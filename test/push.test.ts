import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import type { FeedEvent } from '../worker/livebook.ts'
import { deliverPush, ownerPush, parseSub, pushApi, pushTargets, relayTaken, simEvent, takerPush, type PushEnv } from '../worker/push.ts'
import { tokenPrint, whoToken } from '../worker/session.ts'
import { b64u, newVapidJwk } from '../worker/webpush.ts'

function memD1() {
	const db = new DatabaseSync(':memory:', { limits: { compoundSelect: 5 } })
	for (const f of readdirSync('migrations').sort()) db.exec(readFileSync(`migrations/${f}`, 'utf8'))
	const stmt = (sql: string, args: unknown[] = []) => ({
		bind: (...a: unknown[]) => stmt(sql, a),
		all: async () => ({ results: db.prepare(sql).all(...(args as never[])) as never[] }),
		first: async () => (db.prepare(sql).get(...(args as never[])) ?? null) as never,
		run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...(args as never[])).changes) } }),
	})
	return { db, d1: { prepare: (sql: string) => stmt(sql), batch: async (ss: { run: () => Promise<unknown> }[]) => { for (const s of ss) await s.run() } } }
}

const T = Date.parse('2026-11-03T15:00:00Z')
const at = (s: number) => new Date(T + s * 1000).toISOString()
const OWNER = '0b5e4c1a-1111-4222-8333-944455556666'
const ev = (event: string, d: Partial<FeedEvent['data']> = {}, s = 0): FeedEvent => ({
	event,
	data: { uuid: 'o1', type: 'sell', coin: 'BANK_CUP', amount: '20', receive: '22200', status: 'processing', updated_at: at(s), offer_kind: 'fixed', owner_uuid: OWNER.toUpperCase(), ...d },
})

test('push: lo que se le avisa al dueño de la oferta', () => {
	const t = (e: FeedEvent, trade: unknown = null) => ownerPush(e, trade as never, T)?.msg
	assert.deepEqual(t(ev('p2p.applied')), { title: 'Tomaron tu venta de 20.00 USD', body: 'CUP Transferencia a 1,110.00 CUP. Espera el pago y libera solo cuando veas el dinero en tu cuenta.', tag: 'tp:o1:taken', url: '/#ops', urgent: false, offer: 'o1', kind: 'taken' })
	assert.equal(t(ev('p2p.applied', { type: 'buy' }))?.body, 'CUP Transferencia a 1,110.00 CUP. Te toca pagar dentro del plazo.')
	assert.equal(t(ev('p2p.applied', { type: 'buy' }))?.urgent, true)
	assert.equal(t(ev('p2p.paid'))?.title, 'Te pagaron: comprueba y libera')
	// En tu compra quien marca pagado eres tú, y en tu venta quien libera eres tú
	assert.equal(t(ev('p2p.paid', { type: 'buy' })), undefined)
	assert.equal(t(ev('p2p.completed', { status: 'completed' })), undefined)
	assert.equal(t(ev('p2p.completed', { type: 'buy', status: 'completed' }))?.title, 'Te liberaron 20.00 USD')
	assert.equal(t(ev('p2p.reopened', { status: 'open' }))?.title, 'Tu venta quedó libre otra vez')
	assert.match(t(ev('p2p.reopened', { status: 'open' }))!.body, /unos minutos en pausa para que revises la tasa/)
	assert.equal(t(ev('p2p.paused', { status: 'open', pause: { reason: 'owner', until: null } })), undefined)
	assert.equal(t(ev('p2p.resumed', { status: 'open' })), undefined)
	assert.equal(t(ev('p2p.created', { status: 'open' })), undefined)
	// De rango: lo tomado y lo que vuelve
	const range = ev('p2p.range_updated', { offer_kind: 'flexible', amount: '100', receive: '111000', available_amount: '70', change: 'taken' })
	assert.equal(t(range, { ops: 1, usd: 30 })?.title, 'Te tomaron 30.00 USD de tu venta')
	assert.match(t(range, { ops: 1, usd: 30 })!.body, /Quedan 70\.00 USD publicados/)
	assert.equal(t(range, { ops: -1, usd: 30 })?.title, 'Volvieron 30.00 USD a tu venta')
	// Una parte que vuelve llega con la pausa automática: se dice a qué hora vuelve sola (hora de Cuba)
	const back = ev('p2p.range_closed', { offer_kind: 'flexible', amount: '100', receive: '111000', available_amount: '100', change: 'paused', pause: { reason: 'taker_left', until: '2026-10-27T20:10:00.000Z' } })
	assert.match(t(back, { ops: -1, usd: 30 })!.body, /vuelve sola al libro a las 16:10/)
	assert.equal(t(range), undefined)
	// El dueño en minúsculas y la misma clave para el mismo evento (llega por el webhook y por el stream)
	const n = ownerPush(ev('p2p.paid'), null, T)!
	assert.equal(n.owner, OWNER)
	assert.equal(n.key, ownerPush(ev('p2p.paid'), null, T)!.key)
	// Uno viejo (tras un corte del feed) no avisa
	assert.equal(ownerPush(ev('p2p.paid', {}, -20 * 60), null, T), null)
})

