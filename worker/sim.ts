// Simulador de trading en sim.terminalp2p.com: dinero ficticio, precios reales (de MEXC).
//
//   · Se entra con el botón oficial de Telegram: se comprueba su firma con el token del bot y se
//     guarda una cookie firmada. De cada jugador solo se guarda lo que da Telegram al entrar.
//   · La cuenta de cada jugador (src/sim/engine.ts) vive en D1 como un JSON con control de versión.
//   · Las órdenes a mercado se ejecutan con el bid/ask del momento. Las pendientes (límite, stop, OCO)
//     se revisan con las velas de 1 minuto: cada minuto en el cron y cada vez que el jugador abre su
//     cuenta. Así se ejecutan aunque nadie tenga la pantalla abierta. Precios: ver «Precios» abajo.

import { Engine, freshState, MARKETS, normSymbol, SimError, SYMBOLS, type Candle, type Quote, type SimState, type Symbol } from '../src/sim/engine.ts'
import { authorized } from './metrics.ts'
import { cubaOffset, type D1 } from './rates.ts'

export interface SimEnv {
	DB: D1
	TELEGRAM_BOT_TOKEN?: string
	SIM_SESSION_KEY?: string
	// Nombre del bot del botón de Telegram (sin @)
	SIM_BOT?: string
	// Solo en desarrollo (.dev.vars): entrar sin Telegram, que no funciona en localhost
	SIM_DEV_LOGIN?: string
	// Clave del panel de métricas: también abre la página privada del resumen semanal (/admin)
	METRICS_KEY?: string
	// Grupo donde se publica el resumen semanal
	SIM_CHANNEL?: string
}

// Binance no responde a las peticiones que salen de Cloudflare (bloquea su región: 451 y 403), así que
// el servidor toma los precios de MEXC, que usa la misma API que Binance y sigue su precio casi al
// céntimo. La pantalla también los pide aquí (ver «Precios para la pantalla»). (Binance.US sí responde, pero sus mercados pequeños
// casi no tienen actividad: el oro, PAXG, estaba un 10 % desfasado)
const MEXC = 'https://api.mexc.com/api/v3'
const sourceOf = (_symbol: Symbol) => MEXC
const COOKIE = 'tps'
const SESSION_DAYS = 30
// La firma del botón de Telegram vale un día
const AUTH_MAX_AGE_S = 86_400
// Velas de 1 minuto (las más finas que dan esas fuentes) y cuántas por petición
export const CANDLE_MS = 60_000
const KLINE_LIMIT = 1000
// Se espera un poco tras el cierre de cada vela para que la fuente la tenga completa
const CLOSE_DELAY_MS = 1500
const RANKING_SIZE = 50
// Operaciones de la temporada para aparecer en el ranking, y puestos del resumen semanal
export const MIN_TRADES = 3
const SUMMARY_SIZE = 10

// ── Temporadas: de lunes 00:00 a domingo 23:59, hora de Cuba ──────────

const DAY_MS = 86_400_000
const isoDay = (t: number) => new Date(t).toISOString().slice(0, 10)
// Medianoche (hora de Cuba) del día local que empieza en localMidnight, en ms UTC
const toUtc = (localMidnight: number) => localMidnight - cubaOffset(localMidnight + 4 * 3600_000)

export function season(now = Date.now()) {
	const local = now + cubaOffset(now)
	const d = new Date(local)
	const monday = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - ((d.getUTCDay() + 6) % 7) * DAY_MS
	return { id: isoDay(monday), start: toUtc(monday), end: toUtc(monday + 7 * DAY_MS) }
}

// ── Precios ───────────────────────────────────────────────────────────

async function market<T>(base: string, path: string): Promise<T> {
	const res = await fetch(`${base}${path}`, { headers: { Accept: 'application/json' } })
	if (!res.ok) {
		console.error(`precios ${res.status} ${base}${path.split('?')[0]}: ${(await res.text().catch(() => '')).slice(0, 200)}`)
		throw new SimError(`La fuente de precios no responde ahora mismo (${res.status}); inténtalo en unos segundos`)
	}
	return res.json() as Promise<T>
}

// Bid/ask de cada mercado pedido. Si alguno falla, se omite: quien lo necesite lo dirá
export async function quotes(symbols: Iterable<Symbol> = SYMBOLS): Promise<Partial<Record<Symbol, Quote>>> {
	const rows = await Promise.all(
		[...new Set(symbols)].map((s) =>
			market<{ bidPrice: string; askPrice: string }>(sourceOf(s), `/ticker/bookTicker?symbol=${s}`)
				.then((r) => [s, { bid: +r.bidPrice, ask: +r.askPrice }] as const)
				.catch(() => null),
		),
	)
	return Object.fromEntries(rows.filter((r) => r && r[1].bid > 0 && r[1].ask > 0) as [Symbol, Quote][])
}

const mids = (qs: Partial<Record<Symbol, Quote>>) => Object.fromEntries(Object.entries(qs).map(([s, q]) => [s, (q!.bid + q!.ask) / 2])) as Partial<Record<Symbol, number>>

// ── Precios para la pantalla ──────────────────────────────────────────
// El navegador no habla con ningún exchange (Binance y MEXC no responden desde Cuba sin VPN): pide aquí los
// precios y las velas, que salen de MEXC, la misma fuente con la que se ejecutan las órdenes. Se cachean unos
// segundos en el borde para que todos los jugadores compartan la misma consulta

