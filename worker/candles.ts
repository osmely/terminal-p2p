// Velas de lo completado. El libro en vivo (livebook-do.ts) apunta cada operación del feed en su franja de 15 minutos;
// aquí se juntan en velas de 15 min, 1 h, 4 h o 1 día (en hora de Cuba) para la pestaña «Velas» del terminal. De antes
// de que se contaran no hay precio de cada operación: ahí la vela sale de la mejor venta del libro (book_stats, una
// foto cada 10 min) y va marcada (book), y los USD, del volumen por hora. Solo precios y sumas del mercado: ninguna
// oferta ni usuario

import { isOutlier } from '../src/terminal/market.ts'
import { cubaOffset, VOLUME_USD_SINCE, type D1 } from './rates.ts'

export const SLOT_MS = 15 * 60_000
const HOUR_MS = 3600_000
const DAY_MS = 86_400_000

// Cada intervalo, con cuánto hacia atrás se manda (unas 200–365 velas)
export const FRAMES = {
	'15m': { ms: SLOT_MS, span: 2 * DAY_MS },
	'1h': { ms: HOUR_MS, span: 10 * DAY_MS },
	'4h': { ms: 4 * HOUR_MS, span: 45 * DAY_MS },
	'1d': { ms: DAY_MS, span: 365 * DAY_MS },
} as const
export type Frame = keyof typeof FRAMES
export const isFrame = (f: string | null): f is Frame => f !== null && Object.hasOwn(FRAMES, f)

// Sin precio (o null): un periodo de antes con volumen y sin foto del libro
export interface Candle {
	t: number
	o: number | null
	h: number | null
	l: number | null
	c: number | null
	ops: number
	usd: number
	book?: true
}
interface Row {
	t: number
	o: number
	h: number
	l: number
	c: number
	ops: number
	usd: number
	first_at: number
	last_at: number
}

// Desde cuándo se cuentan las velas: lo apunta el libro en vivo una vez, al estrenarlas
const FROM_KEY = 'candles_from'
export async function markCandlesFrom(db: D1, at: number) {
	await db.prepare('INSERT OR IGNORE INTO app_flags (key, value, updated_at) VALUES (?, ?, ?)').bind(FROM_KEY, String(at), at).run()
}
async function candlesFrom(db: D1) {
	const v = Number((await db.prepare('SELECT value FROM app_flags WHERE key = ?').bind(FROM_KEY).first<{ value: string }>())?.value)
	return Number.isFinite(v) && v > 0 ? v : 0
}

// El inicio de la vela en la que cae t. Las de 4 h y de un día empiezan a la hora de Cuba (00:00, 04:00…)
export function frameStart(t: number, frame: Frame) {
	const { ms } = FRAMES[frame]
	const off = ms > HOUR_MS ? cubaOffset(t) : 0
	return Math.floor((t + off) / ms) * ms - off
}

// ¿Cuenta para las velas? Lo atípico respecto a la mediana de lo completado de su lado no (como en el libro)
export const candlePrice = (price: number, ref: number | null, side: 'ask' | 'bid') => price > 0 && !isOutlier(price, ref, side)

// Referencia propia de cada mercado: la mediana de los cierres de sus franjas de 15 min de las últimas 48 h, con 3
// operaciones o más. Es para los mercados de los que QvaPay no publica la mediana de lo completado (Pix, PayPal, USDT):
// sin ella no se ve qué precio es raro. Sin lado (las velas juntan compras y ventas)
export const OWN_REF_MS = 48 * HOUR_MS
export async function ownRefs(db: D1, now = Date.now()): Promise<Map<string, number>> {
	const { results } = await db.prepare('SELECT coin, c, ops FROM candles WHERE t >= ? AND c > 0').bind(now - OWN_REF_MS).all<{ coin: string; c: number; ops: number }>()
	const by = new Map<string, { closes: number[]; ops: number }>()
	for (const r of results) {
		const m = by.get(r.coin) ?? { closes: [], ops: 0 }
		m.closes.push(r.c)
		m.ops += r.ops
		by.set(r.coin, m)
	}
	const out = new Map<string, number>()
	for (const [coin, m] of by) {
		if (m.ops < 3) continue
		const s = m.closes.sort((a, b) => a - b)
		const mid = s.length >> 1
		out.set(coin, s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2)
	}
	return out
}

