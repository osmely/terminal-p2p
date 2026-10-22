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
		'INSERT OR REPLACE INTO rates (coin, t, average, avg_buy, avg_sell, median, median_buy, median_sell, count, window_h) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
	)
	await db.batch(rows.map((r) => stmt.bind(r.coin, r.t, r.average, r.avg_buy, r.avg_sell, r.median, r.median_buy, r.median_sell, r.count, r.window_h)))
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
			`SELECT (t / ?1) * ?1 AS t,
			        AVG(COALESCE(median_buy, avg_buy))   AS buy,
			        AVG(COALESCE(median_sell, avg_sell)) AS sell,
			        AVG(average)                         AS avg,
			        MAX(count)                           AS count
			   FROM rates WHERE coin = ?2 AND t >= ?3
			  GROUP BY t / ?1 ORDER BY 1`,
		)
		.bind(bucket, coin, since)
		.all<{ t: number; buy: number | null; sell: number | null; avg: number | null; count: number }>()
	const first = await db.prepare('SELECT MIN(t) AS t FROM rates WHERE coin = ?').bind(coin).first<{ t: number | null }>()
	return { coin, days, bucketMs: bucket, firstPoint: first?.t ?? null, points: results }
}

export const isCoin = (v: string | null): v is string => v !== null && TICKS.has(v)
