// Acciones de QvaPay, solo para mirar (experimental). QvaPay vende acciones tokenizadas (las de su app) y publica sin
// cuenta su cotización (/stocks/:tick?type=quote) y su histórico (/stocks/:tick?timeframe=…). Aquí se leen esas dos
// rutas públicas para el mercado «Acciones» del terminal y para los avisos de precio de Pro. Comprar y vender se hace
// en QvaPay: el terminal no compra ni vende acciones. Solo precios públicos: ningún usuario ni token

export const QVAPAY = 'https://api.qvapay.com'

// Las de la app de QvaPay, en su orden (su lista pública trae solo 7, pero la cotización responde para todas)
export const STOCKS = [
	['SPY', 'S&P 500'],
	['NVDA', 'NVIDIA'],
	['TSLA', 'Tesla'],
	['QQQ', 'Nasdaq 100'],
	['CRCL', 'Circle'],
	['MSTR', 'Strategy'],
	['MSFT', 'Microsoft'],
	['AAPL', 'Apple'],
	['META', 'Meta'],
	['GOOGL', 'Alphabet'],
	['AMZN', 'Amazon'],
] as const
export type Stock = (typeof STOCKS)[number][0]
const NAMES = new Map<string, string>(STOCKS)
export const isStock = (s: unknown): s is Stock => typeof s === 'string' && NAMES.has(s)
export const stockName = (s: string) => NAMES.get(s) ?? s

// Los intervalos del histórico que da QvaPay y cuánto se guarda cada uno en la caché del borde (s). QvaPay ya guarda
// 2 min la última hora y hasta 2 h el año: más a menudo no traería nada nuevo
export const TIMEFRAMES = { '1H': 120, '24H': 300, '1W': 900, '1M': 3600, '1Y': 7200 } as const
export type Timeframe = keyof typeof TIMEFRAMES
export const isTimeframe = (t: unknown): t is Timeframe => typeof t === 'string' && Object.hasOwn(TIMEFRAMES, t)
// La cotización: QvaPay la guarda 5 minutos
export const QUOTES_TTL_S = 300

export interface Quote {
	symbol: Stock
	name: string
	fullName: string
	price: number
	change: number | null
	changeDollar: number | null
	open: number | null
	high: number | null
	low: number | null
	previousClose: number | null
	volume: number | null
	high52: number | null
	low52: number | null
}

const num = (v: unknown) => {
	const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v
	return typeof n === 'number' && Number.isFinite(n) ? n : null
}
const pos = (v: unknown) => {
	const n = num(v)
	return n !== null && n > 0 ? n : null
}

// Lo que se toma de la cotización de QvaPay (sin precio, nada)
export function cleanQuote(symbol: Stock, raw: unknown): Quote | null {
	const r = (raw ?? {}) as Record<string, unknown>
	const price = pos(r.price)
	if (price === null) return null
	const fullName = typeof r.name === 'string' && r.name.trim() ? r.name.trim().slice(0, 80) : stockName(symbol)
	return {
		symbol,
		name: stockName(symbol),
		fullName,
		price,
		change: num(r.change),
		changeDollar: num(r.changeDollar),
		open: pos(r.open),
		high: pos(r.high),
		low: pos(r.low),
		previousClose: pos(r.previousClose),
		volume: pos(r.volume),
		high52: pos(r.fiftyTwoWeekHigh),
		low52: pos(r.fiftyTwoWeekLow),
	}
}

// El histórico: [segundos, precio], en orden y sin repetidos
export function cleanHistory(raw: unknown): [number, number][] {
	if (!Array.isArray(raw)) return []
	const byTime = new Map<number, number>()
	for (const p of raw) {
		const t = num((p as Record<string, unknown>)?.time)
		const v = pos((p as Record<string, unknown>)?.value)
		if (t === null || v === null || t <= 0) continue
		byTime.set(Math.floor(t), v)
	}
	return [...byTime].sort((a, b) => a[0] - b[0])
}

async function getJson(url: string, fetcher: typeof fetch) {
	const res = await fetcher(url, { headers: { Accept: 'application/json' } }).catch(() => null)
	if (!res?.ok) return null
	return res.json().catch(() => null) as Promise<unknown>
}

export const loadQuote = async (symbol: Stock, fetcher: typeof fetch = fetch) => cleanQuote(symbol, await getJson(`${QVAPAY}/stocks/${symbol}?type=quote`, fetcher))

// La lista de todas, con las menos llamadas posibles (QvaPay corta a las pocas peticiones seguidas): su lista pública
// trae 7 con precio, cambio y volumen; las demás, de una en una con su cotización, hasta que QvaPay pida esperar (429).
// Las que falten salen de la lectura anterior (prev) si la hay; si no, fuera. El resto de la ficha (apertura, máximo,
// 52 semanas…) se pide aparte solo de la que se mira (loadQuote)
export async function loadQuotes(fetcher: typeof fetch = fetch, prev: Quote[] = []) {
	const out = new Map<string, Quote>()
	let limited = false
	const watched = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const res = await fetcher(input, init)
		if (res.status === 429) limited = true
		return res
	}) as typeof fetch
	const listed = await getJson(`${QVAPAY}/stocks`, watched)
	if (Array.isArray(listed))
		for (const raw of listed) {
			const s = (raw as Record<string, unknown>)?.symbol
			if (!isStock(s)) continue
			const q = cleanQuote(s, { ...(raw as Record<string, unknown>), name: stockName(s) })
			if (q) out.set(s, { ...q, fullName: q.name })
		}
	for (const [s] of STOCKS) {
		if (out.has(s)) continue
		if (limited) break
		const q = await loadQuote(s, watched)
		if (q) out.set(s, q)
	}
	for (const q of prev) if (isStock(q?.symbol) && !out.has(q.symbol)) out.set(q.symbol, q)
	return STOCKS.map(([s]) => out.get(s)).filter((q): q is Quote => !!q)
}

