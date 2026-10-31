import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { analysis, ANALYSIS_KEY, isAnalysisTime, refreshAnalysis, refreshBook } from '../worker/analysis.ts'

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

// 31 oct 2026, 12:00 en Cuba (UTC-4)
const NOW = Date.parse('2026-10-31T16:00:00Z')
const H = 3600_000

test('análisis: el cierre de cada día de Cuba, su volumen (null sin registro) y elTOQUE', async () => {
	const { db, d1 } = memD1()
	// Dos registros el 29 (el último manda), uno el 30 y uno hoy. Hora de Cuba = UTC-4
	db.exec(`INSERT INTO rates (coin, t, median, median_buy, median_sell, count, count_buy, count_sell, window_h) VALUES
		('BANK_CUP', ${Date.parse('2026-10-29T14:00:00Z')}, 1100, 1095, 1105, 50, 20, 30, 24),
		('BANK_CUP', ${Date.parse('2026-10-30T03:50:00Z')}, 1110, 1105, 1115, 60, 25, 35, 24),
		('BANK_CUP', ${Date.parse('2026-10-30T20:00:00Z')}, 1120, 1115, 1125, 70, 30, 40, 24),
		('BANK_CUP', ${NOW - H}, 1130, 1125, 1135, 72, 30, 42, 72)`)
	db.exec(`INSERT INTO volume (coin, hour, side, ops, usd) VALUES
		('BANK_CUP', ${Date.parse('2026-10-30T15:00:00Z')}, 'buy', 3, 300),
		('BANK_CUP', ${Date.parse('2026-10-30T15:00:00Z')}, 'sell', 2, 500),
		('BANK_CUP', ${Date.parse('2026-10-30T16:00:00Z')}, 'sell', -1, -100)`)
	db.exec(`INSERT INTO informal (day, cur, rate, final, t) VALUES ('2026-10-30', 'USD', 865, 1, 0), ('2026-10-30', 'USDT_TRC20', 1105, 1, 0), ('2026-10-30', 'BTC', 0, 1, 0)`)
	const a = await analysis(d1, NOW, 0)
	assert.equal(a.today, '2026-10-31')
	assert.deepEqual(a.informal, { '2026-10-30': { usd: 865, usdt: 1105 } })
	const days = a.coins.BANK_CUP.days
	assert.deepEqual(
		days.map((d) => [d.day, d.rate, d.usd, d.buyUsd, d.sellUsd, d.partial]),
		[
			['2026-10-29', 1110, null, null, null, false],
			['2026-10-30', 1120, 700, 300, 400, false],
			['2026-10-31', 1130, null, null, null, true],
		],
	)
	// Con ventana de 72 h, las operaciones se reparten por día
	assert.deepEqual([days[2].ops, days[2].buyOps, days[2].sellOps], [24, 10, 14])
	// Sin foto del libro ni días suficientes: nada inventado
	assert.equal(a.coins.BANK_CUP.book, null)
	assert.equal(a.coins.BANK_CUP.heatBid, null)
	assert.equal(a.coins.BANK_CUP.heatVol, null)
	assert.deepEqual(a.coins.ZELLE.days, [])
})

test('análisis: un mercado sin tasa de QvaPay (USDCASH) tiene sus días por el volumen, con las operaciones del feed', async () => {
	const { db, d1 } = memD1()
	db.exec(`INSERT INTO rates (coin, t, median, median_buy, median_sell, count, count_buy, count_sell, window_h) VALUES
		('ZELLE', ${Date.parse('2026-10-30T20:00:00Z')}, 1.1, 1.09, 1.11, 10, 4, 6, 24)`)
	db.exec(`INSERT INTO volume (coin, hour, side, ops, usd) VALUES
		('USDCASH', ${Date.parse('2026-10-29T14:00:00Z')}, 'sell', 2, 244),
		('USDCASH', ${Date.parse('2026-10-30T15:00:00Z')}, 'sell', 1, 200),
		('USDCASH', ${Date.parse('2026-10-30T16:00:00Z')}, 'buy', 1, 50),
		('ZELLE', ${Date.parse('2026-10-29T15:00:00Z')}, 'buy', 3, 90)`)
	const a = await analysis(d1, NOW, 0)
	assert.deepEqual(
		a.coins.USDCASH.days.map((d) => [d.day, d.rate, d.ops, d.buyOps, d.sellOps, d.usd, d.buyUsd, d.sellUsd]),
		[
			['2026-10-29', null, 2, 0, 2, 244, 0, 244],
			['2026-10-30', null, 2, 1, 1, 250, 50, 200],
		],
	)
	// Un mercado con tasa también gana los días que solo tienen volumen, en orden
	assert.deepEqual(
		a.coins.ZELLE.days.map((d) => [d.day, d.rate, d.usd]),
		[
			['2026-10-29', null, 90],
			['2026-10-30', 1.1, null],
		],
	)
	// Con los USD de fiar solo desde el 30 a las 15:30 UTC: el 29 conserva sus operaciones, sin USD; el 30, solo lo de después
	const b = await analysis(d1, NOW, Date.parse('2026-10-30T15:30:00Z'))
	assert.deepEqual(
		b.coins.USDCASH.days.map((d) => [d.day, d.ops, d.usd, d.buyUsd, d.sellUsd]),
		[
			['2026-10-29', 2, null, null, null],
			['2026-10-30', 2, 50, 50, 0],
		],
	)
})