const TICKERS_TTL_S = 3
// Intervalos del gráfico y su nombre en MEXC, con lo que se cachea cada uno
const INTERVALS: Record<string, { mexc: string; ttl: number }> = {
	'1m': { mexc: '1m', ttl: 5 },
	'5m': { mexc: '5m', ttl: 15 },
	'15m': { mexc: '15m', ttl: 30 },
	'1h': { mexc: '60m', ttl: 60 },
	'4h': { mexc: '4h', ttl: 120 },
	'1d': { mexc: '1d', ttl: 300 },
}

const edgeCache = () => (caches as unknown as { default: Cache }).default
// Última respuesta buena de cada ruta, para cuando MEXC falla (se guarda una hora)
const GOOD_TTL_S = 3600
const goodKey = (url: URL) => new Request(`${url.origin}/__good${url.pathname}${url.search}`)

async function putJson(key: Request, body: unknown, ttl: number) {
	const res = new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': `public, max-age=${ttl}` } })
	await edgeCache().put(key, res.clone())
	return res
}

// Respuesta cacheada unos segundos. Si MEXC falla, se sirve la última buena: lleva su hora (t), así la
// página sabe que es antigua y no la toma por un precio actual
async function cached(url: URL, ttl: number, load: () => Promise<unknown>) {
	const key = new Request(url.toString())
	const hit = await edgeCache().match(key)
	if (hit) return hit
	try {
		const body = await load()
		await putJson(goodKey(url), body, GOOD_TTL_S)
		return await putJson(key, body, ttl)
	} catch (err) {
		const good = await edgeCache().match(goodKey(url))
		if (good) return new Response(good.body, { headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } })
		throw err
	}
}

interface Ticker {
	last: number
	open: number
	bid: number
	ask: number
	t: number
}

// Último precio, apertura de 24 h y bid/ask de cada mercado, cada uno con la hora en que se leyó. Un mercado
// que falla se completa con su último precio bueno (con su hora antigua); si fallan todos, es un error
async function tickers(url: URL) {
	const now = Date.now()
	const rows = await Promise.all(
		SYMBOLS.map((s) =>
			market<{ lastPrice: string; openPrice: string; bidPrice: string; askPrice: string }>(sourceOf(s), `/ticker/24hr?symbol=${s}`)
				.then((r) => [s, { last: +r.lastPrice, open: +r.openPrice, bid: +r.bidPrice, ask: +r.askPrice, t: now }] as const)
				.catch(() => null),
		),
	)
	const fresh = Object.fromEntries(rows.filter(Boolean) as [Symbol, Ticker][])
	if (!Object.keys(fresh).length) throw new SimError('La fuente de precios no responde ahora mismo')
	if (Object.keys(fresh).length < SYMBOLS.length) {
		const good = (await (await edgeCache().match(goodKey(url)))?.json().catch(() => null)) as { tickers?: Record<string, Ticker> } | null
		for (const s of SYMBOLS) if (!fresh[s] && good?.tickers?.[s]) fresh[s] = good.tickers[s]
	}
	return { t: now, tickers: fresh }
}

async function chartKlines(symbol: Symbol, interval: string) {
	const rows = await market<[number, string, string, string, string][]>(sourceOf(symbol), `/klines?symbol=${symbol}&interval=${INTERVALS[interval].mexc}&limit=500`)
	return rows.map((r) => [r[0], +r[1], +r[2], +r[3], +r[4]])
}

// Libro de órdenes (20 niveles por lado) y últimas operaciones del mercado que se mira
async function depth(symbol: Symbol) {
	const d = await market<{ bids: [string, string][]; asks: [string, string][] }>(sourceOf(symbol), `/depth?symbol=${symbol}&limit=20`)
	return { t: Date.now(), bids: d.bids.map(([p, q]) => [+p, +q]), asks: d.asks.map(([p, q]) => [+p, +q]) }
}

async function recentTrades(symbol: Symbol) {
	const rows = await market<{ price: string; qty: string; time: number; isBuyerMaker: boolean }[]>(sourceOf(symbol), `/trades?symbol=${symbol}&limit=30`)
	// isBuyerMaker: el comprador esperaba en el libro, así que quien ejecutó vendía
	return rows.map((r) => ({ p: +r.price, q: +r.qty, t: r.time, sell: r.isBuyerMaker }))
}

// Velas de 1 minuto que empiezan entre from y to
export async function candles(symbol: Symbol, from: number, to: number): Promise<Candle[]> {
	const out: Candle[] = []
	let start = Math.floor(from / CANDLE_MS) * CANDLE_MS
	while (start <= to) {
		const rows = await market<[number, string, string, string, string][]>(sourceOf(symbol), `/klines?symbol=${symbol}&interval=1m&startTime=${start}&endTime=${to}&limit=${KLINE_LIMIT}`)
		for (const r of rows) out.push({ t: r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4] })
		if (rows.length < KLINE_LIMIT) break
		start = rows[rows.length - 1][0] + CANDLE_MS
	}
	return out
}

// ── Cuentas ───────────────────────────────────────────────────────────

interface Row {
	state: string
	version: number
}

export async function loadAccount(db: D1, tgId: number) {
	const row = await db.prepare('SELECT state, version FROM sim_accounts WHERE tg_id = ?').bind(tgId).first<Row>()
	return row ? { engine: new Engine(JSON.parse(row.state) as SimState), version: row.version } : null
}

