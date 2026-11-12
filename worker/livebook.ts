// Libro del P2P desde el servidor (al instante para Pro, cada 10 s para el resto). QvaPay manda cada oferta nueva y
// cada cambio al momento (el feed del mercado, por webhook firmado) y un Durable Object guarda el libro y se lo empuja
// a los terminales conectados por WebSocket. El feed no dice quién publica cada oferta (solo el uuid de su dueño): el nombre, las operaciones y la
// valoración salen de leer el listado del P2P con las credenciales de nuestra app de comerciante (app-id/app-secret,
// las mismas de los cobros de Pro). Sin feed (o si se corta), esas credenciales leen el libro cada pocos segundos.
// Solo ofertas públicas del mercado: nada de ningún usuario del terminal pasa por aquí

import { COINS, isOutlier, toLevel, type Level } from '../src/terminal/market.ts'
import { num, type P2POffer } from '../src/qvapay/types.ts'
import { hex, hmac } from './crypto.ts'
import { inCuba, type D1 } from './rates.ts'

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
// El lado entero se lee cada tanto, por páginas de DEEP_TAKE (lo más que da QvaPay) y como mucho DEEP_PAGES: las ofertas
// que ya estaban antes de que el libro las conociera y nadie tocó desde entonces no llegan por el feed, y si están por
// detrás de las TAKE mejores tampoco por la lectura normal (se vieron 10 de 94 ventas de CUP que faltaban así)
export const DEEP_EVERY_MS = 60 * 60_000
export const DEEP_TAKE = 100
export const DEEP_PAGES = 5
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
		// La pausa vigente (va en todos los eventos): la puso su dueño (sin fin) o es la automática tras irse quien la tomó
		// (taker_left, vuelve sola en until). Una oferta open con pausa no se puede tomar: está fuera del libro
		pause?: Pause | null
	}
}

export interface Pause {
	reason: 'owner' | 'taker_left' | string
	until: string | null
}

// Para los avisos al dueño cuando se le va quien tomó su oferta: QvaPay la deja unos minutos en pausa (10 por defecto)
// para que revise la tasa y luego vuelve sola. Con la hora si el evento ya la trae (las de rango); si no, en general
export function autoPauseNote(pause: Pause | null | undefined) {
	const at = pause?.reason === 'taker_left' && pause.until ? Date.parse(pause.until) : NaN
	const hhmm = Number.isFinite(at) ? inCuba(at).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }) : null
	return hhmm
		? `QvaPay la tiene en pausa para que revises la tasa: vuelve sola al libro a las ${hhmm}.`
		: 'QvaPay la deja unos minutos en pausa para que revises la tasa y después vuelve sola al libro.'
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
// paused: su dueño la sacó sin cancelarla; autopaused: QvaPay la pausa unos minutos tras irse quien la tomó; resumed: vuelve
export type ActKind = 'new' | 'reopened' | 'taken' | 'partial' | 'returned' | 'cancelled' | 'edited' | 'done' | 'paused' | 'autopaused' | 'resumed'
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

// Una operación para el volumen: +1 una fija completada o una parte tomada de una de rango; −1 una parte que volvió
// (el que la tomó no pagó: QvaPay la devuelve como «returned», o pausa y reanuda la oferta con lo disponible de vuelta).
// La toma de una fija no cuenta: cuenta al completarse (si el que la tomó se va, vuelve al libro y no hubo operación)
export interface Trade {
	t: number
	side: Side
	ops: 1 | -1
	usd: number
	price: number
}
// Cambios de una oferta de rango en los que lo tomado sube o baja por una operación (al editarla, su dueño puede
// cambiar el monto: ahí solo se apunta lo tomado, sin contar nada)
const TRADE_CHANGES = new Set(['taken', 'returned', 'paused', 'resumed'])
// Cuánto se recuerda lo tomado de cada oferta y las fijas ya contadas: más que cualquier ventana de pago
export const TRADES_KEEP_MS = 3 * 86_400_000
// Un dueño que no sale en ninguna lectura en este tiempo y no tiene ofertas en el libro se olvida
export const OWNER_KEEP_DAYS = 30
export const HOUR_MS = 3_600_000
// La versión del código del libro en vivo: la dicen el panel y /data/book (tras desplegar, el objeto puede seguir un rato
// con el código anterior)
export const LIVE_VERSION = 27

export interface Applied {
	coin: string
	side: Side
	changed: boolean
	unknownOwner: boolean
	act: Act | null
	trade: Trade | null
}

