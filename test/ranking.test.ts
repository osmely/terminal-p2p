import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Level } from '../src/terminal/market.ts'
import { positions, rank, reputationScore, userStats, type BookSide } from '../src/terminal/ranking.ts'

const NOW = Date.parse('2026-10-23T12:00:00Z')
let n = 0
const lvl = (user: string, price: number, usd: number, o: Partial<Level> = {}): Level => ({
	uuid: `u${++n}`,
	price,
	usd,
	kind: 'fixed',
	orderMin: null,
	orderMax: null,
	user,
	ops: 10,
	rating: 4.8,
	kyc: true,
	vip: false,
	gold: false,
	vipOnly: false,
	requirements: null,
	createdAt: NOW - 3 * 86_400_000,
	updatedAt: null,
	promoted: false,
	outlier: false,
	...o,
})

const sides: BookSide[] = [
	{
		tick: 'BANK_CUP',
		side: 'ask',
		levels: [lvl('ana', 1010, 100, { ops: 2000, rating: 4.9, updatedAt: NOW - 3600_000 }), lvl('luis', 1012, 500, { ops: 3, rating: 5 }), lvl('typo', 101, 9999, { outlier: true })],
	},
	{
		tick: 'BANK_CUP',
		side: 'bid',
		levels: [lvl('ana', 1000, 50, { ops: 2000, rating: 4.9 }), lvl('eva', 1000, 300, { ops: 40, rating: null, updatedAt: NOW - 600_000 })],
	},
	{ tick: 'ZELLE', side: 'ask', levels: [lvl('luis', 1.05, 200, { ops: 3, rating: 5, updatedAt: NOW - 7200_000 })] },
]

test('ranking: junta las ofertas de cada usuario y descarta los precios atípicos', () => {
	const stats = userStats(sides, NOW)
	const by = Object.fromEntries(stats.map((u) => [u.user, u]))
	assert.equal(by.typo, undefined)
	assert.deepEqual([by.ana.usdAsk, by.ana.usdBid, by.ana.offers, by.ana.markets], [100, 50, 2, ['BANK_CUP']])
	assert.deepEqual([by.luis.usdAsk, by.luis.markets], [700, ['BANK_CUP', 'ZELLE']])
	// Mejor precio: ana en la venta de CUP, ana y eva empatan en la compra, luis en Zelle
	assert.deepEqual([by.ana.best, by.eva.best, by.luis.best], [2, 1, 1])
	// Actividad en las últimas 24 h
	assert.deepEqual([by.ana.recent, by.eva.recent, by.luis.recent], [1, 1, 1])
})

test('ranking por cada criterio', () => {
	const stats = userStats(sides, NOW)
	const users = (c: Parameters<typeof rank>[1]) => rank(stats, c).rows.map((r) => r.stats.user)
	assert.deepEqual(users('liquidity'), ['luis', 'eva', 'ana'])
	assert.deepEqual(users('experience'), ['ana', 'eva', 'luis'])
	// Un 5,0 con 3 operaciones queda por debajo de un 4,9 con 2.000; sin valoración no entra
	assert.deepEqual(users('reputation'), ['ana', 'luis'])
	assert.deepEqual(users('best'), ['ana', 'luis', 'eva'])
	// Solo quien compra y vende a la vez
	assert.deepEqual(users('maker'), ['ana'])
	assert.deepEqual(users('active'), ['eva', 'ana', 'luis'])
	assert.deepEqual(rank(stats, 'liquidity', 2).rows.map((r) => r.rank), [1, 2])
})

test('valoración ajustada y puestos de cada usuario', () => {
	assert.ok(reputationScore(4.9, 2000)! > reputationScore(5, 3)!)
	assert.equal(reputationScore(null, 100), null)
	const pos = positions(userStats(sides, NOW))
	assert.deepEqual(pos.ana, { liquidity: 3, experience: 1, reputation: 1, best: 1, maker: 1, active: 2 })
	assert.equal(pos.eva.reputation, undefined)
})
