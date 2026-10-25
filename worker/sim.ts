// Simulador de trading en sim.terminalp2p.com: dinero ficticio, precios reales (de MEXC).
//
//   · Sin login propio: la sesión viene del terminal (cookie del dominio con la huella del token, ver
//     worker/session.ts) y la cuenta va con tu licencia Pro o con esa huella. Pro se hereda en vivo.
//   · Sin ranking por ahora (y sin temporadas: nadie pierde su cuenta cada lunes). Volverá cuando se vea
//     que el simulador se usa; el anterior, con Telegram, está en el historial de git.
//   · La cuenta de cada jugador (src/sim/engine.ts) vive en D1 como un JSON con control de versión.
//   · Las órdenes a mercado se ejecutan con el bid/ask del momento. Las pendientes (límite, stop, OCO)
//     se revisan con las velas de 1 minuto: cada minuto en el cron y cada vez que el jugador abre su
//     cuenta. Así se ejecutan aunque nadie tenga la pantalla abierta. Precios: ver «Precios» abajo.

import { Engine, freshState, MARKETS, normSymbol, SimError, SYMBOLS, type Candle, type Quote, type SimState, type Symbol } from '../src/sim/engine.ts'
import { licenseOfPrint, ProError, type ProEnv } from './pro.ts'
import { readSession, sessionCookie, sessionToken } from './session.ts'
import type { D1 } from './rates.ts'

export interface SimEnv extends Omit<ProEnv, 'DB'> {
	DB: D1
	// Solo en desarrollo (.dev.vars): entrar sin el terminal (la cookie del terminal no cruza a sim.localhost)
	SIM_DEV_LOGIN?: string
}

// Binance no responde a las peticiones que salen de Cloudflare (bloquea su región: 451 y 403), así que
// el servidor toma los precios de MEXC, que usa la misma API que Binance y sigue su precio casi al
// céntimo. La pantalla también los pide aquí (ver «Precios para la pantalla»). (Binance.US sí responde, pero sus mercados pequeños
// casi no tienen actividad: el oro, PAXG, estaba un 10 % desfasado)
const MEXC = 'https://api.mexc.com/api/v3'
const sourceOf = (_symbol: Symbol) => MEXC
// Velas de 1 minuto (las más finas que dan esas fuentes) y cuántas por petición
export const CANDLE_MS = 60_000
const KLINE_LIMIT = 1000
// Se espera un poco tras el cierre de cada vela para que la fuente la tenga completa
const CLOSE_DELAY_MS = 1500
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
	
	const acc = engine.account(prices)
	const r = await db
		.prepare('UPDATE sim_accounts SET state = ?, equity = ?, pnl_pct = ?, trades = ?, open_orders = ?, checked_at = ?, updated_at = ?, version = version + 1 WHERE player = ? AND version = ?')
		.bind(JSON.stringify(engine.state), acc.equity, acc.pnlPct, engine.state.tradeCount, engine.openOrders().length, engine.state.checkedAt, now, player, version)
		.run()
	return (r.meta?.changes ?? 0) > 0
}

async function createAccount(db: D1, player: number, now: number) {
	const s = freshState(now)
	await db
		.prepare('INSERT OR IGNORE INTO sim_accounts (player, state, equity, pnl_pct, trades, open_orders, checked_at, updated_at, version) VALUES (?, ?, ?, 0, 0, 0, ?, ?, 0)')
		.bind(player, JSON.stringify(s), s.startBalance, now, now)
		.run()
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

// ── Cron: cada minuto, las cuentas con órdenes abiertas ──────────────

export async function simCron(db: D1, now: number) {
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
	const prices = engines.length ? mids(await quotes()) : {}
	for (const { id, version, engine } of engines) {
		await catchUp(engine, now, async (s) => cache.get(s) ?? [])
		await saveAccount(db, id, engine, version, prices, now) // si alguien la tocaba a la vez, la revisa su petición
	}
}

// ── Jugadores: la sesión del terminal ─────────────────────────────────

// Quién juega con esta huella del terminal. Con licencia (aunque haya vencido), la cuenta va con su dueño:
// la misma en todos sus dispositivos, y sigue al pasar de los días gratis a los comprados. Sin licencia, con la
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
		if (route === 'GET /api/config') return json(200, { dev: isDev(env, url), markets: SYMBOLS.map((s) => ({ symbol: s, ...MARKETS[s], free: FREE_MARKETS.has(s) })) })
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
		
		if (route === 'GET /api/me') {
			if (!player || !print) return json(200, { player: null, pro: null })
			await env.DB.prepare('UPDATE sim_players SET last_seen = ? WHERE id = ?').bind(now, player).run()
			const l = await licenseOfPrint(env.DB, print, now)
			return json(200, { player: { id: player }, pro: l ? { username: l.username, plan: l.plan, expiresAt: l.expires_at } : null })
		}
		if (!player || !print) return json(401, { error: 'Conecta tu cuenta en Terminal P2P para jugar' })
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
		if (route === 'POST /api/reset') {
			// Una cuenta nueva no tiene posiciones ni órdenes: no hace falta ningún precio
			const acc = await loadAccount(env.DB, player)
			const engine = new Engine(freshState(now))
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
