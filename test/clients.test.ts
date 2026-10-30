import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { tokenPrint, whoToken } from '../worker/session.ts'
import { addDays, proApi, type ProEnv } from '../worker/pro.ts'
import { cleanupClients, offerText, OPEN_MS } from '../worker/clients.ts'

function memD1() {
	const db = new DatabaseSync(':memory:', { limits: { compoundSelect: 5 } })
	for (const f of readdirSync('migrations').sort()) db.exec(readFileSync(`migrations/${f}`, 'utf8'))
	db.exec("INSERT INTO app_flags (key, value, updated_at) VALUES ('pro', '1', 0)")
	const stmt = (sql: string, args: unknown[] = []) => ({
		bind: (...a: unknown[]) => stmt(sql, a),
		all: async () => ({ results: db.prepare(sql).all(...(args as never[])) as never[] }),
		first: async () => (db.prepare(sql).get(...(args as never[])) ?? null) as never,
		run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...(args as never[])).changes) } }),
	})
	return { db, d1: { prepare: (sql: string) => stmt(sql), batch: async (ss: { run: () => Promise<unknown> }[]) => Promise.all(ss.map((s) => s.run())) } }
}

const T0 = Date.parse('2026-10-30T12:00:00Z')
const KEY = 'clave'
const TOKEN: Record<string, string> = { ana: '11|tokenDeAna', leo: '21|tokenDeLeo', eva: '31|tokenDeEva' }
const OFFER = '7c9e6679-7425-40de-944b-e07fc1f90ae7'
const PUBLIC = '8d0f7780-8536-41ef-a55c-f18fd2fa1bf8'

const qvapayOffer = (uuid: string, extra: Record<string, unknown> = {}) => ({
	uuid,
	type: 'sell',
	coin: 'BANK_CUP',
	amount: '300',
	receive: '118500',
	status: 'open',
	private: true,
	offer_kind: 'fixed',
	User: { uuid: 'u-ana', username: 'Ana' },
	details: [{ name: 'Tarjeta', value: '9200 0000 0000 0000' }],
	...extra,
})

function setup() {
	const { db, d1 } = memD1()
	const sent: { chat_id: number; text: string; reply_markup?: { inline_keyboard: { url: string }[][] } }[] = []
	const reads: string[] = []
	const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input)
		if (url.includes('api.telegram.org')) {
			sent.push(JSON.parse(String(init?.body)))
			return Response.json({ ok: true })
		}
		const m = /api\.qvapay\.com\/p2p\/([0-9a-f-]+)$/.exec(url)
		if (m) {
			const auth = new Headers(init?.headers).get('authorization')
			reads.push(`${auth} ${m[1]}`)
			if (auth !== `Bearer ${TOKEN.ana}`) return Response.json({ p2p: qvapayOffer(m[1], { details: null }) })
			return Response.json({ p2p: qvapayOffer(m[1], m[1] === PUBLIC ? { private: false } : {}) })
		}
		return new Response('no', { status: 404 })
	}) as typeof fetch
	const env = { DB: d1, PRO_KEY: KEY, TELEGRAM_BOT_TOKEN: 'bot', STAGING: '1' } as unknown as ProEnv
	const call = async (who: string, path: string, body: Record<string, unknown> = {}, opts: { token?: string; now?: number } = {}) => {
		const print = await tokenPrint(TOKEN[who])
		const headers: Record<string, string> = { 'Content-Type': 'application/json', Cookie: `tpw=${await whoToken(print, `u-${who}`, who[0].toUpperCase() + who.slice(1), KEY, T0)}` }
		if (opts.token) headers.Authorization = `Bearer ${opts.token}`
		const req = new Request(`https://app.terminalp2p.com${path}`, { method: 'POST', headers, body: JSON.stringify({ print, ...body }) })
		const res = (await proApi(req, new URL(req.url), env, opts.now ?? T0, fetcher))!
		return { status: res.status, body: (await res.json()) as Record<string, any> }
	}
	return { db, d1, env, call, sent, reads }
}

test('mis clientes: el cliente se une con el enlace del comerciante con Pro y sale cuando quiere', async () => {
	const { d1, call } = setup()
	// Sin Pro, su enlace no sirve
	let r = await call('leo', '/pro/clients/join', { merchant: 'ana' })
	assert.equal(r.status, 404)
	assert.match(r.body.error, /no tiene «Mis clientes» activo/)
	await addDays(d1 as never, 'Ana', { kind: 'gift', days: 30, actor: 'admin' }, T0)
	r = await call('leo', '/pro/clients/join', { merchant: '@ana' })
	assert.equal(r.status, 200)
	assert.equal(r.body.joined, 'Ana')
	assert.deepEqual(r.body.merchants.map((m: { username: string }) => m.username), ['Ana'])
	assert.equal(r.body.pro, false)
	// Unirse dos veces no duplica; a uno mismo, no
	await call('leo', '/pro/clients/join', { merchant: 'Ana' })
	assert.equal((await call('ana', '/pro/clients')).body.clients.length, 1)
	r = await call('ana', '/pro/clients/join', { merchant: 'ana' })
	assert.equal(r.status, 409)
	// Sale el cliente
	r = await call('leo', '/pro/clients/leave', { merchant: 'Ana' })
	assert.deepEqual(r.body.merchants, [])
	assert.equal((await call('ana', '/pro/clients')).body.clients.length, 0)
	// Sin la cuenta confirmada por QvaPay, nada
	const req = new Request('https://app.terminalp2p.com/pro/clients', { method: 'POST', body: JSON.stringify({ print: await tokenPrint(TOKEN.leo) }) })
	const res = (await proApi(req, new URL(req.url), { DB: d1, PRO_KEY: KEY } as unknown as ProEnv, T0))!
	assert.equal(res.status, 403)
	assert.equal((await res.json()).code, 'TP_WHO')
})

