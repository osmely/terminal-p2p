// Simulador de trading en sim.terminalp2p.com: dinero ficticio, precios reales de Binance.
//
//   · Se entra con el botón oficial de Telegram: se comprueba su firma con el token del bot y se
//     guarda una cookie firmada. De cada jugador solo se guarda lo que da Telegram al entrar.
//   · La cuenta de cada jugador (src/sim/engine.ts) vive en D1 como un JSON con control de versión.
//   · Las órdenes a mercado se ejecutan con el bid/ask de Binance del momento. Las pendientes
//     (límite, stop, OCO) se revisan con las velas de 1 s de Binance: cada minuto en el cron y
//     cada vez que el jugador abre su cuenta. Así se ejecutan aunque nadie tenga la pantalla abierta.

import { Engine, freshState, MARKETS, normSymbol, SimError, SYMBOLS, type Candle, type Quote, type SimState, type Symbol } from '../src/sim/engine.ts'
import type { D1 } from './rates.ts'

export interface SimEnv {
	DB: D1
	TELEGRAM_BOT_TOKEN?: string
	SIM_SESSION_KEY?: string
	// Nombre del bot del botón de Telegram (sin @)
	SIM_BOT?: string
	// Solo en desarrollo (.dev.vars): entrar sin Telegram, que no funciona en localhost
	SIM_DEV_LOGIN?: string
}

const BINANCE = 'https://data-api.binance.vision/api/v3'
const COOKIE = 'tps'
const SESSION_DAYS = 30
// La firma del botón de Telegram vale un día
const AUTH_MAX_AGE_S = 86_400
// Velas de 1 s por petición (Binance da hasta 1000) y cuánto se pide al segundo antes de usar velas de 1 min
const KLINE_LIMIT = 1000
const FINE_WINDOW_MS = 15 * 60_000
// Las velas se cierran al terminar su segundo: se espera un poco para que estén completas
const CLOSE_DELAY_MS = 1500
const RANKING_SIZE = 50

// ── Binance ───────────────────────────────────────────────────────────

async function binance<T>(path: string): Promise<T> {
	const res = await fetch(`${BINANCE}${path}`, { headers: { Accept: 'application/json' } })
	if (!res.ok) throw new SimError(`Binance no responde ahora mismo (${res.status}); inténtalo en unos segundos`)
	return res.json() as Promise<T>
}

export async function quotes(symbols: readonly Symbol[] = SYMBOLS): Promise<Partial<Record<Symbol, Quote>>> {
	const rows = await binance<{ symbol: string; bidPrice: string; askPrice: string }[]>(`/ticker/bookTicker?symbols=${encodeURIComponent(JSON.stringify(symbols))}`)
	return Object.fromEntries(rows.map((r) => [r.symbol, { bid: +r.bidPrice, ask: +r.askPrice }]))
}

const mids = (qs: Partial<Record<Symbol, Quote>>) => Object.fromEntries(Object.entries(qs).map(([s, q]) => [s, (q!.bid + q!.ask) / 2])) as Partial<Record<Symbol, number>>

async function klines(symbol: Symbol, interval: '1s' | '1m', from: number, to: number): Promise<Candle[]> {
	const out: Candle[] = []
	const step = interval === '1s' ? 1000 : 60_000
	let start = from
	while (start <= to) {
		const rows = await binance<[number, string, string, string, string][]>(`/klines?symbol=${symbol}&interval=${interval}&startTime=${start}&endTime=${to}&limit=${KLINE_LIMIT}`)
		for (const r of rows) out.push({ t: r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4] })
		if (rows.length < KLINE_LIMIT) break
		start = rows[rows.length - 1][0] + step
	}
	return out
}

// Velas cerradas entre from y to: al segundo los últimos 15 min y, si el hueco es mayor, al minuto antes
export async function candles(symbol: Symbol, from: number, to: number): Promise<Candle[]> {
	if (to < from) return []
	const fineFrom = Math.max(from, to - FINE_WINDOW_MS)
	const coarse = fineFrom > from ? await klines(symbol, '1m', from, fineFrom - 1) : []
	// Un minuto que empieza antes de fineFrom y termina después se queda fuera: lo cubren las de 1 s
	return [...coarse.filter((c) => c.t + 60_000 <= fineFrom), ...(await klines(symbol, '1s', fineFrom, to))]
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
	const acc = engine.account(prices)
	const r = await db
		.prepare('UPDATE sim_accounts SET state = ?, equity = ?, pnl_pct = ?, trades = ?, open_orders = ?, checked_at = ?, updated_at = ?, version = version + 1 WHERE tg_id = ? AND version = ?')
		.bind(JSON.stringify(engine.state), acc.equity, acc.pnlPct, engine.state.tradeCount, engine.openOrders().length, engine.state.checkedAt, now, tgId, version)
		.run()
	return (r.meta?.changes ?? 0) > 0
}

async function createAccount(db: D1, tgId: number, now: number) {
	const s = freshState(now)
	await db
		.prepare('INSERT OR IGNORE INTO sim_accounts (tg_id, state, equity, pnl_pct, trades, open_orders, checked_at, updated_at, version) VALUES (?, ?, ?, 0, 0, 0, ?, ?, 0)')
		.bind(tgId, JSON.stringify(s), s.startBalance, now, now)
		.run()
}

