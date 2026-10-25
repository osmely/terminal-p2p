import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Engine, freshState, SimError, type Candle } from '../src/sim/engine.ts'

const T0 = Date.parse('2026-10-24T12:00:00Z')
const q = (p: number) => ({ bid: p - 0.5, ask: p + 0.5 })
const candle = (t: number, o: number, h: number, l: number, c: number): Candle => ({ t, o, h, l, c })

test('compra a mercado al ask, con comisión, y venta con ganancia realizada', () => {
	const e = new Engine(freshState(T0))
	const buy = e.placeOrder({ symbol: 'btc', side: 'BUY', type: 'MARKET', quoteAmount: 1001 }, q(100), T0)
	assert.equal(buy.status, 'FILLED')
	assert.equal(buy.avgPrice, 100.5)
	assert.equal(buy.qty, 9.95024)
	const acc = e.account({ BTCUSDT: 110 })
	assert.ok(Math.abs(acc.cash.free - (10_000 - 9.95024 * 100.5 * 1.001)) < 1e-6)
	const sell = e.placeOrder({ symbol: 'BTCUSDT', side: 'SELL', type: 'MARKET', quantity: 9.95024 }, q(110), T0 + 1000)
	assert.equal(sell.avgPrice, 109.5)
	assert.ok(e.state.trades[1].realizedPnl! > 85)
	assert.equal(e.account({}).positions.length, 0)
})

test('validaciones: saldo, mínimo, stops del lado correcto', () => {
	const e = new Engine(freshState(T0))
	assert.throws(() => e.placeOrder({ symbol: 'BTC', side: 'BUY', quoteAmount: 20_000 }, q(100)), SimError)
	assert.throws(() => e.placeOrder({ symbol: 'BTC', side: 'BUY', quoteAmount: 2 }, q(100)), /mínima/)
	assert.throws(() => e.placeOrder({ symbol: 'BTC', side: 'SELL', quantity: 1 }, q(100)), /No tienes/)
	assert.throws(() => e.placeOrder({ symbol: 'BTC', side: 'BUY', type: 'STOP', stopPrice: 90, quoteAmount: 100 }, q(100)), /por encima/)
	assert.throws(() => e.placeOrder({ symbol: 'NADA', side: 'BUY', quoteAmount: 100 }, q(100)), /no disponible/)
})

test('límite y stop con velas de 1 s: nunca con un precio anterior, y el hueco lo paga el stop', () => {
	const e = new Engine(freshState(T0))
	const limit = e.placeOrder({ symbol: 'ETH', side: 'BUY', type: 'LIMIT', price: 95, quoteAmount: 500 }, q(100), T0 + 500)
	assert.equal(limit.status, 'OPEN')
	assert.ok(e.state.balances.USDT.locked > 0)
	// Una vela que empezó antes de poner la orden no cuenta
	e.replay('ETHUSDT', [candle(T0, 100, 100, 90, 95)])
	assert.equal(limit.status, 'OPEN')
	e.replay('ETHUSDT', [candle(T0 + 1000, 99, 99, 96, 97), candle(T0 + 2000, 96, 96, 94, 95)])
	assert.equal(limit.status, 'FILLED')
	assert.equal(limit.avgPrice, 95)
	assert.equal(e.state.balances.USDT.locked, 0)
	// Stop de venta: la vela abre por debajo del stop (hueco) y se ejecuta a la apertura
	const stop = e.placeOrder({ symbol: 'ETH', side: 'SELL', type: 'STOP', stopPrice: 90, quantity: limit.qty }, q(96), T0 + 3000)
	e.replay('ETHUSDT', [candle(T0 + 4000, 88, 89, 87, 88)])
	assert.equal(stop.status, 'FILLED')
	assert.equal(stop.avgPrice, 88)
	assert.equal(stop.trigger, 'stop')
})

test('compra con stop loss y take profit: crea la OCO y, si se tocan los dos, gana el stop', () => {
	const e = new Engine(freshState(T0))
	const buy = e.placeOrder({ symbol: 'SOL', side: 'BUY', quoteAmount: 1000, stopLoss: 90, takeProfit: 120 }, q(100), T0)
	const oco = e.openOrders()[0]
	assert.deepEqual([oco.type, oco.side, oco.price, oco.stopPrice, oco.qty], ['OCO', 'SELL', 120, 90, buy.qty])
	e.replay('SOLUSDT', [candle(T0 + 1000, 100, 121, 89, 100)])
	assert.equal(oco.status, 'FILLED')
	assert.deepEqual([oco.avgPrice, oco.trigger], [90, 'stop'])
	// Otra entrada: ahora solo toca el objetivo
	e.placeOrder({ symbol: 'SOL', side: 'BUY', quoteAmount: 1000, stopLoss: 90, takeProfit: 120 }, q(100), T0 + 2000)
	const oco2 = e.openOrders()[0]
	e.replay('SOLUSDT', [candle(T0 + 3000, 105, 125, 104, 122)])
	assert.deepEqual([oco2.status, oco2.avgPrice, oco2.trigger], ['FILLED', 120, 'objetivo'])
})

test('cortos: se gana si baja y se cancela devolviendo la garantía', () => {
	const e = new Engine(freshState(T0))
	const short = e.placeOrder({ symbol: 'DOGE', side: 'SHORT', quoteAmount: 1000 }, { bid: 0.2, ask: 0.2001 }, T0)
	assert.equal(short.status, 'FILLED')
	const acc = e.account({ DOGEUSDT: 0.18 })
	assert.ok(acc.pnl > 90 && acc.pnl < 100)
	const cover = e.placeOrder({ symbol: 'DOGE', side: 'COVER', type: 'LIMIT', price: 0.15, quantity: short.qty }, { bid: 0.18, ask: 0.1801 }, T0 + 1000)
	e.cancelOrder(cover.id)
	assert.equal(e.state.shorts.DOGE.free, short.qty)
	assert.throws(() => e.cancelOrder(cover.id), /ya no está abierta/)
})