// Guarda solo si nadie la cambió entretanto (false si hay que recargar y repetir)
async function saveAccount(db: D1, tgId: number, engine: Engine, version: number, prices: Partial<Record<Symbol, number>>, now: number) {
	if (Object.keys(prices).length) engine.state.marks = { ...engine.state.marks, ...prices }
	engine.state.season ??= season(now).id
	const acc = engine.account(prices)
	const r = await db
		.prepare('UPDATE sim_accounts SET state = ?, equity = ?, pnl_pct = ?, trades = ?, open_orders = ?, checked_at = ?, updated_at = ?, season = ?, benched = ?, version = version + 1 WHERE tg_id = ? AND version = ?')
		.bind(JSON.stringify(engine.state), acc.equity, acc.pnlPct, engine.state.tradeCount, engine.openOrders().length, engine.state.checkedAt, now, engine.state.season ?? '', engine.state.benched ? 1 : 0, tgId, version)
		.run()
	return (r.meta?.changes ?? 0) > 0
}

async function createAccount(db: D1, tgId: number, now: number) {
	const s = freshState(now, undefined, season(now).id)
	await db
		.prepare('INSERT OR IGNORE INTO sim_accounts (tg_id, state, equity, pnl_pct, trades, open_orders, checked_at, updated_at, version, season, benched) VALUES (?, ?, ?, 0, 0, 0, ?, ?, 0, ?, 0)')
		.bind(tgId, JSON.stringify(s), s.startBalance, now, now, s.season)
		.run()
}

const displayName = (u: { first_name: string; username: string | null }) => (u.username ? `@${u.username}` : u.first_name)
const escHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
const pctEs = (x: number) => `${x >= 0 ? '+' : ''}${x.toFixed(2).replace('.', ',')}%`
const dayEs = (t: number) => new Date(t + cubaOffset(t)).toLocaleDateString('es', { day: 'numeric', month: 'short', timeZone: 'UTC' })

// Al empezar una temporada: guarda la clasificación final de la anterior (con precios del momento),
// deja el borrador del resumen para Telegram y vuelve a poner a todos a 10.000 USDT. Lo hace una sola
// vez aunque lo llamen varias peticiones a la vez (cambio condicionado de sim_meta.season)
export async function rollover(db: D1, now: number, getPrices: () => Promise<Partial<Record<Symbol, number>>> = async () => mids(await quotes())) {
	const cur = season(now)
	const meta = await db.prepare("SELECT value FROM sim_meta WHERE key = 'season'").first<{ value: string }>()
	if (meta?.value === cur.id) return false
	if (!meta) {
		// Primera vez: las cuentas que ya había entran en la temporada en curso tal como están
		await db.prepare("INSERT OR IGNORE INTO sim_meta (key, value) VALUES ('season', ?)").bind(cur.id).run()
		await db.prepare("UPDATE sim_accounts SET season = ? WHERE season = ''").bind(cur.id).run()
		const { results } = await db.prepare('SELECT tg_id, state FROM sim_accounts WHERE season = ?').bind(cur.id).all<{ tg_id: number; state: string }>()
		const stmt = db.prepare('UPDATE sim_accounts SET state = ? WHERE tg_id = ?')
		const fixes = results.map((r) => stmt.bind(JSON.stringify({ ...(JSON.parse(r.state) as SimState), season: cur.id }), r.tg_id))
		for (let i = 0; i < fixes.length; i += 50) await db.batch(fixes.slice(i, i + 50))
		return false
	}
	const claim = await db.prepare("UPDATE sim_meta SET value = ? WHERE key = 'season' AND value = ?").bind(cur.id, meta.value).run()
	if (!claim.meta?.changes) return false
	const prev = meta.value
	const prices = await getPrices().catch(() => ({}))
	const { results } = await db
		.prepare(
			`SELECT a.tg_id, a.state, a.trades, u.first_name, u.username FROM sim_accounts a JOIN sim_users u ON u.tg_id = a.tg_id
			  WHERE a.season = ? AND a.benched = 0 AND a.trades >= ? AND u.compete = 1`,
		)
		.bind(prev, MIN_TRADES)
		.all<{ tg_id: number; state: string; trades: number; first_name: string; username: string | null }>()
	const standings = results
		.map((r) => ({ ...new Engine(JSON.parse(r.state) as SimState).account(prices), tg_id: r.tg_id, name: displayName(r) }))
		.sort((a, b) => b.pnlPct - a.pnlPct)
	const ins = db.prepare('INSERT OR REPLACE INTO sim_results (season, rank, tg_id, name, pnl_pct, equity, trades) VALUES (?, ?, ?, ?, ?, ?, ?)')
	const rows = standings.map((x, i) => ins.bind(prev, i + 1, x.tg_id, x.name, x.pnlPct, x.equity, x.trades))
	for (let i = 0; i < rows.length; i += 50) await db.batch(rows.slice(i, i + 50))
	const text = summaryText(prev, standings)
	await db.prepare("INSERT OR REPLACE INTO sim_meta (key, value) VALUES ('draft', ?)").bind(JSON.stringify({ season: prev, text, createdAt: now, posted: false })).run()
	// Todos a 10.000 USDT en la temporada nueva
	const fresh = freshState(now, undefined, cur.id)
	await db
		.prepare('UPDATE sim_accounts SET state = ?, equity = ?, pnl_pct = 0, trades = 0, open_orders = 0, checked_at = ?, updated_at = ?, season = ?, benched = 0, version = version + 1')
		.bind(JSON.stringify(fresh), fresh.startBalance, now, now, cur.id)
		.run()
	return true
}

