import assert from 'node:assert/strict'
import { test } from 'node:test'
import { tradeStats } from '../src/broker/stats.ts'
import type { Trade } from '../src/broker/trades.ts'

const t = (o: Partial<Trade>): Trade => ({
	id: o.id ?? Math.random().toString(),
	offerUuid: 'o',
	order: null,
	coin: 'BANK_CUP',
	offerType: 'sell',
	role: 'taker',
	side: 'buy',
	payer: true,
	status: 'completed',
	usd: 10,
	coinAmount: 10_000,
	price: 1000,
	counterparty: { username: 'ana', ops: 10, rating: 5 },
	kind: 'fixed',
	updatedAt: '2026-10-20T10:00:00Z',
	expiresAt: null,
	actions: [],
	...o,
})

test('estadísticas: completadas y canceladas, volumen por mes y mercado, precio medio y con quién operas', () => {
	const s = tradeStats([
		t({ usd: 10, coinAmount: 10_000 }),
		t({ usd: 30, coinAmount: 31_500, role: 'owner', counterparty: { username: 'leo', ops: 5, rating: null } }), // a 1050
		t({ side: 'sell', usd: 20, coinAmount: 21_000, updatedAt: '2026-09-02T10:00:00Z' }),
		t({ coin: 'ZELLE', usd: 50, coinAmount: 51.5, counterparty: { username: 'leo', ops: 5, rating: null } }),
		t({ status: 'cancelled', usd: 99 }),
		t({ status: 'open', usd: 99 }),
	])
	assert.deepEqual([s.completed, s.cancelled, s.asOwner, s.asTaker], [4, 1, 1, 3])
	assert.deepEqual([s.usdBought, s.usdSold], [90, 20])
	assert.deepEqual(s.months, [
		{ month: '2026-10', usdBought: 90, usdSold: 0, ops: 3 },
		{ month: '2026-09', usdBought: 0, usdSold: 20, ops: 1 },
	])
	const cup = s.markets.find((m) => m.coin === 'BANK_CUP')!
	assert.deepEqual([cup.ops, cup.usdBought, cup.usdSold, cup.avgBuy, cup.avgSell], [3, 40, 20, 1037.5, 1050]) // 41.500 / 40
	assert.equal(s.markets[0].coin, 'BANK_CUP')
	// Empatan en operaciones: primero quien más USD movió
	assert.deepEqual(s.peers, [{ username: 'leo', ops: 2, usd: 80 }, { username: 'ana', ops: 2, usd: 30 }])
	assert.equal(s.since, '2026-09-02T10:00:00Z')
})
