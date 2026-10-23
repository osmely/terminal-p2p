// Histórico público de la tasa del P2P de QvaPay en D1.
// Solo agregados que QvaPay publica sin cuenta: ningún dato de usuarios.

import { COINS } from '../src/terminal/market.ts'
import type { Averages } from '../src/qvapay/types.ts'

// Lo mínimo de D1 que se usa (compatible con D1Database; compila también en Node)
interface D1Stmt {
	bind(...values: unknown[]): D1Stmt
	all<T>(): Promise<{ results: T[] }>
	first<T>(): Promise<T | null>
}
export interface D1 {
	prepare(sql: string): D1Stmt
	batch(statements: D1Stmt[]): Promise<unknown>
}

const UPSTREAM = 'https://api.qvapay.com/p2p/averages'
const SLOT_MS = 10 * 60_000
const TICKS = new Set<string>(COINS.map((c) => c.tick))

export interface RateRow {
	coin: string
	t: number
	average: number | null
	avg_buy: number | null
	avg_sell: number | null
	median: number | null
	median_buy: number | null
	median_sell: number | null
	count: number
	count_buy: number | null
	count_sell: number | null
	window_h: number | null
}

// Un punto por moneda cada 10 minutos: repetir el cron en la misma franja reemplaza, no duplica
export const slot = (now: number) => Math.floor(now / SLOT_MS) * SLOT_MS

const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null)

export function rowsFrom(avg: Averages, t: number): RateRow[] {
	const rows: RateRow[] = []
	for (const [coin, a] of Object.entries(avg)) {
		if (!TICKS.has(coin) || !a || !(a.count > 0)) continue
		rows.push({
			coin,
			t,
			average: n(a.average),
			avg_buy: n(a.average_buy),
			avg_sell: n(a.average_sell),
			median: n(a.median),
			median_buy: n(a.median_buy),
			median_sell: n(a.median_sell),
			count: a.count,
			count_buy: Number.isFinite(a.count_buy) ? (a.count_buy as number) : null,
			count_sell: Number.isFinite(a.count_sell) ? (a.count_sell as number) : null,
			window_h: n(a.window_hours),
		})
	}
	return rows
}

// Lo llama el cron: una sola petición sin token a QvaPay
export async function collect(db: D1, now = Date.now()) {
	const res = await fetch(UPSTREAM, { headers: { Accept: 'application/json' } })
	if (!res.ok) throw new Error(`QvaPay respondió ${res.status}`)
	const rows = rowsFrom((await res.json()) as Averages, slot(now))
	if (!rows.length) return 0
	const stmt = db.prepare(
		'INSERT OR REPLACE INTO rates (coin, t, average, avg_buy, avg_sell, median, median_buy, median_sell, count, count_buy, count_sell, window_h) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
	)
	await db.batch(rows.map((r) => stmt.bind(r.coin, r.t, r.average, r.avg_buy, r.avg_sell, r.median, r.median_buy, r.median_sell, r.count, r.count_buy, r.count_sell, r.window_h)))
	return rows.length
}

export const RANGES = [7, 30, 365] as const

// Agregación según el rango: 10 min (7 días), 1 h (30 días), 1 día (1 año)
export function bucketFor(days: number) {
	return days <= 7 ? SLOT_MS : days <= 30 ? 3600_000 : 86_400_000
}

export async function query(db: D1, coin: string, days: number, now = Date.now()) {
	const bucket = bucketFor(days)
	const since = now - days * 86_400_000
	const { results } = await db
		.prepare(
			// D1 enlaza los números de JS como REAL: sin CAST la división no trunca y no agrupa nada
			`SELECT CAST(t / ?1 AS INTEGER) * ?1 AS t,
			        AVG(COALESCE(median_buy, avg_buy))   AS buy,
			        AVG(COALESCE(median_sell, avg_sell)) AS sell,
			        AVG(average)                         AS avg,
			        MAX(count)                           AS count
			   FROM rates WHERE coin = ?2 AND t >= ?3
			  GROUP BY CAST(t / ?1 AS INTEGER) ORDER BY 1`,
		)
		.bind(bucket, coin, since)
		.all<{ t: number; buy: number | null; sell: number | null; avg: number | null; count: number }>()
	const first = await db.prepare('SELECT MIN(t) AS t FROM rates WHERE coin = ?').bind(coin).first<{ t: number | null }>()
	// Operaciones por día: el último registro de cada día de Cuba (su conteo es el de las 24 h previas)
	const { results: last } = await db
		.prepare(
			`SELECT r.t, r.count, r.count_buy, r.count_sell, r.window_h
			   FROM rates r
			   JOIN (SELECT MAX(t) AS t FROM rates WHERE coin = ?1 AND t >= ?2
			          GROUP BY CAST((t + CASE WHEN (t >= ?3 AND t < ?4) OR (t >= ?5 AND t < ?6) THEN ${CDT} ELSE ${CST} END) / 86400000 AS INTEGER)) d ON d.t = r.t
			  WHERE r.coin = ?1
			  ORDER BY r.t`,
		)
		// El rango (hasta un año) toca como mucho dos veranos: el del año de inicio y el del actual
		.bind(coin, since, ...summer(new Date(since).getUTCFullYear()), ...summer(new Date(now).getUTCFullYear()))
		.all<DayRow>()
	return { coin, days, bucketMs: bucket, firstPoint: first?.t ?? null, points: results, daily: dailyFrom(last, now) }
}

// Cuba: UTC-5, y UTC-4 en verano. El verano va del segundo domingo de marzo al primer domingo
// de noviembre; los dos cambios son a las 05:00 UTC (00:00 → 01:00 y 01:00 → 00:00 en Cuba)
const CST = -5 * 3600_000
const CDT = -4 * 3600_000
const sunday = (year: number, month: number, nth: number) => {
	const first = new Date(Date.UTC(year, month, 1)).getUTCDay()
	return Date.UTC(year, month, 1 + ((7 - first) % 7) + (nth - 1) * 7, 5)
}
// [inicio, fin) del verano de ese año, en ms UTC
export const summer = (year: number): [number, number] => [sunday(year, 2, 2), sunday(year, 10, 1)]
export function cubaOffset(t: number) {
	const [start, end] = summer(new Date(t).getUTCFullYear())
	return t >= start && t < end ? CDT : CST
}
const cubaDay = (t: number) => Math.floor((t + cubaOffset(t)) / 86_400_000)

interface DayRow {
	t: number
	count: number | null
	count_buy: number | null
	count_sell: number | null
	window_h: number | null
}

// De "operaciones en la ventana de QvaPay" a operaciones por día. En las monedas de poco
// movimiento la ventana es de 7 días: se reparte para que todas las barras sean diarias
export function dailyFrom(rows: DayRow[], now = Date.now()) {
	const today = cubaDay(now)
	return rows.map((r) => {
		const perDay = (r.window_h ?? 24) / 24
		const per = (v: number | null) => (v == null ? null : Math.round(v / perDay))
		const day = cubaDay(r.t)
		const noon = day * 86_400_000 + 12 * 3600_000
		return {
			// Mediodía de ese día en Cuba, para dibujar la barra
			t: noon - cubaOffset(noon - CST),
			day: new Date(day * 86_400_000).toISOString().slice(0, 10),
			ops: per(r.count) ?? 0,
			buy: per(r.count_buy),
			sell: per(r.count_sell),
			// El día de hoy aún no terminó: es lo de las últimas 24 h
			partial: day === today,
		}
	})
}

export const isCoin = (v: string | null): v is string => v !== null && TICKS.has(v)
