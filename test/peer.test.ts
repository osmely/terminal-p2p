import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Broker, type AccountStore } from '../src/broker/routes.ts'
import type { QvaPayClient } from '../src/qvapay/client.ts'
import type { ListParams, P2POffer } from '../src/qvapay/types.ts'

const lock = { uuid: 'u1', username: 'LockBefore', image: 'profiles/u1/avatar-1.webp', kyc: true, vip: true, golden_check: true, phone_verified: true, telegram_verified: true, rating_avg: 4.91, rating_count: 524, _count: { P2P: 245, P2P_Peer: 1476 } }

async function setup(data: P2POffer[]) {
	const lists: ListParams[] = []
	const client = {
		me: async () => ({ uuid: 'me', username: 'yo', balance: 10, kyc: true, golden_check: false, p2p_enabled: true }),
		listOffers: async (p: ListParams) => (lists.push(p), { current_page: 1, per_page: 100, total: data.length, data }),
	} as unknown as QvaPayClient
	const acc = { sid: 's', me: await client.me(), client }
	const broker = new Broker({ accounts: { get: async () => acc } as unknown as AccountStore, market: { wake() {} }, dryRun: false })
	const get = async (path: string) => {
		const res = (await broker.handle(new Request(`https://app.terminalp2p.com/api/broker${path}`)))!
		return { status: res.status, body: await res.json() }
	}
	return { get, lists }
}

test('ficha de un usuario: perfil y ofertas abiertas en todos los mercados', async () => {
	const { get, lists } = await setup([
		{ uuid: 'o1', type: 'buy', coin: 'BANK_CUP', amount: '4000', receive: '4064000', available_amount: '3919', order_min: '20', order_max: '4000', offer_kind: 'flexible', status: 'open', User: lock, updated_at: '2026-10-24T10:00:00Z' },
		{ uuid: 'o2', type: 'sell', coin: 'BANK_CUP', amount: '100', receive: '103000', status: 'open', User: lock },
		// Lo que no es suyo o no está abierto no entra
		{ uuid: 'o3', type: 'sell', coin: 'ZELLE', amount: '50', receive: '52', status: 'open', User: { uuid: 'x', username: 'otro' } },
	])
	const { status, body } = await get('/peer?user=@LockBefore')
	assert.equal(status, 200)
	assert.deepEqual(lists[0], { peer: 'LockBefore', take: 100 })
	assert.deepEqual(
		{ ...body.profile, score: Math.round(body.profile.score * 1000) / 1000 },
		{ username: 'LockBefore', image: 'profiles/u1/avatar-1.webp', kyc: true, vip: true, gold: true, phone: true, telegram: true, opsOwner: 245, opsTaker: 1476, rating: 4.91, ratings: 524, score: 4.903 },
	)
	assert.deepEqual(
		body.offers.map((o: { offer: string; type: string; price: number; usd: number; orderMax: number | null }) => [o.offer, o.type, o.price, o.usd, o.orderMax]),
		[
			['o1', 'buy', 1016, 3919, 3919],
			['o2', 'sell', 1030, 100, null],
		],
	)
})

test('ficha: sin ofertas abiertas no hay perfil, y el usuario se valida', async () => {
	const { get, lists } = await setup([])
	const { body } = await get('/peer?user=nadie')
	assert.deepEqual([body.profile, body.offers], [null, []])
	assert.equal((await get('/peer?user=a%20b')).status, 400)
	assert.equal((await get('/peer?user=')).status, 400)
	assert.equal(lists.length, 1)
})