test('push: lo que se le avisa a quien tomó la oferta desde el terminal', () => {
	// Tomó una venta: compra USD, le liberan
	assert.equal(takerPush(ev('p2p.completed', { status: 'completed' }), T)?.msg?.title, 'Te liberaron 20.00 USD')
	assert.equal(takerPush(ev('p2p.completed', { status: 'completed' }), T)?.end, true)
	assert.equal(takerPush(ev('p2p.paid'), T), null)
	// Tomó una compra: vende USD, le pagan; al completarse liberó él (no se avisa, pero se deja de vigilar)
	assert.equal(takerPush(ev('p2p.paid', { type: 'buy' }), T)?.msg?.title, 'Te pagaron: comprueba y libera')
	const done = takerPush(ev('p2p.completed', { type: 'buy', status: 'completed' }), T)!
	assert.deepEqual([done.msg, done.end], [null, true])
	assert.equal(takerPush(ev('p2p.reopened', { status: 'open' }), T)?.msg?.title, 'Se canceló tu compra de 20.00 USD')
	assert.equal(takerPush(ev('p2p.range_updated', { offer_kind: 'flexible' }), T), null)
})

async function setup() {
	const { db, d1 } = memD1()
	const jwk = await newVapidJwk()
	const refreshed: string[] = []
	const env: PushEnv = {
		DB: d1 as never,
		PRO_KEY: 'clave',
		VAPID_PRIVATE_JWK: JSON.stringify(jwk),
		LIVE: { idFromName: () => 'id', get: () => ({ fetch: async (u: string) => (refreshed.push(u), Response.json({ notices: 1, sent: 1 })) }) },
	}
	const token = '12|tokenAna'
	const print = await tokenPrint(token)
	const cookie = `tpw=${await whoToken(print, OWNER, 'ana', 'clave', T)}`
	const sent: { url: string; headers: Record<string, string> }[] = []
	let status = 201
	const fetcher = (async (url: string, init: RequestInit) => (sent.push({ url, headers: init.headers as Record<string, string> }), new Response(null, { status }))) as unknown as typeof fetch
	const ua = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair
	const p256dh = b64u(new Uint8Array(await crypto.subtle.exportKey('raw', ua.publicKey)))
	const auth = b64u(crypto.getRandomValues(new Uint8Array(16)))
	const subOf = (n: number) => ({ endpoint: `https://fcm.googleapis.com/fcm/send/dev${n}`, keys: { p256dh, auth } })
	const ctx = { waitUntil: (p: Promise<unknown>) => void p }
	const call = async (path: string, body: unknown, withCookie: boolean | string = true) => {
		const req = new Request(`https://app.terminalp2p.com${path}`, { method: 'POST', body: JSON.stringify(body), headers: withCookie ? { cookie: typeof withCookie === 'string' ? withCookie : cookie } : {} })
		const res = await pushApi(req, new URL(req.url), env, ctx, T, fetcher)
		return { status: res.status, body: (await res.json()) as Record<string, unknown> }
	}
	// Tomar una oferta desde el terminal: el relé la ve (con el token y la cookie de la cuenta) y la vigila
	const take = (offer: string, tok = token, ck = cookie, ok = true) =>
		relayTaken(env, new Request(`https://app.terminalp2p.com/qp/p2p/${offer}/apply`, { method: 'POST', headers: { authorization: `Bearer ${tok}`, cookie: ck } }), `/p2p/${offer}/apply`, ok, T)
	return { db, env, print, call, take, subOf, sent, refreshed, fetcher, setStatus: (s: number) => (status = s) }
}