test('mis clientes: la oferta privada se lee en QvaPay con el token del comerciante, se avisa una vez y solo a sus clientes', async () => {
	const { db, d1, call, sent, reads } = setup()
	await addDays(d1 as never, 'Ana', { kind: 'gift', days: 30, actor: 'admin' }, T0)
	await call('leo', '/pro/clients/join', { merchant: 'Ana' })
	await call('eva', '/pro/clients/join', { merchant: 'Ana' })
	// Leo conectó el bot; Eva no
	db.exec("INSERT INTO pro_telegram (license, chat_id, linked_at) VALUES ('qp:leo', 501, 0)")

	// Sin token, o con el de otro, no se manda
	assert.equal((await call('ana', '/pro/clients/send', { offer: OFFER })).status, 403)
	assert.equal((await call('ana', '/pro/clients/send', { offer: OFFER }, { token: TOKEN.leo })).status, 403)
	// Una pública no (ya sale en el libro); una de otro tampoco
	let r = await call('ana', '/pro/clients/send', { offer: PUBLIC }, { token: TOKEN.ana })
	assert.equal(r.status, 409)
	assert.match(r.body.error, /privadas/)
	await addDays(d1 as never, 'Leo', { kind: 'gift', days: 30, actor: 'admin' }, T0)
	r = await call('leo', '/pro/clients/send', { offer: OFFER }, { token: TOKEN.leo })
	assert.equal(r.status, 409)
	assert.match(r.body.error, /no es tuya/)

	r = await call('ana', '/pro/clients/send', { offer: OFFER.toUpperCase() }, { token: TOKEN.ana })
	assert.equal(r.status, 200)
	assert.equal(r.body.sent, 1)
	assert.equal(r.body.fresh, true)
	assert.equal(sent.length, 1)
	assert.equal(sent[0].chat_id, 501)
	assert.match(sent[0].text, /@Ana publicó una oferta para sus clientes/)
	assert.match(sent[0].text, /Vende <b>300\.00 USD<\/b> a <b>395\.00 CUP<\/b>/)
	assert.equal(sent[0].reply_markup?.inline_keyboard[0][0].url, `https://app.staging.terminalp2p.com/#p2p/${OFFER}`)
	assert.ok(reads.includes(`Bearer ${TOKEN.ana} ${OFFER}`))
	// Nunca se guardan los datos de pago
	assert.doesNotMatch(JSON.stringify(db.prepare('SELECT * FROM client_offers').all()), /9200/)
	// Mandarla otra vez no repite el aviso
	r = await call('ana', '/pro/clients/send', { offer: OFFER }, { token: TOKEN.ana })
	assert.equal(r.body.fresh, false)
	assert.equal(sent.length, 1)

	// Los clientes la ven; quien no es cliente, no
	assert.deepEqual((await call('leo', '/pro/clients')).body.offers.map((o: { uuid: string }) => o.uuid), [OFFER])
	assert.deepEqual((await call('eva', '/pro/clients')).body.offers[0].price, 395)
	await call('eva', '/pro/clients/leave', { merchant: 'Ana' })
	assert.deepEqual((await call('eva', '/pro/clients')).body.offers, [])

	// El comerciante saca a Leo de su lista
	r = await call('ana', '/pro/clients/remove', { client: 'Leo' })
	assert.deepEqual(r.body.clients, [])
	assert.deepEqual((await call('leo', '/pro/clients')).body.offers, [])
})

test('mis clientes: la oferta deja de enseñarse cuando el comerciante dice que se cerró, o a los 2 días', async () => {
	const { d1, call } = setup()
	await addDays(d1 as never, 'Ana', { kind: 'gift', days: 30, actor: 'admin' }, T0)
	await call('leo', '/pro/clients/join', { merchant: 'Ana' })
	await call('ana', '/pro/clients/send', { offer: OFFER }, { token: TOKEN.ana })
	await call('ana', '/pro/clients/send', { offer: PUBLIC.replace('8d', '9d') }, { token: TOKEN.ana })
	assert.equal((await call('leo', '/pro/clients')).body.offers.length, 2)
	// Solo el dueño las cierra
	await call('leo', '/pro/clients/close', { offers: [OFFER] })
	assert.equal((await call('leo', '/pro/clients')).body.offers.length, 2)
	await call('ana', '/pro/clients/close', { offers: [OFFER] })
	const v = (await call('leo', '/pro/clients')).body
	assert.equal(v.offers.length, 1)
	assert.equal((await call('ana', '/pro/clients')).body.mine.find((o: { uuid: string }) => o.uuid === OFFER).status, 'closed')
	// Caducada
	assert.equal((await call('leo', '/pro/clients', {}, { now: T0 + OPEN_MS + 1 })).body.offers.length, 0)
	await cleanupClients(d1 as never, T0 + OPEN_MS + 1)
	assert.equal((await call('ana', '/pro/clients', {}, { now: T0 + OPEN_MS + 1 })).body.mine.every((o: { status: string }) => o.status === 'closed'), true)
})

test('mis clientes: el aviso por partes y solo VIP', () => {
	const t = offerText({ merchant: 'Ana', coin: 'BANK_MLC', type: 'buy', price: 1.05, usd: 1050.5, kind: 'flexible', orderMin: 50, orderMax: 500, vipOnly: true })
	assert.match(t, /Compra <b>1,050\.50 USD<\/b> a <b>1\.05 MLC<\/b>/)
	assert.match(t, /Por partes: de 50\.00 a 500\.00 USD/)
	assert.match(t, /Solo cuentas VIP/)
})
