import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Level } from '../src/terminal/market.ts'
import { intentOf } from '../src/terminal/stats.ts'
import type { CompletedRates } from '../src/qvapay/types.ts'

const lv = (price: number, usd: number, extra: Partial<Level> = {}) => ({ uuid: `${price}`, price, usd, kind: 'fixed', orderMin: null, orderMax: null, user: 'x', ops: 10, rating: 5, kyc: true, vip: false, gold: false, vipOnly: false, requirements: null, requirementsMet: null, createdAt: 0, updatedAt: 0, promoted: false, outlier: false, ...extra }) as Level
const done = (median: number): CompletedRates => ({ average: median, average_buy: median, average_sell: median, median_buy: median, median_sell: median, count: 50, window_hours: 48, offers: [median - 5, median, median + 5] })

test('intención en el servidor: profundidad a ±2 % del medio (70 %) y precio frente a lo completado (30 %)', () => {
	// Medio 1000; a ±2 %: 300 USD de compra frente a 100 de venta → 75 % compra. El medio igual a la mediana: deriva 0
	const r = intentOf([lv(1010, 100), lv(1100, 900)], [lv(990, 300), lv(900, 500)], done(1000))!
	assert.deepEqual([r.mid, r.bidUsd, r.askUsd, r.drift], [1000, 300, 100, 0])
	assert.equal(r.score, Math.round((0.7 * 0.75 + 0.3 * 0.5) * 100))
	// El medio un 2 % por encima de lo completado llena su parte de la escala
	assert.equal(intentOf([lv(1030, 100)], [lv(1010, 300)], done(1000))!.score, Math.round((0.7 * 0.75 + 0.3) * 100))
})

test('intención en el servidor: no cuentan las solo-VIP ni las de precio atípico (como el libro con sus filtros de siempre)', () => {
	const base = intentOf([lv(1010, 100)], [lv(990, 300)], done(1000))!
	// Una venta solo-VIP y una venta regalada (un 20 % por debajo: cebo o error) no mueven nada
	const noisy = intentOf([lv(800, 5000), lv(1005, 9000, { vipOnly: true }), lv(1010, 100)], [lv(990, 300)], done(1000))!
	assert.deepEqual([noisy.score, noisy.mid], [base.score, base.mid])
	// Sin libro no hay intención
	assert.equal(intentOf([], [], done(1000)), null)
})
