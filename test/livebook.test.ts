import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { test } from 'node:test'
import type { P2POffer } from '../src/qvapay/types.ts'
import { Book, feedSign, feedSigned, feedWebhook, sseEvents, tradeOf, type FeedEvent } from '../worker/livebook.ts'

const T = Date.parse('2026-10-27T15:00:00Z')
const at = (s: number) => new Date(T + s * 1000).toISOString()
const ev = (event: string, d: Partial<FeedEvent['data']>, s = 0): FeedEvent => ({
	event,
	data: { uuid: 'o1', type: 'sell', coin: 'BANK_CUP', amount: '20', receive: '21000', status: 'open', updated_at: at(s), offer_kind: 'fixed', owner_uuid: 'u-ana', only_vip: false, requirements: null, ...d },
})
const ana = { uuid: 'u-ana', username: 'ana', rating_avg: 4.9, rating_count: 30, _count: { P2P: 40, P2P_Peer: 5 }, kyc: true }

test('feed: una venta nueva entra al libro y sale al tomarla; un evento viejo o repetido no la resucita', () => {
	const b = new Book()
	const c = b.apply(ev('p2p.created', {}), T)!
	assert.deepEqual([c.coin, c.side, c.changed, c.unknownOwner, c.act?.kind, c.act?.usd], ['BANK_CUP', 'ask', true, true, 'new', 20])
	assert.equal(b.levels('BANK_CUP', 'ask')[0].price, 1050)
	const a = b.apply(ev('p2p.applied', {}, 5), T)!
	assert.deepEqual([a.changed, a.act?.kind, a.act?.usd, a.act?.price], [true, 'taken', 20, 1050])
	assert.equal(b.count('BANK_CUP', 'ask'), 0)
	// El «created» repetido (reintento de QvaPay) llega tarde: no vuelve
	assert.equal(b.apply(ev('p2p.created', {}), T), null)
	// Reabierta después: sí vuelve
	assert.ok(b.apply(ev('p2p.reopened', {}, 9), T))
	assert.equal(b.count('BANK_CUP', 'ask'), 1)
	// Mercados que no existen o datos raros: nada
	assert.equal(b.apply(ev('p2p.created', { uuid: 'x', coin: 'NADA' }), T), null)
	assert.equal(b.apply({ event: 'p2p.created' } as FeedEvent, T), null)
})

test('feed: ofertas por rango con lo que queda; al cerrarse salen; pasar de fija a rango la mantiene', () => {
	const b = new Book()
	b.apply(ev('p2p.created', { uuid: 'r1' }), T)
	// El dueño la convierte en por rango: «cancelled» y luego «range_created» con la misma hora
	b.apply(ev('p2p.cancelled', { uuid: 'r1', offer_kind: 'flexible' }, 3), T)
	b.apply(ev('p2p.range_created', { uuid: 'r1', amount: '100', receive: '105000', offer_kind: 'flexible', available_amount: '100', order_min: '10', order_max: '50' }, 3), T)
	let l = b.levels('BANK_CUP', 'ask')[0]
	assert.deepEqual([l.kind, l.usd, l.orderMin, l.orderMax, l.price], ['flexible', 100, 10, 50, 1050])
	b.apply(ev('p2p.range_updated', { uuid: 'r1', amount: '100', receive: '105000', offer_kind: 'flexible', available_amount: '60', change: 'taken' }, 4), T)
	l = b.levels('BANK_CUP', 'ask')[0]
	assert.equal(l.usd, 60)
	b.apply(ev('p2p.range_closed', { uuid: 'r1', offer_kind: 'flexible', available_amount: '0' }, 6), T)
	assert.equal(b.count('BANK_CUP', 'ask'), 0)
})

test('lectura con el token: aprende quién es cada dueño y saca lo que se perdió, sin tocar lo recién llegado', () => {
	const b = new Book()
	b.apply(ev('p2p.created', { uuid: 'viejo' }), T)
	b.apply(ev('p2p.created', { uuid: 'nuevo', receive: '20900' }, 60), T + 60_000)
	const list = [{ uuid: 'o9', type: 'sell', coin: 'BANK_CUP', amount: '10', receive: '10600', status: 'open', updated_at: at(0), User: ana }] as P2POffer[]
	// Se leyó todo el lado (menos de 50): lo que no está, sale (salvo lo que llegó hace menos de 30 s)
	assert.equal(b.merge('BANK_CUP', 'ask', list, T + 70_000), 1)
	assert.deepEqual(
		b.levels('BANK_CUP', 'ask').map((l) => [l.uuid, l.user, l.ops, l.rating]),
		[
			['nuevo', 'ana', 45, 4.9],
			['o9', 'ana', 45, 4.9],
		],
	)
	// Leer lo mismo otra vez no cambia nada (no se guarda de nuevo)
	b.changed.clear()
	b.changedOwners.clear()
	b.merge('BANK_CUP', 'ask', list, T + 80_000)
	assert.deepEqual([b.changed.size, b.changedOwners.size], [0, 0])
})