// Resumen de una temporada para el grupo de Telegram (HTML de Telegram)
export function summaryText(seasonId: string, standings: { name: string; pnlPct: number }[]) {
	const start = Date.parse(`${seasonId}T12:00:00Z`)
	const medal = ['🥇', '🥈', '🥉']
	const top = standings.slice(0, SUMMARY_SIZE).map((x, i) => `${medal[i] ?? `${i + 1}.`} ${escHtml(x.name)} <b>${pctEs(x.pnlPct)}</b>`)
	return [
		`🏆 <b>Simulador de trading: temporada del ${dayEs(start)} al ${dayEs(start + 6 * DAY_MS)}</b>`,
		'',
		...(top.length ? top : ['Esta semana nadie llegó a las 3 operaciones. ¡La próxima puede ser tuya!']),
		'',
		standings.length === 1 ? `Compitió 1 jugador con al menos ${MIN_TRADES} operaciones.` : standings.length ? `Compitieron ${standings.length} jugadores con al menos ${MIN_TRADES} operaciones.` : '',
		'Ya empezó la nueva temporada: todos arrancan con 10.000 USDT ficticios 👉 https://sim.terminalp2p.com',
	]
		.filter((l, i, a) => l !== '' || a[i - 1] !== '')
		.join('\n')
}

// Revisa las órdenes pendientes con las velas cerradas desde la última revisión. checkedAt queda en el
// inicio del minuto en curso: todas las velas anteriores ya se revisaron
export async function catchUp(engine: Engine, now: number, fetchCandles: (s: Symbol, from: number, to: number) => Promise<Candle[]> = candles) {
	const closed = (c: Candle) => c.t + CANDLE_MS + CLOSE_DELAY_MS <= now
	const open = engine.openOrders()
	for (const symbol of new Set(open.map((o) => o.symbol))) {
		const first = Math.min(...open.filter((o) => o.symbol === symbol).map((o) => o.createdAt))
		const from = Math.floor(Math.max(engine.state.checkedAt, first) / CANDLE_MS) * CANDLE_MS
		const cs = (await fetchCandles(symbol, from, now)).filter((c) => c.t >= from && closed(c))
		engine.replay(symbol, cs, CANDLE_MS)
	}
	engine.state.checkedAt = Math.max(engine.state.checkedAt, Math.floor((now - CLOSE_DELAY_MS) / CANDLE_MS) * CANDLE_MS)
}

// Mercados de los que hace falta precio: posiciones, órdenes abiertas y el de la orden nueva
function needed(engine: Engine, extra?: Symbol) {
	const s = engine.state
	const out = new Set<Symbol>(extra ? [extra] : [])
	for (const sym of SYMBOLS) {
		const b = MARKETS[sym].base
		if (s.balances[b]?.free || s.balances[b]?.locked || s.shorts[b]?.qty) out.add(sym)
	}
	for (const o of engine.openOrders()) out.add(o.symbol)
	return out
}

// Carga, aplica un cambio y guarda; si otra petición la cambió a la vez, lo repite con la versión nueva
async function withAccount<T>(db: D1, tgId: number, fn: (e: Engine, prices: Partial<Record<Symbol, Quote>>) => T | Promise<T>, symbol?: Symbol): Promise<{ result: T; engine: Engine; prices: Partial<Record<Symbol, Quote>> }> {
	for (let attempt = 0; attempt < 3; attempt++) {
		const now = Date.now()
		let acc = await loadAccount(db, tgId)
		// Si empezó una temporada y el cron aún no la abrió, se abre ahora (y se lee la cuenta ya al día)
		if (acc && acc.engine.state.season !== season(now).id) {
			await rollover(db, now)
			acc = await loadAccount(db, tgId)
		}
		if (!acc) {
			await createAccount(db, tgId, now)
			acc = await loadAccount(db, tgId)
		}
		const prices = await quotes(needed(acc!.engine, symbol))
		await catchUp(acc!.engine, now)
		const result = await fn(acc!.engine, prices)
		if (await saveAccount(db, tgId, acc!.engine, acc!.version, mids(prices), now)) return { result, engine: acc!.engine, prices }
	}
	throw new SimError('La cuenta está ocupada; inténtalo de nuevo')
}

function view(engine: Engine, prices: Partial<Record<Symbol, Quote>>) {
	const s = engine.state
	return {
		account: engine.account(mids(prices)),
		openOrders: engine.openOrders().reverse(),
		orders: s.orders.filter((o) => o.status !== 'OPEN').slice(-30).reverse(),
		trades: s.trades.slice(-50).reverse(),
		checkedAt: s.checkedAt,
	}
}

// ── Cron: cada minuto, las cuentas con órdenes abiertas; cada 10, el patrimonio del ranking ──

export async function simCron(db: D1, now: number, refreshAll: boolean) {
	await rollover(db, now)
	const { results } = await db.prepare('SELECT tg_id, state, version FROM sim_accounts WHERE open_orders > 0 LIMIT 500').all<Row & { tg_id: number }>()
	const cache = new Map<string, Candle[]>()
	const engines = results.map((r) => ({ id: r.tg_id, version: r.version, engine: new Engine(JSON.parse(r.state) as SimState) }))
	// Una sola petición de velas por mercado para todas las cuentas
	const ranges = new Map<Symbol, number>()
	for (const { engine } of engines)
		for (const o of engine.openOrders()) {
			const from = Math.floor(Math.max(engine.state.checkedAt, o.createdAt) / CANDLE_MS) * CANDLE_MS
			ranges.set(o.symbol, Math.min(ranges.get(o.symbol) ?? Infinity, from))
		}
	for (const [symbol, from] of ranges) cache.set(symbol, await candles(symbol, from, now).catch(() => []))
	const prices = engines.length || refreshAll ? mids(await quotes()) : {}
	for (const { id, version, engine } of engines) {
		await catchUp(engine, now, async (s) => cache.get(s) ?? [])
		await saveAccount(db, id, engine, version, prices, now) // si alguien la tocaba a la vez, la revisa su petición
	}
	if (!refreshAll) return
	// Patrimonio a precio de mercado de quien tiene posiciones, para que el ranking esté al día
	const { results: all } = await db.prepare('SELECT tg_id, state FROM sim_accounts WHERE trades > 0').all<{ tg_id: number; state: string }>()
	const stmt = db.prepare('UPDATE sim_accounts SET equity = ?, pnl_pct = ? WHERE tg_id = ?')
	const updates = all.map((r) => {
		const a = new Engine(JSON.parse(r.state) as SimState).account(prices)
		return stmt.bind(a.equity, a.pnlPct, r.tg_id)
	})
	for (let i = 0; i < updates.length; i += 50) await db.batch(updates.slice(i, i + 50))
}

