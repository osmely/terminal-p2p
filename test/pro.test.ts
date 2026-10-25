import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { PRO_DEVICES, proAdmin, proApi, type ProEnv } from '../worker/pro.ts'

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
	return { db, d1: { prepare: (sql: string) => stmt(sql), batch: async (ss: { run: () => Promise<unknown> }[]) => Promise.all(ss.map((s) => s.run())) } }
}

// QvaPay de comerciante simulado: crea facturas y dice quién pagó cada una
function fakeQvaPay() {
	const invoices = new Map<string, { remote_id: string; amount: number; status: string; PaidBy: { uuid: string; username: string } | null }>()
	const calls: string[] = []
	const fetcher = (async (input: string | URL, init?: RequestInit) => {
		const url = String(input)
		const h = new Headers(init?.headers)
		calls.push(url.replace('https://api.qvapay.com', ''))
		if (h.get('app-id') !== 'app' || h.get('app-secret') !== 'secreto') return new Response('{"error":"credenciales"}', { status: 401 })
		if (url.endsWith('/v2/create_invoice')) {
			const b = JSON.parse(String(init?.body))
			const uuid = `inv-${invoices.size + 1}`
			invoices.set(uuid, { remote_id: b.remote_id, amount: b.amount, status: 'pending', PaidBy: null })
			return Response.json({ transaction_uuid: uuid, url: `https://www.qvapay.com/pay/${uuid}` })
		}
		const m = url.match(/\/v2\/transactions\/(.+)$/)
		if (m) return Response.json({ transaction: invoices.get(decodeURIComponent(m[1])) ?? null })
		return new Response('{}', { status: 404 })
	}) as typeof fetch
	const pay = (uuid: string, username = 'ana', amount?: number) => Object.assign(invoices.get(uuid)!, { status: 'paid', PaidBy: { uuid: `u-${username}`, username }, ...(amount ? { amount } : {}) })
	return { fetcher, pay, calls, invoices }
}

const T0 = Date.parse('2026-10-25T12:00:00Z')
const P1 = 'a'.repeat(64)
const P2 = 'b'.repeat(64)
const P3 = 'c'.repeat(64)
const P4 = 'd'.repeat(64)