export interface Owner {
	username: string
	image?: string | null
	ops: number
	rating: number | null
	kyc: boolean
	vip: boolean
	gold: boolean
	// Último día (UTC, AAAA-MM-DD) en que salió en una lectura, para olvidar a quien ya no opera
	seen?: string
}

const ts = (v?: string | null) => (v ? Date.parse(v) || 0 : 0)
export const sideKey = (coin: string, side: Side) => `${coin}:${side}`
const round = (n: number, d: number) => Math.round(n * 10 ** d) / 10 ** d

// La foto de un lado del libro (Book.stats, tabla book_stats)
export interface BookStat {
	offers: number
	outliers: number
	best: number | null
	usd: number
	usd1: number
	usd3: number
	top1: number | null
	top3: number | null
	age: number | null
	fill100: number | null
	fill500: number | null
}

// ── El libro (sin nada de Cloudflare: se prueba en Node) ─────────────

export class Book {
	offers = new Map<string, LiveOffer>()
	owners = new Map<string, Owner>()
	gone = new Map<string, number>()
	// De qué mercado y lado era cada oferta que salió (para el enlace compartido de una oferta que ya no está)
	left = new Map<string, { coin: string; side: Side; pause?: Pause }>()
	// Lo que cambió desde la última vez que se guardó
	changed = new Set<string>()
	changedOwners = new Set<string>()
	// Lo tomado de cada oferta de rango (su monto menos lo disponible), también después de salir del libro: el mismo aviso
	// llega por el webhook y por el stream, y una parte puede volver después de cerrada. Y las fijas ya contadas
	filled = new Map<string, { usd: number; at: number }>()
	completed = new Map<string, number>()
	changedTrades = new Set<string>()
	private prunedAt = 0
	// Las que no salieron en la última lectura del lado entero (ver sweep)
	private missed = new Set<string>()

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
		const trade = this.tradeOf(e, side, at, flexible, amount, price, had)
		const out = (changed: boolean, a: Act | null, unknownOwner = false): Applied | null =>
			changed || a || trade ? { coin: d.coin, side, changed, unknownOwner, act: a, trade } : null

		// Una operación que se completó: no cambia el libro (la oferta ya había salido al tomarla), pero es un precio real
		if (e.event === 'p2p.completed') return out(false, act('done', amount))
		if (e.event === 'p2p.paid') return null

