import assert from 'node:assert/strict'
import { test } from 'node:test'
import { bucketFor, cubaOffset, dailyFrom, rowsFrom, slot, summer, volumeBars } from '../worker/rates.ts'
import { cacheable } from '../worker/relay.ts'
import type { Averages } from '../src/qvapay/types.ts'

test('histórico: solo las monedas de la web, con operaciones, en franjas de 10 min', () => {
	const avg = {
		BANK_CUP: { name: 'CUP', average: 1010, average_buy: 1008, average_sell: 1012, median: 1011, median_buy: 1009, median_sell: 1013, count: 420, count_buy: 250, count_sell: 170, window_hours: 24 },
		BTC: { name: 'Bitcoin', average: 0, average_buy: 0, average_sell: 0, count: 0 },
		ZELLE: { name: 'Zelle', average: 1.02, average_buy: 1.01, average_sell: 0, count: 30 },
		ETECSA: { name: 'ETECSA', average: 0, average_buy: 0, average_sell: 0, count: 0 },
	} as Averages
	const t = slot(Date.UTC(2026, 9, 22, 16, 37, 12))
	assert.equal(t, Date.UTC(2026, 9, 22, 16, 30))
	const rows = rowsFrom(avg, t)
	assert.deepEqual(rows.map((r) => r.coin), ['BANK_CUP', 'ZELLE'])
	assert.equal(rows[0].median_buy, 1009)
	assert.deepEqual([rows[0].count_buy, rows[0].count_sell, rows[1].count_buy], [250, 170, null])
	// Los ceros de QvaPay ("sin datos") se guardan como vacío, no como precio 0
	assert.equal(rows[1].avg_sell, null)
	assert.equal(rows[1].median, null)
})

test('agregación según el rango', () => {
	assert.equal(bucketFor(7), 600_000)
	assert.equal(bucketFor(30), 3_600_000)
	assert.equal(bucketFor(365), 86_400_000)
})

test('solo se cachea lo público y sin token', () => {
	const get = (h: Record<string, string> = {}) => new Request('https://x/qp', { headers: h })
	assert.equal(cacheable(get(), '/p2p/averages'), true)
	assert.equal(cacheable(get(), '/p2p/completed_pairs_average'), true)
	assert.equal(cacheable(get({ Authorization: 'Bearer t' }), '/p2p/averages'), false)
	assert.equal(cacheable(get(), '/p2p'), false)
	assert.equal(cacheable(get({ Authorization: 'Bearer t' }), '/user'), false)
	assert.equal(cacheable(new Request('https://x/qp', { method: 'POST' }), '/p2p/averages'), false)
})

test('operaciones por día: un valor por día de Cuba, repartiendo las ventanas de 7 días', () => {
	const at = (iso: string) => Date.parse(iso)
	const days = dailyFrom(
		[
			// 23:50 del 20 en Cuba, en horario de verano (03:50 UTC del 21)
			{ t: at('2026-10-21T03:50:00Z'), count: 400, count_buy: 240, count_sell: 160, window_h: 24 },
			// Moneda de poco movimiento: 70 en 7 días son 10 al día
			{ t: at('2026-10-22T03:50:00Z'), count: 70, count_buy: null, count_sell: null, window_h: 168 },
			// Hoy, aún en curso
			{ t: at('2026-10-22T18:00:00Z'), count: 380, count_buy: 200, count_sell: 180, window_h: 24 },
		],
		at('2026-10-22T18:05:00Z'),
	)
	assert.deepEqual(
		days.map((d) => [d.day, d.ops, d.buy, d.sell, d.partial]),
		[
			['2026-10-20', 400, 240, 160, false],
			['2026-10-21', 10, null, null, false],
			['2026-10-22', 380, 200, 180, true],
		],
	)
	// La barra va al mediodía de ese día en Cuba (16:00 UTC en verano)
	assert.equal(new Date(days[0].t).toISOString(), '2026-10-20T16:00:00.000Z')
})

test('horario de Cuba: UTC-4 del segundo domingo de marzo al primer domingo de noviembre', () => {
	const at = (iso: string) => Date.parse(iso)
	assert.deepEqual(summer(2026).map((t) => new Date(t).toISOString()), ['2026-03-08T05:00:00.000Z', '2026-11-01T05:00:00.000Z'])
	assert.deepEqual(summer(2027).map((t) => new Date(t).toISOString()), ['2027-03-14T05:00:00.000Z', '2027-11-07T05:00:00.000Z'])
	const h = (iso: string) => cubaOffset(at(iso)) / 3600_000
	assert.deepEqual([h('2026-03-08T04:59:59Z'), h('2026-03-08T05:00:00Z'), h('2026-10-31T23:00:00Z'), h('2026-11-01T05:00:00Z'), h('2026-12-15T12:00:00Z')], [-5, -4, -4, -5, -5])
	// En invierno el día de Cuba empieza a las 05:00 UTC y la barra va a las 17:00 UTC
	const [d] = dailyFrom([{ t: at('2026-12-16T04:50:00Z'), count: 24, count_buy: null, count_sell: null, window_h: 24 }], at('2026-12-20T12:00:00Z'))
	assert.deepEqual([d.day, new Date(d.t).toISOString()], ['2026-12-15', '2026-12-15T17:00:00.000Z'])
})

test('volumen: por hora tal cual y cada 6 h desde las 0, 6, 12 y 18 de Cuba; nunca negativo', () => {
	const H = 3_600_000
	// 27 oct 2026: Cuba en verano (UTC-4). Las 10:00 UTC son las 6:00 de Cuba
	const h = (iso: string) => Date.parse(iso)
	const rows = [
		{ hour: h('2026-10-27T09:00:00Z'), side: 'sell', ops: 2, usd: 40 },
		{ hour: h('2026-10-27T10:00:00Z'), side: 'buy', ops: 1, usd: 15.5 },
		{ hour: h('2026-10-27T10:00:00Z'), side: 'sell', ops: 3, usd: 60 },
		{ hour: h('2026-10-27T11:00:00Z'), side: 'buy', ops: -1, usd: -10 },
	]
	assert.deepEqual(volumeBars(rows, H), [
		{ t: h('2026-10-27T09:00:00Z'), ops: 2, usd: 40, buy: 0, sell: 2, buyUsd: 0, sellUsd: 40 },
		{ t: h('2026-10-27T10:00:00Z'), ops: 4, usd: 75.5, buy: 1, sell: 3, buyUsd: 15.5, sellUsd: 60 },
		{ t: h('2026-10-27T11:00:00Z'), ops: 0, usd: 0, buy: 0, sell: 0, buyUsd: 0, sellUsd: 0 },
	])
	// Cada 6 h: las 5:00 de Cuba van con la barra de las 0:00, las 6:00 y 7:00 con la de las 6:00
	assert.deepEqual(volumeBars(rows, 6 * H), [
		{ t: h('2026-10-27T04:00:00Z'), ops: 2, usd: 40, buy: 0, sell: 2, buyUsd: 0, sellUsd: 40 },
		{ t: h('2026-10-27T10:00:00Z'), ops: 3, usd: 65.5, buy: 0, sell: 3, buyUsd: 5.5, sellUsd: 60 },
	])
})
