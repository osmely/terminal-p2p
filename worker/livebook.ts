// Libro del P2P desde el servidor (al instante para Pro, cada 10 s para el resto). QvaPay manda cada oferta nueva y
// cada cambio al momento (el feed del mercado, por webhook firmado) y un Durable Object guarda el libro y se lo empuja
// a los terminales conectados por WebSocket. El feed no dice quién publica cada oferta (solo el uuid de su dueño): el nombre, las operaciones y la
// valoración salen de leer el listado del P2P con las credenciales de nuestra app de comerciante (app-id/app-secret,
// las mismas de los cobros de Pro). Sin feed (o si se corta), esas credenciales leen el libro cada pocos segundos.
// Solo ofertas públicas del mercado: nada de ningún usuario del terminal pasa por aquí

import { COINS, toLevel, type Level } from '../src/terminal/market.ts'
import { num, type P2POffer } from '../src/qvapay/types.ts'
import { hex, hmac } from './crypto.ts'
import type { D1 } from './rates.ts'

// Lo que se usa del espacio del Durable Object (así este archivo no depende de los tipos de Cloudflare)
export interface LiveNamespace {
	idFromName(name: string): unknown
	get(id: never): { fetch(input: string, init?: RequestInit): Promise<Response> }
}

export interface LiveEnv {
	DB: D1
	LIVE?: LiveNamespace
	QVAPAY_FEED_SECRET?: string
	// La app de comerciante (ver pro.ts): con ella se lee el listado del P2P
	QVAPAY_APP_ID?: string
	QVAPAY_APP_SECRET?: string
	// Producción le reenvía cada evento a staging tal cual llegó (con su firma): una sola URL y la misma fuente para los dos
	FEED_FORWARD?: string
	// «1»: el libro del servidor llega también sin Pro (cada FREE_EVERY_MS). Si no, solo a los Pro
	LIVE_FREE?: string
	STAGING?: string
}

export type Side = 'ask' | 'bid'
export const TICKS = new Set<string>(COINS.map((c) => c.tick))
export const QVAPAY = 'https://api.qvapay.com'
// Lo que se manda de cada lado: las mejores (como el libro del terminal, que lee 50)
export const SEND_TOP = 60
export const TAKE = 50
// Un evento con la firma de hace más de esto se rechaza (lo pide QvaPay)
const SIGNATURE_MAX_AGE_MS = 5 * 60_000
// Sin eventos en este tiempo, el feed se da por parado y el libro se lee con el token
export const FEED_IDLE_MS = 10 * 60_000
// Con el feed, cada lado se relee de vez en cuando (por si se perdió algún evento y para las reputaciones)
export const RESYNC_MS = 5 * 60_000
// Actividad que se guarda y se manda de cada mercado (la más reciente primero)
export const ACT_KEEP = 40
// Sin Pro, el libro llega cada tanto (con Pro, al instante)
export const FREE_EVERY_MS = 10_000
// Sin el feed, los lados que alguien mira se leen así de seguido
export const POLL_MS = 15_000
export const ALARM_MS = 5_000
// El stream se corta solo cada pocos minutos; aun así, cada conexión dura como mucho esto (un alarm vive 15 min)
export const STREAM_MAX_MS = 10 * 60_000
// Sin nada del stream en este tiempo (ni la señal de vida, que llega cada 25 s), la conexión se dio por colgada
export const STREAM_STALL_MS = 60_000
// Lecturas del libro por minuto con nuestro token (QvaPay deja 25)
export const READS_PER_MIN = 18
// Lo que dura el recuerdo de una oferta que ya salió (para no meterla de nuevo con un evento viejo que llega tarde)
const GONE_KEEP_MS = 24 * 3600_000

export interface FeedEvent {
	event: string
	sent_at?: string
	data: {
		uuid: string
		type: 'buy' | 'sell'
		coin: string
		amount: string
		receive: string
		status: string
		updated_at?: string
		only_vip?: boolean
		offer_kind?: 'fixed' | 'flexible'
		available_amount?: string | null
		order_min?: string | null
		order_max?: string | null
		owner_uuid?: string
		owner_vip?: boolean
		requirements?: Record<string, number> | null
		change?: string | null
	}
}

export interface LiveOffer {
	uuid: string
	coin: string
	side: Side
	price: number
	usd: number
	kind: 'fixed' | 'flexible'
	orderMin: number | null
	orderMax: number | null
	owner: string
	ownerVip: boolean
	onlyVip: boolean
	requirements: Record<string, number> | null
	createdAt: number
	updatedAt: number
}

