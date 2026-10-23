import assert from 'node:assert/strict'
import { test } from 'node:test'
import { offerTerms, offerView, ratingsOf } from '../src/broker/routes.ts'
import { orderTrades } from '../src/broker/trades.ts'
import type { P2POffer } from '../src/qvapay/types.ts'

test('offerTerms: monto, precio y total con los límites de QvaPay', () => {
	assert.deepEqual(offerTerms({ amount: 50, price: 1012.5 }, false), {
		amount: 50,
		receive: 50_625,
		price: 1012.5,
		kind: 'fixed',
		orderMin: undefined,
		orderMax: undefined,
		requirements: undefined,
	})
	assert.ok('error' in offerTerms({ amount: 0.05, price: 1000 }, false))
	assert.ok('error' in offerTerms({ amount: 20_000, price: 1000 }, false))
	assert.ok('error' in offerTerms({ amount: 10, price: 0 }, false))
})

test('offerTerms: rango por orden y requisitos válidos', () => {
	const ok = offerTerms({ amount: 100, price: 1000, orderMin: 10, orderMax: 50, requirements: { min_completed: 25, min_rating: 0 } }, true)
	assert.ok(!('error' in ok))
	assert.deepEqual([ok.kind, ok.orderMin, ok.orderMax, ok.requirements], ['flexible', 10, 50, { min_completed: 25 }])
	// Máximo por encima del monto, o mínimo mayor que el máximo
	assert.ok('error' in offerTerms({ amount: 100, price: 1000, orderMin: 10, orderMax: 150 }, true))
	assert.ok('error' in offerTerms({ amount: 100, price: 1000, orderMin: 60, orderMax: 50 }, true))
	// Valores que QvaPay no acepta
	assert.ok('error' in offerTerms({ amount: 10, price: 1000, requirements: { min_completed: 7 } }, false))
})

const me = { uuid: 'me', username: 'yo' }
const taker = { uuid: 't', username: 'cliente', _count: { P2P: 3 } }
const flexOffer = {
	uuid: 'f',
	type: 'sell',
	coin: 'BANK_CUP',
	amount: '100',
	receive: '101000',
	status: 'open',
	offer_kind: 'flexible',
	available_amount: '60',
	reserved_amount: '20',
	order_min: '5',
	order_max: '40',
	User: me,
	details: { 'Nro de tarjeta': '9200' },
	Orders: [
		{ uuid: 'o1', amount: '20', receive: '20200', status: 'processing', Taker: taker, payment_window_expires_at: '2026-10-22T12:30:00Z' },
		{ uuid: 'o2', amount: '20', receive: '20200', status: 'cancelled', Taker: taker },
	],
} as unknown as P2POffer

test('orderTrades: las órdenes tomadas de tu oferta por rango', () => {
	const ts = orderTrades(flexOffer, 'me')
	assert.equal(ts.length, 1) // la cancelada no cuenta
	const [t] = ts
	assert.deepEqual([t.id, t.order, t.role, t.side, t.payer, t.usd, t.price], ['f:o1', 'o1', 'owner', 'sell', false, 20, 1010])
	assert.deepEqual(t.actions, ['wait_payment', 'dispute'])
	assert.equal(t.counterparty?.username, 'cliente')
	assert.equal(t.expiresAt, '2026-10-22T12:30:00Z')
	// De una oferta ajena no se sacan órdenes
	assert.deepEqual(orderTrades(flexOffer, 'otro'), [])
})

test('offerView: los datos de pago y las órdenes solo para el dueño', () => {
	const mine = offerView(flexOffer, 'me')
	assert.equal(mine.isOwner, true)
	assert.deepEqual(mine.details, [{ name: 'Nro de tarjeta', value: '9200' }])
	assert.equal(mine.orders.length, 2)
	assert.deepEqual([mine.kind, mine.available, mine.orderMin, mine.orderMax, mine.price], ['flexible', 60, 5, 40, 1010])
	const other = offerView(flexOffer, 'otro')
	assert.deepEqual([other.isOwner, other.details, other.orders], [false, [], []])
})

test('offerTerms al editar: el máximo por orden puede superar lo que queda', () => {
	// Quedan 20 USD de una oferta por partes con máximo 50: cambiar el precio debe poder hacerse
	const edit = offerTerms({ amount: 20, price: 1015, orderMin: 10, orderMax: 50 }, true, true)
	assert.ok(!('error' in edit))
	assert.ok('error' in offerTerms({ amount: 20, price: 1015, orderMin: 60, orderMax: 50 }, true, true))
	// Al crear sí: el máximo no puede superar el monto
	assert.ok('error' in offerTerms({ amount: 20, price: 1015, orderMin: 10, orderMax: 50 }, true))
})

test('ratingsOf: la calificación que diste y la que te dieron (ids numéricos de QvaPay)', () => {
	const o = {
		currentUserId: '202274',
		Ratings: [
			{ rater: '30227', rated: '202274', rating: '4', editable_until: '2026-10-26T00:51:10Z' },
			{ rater: '202274', rated: '30227', rating: '5', editable_until: '2026-10-26T00:50:44Z' },
		],
	} as unknown as P2POffer
	assert.deepEqual(ratingsOf(o), { mine: { rating: 5, editableUntil: '2026-10-26T00:50:44Z' }, theirs: { rating: 4, editableUntil: '2026-10-26T00:51:10Z' } })
	assert.deepEqual(ratingsOf({ Ratings: [] } as unknown as P2POffer), { mine: null, theirs: null })
})