test('editar una orden abierta: nuevo precio con la misma cantidad, y si no vale, todo queda igual', () => {
	const e = new Engine(freshState(T0))
	const o = e.placeOrder({ symbol: 'ETH', side: 'BUY', type: 'LIMIT', price: 90, quoteAmount: 900 }, q(100), T0)
	const locked = e.state.balances.USDT.locked
	const moved = e.modifyOrder(o.id, { price: 80 }, q(100), T0 + 1000)
	assert.deepEqual([moved.price, moved.qty, moved.status, o.status], [80, o.qty, 'OPEN', 'CANCELED'])
	assert.ok(e.state.balances.USDT.locked < locked) // a 80 se reserva menos
	// Un stop de venta por encima del precio no vale: la orden sigue como estaba
	e.placeOrder({ symbol: 'SOL', side: 'BUY', quoteAmount: 500 }, q(100), T0)
	const stop = e.placeOrder({ symbol: 'SOL', side: 'SELL', type: 'STOP', stopPrice: 90, quantity: 4 }, q(100), T0)
	assert.throws(() => e.modifyOrder(stop.id, { stopPrice: 110 }, q(100)), /por debajo/)
	assert.deepEqual([e.openOrders().find((x) => x.id === stop.id)?.stopPrice, e.state.balances.SOL.locked], [90, 4])
})

test('cancelar todas, o solo las de un mercado', () => {
	const e = new Engine(freshState(T0))
	e.placeOrder({ symbol: 'ETH', side: 'BUY', type: 'LIMIT', price: 90, quoteAmount: 300 }, q(100), T0)
	e.placeOrder({ symbol: 'ETH', side: 'BUY', type: 'LIMIT', price: 80, quoteAmount: 300 }, q(100), T0)
	e.placeOrder({ symbol: 'BTC', side: 'BUY', type: 'LIMIT', price: 90, quoteAmount: 300 }, q(100), T0)
	assert.equal(e.cancelAll('ETHUSDT'), 2)
	assert.deepEqual(e.openOrders().map((o) => o.symbol), ['BTCUSDT'])
	assert.equal(e.cancelAll(), 1)
	assert.equal(e.state.balances.USDT.locked, 0)
})

test('cerrar una posición: cancela sus salidas automáticas y vende todo de una vez', () => {
	const e = new Engine(freshState(T0))
	const buy = e.placeOrder({ symbol: 'SOL', side: 'BUY', quoteAmount: 1000, stopLoss: 90, takeProfit: 120 }, q(100), T0)
	e.placeOrder({ symbol: 'ETH', side: 'BUY', type: 'LIMIT', price: 50, quoteAmount: 200 }, q(100), T0)
	assert.equal(e.openOrders().length, 2) // la OCO de SOL y el límite de ETH
	const sell = e.closePosition('SOLUSDT', q(110), T0 + 1000)
	assert.deepEqual([sell.status, sell.qty, sell.avgPrice], ['FILLED', buy.qty, 109.5])
	assert.equal(e.state.balances.SOL.free + e.state.balances.SOL.locked, 0)
	// Solo queda la orden de otro mercado
	assert.deepEqual(e.openOrders().map((o) => o.symbol), ['ETHUSDT'])
	// Sin posición no hace nada y no cambia la cuenta
	assert.throws(() => e.closePosition('SOLUSDT', q(110)), /No tienes SOL/)
	assert.equal(e.openOrders().length, 1)
})

test('comprar a mercado con todo el saldo en USDT cabe; una compra stop reserva un 0,2% más', () => {
	const e = new Engine(freshState(T0))
	const o = e.placeOrder({ symbol: 'SOL', side: 'BUY', type: 'MARKET', quoteAmount: 10_000 }, q(100), T0)
	assert.equal(o.status, 'FILLED')
	const e2 = new Engine(freshState(T0))
	const s = e2.placeOrder({ symbol: 'SOL', side: 'BUY', type: 'STOP', stopPrice: 110, quoteAmount: 10_000 }, q(100), T0)
	assert.ok(s.locked <= 10_000 && s.locked > 9_990)
})

test('la salida automática no se pierde aunque un hueco ya pasara el stop, ni en compras pequeñas', () => {
	const e = new Engine(freshState(T0))
	// Límite a 100 con stop a 98; la vela abre en 95 (la compra sale a 95, ya por debajo del stop)
	e.placeOrder({ symbol: 'SOL', side: 'BUY', type: 'LIMIT', price: 100, quoteAmount: 1000, stopLoss: 98, takeProfit: 110 }, q(102), T0)
	e.replay('SOLUSDT', [{ t: T0 + 60_000, o: 95, h: 96, l: 94, c: 95 }])
	assert.deepEqual(e.openOrders().map((o) => o.type), ['OCO'])
	// Con la vela siguiente salta el stop, al precio de apertura
	e.replay('SOLUSDT', [{ t: T0 + 120_000, o: 95, h: 96, l: 94, c: 95 }])
	assert.equal(e.openOrders().length, 0)
	assert.equal(e.state.trades.at(-1)!.trigger, 'stop')
	// 5,1 USDT con stop al −5%: la salida vale menos del mínimo, pero se pone igual
	const e2 = new Engine(freshState(T0))
	e2.placeOrder({ symbol: 'SOL', side: 'BUY', type: 'MARKET', quoteAmount: 5.2, stopLoss: 95 }, q(100), T0)
	assert.deepEqual(e2.openOrders().map((o) => o.type), ['STOP'])
})