// Lo que pasó en el libro, para la actividad del terminal
export type ActKind = 'new' | 'reopened' | 'taken' | 'partial' | 'returned' | 'cancelled' | 'edited' | 'done'
export interface Act {
	t: number
	kind: ActKind
	side: Side
	price: number
	usd: number
	// El anunciante: su uuid y, si ya se sabe, su usuario (al mandarlo se completa con lo que se sepa entonces)
	owner: string
	user: string
	uuid: string
}

export interface Applied {
	coin: string
	side: Side
	changed: boolean
	unknownOwner: boolean
	act: Act | null
}

export interface Owner {
	username: string
	ops: number
	rating: number | null
	kyc: boolean
	vip: boolean
	gold: boolean
}

const ts = (v?: string | null) => (v ? Date.parse(v) || 0 : 0)
export const sideKey = (coin: string, side: Side) => `${coin}:${side}`

// ── El libro (sin nada de Cloudflare: se prueba en Node) ─────────────

export class Book {
	offers = new Map<string, LiveOffer>()
	owners = new Map<string, Owner>()
	gone = new Map<string, number>()
	// Lo que cambió desde la última vez que se guardó
	changed = new Set<string>()
	changedOwners = new Set<string>()

	// Un evento del feed. Devuelve el mercado y el lado, si cambió el libro, si su dueño es desconocido y lo que pasó
	// (para la actividad: el feed sí dice si una oferta se tomó o la retiró su dueño). null si no hay nada que contar
	apply(e: FeedEvent, now = Date.now()): Applied | null {
		const d = e?.data
		if (!d?.uuid || !TICKS.has(d.coin) || (d.type !== 'buy' && d.type !== 'sell')) return null
		const side: Side = d.type === 'sell' ? 'ask' : 'bid'
		const at = ts(d.updated_at) || ts(e.sent_at) || now
		const had = this.offers.get(d.uuid)
		// Un evento más viejo que lo que ya sabemos de esa oferta no cambia nada (pueden llegar repetidos o desordenados)
		if (had && at < had.updatedAt) return null
		const gone = this.gone.get(d.uuid)
		if (!had && gone !== undefined && at < gone) return null
		const flexible = d.offer_kind === 'flexible' || e.event.startsWith('p2p.range_')
		const usd = flexible ? num(d.available_amount ?? 0) : num(d.amount)
		const amount = num(d.amount)
		const price = amount > 0 ? num(d.receive) / amount : 0
		const user = this.owners.get(d.owner_uuid ?? '')?.username ?? ''
		const act = (kind: ActKind, actUsd: number, actPrice = price): Act | null =>
			actUsd > 0 && actPrice > 0 ? { t: at, kind, side, price: actPrice, usd: Math.round(actUsd * 100) / 100, owner: d.owner_uuid ?? '', user, uuid: d.uuid } : null
		const out = (changed: boolean, a: Act | null, unknownOwner = false): Applied | null => (changed || a ? { coin: d.coin, side, changed, unknownOwner, act: a } : null)

		// Una operación que se completó: no cambia el libro (la oferta ya había salido al tomarla), pero es un precio real
		if (e.event === 'p2p.completed') return out(false, act('done', amount))
		if (e.event === 'p2p.paid') return null

		const put = (e.event === 'p2p.created' || e.event === 'p2p.reopened' || e.event === 'p2p.range_created' || e.event === 'p2p.range_updated') && d.status === 'open' && usd > 0
		if (put) {
			const o: LiveOffer = {
				uuid: d.uuid,
				coin: d.coin,
				side,
				price,
				usd,
				kind: flexible ? 'flexible' : 'fixed',
				orderMin: flexible && d.order_min != null ? num(d.order_min) : null,
				orderMax: flexible && d.order_max != null ? num(d.order_max) : null,
				owner: d.owner_uuid ?? '',
				ownerVip: !!d.owner_vip,
				onlyVip: !!d.only_vip,
				requirements: d.requirements && Object.keys(d.requirements).length ? d.requirements : null,
				createdAt: had?.createdAt ?? at,
				updatedAt: at,
			}
			if (!(o.price > 0)) return null
			this.offers.set(o.uuid, o)
			this.changed.add(o.uuid)
			this.gone.delete(o.uuid)
			// Qué pasó: nueva, reabierta, o en una de rango, una parte tomada, una parte que volvió o editada
			let a: Act | null
			if (!had) a = act(e.event === 'p2p.reopened' ? 'reopened' : 'new', usd)
			else if (d.change === 'taken' || (d.change == null && usd < had.usd && price === had.price)) a = act('partial', had.usd - usd)
			else if (d.change === 'returned') a = act('returned', usd - had.usd)
			else if (price !== had.price || usd !== had.usd) a = act('edited', usd)
			else a = null
			return out(true, a, !!o.owner && !this.owners.has(o.owner))
		}
		// Sale del libro: tomada entera, cancelada por su dueño o cerrada. Pasar de fija a por rango no es salir
		this.gone.set(d.uuid, at)
		if (had) {
			this.offers.delete(d.uuid)
			this.changed.add(d.uuid)
		}
		const converted = e.event === 'p2p.cancelled' && d.offer_kind === 'flexible' && d.status === 'open'
		const taken = e.event === 'p2p.applied' || (e.event === 'p2p.range_closed' && d.change === 'taken')
		const rest = had?.usd ?? (flexible ? num(d.available_amount ?? 0) || amount : amount)
		return out(!!had, converted ? null : act(taken ? 'taken' : 'cancelled', rest, had?.price ?? price))
	}