// ── Telegram y sesión ─────────────────────────────────────────────────

const enc = new TextEncoder()
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('')
const b64url = (s: string) => btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const unb64url = (s: string) => atob(s.replace(/-/g, '+').replace(/_/g, '/'))

async function hmac(key: ArrayBuffer | string, data: string) {
	const raw = typeof key === 'string' ? new Uint8Array(enc.encode(key)) : key
	const k = await crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
	return crypto.subtle.sign('HMAC', k, new Uint8Array(enc.encode(data)))
}

// Igualdad en tiempo constante entre dos cadenas de la misma longitud
function same(a: string, b: string) {
	if (a.length !== b.length) return false
	let diff = 0
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
	return diff === 0
}

export interface TgUser {
	id: number
	first_name: string
	username?: string
	photo_url?: string
}

// Comprueba la firma del botón de Telegram: HMAC-SHA-256 de los campos ordenados con SHA-256(token del bot)
// como clave (https://core.telegram.org/widgets/login#checking-authorization)
export async function verifyTelegram(params: URLSearchParams, botToken: string, nowS = Math.floor(Date.now() / 1000)): Promise<TgUser | null> {
	const hash = params.get('hash') ?? ''
	const fields = [...params.entries()].filter(([k]) => k !== 'hash').sort(([a], [b]) => (a < b ? -1 : 1))
	const check = fields.map(([k, v]) => `${k}=${v}`).join('\n')
	const key = await crypto.subtle.digest('SHA-256', new Uint8Array(enc.encode(botToken)))
	if (!same(hex(await hmac(key, check)), hash.toLowerCase())) return null
	const authDate = Number(params.get('auth_date'))
	if (!(authDate > 0) || nowS - authDate > AUTH_MAX_AGE_S) return null
	const id = Number(params.get('id'))
	if (!Number.isSafeInteger(id) || id <= 0) return null
	return { id, first_name: (params.get('first_name') ?? '').slice(0, 64) || 'Jugador', username: params.get('username')?.slice(0, 32) || undefined, photo_url: params.get('photo_url')?.slice(0, 300) || undefined }
}

export async function sessionCookie(tgId: number, key: string, now = Date.now()) {
	const payload = b64url(JSON.stringify({ u: tgId, e: now + SESSION_DAYS * 86_400_000 }))
	const sig = b64url(String.fromCharCode(...new Uint8Array(await hmac(key, payload))))
	return `${payload}.${sig}`
}

export async function readSession(cookieHeader: string | null, key: string, now = Date.now()): Promise<number | null> {
	const raw = (cookieHeader ?? '')
		.split(';')
		.map((p) => p.trim())
		.find((p) => p.startsWith(`${COOKIE}=`))
		?.slice(COOKIE.length + 1)
	if (!raw) return null
	const [payload, sig] = raw.split('.')
	if (!payload || !sig) return null
	const expected = b64url(String.fromCharCode(...new Uint8Array(await hmac(key, payload))))
	if (!same(expected, sig)) return null
	try {
		const { u, e } = JSON.parse(unb64url(payload)) as { u: number; e: number }
		return Number.isSafeInteger(u) && e > now ? u : null
	} catch {
		return null
	}
}

const setCookie = (url: URL, value: string, maxAgeS: number) =>
	`${COOKIE}=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAgeS}${url.protocol === 'https:' ? '; Secure' : ''}`

async function login(env: SimEnv, url: URL, user: TgUser) {
	const now = Date.now()
	await env.DB.prepare(
		`INSERT INTO sim_users (tg_id, first_name, username, photo_url, created_at, last_login) VALUES (?, ?, ?, ?, ?, ?)
		 ON CONFLICT (tg_id) DO UPDATE SET first_name = excluded.first_name, username = excluded.username, photo_url = excluded.photo_url, last_login = excluded.last_login`,
	)
		.bind(user.id, user.first_name, user.username ?? null, user.photo_url ?? null, now, now)
		.run()
	await createAccount(env.DB, user.id, now)
	return new Response(null, { status: 302, headers: { Location: '/', 'Set-Cookie': setCookie(url, await sessionCookie(user.id, env.SIM_SESSION_KEY!, now), SESSION_DAYS * 86_400) } })
}

// ── Rutas (/api/* en sim.terminalp2p.com) ─────────────────────────────

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
	new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers } })

const isDev = (env: SimEnv, url: URL) => env.SIM_DEV_LOGIN === '1' && (url.hostname.endsWith('.localhost') || url.hostname === 'localhost')

