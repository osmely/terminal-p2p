import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { QvaPayClient } from '../src/qvapay/client.ts'
import type { ListParams } from '../src/qvapay/types.ts'
import { Market, type WatchedSide } from '../src/terminal/market.ts'

// El libro leído con una cuenta simulada: se apunta qué lado se pidió en cada paso
function setup() {
	const reads: string[] = []
	const client = {
		listOffers: async (p: ListParams) => {
			reads.push(`${p.coin}:${p.type === 'sell' ? 'ask' : 'bid'}`)
			return { current_page: 1, per_page: 50, total: 1, data: [{ uuid: `o-${p.coin}-${p.type}`, type: p.type, coin: p.coin, amount: '10', receive: p.type === 'sell' ? '4800' : '4700', status: 'open', User: { username: 'ana', rating_avg: 4.9, rating_count: 20, _count: { P2P: 30, P2P_Peer: 0 } } }] }
		},
	}
	const publicClient = { averages: async () => ({}), completedRates: async () => null }
	const market = new Market({
		publicClient: publicClient as unknown as QvaPayClient,
		readers: { get: async () => ({ sid: 's', client: client as unknown as QvaPayClient }), invalid: () => {} },
		historyStore: { load: async () => [], append: async () => {} },
	})
	return { market, reads }
}

test('radar: sus lados se leen antes que el mercado que se mira, y cada lectura le llega', async (t) => {
	t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-27T12:00:00Z') })
	const { market, reads } = setup()
	const got: WatchedSide[] = []
	market.touch('ETECSA')
	market.watch([{ tick: 'BANK_CUP', side: 'ask' }], (w) => got.push(w))
	assert.equal(market.watching(), true)
	await market.tick()
	assert.equal(reads[0], 'BANK_CUP:ask')
	assert.equal(got.length, 1)
	assert.deepEqual([got[0].tick, got[0].side, got[0].levels[0].price], ['BANK_CUP', 'ask', 480])
	// Recién leído: el siguiente paso es para el mercado que se mira (sus dos lados, la primera vez)
	t.mock.timers.tick(4000)
	await market.tick()
	assert.deepEqual(reads.slice(1), ['ETECSA:ask', 'ETECSA:bid'])
	// Pasados unos segundos, otra vez el del radar
	t.mock.timers.tick(5000)
	await market.tick()
	assert.equal(reads.at(-1), 'BANK_CUP:ask')
	assert.equal(got.length, 2)
})

test('radar: con nada más que mirar, los demás mercados siguen a su ritmo (uno por minuto), no a cada paso', async (t) => {
	t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-27T12:00:00Z') })
	const { market, reads } = setup()
	market.watch([{ tick: 'BANK_CUP', side: 'bid' }], () => {})
	for (let i = 0; i < 8; i++) {
		await market.tick()
		t.mock.timers.tick(4000)
	}
	const others = reads.filter((r) => r !== 'BANK_CUP:bid')
	assert.equal(others.length, 1, reads.join(', '))
	assert.equal(market.nextDelayMs(), 4000)
	// Apagado: vuelve el ritmo lento y no avisa a nadie
	market.watch([], () => assert.fail('no debería avisar'))
	assert.equal(market.watching(), false)
	assert.equal(market.nextDelayMs(), 60_000)
})

test('radar: como mucho 3 lados, sin repetir ni mercados que no existen', () => {
	const { market } = setup()
	market.watch(
		[
			{ tick: 'BANK_CUP', side: 'ask' },
			{ tick: 'BANK_CUP', side: 'ask' },
			{ tick: 'NADA' as 'BANK_CUP', side: 'ask' },
			{ tick: 'ETECSA', side: 'bid' },
			{ tick: 'ZELLE', side: 'ask' },
			{ tick: 'CLASICA', side: 'bid' },
		],
		() => {},
	)
	assert.deepEqual((market as unknown as { watched: unknown[] }).watched, [
		{ tick: 'BANK_CUP', side: 'ask' },
		{ tick: 'ETECSA', side: 'bid' },
		{ tick: 'ZELLE', side: 'ask' },
	])
})

test('tiempo real (Pro): lo empujado por el servidor no se lee con el token y le llega al radar al momento', async (t) => {
	t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-27T12:00:00Z') })
	const { market, reads } = setup()
	const got: WatchedSide[] = []
	market.watch([{ tick: 'BANK_CUP', side: 'ask' }], (w) => got.push(w))
	assert.deepEqual(market.wanted(), ['BANK_CUP'])
	market.setLiveCoins(['BANK_CUP'])
	const level = { uuid: 'x', price: 1040, usd: 20, kind: 'fixed', orderMin: null, orderMax: null, user: 'ana', ops: 40, rating: 4.9, kyc: true, vip: false, gold: false, vipOnly: false, requirements: null, requirementsMet: null, createdAt: Date.now(), updatedAt: Date.now(), promoted: false, outlier: false } as const
	market.setLive('BANK_CUP', 'ask', [level], 1)
	assert.equal(got.length, 1)
	assert.equal(got[0].levels[0].uuid, 'x')
	assert.equal(market.snapshot('BANK_CUP').realtime, true)
	// El radar ya no gasta lecturas de tu cuenta en ese mercado
	for (let i = 0; i < 3; i++) {
		await market.tick()
		t.mock.timers.tick(4000)
	}
	assert.ok(!reads.includes('BANK_CUP:ask'), reads.join(', '))
	// Se corta la conexión: vuelve a leerse con el token
	market.setLiveCoins([])
	t.mock.timers.tick(9000)
	await market.tick()
	assert.equal(reads.at(-1), 'BANK_CUP:ask')
	assert.equal(market.snapshot('BANK_CUP').realtime, false)
})
