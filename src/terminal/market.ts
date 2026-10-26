// Libro de órdenes del P2P de QvaPay construido a partir de las ofertas abiertas.
//
//   Oferta sell (el creador vende QUSD) → ask: el taker COMPRA USD pagando la moneda
//   Oferta buy  (el creador compra QUSD) → bid: el taker VENDE USD y recibe la moneda
//
// El precio es siempre "moneda por USD" (receive / amount), como en QvaPay.

import { logger } from '../log.ts'
import { QvaPayError, type QvaPayClient } from '../qvapay/client.ts'
import { num, type Averages, type CompletedRates, type OfferType, type P2POffer } from '../qvapay/types.ts'

const log = logger('market')

export const COINS = [
	{ tick: 'BANK_CUP', name: 'CUP Transferencia', unit: 'CUP' },
	{ tick: 'ETECSA', name: 'Saldo ETECSA', unit: 'CUP' },
	{ tick: 'CLASICA', name: 'Tarjeta Clásica', unit: 'USD' },
	{ tick: 'BANK_MLC', name: 'MLC', unit: 'MLC' },
	{ tick: 'ZELLE', name: 'Zelle', unit: 'USD' },
	{ tick: 'BANDECPREPAGO', name: 'Bandec Prepago', unit: 'USD' },
	{ tick: 'TROPIPAY', name: 'TropiPay', unit: 'EUR' },
	{ tick: 'CUPCASH', name: 'CUP Efectivo', unit: 'CUP' },
	{ tick: 'BOLSATM', name: 'Bolsa TM', unit: 'CUP' },
] as const

export type Tick = (typeof COINS)[number]['tick']

export interface Level {
	uuid: string
	price: number
	usd: number
	kind: 'fixed' | 'flexible'
	orderMin: number | null
	orderMax: number | null
	user: string
	ops: number
	rating: number | null
	kyc: boolean
	vip: boolean
	gold: boolean
	vipOnly: boolean
	requirements: Record<string, number> | null
	// Epoch ms. updatedAt cambia al editar o reabrir la oferta: es su última actividad
	createdAt: number | null
	updatedAt: number | null
	promoted: boolean
	// A más de OUTLIER_PCT de la referencia: casi siempre un error de tipeo
	outlier: boolean
}

export interface BookActivity {
	t: number
	kind: 'new' | 'gone'
	side: 'ask' | 'bid'
	price: number
	usd: number
	user: string
}

interface SideState {
	levels: Level[]
	total: number
	updatedAt: number | null
	error: string | null
}

interface CoinState {
	ask: SideState
	bid: SideState
	completed: CompletedRates | null
	completedAt: number | null
	activity: BookActivity[]
	hotUntil: number
}

// Con qué cuenta se lee el libro: en el navegador, solo la del propio usuario
export interface BookReaders {
	get(): Promise<{ sid: string; client: QvaPayClient } | null>
	invalid(sid: string): void | Promise<void>
}

// Dónde se guarda el histórico propio (SQLite del Durable Object, o memoria en tests)
export interface HistoryStore {
	load(sinceMs: number): Promise<(HistoryPoint & { coin: string })[]>
	append(points: (HistoryPoint & { coin: string })[]): Promise<void>
}

export interface HistoryPoint {
	t: number
	bid: number | null
	ask: number | null
}

// Precio raro: lejos de la referencia (mediana de lo completado). Hacia el lado bueno para quien la toma
// (una venta muy barata o una compra muy cara) basta un 8 %: suele ser un error o un cebo de una cuenta nueva.
// Hacia el lado malo no engaña a nadie y se tolera mucho más
const OUTLIER_PCT = 0.35
const OUTLIER_GOOD_PCT = 0.08
const TAKE = 50
// 15 lecturas/min mientras alguien mira: deja cupo libre a cada cuenta para sus operaciones.
// Sin nadie mirando, una lectura por minuto (el histórico sigue avanzando, más lento).
const TICK_MS = 4000
const IDLE_TICK_MS = 60_000
const HOT_REFRESH_MS = 10_000
const HOT_WINDOW_MS = 90_000
const COMPLETED_EVERY_MS = 5 * 60_000
const COMPLETED_GAP_MS = 20_000
const NO_READER_RETRY_MS = 15_000
const HISTORY_EVERY_MS = 60_000
const HISTORY_KEEP_MS = 14 * 24 * 3600_000