test('push: activar los avisos pide tu cuenta confirmada en ese navegador; luego se vigila, se prueba y se desactiva', async () => {
	const s = await setup()
	const get = await pushApi(new Request('https://app.terminalp2p.com/push/key'), new URL('https://app.terminalp2p.com/push/key'), s.env, { waitUntil() {} }, T)
	assert.match(((await get.json()) as { key: string }).key, /^B[A-Za-z0-9_-]{86}$/)

	assert.equal((await s.call('/push/subscribe', { print: s.print, sub: s.subOf(1) }, false)).status, 401)
	assert.equal((await s.call('/push/subscribe', { print: 'b'.repeat(64), sub: s.subOf(1) })).status, 401)
	assert.equal((await s.call('/push/subscribe', { print: s.print, sub: { endpoint: 'http://x' } })).status, 400)
	assert.equal((await s.call('/push/subscribe', { print: s.print, sub: s.subOf(1) })).status, 200)
	assert.deepEqual(s.db.prepare('SELECT owner, username FROM push_subs').all().map((r) => ({ ...r })), [{ owner: OWNER, username: 'ana' }])
	assert.deepEqual(s.refreshed, ['https://live/push-refresh'])

	// Vigilar una oferta tomada: solo desde un navegador con los avisos de esa cuenta
	const offer = '7f1c2d3e-aaaa-4bbb-8ccc-0123456789ab'
	assert.equal((await s.call('/push/watch', { print: s.print, endpoint: s.subOf(2).endpoint, offer })).status, 404)
	assert.equal((await s.call('/push/watch', { print: s.print, endpoint: s.subOf(1).endpoint, offer: 'no' })).status, 400)
	// Una oferta que no tomó desde el terminal, no (si no, cualquiera vigilaba las de otros y veía cuándo les pagan)
	assert.equal((await s.call('/push/watch', { print: s.print, endpoint: s.subOf(1).endpoint, offer })).status, 404)
	// Tomarla sin éxito, o sin la cuenta confirmada en ese navegador, tampoco la vigila
	assert.equal(await s.take(offer, undefined, undefined, false), 0)
	assert.equal(await s.take(offer, '99|otroToken'), 0)
	// La tomó: el relé la vigila en sus navegadores, y el terminal puede renovarla
	assert.equal(await s.take(offer.toUpperCase()), 1)
	assert.equal((await s.call('/push/watch', { print: s.print, endpoint: s.subOf(1).endpoint, offer: offer.toUpperCase() })).status, 200)
	const t = await pushTargets(s.env.DB, T)
	assert.deepEqual([[...t.owners], [...t.offers]], [[OWNER], [offer]])

	// El aviso de prueba sale al servicio de push del navegador
	assert.deepEqual((await s.call('/push/test', { print: s.print, endpoint: s.subOf(1).endpoint })).body, { ok: true })
	assert.equal(s.sent.at(-1)!.url, s.subOf(1).endpoint)
	// Si el servicio dice que no existe, el de prueba no la borra (recién hecha, FCM a veces tarda unos segundos)
	s.setStatus(410)
	assert.equal((await s.call('/push/test', { print: s.print, endpoint: s.subOf(1).endpoint })).status, 502)
	assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM push_subs').get()!.n, 1)
	s.setStatus(201)
	// La simulación solo existe en staging y en local
	assert.equal((await s.call('/push/sim', { print: s.print, endpoint: s.subOf(1).endpoint, kind: 'paid' })).status, 404)

	assert.equal((await s.call('/push/unsubscribe', { endpoint: s.subOf(1).endpoint }, false)).status, 200)
	assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM push_subs').get()!.n, 0)
	assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM push_watch').get()!.n, 0)
})

test('push: el aviso llega a todos los navegadores de la cuenta; uno que ya no existe se borra; con tope por hora', async () => {
	const s = await setup()
	for (const n of [1, 2]) await s.call('/push/subscribe', { print: s.print, sub: s.subOf(n) })
	const n = ownerPush(ev('p2p.paid'), null, T)!
	assert.equal(await deliverPush(s.env, n, T, new Map(), s.fetcher), 2)
	assert.equal(s.sent[0].headers.Urgency, 'high')
	assert.equal(s.sent[0].headers.Topic, 'o1paid')

	s.setStatus(410)
	assert.equal(await deliverPush(s.env, n, T, new Map(), s.fetcher), 0)
	assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM push_subs').get()!.n, 0)

	s.setStatus(201)
	await s.call('/push/subscribe', { print: s.print, sub: s.subOf(3) })
	const times = new Map<string, number[]>()
	let ok = 0
	for (let i = 0; i < 35; i++) ok += await deliverPush(s.env, n, T + i, times, s.fetcher)
	assert.equal(ok, 30)

	// Quien tomó la oferta: al terminar la operación se deja de vigilar
	const offer = '7f1c2d3e-aaaa-4bbb-8ccc-0123456789ab'
	assert.equal(await s.take(offer), 1)
	const end = takerPush(ev('p2p.completed', { uuid: offer, status: 'completed' }), T)!
	assert.equal(await deliverPush(s.env, end, T, new Map(), s.fetcher), 1)
	assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM push_watch').get()!.n, 0)
})

