import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { test } from 'node:test'
import type { P2POffer } from '../src/qvapay/types.ts'
import { Book, feedSign, lagStats, feedSigned, feedWebhook, liveSocket, sseEvents, type FeedEvent, type LiveEnv } from '../worker/livebook.ts'
import { liveRows } from '../worker/pro.ts'

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

test('oferta compartida: abierta con su mercado y lado, ya fuera del libro o desconocida', () => {
	const b = new Book()
	b.apply(ev('p2p.created', {}), T)
	const open = b.find('o1')
	assert.equal(open.state, 'open')
	if (open.state === 'open') assert.deepEqual([open.coin, open.side, open.level.price, open.level.usd], ['BANK_CUP', 'ask', 1050, 20])
	b.apply(ev('p2p.applied', {}, 5), T)
	assert.deepEqual(b.find('o1'), { state: 'gone', coin: 'BANK_CUP', side: 'ask' })
	assert.deepEqual(b.find('otra'), { state: 'unknown' })
	// Reabierta, vuelve a estar abierta; y lo que salió se olvida con el resto de lo que salió
	b.apply(ev('p2p.reopened', {}, 9), T)
	assert.equal(b.find('o1').state, 'open')
	b.apply(ev('p2p.cancelled', { status: 'cancelled' }, 12), T)
	b.prune(T + 25 * 3600_000)
	assert.deepEqual(b.find('o1'), { state: 'unknown' })
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

test('lectura con la promocionada: no borra las ofertas que hay entre las 50 mejores y su precio, y ella no sale al leer el lado entero', () => {
	const b = new Book()
	const mk = (i: number, price: number) => ({ uuid: `s${i}`, type: 'sell', coin: 'BANK_CUP', amount: '10', receive: String(price * 10), status: 'open', updated_at: at(0), User: ana }) as P2POffer
	const all = Array.from({ length: 80 }, (_, i) => mk(i, 400 + i))
	b.merge('BANK_CUP', 'ask', all, T + 60_000, true)
	assert.equal(b.count('BANK_CUP', 'ask'), 80)
	// Las 50 mejores (400–449) y la promocionada a 470: siguen las 80
	assert.equal(b.read('BANK_CUP', 'ask', all.slice(0, 50), mk(70, 470), T + 120_000), 0)
	assert.equal(b.count('BANK_CUP', 'ask'), 80)
	// Lado entero (menos de 50) con una promocionada que no sale en la lista: lo demás que falta sale, ella se queda
	const c = new Book()
	c.merge('BANK_CUP', 'ask', all.slice(0, 5), T + 60_000, true)
	c.read('BANK_CUP', 'ask', all.slice(0, 3), mk(60, 460), T + 120_000)
	assert.deepEqual(c.levels('BANK_CUP', 'ask').map((l) => l.uuid), ['s0', 's1', 's2', 's60'])
})

test('lectura del lado entero: mete las viejas que no se conocían y saca lo que falta dos veces seguidas', () => {
	const b = new Book()
	b.apply(ev('p2p.created', { uuid: 'conocida' }), T)
	const page = [{ uuid: 'vieja', type: 'sell', coin: 'BANK_CUP', amount: '20', receive: '26000', status: 'open', updated_at: '2026-10-20T16:59:00Z', User: ana }] as P2POffer[]
	assert.equal(b.merge('BANK_CUP', 'ask', page, T + 3600_000, true), 0)
	assert.deepEqual(b.levels('BANK_CUP', 'ask').map((l) => l.uuid).sort(), ['conocida', 'vieja'])
	assert.equal(b.count('BANK_CUP', 'ask'), 2)
	// La siguiente lectura entera ya no trae la vieja: la primera vez solo se apunta, la segunda sale
	const seen = new Set<string>()
	b.merge('BANK_CUP', 'ask', [{ uuid: 'conocida', type: 'sell', coin: 'BANK_CUP', amount: '10', receive: '10500', status: 'open', updated_at: at(0), User: ana }] as P2POffer[], T + 7200_000, true, seen)
	assert.equal(b.sweep('BANK_CUP', 'ask', seen, T + 7200_000, T + 7200_000), 0)
	assert.equal(b.sweep('BANK_CUP', 'ask', seen, T + 10800_000, T + 10800_000), 1)
	assert.deepEqual(b.levels('BANK_CUP', 'ask').map((l) => l.uuid), ['conocida'])
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

test('volumen: cuentan las fijas al completarse y lo tomado de las de rango; lo que vuelve resta y un aviso repetido no suma', () => {
	const b = new Book()
	const trade = (e: FeedEvent) => {
		const t = b.apply(e, T)?.trade
		return t ? [t.ops, t.usd] : null
	}
	// Fija: tomarla no cuenta (puede volver); completarla sí, con su monto, y una sola vez (llega por el webhook y el stream)
	assert.equal(trade(ev('p2p.created', {})), null)
	assert.equal(trade(ev('p2p.applied', {}, 2)), null)
	assert.deepEqual(trade(ev('p2p.completed', { status: 'completed' }, 9)), [1, 20])
	assert.equal(trade(ev('p2p.completed', { status: 'completed' }, 9)), null)
	// De rango: cada parte tomada suma lo que bajó lo disponible; la que vuelve resta
	const r = { uuid: 'r1', amount: '100', receive: '105000', offer_kind: 'flexible' as const }
	assert.equal(trade(ev('p2p.range_created', { ...r, available_amount: '100' }, 10)), null)
	assert.deepEqual(trade(ev('p2p.range_updated', { ...r, available_amount: '70', change: 'taken' }, 11)), [1, 30])
	assert.deepEqual(trade(ev('p2p.range_updated', { ...r, available_amount: '80', change: 'returned' }, 12)), [-1, 10])
	// Se cierra tomada con un resto por debajo del mínimo: cuenta lo tomado (75), no lo que quedaba antes (80)
	const closed = ev('p2p.range_closed', { ...r, available_amount: '5', change: 'taken', status: 'completed' }, 13)
	assert.deepEqual(trade(closed), [1, 75])
	// El mismo cierre otra vez (por el stream), con la oferta ya fuera del libro: no suma
	assert.equal(trade(closed), null)
	// QvaPay la pausa con lo tomado de vuelta y la reanuda: esa parte no se operó
	assert.deepEqual(trade(ev('p2p.range_closed', { ...r, available_amount: '100', change: 'paused', status: 'open' }, 14)), [-1, 95])
	assert.equal(trade(ev('p2p.range_updated', { ...r, available_amount: '100', change: 'resumed', status: 'open' }, 15)), null)
	// Editarla (puede cambiar el monto) no cuenta; lo tomado después se mide desde ahí
	assert.equal(trade(ev('p2p.range_updated', { ...r, amount: '120', receive: '126000', available_amount: '120', change: 'edited', status: 'open' }, 16)), null)
	assert.deepEqual(trade(ev('p2p.range_updated', { ...r, amount: '120', receive: '126000', available_amount: '100', change: 'taken', status: 'open' }, 17)), [1, 20])
	// De una que no conocíamos (ni en el libro), la primera noticia no cuenta: monto − disponible es toda su vida
	const r2 = { uuid: 'r2', amount: '50', receive: '52500', offer_kind: 'flexible' as const }
	assert.equal(trade(ev('p2p.range_updated', { ...r2, available_amount: '20', change: 'taken', status: 'open' }, 18)), null)
	assert.deepEqual(trade(ev('p2p.range_closed', { ...r2, available_amount: '0', change: 'taken', status: 'completed' }, 18.5)), [1, 20])
	// Cancelar no es una operación
	trade(ev('p2p.created', { uuid: 'o2' }, 19))
	assert.equal(trade(ev('p2p.cancelled', { uuid: 'o2', status: 'cancelled' }, 20)), null)
	// Se olvida a los tres días (como mucho, una vez por hora)
	assert.deepEqual(b.pruneTrades(T + 4 * 86_400_000).sort(), ['d:o1', 'f:r1', 'f:r2'])
	assert.deepEqual(b.pruneTrades(T + 4 * 86_400_000 + 60_000), [])
})

test('en vivo (panel): cada conexión lleva su cuenta; se juntan por cuenta con sus pestañas, mercados, desde cuándo y última señal', async () => {
	// El libro en vivo recibe de qué cuenta es cada conexión (la que confirmó QvaPay)
	let asked = ''
	const env = { LIVE_FREE: '1', LIVE: { idFromName: () => 'id', get: () => ({ fetch: async (u: string) => ((asked = u), new Response('ok')) }) } } as unknown as LiveEnv
	const req = new Request('https://app.terminalp2p.com/live?p=' + 'a'.repeat(64), { headers: { Upgrade: 'websocket' } })
	await liveSocket(req, new URL(req.url), env, async () => ({ ok: true, pro: true, username: 'Ana' }))
	assert.equal(asked, 'https://live/ws?pro=1&u=Ana')
	const rows = liveRows([
		{ u: 'Ana', pro: false, subs: ['BANK_CUP'], at: T + 5000, seen: T + 9000 },
		{ u: 'leo', pro: false, subs: [], at: T + 1000, seen: null },
		{ u: 'ana', pro: true, subs: ['ETECSA', 'BANK_CUP'], at: T + 2000, seen: T + 7000 },
	])
	assert.deepEqual(
		rows.map((r) => [r.u, r.tabs, r.pro, [...r.subs], r.at, r.seen]),
		[
			['leo', 1, false, [], T + 1000, T + 1000],
			['Ana', 2, true, ['BANK_CUP', 'ETECSA'], T + 2000, T + 9000],
		],
	)
})

test('retraso del feed: mediana, 90 % y el peor', () => {
	assert.equal(lagStats([]), null)
	assert.deepEqual(lagStats([300, 100, 200, 5000, 400, 250, 150, 350, 450, 120]), { n: 10, p50: 300, p90: 5000, max: 5000 })
})

test('foto del libro: mejor precio sin lo atípico ni lo solo-VIP, USD cerca del mejor, concentración, frescura y precio de tomar 100 y 500', () => {
	const b = new Book()
	const sell = (uuid: string, usd: number, price: number, s: number, extra: Partial<FeedEvent['data']> = {}) =>
		b.apply(ev('p2p.created', { uuid, amount: String(usd), receive: String(usd * price), owner_uuid: `u-${uuid}`, ...extra }, s), T)
	sell('vip', 50, 1040, 0, { only_vip: true })
	sell('a', 60, 1050, -600)
	sell('b', 40, 1055, -1200, { owner_uuid: 'u-a' })
	sell('c', 300, 1080, -60)
	sell('d', 500, 1200, -30)
	sell('typo', 10, 105, 0)
	const s = b.stats('BANK_CUP', 'ask', 1060, T)
	assert.deepEqual([s.offers, s.outliers, s.best, s.usd], [5, 1, 1050, 950])
	// Hasta un 1 % del mejor (1,060.50): la solo-VIP y las dos de @a; hasta un 3 %, también la de 1,080
	assert.deepEqual([s.usd1, s.usd3], [150, 450])
	// El que más tiene es @d (500 de 950); los tres primeros, d + c + a(100)
	assert.deepEqual([s.top1, s.top3], [0.526, 0.947])
	// Las cinco con su último cambio hace 0, 10, 20, 1 y 0.5 min: la mediana, 1
	assert.equal(s.age, 1)
	// 100 USD: 60 a 1,050 y 40 a 1,055 (la solo-VIP no la toma cualquiera); 500: además 300 a 1,080 y 100 a 1,200
	assert.equal(s.fill100, 1052)
	assert.equal(s.fill500, (60 * 1050 + 40 * 1055 + 300 * 1080 + 100 * 1200) / 500)
	// Sin referencia nada es atípico; un lado vacío no tiene mejor precio ni concentración
	assert.equal(b.stats('BANK_CUP', 'ask', null, T).outliers, 0)
	const empty = b.stats('BANK_CUP', 'bid', 1060, T)
	assert.deepEqual([empty.offers, empty.best, empty.usd, empty.top1, empty.age, empty.fill100], [0, null, 0, null, null, null])
})

test('libro: se olvida al dueño que no sale en 30 días y no tiene ofertas; lo que salió no queda pendiente de barrer', () => {
	const b = new Book()
	const leo = { ...ana, uuid: 'u-leo', username: 'leo' }
	const list = [
		{ uuid: 'a1', type: 'sell', coin: 'BANK_CUP', amount: '10', receive: '10600', status: 'open', updated_at: at(0), User: ana },
		{ uuid: 'l1', type: 'sell', coin: 'BANK_CUP', amount: '10', receive: '10700', status: 'open', updated_at: at(0), User: leo },
	] as P2POffer[]
	b.merge('BANK_CUP', 'ask', list, T)
	assert.equal(b.owners.get('u-ana')?.seen, '2026-10-27')
	// La de leo sale del libro; pasan 31 días: leo se olvida, ana (con oferta) no
	b.apply(ev('p2p.cancelled', { uuid: 'l1', owner_uuid: 'u-leo', status: 'cancelled' }, 10), T + 10_000)
	const later = T + 31 * 86_400_000
	assert.deepEqual(b.pruneTrades(later), ['u:u-leo'])
	assert.deepEqual([...b.owners.keys()], ['u-ana'])
	// Un dueño guardado de antes (sin día) cuenta desde hoy
	b.owners.set('u-old', { username: 'old', ops: 1, rating: null, kyc: false, vip: false, gold: false })
	b.pruneTrades(later + 2 * 3600_000)
	assert.equal(b.owners.get('u-old')?.seen, new Date(later + 2 * 3600_000).toISOString().slice(0, 10))
	assert.ok(b.changedOwners.has('u-old'))
})