test('firma del webhook: HMAC del cuerpo en crudo, con o sin «sha256=», y hora reciente', async () => {
	const raw = JSON.stringify(ev('p2p.created', {}))
	const sig = createHmac('sha256', 'secreto').update(raw).digest('hex')
	const h = (s: string, t = String(Math.floor(T / 1000))) => new Headers({ 'x-qvapay-signature': s, 'x-qvapay-timestamp': t })
	assert.equal(await feedSigned(raw, h(sig), 'secreto', T), null)
	assert.equal(await feedSigned(raw, h(`sha256=${sig}`), 'secreto', T), null)
	assert.equal(await feedSigned(raw, h(sig, new Date(T).toISOString()), 'secreto', T), null)
	assert.equal(await feedSigned(raw + ' ', h(sig), 'secreto', T), 'firma que no coincide')
	assert.equal(await feedSigned(raw, h(''), 'secreto', T), 'sin firma')
	assert.equal(await feedSigned(raw, h(sig, String(Math.floor(T / 1000) - 600)), 'secreto', T), 'hora de la firma vieja')
})

test('webhook: responde enseguida y le pasa al libro el evento (o por qué se rechazó)', async () => {
	const sent: string[] = []
	const env = {
		DB: {} as never,
		QVAPAY_FEED_SECRET: 'secreto',
		LIVE: { idFromName: () => 'id', get: () => ({ fetch: async (_u: string, init?: RequestInit) => (sent.push(String(init?.body)), new Response('{}')) }) },
	}
	const waits: Promise<unknown>[] = []
	const ctx = { waitUntil: (p: Promise<unknown>) => void waits.push(p) }
	const raw = JSON.stringify(ev('p2p.created', {}))
	const sig = createHmac('sha256', 'secreto').update(raw).digest('hex')
	const post = (body: string, s: string) => feedWebhook(new Request('https://app.terminalp2p.com/api/p2p/feed', { method: 'POST', body, headers: { 'x-qvapay-signature': s } }), env, ctx, T)
	assert.equal((await post(raw, sig)).status, 200)
	assert.equal((await post(raw, 'f'.repeat(64))).status, 401)
	await Promise.all(waits)
	assert.deepEqual(JSON.parse(sent[0]), { raw, rejected: null })
	assert.match(JSON.parse(sent[1]).rejected, /firma que no coincide/)
	// Sin secreto configurado: 503 (QvaPay reintenta), pero lo que llegó se guarda para verlo en el panel
	assert.equal((await feedWebhook(new Request('https://x/api/p2p/feed', { method: 'POST', body: raw }), { ...env, QVAPAY_FEED_SECRET: undefined }, ctx, T)).status, 503)
	await Promise.all(waits)
	assert.deepEqual(JSON.parse(sent[2]), { raw, rejected: 'falta el secreto del feed (QVAPAY_FEED_SECRET)' })
})

test('webhook: producción le reenvía a staging cada evento válido tal cual, con su firma (y nada inválido)', async (t) => {
	const forwarded: { url: string; body: string; sig: string | null }[] = []
	t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
		forwarded.push({ url, body: String(init.body), sig: new Headers(init.headers).get('x-qvapay-signature') })
		return new Response('{}')
	})
	const env = { DB: {} as never, QVAPAY_FEED_SECRET: 'secreto', FEED_FORWARD: 'https://app.staging.terminalp2p.com/api/p2p/feed', LIVE: { idFromName: () => 'id', get: () => ({ fetch: async () => new Response('{}') }) } }
	const waits: Promise<unknown>[] = []
	const ctx = { waitUntil: (p: Promise<unknown>) => void waits.push(p) }
	const raw = JSON.stringify(ev('p2p.created', {}))
	const sig = createHmac('sha256', 'secreto').update(raw).digest('hex')
	const post = (s: string) => feedWebhook(new Request('https://app.terminalp2p.com/api/p2p/feed', { method: 'POST', body: raw, headers: { 'x-qvapay-signature': s } }), env, ctx, T)
	await post(sig)
	await post('0'.repeat(64))
	await Promise.all(waits)
	assert.deepEqual(forwarded, [{ url: 'https://app.staging.terminalp2p.com/api/p2p/feed', body: raw, sig }])
})

test('stream: trocea los eventos aunque lleguen partidos, ignora los comentarios y deja lo incompleto para después', () => {
	const a = sseEvents('retry: 10000\nevent: init\ndata: {"ok":true}\n\n: keepalive 1758391226000\n\nevent: p2p.created\ndata: {"event":"p2p.cre')
	assert.deepEqual(a.events, [{ event: 'init', data: '{"ok":true}' }])
	const b = sseEvents(a.rest + 'ated","data":{}}\r\n\r\nevent: p2p.applied\n')
	assert.deepEqual(b.events, [{ event: 'p2p.created', data: '{"event":"p2p.created","data":{}}' }])
	assert.equal(b.rest, 'event: p2p.applied\n')
})

