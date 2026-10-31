// El análisis de mercado del modo Pro (/data/analysis): en una respuesta, todo lo que guarda el servidor de cada mercado.
// - La tasa al cierre de cada día de Cuba: el último registro del día (rates; QvaPay da la mediana de sus últimas 24 h).
// - Las operaciones del día, de ese mismo registro, y el volumen en USD y su reparto (volume, desde el feed).
// - elTOQUE de cada día (informal).
// - La última foto del libro, lo normal a esta hora y las horas en que más se opera y más se paga (book_stats).
// Solo agregados del mercado: ninguna oferta ni usuario. El cron lo calcula una vez al día, a la hora de menos tráfico
// de QvaPay, y lo deja hecho en el KV; cada hora solo le cambia la foto del libro (2 filas por mercado). Las visitas solo
// leen el último, nunca la base

import { COINS } from '../src/terminal/market.ts'
import { cubaDate } from './informal.ts'
import { cubaOffset, summer, type D1 } from './rates.ts'

const DAY_MS = 86_400_000
// El mes pasado entero, el anterior para comparar y unos días más para las medias móviles
const HISTORY_DAYS = 100
// Las horas del mercado y el libro de las últimas 4 semanas; lo normal del libro, de la última
const HEAT_DAYS = 28
const NORMAL_DAYS = 7
// Con menos días, las horas del mercado dirían más del azar que del mercado
const HEAT_MIN_DAYS = 3
// Una foto más vieja ya no es «el libro ahora»
const BOOK_MAX_AGE_MS = 30 * 60_000
const CST = -5 * 3600_000
const CDT = -4 * 3600_000

type Side = 'ask' | 'bid'
interface BookRow {
	t: number
	side: Side
	offers: number
	best: number | null
	usd: number
	usd1: number
	top1: number | null
	age: number | null
	fill100: number | null
	fill500: number | null
	stale: number
}
export interface AnalysisDay {
	day: string
	rate: number | null
	buy: number | null
	sell: number | null
	ops: number | null
	buyOps: number | null
	sellOps: number | null
	// USD operados (del feed): null en los días sin registro de volumen
	usd: number | null
	buyUsd: number | null
	sellUsd: number | null
	partial: boolean
}
type Heat = (number | null)[][]

const round = (v: number, d = 4) => Math.round(v * 10 ** d) / 10 ** d
const median = (xs: number[]) => {
	if (!xs.length) return null
	const s = [...xs].sort((a, b) => a - b)
	const m = s.length >> 1
	return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}
// Día de la semana (0 = domingo) y hora de Cuba
const cubaClock = (t: number) => {
	const d = new Date(t + cubaOffset(t))
	return [d.getUTCDay(), d.getUTCHours()] as const
}
const emptyHeat = (): number[][] => Array.from({ length: 7 }, () => Array(24).fill(0))

export const ANALYSIS_KEY = 'analysis/latest'
// De 3 a 5 de la madrugada en Cuba casi no hay operaciones ni nadie en el terminal (medido con volume y live_slots)
export const ANALYSIS_HOUR = 3
export function isAnalysisTime(at: number) {
	const d = new Date(at + cubaOffset(at))
	return d.getUTCHours() === ANALYSIS_HOUR && d.getUTCMinutes() === 0
}

export async function refreshAnalysis(env: { DB: D1; PRO?: { put?(key: string, value: string): Promise<void> } }, now = Date.now()) {
	if (!env.PRO?.put) return
	await env.PRO.put(ANALYSIS_KEY, JSON.stringify(await analysis(env.DB, now)))
}

