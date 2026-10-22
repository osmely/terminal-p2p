import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Broker, type AccountStore } from '../src/broker/routes.ts'
import type { QvaPayClient } from '../src/qvapay/client.ts'
import type { P2POffer } from '../src/qvapay/types.ts'

// QvaPay simulado: el usuario "yo" ya tomó dos ofertas
function fakeQvaPay() {
	const calls: string[] = []
	const other = { uuid: 's1', username: 'otro' }
	const me = { uuid: 'me', username: 'yo' }
	const offers: Record<string, P2POffer> = {
		// Compro USD: me toca pagar
		a1: { uuid: 'a1', type: 'sell', coin: 'BANK_CUP', amount: '20', receive: '20100', status: 'processing', User: other, Peer: me, details: { 'Nro de tarjeta': '9200 1111' } },
		// Vendo USD: me pagaron, me toca liberar
		b1: { uuid: 'b1', type: 'buy', coin: 'BANK_CUP', amount: '30', receive: '30300', status: 'paid', User: other, Peer: me, tx_id: 'REF-7' },
	}
	const client = {
		me: async () => ({ uuid: 'me', username: 'yo', balance: 100, kyc: true, golden_check: false, p2p_enabled: true }),
		getOffer: async (uuid: string) => structuredClone(offers[uuid]),
		listOffers: async () => ({ current_page: 1, per_page: 50, total: 2, data: Object.values(offers) }),
		getChat: async () => [],
		markPaid: async (uuid: string, tx: string) => {
			calls.push(`paid:${uuid}:${tx}`)
			offers[uuid].status = 'paid'
		},
		markReceived: async (uuid: string) => {
			calls.push(`received:${uuid}`)
			offers[uuid].status = 'completed'
			return { amount: 29.92, fee: 0.08, gross_amount: 30 }
		},
		cancelOrder: async (uuid: string) => (calls.push(`cancel:${uuid}`), { message: 'P2P cancelada' }),
	}
	return { client: client as unknown as QvaPayClient, calls, offers }
}

const BASE = 'https://terminalp2p.com/api/broker'
const HEADERS = { 'Content-Type': 'application/json', 'X-Broker': '1', Cookie: 'sid=sid1' }

async function setup() {
	const fake = fakeQvaPay()
	const acc = { sid: 'sid1', me: await fake.client.me(), client: fake.client }
	const accounts = { get: async (sid?: string) => (sid === 'sid1' ? acc : null) } as unknown as AccountStore
	const broker = new Broker({ accounts, market: { wake() {} }, dryRun: false })
	const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = HEADERS) => {
		const res = (await broker.handle(new Request(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })))!
		return { status: res.status, body: await res.json() }
	}
	return { fake, post: (p: string, b: unknown, h?: Record<string, string>) => call('POST', p, b, h), get: (p: string, h?: Record<string, string>) => call('GET', p, undefined, h) }
}

test('mis operaciones: acciones según el lado y liberación protegida', async () => {
	const { fake, post, get } = await setup()
	const { body } = await get('/trades')
	const byId = Object.fromEntries(body.trades.map((t: { id: string }) => [t.id, t]))
	assert.deepEqual(byId.a1.actions, ['pay', 'cancel'])
	assert.deepEqual(byId.b1.actions, ['release', 'dispute'])

	// El detalle trae los datos del vendedor para pagarle
	const detail = await get('/trade?offer=a1')
	assert.deepEqual(detail.body.ownerDetails, [{ name: 'Nro de tarjeta', value: '9200 1111' }])

	// Liberar con la operación en "esperando pago" está prohibido
	const early = await post('/trade/action', { offer: 'a1', action: 'release' })
	assert.equal(early.status, 400)
	assert.match(early.body.error, /no en pagado/)

	// Pagar exige referencia
	assert.equal((await post('/trade/action', { offer: 'a1', action: 'paid' })).status, 400)
	assert.equal((await post('/trade/action', { offer: 'a1', action: 'paid', txId: 'REF-9' })).status, 200)

	// Con la operación en "pagado" sí se libera
	const ok = await post('/trade/action', { offer: 'b1', action: 'release' })
	assert.equal(ok.status, 200)
	assert.match(ok.body.message, /Liberado/)
	assert.deepEqual(fake.calls, ['paid:a1:REF-9', 'received:b1'])
})

test('sin sesión no hay operaciones y los POST ajenos se rechazan', async () => {
	const { post, get } = await setup()
	assert.equal((await get('/trades', {})).status, 401)
	assert.equal((await post('/trade/action', { offer: 'b1', action: 'release' }, { 'Content-Type': 'application/json', Cookie: 'sid=sid1' })).status, 403)
	assert.equal(
		(await post('/trade/action', { offer: 'b1', action: 'release' }, { ...HEADERS, Origin: 'https://evil.example' })).status,
		403,
	)
})

test('conectar: límite de intentos por IP', async () => {
	const { post } = await setup()
	const h = { ...HEADERS, 'cf-connecting-ip': '203.0.113.9' }
	for (let i = 0; i < 10; i++) assert.equal((await post('/connect', { token: 'x' }, h)).status, 400)
	assert.equal((await post('/connect', { token: 'x' }, h)).status, 429)
})