const emptySide = (): SideState => ({ levels: [], total: 0, updatedAt: null, error: null })

export class Market {
	private readonly publicClient: QvaPayClient
	private readonly readers: BookReaders
	private readonly historyStore: HistoryStore
	private readonly coins = new Map<Tick, CoinState>()
	private history = new Map<Tick, HistoryPoint[]>()
	private averages: Averages | null = null
	private averagesAt = 0
	private lastHistoryAt = 0
	private busy = false
	private lastCompletedCall = 0
	// Sin ninguna cuenta conectada no hay con qué leer el libro
	private noReaderUntil = 0
	private hasReader = false

	constructor(opts: { publicClient: QvaPayClient; readers: BookReaders; historyStore: HistoryStore }) {
		this.publicClient = opts.publicClient
		this.readers = opts.readers
		this.historyStore = opts.historyStore
		for (const c of COINS) {
			this.coins.set(c.tick, { ask: emptySide(), bid: emptySide(), completed: null, completedAt: null, activity: [], hotUntil: 0 })
			this.history.set(c.tick, [])
		}
	}

	// Carga el histórico guardado. Se llama una vez al arrancar.
	async init() {
		for (const p of await this.historyStore.load(Date.now() - HISTORY_KEEP_MS)) {
			this.history.get(p.coin as Tick)?.push({ t: p.t, bid: p.bid, ask: p.ask })
		}
	}

	// Cuándo conviene el próximo tick: rápido si alguien mira, lento si no
	nextDelayMs() {
		const now = Date.now()
		const watched = COINS.some((m) => this.coins.get(m.tick)!.hotUntil > now)
		return watched ? TICK_MS : IDLE_TICK_MS
	}

	// Alguien acaba de conectar su cuenta: el libro puede leerse ya
	wake() {
		this.noReaderUntil = 0
	}

	// Una moneda que alguien está mirando se refresca más a menudo
	touch(tick: Tick) {
		const c = this.coins.get(tick)
		if (c) c.hotUntil = Date.now() + HOT_WINDOW_MS
	}

	snapshot(tick: Tick) {
		const c = this.coins.get(tick)!
		const meta = COINS.find((x) => x.tick === tick)!
		const avg = this.averages?.[tick]
		return {
			coin: meta,
			ask: c.ask,
			bid: c.bid,
			reference: this.reference(tick),
			averages24h: avg
				? { average: avg.average, buy: avg.average_buy, sell: avg.average_sell, count: avg.count, windowHours: avg.window_hours ?? null }
				: null,
			completed: c.completed,
			activity: c.activity.slice(0, 40),
			// false = nadie ha conectado su cuenta: no hay libro en vivo
			live: this.hasReader,
			serverTime: Date.now(),
		}
	}

	// Los lados de cada mercado que ya se han leído (para el ranking de usuarios)
	sides(tick?: Tick, side?: 'ask' | 'bid') {
		const out: { tick: Tick; side: 'ask' | 'bid'; levels: Level[] }[] = []
		for (const [t, c] of this.coins)
			for (const sd of ['ask', 'bid'] as const)
				if ((!tick || t === tick) && (!side || sd === side) && c[sd].updatedAt !== null) out.push({ tick: t, side: sd, levels: c[sd].levels })
		return out
	}

	overview() {
		return COINS.map((meta) => {
			const c = this.coins.get(meta.tick)!
			const ask = c.ask.levels.find((l) => !l.outlier && !l.vipOnly)?.price ?? null
			const bid = c.bid.levels.find((l) => !l.outlier && !l.vipOnly)?.price ?? null
			const avg = this.averages?.[meta.tick]
			return { ...meta, ask, bid, count24h: avg?.count ?? 0, avgBuy: avg?.average_buy || null, avgSell: avg?.average_sell || null }
		})
	}

	historyFor(tick: Tick) {
		return this.history.get(tick) ?? []
	}

	// ── Polling ──────────────────────────────────────────────────────────

