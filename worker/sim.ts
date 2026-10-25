// Simulador de trading en sim.terminalp2p.com: dinero ficticio, precios reales (de MEXC).
//
//   · Sin login propio: la sesión viene del terminal (cookie del dominio con la huella del token, ver
//     worker/session.ts) y la cuenta va con tu licencia Pro o con esa huella. Pro se hereda en vivo.
//   · Telegram solo para salir en el ranking: se comprueba la firma de su botón y se guarda su nombre.
//   · La cuenta de cada jugador (src/sim/engine.ts) vive en D1 como un JSON con control de versión.
//   · Las órdenes a mercado se ejecutan con el bid/ask del momento. Las pendientes (límite, stop, OCO)
//     se revisan con las velas de 1 minuto: cada minuto en el cron y cada vez que el jugador abre su
//     cuenta. Así se ejecutan aunque nadie tenga la pantalla abierta. Precios: ver «Precios» abajo.

import { Engine, freshState, MARKETS, normSymbol, SimError, SYMBOLS, type Candle, type Quote, type SimState, type Symbol } from '../src/sim/engine.ts'
import { enc, hex, hmac, same } from './crypto.ts'
import { adminPage, askKey } from './admin.ts'
import { authorized } from './metrics.ts'
import { licenseOfPrint, ProError, type ProEnv } from './pro.ts'
import { readSession, sessionCookie, sessionToken } from './session.ts'
import { cubaOffset, type D1 } from './rates.ts'

export interface SimEnv extends Omit<ProEnv, 'DB' | 'METRICS_KEY'> {
	DB: D1
	// Bot de Telegram: su botón vincula tu Telegram para salir en el ranking, y publica el resumen semanal
	TELEGRAM_BOT_TOKEN?: string
	// Nombre del bot del botón de Telegram (sin @)
	SIM_BOT?: string
	// Solo en desarrollo (.dev.vars): entrar sin el terminal (la cookie del terminal no cruza a sim.localhost)
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
// La firma del botón de Telegram vale un día
const AUTH_MAX_AGE_S = 86_400
// Velas de 1 minuto (las más finas que dan esas fuentes) y cuántas por petición
export const CANDLE_MS = 60_000
const KLINE_LIMIT = 1000
// Se espera un poco tras el cierre de cada vela para que la fuente la tenga completa
const CLOSE_DELAY_MS = 1500
const RANKING_SIZE = 50
// Compite quien se apuntó y tiene Telegram vinculado (su nombre es el que sale en el ranking)
const COMPETES = 'u.compete = 1 AND u.tg_id IS NOT NULL'
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

// Lo que se guarda en la caché del borde lleva su duración; al navegador se le dice que no guarde nada (los
// precios cambian cada pocos segundos, y la zona alarga a 4 h la caché del navegador de lo que sale de la caché)
const toBrowser = (body: string | ReadableStream | null) => new Response(body, { headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } })

