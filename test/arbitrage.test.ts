import assert from 'node:assert/strict'
import { test } from 'node:test'
import { bestCross, pairCross } from '../src/terminal/arbitrage.ts'
import type { Level } from '../src/terminal/market.ts'

const lvl = (o: Partial<Level>): Level => ({
	uuid: o.user ?? 'x',
	price: 1000,
	usd: 50,
	kind: 'fixed',
	orderMin: null,
	orderMax: null,
	user: 'x',
	ops: 500,
	rating: 4.9,
	kyc: true,
	vip: false,
	gold: false,
	vipOnly: false,
	requirements: null,
	requirementsMet: null,
	createdAt: null,
	updatedAt: null,
	promoted: false,
	outlier: false,
	...o,
})

test('libro cruzado: con una venta de rango, compras lo justo para vender toda la compra fija tras la comisión', () => {
	const ask = lvl({ user: 'cally', price: 1056.9, usd: 200, kind: 'flexible', orderMin: 5, orderMax: 200 })
	const bid = lvl({ user: 'chamr', price: 1078.01, usd: 50 })
	const c = pairCross(ask, bid, 0.0025)!
	assert.equal(c.sellUsd, 50)
	assert.equal(c.buyUsd, 50.13) // 50 / 0,9975
	assert.equal(c.leftUsd, 0)
	assert.ok(Math.abs(c.profit - (50 * 1078.01 - 50.13 * 1056.9)) < 1e-6)
	assert.ok(c.pct > 0.017 && c.pct < 0.018)
})

test('libro cruzado: dos fijas que no encajan no cuentan; si la venta es mayor, lo que sobra se dice aparte', () => {
	// Compras 20 fijos y la compra pide 50 fijos: no te llegan
	assert.equal(pairCross(lvl({ price: 1000, usd: 20 }), lvl({ price: 1100, usd: 50 }), 0.0025), null)
	// Compras 100 fijos y vendes 50: te sobran 49,75
	const c = pairCross(lvl({ price: 1000, usd: 100 }), lvl({ price: 1100, usd: 50 }), 0.0025)!
	assert.deepEqual([c.buyUsd, c.sellUsd, c.leftUsd], [100, 50, 49.75])
	assert.ok(Math.abs(c.profit - 4750) < 1e-6) // 50 × 100 de diferencia menos la comisión (0,25 USD a 1000); lo que sobra queda a lo que costó
	// Sin margen tras la comisión, nada
	assert.equal(pairCross(lvl({ price: 1000 }), lvl({ price: 1001 }), 0.0025), null)
})

test('libro cruzado: solo ofertas que puedes tomar, con tu comisión (GOLD sin comisión)', () => {
	const cheapVip = lvl({ user: 'vip', price: 900, vipOnly: true })
	const cheapReq = lvl({ user: 'req', price: 950, requirementsMet: false })
	const odd = lvl({ user: 'raro', price: 500, outlier: true })
	const mine = lvl({ user: 'yo', price: 960 })
	const ok = lvl({ user: 'ana', price: 1000 })
	const bid = lvl({ user: 'leo', price: 1010, usd: 40 })
	const c = bestCross([odd, cheapVip, cheapReq, mine, ok], [bid], 0.0025, 'yo')!
	assert.equal(c.ask.user, 'ana')
	// 1 % de diferencia: con la comisión normal no da para nada más que esto; sin ella, más
	const gold = bestCross([ok], [bid], 0, 'yo')!
	assert.ok(gold.profit > c.profit)
	assert.equal(bestCross([odd, cheapVip, cheapReq], [bid], 0.0025), null)
})