	// Un paso del bucle: lo dispara la alarma del Durable Object y se espera
	// entero. El libro gasta el cupo de GET /p2p (25/min por cuenta); promedios
	// y completados tienen límites propios, así que no compiten con él.
	async tick() {
		if (this.busy) return
		this.busy = true
		try {
			const now = Date.now()
			if (now - this.averagesAt > COMPLETED_EVERY_MS) {
				this.averagesAt = now
				this.averages = await this.publicClient.averages().catch((e) => (log.warn(`averages: ${e.message}`), this.averages))
			} else if (now - this.lastCompletedCall > COMPLETED_GAP_MS) {
				const due = COINS.map((m) => m.tick)
					.filter((t) => {
						const c = this.coins.get(t)!
						return !c.completedAt || now - c.completedAt > COMPLETED_EVERY_MS
					})
					.sort((a, b) => this.coins.get(b)!.hotUntil - this.coins.get(a)!.hotUntil)[0]
				if (due) {
					this.lastCompletedCall = now
					await this.refreshCompleted(due)
				}
			}
			if (now >= this.noReaderUntil) {
				const task = this.nextBookTask(now)
				if (task) {
					await this.refreshSide(task.tick, task.side)
					// La primera vez que se abre un mercado, los dos lados seguidos: nunca medio libro
					const other = task.side === 'ask' ? 'bid' : 'ask'
					const c = this.coins.get(task.tick)!
					if (c.hotUntil > now && c[other].updatedAt === null && now >= this.noReaderUntil) await this.refreshSide(task.tick, other)
				}
			}
			if (now - this.lastHistoryAt > HISTORY_EVERY_MS) await this.recordHistory(now)
		} finally {
			this.busy = false
		}
	}

	private nextBookTask(now: number): { tick: Tick; side: 'ask' | 'bid' } | undefined {
		const tasks = COINS.flatMap((m) => (['ask', 'bid'] as const).map((side) => ({ tick: m.tick, side })))
		const age = (t: { tick: Tick; side: 'ask' | 'bid' }) => now - (this.coins.get(t.tick)![t.side].updatedAt ?? 0)
		const hot = tasks.filter((t) => this.coins.get(t.tick)!.hotUntil > now && age(t) > HOT_REFRESH_MS)
		const pool = hot.length ? hot : tasks.filter((t) => age(t) > 30_000)
		return pool.sort((a, b) => age(b) - age(a))[0]
	}

	private async refreshSide(tick: Tick, side: 'ask' | 'bid') {
		const c = this.coins.get(tick)!
		const type: OfferType = side === 'ask' ? 'sell' : 'buy'
		const reader = await this.readers.get()
		this.hasReader = !!reader
		if (!reader) {
			this.noReaderUntil = Date.now() + NO_READER_RETRY_MS
			return
		}
		try {
			const res = await reader.client.listOffers({ type, coin: tick, orderBy: 'best_rate', orderType: 'desc', take: TAKE })
			const promoted = res.promoted?.offer
			const offers = promoted ? [promoted, ...res.data.filter((o) => o.uuid !== promoted.uuid)] : res.data
			const ref = this.reference(tick)?.[side === 'ask' ? 'sell' : 'buy'] ?? null
			const levels = offers.map((o) => toLevel(o, o.uuid === promoted?.uuid, ref)).filter((l) => l.usd > 0)
			levels.sort((a, b) => (side === 'ask' ? a.price - b.price : b.price - a.price))
			this.diffActivity(c, side, c[side].levels, levels)
			c[side] = { levels, total: res.total, updatedAt: Date.now(), error: null }
		} catch (err) {
			// El mensaje de QvaPay tal cual (p. ej. "Debes vincular tu cuenta de Telegram…"), sin el código delante
			const body = err instanceof QvaPayError ? (err.body as { error?: unknown } | undefined) : undefined
			c[side].error = typeof body?.error === 'string' ? body.error : (err as Error).message
			c[side].updatedAt = Date.now()
			// Token revocado: esa cuenta se desconecta y la próxima lectura usa otra
			if (err instanceof QvaPayError && err.status === 401) {
				await this.readers.invalid(reader.sid)
				log.warn('Un token conectado fue rechazado por QvaPay (401); se desconecta esa cuenta')
				return
			}
			log.warn(`${tick} ${side}: ${(err as Error).message}`)
		}
	}

	private async refreshCompleted(tick: Tick) {
		const c = this.coins.get(tick)!
		c.completedAt = Date.now()
		try {
			c.completed = await this.publicClient.completedRates(tick)
		} catch (err) {
			log.warn(`completados ${tick}: ${(err as Error).message}`)
		}
	}

