import test from 'node:test'
import assert from 'node:assert/strict'
import { bookOf, latest, nostrBook, parseOrder, ratingOf, readRelay, type NostrEvent, type SocketLike } from '../worker/nostr.ts'

const NOW = 1_794_400_000_000
const S = NOW / 1000
const ev = (tags: string[][], o: Partial<NostrEvent> = {}): NostrEvent => ({ pubkey: 'pk1', created_at: S - 60, kind: 38383, tags, ...o })
const base = (extra: string[][] = []) => [['d', 'o1'], ['k', 'sell'], ['f', 'USD'], ['s', 'pending'], ['amt', '0'], ['fa', '10', '600'], ['premium', '2'], ['network', 'mainnet'], ['layer', 'lightning'], ['expiration', String(S + 3600)], ['y', 'mostro', 'Mostro'], ...extra]
const market = { USD: 70_000, CUP: 70_000_000 }

test('nostr: una orden a mercado sale a mercado × (1 + prima), del lado de quien mira', () => {
	const o = parseOrder(ev(base([['pm', 'Zelle', 'Zelle', 'Strike\u0000']])), market, NOW)!
	assert.equal(o.side, 'ask')
	assert.equal(o.price, 71_400)
	assert.equal(o.premium, 2)
	assert.deepEqual([o.min, o.max, o.sats], [10, 600, null])
	assert.deepEqual(o.pays, ['Zelle', 'Strike'])
	assert.equal(o.platform, 'mostro')
	assert.equal(o.node, 'Mostro')
	assert.equal(o.link, null)
	assert.equal(parseOrder(ev(base().map((t) => (t[0] === 'k' ? ['k', 'buy'] : t))), market, NOW)!.side, 'bid')
	// Las monedas estables se comparan con el dólar; sin precio de mercado, sin precio
	assert.equal(parseOrder(ev(base().map((t) => (t[0] === 'f' ? ['f', 'USDT'] : t))), market, NOW)!.price, 71_400)
	assert.equal(parseOrder(ev(base().map((t) => (t[0] === 'f' ? ['f', 'PLN'] : t))), market, NOW)!.price, null)
})

test('nostr: con monto fijo el precio sale de sus satoshis y la prima se calcula', () => {
	const tags = base().map((t) => (t[0] === 'amt' ? ['amt', '1428571'] : t[0] === 'fa' ? ['fa', '1000.0', '1000.0'] : t[0] === 'premium' ? ['premium', '0.00'] : t))
	tags.push(['source', 'https://hodlhodl.com/offers/abc?utm_source=nostr'], ['rating', '{"trades_count":12,"rating":null}'], ['name', 'ana'])
	const o = parseOrder(ev(tags), market, NOW)!
	assert.equal(o.sats, 1_428_571)
	assert.equal(Math.round(o.price!), 70_000)
	assert.equal(o.premium, 0)
	assert.equal(o.link, 'https://hodlhodl.com/offers/abc?utm_source=nostr')
	assert.deepEqual([o.score, o.reviews, o.name], [null, 12, 'ana'])
	// Con rango, los satoshis son los del tope (20–1,000 USD por 1,000 USD en sats)
	const range = parseOrder(ev(tags.map((t) => (t[0] === 'fa' ? ['fa', '20', '1000'] : t))), market, NOW)!
	assert.equal(Math.round(range.price!), 70_000)
	assert.deepEqual([range.min, range.max], [20, 1000])
})

test('nostr: fuera las cerradas, caducadas, de pruebas, sin monto o raras', () => {
	const swap = (k: string, v: string[] | null) => ev(base().filter((t) => t[0] !== k).concat(v ? [v] : []))
	assert.equal(parseOrder(swap('s', ['s', 'canceled']), market, NOW), null)
	assert.equal(parseOrder(swap('expiration', ['expiration', String(S - 1)]), market, NOW), null)
	assert.equal(parseOrder(swap('network', ['network', 'testnet']), market, NOW), null)
	assert.equal(parseOrder(swap('fa', null), market, NOW), null)
	assert.equal(parseOrder(swap('k', ['k', 'swap']), market, NOW), null)
	assert.equal(parseOrder(swap('f', ['f', '<b>']), market, NOW), null)
	assert.equal(parseOrder(ev(base(), { kind: 1 }), market, NOW), null)
	// Un enlace que no es https no se da (los de RoboSats van por Tor, los de Mostro son mostro:)
	assert.equal(parseOrder(ev(base([['source', 'http://x.onion/order/1']])), market, NOW)!.link, null)
	assert.equal(parseOrder(ev(base([['source', 'javascript:alert(1)']])), market, NOW)!.link, null)
	// Una plataforma que es una clave en hexadecimal
	assert.equal(parseOrder(ev(base().filter((t) => t[0] !== 'y').concat([['y', 'ab'.repeat(32)]])), market, NOW)!.platform, 'otra')
})

