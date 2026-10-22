import assert from 'node:assert/strict'
import { test } from 'node:test'
import { EXPIRING_MS, pendingCount, tradeAlerts } from '../src/broker/alerts.ts'
import { actionsFor, type Trade } from '../src/broker/trades.ts'

const NOW = Date.parse('2026-10-22T12:00:00Z')

const trade = (o: Partial<Trade>): Trade => {
	const t: Trade = {
		id: 'a',
		offerUuid: 'a',
		order: null,
		coin: 'BANK_CUP',
		offerType: 'sell',
		role: 'taker',
		side: 'buy',
		payer: true,
		status: 'processing',
		usd: 50,
		coinAmount: 50_500,
		price: 1010,
		counterparty: { username: 'otro', ops: 10, rating: 4.9 },
		kind: 'fixed',
		updatedAt: null,
		expiresAt: null,
		actions: [],
		...o,
	}
	t.actions = actionsFor(t.status, t.payer, t.role, true)
	return t
}
const read = (trades: Trade[], openOffers: Trade[] = []) => ({ trades, openOffers })
const kinds = (xs: { kind: string }[]) => xs.map((x) => x.kind)

test('primera lectura: sin avisos de cambios', () => {
	assert.deepEqual(tradeAlerts(null, [trade({ status: 'paid', payer: false, side: 'sell' })], NOW, new Set()), [])
})

test('te pagaron: avisa al que recibe, no al que paga', () => {
	const seller = (status: string) => trade({ status, payer: false, side: 'sell' })
	const a = tradeAlerts(read([seller('processing')]), [seller('paid')], NOW, new Set())
	assert.deepEqual(kinds(a), ['paid'])
	assert.equal(a[0].urgent, true)
	assert.match(a[0].body, /@otro marcó el pago de 50\.500 CUP/)
	// Quien pagó no recibe aviso de su propio pago
	assert.deepEqual(tradeAlerts(read([trade({})]), [trade({ status: 'paid' })], NOW, new Set()), [])
})

test('te liberaron y disputa', () => {
	assert.deepEqual(kinds(tradeAlerts(read([trade({ status: 'paid' })]), [trade({ status: 'completed' })], NOW, new Set())), ['released'])
	assert.deepEqual(kinds(tradeAlerts(read([trade({ status: 'paid' })]), [trade({ status: 'revision' })], NOW, new Set())), ['dispute'])
})

test('tomaron tu oferta publicada', () => {
	const mine = trade({ id: 'o', offerUuid: 'o', role: 'owner', side: 'sell', payer: false })
	const open = { ...mine, status: 'open' }
	const a = tradeAlerts(read([], [open]), [mine], NOW, new Set())
	assert.deepEqual(kinds(a), ['taken'])
	assert.match(a[0].body, /@otro te compra 50 USD\. Espera su pago de 50\.500 CUP\./)
	// Una operación que tomaste tú no es noticia
	assert.deepEqual(tradeAlerts(read([]), [trade({ id: 'x' })], NOW, new Set()), [])
})

test('mensaje nuevo de la contraparte, no los tuyos', () => {
	const withChat = (count: number, lastMine: boolean) => trade({ chat: { count, lastMine, lastText: 'Ya transferí' } })
	const a = tradeAlerts(read([withChat(2, true)]), [withChat(3, false)], NOW, new Set())
	assert.deepEqual(kinds(a), ['chat'])
	assert.equal(a[0].body, 'Ya transferí')
	assert.deepEqual(tradeAlerts(read([withChat(2, false)]), [withChat(3, true)], NOW, new Set()), [])
})

test('plazo de pago: avisa una vez y solo al que paga', () => {
	const soon = new Date(NOW + EXPIRING_MS - 60_000).toISOString()
	const t = trade({ expiresAt: soon })
	const a = tradeAlerts(null, [t], NOW, new Set())
	assert.deepEqual(kinds(a), ['expiring'])
	assert.equal(a[0].title, 'Quedan 4 min para pagar')
	assert.deepEqual(tradeAlerts(read([t]), [t], NOW, new Set([a[0].key])), [])
	// Lejos del plazo, vencido o si no te toca pagar: nada
	assert.deepEqual(tradeAlerts(null, [trade({ expiresAt: new Date(NOW + 30 * 60_000).toISOString() })], NOW, new Set()), [])
	assert.deepEqual(tradeAlerts(null, [trade({ expiresAt: new Date(NOW - 1000).toISOString() })], NOW, new Set()), [])
	assert.deepEqual(tradeAlerts(null, [trade({ payer: false, side: 'sell', expiresAt: soon })], NOW, new Set()), [])
})

test('pendingCount cuenta lo que espera una acción tuya', () => {
	assert.equal(pendingCount([trade({}), trade({ status: 'paid', payer: false, side: 'sell' }), trade({ status: 'paid' })]), 2)
})

test('mensaje nuevo aunque el número de mensajes no cambie (la API devuelve un máximo)', () => {
	const at = (lastId: string, lastMine: boolean) => trade({ chat: { count: 50, lastId, lastMine, lastText: 'Listo' } })
	assert.deepEqual(kinds(tradeAlerts(read([at('m1', true)]), [at('m2', false)], NOW, new Set())), ['chat'])
	assert.deepEqual(tradeAlerts(read([at('m1', false)]), [at('m1', false)], NOW, new Set()), [])
})

test('la contraparte deja tu oferta y vuelve al mercado', () => {
	const taken = trade({ id: 'o', offerUuid: 'o', role: 'owner', side: 'sell', payer: false })
	const reopened = { ...taken, status: 'open', counterparty: null, pause: { reason: 'taker_left' as const, until: null } }
	const a = tradeAlerts(read([taken]), [], NOW, new Set(), [reopened])
	assert.deepEqual(kinds(a), ['left'])
	assert.match(a[0].body, /@otro canceló.*pausa/)
})

test('una oferta fija tomada otra vez por otra persona vuelve a avisar', () => {
	const mine = (who: string) => trade({ id: 'o', offerUuid: 'o', role: 'owner', side: 'sell', payer: false, counterparty: { username: who, ops: 1, rating: null } })
	const open = { ...mine('x'), status: 'open', counterparty: null }
	const first = tradeAlerts(read([], [open]), [mine('ana')], NOW, new Set())
	const sent = new Set(first.map((x) => x.key))
	const again = tradeAlerts(read([], [open]), [mine('luis')], NOW, sent)
	assert.deepEqual([kinds(first), kinds(again)], [['taken'], ['taken']])
})
