import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { addCandle, candlePrice, frameStart, joinCandles, loadCandles, markCandlesFrom, ownRefs } from '../worker/candles.ts'

function memD1() {
	const db = new DatabaseSync(':memory:')
	for (const f of readdirSync('migrations').sort()) db.exec(readFileSync(`migrations/${f}`, 'utf8'))
	const stmt = (sql: string, args: unknown[] = []) => ({
		bind: (...a: unknown[]) => stmt(sql, a),
		all: async () => ({ results: db.prepare(sql).all(...(args as never[])) as never[] }),
		first: async () => (db.prepare(sql).get(...(args as never[])) ?? null) as never,
		run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...(args as never[])).changes) } }),
	})
	return { db, d1: { prepare: (sql: string) => stmt(sql), batch: async (ss: { run: () => Promise<unknown> }[]) => Promise.all(ss.map((s) => s.run())) } }
}

// Un martes a las 14:00 de Cuba (UTC−4)
const T = Date.parse('2026-11-03T18:00:00Z')
const MIN = 60_000

test('velas: apertura, máximo, mínimo y cierre de la franja, aunque lleguen desordenadas', async () => {
	const { d1 } = memD1()
	await addCandle(d1, 'BANK_CUP', T + 5 * MIN, 1120, 50)
	await addCandle(d1, 'BANK_CUP', T + 9 * MIN, 1130, 20)
	await addCandle(d1, 'BANK_CUP', T + 1 * MIN, 1110, 10) // llega tarde: abre ella
	await addCandle(d1, 'BANK_CUP', T + 7 * MIN, 1105, 15.5)
	await addCandle(d1, 'BANK_CUP', T + 16 * MIN, 1125, 100) // la franja siguiente
	const c = await loadCandles(d1, 'BANK_CUP', '15m', null, T + 20 * MIN)
	assert.deepEqual(c, [
		{ t: T, o: 1110, h: 1130, l: 1105, c: 1130, ops: 4, usd: 95.5 },
		{ t: T + 15 * MIN, o: 1125, h: 1125, l: 1125, c: 1125, ops: 1, usd: 100 },
	])
	// En velas de una hora, las dos franjas son una
	assert.deepEqual(await loadCandles(d1, 'BANK_CUP', '1h', null, T + 20 * MIN), [{ t: T, o: 1110, h: 1130, l: 1105, c: 1125, ops: 5, usd: 195.5 }])
	// Con since, solo desde esa vela
	assert.deepEqual(
		(await loadCandles(d1, 'BANK_CUP', '15m', T + 15 * MIN, T + 20 * MIN)).map((x) => x.t),
		[T + 15 * MIN],
	)
	// Otro mercado no se mezcla
	assert.deepEqual(await loadCandles(d1, 'CUP', '15m', null, T + 20 * MIN), [])
})

test('velas: las de 4 h y de un día empiezan en hora de Cuba', () => {
	assert.equal(frameStart(T + 30 * MIN, '1d'), Date.parse('2026-11-03T04:00:00Z'))
	assert.equal(frameStart(Date.parse('2026-11-04T03:59:00Z'), '1d'), Date.parse('2026-11-03T04:00:00Z'))
	assert.equal(frameStart(T + 30 * MIN, '4h'), Date.parse('2026-11-03T16:00:00Z')) // 12:00 en Cuba
	assert.equal(frameStart(T + 30 * MIN, '1h'), T)
	const day = joinCandles(
		[
			{ t: Date.parse('2026-11-03T04:00:00Z'), o: 1, h: 2, l: 1, c: 2, ops: 1, usd: 1, first_at: 1, last_at: 1 },
			{ t: Date.parse('2026-11-04T03:45:00Z'), o: 3, h: 3, l: 3, c: 3, ops: 1, usd: 1, first_at: 2, last_at: 2 },
		],
		'1d',
	)
	assert.equal(day.length, 1)
	assert.equal(day[0].c, 3)
})