test('nostr: la valoración de cada plataforma', () => {
	assert.deepEqual(ratingOf(['rating', '["rating",{"days":45,"total_rating":4.84375,"total_reviews":16}]']), { score: 4.84, reviews: 16, days: 45 })
	assert.deepEqual(ratingOf(['rating', '{"trades_count":3,"rating":4.5}']), { score: 4.5, reviews: 3, days: null })
	// Hodl Hodl: de 0 a 1
	assert.deepEqual(ratingOf(['rating', '{"trades_count":6,"rating":0.9}']), { score: 4.5, reviews: 6, days: null })
	assert.deepEqual(ratingOf(['rating', '4.41', '76', '12']), { score: 4.41, reviews: 76, days: 12 })
	assert.deepEqual(ratingOf(['rating', '{roto']), { score: null, reviews: null, days: null })
	assert.deepEqual(ratingOf(undefined), { score: null, reviews: null, days: null })
})

test('nostr: de cada orden vale la versión más reciente de cualquier relay; libro ordenado', () => {
	const open = ev(base(), { created_at: S - 100 })
	const taken = ev(base().map((t) => (t[0] === 's' ? ['s', 'in-progress'] : t)), { created_at: S - 50 })
	assert.equal(latest([open, taken]).length, 1)
	const ask = (d: string, p: string) => ev(base().map((t) => (t[0] === 'd' ? ['d', d] : t[0] === 'premium' ? ['premium', p] : t)))
	const bid = (d: string, p: string) => ev(base().map((t) => (t[0] === 'd' ? ['d', d] : t[0] === 'premium' ? ['premium', p] : t[0] === 'k' ? ['k', 'buy'] : t)))
	const book = bookOf([bid('c', '-3'), open, taken, ask('a', '5'), bid('e', '1'), ask('b', '-1')], market, [], NOW)
	assert.deepEqual(book.orders.map((o) => `${o.side}${o.premium}`), ['ask-1', 'ask5', 'bid1', 'bid-3'])
	assert.deepEqual(book.market, { USD: 70_000 })
})

// Un relay falso: contesta a REQ con los eventos que se le den y EOSE (o nada, para probar el tiempo agotado)
function fakeRelay(events: NostrEvent[], opts: { silent?: boolean } = {}): SocketLike {
	const on: Record<string, ((ev?: { data: unknown }) => void)[]> = {}
	return {
		send(data: string) {
			const m = JSON.parse(data)
			if (m[0] !== 'REQ' || opts.silent) return
			queueMicrotask(() => {
				for (const e of events) on.message?.forEach((f) => f({ data: JSON.stringify(['EVENT', m[1], e]) }))
				on.message?.forEach((f) => f({ data: JSON.stringify(['EVENT', 'otra', events[0]]) }))
				on.message?.forEach((f) => f({ data: 'basura' }))
				on.message?.forEach((f) => f({ data: JSON.stringify(['EOSE', m[1]]) }))
			})
		},
		close() {},
		addEventListener(type: string, fn: (ev?: { data: unknown }) => void) {
			;(on[type] ??= []).push(fn)
		},
	} as SocketLike
}

test('nostr: lee cada relay y uno que falla no rompe el libro', async () => {
	const r = await readRelay('wss://a', async () => fakeRelay([ev(base())]), S)
	assert.deepEqual(r.state, { url: 'wss://a', ok: true, events: 1 })
	const slow = await readRelay('wss://b', async () => fakeRelay([], { silent: true }), S, 30)
	assert.deepEqual(slow.state, { url: 'wss://b', ok: false, events: 0, why: 'tiempo agotado' })
	const down = await readRelay('wss://c', async () => {
		throw new Error('HTTP 403')
	}, S)
	assert.deepEqual(down.state, { url: 'wss://c', ok: false, events: 0, why: 'HTTP 403' })

	let n = 0
	const connect = async () => {
		if (n++ === 0) throw new Error('HTTP 502')
		return fakeRelay([ev(base())])
	}
	const fetcher = (async () => Response.json({ BTC: { USD: 70_000, XX: 'no' } })) as typeof fetch
	const book = await nostrBook(connect, fetcher, NOW)
	assert.equal(book.relays.filter((x) => x.ok).length, 4)
	assert.equal(book.orders.length, 1)
	assert.equal(book.orders[0].price, 71_400)
	// Sin Yadio el libro sale igual, sin precios
	const noPrice = await nostrBook(async () => fakeRelay([ev(base())]), (async () => new Response('x', { status: 500 })) as typeof fetch, NOW)
	assert.equal(noPrice.orders[0].price, null)
})