// Revisa las órdenes pendientes con las velas cerradas desde la última revisión
export async function catchUp(engine: Engine, now: number, fetchCandles: (s: Symbol, from: number, to: number) => Promise<Candle[]> = candles) {
	const to = now - CLOSE_DELAY_MS
	const open = engine.openOrders()
	for (const symbol of new Set(open.map((o) => o.symbol))) {
		const first = Math.min(...open.filter((o) => o.symbol === symbol).map((o) => o.createdAt))
		const from = Math.floor(Math.max(engine.state.checkedAt, first) / 1000) * 1000
		const cs = (await fetchCandles(symbol, from, to)).filter((c) => c.t >= from && c.t + 1000 <= now)
		engine.replay(symbol, cs)
	}
	engine.state.checkedAt = Math.max(engine.state.checkedAt, to)
}

// Carga, aplica un cambio y guarda; si otra petición la cambió a la vez, lo repite con la versión nueva
async function withAccount<T>(db: D1, tgId: number, fn: (e: Engine, prices: Partial<Record<Symbol, Quote>>) => T | Promise<T>): Promise<{ result: T; engine: Engine; prices: Partial<Record<Symbol, Quote>> }> {
	for (let attempt = 0; attempt < 3; attempt++) {
		const now = Date.now()
		let acc = await loadAccount(db, tgId)
		if (!acc) {
			await createAccount(db, tgId, now)
			acc = await loadAccount(db, tgId)
		}
		const prices = await quotes()
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
	const { results } = await db.prepare('SELECT tg_id, state, version FROM sim_accounts WHERE open_orders > 0 LIMIT 500').all<Row & { tg_id: number }>()
	const cache = new Map<string, Candle[]>()
	const engines = results.map((r) => ({ id: r.tg_id, version: r.version, engine: new Engine(JSON.parse(r.state) as SimState) }))
	// Una sola petición de velas por mercado para todas las cuentas
	const ranges = new Map<Symbol, number>()
	for (const { engine } of engines)
		for (const o of engine.openOrders()) {
			const from = Math.floor(Math.max(engine.state.checkedAt, o.createdAt) / 1000) * 1000
			ranges.set(o.symbol, Math.min(ranges.get(o.symbol) ?? Infinity, from))
		}
	for (const [symbol, from] of ranges) cache.set(symbol, await candles(symbol, from, now - CLOSE_DELAY_MS).catch(() => []))
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
			const user = tgId ? await env.DB.prepare('SELECT tg_id AS id, first_name, username, photo_url FROM sim_users WHERE tg_id = ?').bind(tgId).first() : null
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
			})
			return json(200, { order: result, ...view(engine, prices) })
		}
		const cancel = /^DELETE \/api\/orders\/(\d+)$/.exec(route)
		if (cancel) {
			const { engine, prices } = await withAccount(env.DB, tgId, (e) => e.cancelOrder(Number(cancel[1])))
			return json(200, view(engine, prices))
		}
		if (route === 'POST /api/reset') {
			const { engine, prices } = await withAccount(env.DB, tgId, (e) => {
				e.state = freshState(Date.now())
			})
			return json(200, view(engine, prices))
		}
		return json(404, { error: 'Ruta desconocida' })
	} catch (err) {
		if (err instanceof SimError) return json(400, { error: err.message })
		console.error(`simulador ${route}: ${(err as Error).message}`)
		return json(500, { error: 'Algo falló en el simulador; inténtalo de nuevo' })
	}
}

const num = (v: unknown) => (v == null || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null)

// Ranking por rentabilidad de quien ha operado al menos una vez, y tu puesto
async function ranking(db: D1, me: number | null) {
	const { results } = await db
		.prepare(
			`SELECT a.tg_id, a.equity, a.pnl_pct, a.trades, u.first_name, u.username FROM sim_accounts a JOIN sim_users u ON u.tg_id = a.tg_id
			  WHERE a.trades > 0 ORDER BY a.pnl_pct DESC LIMIT ?`,
		)
		.bind(RANKING_SIZE)
		.all<{ tg_id: number; equity: number; pnl_pct: number; trades: number; first_name: string; username: string | null }>()
	const rows = results.map((r, i) => ({ rank: i + 1, name: r.username ? `@${r.username}` : r.first_name, equity: r.equity, pnlPct: r.pnl_pct, trades: r.trades, me: r.tg_id === me }))
	let mine = rows.find((r) => r.me) ?? null
	if (!mine && me) {
		const a = await db.prepare('SELECT pnl_pct, equity, trades FROM sim_accounts WHERE tg_id = ?').bind(me).first<{ pnl_pct: number; equity: number; trades: number }>()
		if (a && a.trades > 0) {
			const above = await db.prepare('SELECT COUNT(*) AS n FROM sim_accounts WHERE trades > 0 AND pnl_pct > ?').bind(a.pnl_pct).first<{ n: number }>()
			mine = { rank: (above?.n ?? 0) + 1, name: 'Tú', equity: a.equity, pnlPct: a.pnl_pct, trades: a.trades, me: true }
		}
	}
	return { rows, mine }
}