export async function simApi(req: Request, url: URL, env: SimEnv): Promise<Response> {
	const route = `${req.method} ${url.pathname}`
	if (!env.SIM_SESSION_KEY) return json(503, { error: 'El simulador aún no está configurado' })
	// Las escrituras solo desde nuestra propia página
	if (req.method !== 'GET' && req.headers.get('origin') !== url.origin) return json(403, { error: 'Origen no permitido' })
	try {
		if (route === 'GET /api/config') return json(200, { bot: env.SIM_BOT ?? 'terminalp2p_bot', dev: isDev(env, url), markets: SYMBOLS.map((s) => ({ symbol: s, ...MARKETS[s] })) })
		if (route === 'GET /api/tickers') {
			const u = new URL('/api/tickers', url.origin)
			return await cached(u, TICKERS_TTL_S, () => tickers(u))
		}
		if (route === 'GET /api/klines') {
			const symbol = normSymbol(url.searchParams.get('symbol'))
			const interval = url.searchParams.get('interval') ?? ''
			if (!INTERVALS[interval]) return json(400, { error: 'Intervalo no válido' })
			return await cached(new URL(`/api/klines?symbol=${symbol}&interval=${interval}`, url.origin), INTERVALS[interval].ttl, () => chartKlines(symbol, interval))
		}
		if (route === 'GET /api/depth' || route === 'GET /api/trades') {
			const symbol = normSymbol(url.searchParams.get('symbol'))
			const path = url.pathname
			return await cached(new URL(`${path}?symbol=${symbol}`, url.origin), TICKERS_TTL_S, () => (path === '/api/depth' ? depth(symbol) : recentTrades(symbol)))
		}
		if (route === 'GET /api/ranking') return json(200, await ranking(env.DB, await readSession(req.headers.get('cookie'), env.SIM_SESSION_KEY)))
		if (route === 'GET /api/auth/telegram') {
			if (!env.TELEGRAM_BOT_TOKEN) return json(503, { error: 'Falta configurar el bot de Telegram' })
			const user = await verifyTelegram(url.searchParams, env.TELEGRAM_BOT_TOKEN)
			if (!user) return new Response('No se pudo comprobar el inicio de sesión con Telegram. Vuelve a intentarlo.', { status: 401 })
			return login(env, url, user)
		}
		if (route === 'GET /api/auth/dev' && isDev(env, url)) return login(env, url, { id: 1, first_name: 'Prueba', username: 'prueba_local' })
		if (route === 'POST /api/logout') return json(200, { ok: true }, { 'Set-Cookie': setCookie(url, '', 0) })

		const tgId = await readSession(req.headers.get('cookie'), env.SIM_SESSION_KEY)
		if (route === 'GET /api/me') {
			const user = tgId ? await env.DB.prepare('SELECT tg_id AS id, first_name, username, photo_url, compete FROM sim_users WHERE tg_id = ?').bind(tgId).first() : null
			return json(200, { user })
		}
		if (!tgId) return json(401, { error: 'Entra con Telegram para jugar' })
		if (route === 'GET /api/state') {
			const { engine, prices } = await withAccount(env.DB, tgId, () => null)
			return json(200, view(engine, prices))
		}
		if (route === 'POST /api/orders') {
			const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
			const symbol = normSymbol(body.symbol)
			const { result, engine, prices } = await withAccount(env.DB, tgId, (e, qs) => {
				const q = qs[symbol]
				if (!q) throw new SimError('Aún no hay precio para este mercado')
				return e.placeOrder(
					{
						symbol,
						side: String(body.side ?? ''),
						type: String(body.type ?? 'MARKET'),
						quantity: num(body.quantity),
						quoteAmount: num(body.quoteAmount),
						price: num(body.price),
						stopPrice: num(body.stopPrice),
						stopLoss: num(body.stopLoss),
						takeProfit: num(body.takeProfit),
					},
					q,
				)
			}, symbol)
			return json(200, { order: result, ...view(engine, prices) })
		}
		const edit = /^PATCH \/api\/orders\/(\d+)$/.exec(route)
		if (edit) {
			const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
			const acc = await loadAccount(env.DB, tgId)
			const o = acc?.engine.openOrders().find((x) => x.id === Number(edit[1]))
			if (!o) throw new SimError('Esa orden ya no está abierta')
			const { result, engine, prices } = await withAccount(
				env.DB,
				tgId,
				(e, qs) => {
					const q = qs[o.symbol]
					if (!q) throw new SimError('Aún no hay precio para este mercado')
					return e.modifyOrder(Number(edit[1]), { price: num(body.price), stopPrice: num(body.stopPrice) }, q)
				},
				o.symbol,
			)
			return json(200, { order: result, ...view(engine, prices) })
		}
		if (route === 'DELETE /api/orders') {
			const symbol = url.searchParams.get('symbol') ? normSymbol(url.searchParams.get('symbol')) : undefined
			const { result, engine, prices } = await withAccount(env.DB, tgId, (e) => e.cancelAll(symbol))
			return json(200, { canceled: result, ...view(engine, prices) })
		}
		const cancel = /^DELETE \/api\/orders\/(\d+)$/.exec(route)
		if (cancel) {
			const { engine, prices } = await withAccount(env.DB, tgId, (e) => e.cancelOrder(Number(cancel[1])))
			return json(200, view(engine, prices))
		}
		if (route === 'POST /api/compete') {
			// Apuntarse cuando ya operaste esta semana cuenta desde el lunes: nadie juega oculto y se apunta
			// solo cuando le va bien. Salir es inmediato
			const on = ((await req.json().catch(() => ({}))) as { on?: unknown }).on === true
			let startsMonday = false
			if (on) {
				const { engine } = await withAccount(env.DB, tgId, (e) => {
					if (e.state.tradeCount > 0 && !e.state.benched) e.state.benched = true
				})
				startsMonday = !!engine.state.benched
			}
			await env.DB.prepare('UPDATE sim_users SET compete = ? WHERE tg_id = ?').bind(on ? 1 : 0, tgId).run()
			return json(200, { compete: on, startsMonday, ranking: await ranking(env.DB, tgId) })
		}
		if (route === 'POST /api/reset') {
			// Una cuenta nueva no tiene posiciones ni órdenes: no hace falta ningún precio. Quien reinicia
			// después de operar en la temporada no compite hasta la siguiente
			const now = Date.now()
			const acc = await loadAccount(env.DB, tgId)
			const prev = acc?.engine.state
			const cur = season(now).id
			const benched = prev?.season === cur && (prev.benched || prev.tradeCount > 0)
			const engine = new Engine(freshState(now, undefined, cur, !!benched))
			if (!acc) await createAccount(env.DB, tgId, now)
			else if (!(await saveAccount(env.DB, tgId, engine, acc.version, {}, now))) throw new SimError('La cuenta está ocupada; inténtalo de nuevo')
			return json(200, view(engine, {}))
		}
		return json(404, { error: 'Ruta desconocida' })
	} catch (err) {
		if (err instanceof SimError) return json(400, { error: err.message })
		console.error(`simulador ${route}: ${(err as Error).message}`)
		return json(500, { error: 'Algo falló en el simulador; inténtalo de nuevo' })
	}
}