async function putJson(key: Request, body: unknown, ttl: number) {
	const text = JSON.stringify(body)
	await edgeCache().put(key, new Response(text, { headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': `public, max-age=${ttl}` } }))
	return toBrowser(text)
}

// Respuesta cacheada unos segundos. Si MEXC falla, se sirve la última buena: lleva su hora (t), así la
// página sabe que es antigua y no la toma por un precio actual
async function cached(url: URL, ttl: number, load: () => Promise<unknown>) {
	const key = new Request(url.toString())
	const hit = await edgeCache().match(key)
	if (hit) return toBrowser(hit.body)
	try {
		const body = await load()
		await putJson(goodKey(url), body, GOOD_TTL_S)
		return await putJson(key, body, ttl)
	} catch (err) {
		const good = await edgeCache().match(goodKey(url))
		if (good) return toBrowser(good.body)
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
				// El «último precio» de este resumen va hasta 10 s por detrás; el bid/ask está al día: el precio en
				// vivo es su punto medio (si falta, el último)
				.then((r) => {
					const bid = +r.bidPrice
					const ask = +r.askPrice
					return [s, { last: bid > 0 && ask > 0 ? (bid + ask) / 2 : +r.lastPrice, open: +r.openPrice, bid, ask, t: now }] as const
				})
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

export async function loadAccount(db: D1, player: number) {
	const row = await db.prepare('SELECT state, version FROM sim_accounts WHERE player = ?').bind(player).first<Row>()
	return row ? { engine: new Engine(JSON.parse(row.state) as SimState), version: row.version } : null
}

// Guarda solo si nadie la cambió entretanto (false si hay que recargar y repetir)
async function saveAccount(db: D1, player: number, engine: Engine, version: number, prices: Partial<Record<Symbol, number>>, now: number) {
	if (Object.keys(prices).length) engine.state.marks = { ...engine.state.marks, ...prices }
	engine.state.season ??= season(now).id
	const acc = engine.account(prices)
	const r = await db
		.prepare('UPDATE sim_accounts SET state = ?, equity = ?, pnl_pct = ?, trades = ?, open_orders = ?, checked_at = ?, updated_at = ?, season = ?, benched = ?, version = version + 1 WHERE player = ? AND version = ?')
		.bind(JSON.stringify(engine.state), acc.equity, acc.pnlPct, engine.state.tradeCount, engine.openOrders().length, engine.state.checkedAt, now, engine.state.season ?? '', engine.state.benched ? 1 : 0, player, version)
		.run()
	return (r.meta?.changes ?? 0) > 0
}

async function createAccount(db: D1, player: number, now: number) {
	const s = freshState(now, undefined, season(now).id)
	await db
		.prepare('INSERT OR IGNORE INTO sim_accounts (player, state, equity, pnl_pct, trades, open_orders, checked_at, updated_at, version, season, benched) VALUES (?, ?, ?, 0, 0, 0, ?, ?, 0, ?, 0)')
		.bind(player, JSON.stringify(s), s.startBalance, now, now, s.season)
		.run()
}

const displayName = (u: { first_name: string | null; username: string | null }) => (u.username ? `@${u.username}` : (u.first_name ?? 'Jugador'))
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
		const { results } = await db.prepare('SELECT player, state FROM sim_accounts WHERE season = ?').bind(cur.id).all<{ player: number; state: string }>()
		const stmt = db.prepare('UPDATE sim_accounts SET state = ? WHERE player = ?')
		const fixes = results.map((r) => stmt.bind(JSON.stringify({ ...(JSON.parse(r.state) as SimState), season: cur.id }), r.player))
		for (let i = 0; i < fixes.length; i += 50) await db.batch(fixes.slice(i, i + 50))
		return false
	}
	const claim = await db.prepare("UPDATE sim_meta SET value = ? WHERE key = 'season' AND value = ?").bind(cur.id, meta.value).run()
	if (!claim.meta?.changes) return false
	const prev = meta.value
	const prices = await getPrices().catch(() => ({}))
	const { results } = await db
		.prepare(
			`SELECT a.player, a.state, a.trades, u.first_name, u.username FROM sim_accounts a JOIN sim_players u ON u.id = a.player
			  WHERE a.season = ? AND a.benched = 0 AND a.trades >= ? AND ${COMPETES}`,
		)
		.bind(prev, MIN_TRADES)
		.all<{ player: number; state: string; trades: number; first_name: string | null; username: string | null }>()
	const standings = results
		.map((r) => ({ ...new Engine(JSON.parse(r.state) as SimState).account(prices), player: r.player, name: displayName(r) }))
		.sort((a, b) => b.pnlPct - a.pnlPct)
	const ins = db.prepare('INSERT OR REPLACE INTO sim_results (season, rank, player, name, pnl_pct, equity, trades) VALUES (?, ?, ?, ?, ?, ?, ?)')
	const rows = standings.map((x, i) => ins.bind(prev, i + 1, x.player, x.name, x.pnlPct, x.equity, x.trades))
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
		`🏆 <b>Terminal Trading: temporada del ${dayEs(start)} al ${dayEs(start + 6 * DAY_MS)}</b>`,
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
async function withAccount<T>(db: D1, player: number, fn: (e: Engine, prices: Partial<Record<Symbol, Quote>>) => T | Promise<T>, symbol?: Symbol): Promise<{ result: T; engine: Engine; prices: Partial<Record<Symbol, Quote>> }> {
	for (let attempt = 0; attempt < 3; attempt++) {
		const now = Date.now()
		let acc = await loadAccount(db, player)
		// Si empezó una temporada y el cron aún no la abrió, se abre ahora (y se lee la cuenta ya al día)
		if (acc && acc.engine.state.season !== season(now).id) {
			await rollover(db, now)
			acc = await loadAccount(db, player)
		}
		if (!acc) {
			await createAccount(db, player, now)
			acc = await loadAccount(db, player)
		}
		const prices = await quotes(needed(acc!.engine, symbol))
		await catchUp(acc!.engine, now)
		const result = await fn(acc!.engine, prices)
		if (await saveAccount(db, player, acc!.engine, acc!.version, mids(prices), now)) return { result, engine: acc!.engine, prices }
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
	const { results } = await db.prepare('SELECT player, state, version FROM sim_accounts WHERE open_orders > 0 LIMIT 500').all<Row & { player: number }>()
	const cache = new Map<string, Candle[]>()
	const engines = results.map((r) => ({ id: r.player, version: r.version, engine: new Engine(JSON.parse(r.state) as SimState) }))
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
	const { results: all } = await db.prepare('SELECT player, state FROM sim_accounts WHERE trades > 0').all<{ player: number; state: string }>()
	const stmt = db.prepare('UPDATE sim_accounts SET equity = ?, pnl_pct = ? WHERE player = ?')
	const updates = all.map((r) => {
		const a = new Engine(JSON.parse(r.state) as SimState).account(prices)
		return stmt.bind(a.equity, a.pnlPct, r.player)
	})
	for (let i = 0; i < updates.length; i += 50) await db.batch(updates.slice(i, i + 50))
}

// ── Jugadores: la sesión del terminal y Telegram para el ranking ─────

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

// Quién juega con esta huella del terminal. Con licencia (aunque haya vencido), la cuenta va con su dueño:
// la misma en todos sus dispositivos, y sigue al pasar del mes gratis al plan de pago. Sin licencia, con la
// huella; al hacerse Pro, esa cuenta pasa al dueño de la licencia con su saldo y su historial
export async function playerOf(db: D1, print: string, now: number) {
	const lic = await db
		.prepare('SELECT l.username FROM pro_prints p JOIN pro_licenses l ON l.uuid = p.license WHERE p.print = ?')
		.bind(print)
		.first<{ username: string }>()
	const userKey = lic ? `user:${lic.username.toLowerCase()}` : null
	const printKey = `print:${print}`
	const find = (key: string) => db.prepare('SELECT player FROM sim_ids WHERE key = ?').bind(key).first<{ player: number }>()
	let id = (userKey && (await find(userKey))?.player) || null
	if (!id) {
		const free = await find(printKey)
		if (free && userKey) await db.prepare('UPDATE sim_ids SET key = ? WHERE key = ?').bind(userKey, printKey).run()
		id = free?.player ?? null
	}
	if (!id) {
		const row = await db.prepare('INSERT INTO sim_players (created_at, last_seen) VALUES (?, ?) RETURNING id').bind(now, now).first<{ id: number }>()
		id = row!.id
		await db.prepare('INSERT INTO sim_ids (key, player) VALUES (?, ?)').bind(userKey ?? printKey, id).run()
	}
	return id
}


// Vincula tu Telegram (para el ranking). Si ese Telegram estaba en otra cuenta del simulador, sale de ella
async function linkTelegram(db: D1, player: number, user: TgUser) {
	await db.prepare('UPDATE sim_players SET tg_id = NULL, compete = 0 WHERE tg_id = ? AND id <> ?').bind(user.id, player).run()
	await db
		.prepare('UPDATE sim_players SET tg_id = ?, first_name = ?, username = ?, photo_url = ? WHERE id = ?')
		.bind(user.id, user.first_name, user.username ?? null, user.photo_url ?? null, player)
		.run()
}

// Apuntarse cuando ya operaste esta semana cuenta desde el lunes: nadie juega oculto y se apunta solo cuando
// le va bien. Salir es inmediato
async function setCompete(db: D1, player: number, on: boolean) {
	let startsMonday = false
	if (on) {
		const { engine } = await withAccount(db, player, (e) => {
			if (e.state.tradeCount > 0 && !e.state.benched) e.state.benched = true
		})
		startsMonday = !!engine.state.benched
	}
	await db.prepare('UPDATE sim_players SET compete = ? WHERE id = ?').bind(on ? 1 : 0, player).run()
	return startsMonday
}

// ── Rutas (/api/* en sim.terminalp2p.com) ─────────────────────────────

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
	new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers } })

const isDev = (env: SimEnv, url: URL) => env.SIM_DEV_LOGIN === '1' && (url.hostname.endsWith('.localhost') || url.hostname === 'localhost')
// Huella fija del jugador de desarrollo
const DEV_PRINT = '0'.repeat(63) + '1'

// Los usuarios regulares operan BTC y ETH; los Pro, todos los mercados. Fuera de estos, se puede seguir
// vendiendo lo que ya tienes (o recomprando un corto), nunca abrir posición
export const FREE_MARKETS = new Set<Symbol>(['BTCUSDT', 'ETHUSDT'])

// ¿Puede poner esta orden? Comprobado en el servidor: no se puede saltar desde la página
export const canTrade = (pro: boolean, symbol: Symbol, side: string) => pro || FREE_MARKETS.has(symbol) || side === 'SELL' || side === 'COVER'

export async function simApi(req: Request, url: URL, env: SimEnv): Promise<Response> {
	const route = `${req.method} ${url.pathname}`
	if (!env.PRO_KEY) return json(503, { error: 'El simulador aún no está configurado' })
	// Las escrituras solo desde nuestra propia página
	if (req.method !== 'GET' && req.headers.get('origin') !== url.origin) return json(403, { error: 'Origen no permitido' })
	try {
		if (route === 'GET /api/config') return json(200, { bot: env.SIM_BOT ?? 'terminalp2p_bot', dev: isDev(env, url), markets: SYMBOLS.map((s) => ({ symbol: s, ...MARKETS[s], free: FREE_MARKETS.has(s) })) })
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
		if (route === 'GET /api/auth/dev' && isDev(env, url))
			return new Response(null, { status: 302, headers: { Location: '/', 'Set-Cookie': sessionCookie(url, await sessionToken(DEV_PRINT, env.PRO_KEY)) } })

		const now = Date.now()
		const print = await readSession(req.headers.get('cookie'), env.PRO_KEY, now)
		const player = print ? await playerOf(env.DB, print, now) : null
		if (route === 'GET /api/ranking') return json(200, await ranking(env.DB, player))
		if (route === 'GET /api/me') {
			if (!player || !print) return json(200, { player: null, pro: null })
			await env.DB.prepare('UPDATE sim_players SET last_seen = ? WHERE id = ?').bind(now, player).run()
			const u = await env.DB.prepare('SELECT tg_id, first_name, username, photo_url, compete FROM sim_players WHERE id = ?')
				.bind(player)
				.first<{ tg_id: number | null; first_name: string | null; username: string | null; photo_url: string | null; compete: number }>()
			const l = await licenseOfPrint(env.DB, print, now)
			return json(200, {
				player: { id: player, compete: !!u?.compete && !!u.tg_id, telegram: u?.tg_id ? { first_name: u.first_name, username: u.username, photo_url: u.photo_url } : null },
				pro: l ? { username: l.username, plan: l.plan, expiresAt: l.expires_at } : null,
			})
		}
		if (!player || !print) return json(401, { error: 'Conecta tu cuenta en Terminal P2P para jugar' })
		// Telegram vuelve aquí con sus datos firmados: se vincula y ya compites
		if (route === 'GET /api/auth/telegram') {
			if (!env.TELEGRAM_BOT_TOKEN) return json(503, { error: 'Falta configurar el bot de Telegram' })
			const user = await verifyTelegram(url.searchParams, env.TELEGRAM_BOT_TOKEN)
			if (!user) return new Response('No se pudo comprobar tu Telegram. Vuelve a intentarlo.', { status: 401 })
			await linkTelegram(env.DB, player, user)
			const monday = await setCompete(env.DB, player, true)
			return new Response(null, { status: 302, headers: { Location: `/?ranking=${monday ? 'lunes' : 'ya'}` } })
		}
		if (route === 'POST /api/telegram/unlink') {
			await env.DB.prepare('UPDATE sim_players SET tg_id = NULL, first_name = NULL, username = NULL, photo_url = NULL, compete = 0 WHERE id = ?').bind(player).run()
			return json(200, { ok: true, ranking: await ranking(env.DB, player) })
		}
		if (route === 'GET /api/state') {
			const { engine, prices } = await withAccount(env.DB, player, () => null)
			return json(200, view(engine, prices))
		}
		if (route === 'POST /api/orders') {
			const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
			const symbol = normSymbol(body.symbol)
			if (!canTrade(!!(await licenseOfPrint(env.DB, print, now)), symbol, String(body.side ?? '').toUpperCase()))
				return json(403, { error: `${MARKETS[symbol].base} es un mercado Pro. Sin Pro operas BTC y ETH; con Pro, todos.`, pro: true })
			const { result, engine, prices } = await withAccount(env.DB, player, (e, qs) => {
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
			const acc = await loadAccount(env.DB, player)
			const o = acc?.engine.openOrders().find((x) => x.id === Number(edit[1]))
			if (!o) throw new SimError('Esa orden ya no está abierta')
			const { result, engine, prices } = await withAccount(
				env.DB,
				player,
				(e, qs) => {
					const q = qs[o.symbol]
					if (!q) throw new SimError('Aún no hay precio para este mercado')
					return e.modifyOrder(Number(edit[1]), { price: num(body.price), stopPrice: num(body.stopPrice) }, q)
				},
				o.symbol,
			)
			return json(200, { order: result, ...view(engine, prices) })
		}
		if (route === 'POST /api/close') {
			const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
			const symbol = normSymbol(body.symbol)
			const { result, engine, prices } = await withAccount(
				env.DB,
				player,
				(e, qs) => {
					const q = qs[symbol]
					if (!q) throw new SimError('Aún no hay precio para este mercado')
					return e.closePosition(symbol, q)
				},
				symbol,
			)
			return json(200, { order: result, ...view(engine, prices) })
		}
		if (route === 'DELETE /api/orders') {
			const symbol = url.searchParams.get('symbol') ? normSymbol(url.searchParams.get('symbol')) : undefined
			const { result, engine, prices } = await withAccount(env.DB, player, (e) => e.cancelAll(symbol))
			return json(200, { canceled: result, ...view(engine, prices) })
		}
		const cancel = /^DELETE \/api\/orders\/(\d+)$/.exec(route)
		if (cancel) {
			const { engine, prices } = await withAccount(env.DB, player, (e) => e.cancelOrder(Number(cancel[1])))
			return json(200, view(engine, prices))
		}
		if (route === 'POST /api/compete') {
			const on = ((await req.json().catch(() => ({}))) as { on?: unknown }).on === true
			if (on && !(await env.DB.prepare('SELECT tg_id FROM sim_players WHERE id = ?').bind(player).first<{ tg_id: number | null }>())?.tg_id)
				return json(400, { error: 'Vincula tu Telegram para salir en el ranking' })
			const startsMonday = await setCompete(env.DB, player, on)
			return json(200, { compete: on, startsMonday, ranking: await ranking(env.DB, player) })
		}
		if (route === 'POST /api/reset') {
			// Una cuenta nueva no tiene posiciones ni órdenes: no hace falta ningún precio. Quien reinicia
			// después de operar en la temporada no compite hasta la siguiente
			const acc = await loadAccount(env.DB, player)
			const prev = acc?.engine.state
			const cur = season(now).id
			const benched = prev?.season === cur && (prev.benched || prev.tradeCount > 0)
			const engine = new Engine(freshState(now, undefined, cur, !!benched))
			if (!acc) await createAccount(env.DB, player, now)
			else if (!(await saveAccount(env.DB, player, engine, acc.version, {}, now))) throw new SimError('La cuenta está ocupada; inténtalo de nuevo')
			return json(200, view(engine, {}))
		}
		return json(404, { error: 'Ruta desconocida' })
	} catch (err) {
		if (err instanceof SimError) return json(400, { error: err.message })
		if (err instanceof ProError) return json(err.status, { error: err.message })
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
			`SELECT a.player, a.equity, a.pnl_pct, a.trades, u.first_name, u.username FROM sim_accounts a JOIN sim_players u ON u.id = a.player
			  WHERE a.season = ? AND a.benched = 0 AND a.trades >= ? AND ${COMPETES} ORDER BY a.pnl_pct DESC LIMIT ?`,
		)
		.bind(cur.id, MIN_TRADES, RANKING_SIZE)
		.all<{ player: number; equity: number; pnl_pct: number; trades: number; first_name: string | null; username: string | null }>()
	const rows = results.map((r, i) => ({ rank: i + 1, name: displayName(r), equity: r.equity, pnlPct: r.pnl_pct, trades: r.trades, me: r.player === me }))
	let mine: { rank: number | null; equity: number; pnlPct: number; trades: number; benched: boolean; compete: boolean } | null = null
	if (me) {
		const a = await db
			.prepare('SELECT a.pnl_pct, a.equity, a.trades, a.benched, a.season, u.compete, u.tg_id FROM sim_accounts a JOIN sim_players u ON u.id = a.player WHERE a.player = ?')
			.bind(me)
			.first<{ pnl_pct: number; equity: number; trades: number; benched: number; season: string; compete: number; tg_id: number | null }>()
		if (a && a.season === cur.id) {
			const competes = !!a.compete && !!a.tg_id
			const eligible = competes && !a.benched && a.trades >= MIN_TRADES
			const above = eligible
				? await db
						.prepare(`SELECT COUNT(*) AS n FROM sim_accounts a JOIN sim_players u ON u.id = a.player WHERE a.season = ? AND a.benched = 0 AND a.trades >= ? AND ${COMPETES} AND a.pnl_pct > ?`)
						.bind(cur.id, MIN_TRADES, a.pnl_pct)
						.first<{ n: number }>()
				: null
			mine = { rank: eligible ? (above?.n ?? 0) + 1 : null, equity: a.equity, pnlPct: a.pnl_pct, trades: a.trades, benched: !!a.benched, compete: competes }
		}
	}
	const last = await db.prepare("SELECT season FROM sim_results WHERE season < ? ORDER BY season DESC LIMIT 1").bind(cur.id).first<{ season: string }>()
	const podium = last
		? (await db.prepare('SELECT rank, player, name, pnl_pct, trades FROM sim_results WHERE season = ? ORDER BY rank LIMIT ?').bind(last.season, SUMMARY_SIZE).all<{ rank: number; player: number; name: string; pnl_pct: number; trades: number }>()).results
		: []
	const { results: fame } = await db
		.prepare(
			`SELECT player, SUM(rank = 1) AS wins, SUM(rank <= 3) AS podiums, (SELECT name FROM sim_results r2 WHERE r2.player = r.player ORDER BY season DESC LIMIT 1) AS name
			   FROM sim_results r WHERE rank <= 3 GROUP BY player ORDER BY wins DESC, podiums DESC LIMIT 20`,
		)
		.all<{ player: number; wins: number; podiums: number; name: string }>()
	return {
		season: cur,
		minTrades: MIN_TRADES,
		rows,
		mine,
		last: last ? { season: last.season, rows: podium.map((r) => ({ rank: r.rank, name: r.name, pnlPct: r.pnl_pct, trades: r.trades, me: r.player === me })) } : null,
		fame: fame.map((f) => ({ name: f.name, wins: f.wins, podiums: f.podiums, me: f.player === me })),
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

const html = (body: string, status = 200) => adminPage('sim', 'Simulador', body, status)

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
	if (!(await authorized(req, env.METRICS_KEY))) return askKey()
	const row = await env.DB.prepare("SELECT value FROM sim_meta WHERE key = 'draft'").first<{ value: string }>()
	const draft = row ? (JSON.parse(row.value) as Draft) : null

	if (req.method === 'POST' && url.pathname === '/admin/sim/publish') {
		if (req.headers.get('origin') !== url.origin) return new Response('Origen no permitido', { status: 403 })
		if (!draft) return html('<p>No hay ningún resumen pendiente.</p>', 400)
		if (draft.posted) return Response.redirect(`${url.origin}/admin/sim?ya=1`, 303)
		if (!env.TELEGRAM_BOT_TOKEN) return html('<p>Falta el token del bot.</p>', 503)
		const text = String((await req.formData()).get('text') ?? '').trim().slice(0, 4000) || draft.text
		try {
			await sendTelegram(env.TELEGRAM_BOT_TOKEN, env.SIM_CHANNEL ?? '@terminalp2p', text)
		} catch (e) {
			return html(`<h1>No se publicó</h1><p>${escHtml((e as Error).message)}</p><p><a href="/admin/sim">Volver</a></p>`, 502)
		}
		await env.DB.prepare("UPDATE sim_meta SET value = ? WHERE key = 'draft'").bind(JSON.stringify({ ...draft, text, posted: true, postedAt: Date.now() })).run()
		return Response.redirect(`${url.origin}/admin/sim?ok=1`, 303)
	}
	if (url.pathname !== '/admin/sim') return new Response('no encontrado', { status: 404 })

	// Clasificación provisional de la temporada en curso
	const cur = season()
	const { results } = await env.DB.prepare(
		`SELECT a.pnl_pct, a.trades, u.first_name, u.username FROM sim_accounts a JOIN sim_players u ON u.id = a.player
		  WHERE a.season = ? AND a.benched = 0 AND a.trades >= ? AND ${COMPETES} ORDER BY a.pnl_pct DESC LIMIT 10`,
	)
		.bind(cur.id, MIN_TRADES)
		.all<{ pnl_pct: number; trades: number; first_name: string | null; username: string | null }>()
	const notice = url.searchParams.has('ok') ? '<p class="ok">Publicado en el grupo de Telegram.</p>' : url.searchParams.has('ya') ? '<p class="ok">Ese resumen ya estaba publicado.</p>' : ''
	const draftBlock = !draft
		? '<p class="note">Aún no ha terminado ninguna temporada. El borrador aparece aquí el lunes a las 00:00 (hora de Cuba).</p>'
		: draft.posted
			? `<p class="note">El resumen de la temporada del ${seasonDay(draft.season)} se publicó el ${new Date(draft.postedAt ?? 0).toLocaleString('es')}.</p><textarea readonly>${escHtml(draft.text)}</textarea>`
			: `<p class="note">Temporada del ${seasonDay(draft.season)}. Puedes editar el texto (HTML de Telegram: &lt;b&gt;, &lt;i&gt;) antes de publicarlo.</p>
				<form method="post" action="/admin/sim/publish"><textarea name="text">${escHtml(draft.text)}</textarea><button type="submit">Publicar en ${escHtml(env.SIM_CHANNEL ?? '@terminalp2p')}</button></form>`
	return html(`<h1>Resumen semanal del simulador</h1><p class="note">Temporada en curso: ${dayEs(cur.start)} – ${dayEs(cur.end - 1)} (termina el lunes a las 00:00, hora de Cuba)</p>${notice}
		<h2>Resumen pendiente</h2>${draftBlock}
		<h2>Clasificación provisional de esta semana</h2>${
			results.length
				? `<div class="wrap"><table class="left"><thead><tr><th>#</th><th>Jugador</th><th>Rentabilidad</th><th>Operaciones</th></tr></thead><tbody>${results
						.map((r, i) => `<tr><td>${i + 1}</td><td>${escHtml(displayName(r))}</td><td>${pctEs(r.pnl_pct)}</td><td>${r.trades}</td></tr>`)
						.join('')}</tbody></table></div>`
				: `<p class="note">Nadie lleva aún ${MIN_TRADES} operaciones esta semana.</p>`
		}`)
}