// QvaPay cuenta barras, no tiempo: su «24H» trae unos 6 días, «1W» un mes, «1M» seis semanas y «1Y» año y medio. Se
// recorta a lo que dice el intervalo, contado desde el último precio (con la bolsa cerrada, la última sesión). Si el
// recorte deja muy poco (el lunes recién abierto, «24 h» serían unos minutos) se queda al menos una sesión
const SPAN_S: Record<Timeframe, number> = { '1H': 3600, '24H': 86_400, '1W': 7 * 86_400, '1M': 30 * 86_400, '1Y': 365 * 86_400 }
const MIN_POINTS: Record<Timeframe, number> = { '1H': 0, '24H': 26, '1W': 35, '1M': 0, '1Y': 0 }
export function trimHistory(points: [number, number][], tf: Timeframe) {
	if (!points.length) return points
	const from = points[points.length - 1][0] - SPAN_S[tf]
	const start = points.findIndex(([t]) => t >= from)
	return points.slice(Math.max(0, Math.min(start, points.length - MIN_POINTS[tf])))
}

// En lo intradía QvaPay da la hora de Nueva York como si fuera UTC (sus barras van de 09:30 a 15:30): se pasa al
// instante de verdad. Lo diario (1M, 1Y) es un día a las 00:00 y se deja tal cual
const INTRADAY = new Set<Timeframe>(['1H', '24H', '1W'])
export async function loadHistory(symbol: Stock, tf: Timeframe, fetcher: typeof fetch = fetch) {
	const points = cleanHistory(await getJson(`${QVAPAY}/stocks/${symbol}?timeframe=${tf}`, fetcher))
	return trimHistory(INTRADAY.has(tf) ? points.map(([t, v]): [number, number] => [fromNyWall(t * 1000) / 1000, v]) : points, tf)
}

// ── La bolsa de Nueva York ─────────────────────────────────────────────
// De 9:30 a 16:00 de Nueva York, de lunes a viernes, sin sus festivos (hay que añadir los de cada año nuevo) y con los
// días que cierra a las 13:00. Fuera de ese horario QvaPay vende y compra igual, con más diferencia de precio
const HOLIDAYS = new Set([
	'2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', '2026-05-25', '2026-06-19', '2026-07-03', '2026-09-07', '2026-11-26', '2026-12-25',
	'2027-01-01', '2027-01-18', '2027-02-15', '2027-03-26', '2027-05-31', '2027-06-18', '2027-07-05', '2027-09-06', '2027-11-25', '2027-12-24',
])
const EARLY_CLOSE = new Set(['2026-11-27', '2026-12-24', '2027-11-26'])
const OPEN_MIN = 9 * 60 + 30
const CLOSE_MIN = 16 * 60
const EARLY_MIN = 13 * 60

const nyParts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short' })
function inNewYork(ms: number) {
	const p = Object.fromEntries(nyParts.formatToParts(new Date(ms)).map((x) => [x.type, x.value]))
	const wall = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second))
	return { day: `${p.year}-${p.month}-${p.day}`, weekday: p.weekday, minutes: Number(p.hour) * 60 + Number(p.minute), offset: wall - Math.floor(ms / 1000) * 1000 }
}
// El instante de una hora de Nueva York escrita como si fuera UTC (ms). Dos pasadas por si ese día cambia la hora
function fromNyWall(wall: number) {
	const t = wall - inNewYork(wall).offset
	return wall - inNewYork(t).offset
}
// El instante de una hora de Nueva York (minutos desde medianoche) de un día (AAAA-MM-DD)
function nyInstant(day: string, minutes: number) {
	const [y, m, d] = day.split('-').map(Number)
	return fromNyWall(Date.UTC(y, m - 1, d, 0, minutes))
}
const tradingDay = (day: string, weekday: string) => weekday !== 'Sat' && weekday !== 'Sun' && !HOLIDAYS.has(day)
const closeOf = (day: string) => (EARLY_CLOSE.has(day) ? EARLY_MIN : CLOSE_MIN)

export interface MarketStatus {
	open: boolean
	// Abierta: cuándo cierra. Cerrada: cuándo abre
	until: number
}
export function marketStatus(now: number): MarketStatus {
	const here = inNewYork(now)
	if (tradingDay(here.day, here.weekday) && here.minutes >= OPEN_MIN && here.minutes < closeOf(here.day)) return { open: true, until: nyInstant(here.day, closeOf(here.day)) }
	// El próximo día con bolsa (hoy mismo si aún no abrió)
	for (let i = 0; i < 12; i++) {
		const probe = inNewYork(now + i * 86_400_000)
		if (!tradingDay(probe.day, probe.weekday)) continue
		const opens = nyInstant(probe.day, OPEN_MIN)
		if (opens > now) return { open: false, until: opens }
	}
	return { open: false, until: now + 86_400_000 }
}