	// Una lectura del libro (las mejores TAKE de un lado) con nuestro token: mete o actualiza lo leído, aprende quién
	// es cada dueño y saca lo que debería estar dentro de lo leído y no está (un evento que se perdió)
	merge(coin: string, side: Side, list: P2POffer[], now = Date.now()) {
		const seen = new Set<string>()
		for (const o of list) {
			const u = o.User
			if (u?.uuid) {
				const w: Owner = {
					username: u.username ?? '—',
					ops: (u._count?.P2P ?? 0) + (u._count?.P2P_Peer ?? 0),
					rating: u.rating_count ? (u.rating_avg ?? null) : null,
					kyc: !!u.kyc,
					vip: !!u.vip,
					gold: !!u.golden_check,
				}
				// Solo se apunta (y se guarda) si cambió algo
				if (JSON.stringify(this.owners.get(u.uuid)) !== JSON.stringify(w)) {
					this.owners.set(u.uuid, w)
					this.changedOwners.add(u.uuid)
				}
			}
			const flexible = o.offer_kind === 'flexible'
			const amount = num(o.amount)
			const usd = flexible ? num(o.available_amount) : amount
			if (o.private || !(amount > 0) || !(usd > 0) || (o.status && o.status !== 'open') || o.pause) continue
			seen.add(o.uuid)
			const had = this.offers.get(o.uuid)
			const at = ts(o.updated_at) || ts(o.created_at) || now
			if (had && (had.updatedAt > at || (had.updatedAt === at && had.usd === usd))) continue
			this.changed.add(o.uuid)
			this.offers.set(o.uuid, {
				uuid: o.uuid,
				coin,
				side,
				price: num(o.receive) / amount,
				usd,
				kind: flexible ? 'flexible' : 'fixed',
				orderMin: flexible && o.order_min != null ? num(o.order_min) : null,
				orderMax: flexible && o.order_max != null ? num(o.order_max) : null,
				owner: u?.uuid ?? had?.owner ?? '',
				ownerVip: !!u?.vip,
				onlyVip: !!o.only_vip,
				requirements: o.requirements && Object.keys(o.requirements).length ? o.requirements : null,
				createdAt: ts(o.created_at) || had?.createdAt || at,
				updatedAt: at,
			})
		}
		// Lo leído son las mejores: lo que falta y estaría entre ellas ya no está (si se leyó todo el lado, todo lo que falta)
		const prices = list.filter((o) => seen.has(o.uuid)).map((o) => num(o.receive) / num(o.amount))
		const worst = prices.length ? (side === 'ask' ? Math.max(...prices) : Math.min(...prices)) : null
		const complete = list.length < TAKE
		let removed = 0
		for (const o of [...this.offers.values()]) {
			if (o.coin !== coin || o.side !== side || seen.has(o.uuid)) continue
			const inside = complete || worst === null || (side === 'ask' ? o.price <= worst : o.price >= worst)
			// Una oferta que llegó por el feed hace nada puede no salir aún en el listado
			if (inside && now - o.updatedAt > 30_000) {
				this.offers.delete(o.uuid)
				this.changed.add(o.uuid)
				this.gone.set(o.uuid, now)
				removed++
			}
		}
		return removed
	}

