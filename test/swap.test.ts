import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Broker, bestSwap, dropOutliers, type AccountStore } from '../src/broker/routes.ts'
import type { QvaPayClient } from '../src/qvapay/client.ts'
import type { ListParams, P2POffer } from '../src/qvapay/types.ts'

const vip = (username: string) => ({ uuid: `u-${username}`, username, vip: true, golden_check: true, rating_avg: 4.9, rating_count: 100, _count: { P2P: 900, P2P_Peer: 100 } })

// QvaPay simulado con ofertas de compra de cuentas VIP en CUP Transferencia
function fakeQvaPay() {
	const calls: string[] = []
	const lists: ListParams[] = []
	const offers: Record<string, P2POffer> = {
		v1: { uuid: 'v1', type: 'buy', coin: 'BANK_CUP', amount: '4000', receive: '4064000', available_amount: '3919', order_min: '10', order_max: '4000', offer_kind: 'flexible', status: 'open', User: vip('lock') },
		v2: { uuid: 'v2', type: 'buy', coin: 'BANK_CUP', amount: '1100', receive: '1116500', available_amount: '1100', order_min: '5', order_max: '500', offer_kind: 'flexible', status: 'open', User: vip('azi') },
		v3: { uuid: 'v3', type: 'buy', coin: 'BANK_CUP', amount: '50', receive: '49500', status: 'open', User: vip('also') },
		// Solo VIP, requisitos que no cumples y un error de tipeo: fuera
		v4: { uuid: 'v4', type: 'buy', coin: 'BANK_CUP', amount: '100', receive: '103000', status: 'open', only_vip: true, User: vip('x') },
		v5: { uuid: 'v5', type: 'buy', coin: 'BANK_CUP', amount: '100', receive: '103000', status: 'open', requirements_met: false, User: vip('y') },
		v6: { uuid: 'v6', type: 'buy', coin: 'BANK_CUP', amount: '100', receive: '1010000', status: 'open', User: vip('typo') },
	}
	const client = {
		me: async () => ({ uuid: 'me', username: 'yo', balance: 300, kyc: true, golden_check: false, p2p_enabled: true }),
		listOffers: async (p: ListParams) => (lists.push(p), { current_page: 1, per_page: 30, total: 6, data: Object.values(offers).map((o) => structuredClone(o)) }),
		getOffer: async (uuid: string) => structuredClone(offers[uuid]),
		applyOffer: async (uuid: string, amount?: number, meta?: unknown) => (calls.push(`apply:${uuid}:${amount}:${JSON.stringify(meta)}`), { order: 'o1' }),
		sendChat: async (uuid: string, message: string, order?: string) => void calls.push(`chat:${uuid}:${order}:${message}`),
		markReceived: async () => void calls.push('received'),
	}
	return { client: client as unknown as QvaPayClient, calls, lists, offers }
}

async function setup() {
	const fake = fakeQvaPay()
	const acc = { sid: 'sid1', me: await fake.client.me(), client: fake.client }
	const accounts = { get: async () => acc } as unknown as AccountStore
	const broker = new Broker({ accounts, market: { wake() {} }, dryRun: false })
	const call = async (method: string, path: string, body?: unknown) => {
		const res = (await broker.handle(
			new Request(`https://app.terminalp2p.com/api/broker${path}`, { method, headers: { 'Content-Type': 'application/json', 'X-Broker': '1' }, body: body === undefined ? undefined : JSON.stringify(body) }),
		))!
		return { status: res.status, body: await res.json() }
	}
	return { fake, get: (p: string) => call('GET', p), post: (p: string, b: unknown) => call('POST', p, b) }
}