	// Ofertas que aparecen o desaparecen entre dos lecturas. Sin el feed no
	// sabemos si una oferta que se fue la tomaron o la cancelaron.
	private diffActivity(c: CoinState, side: 'ask' | 'bid', prev: Level[], next: Level[]) {
		if (c[side].updatedAt === null) return
		const before = new Map(prev.map((l) => [l.uuid, l]))
		const after = new Map(next.map((l) => [l.uuid, l]))
		const t = Date.now()
		const events: BookActivity[] = []
		for (const [id, l] of after) if (!before.has(id) && !l.outlier) events.push({ t, kind: 'new', side, price: l.price, usd: l.usd, user: l.user })
		// Solo cuenta como retirada si estaba dentro de lo que leemos (no si salió del top por precio)
		const worst = next.at(-1)?.price
		for (const [id, l] of before) {
			if (after.has(id) || l.outlier) continue
			const insideWindow = next.length < TAKE || worst === undefined || (side === 'ask' ? l.price <= worst : l.price >= worst)
			if (insideWindow) events.push({ t, kind: 'gone', side, price: l.price, usd: l.usd, user: l.user })
		}
		c.activity = [...events, ...c.activity].slice(0, 100)
	}

	// Referencia para detectar precios absurdos: medianas de lo completado
	private reference(tick: Tick): { buy: number; sell: number } | null {
		const c = this.coins.get(tick)!.completed
		if (c && c.count >= 3) return { buy: c.median_buy || c.average_buy, sell: c.median_sell || c.average_sell }
		const a = this.averages?.[tick]
		if (a && a.count >= 3) return { buy: a.median_buy || a.average_buy || a.average, sell: a.median_sell || a.average_sell || a.average }
		return null
	}

	// ── Histórico propio (QvaPay no lo da para monedas fiat) ──────────────

	private async recordHistory(now: number) {
		this.lastHistoryAt = now
		const points: (HistoryPoint & { coin: string })[] = []
		for (const meta of COINS) {
			const c = this.coins.get(meta.tick)!
			if (!c.ask.updatedAt && !c.bid.updatedAt) continue
			const pick = (levels: Level[]) => levels.find((l) => !l.outlier && !l.vipOnly && l.usd >= 5)?.price ?? null
			const point = { t: now, bid: pick(c.bid.levels), ask: pick(c.ask.levels) }
			if (point.bid === null && point.ask === null) continue
			const series = this.history.get(meta.tick)!
			series.push(point)
			// Solo lo de los últimos 14 días se queda en memoria
			while (series.length && series[0].t < now - HISTORY_KEEP_MS) series.shift()
			points.push({ coin: meta.tick, ...point })
		}
		if (points.length) await this.historyStore.append(points).catch((e) => log.warn(`histórico: ${e.message}`))
	}
}

function toLevel(o: P2POffer, promoted: boolean, ref: number | null): Level {
	const amount = num(o.amount)
	const flexible = o.offer_kind === 'flexible'
	const price = amount > 0 ? num(o.receive) / amount : 0
	const u = o.User
	const ts = (v?: string) => (v ? new Date(v).getTime() || null : null)
	return {
		uuid: o.uuid,
		price,
		usd: flexible ? num(o.available_amount) : amount,
		kind: flexible ? 'flexible' : 'fixed',
		orderMin: flexible && o.order_min != null ? num(o.order_min) : null,
		orderMax: flexible && o.order_max != null ? num(o.order_max) : null,
		user: u?.username ?? '—',
		ops: (u?._count?.P2P ?? 0) + (u?._count?.P2P_Peer ?? 0),
		rating: u?.rating_count ? (u.rating_avg ?? null) : null,
		kyc: !!u?.kyc,
		vip: !!u?.vip,
		gold: !!u?.golden_check,
		vipOnly: !!o.only_vip,
		requirements: o.requirements ?? null,
		createdAt: ts(o.created_at) ?? ts(o.updated_at),
		updatedAt: ts(o.updated_at) ?? ts(o.created_at),
		promoted,
		outlier: isOutlier(price, ref, o.type === 'sell' ? 'ask' : 'bid'),
	}
}

// ¿Precio raro? Una venta (ask) es buena para quien la toma si es barata; una compra (bid), si es cara
export function isOutlier(price: number, ref: number | null, side: 'ask' | 'bid') {
	if (ref === null || !(ref > 0)) return false
	const d = price / ref - 1
	const good = side === 'ask' ? -d : d
	return good > OUTLIER_GOOD_PCT || Math.abs(d) > OUTLIER_PCT
}