export async function analysis(db: D1, now = Date.now()) {
	const since = now - HISTORY_DAYS * DAY_MS
	const heatSince = now - HEAT_DAYS * DAY_MS
	const today = cubaDate(now)
	const coins = await Promise.all(
		COINS.map(async (c) => {
			const [rates, volume, book] = await Promise.all([
				// Con "coin = ? AND t IN (...)" cada fila se busca por la clave (ver query en rates.ts)
				db
					.prepare(
						`SELECT t, median, median_buy, median_sell, count, count_buy, count_sell, window_h
						   FROM rates
						  WHERE coin = ?1 AND t IN (
						        SELECT MAX(t) FROM rates WHERE coin = ?1 AND t >= ?2
						         GROUP BY CAST((t + CASE WHEN (t >= ?3 AND t < ?4) OR (t >= ?5 AND t < ?6) THEN ${CDT} ELSE ${CST} END) / 86400000 AS INTEGER))
						  ORDER BY t`,
					)
					.bind(c.tick, since, ...summer(new Date(since).getUTCFullYear()), ...summer(new Date(now).getUTCFullYear()))
					.all<{ t: number; median: number | null; median_buy: number | null; median_sell: number | null; count: number | null; count_buy: number | null; count_sell: number | null; window_h: number | null }>(),
				db.prepare('SELECT hour, side, ops, usd FROM volume WHERE coin = ? AND hour >= ?').bind(c.tick, since).all<{ hour: number; side: string; ops: number; usd: number }>(),
				db
					.prepare('SELECT t, side, offers, best, usd, usd1, top1, age, fill100, fill500, stale FROM book_stats WHERE coin = ? AND t >= ? ORDER BY t')
					.bind(c.tick, heatSince)
					.all<BookRow>(),
			])
			return { tick: c.tick, ...coinAnalysis(rates.results, volume.results, book.results, today, now) }
		}),
	)
	const { results: inf } = await db.prepare('SELECT day, cur, rate FROM informal WHERE day >= ?').bind(cubaDate(since)).all<{ day: string; cur: string; rate: number }>()
	const informal: Record<string, { usd?: number; eur?: number; mlc?: number; usdt?: number }> = {}
	const KEY: Record<string, 'usd' | 'eur' | 'mlc' | 'usdt'> = { USD: 'usd', ECU: 'eur', MLC: 'mlc', USDT_TRC20: 'usdt' }
	for (const r of inf) if (r.rate > 0 && KEY[r.cur]) (informal[r.day] ??= {})[KEY[r.cur]] = r.rate
	return { at: now, today, informal, coins: Object.fromEntries(coins.map(({ tick, ...rest }) => [tick, rest])) }
}

// Cada hora (menos a la del cálculo entero): en el informe guardado, solo la última foto del libro de cada mercado
export async function refreshBook(env: { DB: D1; PRO?: { get(key: string): Promise<string | null>; put?(key: string, value: string): Promise<void> } }, now = Date.now()) {
	const body = await env.PRO?.get(ANALYSIS_KEY)
	if (!body || !env.PRO?.put) return
	const a = JSON.parse(body) as Awaited<ReturnType<typeof analysis>>
	await Promise.all(
		COINS.map(async (c) => {
			const { results } = await env.DB.prepare('SELECT t, side, offers, best, usd, usd1, top1, age, fill100, fill500, stale FROM book_stats WHERE coin = ? ORDER BY t DESC LIMIT 2').bind(c.tick).all<BookRow>()
			if (a.coins[c.tick]) a.coins[c.tick].book = latestBook(results, now)
		}),
	)
	await env.PRO.put(ANALYSIS_KEY, JSON.stringify(a))
}

// La foto más reciente con sus dos lados; una de hace más de media hora ya no es «el libro ahora»
function latestBook(book: BookRow[], now: number) {
	if (!book.length) return null
	const t = Math.max(...book.map((b) => b.t))
	if (now - t >= BOOK_MAX_AGE_MS) return null
	const at = (side: Side) => book.find((b) => b.t === t && b.side === side) ?? null
	const pick = (b: BookRow | null) => b && { offers: b.offers, best: b.best, usd: b.usd, usd1: b.usd1, top1: b.top1, age: b.age, fill100: b.fill100, fill500: b.fill500 }
	return { t, stale: !!(at('ask')?.stale || at('bid')?.stale), ask: pick(at('ask')), bid: pick(at('bid')) }
}