test('Vender ya: solo ofertas VIP que puedes tomar, de mejor a peor precio', async () => {
	const { fake, get } = await setup()
	const { body } = await get('/swap/quote?coin=BANK_CUP&amount=200')
	assert.deepEqual(fake.lists[0], { type: 'buy', coin: 'BANK_CUP', vip_maker: 1, orderBy: 'best_rate', orderType: 'desc', take: 30 })
	assert.deepEqual(
		body.offers.map((o: { offer: string; price: number }) => [o.offer, o.price]),
		[
			['v1', 1016],
			['v2', 1015],
			['v3', 990],
		],
	)
	assert.equal(body.best.offer, 'v1')
	// Lo que queda disponible limita el máximo por orden
	assert.equal(body.offers[0].orderMax, 3919)
	// Se reutiliza la lectura reciente; con fresh=1 se vuelve a pedir
	await get('/swap/quote?coin=BANK_CUP&amount=50')
	assert.equal(fake.lists.length, 1)
	await get('/swap/quote?coin=BANK_CUP&amount=50&fresh=1')
	assert.equal(fake.lists.length, 2)
	assert.equal((await get('/swap/quote?coin=NADA')).status, 400)
})

test('mejor oferta en la que cabe el monto', () => {
	const offers = [
		{ offer: 'a', price: 1016, usd: 300, kind: 'flexible' as const, orderMin: 100, orderMax: 300 },
		{ offer: 'b', price: 1010, usd: 50, kind: 'fixed' as const, orderMin: null, orderMax: null },
		{ offer: 'c', price: 1000, usd: 900, kind: 'flexible' as const, orderMin: 5, orderMax: 900 },
	]
	assert.equal(bestSwap(offers, 200)?.offer, 'a')
	// Las fijas se toman enteras
	assert.equal(bestSwap(offers, 50)?.offer, 'b')
	assert.equal(bestSwap(offers, 40)?.offer, 'c')
	assert.equal(bestSwap(offers, 5000), null)
	assert.equal(bestSwap(offers, 0), null)
	assert.deepEqual(
		dropOutliers([{ price: 1000 }, { price: 1010 }, { price: 10100 }, { price: 990 }]).map((o) => o.price),
		[1000, 1010, 990],
	)
})

test('Vender ya: toma la oferta, manda tus datos por el chat y nunca libera', async () => {
	const { fake, post } = await setup()
	const details = [{ name: 'card', label: 'Tarjeta', value: '9200 0000 1111 2222' }]
	const r = await post('/swap', { offer: 'v1', amount: 200, minPrice: 1016, details })
	assert.equal(r.status, 200)
	assert.deepEqual([r.body.offer, r.body.order, r.body.chatSent], ['v1', 'o1', true])
	assert.equal(fake.calls[0], `apply:v1:200:${JSON.stringify({ coin: 'BANK_CUP', side: 'buy', usd: 200, via: 'swap' })}`)
	assert.match(fake.calls[1], /^chat:v1:o1:.*Tarjeta: 9200 0000 1111 2222/s)
	assert.ok(!fake.calls.includes('received'))
})

test('Vender ya: no vende si el precio bajó, si no cabe el monto o si no es VIP', async () => {
	const { fake, post } = await setup()
	const details = [{ label: 'Tarjeta', value: '9200' }]
	fake.offers.v1.receive = '4000000' // ahora paga 1.000
	const lower = await post('/swap', { offer: 'v1', amount: 200, minPrice: 1016, details })
	assert.equal(lower.status, 409)
	assert.match(lower.body.error, /bajó/)
	assert.equal((await post('/swap', { offer: 'v2', amount: 600, minPrice: 1015, details })).status, 409)
	// La fija se toma entera
	assert.equal((await post('/swap', { offer: 'v3', amount: 20, minPrice: 990, details })).status, 409)
	assert.equal((await post('/swap', { offer: 'v2', amount: 100, minPrice: 1015, details: [] })).status, 400)
	// Más de lo que tienes (300 USD)
	const over = await post('/swap', { offer: 'v1', amount: 400, minPrice: 1000, details })
	assert.equal(over.status, 400)
	assert.match(over.body.error, /saldo/)
	fake.offers.v2.User = { ...vip('azi'), vip: false }
	assert.equal((await post('/swap', { offer: 'v2', amount: 100, minPrice: 1015, details })).status, 400)
	fake.offers.v3.status = 'processing'
	assert.equal((await post('/swap', { offer: 'v3', amount: 50, minPrice: 990, details })).status, 409)
	assert.deepEqual(fake.calls, [])
})