const num = (v: unknown) => (v == null || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null)

// Ranking de la temporada (quien lleva al menos 3 operaciones y no reinició), tu situación,
// el podio de la temporada pasada y el salón de la fama
async function ranking(db: D1, me: number | null) {
	const cur = season()
	const { results } = await db
		.prepare(
			`SELECT a.tg_id, a.equity, a.pnl_pct, a.trades, u.first_name, u.username FROM sim_accounts a JOIN sim_users u ON u.tg_id = a.tg_id
			  WHERE a.season = ? AND a.benched = 0 AND a.trades >= ? AND u.compete = 1 ORDER BY a.pnl_pct DESC LIMIT ?`,
		)
		.bind(cur.id, MIN_TRADES, RANKING_SIZE)
		.all<{ tg_id: number; equity: number; pnl_pct: number; trades: number; first_name: string; username: string | null }>()
	const rows = results.map((r, i) => ({ rank: i + 1, name: displayName(r), equity: r.equity, pnlPct: r.pnl_pct, trades: r.trades, me: r.tg_id === me }))
	let mine: { rank: number | null; equity: number; pnlPct: number; trades: number; benched: boolean; compete: boolean } | null = null
	if (me) {
		const a = await db
			.prepare('SELECT a.pnl_pct, a.equity, a.trades, a.benched, a.season, u.compete FROM sim_accounts a JOIN sim_users u ON u.tg_id = a.tg_id WHERE a.tg_id = ?')
			.bind(me)
			.first<{ pnl_pct: number; equity: number; trades: number; benched: number; season: string; compete: number }>()
		if (a && a.season === cur.id) {
			const eligible = !!a.compete && !a.benched && a.trades >= MIN_TRADES
			const above = eligible
				? await db
						.prepare('SELECT COUNT(*) AS n FROM sim_accounts a JOIN sim_users u ON u.tg_id = a.tg_id WHERE a.season = ? AND a.benched = 0 AND a.trades >= ? AND u.compete = 1 AND a.pnl_pct > ?')
						.bind(cur.id, MIN_TRADES, a.pnl_pct)
						.first<{ n: number }>()
				: null
			mine = { rank: eligible ? (above?.n ?? 0) + 1 : null, equity: a.equity, pnlPct: a.pnl_pct, trades: a.trades, benched: !!a.benched, compete: !!a.compete }
		}
	}
	const last = await db.prepare("SELECT season FROM sim_results WHERE season < ? ORDER BY season DESC LIMIT 1").bind(cur.id).first<{ season: string }>()
	const podium = last
		? (await db.prepare('SELECT rank, tg_id, name, pnl_pct, trades FROM sim_results WHERE season = ? ORDER BY rank LIMIT ?').bind(last.season, SUMMARY_SIZE).all<{ rank: number; tg_id: number; name: string; pnl_pct: number; trades: number }>()).results
		: []
	const { results: fame } = await db
		.prepare(
			`SELECT tg_id, SUM(rank = 1) AS wins, SUM(rank <= 3) AS podiums, (SELECT name FROM sim_results r2 WHERE r2.tg_id = r.tg_id ORDER BY season DESC LIMIT 1) AS name
			   FROM sim_results r WHERE rank <= 3 GROUP BY tg_id ORDER BY wins DESC, podiums DESC LIMIT 20`,
		)
		.all<{ tg_id: number; wins: number; podiums: number; name: string }>()
	return {
		season: cur,
		minTrades: MIN_TRADES,
		rows,
		mine,
		last: last ? { season: last.season, rows: podium.map((r) => ({ rank: r.rank, name: r.name, pnlPct: r.pnl_pct, trades: r.trades, me: r.tg_id === me })) } : null,
		fame: fame.map((f) => ({ name: f.name, wins: f.wins, podiums: f.podiums, me: f.tg_id === me })),
	}
}

// ── Página privada del resumen semanal (/admin, con la clave del panel de métricas) ──

interface Draft {
	season: string
	text: string
	createdAt: number
	posted: boolean
	postedAt?: number
}

const seasonDay = (id: string) => dayEs(Date.parse(`${id}T12:00:00Z`))