		// Pausada (p2p.paused, o range_closed con change paused): sigue open pero nadie la puede tomar, así que sale del libro
		// hasta su p2p.resumed (o range_updated con change resumed). Cualquier evento que traiga una pausa vigente, igual
		const paused = !!d.pause || e.event === 'p2p.paused' || (e.event === 'p2p.range_closed' && d.change === 'paused')
		const put =
			!paused &&
			(e.event === 'p2p.created' || e.event === 'p2p.reopened' || e.event === 'p2p.resumed' || e.event === 'p2p.range_created' || e.event === 'p2p.range_updated') &&
			d.status === 'open' &&
			usd > 0
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
			this.left.delete(o.uuid)
			// Qué pasó: nueva, reabierta, o en una de rango, una parte tomada, una parte que volvió o editada
			let a: Act | null
			if (!had) a = act(e.event === 'p2p.reopened' ? 'reopened' : e.event === 'p2p.resumed' || d.change === 'resumed' ? 'resumed' : 'new', usd)
			else if (d.change === 'taken' || (d.change == null && usd < had.usd && price === had.price)) a = act('partial', had.usd - usd)
			else if (d.change === 'returned') a = act('returned', usd - had.usd)
			else if (price !== had.price || usd !== had.usd) a = act('edited', usd)
			else a = null
			return out(true, a, !!o.owner && !this.owners.has(o.owner))
		}
		// Sale del libro: tomada entera, cancelada por su dueño, cerrada o pausada. Pasar de fija a por rango no es salir
		this.gone.set(d.uuid, at)
		const pause: Pause | undefined = paused ? { reason: d.pause?.reason ?? 'owner', until: d.pause?.until ?? null } : undefined
		this.left.set(d.uuid, pause ? { coin: d.coin, side, pause } : { coin: d.coin, side })
		if (had) {
			this.offers.delete(d.uuid)
			this.changed.add(d.uuid)
		}
		this.missed.delete(d.uuid)
		const converted = e.event === 'p2p.cancelled' && d.offer_kind === 'flexible' && d.status === 'open'
		const taken = e.event === 'p2p.applied' || (e.event === 'p2p.range_closed' && d.change === 'taken')
		const rest = had?.usd ?? (flexible ? num(d.available_amount ?? 0) || amount : amount)
		// Una pausa de algo que no estaba en el libro (otra pausa encima, o ya fuera) no es noticia
		if (pause) return out(!!had, had ? act(pause.reason === 'taker_left' ? 'autopaused' : 'paused', rest, had.price) : null)
		return out(!!had, converted ? null : act(taken ? 'taken' : 'cancelled', rest, had?.price ?? price))
	}

	// Lo que el evento suma o resta al volumen. Una fija, al completarse y una sola vez. Una de rango, lo que cambió lo
	// tomado desde el último aviso: un aviso repetido no suma nada y una parte que vuelve resta. De una oferta que no se
	// conocía, lo tomado de antes es lo que faltaba en el libro; si tampoco estaba ahí, la primera noticia no cuenta
	private tradeOf(e: FeedEvent, side: Side, at: number, flexible: boolean, amount: number, price: number, had: LiveOffer | undefined): Trade | null {
		const d = e.data
		if (e.event === 'p2p.completed') {
			if (d.status !== 'completed' || !(amount > 0) || this.completed.has(d.uuid)) return null
			this.completed.set(d.uuid, at)
			this.changedTrades.add(`d:${d.uuid}`)
			return { t: at, side, ops: 1, usd: round(amount, 2), price }
		}
		if (!flexible || d.available_amount == null || !(amount > 0)) return null
		const now = Math.max(0, amount - num(d.available_amount))
		const prev = this.filled.get(d.uuid)
		const before = prev?.usd ?? (had ? Math.max(0, amount - had.usd) : 0)
		this.filled.set(d.uuid, { usd: now, at })
		// Solo se guarda si cambió (las ediciones de las de rango llegan a miles al día)
		if (prev?.usd !== now) this.changedTrades.add(`f:${d.uuid}`)
		const delta = round(now - before, 2)
		// Sin nada sabido de antes no cuenta nada, solo se apunta lo tomado: en una oferta que ya corría, monto − disponible
		// es todo lo que se tomó en su vida (se vio una venta con 1,935 USD tomados antes de su primer aviso)
		if (!prev && !had) return null
		if (!delta || !TRADE_CHANGES.has(d.change ?? '')) return null
		return { t: at, side, ops: delta > 0 ? 1 : -1, usd: Math.abs(delta), price }
	}

	// Olvida lo tomado y las fijas contadas de hace más de TRADES_KEEP_MS (como mucho, una vez por hora). Devuelve las
	// claves que ya no hay que guardar
	pruneTrades(now = Date.now()): string[] {
		if (now - this.prunedAt < HOUR_MS) return []
		this.prunedAt = now
		const out: string[] = []
		for (const [id, f] of this.filled) if (now - f.at > TRADES_KEEP_MS) this.filled.delete(id), out.push(`f:${id}`)
		for (const [id, t] of this.completed) if (now - t > TRADES_KEEP_MS) this.completed.delete(id), out.push(`d:${id}`)
		// Los dueños que no se ven hace OWNER_KEEP_DAYS y no tienen ofertas en el libro. Los guardados antes de apuntar el
		// día cuentan desde hoy
		const today = new Date(now).toISOString().slice(0, 10)
		const oldest = new Date(now - OWNER_KEEP_DAYS * 86_400_000).toISOString().slice(0, 10)
		const active = new Set([...this.offers.values()].map((o) => o.owner))
		for (const [id, w] of this.owners) {
			if (!w.seen) {
				w.seen = today
				this.changedOwners.add(id)
			} else if (w.seen < oldest && !active.has(id)) {
				this.owners.delete(id)
				this.changedOwners.delete(id)
				out.push(`u:${id}`)
			}
		}
		return out
	}

	// Una lectura del libro (las mejores TAKE de un lado) con nuestro token: mete o actualiza lo leído, aprende quién
	// es cada dueño y saca lo que debería estar dentro de lo leído y no está (un evento que se perdió). Con addOnly (una
	// página de la lectura del lado entero) solo mete y actualiza, y apunta en `into` lo que vio: lo que falta lo decide
	// sweep() al acabar todas las páginas
	// Una lectura normal de QvaPay: la lista y su oferta promocionada. La promocionada va aparte y solo se añade: QvaPay
	// la pone en su hueco aunque su precio sea peor que el de la última de la lista, y contándola el «peor precio leído»
	// bajaba hasta ella y se borraba del libro todo lo que hay entre las mejores y su precio. Cuenta como vista (si no,
	// con el lado entero leído se borraría por no estar en la lista). La lista va tal cual: con su largo se sabe si se
	// leyó el lado entero
	read(coin: string, side: Side, list: P2POffer[], promoted?: P2POffer | null, now = Date.now()) {
		const seen = new Set<string>()
		if (promoted) this.merge(coin, side, [promoted], now, true, seen)
		return this.merge(coin, side, list, now, false, seen)
	}

	merge(coin: string, side: Side, list: P2POffer[], now = Date.now(), addOnly = false, into?: Set<string>) {
		const seen = into ?? new Set<string>()
		for (const o of list) {
			const u = o.User
			if (u?.uuid) {
				const w: Owner = {
					username: u.username ?? '—',
					image: u.image ?? null,
					ops: (u._count?.P2P ?? 0) + (u._count?.P2P_Peer ?? 0),
					rating: u.rating_count ? (u.rating_avg ?? null) : null,
					kyc: !!u.kyc,
					vip: !!u.vip,
					gold: !!u.golden_check,
					seen: new Date(now).toISOString().slice(0, 10),
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
		if (addOnly) return 0
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
				this.drop(o, now)
				removed++
			}
		}
		return removed
	}

	// Al acabar la lectura del lado entero (todas sus páginas): lo que no salió en ninguna se apunta, y si tampoco sale
	// en la siguiente lectura entera, se da por ido. Una sola vez no basta: si entre página y página sale una oferta,
	// las de detrás suben una posición y la primera de la página siguiente no se ve. Devuelve cuántas sacó
	sweep(coin: string, side: Side, seen: Set<string>, startedAt: number, now = Date.now()) {
		let removed = 0
		for (const o of [...this.offers.values()]) {
			if (o.coin !== coin || o.side !== side) continue
			if (seen.has(o.uuid) || o.updatedAt > startedAt - 30_000) {
				this.missed.delete(o.uuid)
				continue
			}
			if (!this.missed.has(o.uuid)) {
				this.missed.add(o.uuid)
				continue
			}
			this.missed.delete(o.uuid)
			this.drop(o, now)
			removed++
		}
		return removed
	}

	private drop(o: LiveOffer, now: number) {
		this.offers.delete(o.uuid)
		this.missed.delete(o.uuid)
		this.changed.add(o.uuid)
		this.gone.set(o.uuid, now)
		this.left.set(o.uuid, { coin: o.coin, side: o.side })
	}

	// Un lado como lo usa el terminal (los mismos campos que su libro), el mejor precio primero
	levels(coin: string, side: Side, top = SEND_TOP): Level[] {
		const list = [...this.offers.values()].filter((o) => o.coin === coin && o.side === side)
		list.sort((a, b) => (side === 'ask' ? a.price - b.price : b.price - a.price) || a.createdAt - b.createdAt)
		return list.slice(0, top).map((o) => this.levelOf(o))
	}

	// Una oferta por su uuid (el enlace que comparte su dueño): abierta, ya fuera del libro (con su mercado y lado) o
	// desconocida (las privadas no salen en el feed)
	// paused: sigue publicada pero pausada (por su dueño, o la automática hasta until): aún no se puede tomar
	find(
		uuid: string,
	): { state: 'open'; coin: string; side: Side; level: Level } | { state: 'gone'; coin: string; side: Side } | { state: 'paused'; coin: string; side: Side; reason: string; until: string | null } | { state: 'unknown' } {
		const o = this.offers.get(uuid)
		if (o) return { state: 'open', coin: o.coin, side: o.side, level: this.levelOf(o) }
		const l = this.left.get(uuid)
		if (!l) return { state: 'unknown' }
		if (l.pause) return { state: 'paused', coin: l.coin, side: l.side, reason: l.pause.reason, until: l.pause.until }
		return { state: 'gone', coin: l.coin, side: l.side }
	}

	private levelOf(o: LiveOffer): Level {
		const coin = o.coin
		const side = o.side
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
		return { ...level, price: o.price, user: w?.username ?? '—', image: w?.image ?? null, ops: w?.ops ?? 0, rating: w?.rating ?? null, kyc: w?.kyc ?? false, vip: w?.vip ?? o.ownerVip, gold: w?.gold ?? false }
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

	// La foto de un lado para el histórico del libro (bookstats.ts): solo números del mercado, sin ofertas ni usuarios.
	// Lo atípico respecto a la referencia (la mediana de lo completado) no cuenta
	stats(coin: string, side: Side, ref: number | null, now = Date.now()): BookStat {
		const all = [...this.offers.values()].filter((o) => o.coin === coin && o.side === side)
		const list = all.filter((o) => !isOutlier(o.price, ref, side)).sort((a, b) => (side === 'ask' ? a.price - b.price : b.price - a.price) || a.createdAt - b.createdAt)
		const open = list.filter((o) => !o.onlyVip)
		const best = open[0]?.price ?? null
		const sum = (xs: LiveOffer[]) => xs.reduce((t, o) => t + o.usd, 0)
		const near = (pct: number) => (best === null ? 0 : sum(list.filter((o) => (side === 'ask' ? o.price <= best * (1 + pct) : o.price >= best * (1 - pct)))))
		const usd = sum(list)
		const byOwner = new Map<string, number>()
		for (const o of list) byOwner.set(o.owner || o.uuid, (byOwner.get(o.owner || o.uuid) ?? 0) + o.usd)
		const shares = [...byOwner.values()].sort((a, b) => b - a)
		const ages = list.slice(0, 10).map((o) => now - o.updatedAt).sort((a, b) => a - b)
		const age = ages.length ? Math.round((ages.length % 2 ? ages[(ages.length - 1) / 2] : (ages[ages.length / 2 - 1] + ages[ages.length / 2]) / 2) / 60_000) : null
		// Precio medio de tomar tantos USD, de la mejor hacia atrás (las que puede tomar cualquiera)
		const fill = (want: number) => {
			let got = 0
			let paid = 0
			for (const o of open) {
				const take = Math.min(o.usd, want - got)
				got += take
				paid += take * o.price
				if (got >= want) return round(paid / want, 4)
			}
			return null
		}
		return {
			offers: list.length,
			outliers: all.length - list.length,
			best,
			usd: round(usd, 2),
			usd1: round(near(0.01), 2),
			usd3: round(near(0.03), 2),
			top1: usd > 0 ? round(shares[0] / usd, 3) : null,
			top3: usd > 0 ? round(shares.slice(0, 3).reduce((t, x) => t + x, 0) / usd, 3) : null,
			age,
			fill100: fill(100),
			fill500: fill(500),
		}
	}

	prune(now = Date.now()) {
		for (const [k, t] of this.gone)
			if (now - t > GONE_KEEP_MS) {
				this.gone.delete(k)
				this.left.delete(k)
			}
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

const REJECTED_GAP_MS = 10_000
let lastRejected = -Infinity

export const liveStub = (env: LiveEnv) => env.LIVE!.get(env.LIVE!.idFromName('book') as never)

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
	// Se responde enseguida (QvaPay corta a los 5 s) y el libro se actualiza después. Lo rechazado solo se pasa para
	// verlo en el panel: uno cada REJECTED_GAP_MS por instancia y recortado (sin firma, cualquiera puede mandar cuerpos y
	// cada uno despertaba al libro en vivo, que es uno para todos)
	if (!bad || now - lastRejected >= REJECTED_GAP_MS) {
		if (bad) lastRejected = now
		ctx.waitUntil(liveStub(env).fetch('https://live/event', { method: 'POST', body: JSON.stringify({ raw: bad ? raw.slice(0, 2048) : raw, rejected: bad }) }).catch(() => {}))
	}
	if (!env.QVAPAY_FEED_SECRET) return Response.json({ error: 'El feed aún no está configurado' }, { status: 503 })
	return bad ? Response.json({ error: bad }, { status: 401 }) : Response.json({ ok: true })
}

// Un terminal se conecta para recibir el libro: solo con una cuenta de QvaPay conectada y confirmada en ese navegador.
// gate dice si lo está y si tiene Pro (al instante; sin Pro, cada FREE_EVERY_MS)
// gate: si esa huella puede recibir el libro, si es Pro y de qué cuenta es (para ver en el panel quién está conectado ahora)
export async function liveSocket(req: Request, url: URL, env: LiveEnv, gate: (print: string) => Promise<{ ok: boolean; pro: boolean; username?: string }>) {
	if (req.headers.get('Upgrade') !== 'websocket') return Response.json({ error: 'Se espera un WebSocket' }, { status: 426 })
	if (!env.LIVE) return Response.json({ error: 'El libro en vivo no está disponible' }, { status: 503 })
	const print = url.searchParams.get('p') ?? ''
	const g = /^[0-9a-f]{64}$/.test(print) ? await gate(print) : { ok: false, pro: false }
	if (!g.ok) return Response.json({ error: 'Conecta tu cuenta de QvaPay para ver el libro' }, { status: 403 })
	// Sin LIVE_FREE, solo los Pro (el resto sigue leyendo el libro con su token)
	if (!g.pro && env.LIVE_FREE !== '1') return Response.json({ error: 'El libro en tiempo real es parte de Pro' }, { status: 403 })
	const q = new URLSearchParams({ pro: g.pro ? '1' : '0', u: g.username ?? '' })
	return liveStub(env).fetch(`https://live/ws?${q}`, { headers: req.headers })
}

// Los terminales conectados ahora mismo: de qué cuenta, si es Pro, qué mercados miran, desde cuándo y su última señal.
// No se guarda en ninguna parte: es lo que tiene abierto el libro en vivo en este momento
export interface LiveClient {
	u: string | null
	pro: boolean
	subs: string[]
	at: number | null
	seen: number | null
}
// Un mercado entero, para la mini app de QvaPay (solo mirar)
export interface LiveBookSide {
	ready: boolean
	levels: Level[]
	total: number
}
export async function liveBookOf(env: LiveEnv, coin: string): Promise<{ coin: string; at: number; feed: boolean; version?: number; ask: LiveBookSide; bid: LiveBookSide } | null> {
	if (!env.LIVE) return null
	const r = await liveStub(env).fetch(`https://live/book?coin=${encodeURIComponent(coin)}`)
	return r.ok ? r.json() : null
}

// Una oferta por su uuid (ver Book.find), para el enlace que comparte su dueño
export async function liveOfferOf(env: LiveEnv, uuid: string): Promise<ReturnType<Book['find']> | null> {
	if (!env.LIVE) return null
	const r = await liveStub(env).fetch(`https://live/offer?id=${encodeURIComponent(uuid)}`)
	return r.ok ? r.json() : null
}

// Seguir quién está en línea aparte de los dueños del libro (la contraparte de una operación, una ficha abierta)
export async function liveOnline(env: LiveEnv, users: { id: string; u: string }[], ip = ''): Promise<{ on: boolean; term: string[]; qp: string[]; at: number | null } | null> {
	if (!env.LIVE) return null
	const r = await liveStub(env).fetch('https://live/online', { method: 'POST', headers: { 'x-ip': ip }, body: JSON.stringify({ users }) })
	return r.ok ? r.json() : null
}

export async function liveClients(env: LiveEnv): Promise<LiveClient[] | null> {
	if (!env.LIVE) return null
	return liveStub(env)
		.fetch('https://live/clients')
		.then((r: Response) => r.json() as Promise<LiveClient[]>)
		.catch(() => null)
}

// La foto de todos los mercados para el histórico del libro, con la referencia de lo atípico de cada uno. Solo los lados
// completos; stale: el feed estaba parado
export type BookRefs = Record<string, { ask: number | null; bid: number | null }>
export interface BookSnapshot {
	stale: boolean
	sides: { coin: string; side: Side; stat: BookStat }[]
}
export async function liveSnapshot(env: LiveEnv, refs: BookRefs): Promise<BookSnapshot | null> {
	if (!env.LIVE) return null
	const r = await liveStub(env).fetch('https://live/snapshot', { method: 'POST', body: JSON.stringify({ refs }) })
	return r.ok ? ((await r.json()) as BookSnapshot) : null
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

// Retraso de los eventos del feed: cuántos se midieron y en ms la mediana, el 90 % y el peor
export const LAG_KEEP = 200
export interface LagStats {
	n: number
	p50: number
	p90: number
	max: number
}
export function lagStats(list: number[]): LagStats | null {
	if (!list.length) return null
	const s = [...list].sort((a, b) => a - b)
	const at = (q: number) => s[Math.min(s.length - 1, Math.floor(q * s.length))]
	return { n: s.length, p50: at(0.5), p90: at(0.9), max: s[s.length - 1] }
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
	// Desde que QvaPay manda el evento (sent_at) y desde que cambió la oferta (updated_at) hasta que llega aquí
	lag?: { sent: LagStats | null; upd: LagStats | null }
	stream?: { on: boolean; since: number | null; events: number; error: string | null; connects?: number; gap?: number | null }
	lastRead: number | null
	readError: string | null
	// Quién está en línea: si se consulta QvaPay, su última consulta, cuántos ahí y con el terminal abierto, y el error
	presence?: { on: boolean; at: number | null; online: number; terminal: number; error: string | null }
}
