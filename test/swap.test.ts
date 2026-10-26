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

// QvaPay simulado para la orden inteligente: ventas que se pueden comprar y una compra que se puede vender
function smartQvaPay(failApply?: string, failCreate = false) {
	const calls: string[] = []
	const created: unknown[] = []
	// Como el detalle real de QvaPay: el dueño viene sin su historial (operaciones y ★ solo salen en el listado)
	const seller = (u: string) => ({ uuid: `u-${u}`, username: u, kyc: true, vip: false })
	const offers: Record<string, P2POffer> = {
		s1: { uuid: 's1', type: 'sell', coin: 'BANK_CUP', amount: '20', receive: '20960', status: 'open', User: seller('ana'), details: [{ name: 'Tarjeta', value: '9200 2222' }], payment_window_expires_at: '2026-10-25T03:30:00Z' },
		s2: { uuid: 's2', type: 'sell', coin: 'BANK_CUP', amount: '100', receive: '105000', available_amount: '70', order_min: '10', order_max: '70', offer_kind: 'flexible', status: 'open', User: seller('leo') },
		b1: { uuid: 'b1', type: 'buy', coin: 'BANK_CUP', amount: '50', receive: '52000', status: 'open', User: seller('eva') },
		b2: { uuid: 'b2', type: 'buy', coin: 'BANK_CUP', amount: '30', receive: '31200', status: 'open', User: seller('max') },
	}
	const client = {
		me: async () => ({ uuid: 'me', username: 'yo', balance: 300, kyc: true, golden_check: false, p2p_enabled: true }),
		getOffer: async (uuid: string) => {
			if (!offers[uuid]) throw new Error('404')
			return structuredClone(offers[uuid])
		},
		applyOffer: async (uuid: string, amount?: number) => {
			calls.push(`apply:${uuid}:${amount}`)
			if (uuid === failApply) throw new Error('Esta oferta ya fue tomada')
			// Como en QvaPay: la fija pasa a en proceso contigo de contraparte; en la por rango nace tu orden
			const o = offers[uuid]
			if (o.offer_kind === 'flexible') o.Orders = [...(o.Orders ?? []), { uuid: `ord-${uuid}`, amount: String(amount), receive: '0', status: 'processing', Taker: { uuid: 'me', username: 'yo' } }]
			else Object.assign(o, { status: 'processing', Peer: { uuid: 'me', username: 'yo' } })
			return { order: o.offer_kind === 'flexible' ? `ord-${uuid}` : null }
		},
		cancelOrder: async (uuid: string, order?: string) => (calls.push(`cancel:${uuid}:${order}`), { message: 'P2P cancelada' }),
		createOffer: async (body: { amount: number }) => {
			calls.push(`create:${body.amount}`)
			created.push(body)
			if (failCreate) throw new Error('Datos inválidos')
			return { p2p: { uuid: 'nueva' } }
		},
		sendChat: async (uuid: string, message: string) => void calls.push(`chat:${uuid}:${message}`),
		editOffer: async (uuid: string, body: unknown) => void calls.push(`edit:${uuid}:${JSON.stringify(body)}`),
	}
	return { client: client as unknown as QvaPayClient, calls, offers, created }
}

