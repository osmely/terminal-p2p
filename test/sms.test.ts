import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { cleanPhone, maskPhone, removeSms, sendCode, SMS_DAILY, smsPlain, smsState, smsUser, verifyCode, type SmsEnv } from '../worker/sms.ts'
import { radarSms } from '../worker/userbot.ts'

// D1 sobre SQLite en memoria, con las migraciones del proyecto
function memD1() {
	const db = new DatabaseSync(':memory:')
	for (const f of readdirSync('migrations').sort()) db.exec(readFileSync(`migrations/${f}`, 'utf8'))
	const stmt = (sql: string, args: unknown[] = []) => ({
		bind: (...a: unknown[]) => stmt(sql, a),
		all: async () => ({ results: db.prepare(sql).all(...(args as never[])) as never[] }),
		first: async () => (db.prepare(sql).get(...(args as never[])) ?? null) as never,
		run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...(args as never[])).changes) } }),
	})
	return { prepare: (sql: string) => stmt(sql), batch: async (ss: { run: () => Promise<unknown> }[]) => Promise.all(ss.map((s) => s.run())) }
}

// OTP Cuba de mentira: el código es 123456; cuenta lo que le piden
function fakeOtp() {
	const calls: { path: string; body: Record<string, unknown>; key: string | null }[] = []
	const fetcher = (async (url: string, init: RequestInit) => {
		const path = new URL(url).pathname.replace('/api/v2', '')
		const body = JSON.parse(String(init.body)) as Record<string, unknown>
		calls.push({ path, body, key: (init.headers as Record<string, string>)['x-api-key'] ?? null })
		if (path === '/send') return Response.json({ hash: `h-${calls.length}`, message: 'OTP enviado correctamente' })
		if (path === '/verify') return body.code === '123456' ? Response.json({ message: 'Código verificado correctamente' }) : Response.json({ error: 'Código incorrecto', attemptsLeft: 4 }, { status: 400 })
		if (path === '/sms/send') return Response.json({ success: true })
		return new Response('no', { status: 404 })
	}) as typeof fetch
	return { calls, fetcher }
}

const T = Date.parse('2026-11-25T20:00:00Z')
const env = (): SmsEnv => ({ DB: memD1() as never, OTP_API_KEY: 'APP-x', OTP_TOKEN_SECRET: 'OTP-x' })

test('sms: el número cubano se limpia, se tapa al enseñarlo y el texto va sin tildes y en 160', () => {
	assert.equal(cleanPhone('+53 5123-4567'), '+5351234567')
	assert.equal(cleanPhone('51234567'), '+5351234567')
	assert.equal(cleanPhone('5351234567'), '+5351234567')
	assert.equal(cleanPhone('+1 305 555 1234'), null)
	assert.equal(cleanPhone('+53 7123 4567'), null) // fijo, no móvil
	assert.equal(maskPhone('+5351234567'), '+53 5•••• 567')
	assert.equal(smsPlain('  El radar compró a @peña ¿pagaste?  Ñ '), 'El radar compro a @peña pagaste? Ñ')
	assert.equal(smsPlain('x'.repeat(300)).length, 160)
	const text = radarSms({ kind: 'taken', offer: 'o', coin: 'ETECSA', side: 'buy', price: 264.83, usd: 18.88, peer: 'skymind', limit: 266, pay: 5000, payBy: T })
	assert.ok(smsPlain(text).length <= 160, smsPlain(text))
	assert.equal(text, 'TerminalP2P: Aviso de Radar, Paga antes de las 04:00 p. m.')
})

test('sms: poner el número, verificarlo con el código y recibir avisos; quitarlo', async () => {
	const e = env()
	const otp = fakeOtp()
	assert.deepEqual(await smsState(e.DB, 'qp:ana'), { phone: null, pending: null })
	assert.equal(await sendCode(e, 'qp:ana', 'nada', T, otp.fetcher), 'Pon un móvil cubano: +53 y 8 dígitos (por ejemplo +53 5123 4567)')
	assert.equal(await sendCode(e, 'qp:ana', '+53 5123 4567', T, otp.fetcher), null)
	assert.deepEqual(otp.calls[0], { path: '/send', body: { phoneNumber: '+5351234567', expiresInSeconds: 600, digits: 6 }, key: 'APP-x' })
	assert.deepEqual(await smsState(e.DB, 'qp:ana'), { phone: null, pending: '+53 5•••• 567' })
	// Sin verificar no le llegan avisos
	assert.equal(await smsUser(e, 'qp:ana', 'hola', T, otp.fetcher), false)
	// Otro código enseguida, no
	assert.match((await sendCode(e, 'qp:ana', '+5351234567', T + 10_000, otp.fetcher))!, /Espera un minuto/)
	assert.equal(await verifyCode(e, 'qp:ana', '999999', T, otp.fetcher), 'Código incorrecto. Te quedan 4 intentos')
	assert.equal(await verifyCode(e, 'qp:ana', '123456', T, otp.fetcher), null)
	assert.deepEqual(otp.calls.at(-1)!.body, { hash: 'h-1', code: '123456' })
	assert.deepEqual(await smsState(e.DB, 'qp:ana'), { phone: '+53 5•••• 567', pending: null })
	// El aviso va al número verificado, sin tildes y sin la clave de la app (solo el token secreto)
	assert.equal(await smsUser(e, 'qp:ana', 'El radar compró', T, otp.fetcher), true)
	assert.deepEqual(otp.calls.at(-1), { path: '/sms/send', body: { phoneNumber: '+5351234567', message: 'El radar compro' }, key: null })
	// A otra cuenta, nada
	assert.equal(await smsUser(e, 'qp:beto', 'hola', T, otp.fetcher), false)
	await removeSms(e.DB, 'qp:ana')
	assert.equal(await smsUser(e, 'qp:ana', 'hola', T, otp.fetcher), false)
	assert.deepEqual(await smsState(e.DB, 'qp:ana'), { phone: null, pending: null })
})

test('sms: tope de SMS por cuenta y día (códigos y avisos); al otro día vuelve; sin claves no hace nada', async () => {
	const e = env()
	const otp = fakeOtp()
	await sendCode(e, 'qp:ana', '51234567', T, otp.fetcher)
	await verifyCode(e, 'qp:ana', '123456', T, otp.fetcher)
	let ok = 0
	for (let i = 0; i < SMS_DAILY + 3; i++) if (await smsUser(e, 'qp:ana', 'aviso', T + i, otp.fetcher)) ok++
	assert.equal(ok, SMS_DAILY - 1) // el código ya gastó uno
	assert.equal(await smsUser(e, 'qp:ana', 'aviso', T + 86_400_000, otp.fetcher), true)
	const off = fakeOtp()
	assert.equal(await smsUser({ DB: e.DB }, 'qp:ana', 'aviso', T, off.fetcher), false)
	assert.match((await sendCode({ DB: e.DB } as SmsEnv, 'qp:ana', '51234567', T, off.fetcher))!, /no están disponibles/)
	assert.equal(off.calls.length, 0)
})