test('push: el evento inventado de las pruebas lleva tu cuenta de dueño y pasa por el mismo aviso', () => {
	const e = simEvent(OWNER, 'paid', 'sell', T)!
	assert.equal(ownerPush(e, null, T)?.msg?.title, 'Te pagaron: comprueba y libera')
	assert.equal(ownerPush(simEvent(OWNER, 'released', 'buy', T)!, null, T)?.msg?.title, 'Te liberaron 10.00 USD')
	assert.equal(simEvent(OWNER, 'otro', 'sell', T), null)
})

test('push: dos cuentas en el mismo navegador reciben las dos, y el aviso dice de cuál es', async () => {
	const s = await setup()
	const OWNER2 = '22222222-2222-4222-8222-222222222222'
	const token2 = '13|tokenLeo'
	const print2 = await tokenPrint(token2)
	const cookie2 = `tpw=${await whoToken(print2, OWNER2, 'leo', 'clave', T)}`
	await s.call('/push/subscribe', { print: s.print, sub: s.subOf(1) })
	await s.call('/push/subscribe', { print: print2, sub: s.subOf(1) }, cookie2)
	assert.deepEqual(s.db.prepare('SELECT owner, username FROM push_subs ORDER BY username').all().map((r) => ({ ...r })), [{ owner: OWNER, username: 'ana' }, { owner: OWNER2, username: 'leo' }])
	// La de ana sigue recibiendo lo suyo, aunque leo se conectó después
	assert.equal(await deliverPush(s.env, ownerPush(ev('p2p.paid'), null, T)!, T, new Map(), s.fetcher), 1)
	assert.equal(await deliverPush(s.env, ownerPush(ev('p2p.paid', { owner_uuid: OWNER2 }), null, T)!, T, new Map(), s.fetcher), 1)
	// Las dos cuentas pueden vigilar desde ese navegador lo que tomaron
	const offer = '7f1c2d3e-aaaa-4bbb-8ccc-0123456789ab'
	assert.equal((await s.call('/push/watch', { print: print2, endpoint: s.subOf(1).endpoint, offer }, cookie2)).status, 404)
	assert.equal(await s.take(offer, token2, cookie2), 1)
	assert.equal((await s.call('/push/watch', { print: print2, endpoint: s.subOf(1).endpoint, offer }, cookie2)).status, 200)
	assert.equal(await deliverPush(s.env, takerPush(ev('p2p.paid', { uuid: offer, type: 'buy' }), T)!, T, new Map(), s.fetcher), 1)
	// Desactivar los avisos en el navegador los quita para todas sus cuentas
	await s.call('/push/unsubscribe', { endpoint: s.subOf(1).endpoint }, false)
	assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM push_subs').get()!.n, 0)
})

test('push: solo se aceptan los servicios de push de los navegadores (el servidor llama a esa dirección)', () => {
	const keys = { p256dh: 'B'.repeat(40), auth: 'a'.repeat(16) }
	const ok = (endpoint: string) => !!parseSub({ endpoint, keys })
	for (const e of ['https://fcm.googleapis.com/fcm/send/abc', 'https://updates.push.services.mozilla.com/wpush/v2/abc', 'https://web.push.apple.com/QabC', 'https://wns2-bl2p.notify.windows.com/w/?token=abc'])
		assert.equal(ok(e), true, e)
	for (const e of ['https://example.com/push', 'https://fcm.googleapis.com.evil.example/x', 'https://evil.example/fcm.googleapis.com/x', 'http://fcm.googleapis.com/fcm/send/abc', 'https://127.0.0.1/x', 'https://fcm.googleapis.com@evil.example/x'])
		assert.equal(ok(e), false, e)
})