const html = (body: string, status = 200) =>
	new Response(
		`<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>Resumen semanal · Simulador</title>
<style>:root{color-scheme:dark;--bg:#0a0d12;--s:#10151c;--l:#1e2733;--t:#e7ecf3;--m:#7a8799;--a:#5b8cff;--g:#1fc28b}body{margin:0;background:var(--bg);color:var(--t);font:15px/1.5 system-ui,sans-serif}main{width:min(760px,100% - 32px);margin:28px auto 60px}h1{font-size:22px;margin:0 0 4px}h2{font-size:16px;margin:28px 0 10px}.m{color:var(--m);font-size:13px}textarea{width:100%;min-height:260px;box-sizing:border-box;background:var(--s);color:var(--t);border:1px solid var(--l);border-radius:10px;padding:12px;font:14px/1.5 ui-monospace,Menlo,monospace}button{margin-top:10px;padding:10px 16px;border:0;border-radius:8px;background:var(--a);color:#fff;font-weight:600;font-size:14px;cursor:pointer}.ok{padding:10px 14px;border-radius:8px;background:rgba(31,194,139,.12);color:var(--g)}table{width:100%;border-collapse:collapse;font-size:14px}td,th{padding:7px 10px;border-bottom:1px solid var(--l);text-align:left}th{color:var(--m);font-size:12px}</style></head><body><main>${body}</main></body></html>`,
		{ status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' } },
	)

async function sendTelegram(token: string, chat: string, text: string) {
	const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ chat_id: chat, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true } }),
	})
	const data = (await res.json().catch(() => ({}))) as { ok?: boolean; description?: string }
	if (!data.ok) throw new SimError(`Telegram no aceptó el mensaje: ${data.description ?? res.status}`)
}

export async function simAdmin(req: Request, url: URL, env: SimEnv): Promise<Response> {
	if (!env.METRICS_KEY) return new Response('no encontrado', { status: 404 })
	if (!(await authorized(req, env.METRICS_KEY)))
		return new Response('Necesitas la clave del panel', { status: 401, headers: { 'WWW-Authenticate': 'Basic realm="Terminal P2P metrics", charset="UTF-8"', 'Cache-Control': 'no-store' } })
	const row = await env.DB.prepare("SELECT value FROM sim_meta WHERE key = 'draft'").first<{ value: string }>()
	const draft = row ? (JSON.parse(row.value) as Draft) : null

	if (req.method === 'POST' && url.pathname === '/admin/publish') {
		if (req.headers.get('origin') !== url.origin) return new Response('Origen no permitido', { status: 403 })
		if (!draft) return html('<p>No hay ningún resumen pendiente.</p>', 400)
		if (draft.posted) return Response.redirect(`${url.origin}/admin?ya=1`, 303)
		if (!env.TELEGRAM_BOT_TOKEN) return html('<p>Falta el token del bot.</p>', 503)
		const text = String((await req.formData()).get('text') ?? '').trim().slice(0, 4000) || draft.text
		try {
			await sendTelegram(env.TELEGRAM_BOT_TOKEN, env.SIM_CHANNEL ?? '@terminalp2p', text)
		} catch (e) {
			return html(`<h1>No se publicó</h1><p>${escHtml((e as Error).message)}</p><p><a href="/admin" style="color:#5b8cff">Volver</a></p>`, 502)
		}
		await env.DB.prepare("UPDATE sim_meta SET value = ? WHERE key = 'draft'").bind(JSON.stringify({ ...draft, text, posted: true, postedAt: Date.now() })).run()
		return Response.redirect(`${url.origin}/admin?ok=1`, 303)
	}
	if (url.pathname !== '/admin') return new Response('no encontrado', { status: 404 })

	// Clasificación provisional de la temporada en curso
	const cur = season()
	const { results } = await env.DB.prepare(
		`SELECT a.pnl_pct, a.trades, u.first_name, u.username FROM sim_accounts a JOIN sim_users u ON u.tg_id = a.tg_id
		  WHERE a.season = ? AND a.benched = 0 AND a.trades >= ? AND u.compete = 1 ORDER BY a.pnl_pct DESC LIMIT 10`,
	)
		.bind(cur.id, MIN_TRADES)
		.all<{ pnl_pct: number; trades: number; first_name: string; username: string | null }>()
	const notice = url.searchParams.has('ok') ? '<p class="ok">Publicado en el grupo de Telegram.</p>' : url.searchParams.has('ya') ? '<p class="ok">Ese resumen ya estaba publicado.</p>' : ''
	const draftBlock = !draft
		? '<p class="m">Aún no ha terminado ninguna temporada. El borrador aparece aquí el lunes a las 00:00 (hora de Cuba).</p>'
		: draft.posted
			? `<p class="m">El resumen de la temporada del ${seasonDay(draft.season)} se publicó el ${new Date(draft.postedAt ?? 0).toLocaleString('es')}.</p><textarea readonly>${escHtml(draft.text)}</textarea>`
			: `<p class="m">Temporada del ${seasonDay(draft.season)}. Puedes editar el texto (HTML de Telegram: &lt;b&gt;, &lt;i&gt;) antes de publicarlo.</p>
				<form method="post" action="/admin/publish"><textarea name="text">${escHtml(draft.text)}</textarea><button type="submit">Publicar en ${escHtml(env.SIM_CHANNEL ?? '@terminalp2p')}</button></form>`
	return html(`<h1>Resumen semanal del simulador</h1><p class="m">Temporada en curso: ${dayEs(cur.start)} – ${dayEs(cur.end - 1)} (termina el lunes a las 00:00, hora de Cuba)</p>${notice}
		<h2>Resumen pendiente</h2>${draftBlock}
		<h2>Clasificación provisional de esta semana</h2>${
			results.length
				? `<table><thead><tr><th>#</th><th>Jugador</th><th>Rentabilidad</th><th>Operaciones</th></tr></thead><tbody>${results
						.map((r, i) => `<tr><td>${i + 1}</td><td>${escHtml(displayName(r))}</td><td>${pctEs(r.pnl_pct)}</td><td>${r.trades}</td></tr>`)
						.join('')}</tbody></table>`
				: `<p class="m">Nadie lleva aún ${MIN_TRADES} operaciones esta semana.</p>`
		}`)
}
