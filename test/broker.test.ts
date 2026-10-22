import assert from 'node:assert/strict'
import { test } from 'node:test'
import { paymentDetails, toTrades } from '../src/broker/trades.ts'
import type { P2POffer } from '../src/qvapay/types.ts'

const offer = (o: Partial<P2POffer>): P2POffer => ({ uuid: 'o1', type: 'sell', coin: 'BANK_CUP', amount: '50', receive: '50500', status: 'processing', ...o }) as P2POffer

test('toTrades: roles, lado y acciones', () => {
	const me = { uuid: 'me', username: 'yo' }
	const other = { uuid: 'x', username: 'otro', _count: { P2P: 10, P2P_Peer: 5 }, rating_avg: 4.8, rating_count: 3 }
	const { trades, openOffers } = toTrades(
		[
			// Tomé una venta ajena: compro USD, me toca pagar
			offer({ uuid: 'a', type: 'sell', User: other, Peer: me, status: 'processing' }),
			// Tomé una compra ajena y ya me pagaron: vendo USD, me toca liberar
			offer({ uuid: 'b', type: 'buy', User: other, Peer: me, status: 'paid' }),
			// Mi oferta de venta abierta sin contraparte
			offer({ uuid: 'c', type: 'sell', User: me, Peer: null, status: 'open' }),
			// Parte tomada de una oferta por rango ajena
			offer({ uuid: 'd', type: 'sell', offer_kind: 'flexible', User: other, status: 'open', my_order: { uuid: 'ord', amount: '20', receive: '20200', status: 'processing' } }),
			// Cancelada: no se muestra
			offer({ uuid: 'e', type: 'sell', User: other, Peer: me, status: 'cancelled' }),
			// Oferta ajena que volvió a estar abierta (te fuiste): ya no es tuya
			offer({ uuid: 'g', type: 'sell', User: other, Peer: null, status: 'open' }),
		],
		'me',
	)
	const byId = Object.fromEntries(trades.map((t) => [t.id, t]))
	assert.deepEqual([byId.a.side, byId.a.payer, byId.a.actions], ['buy', true, ['pay', 'cancel']])
	assert.equal(byId.a.counterparty?.username, 'otro')
	assert.equal(byId.a.counterparty?.ops, 15)
	assert.deepEqual([byId.b.side, byId.b.payer, byId.b.actions], ['sell', false, ['release', 'dispute']])
	assert.deepEqual([byId['d:ord'].order, byId['d:ord'].usd, byId['d:ord'].actions], ['ord', 20, ['pay', 'cancel']])
	assert.equal(byId.e, undefined)
	assert.equal(byId.g, undefined)
	assert.deepEqual(
		openOffers.map((t) => [t.id, t.side, t.actions]),
		[['c', 'sell', ['cancel_offer']]],
	)
})

test('paymentDetails acepta objeto o lista', () => {
	assert.deepEqual(paymentDetails({ 'Nro de tarjeta': '9200' }), [{ name: 'Nro de tarjeta', value: '9200' }])
	assert.deepEqual(paymentDetails([{ name: 'Celular', value: '+53' }, { name: 'x', value: '' }]), [{ name: 'Celular', value: '+53' }])
	assert.deepEqual(paymentDetails(null), [])
})