async function smartSetup(failApply?: string, failCreate = false) {
	const fake = smartQvaPay(failApply, failCreate)
	const acc = { sid: 'sid1', me: await fake.client.me(), client: fake.client }
	const broker = new Broker({ accounts: { get: async () => acc } as unknown as AccountStore, market: { wake() {} }, dryRun: false })
	const to = (path: string) => async (body: unknown) => {
		const res = (await broker.handle(new Request(`https://app.terminalp2p.com/api/broker${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Broker': '1' }, body: JSON.stringify(body) })))!
		return res.json()
	}
	return { fake, post: to('/smart') }
}

const rest = { amount: 210, price: 1050, kind: 'fixed', details: [{ name: 'Tarjeta', value: '9200' }] }
const buyOrder = { side: 'buy', coin: 'BANK_CUP', price: 1050, takes: [{ offer: 's1', amount: 20 }, { offer: 's2', amount: 70 }], offer: rest }
const statuses = (r: { steps: { status: string }[] }) => r.steps.map((s) => s.status)
const noCancels = (calls: string[]) => assert.ok(!calls.some((c) => c.startsWith('cancel')), `se canceló algo: ${calls.join(', ')}`)

test('orden inteligente: toma las dos y publica el resto, con la lista de pagos', async () => {
	const { fake, post } = await smartSetup()
	const r = await post(buyOrder)
	assert.equal(r.ok, true)
	assert.deepEqual(fake.calls, ['apply:s1:undefined', 'apply:s2:70', 'create:210'])
	assert.deepEqual([r.published, r.rest], ['nueva', 210])
	assert.deepEqual(statuses(r), ['taken', 'taken'])
	assert.deepEqual(r.steps[0].pay, { details: [{ name: 'Tarjeta', value: '9200 2222' }], expiresAt: '2026-10-25T03:30:00Z', coinAmount: 20960 })
	assert.equal(r.steps[1].pay.coinAmount, 73500)
})

test('orden inteligente: una oferta que cambió se salta y su parte se suma a lo que publicas', async () => {
	const { fake, post } = await smartSetup()
	fake.offers.s2.receive = '107000' // ahora 1070 por USD: ya no cruza con tu 1050
	const r = await post(buyOrder)
	assert.equal(r.ok, true)
	assert.deepEqual(statuses(r), ['taken', 'skipped'])
	assert.match(r.steps[1].error, /cambió de precio/)
	assert.deepEqual(fake.calls, ['apply:s1:undefined', 'create:280'])
	// Igual con una cuenta sin historial o una oferta que ya no existe
	const { fake: f2, post: p2 } = await smartSetup()
	f2.offers.s1.User = { uuid: 'u-nuevo', username: 'nuevo', rating_count: 0, _count: { P2P: 1, P2P_Peer: 0 } }
	delete f2.offers.s2
	const r2 = await p2(buyOrder)
	assert.deepEqual(statuses(r2), ['skipped', 'skipped'])
	assert.match(r2.steps[0].error, /poco historial/)
	assert.deepEqual(f2.calls, ['create:300'])
})

test('orden inteligente: si una toma falla, se sigue con lo demás y no se cancela nada', async () => {
	const { fake, post } = await smartSetup('s1')
	const r = await post(buyOrder)
	assert.deepEqual(statuses(r), ['failed', 'taken'])
	assert.deepEqual(fake.calls, ['apply:s1:undefined', 'apply:s2:70', 'create:230'])
	noCancels(fake.calls)
})

test('orden inteligente: si no se puede publicar el resto, las tomas siguen y se avisa', async () => {
	const { fake, post } = await smartSetup(undefined, true)
	const r = await post(buyOrder)
	assert.equal(r.ok, true)
	assert.deepEqual(statuses(r), ['taken', 'taken'])
	assert.equal(r.published, null)
	assert.equal(r.publishError, 'Datos inválidos')
	noCancels(fake.calls)
})

test('orden inteligente: un corte de red no esconde una toma hecha', async () => {
	const { fake, post } = await smartSetup()
	const realApply = fake.client.applyOffer.bind(fake.client)
	;(fake.client as unknown as { applyOffer: typeof realApply }).applyOffer = async (uuid, amount, meta) => {
		const r = await realApply(uuid, amount, meta)
		if (uuid === 's1') throw new TypeError('Failed to fetch')
		return r
	}
	const r = await post(buyOrder)
	assert.deepEqual(statuses(r), ['taken', 'taken'])
	assert.deepEqual(fake.calls, ['apply:s1:undefined', 'apply:s2:70', 'create:210'])
})

test('orden inteligente: si el dueño subió el precio justo antes, queda tomada y se avisa (sin cancelar)', async () => {
	const { fake, post } = await smartSetup()
	const realApply = fake.client.applyOffer.bind(fake.client)
	;(fake.client as unknown as { applyOffer: typeof realApply }).applyOffer = async (uuid, amount, meta) => {
		if (uuid === 's2') fake.offers.s2.receive = '108000'
		return realApply(uuid, amount, meta)
	}
	const r = await post(buyOrder)
	assert.deepEqual(statuses(r), ['taken', 'taken'])
	assert.match(r.notes[0], /@leo cambió el precio justo antes: compraste a 1080.*cancelarla en «Mis operaciones» sin disputa/)
	noCancels(fake.calls)
})

test('orden inteligente vendiendo: dos tomas, tus datos a cada comprador y nunca más que tu saldo', async () => {
	const { fake, post } = await smartSetup()
	const details = [{ label: 'Tarjeta', value: '9200 1111' }]
	const sell = { side: 'sell', coin: 'BANK_CUP', price: 1040, takes: [{ offer: 'b1', amount: 50 }, { offer: 'b2', amount: 30 }], offer: { ...rest, amount: 20 }, details }
	const poor = await post({ ...sell, offer: { ...rest, amount: 230 } })
	assert.equal(poor.nothingDone, true)
	assert.match(poor.error, /necesitas 310 USD/)
	assert.equal(fake.calls.length, 0)
	const r = await post(sell)
	assert.deepEqual(statuses(r), ['taken', 'taken'])
	assert.equal(r.chatSent, true)
	assert.equal(fake.calls[0], 'apply:b1:undefined')
	assert.match(fake.calls[1], /^chat:b1:Hola\. Vendo 50 USD[\s\S]*Tarjeta: 9200 1111/)
	assert.match(fake.calls[3], /^chat:b2:Hola\. Vendo 30 USD/)
	assert.equal(fake.calls[4], 'create:20')
	noCancels(fake.calls)
})

test('orden inteligente: el resto se publica siempre entero, aunque se pida por partes', async () => {
	const { fake, post } = await smartSetup()
	await post({ ...buyOrder, offer: { ...rest, kind: 'flexible', orderMin: 10, orderMax: 100 } })
	const body = fake.created[0] as Record<string, unknown>
	assert.equal(body.amount, 210)
	assert.equal(body.offer_kind, undefined)
	assert.equal(body.order_min, undefined)
	// Pública salvo que se pida privada
	assert.equal(body.private, 0)
})