	// Un lado como lo usa el terminal (los mismos campos que su libro), el mejor precio primero
	levels(coin: string, side: Side, top = SEND_TOP): Level[] {
		const list = [...this.offers.values()].filter((o) => o.coin === coin && o.side === side)
		list.sort((a, b) => (side === 'ask' ? a.price - b.price : b.price - a.price) || a.createdAt - b.createdAt)
		return list.slice(0, top).map((o) => {
			const w = this.owners.get(o.owner)
			const level = toLevel(
				{
					uuid: o.uuid,
					type: side === 'ask' ? 'sell' : 'buy',
					coin,
					amount: String(o.usd),
					receive: String(o.price * o.usd),
					available_amount: o.kind === 'flexible' ? String(o.usd) : undefined,
					offer_kind: o.kind,
					order_min: o.orderMin == null ? undefined : String(o.orderMin),
					order_max: o.orderMax == null ? undefined : String(o.orderMax),
					only_vip: o.onlyVip,
					requirements: o.requirements ?? undefined,
					created_at: new Date(o.createdAt).toISOString(),
					updated_at: new Date(o.updatedAt).toISOString(),
					status: 'open',
				} as P2POffer,
				false,
				null,
			)
			// El precio exacto (sin pasar por receive/amount redondeados) y quién es su dueño, si se sabe
			return { ...level, price: o.price, user: w?.username ?? '—', ops: w?.ops ?? 0, rating: w?.rating ?? null, kyc: w?.kyc ?? false, vip: w?.vip ?? o.ownerVip, gold: w?.gold ?? false }
		})
	}

	// La actividad con el usuario de cada anunciante tal como se sabe ahora
	named(acts: Act[]) {
		return acts.map((a) => ({ ...a, user: a.user || this.owners.get(a.owner)?.username || '' }))
	}

	count(coin: string, side: Side) {
		let n = 0
		for (const o of this.offers.values()) if (o.coin === coin && o.side === side) n++
		return n
	}

	prune(now = Date.now()) {
		for (const [k, t] of this.gone) if (now - t > GONE_KEEP_MS) this.gone.delete(k)
	}
}

// ── El stream (SSE) ──────────────────────────────────────────────────

// Lo que va llegando del stream, troceado en eventos. Devuelve los completos y lo que queda a medias para el siguiente trozo
export function sseEvents(buffer: string): { events: { event: string; data: string }[]; rest: string } {
	const text = buffer.replace(/\r\n?/g, '\n')
	const blocks = text.split('\n\n')
	const rest = blocks.pop() ?? ''
	const events: { event: string; data: string }[] = []
	for (const b of blocks) {
		let event = 'message'
		const data: string[] = []
		for (const line of b.split('\n')) {
			if (!line || line.startsWith(':')) continue
			const i = line.indexOf(':')
			const field = i < 0 ? line : line.slice(0, i)
			const value = i < 0 ? '' : line.slice(i + 1).replace(/^ /, '')
			if (field === 'event') event = value
			else if (field === 'data') data.push(value)
		}
		if (data.length) events.push({ event, data: data.join('\n') })
	}
	return { events, rest }
}

// Firma un evento como lo firma QvaPay (para reenviárselo a staging desde el stream, que no trae firma)
export async function feedSign(raw: string, secret: string, now = Date.now()) {
	return { 'x-qvapay-signature': await hex(await hmac(secret, raw)), 'x-qvapay-timestamp': String(Math.floor(now / 1000)) }
}

// ── La firma del webhook ─────────────────────────────────────────────

// HMAC-SHA256 del cuerpo en crudo (x-qvapay-signature, con o sin «sha256=») y una hora reciente (x-qvapay-timestamp)
export async function feedSigned(raw: string, headers: Headers, secret: string, now = Date.now()) {
	const sig = (headers.get('x-qvapay-signature') ?? '').replace(/^sha256=/, '').trim().toLowerCase()
	if (!/^[0-9a-f]{64}$/.test(sig)) return 'sin firma'
	const want = await hex(await hmac(secret, raw))
	if (!timingSafe(sig, want)) return 'firma que no coincide'
	const t = headers.get('x-qvapay-timestamp')
	if (t) {
		const n = Number(t)
		const at = Number.isFinite(n) ? (n < 1e12 ? n * 1000 : n) : Date.parse(t)
		if (!(Math.abs(now - at) <= SIGNATURE_MAX_AGE_MS)) return 'hora de la firma vieja'
	}
	return null
}

function timingSafe(a: string, b: string) {
	if (a.length !== b.length) return false
	let x = 0
	for (let i = 0; i < a.length; i++) x |= a.charCodeAt(i) ^ b.charCodeAt(i)
	return x === 0
}

// ── En el Worker: el webhook de QvaPay y la conexión de los terminales ─

const liveStub = (env: LiveEnv) => env.LIVE!.get(env.LIVE!.idFromName('book') as never)