test('velas: antes de contarlas, la mejor venta del libro y el volumen por hora', async () => {
	const { db, d1 } = memD1()
	const H = 3600_000
	const cut = T + 2 * H
	await markCandlesFrom(d1, cut)
	await markCandlesFrom(d1, cut + H) // solo la primera vez
	const snap = db.prepare("INSERT INTO book_stats (coin, t, side, offers, outliers, best, usd, usd1, usd3, stale) VALUES ('BANK_CUP', ?, ?, 10, 0, ?, 500, 100, 300, ?)")
	snap.run(T, 'ask', 1120, 0)
	snap.run(T + 20 * MIN, 'ask', 1130, 0)
	snap.run(T + 40 * MIN, 'ask', 1110, 0)
	snap.run(T + 50 * MIN, 'ask', 1500, 1) // con el feed parado no cuenta
	snap.run(T + 50 * MIN, 'bid', 1100, 0) // la compra no
	snap.run(T + H, 'ask', 1125, 0)
	snap.run(cut, 'ask', 1140, 0) // desde que se cuentan, no
	const vol = db.prepare("INSERT INTO volume (coin, hour, side, ops, usd) VALUES ('BANK_CUP', ?, ?, ?, ?)")
	vol.run(T, 'buy', 2, 30)
	vol.run(T, 'sell', 1, 20)
	vol.run(T + H, 'sell', 3, 40)
	vol.run(cut, 'sell', 5, 99) // ya contado en las velas
	await addCandle(d1, 'BANK_CUP', T + H + 5 * MIN, 1118, 15) // sembrada (de antes): su precio manda, sus USD ya están en el volumen
	await addCandle(d1, 'BANK_CUP', cut + 5 * MIN, 1135, 60)
	const c = await loadCandles(d1, 'BANK_CUP', '1h', null, cut + 10 * MIN)
	assert.deepEqual(c, [
		{ t: T, o: 1120, h: 1130, l: 1110, c: 1110, ops: 3, usd: 50, book: true },
		{ t: T + H, o: 1118, h: 1118, l: 1118, c: 1118, ops: 3, usd: 40 },
		{ t: cut, o: 1135, h: 1135, l: 1135, c: 1135, ops: 1, usd: 60 },
	])
	// En velas de un día, todo junto: el precio de lo contado y los USD de las dos partes
	assert.deepEqual(await loadCandles(d1, 'BANK_CUP', '1d', null, cut + 10 * MIN), [{ t: frameStart(T, '1d'), o: 1118, h: 1135, l: 1118, c: 1135, ops: 7, usd: 150 }])
	// En 15 min no hay volumen de antes (una hora no se parte): la del libro va sin USD
	assert.deepEqual((await loadCandles(d1, 'BANK_CUP', '15m', null, cut + 10 * MIN))[0], { t: T, o: 1120, h: 1120, l: 1120, c: 1120, ops: 0, usd: 0, book: true })
})

test('velas: lo atípico no cuenta', () => {
	assert.equal(candlePrice(1120, 1115, 'ask'), true)
	assert.equal(candlePrice(10_000, 1115, 'ask'), false)
	assert.equal(candlePrice(10_000, null, 'ask'), true) // sin referencia no se marca nada
	assert.equal(candlePrice(0, 1115, 'bid'), false)
})

test('velas: la referencia propia es la mediana de los cierres de 48 h, con 3 operaciones o más', async () => {
	const { d1 } = memD1()
	const now = T + 10 * MIN
	await addCandle(d1, 'PIX', T - 40 * MIN, 5.6, 100)
	await addCandle(d1, 'PIX', T - 20 * MIN, 5.9, 50)
	await addCandle(d1, 'PIX', T + 5 * MIN, 0.59, 10) // un error de tipeo no la mueve
	await addCandle(d1, 'PIX', T + 6 * MIN, 5.7, 10) // misma franja: cierra en 5.7
	await addCandle(d1, 'PIX', T - 50 * 60 * MIN, 9, 10) // de hace más de 48 h no cuenta
	await addCandle(d1, 'PAYPAL', T - 5 * MIN, 1.05, 30) // con solo 2 operaciones, sin referencia
	await addCandle(d1, 'PAYPAL', T + 5 * MIN, 1.1, 30)
	const refs = await ownRefs(d1, now)
	assert.equal(refs.get('PIX'), 5.7)
	assert.equal(refs.has('PAYPAL'), false)
})