function setup(extra: Partial<ProEnv> = {}) {
	const { db, d1 } = memD1()
	const q = fakeQvaPay()
	const env: ProEnv = { DB: d1, QVAPAY_APP_ID: 'app', QVAPAY_APP_SECRET: 'secreto', PRO_KEY: 'clave', METRICS_KEY: 'panel', ...extra }
	let now = T0
	const call = async (method: string, path: string, body?: unknown) => {
		const req = new Request(`https://app.terminalp2p.com${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
		const res = (await proApi(req, new URL(req.url), env, now, q.fetcher))!
		return { status: res.status, body: res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text() }
	}
	return { db, env, q, call, tick: (ms: number) => (now += ms), post: (p: string, b: unknown) => call('POST', p, b), get: (p: string) => call('GET', p) }
}

// Compra completa: factura, pago en QvaPay y el navegador recoge el resultado
async function buy(s: ReturnType<typeof setup>, print = P1, plan = 'month', username = 'ana') {
	const c = await s.post('/pro/checkout', { print, plan })
	const inv = [...s.q.invoices.keys()].at(-1)!
	s.q.pay(inv, username)
	return { checkout: c.body, result: (await s.get(`/pro/checkout?id=${c.body.id}`)).body }
}

test('comprar: factura de QvaPay, quién pagó lo confirma QvaPay y el código de respaldo se entrega una vez', async () => {
	const s = setup()
	const c = await s.post('/pro/checkout', { print: P1, plan: 'month' })
	assert.equal(c.status, 200)
	assert.match(c.body.url, /^https:\/\/www\.qvapay\.com\/pay\/inv-1$/)
	assert.deepEqual(s.q.invoices.get('inv-1')?.amount, 1.99)
	// Sin pagar sigue pendiente y no es Pro
	assert.equal((await s.get(`/pro/checkout?id=${c.body.id}`)).body.status, 'pending')
	assert.equal((await s.post('/pro/status', { print: P1 })).body.pro, false)
	s.q.pay('inv-1', 'ana')
	const r = (await s.get(`/pro/checkout?id=${c.body.id}`)).body
	assert.equal(r.status, 'paid')
	assert.equal(r.pro, true)
	assert.equal(r.username, 'ana')
	assert.match(r.backupCode, /^TP-[2-9A-Z]{4}-[2-9A-Z]{4}-[2-9A-Z]{4}$/)
	assert.equal(r.expiresAt, T0 + 30 * 86_400_000)
	// Una segunda consulta ya no devuelve el código (solo lo tiene quien compró)
	assert.equal((await s.get(`/pro/checkout?id=${c.body.id}`)).body.backupCode, null)
	const st = (await s.post('/pro/status', { print: P1 })).body
	assert.deepEqual([st.pro, st.username, st.plan], [true, 'ana', 'month'])
	// En la base: el usuario y la huella, nunca un token
	assert.deepEqual({ ...s.db.prepare('SELECT username, plan FROM pro_licenses').get() }, { username: 'ana', plan: 'month' })
})

test('renovar suma el periodo y no cambia el código de respaldo', async () => {
	const s = setup()
	await buy(s)
	s.tick(10 * 86_400_000)
	const { result } = await buy(s, P1, 'year')
	assert.equal(result.expiresAt, T0 + (30 + 365) * 86_400_000)
	assert.equal(result.backupCode, null)
})

test('no se da por pagada si QvaPay no lo confirma, si paga menos o si el aviso es falso', async () => {
	const s = setup()
	const c = await s.post('/pro/checkout', { print: P1, plan: 'year' })
	// Un aviso cualquiera no basta: se consulta a QvaPay y sigue pendiente
	await s.post('/api/pro/webhook', { remote_id: c.body.id, status: 'paid' })
	assert.equal((await s.post('/pro/status', { print: P1 })).body.pro, false)
	// Pagó menos de lo que vale el plan
	s.q.pay('inv-1', 'ana', 1)
	assert.equal((await s.get(`/pro/checkout?id=${c.body.id}`)).body.status, 'pending')
	// Pagado de verdad: el aviso de QvaPay lo activa
	s.q.pay('inv-1', 'ana', 20)
	await s.post('/api/pro/webhook', { transaction_uuid: 'inv-1' })
	assert.equal((await s.post('/pro/status', { print: P1 })).body.pro, true)
})

test('cambiar de token: la huella vieja autoriza a la nueva y deja de valer', async () => {
	const s = setup()
	await buy(s)
	const r = await s.post('/pro/rotate', { from: P1, to: P2 })
	assert.equal(r.body.pro, true)
	assert.equal((await s.post('/pro/status', { print: P2 })).body.pro, true)
	assert.equal((await s.post('/pro/status', { print: P1 })).body.pro, false)
	// Una huella que no es Pro no autoriza nada
	assert.equal((await s.post('/pro/rotate', { from: P3, to: P4 })).body.pro, false)
})

test('añadir dispositivo con un código de 6 cifras: un solo uso y 5 minutos', async () => {
	const s = setup()
	await buy(s)
	assert.equal((await s.post('/pro/pair', { print: P3 })).status, 403)
	const { code } = (await s.post('/pro/pair', { print: P1 })).body
	assert.match(code, /^\d{6}$/)
	const ok = await s.post('/pro/claim', { print: P2, code })
	assert.equal(ok.body.pro, true)
	// Ya usado
	assert.equal((await s.post('/pro/claim', { print: P3, code })).status, 400)
	// Caducado
	const late = (await s.post('/pro/pair', { print: P1 })).body.code
	s.tick(5 * 60_000 + 1)
	assert.equal((await s.post('/pro/claim', { print: P3, code: late })).status, 400)
})

test(`como mucho ${PRO_DEVICES} dispositivos: el que entra expulsa al que lleva más tiempo sin usarse`, async () => {
	const s = setup()
	await buy(s)
	s.tick(1000)
	await s.post('/pro/claim', { print: P2, code: (await s.post('/pro/pair', { print: P1 })).body.code })
	s.tick(1000)
	await s.post('/pro/status', { print: P1 }) // P1 se usa: P2 queda como el más antiguo
	s.tick(1000)
	await s.post('/pro/claim', { print: P3, code: (await s.post('/pro/pair', { print: P1 })).body.code })
	const pro = async (p: string) => (await s.post('/pro/status', { print: p })).body.pro
	assert.deepEqual([await pro(P1), await pro(P2), await pro(P3)], [true, false, true])
})

test('código de respaldo: entra un dispositivo nuevo y el código cambia (uno compartido sirve una vez)', async () => {
	const s = setup()
	const { result } = await buy(s)
	const first = result.backupCode as string
	const r = await s.post('/pro/claim', { print: P2, code: first.toLowerCase().replace(/-/g, ' ') })
	assert.equal(r.body.pro, true)
	assert.notEqual(r.body.backupCode, first)
	assert.equal((await s.post('/pro/claim', { print: P3, code: first })).status, 400)
	// Desde un dispositivo Pro se puede pedir otro (y el anterior deja de valer)
	const next = (await s.post('/pro/backup', { print: P2 })).body.backupCode
	assert.equal((await s.post('/pro/claim', { print: P4, code: r.body.backupCode })).status, 400)
	assert.equal((await s.post('/pro/claim', { print: P4, code: next })).body.pro, true)
})

test('el módulo Pro sale firmado con el usuario, y nunca sin licencia válida o revocada', async () => {
	const store = new Map([['module.js', 'console.log("pro")']])
	const s = setup({ PRO: { get: async (k) => store.get(k) ?? null } })
	const { result } = await buy(s)
	const mod = await s.get(`/pro/module.js?l=${encodeURIComponent(result.license)}`)
	assert.equal(mod.status, 200)
	assert.match(mod.body, /licencia de @ana \(u-ana\)/)
	assert.match(mod.body, /window\.TPProUser="ana"/)
	assert.match(mod.body, /console\.log\("pro"\)$/)
	assert.equal((await s.get('/pro/module.js?l=falsa')).status, 403)
	// La licencia firmada caduca en un día
	s.tick(86_400_000 + 1)
	assert.equal((await s.get(`/pro/module.js?l=${encodeURIComponent(result.license)}`)).status, 403)
})

test('panel: regalar una licencia (con código para activarla) y revocarla', async () => {
	const s = setup()
	const form = (fields: Record<string, string>, auth = 'panel') =>
		proAdmin(new Request('https://app.terminalp2p.com/admin/pro', { method: 'POST', headers: { Authorization: `Basic ${btoa(`x:${auth}`)}` }, body: new URLSearchParams(fields) }), s.env, T0)
	assert.equal((await form({ action: 'gift', username: 'leo' }, 'mala')).status, 401)
	const html = await (await form({ action: 'gift', username: '@leo', days: '7' })).text()
	const code = html.match(/TP-[2-9A-Z]{4}-[2-9A-Z]{4}-[2-9A-Z]{4}/)![0]
	assert.equal((await s.post('/pro/claim', { print: P1, code })).body.pro, true)
	await form({ action: 'revoke', uuid: 'gift:leo' })
	assert.equal((await s.post('/pro/status', { print: P1 })).body.pro, false)
})

test('sin credenciales de QvaPay no se puede comprar, y una huella mal formada se rechaza', async () => {
	const s = setup({ QVAPAY_APP_SECRET: undefined })
	assert.equal((await s.post('/pro/checkout', { print: P1, plan: 'month' })).status, 503)
	assert.equal((await s.post('/pro/status', { print: 'token-en-claro' })).status, 400)
	assert.equal((await s.post('/pro/checkout', { print: P1, plan: 'vitalicio' })).status, 400)
})

test('huella del token: siempre la misma para el mismo token, distinta entre tokens y sin revelarlo', async () => {
	const { tokenPrint } = await import('../web/accounts.ts')
	const a = await tokenPrint('1234|secreto')
	assert.match(a, /^[0-9a-f]{64}$/)
	assert.equal(await tokenPrint('1234|secreto'), a)
	assert.notEqual(await tokenPrint('1234|otro'), a)
	assert.ok(!a.includes('secreto'))
})
