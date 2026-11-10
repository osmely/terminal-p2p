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

test('toTrades: la ficha entera de quien toma tu oferta, aunque no tenga ofertas publicadas', () => {
	const me = { uuid: 'me', username: 'yo' }
	const taker = { uuid: 't', username: 'Nuevo', kyc: true, vip: false, golden_check: false, phone_verified: true, telegram_verified: false, rating_avg: 4.9, rating_count: 7, _count: { P2P: 0, P2P_Peer: 12 } }
	const { trades } = toTrades(
		[
			offer({ uuid: 'a', type: 'sell', User: me, Peer: taker, status: 'processing' }),
			// Sin _count no llegó el perfil: no hay ficha (no se da por «sin verificar»)
			offer({ uuid: 'b', type: 'sell', User: me, Peer: { uuid: 'z', username: 'Corto' }, status: 'processing' }),
		],
		'me',
	)
	const p = trades.find((t) => t.id === 'a')?.counterparty?.profile
	assert.deepEqual(
		p && { ...p, score: null },
		{ username: 'Nuevo', uuid: 't', image: null, kyc: true, vip: false, gold: false, phone: true, telegram: false, opsOwner: 0, opsTaker: 12, rating: 4.9, ratings: 7, score: null },
	)
	assert.equal(trades.find((t) => t.id === 'b')?.counterparty?.profile, null)
	assert.equal(trades.find((t) => t.id === 'b')?.counterparty?.uuid, 'z')
})

test('paymentDetails acepta objeto o lista', () => {
	assert.deepEqual(paymentDetails({ 'Nro de tarjeta': '9200' }), [{ name: 'Nro de tarjeta', value: '9200' }])
	// Publicada sin algunos datos: QvaPay devuelve los campos vacíos y no se enseñan
	assert.deepEqual(paymentDetails({ 'Nro de tarjeta': '9200', 'Nro de celular': '', 'Nombre y Apellidos': ' ' }), [{ name: 'Nro de tarjeta', value: '9200' }])
	assert.deepEqual(paymentDetails([{ name: 'Celular', value: '+53' }, { name: 'x', value: '' }]), [{ name: 'Celular', value: '+53' }])
	assert.deepEqual(paymentDetails(null), [])
})

test('toTrades: las partes canceladas no salen «En curso»; para «Mi cuenta», las canceladas con contraparte sí cuentan', () => {
	const me = { uuid: 'me', username: 'yo' }
	const other = { uuid: 'x', username: 'otro' }
	const list = [
		offer({ uuid: 'd', type: 'sell', offer_kind: 'flexible', User: other, status: 'open', my_order: { uuid: 'ord', amount: '20', receive: '20200', status: 'cancelled' } }),
		offer({ uuid: 'e', type: 'sell', User: other, Peer: me, status: 'cancelled' }),
		// Mi oferta cancelada sin que nadie la tomara: no es una operación cancelada
		offer({ uuid: 'f', type: 'sell', User: me, Peer: null, status: 'cancelled' }),
	]
	assert.deepEqual(toTrades(list, 'me').trades, [])
	assert.deepEqual(toTrades(list, 'me', true).trades.map((t) => t.id), ['d:ord', 'e'])
})