// Suma una operación a su franja de 15 min. En el UPDATE cada columna se calcula con lo que había antes
export async function addCandle(db: D1, coin: string, at: number, price: number, usd: number) {
	await db
		.prepare(
			`INSERT INTO candles (coin, t, o, h, l, c, first_at, last_at, ops, usd) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
			ON CONFLICT (coin, t) DO UPDATE SET
				o = CASE WHEN excluded.first_at < first_at THEN excluded.o ELSE o END,
				c = CASE WHEN excluded.last_at >= last_at THEN excluded.c ELSE c END,
				h = MAX(h, excluded.h), l = MIN(l, excluded.l),
				first_at = MIN(first_at, excluded.first_at), last_at = MAX(last_at, excluded.last_at),
				ops = ops + 1, usd = usd + excluded.usd`,
		)
		.bind(coin, Math.floor(at / SLOT_MS) * SLOT_MS, price, price, price, price, at, at, Math.round(usd * 100) / 100)
		.run()
}

// Las franjas de 15 min juntas en velas del intervalo, de la más vieja a la más nueva. Las operaciones y los USD de
// las franjas de antes de countFrom no se suman (ahí los pone el volumen por hora)
export function joinCandles(rows: Row[], frame: Frame, countFrom = 0): Row[] {
	const out = new Map<number, Row>()
	for (const r of rows) {
		const t = frameStart(r.t, frame)
		const counts = r.t >= countFrom
		const k = out.get(t)
		if (!k) {
			out.set(t, { ...r, t, ops: counts ? r.ops : 0, usd: counts ? r.usd : 0 })
			continue
		}
		if (r.first_at < k.first_at) (k.o = r.o), (k.first_at = r.first_at)
		if (r.last_at >= k.last_at) (k.c = r.c), (k.last_at = r.last_at)
		k.h = Math.max(k.h, r.h)
		k.l = Math.min(k.l, r.l)
		if (counts) (k.ops += r.ops), (k.usd += r.usd)
	}
	return [...out.values()].sort((a, b) => a.t - b.t)
}

// Las velas del intervalo desde `since` (el inicio de una vela) o, sin él, todas las de su alcance. Donde hay
// operaciones contadas, mandan ellas; antes de que se contaran, la mejor venta del libro y el volumen por hora (las
// horas enteras de antes; en velas de 15 min no, que una hora no se puede partir)
export async function loadCandles(db: D1, coin: string, frame: Frame, since: number | null, now = Date.now()): Promise<Candle[]> {
	const from = since ?? frameStart(now - FRAMES[frame].span, frame)
	const cut = await candlesFrom(db)
	const hourly = FRAMES[frame].ms >= HOUR_MS
	const [rows, book, vol] = await Promise.all([
		db.prepare('SELECT t, o, h, l, c, first_at, last_at, ops, usd FROM candles WHERE coin = ? AND t >= ? ORDER BY t').bind(coin, from).all<Row>(),
		from < cut
			? db.prepare("SELECT t, best FROM book_stats WHERE coin = ? AND side = 'ask' AND t >= ? AND t < ? AND best IS NOT NULL AND stale = 0 ORDER BY t").bind(coin, from, cut).all<{ t: number; best: number }>()
			: { results: [] },
		from < cut && hourly
			? db.prepare('SELECT hour, SUM(ops) AS ops, SUM(usd) AS usd FROM volume WHERE coin = ? AND hour >= ? AND hour + ? <= ? GROUP BY hour').bind(coin, from, HOUR_MS, cut).all<{ hour: number; ops: number; usd: number }>()
			: { results: [] },
	])
	const out = new Map<number, Candle>()
	const at = (t: number) => {
		const k = frameStart(t, frame)
		let c = out.get(k)
		if (!c) out.set(k, (c = { t: k, o: null, h: null, l: null, c: null, ops: 0, usd: 0 }))
		return c
	}
	for (const s of book.results) {
		const c = at(s.t)
		if (c.o === null) Object.assign(c, { o: s.best, h: s.best, l: s.best, book: true })
		c.h = Math.max(c.h!, s.best)
		c.l = Math.min(c.l!, s.best)
		c.c = s.best
	}
	for (const v of vol.results) {
		const c = at(v.hour)
		c.ops += v.ops
		// Los USD de antes de VOLUME_USD_SINCE no son de fiar (como en el histórico y el análisis): solo las operaciones
		if (v.hour >= VOLUME_USD_SINCE) c.usd += v.usd
	}
	for (const r of joinCandles(rows.results, frame, hourly ? cut : 0)) {
		const c = at(r.t)
		Object.assign(c, { o: r.o, h: r.h, l: r.l, c: r.c, ops: c.ops + r.ops, usd: c.usd + r.usd })
		delete c.book
	}
	return [...out.values()].sort((a, b) => a.t - b.t).map((c) => ({ ...c, usd: Math.round(c.usd * 100) / 100 }))
}
