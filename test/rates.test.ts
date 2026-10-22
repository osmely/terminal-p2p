import assert from 'node:assert/strict'
import { test } from 'node:test'
import { bucketFor, rowsFrom, slot } from '../worker/rates.ts'
import { cacheable } from '../worker/relay.ts'
import type { Averages } from '../src/qvapay/types.ts'

test('histórico: solo las monedas de la web, con operaciones, en franjas de 10 min', () => {
	const avg = {
		BANK_CUP: { name: 'CUP', average: 1010, average_buy: 1008, average_sell: 1012, median: 1011, median_buy: 1009, median_sell: 1013, count: 420, window_hours: 24 },
		BTC: { name: 'Bitcoin', average: 0, average_buy: 0, average_sell: 0, count: 0 },
		ZELLE: { name: 'Zelle', average: 1.02, average_buy: 1.01, average_sell: 0, count: 30 },
		ETECSA: { name: 'ETECSA', average: 0, average_buy: 0, average_sell: 0, count: 0 },
	} as Averages
	const t = slot(Date.UTC(2026, 9, 22, 16, 37, 12))
	assert.equal(t, Date.UTC(2026, 9, 22, 16, 30))
	const rows = rowsFrom(avg, t)
	assert.deepEqual(rows.map((r) => r.coin), ['BANK_CUP', 'ZELLE'])
	assert.equal(rows[0].median_buy, 1009)
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