test('reenvío del stream a staging: firmado como lo firma QvaPay, y staging lo acepta', async () => {
	const raw = JSON.stringify(ev('p2p.created', {}))
	const h = await feedSign(raw, 'secreto', T)
	assert.equal(await feedSigned(raw, new Headers(h), 'secreto', T), null)
	assert.equal(await feedSigned(raw, new Headers(h), 'otro', T), 'firma que no coincide')
})

test('actividad del feed: tomada entera o en parte, retirada, editada y completada (y pasar a rango no es retirarla)', () => {
	const b = new Book()
	b.owners.set('u-ana', { username: 'ana', ops: 40, rating: 4.9, kyc: true, vip: false, gold: false })
	const kinds = (e: FeedEvent) => {
		const r = b.apply(e, T)
		return r?.act ? [r.act.kind, r.act.usd, r.act.user] : null
	}
	const range = (s: number, available: string, change: string | null, extra: Partial<FeedEvent['data']> = {}) =>
		ev('p2p.range_updated', { uuid: 'r', amount: '100', receive: '105000', offer_kind: 'flexible', available_amount: available, change, ...extra }, s)
	assert.deepEqual(kinds(ev('p2p.range_created', { uuid: 'r', amount: '100', receive: '105000', offer_kind: 'flexible', available_amount: '100' }, 1)), ['new', 100, 'ana'])
	assert.deepEqual(kinds(range(2, '70', 'taken')), ['partial', 30, 'ana'])
	assert.deepEqual(kinds(range(3, '80', 'returned')), ['returned', 10, 'ana'])
	assert.deepEqual(kinds(range(4, '80', 'edited', { receive: '106000' })), ['edited', 80, 'ana'])
	assert.deepEqual(kinds(ev('p2p.range_closed', { uuid: 'r', offer_kind: 'flexible', available_amount: '0', change: 'taken' }, 5)), ['taken', 80, 'ana'])
	// Una fija: retirada por su dueño, o pasada a por rango (eso no es retirarla)
	b.apply(ev('p2p.created', { uuid: 'f1' }, 6), T)
	assert.deepEqual(kinds(ev('p2p.cancelled', { uuid: 'f1' }, 7)), ['cancelled', 20, 'ana'])
	b.apply(ev('p2p.created', { uuid: 'f2' }, 8), T)
	assert.equal(kinds(ev('p2p.cancelled', { uuid: 'f2', offer_kind: 'flexible' }, 9)), null)
	// Completada: no cambia el libro, pero es un precio real; pagada no cuenta
	const done = b.apply(ev('p2p.completed', { uuid: 'x', status: 'completed', amount: '50', receive: '52000' }, 10), T)!
	assert.deepEqual([done.changed, done.act?.kind, done.act?.usd, done.act?.price], [false, 'done', 50, 1040])
	assert.equal(b.apply(ev('p2p.paid', { uuid: 'x', status: 'paid' }, 9), T), null)
	// Tomada aunque no estuviera en nuestro libro: se cuenta igual
	assert.deepEqual(kinds(ev('p2p.applied', { uuid: 'fuera', status: 'processing' }, 11)), ['taken', 20, 'ana'])
	// El usuario de un anunciante que aún no se conocía se completa al mandarlo
	const n = b.apply(ev('p2p.created', { uuid: 'z', owner_uuid: 'u-leo' }, 12), T)!.act!
	b.owners.set('u-leo', { username: 'leo', ops: 9, rating: null, kyc: false, vip: false, gold: false })
	assert.equal(b.named([n])[0].user, 'leo')
})

test('volumen: cuentan las fijas al completarse y las partes tomadas de las de rango; la parte que vuelve resta', () => {
	const b = new Book()
	const trade = (e: FeedEvent) => {
		const c = b.apply(e, T)
		return c?.act ? [tradeOf(e.event, c.act), c.act.usd] : [0, 0]
	}
	// Fija: tomarla no cuenta (puede volver); completarla sí, con su monto
	assert.deepEqual(trade(ev('p2p.created', {})), [0, 20])
	assert.deepEqual(trade(ev('p2p.applied', {}, 2)), [0, 20])
	assert.deepEqual(trade(ev('p2p.completed', { status: 'completed' }, 9)), [1, 20])
	// De rango: cada parte tomada suma, la que vuelve resta y lo que quedaba tomado de una vez también suma
	const r = { uuid: 'r1', amount: '100', receive: '105000', offer_kind: 'flexible' as const }
	trade(ev('p2p.range_created', { ...r, available_amount: '100' }, 10))
	assert.deepEqual(trade(ev('p2p.range_updated', { ...r, available_amount: '70', change: 'taken' }, 11)), [1, 30])
	assert.deepEqual(trade(ev('p2p.range_updated', { ...r, available_amount: '80', change: 'returned' }, 12)), [-1, 10])
	assert.deepEqual(trade(ev('p2p.range_closed', { ...r, available_amount: '0', change: 'taken', status: 'open' }, 13)), [1, 80])
	// Cancelar no es una operación
	trade(ev('p2p.created', { uuid: 'o2' }, 14))
	assert.deepEqual(trade(ev('p2p.cancelled', { uuid: 'o2', status: 'cancelled' }, 15)), [0, 20])
})