test('análisis: el libro ahora, lo normal (también cruzado) y las horas solo con 3 días o más', async () => {
	const { db, d1 } = memD1()
	const rows: string[] = []
	// Tres días de fotos a las 10:00 y a las 12:00 de Cuba; a las 12 el mejor comprador paga un 2% más
	for (const day of ['2026-10-29', '2026-10-30', '2026-10-31'])
		for (const [hour, bid] of [
			[14, 1000],
			[16, 1020],
		] as const) {
			const t = Date.parse(`${day}T${hour}:00:00Z`)
			if (t > NOW) continue
			rows.push(`('BANK_CUP', ${t}, 'ask', 5, 0, 990, 800, 100, 300, 0.4, 0.8, 12, 995, 1010, 0)`, `('BANK_CUP', ${t}, 'bid', 4, 0, ${bid}, 600, 200, 400, 0.5, 0.9, 20, NULL, NULL, 0)`)
		}
	db.exec(`INSERT INTO book_stats (coin, t, side, offers, outliers, best, usd, usd1, usd3, top1, top3, age, fill100, fill500, stale) VALUES ${rows.join(',')}`)
	const c = (await analysis(d1, NOW)).coins.BANK_CUP
	assert.equal(c.book?.t, NOW)
	assert.equal(c.book?.ask?.fill100, 995)
	assert.equal(c.book?.bid?.best, 1020)
	// A las 12 de Cuba hay solo 3 fotos (menos de 6): lo normal sale de todas las horas, con el libro cruzado
	assert.equal(c.normal?.hour, false)
	assert.ok(Math.abs((c.normal?.spread ?? 0) - (990 / 1020 - 1 + (990 / 1000 - 1)) / 2) < 1e-9)
	assert.equal(c.normal?.usd1Ask, 100)
	// Viernes 30 y jueves 29 a las 12: el mejor comprador, ~1% sobre la media del día; a las 10, ~1% por debajo
	assert.ok(c.heatBid)
	assert.ok(c.heatBid[5][12]! > 0.9 && c.heatBid[4][10]! < -0.9)
	assert.equal(c.heatBid[5][3], null)
})

test('análisis: el cron lo deja hecho en el KV', async () => {
	const { d1 } = memD1()
	const kv = new Map<string, string>()
	await refreshAnalysis({ DB: d1, PRO: { put: async (k, v) => void kv.set(k, v) } }, NOW)
	assert.equal(JSON.parse(kv.get(ANALYSIS_KEY)!).today, '2026-10-31')
	// Sin KV no hace nada
	await refreshAnalysis({ DB: d1 }, NOW)
})

test('análisis: entero a las 3:00 de Cuba (con y sin horario de verano); cada hora, solo la foto del libro', async () => {
	assert.equal(isAnalysisTime(Date.parse('2026-10-31T07:00:00Z')), true) // UTC−4
	assert.equal(isAnalysisTime(Date.parse('2026-11-05T08:00:00Z')), true) // UTC−5
	assert.equal(isAnalysisTime(Date.parse('2026-10-31T07:10:00Z')), false)
	assert.equal(isAnalysisTime(Date.parse('2026-10-31T08:00:00Z')), false)
	const { db, d1 } = memD1()
	const kv = new Map<string, string>()
	const PRO = { get: async (k: string) => kv.get(k) ?? null, put: async (k: string, v: string) => void kv.set(k, v) }
	await refreshAnalysis({ DB: d1, PRO }, NOW)
	assert.equal(JSON.parse(kv.get(ANALYSIS_KEY)!).coins.BANK_CUP.book, null)
	db.exec(`INSERT INTO book_stats (coin, t, side, offers, outliers, best, usd, usd1, usd3, top1, top3, age, fill100, fill500, stale) VALUES
		('BANK_CUP', ${NOW + 3 * H}, 'ask', 5, 0, 990, 800, 100, 300, 0.4, 0.8, 12, 995, 1010, 0),
		('BANK_CUP', ${NOW + 3 * H}, 'bid', 4, 0, 980, 600, 200, 400, 0.5, 0.9, 20, NULL, NULL, 1)`)
	await refreshBook({ DB: d1, PRO }, NOW + 3 * H + 60_000)
	const a = JSON.parse(kv.get(ANALYSIS_KEY)!)
	assert.deepEqual([a.coins.BANK_CUP.book.t, a.coins.BANK_CUP.book.stale, a.coins.BANK_CUP.book.ask.fill100], [NOW + 3 * H, true, 995])
	// El resto del informe no cambia
	assert.equal(a.at, NOW)
})