export async function feedWebhook(req: Request, env: LiveEnv, ctx: { waitUntil(p: Promise<unknown>): void }, now = Date.now()) {
	if (!env.LIVE) return Response.json({ error: 'El feed aún no está configurado' }, { status: 503 })
	const raw = await req.text()
	if (raw.length > 64 * 1024) return Response.json({ error: 'Demasiado grande' }, { status: 413 })
	// Sin secreto aún se guarda lo que llegó (para verlo en el panel) y se responde 503: QvaPay lo reintenta luego
	const bad = env.QVAPAY_FEED_SECRET ? await feedSigned(raw, req.headers, env.QVAPAY_FEED_SECRET, now) : 'falta el secreto del feed (QVAPAY_FEED_SECRET)'
	if (!bad && env.FEED_FORWARD?.startsWith('https://')) {
		const headers: Record<string, string> = { 'Content-Type': 'application/json' }
		for (const h of ['x-qvapay-signature', 'x-qvapay-timestamp']) if (req.headers.get(h)) headers[h] = req.headers.get(h)!
		ctx.waitUntil(fetch(env.FEED_FORWARD, { method: 'POST', body: raw, headers, signal: AbortSignal.timeout(8000) }).catch(() => {}))
	}
	// Se responde enseguida (QvaPay corta a los 5 s) y el libro se actualiza después
	ctx.waitUntil(liveStub(env).fetch('https://live/event', { method: 'POST', body: JSON.stringify({ raw, rejected: bad }) }).catch(() => {}))
	if (!env.QVAPAY_FEED_SECRET) return Response.json({ error: 'El feed aún no está configurado' }, { status: 503 })
	return bad ? Response.json({ error: bad }, { status: 401 }) : Response.json({ ok: true })
}

// Un terminal se conecta para recibir el libro: solo con una cuenta de QvaPay conectada y confirmada en ese navegador.
// gate dice si lo está y si tiene Pro (al instante; sin Pro, cada FREE_EVERY_MS)
export async function liveSocket(req: Request, url: URL, env: LiveEnv, gate: (print: string) => Promise<{ ok: boolean; pro: boolean }>) {
	if (req.headers.get('Upgrade') !== 'websocket') return Response.json({ error: 'Se espera un WebSocket' }, { status: 426 })
	if (!env.LIVE) return Response.json({ error: 'El libro en vivo no está disponible' }, { status: 503 })
	const print = url.searchParams.get('p') ?? ''
	const g = /^[0-9a-f]{64}$/.test(print) ? await gate(print) : { ok: false, pro: false }
	if (!g.ok) return Response.json({ error: 'Conecta tu cuenta de QvaPay para ver el libro' }, { status: 403 })
	// Sin LIVE_FREE, solo los Pro (el resto sigue leyendo el libro con su token)
	if (!g.pro && env.LIVE_FREE !== '1') return Response.json({ error: 'El libro en tiempo real es parte de Pro' }, { status: 403 })
	return liveStub(env).fetch(`https://live/ws?pro=${g.pro ? 1 : 0}`, { headers: req.headers })
}

export async function liveStatus(env: LiveEnv): Promise<LiveState | null> {
	if (!env.LIVE) return null
	return liveStub(env)
		.fetch('https://live/status')
		.then((r: Response) => r.json() as Promise<LiveState>)
		.catch(() => null)
}

// Staging: mete en el libro una oferta inventada (copia de la mejor venta, un poco más barata) para probar el radar
export async function liveSimulate(env: LiveEnv, coin = 'BANK_CUP') {
	if (!env.LIVE || !env.STAGING) return null
	return liveStub(env)
		.fetch('https://live/simulate', { method: 'POST', body: JSON.stringify({ coin }) })
		.then((r: Response) => r.json() as Promise<{ ok: boolean; offer?: string; price?: number; error?: string }>)
}

// Uno de los últimos eventos tal como llegó (para verlo en el panel)
export interface FeedSample {
	at: number
	rejected: string | null
	body: string
}

export interface LiveState {
	// La versión del código del objeto que respondió (para ver en el panel si ya corre la última)
	version?: number
	recent: FeedSample[]
	mode: 'feed' | 'poll' | 'off'
	events: number
	lastEvent: number | null
	lastRejected: { at: number; reason: string } | null
	offers: number
	owners: number
	// Movimientos de actividad guardados (de todos los mercados)
	acts?: number
	clients: number
	proClients: number
	creds: boolean
	// El stream de QvaPay (solo producción se conecta; staging lo recibe reenviado)
	stream?: { on: boolean; since: number | null; events: number; error: string | null; connects?: number; gap?: number | null }
	lastRead: number | null
	readError: string | null
}