export function coinAnalysis(
	rates: { t: number; median: number | null; median_buy: number | null; median_sell: number | null; count: number | null; count_buy: number | null; count_sell: number | null; window_h: number | null }[],
	volume: { hour: number; side: string; ops: number; usd: number }[],
	book: BookRow[],
	today: string,
	now: number,
) {
	// El volumen de cada día (una parte que volvió resta en su hora: nunca menos de cero)
	const vol = new Map<string, { buy: number; sell: number }>()
	for (const v of volume) {
		const d = vol.get(cubaDate(v.hour)) ?? vol.set(cubaDate(v.hour), { buy: 0, sell: 0 }).get(cubaDate(v.hour))!
		d[v.side === 'buy' ? 'buy' : 'sell'] += v.usd
	}
	const money = (n: number) => Math.max(0, Math.round(n * 100) / 100)
	const days: AnalysisDay[] = rates.map((r) => {
		const day = cubaDate(r.t)
		// En los mercados de poco movimiento la ventana de QvaPay es de 3 o 7 días: se reparte por día
		const per = (n: number | null) => (n == null ? null : Math.round(n / ((r.window_h ?? 24) / 24)))
		const v = vol.get(day)
		return {
			day,
			rate: r.median,
			buy: r.median_buy,
			sell: r.median_sell,
			ops: per(r.count),
			buyOps: per(r.count_buy),
			sellOps: per(r.count_sell),
			usd: v ? money(v.buy + v.sell) : null,
			buyUsd: v ? money(v.buy) : null,
			sellUsd: v ? money(v.sell) : null,
			partial: day === today,
		}
	})

	// Cuándo se opera: USD de media en cada día de la semana y hora, contando solo los días con registro de volumen
	const heatFrom = now - HEAT_DAYS * DAY_MS
	const seen = new Set<string>()
	const usdHeat = emptyHeat()
	for (const v of volume) {
		if (v.hour < heatFrom) continue
		seen.add(cubaDate(v.hour))
		const [d, h] = cubaClock(v.hour)
		usdHeat[d][h] += v.usd
	}
	const perDow = Array(7).fill(0)
	for (const day of seen) perDow[new Date(`${day}T12:00:00Z`).getUTCDay()]++
	const heatVol: Heat | null = seen.size >= HEAT_MIN_DAYS ? usdHeat.map((row, d) => row.map((u) => (perDow[d] ? Math.max(0, Math.round(u / perDow[d])) : null))) : null

	// Cuándo pagan más los que compran USD: el mejor precio de compra del libro sobre su media de ese día (%)
	const fresh = book.filter((b) => !b.stale && b.best != null)
	const bids = fresh.filter((b) => b.side === 'bid')
	const dayMean = new Map<string, { s: number; n: number }>()
	for (const b of bids) {
		const m = dayMean.get(cubaDate(b.t)) ?? dayMean.set(cubaDate(b.t), { s: 0, n: 0 }).get(cubaDate(b.t))!
		m.s += b.best!
		m.n++
	}
	const sum = emptyHeat()
	const cnt = emptyHeat()
	for (const b of bids) {
		const m = dayMean.get(cubaDate(b.t))!
		const [d, h] = cubaClock(b.t)
		sum[d][h] += (b.best! / (m.s / m.n) - 1) * 100
		cnt[d][h]++
	}
	const heatBid: Heat | null = dayMean.size >= HEAT_MIN_DAYS ? sum.map((row, d) => row.map((s, h) => (cnt[d][h] ? round(s / cnt[d][h], 3) : null))) : null

	// El libro ahora: la última foto con los dos lados
	const nowBook = latestBook(book, now)

	// Lo normal: la mediana de la última semana a esta misma hora de Cuba (o de todas las horas, si hay pocas fotos)
	const week = fresh.filter((b) => b.t >= now - NORMAL_DAYS * DAY_MS)
	const hourNow = cubaClock(now)[1]
	const sameHour = week.filter((b) => cubaClock(b.t)[1] === hourNow)
	const base = sameHour.filter((b) => b.side === 'ask').length >= 6 ? sameHour : week
	const byT = new Map<number, Partial<Record<Side, BookRow>>>()
	for (const b of base) (byT.get(b.t) ?? byT.set(b.t, {}).get(b.t)!)[b.side] = b
	const spreads = [...byT.values()].filter((x) => x.ask && x.bid && x.bid.best! > 0).map((x) => x.ask!.best! / x.bid!.best! - 1)
	const normal = base.length
		? {
				spread: median(spreads),
				usd1Ask: median(base.filter((b) => b.side === 'ask').map((b) => b.usd1)),
				usd1Bid: median(base.filter((b) => b.side === 'bid').map((b) => b.usd1)),
				hour: base === sameHour,
			}
		: null

	return { days, heatVol, heatBid, book: nowBook, normal, bookSince: book.length ? book[0].t : null }
}
