// API de "Mis operaciones". Corre en el navegador de cada usuario con su
// propio token: el dinero nunca pasa por aquí, sigue en el escrow de QvaPay.
// Usa Request/Response estándar, así que también se prueba en Node.

import { logger } from '../log.ts'
import { QvaPayError, type QvaPayClient } from '../qvapay/client.ts'
import { num, type CreateOfferBody, type EditOfferBody, type Me, type P2POffer, type PaymentField, type Requirements } from '../qvapay/types.ts'
import { COINS, type Market } from '../terminal/market.ts'
import { pendingCount, tradeAlerts } from './alerts.ts'
import { orderTrades, paymentDetails, toTrades, type Trade } from './trades.ts'

export interface Account {
	sid: string
	me: Me
	client: QvaPayClient
}

// Dónde vive la cuenta conectada (en el navegador: su almacenamiento local)
export interface AccountStore {
	get(sid: string | undefined): Promise<Account | null>
	connect(sid: string, token: string, opts?: { remember?: boolean }): Promise<Account>
	disconnect(sid: string): Promise<void>
	newSid(): string
}

const log = logger('broker')

const MAX_BODY = 64 * 1024
// Intentos de conectar un token por IP: frena a quien pruebe tokens a lo bruto
const CONNECT_MAX = 10
const CONNECT_WINDOW_MS = 10 * 60_000
// Chats que se consultan en cada lectura, para avisar de mensajes nuevos
const CHAT_WATCH = 3
const CHAT_ACTIVE = new Set(['processing', 'paid', 'revision'])
// Ofertas por rango propias cuyo detalle se lee para ver las órdenes que otros tomaron
const FLEX_WATCH = 4
const TICKS = new Set<string>(COINS.map((c) => c.tick))
// Valores que QvaPay acepta en los requisitos de una oferta
const REQUIREMENTS: Record<keyof Requirements, number[]> = {
	min_completed: [5, 10, 25, 50, 100],
	min_rating: [4, 4.5],
	min_account_days: [7, 30, 90, 180],
	min_trustscore: [50, 85],
}

// Lectura anterior de cada cuenta, para saber qué cambió
interface Seen {
	user: string
	last: { trades: Trade[]; openOffers: Trade[] } | null
	sent: Set<string>
}

interface Ctx {
	req: Request
	url: URL
	sid: string | undefined
}

export class Broker {
	private readonly accounts: AccountStore
	private readonly market: Pick<Market, 'wake'>
	readonly dryRun: boolean
	private connectAttempts = new Map<string, number[]>()
	private seen: Seen | null = null
	private coinFields: Record<string, PaymentField[]> | null = null

	constructor(opts: { accounts: AccountStore; market: Pick<Market, 'wake'>; dryRun: boolean }) {
		this.accounts = opts.accounts
		this.market = opts.market
		this.dryRun = opts.dryRun
	}

	// Devuelve la respuesta, o null si la ruta no es suya
	async handle(req: Request): Promise<Response | null> {
		const url = new URL(req.url)
		if (!url.pathname.startsWith('/api/broker/')) return null
		const ctx: Ctx = { req, url, sid: parseCookies(req.headers.get('cookie')).sid }
		const route = `${req.method} ${url.pathname.slice('/api/broker'.length)}`

		if (req.method === 'POST' && !sameOrigin(req, url)) return json(403, { error: 'Origen no permitido' })

		try {
			switch (route) {
				case 'GET /me':
					return await this.me(ctx)
				case 'POST /connect':
					return await this.connect(ctx)
				case 'POST /disconnect':
					return await this.disconnect(ctx)
			}
			const acc = await this.accounts.get(ctx.sid).catch(() => null)
			if (!acc) return json(401, { error: 'Conecta tu cuenta de QvaPay primero' })
			switch (route) {
				case 'GET /trades':
					return await this.trades(acc)
				case 'GET /trade':
					return await this.trade(ctx, acc)
				case 'POST /trade/action':
					return await this.action(ctx, acc)
				case 'GET /coins':
					return await this.coins(acc)
				case 'GET /offer':
					return await this.offer(ctx, acc)
				case 'POST /offer/create':
					return await this.createOffer(ctx, acc)
				case 'POST /offer/edit':
					return await this.editOffer(ctx, acc)
				case 'POST /offer/pause':
					return await this.pauseOffer(ctx, acc)
				case 'POST /offer/apply':
					return await this.applyOffer(ctx, acc)
			}
			return json(404, { error: 'Ruta desconocida' })
		} catch (err) {
			const msg = friendly(err)
			if (!(err instanceof QvaPayError)) log.error(`${route}: ${(err as Error).message}`)
			return json(err instanceof QvaPayError && err.status < 500 ? 400 : 500, { error: msg })
		}
	}

	// ── Cuenta ──────────────────────────────────────────────────────────

	private async me({ sid }: Ctx) {
		const acc = await this.accounts.get(sid).catch(() => null)
		if (!acc) return json(200, { connected: false, dryRun: this.dryRun })
		const me = await acc.client.me().catch(() => acc.me)
		acc.me = me
		return json(200, {
			connected: true,
			dryRun: this.dryRun,
			username: me.username,
			balance: me.balance,
			kyc: me.kyc,
			p2pEnabled: me.p2p_enabled,
			gold: me.golden_check,
		})
	}

	private async connect({ req, url, sid }: Ctx) {
		if (!this.allowConnect(req)) return json(429, { error: 'Demasiados intentos de conexión. Espera unos minutos.' })
		const body = await readJson(req)
		// Solo un filtro básico: quien decide si el token vale es QvaPay
		const token = String(body.token ?? '')
			.trim()
			.replace(/^Bearer\s+/i, '')
		if (token.length < 10 || token.length > 500 || /\s/.test(token))
			return json(400, { error: 'El token está vacío, incompleto o tiene espacios. Cópialo entero desde qvapay.com/dev/tokens.' })
		const newSid = sid ?? this.accounts.newSid()
		let acc: Account
		try {
			acc = await this.accounts.connect(newSid, token, { remember: body.remember === true })
		} catch (err) {
			if (err instanceof QvaPayError && err.code === 'INSUFFICIENT_SCOPE')
				return json(400, { error: 'El token necesita el permiso "read" para identificar tu cuenta. Créalo con read + p2p:buy y/o p2p:sell.' })
			if (err instanceof QvaPayError && err.status === 401) return json(400, { error: 'El token no es válido: revisa que esté completo y activo en tu cuenta de QvaPay.' })
			throw err
		}
		this.market.wake()
		log.info('cuenta conectada')
		return json(200, { connected: true, username: acc.me.username }, { 'Set-Cookie': cookie(url, newSid, 60 * 60 * 24 * 30) })
	}

	private async disconnect({ url, sid }: Ctx) {
		if (sid) await this.accounts.disconnect(sid)
		return json(200, { connected: false }, { 'Set-Cookie': cookie(url, '', 0) })
	}

	private allowConnect(req: Request) {
		const ip = req.headers.get('cf-connecting-ip') ?? 'local'
		const now = Date.now()
		const recent = (this.connectAttempts.get(ip) ?? []).filter((t) => now - t < CONNECT_WINDOW_MS)
		if (recent.length >= CONNECT_MAX) return false
		recent.push(now)
		this.connectAttempts.set(ip, recent)
		return true
	}

	// ── Operaciones ─────────────────────────────────────────────────────

	private async trades(acc: Account) {
		const list = await acc.client.listOffers({ my: true, take: 50 })
		const { trades, openOffers } = toTrades(list.data, acc.me.uuid)
		// Las órdenes de tus ofertas por rango solo vienen en su detalle
		const flex = openOffers.filter((o) => o.kind === 'flexible').slice(0, FLEX_WATCH)
		// Si un detalle falla, sus órdenes de la lectura anterior siguen: si desaparecieran un ciclo,
		// al volver no se sabría qué cambió entretanto y se perdería el aviso
		const before = this.seen?.user === acc.me.uuid ? (this.seen.last?.trades ?? []) : []
		const previousOrders = (offer: string) => before.filter((t) => t.offerUuid === offer && t.role === 'owner' && t.order)
		const orders = await Promise.all(
			flex.map((o) =>
				acc.client
					.getOffer(o.offerUuid)
					.then((d) => orderTrades(d, acc.me.uuid))
					.catch(() => previousOrders(o.offerUuid)),
			),
		)
		const ids = new Set(trades.map((t) => t.id))
		for (const t of orders.flat()) if (!ids.has(t.id)) trades.push(t)
		await Promise.all(
			trades
				.filter((t) => CHAT_ACTIVE.has(t.status))
				.slice(0, CHAT_WATCH)
				.map(async (t) => {
					const chat = await acc.client.getChat(t.offerUuid, t.order ?? undefined).catch(() => null)
					const last = chat?.at(-1)
					t.chat = chat ? { count: chat.length, lastId: last?.id ?? null, lastMine: last?.peer_id === acc.me.uuid, lastText: last?.message?.slice(0, 140) ?? null } : null
				}),
		)
		// Los avisos se calculan contra la lectura anterior de esta misma cuenta
		if (this.seen?.user !== acc.me.uuid) this.seen = { user: acc.me.uuid, last: null, sent: new Set() }
		const seen = this.seen
		const alerts = tradeAlerts(seen.last, trades, Date.now(), seen.sent, openOffers)
		for (const a of alerts) seen.sent.add(a.key)
		// Si un chat no se pudo leer, se conserva su resumen anterior para no avisar dos veces
		const prevChat = new Map(seen.last?.trades.map((t) => [t.id, t.chat]))
		for (const t of trades) if (t.chat === null) t.chat = prevChat.get(t.id) ?? null
		seen.last = { trades, openOffers }
		return json(200, { trades, openOffers, alerts, pending: pendingCount(trades), dryRun: this.dryRun })
	}

	private async trade({ url }: Ctx, acc: Account) {
		const offer = url.searchParams.get('offer') ?? ''
		const order = url.searchParams.get('order') || undefined
		const o = await acc.client.getOffer(offer)
		const ord = order ? o.Orders?.find((x) => x.uuid === order) : undefined
		const chat = await acc.client.getChat(offer, order).catch(() => [])
		const isOwner = o.User?.uuid === acc.me.uuid
		// Solo tu calificación: la que te dieron no se muestra, porque las notas se pueden
		// cambiar durante 72 h y verla invitaría a la represalia
		const { mine } = ratingsOf(o, order)
		return json(200, {
			offer,
			order: order ?? null,
			myRating: mine,
			coin: o.coin,
			type: o.type,
			status: ord?.status ?? o.status,
			usd: num(ord?.amount ?? o.amount),
			coinAmount: num(ord?.receive ?? o.receive),
			txId: ord?.tx_id ?? o.tx_id ?? null,
			expiresAt: ord?.payment_window_expires_at ?? o.payment_window_expires_at ?? null,
			// Los datos de pago de la oferta son los de su creador
			ownerDetails: paymentDetails(o.details),
			isOwner,
			counterparty: isOwner ? (ord?.Taker ?? o.Peer)?.username : o.User?.username,
			chat: chat.slice(-30).map((m) => ({
				mine: m.peer_id === acc.me.uuid,
				moderator: !!m.is_moderator,
				text: m.message,
				image: m.image,
				at: m.created_at,
			})),
		})
	}

	// ── Ofertas: publicar, ver, editar, pausar y tomar ───────────────────

	// Campos de pago que pide cada moneda (GET /coins es público; se guarda en memoria)
	private async coins(acc: Account) {
		if (!this.coinFields) {
			const fields: Record<string, PaymentField[]> = {}
			for (const cat of await acc.client.coins())
				for (const c of cat.Coins ?? []) if (TICKS.has(c.tick)) fields[c.tick] = (c.working_data ?? []).filter((f) => f && f.name)
			this.coinFields = fields
		}
		return json(200, { fields: this.coinFields })
	}

	private async offer({ url }: Ctx, acc: Account) {
		const o = await acc.client.getOffer(url.searchParams.get('offer') ?? '')
		return json(200, offerView(o, acc.me.uuid))
	}

	private async createOffer({ req }: Ctx, acc: Account) {
		const b = await readJson(req)
		const type = b.type === 'buy' || b.type === 'sell' ? b.type : null
		const coin = String(b.coin ?? '')
		if (!type || !TICKS.has(coin)) return json(400, { error: 'Elige si compras o vendes USD y el mercado' })
		const terms = offerTerms(b, b.kind === 'flexible')
		if ('error' in terms) return json(400, terms)
		const details = (Array.isArray(b.details) ? b.details : [])
			.map((d: { name?: unknown; value?: unknown }) => ({ name: String(d?.name ?? '').slice(0, 60), value: String(d?.value ?? '').trim().slice(0, 200) }))
			.filter((d: { name: string; value: string }) => d.name && d.value)
			.slice(0, 10)
		if (!details.length) return json(400, { error: 'Completa tus datos de pago' })
		const key = String(b.idempotencyKey ?? '')
		const body: CreateOfferBody = {
			type,
			coin,
			amount: terms.amount,
			receive: terms.receive,
			details,
			private: b.private === false ? 0 : 1,
			only_vip: b.onlyVip ? 1 : 0,
			...(terms.kind === 'flexible' ? { offer_kind: 'flexible' as const, order_min: terms.orderMin, order_max: terms.orderMax } : {}),
			...(terms.requirements ? { requirements: terms.requirements } : {}),
			...(typeof b.message === 'string' && b.message.trim() ? { message: b.message.trim().slice(0, 79) } : {}),
			...(/^[A-Za-z0-9._-]{8,64}$/.test(key) ? { idempotency_key: key } : {}),
		}
		const r = await acc.client.createOffer(body)
		return json(200, { ok: true, offer: r.p2p.uuid, message: r.duplicate ? 'La oferta ya estaba publicada' : 'Oferta publicada' })
	}

	private async editOffer({ req }: Ctx, acc: Account) {
		const b = await readJson(req)
		const o = await acc.client.getOffer(String(b.offer ?? ''))
		if (o.User?.uuid !== acc.me.uuid) return json(403, { error: 'Solo puedes editar tus ofertas' })
		if (o.status !== 'open') return json(400, { error: 'Solo se edita una oferta publicada y sin contraparte' })
		const flexible = o.offer_kind === 'flexible'
		const terms = offerTerms(b, flexible, true)
		if ('error' in terms) return json(400, terms)
		const body: EditOfferBody = flexible
			? { available_amount: terms.amount, receive: terms.receive, order_min: terms.orderMin, order_max: terms.orderMax }
			: { amount: terms.amount, receive: terms.receive }
		if (b.requirements !== undefined) body.requirements = terms.requirements ?? {}
		await acc.client.editOffer(o.uuid, body)
		return json(200, { ok: true, message: 'Oferta actualizada' })
	}

	private async pauseOffer({ req }: Ctx, acc: Account) {
		const b = await readJson(req)
		const paused = b.paused === true
		await acc.client.pauseOffer(String(b.offer ?? ''), paused)
		return json(200, { ok: true, message: paused ? 'Oferta pausada: ya no aparece en el mercado' : 'Oferta de nuevo en el mercado' })
	}

	private async applyOffer({ req }: Ctx, acc: Account) {
		const b = await readJson(req)
		// Estado fresco antes de comprometer nada
		const o = await acc.client.getOffer(String(b.offer ?? ''))
		if (o.User?.uuid === acc.me.uuid) return json(400, { error: 'Es tu propia oferta' })
		if (o.status !== 'open' || o.pause) return json(409, { error: 'Esta oferta ya no está disponible' })
		let amount: number | undefined
		if (o.offer_kind === 'flexible') {
			amount = Math.round(Number(b.amount) * 100) / 100
			const min = num(o.order_min ?? 0)
			const max = Math.min(num(o.order_max ?? Infinity), num(o.available_amount ?? o.amount))
			if (!(amount >= min && amount <= max)) return json(400, { error: `El monto debe estar entre ${min} y ${max} USD` })
		}
		const r = await acc.client.applyOffer(o.uuid, amount)
		return json(200, { ok: true, offer: o.uuid, order: r.order ?? null, message: 'Tomaste la oferta' })
	}

	private async action({ req }: Ctx, acc: Account) {
		const b = await readJson(req)
		const offer = String(b.offer ?? '')
		const order = b.order ? String(b.order) : undefined
		const c = acc.client
		switch (b.action) {
			case 'paid': {
				const tx = String(b.txId ?? '').trim()
				if (!tx) return json(400, { error: 'Indica la referencia de tu transferencia' })
				await c.markPaid(offer, tx.slice(0, 120), order)
				return json(200, { ok: true, message: 'Marcado como pagado' })
			}
			case 'release': {
				// Estado fresco: solo se libera lo que está en "pagado"
				const o = await c.getOffer(offer)
				const status = order ? o.Orders?.find((x) => x.uuid === order)?.status : o.status
				if (status !== 'paid') return json(400, { error: `La operación está en «${status ?? 'desconocido'}», no en pagado. No se libera.` })
				const r = await c.markReceived(offer, order)
				return json(200, { ok: true, message: r && r.amount != null ? `Liberado: la contraparte recibe ${r.amount} USD netos (comisión ${r.fee ?? 0}).` : 'Liberado' })
			}
			case 'cancel':
			case 'dispute':
			case 'cancel_offer': {
				const r = await c.cancelOrder(offer, order)
				return json(200, { ok: true, message: r.message })
			}
			case 'chat': {
				const text = String(b.message ?? '').trim()
				if (!text) return json(400, { error: 'Mensaje vacío' })
				await c.sendChat(offer, text.slice(0, 599), order)
				return json(200, { ok: true })
			}
			case 'rate': {
				const rating = Math.min(5, Math.max(1, Math.round(Number(b.rating) || 5)))
				await c.rate(offer, order, rating)
				return json(200, { ok: true, message: 'Calificación enviada' })
			}
		}
		return json(400, { error: 'Acción desconocida' })
	}
}

// ── Ofertas: validación y vista ────────────────────────────────────────

const round2 = (n: number) => Math.round(n * 100) / 100

// Monto, precio, límites por orden y requisitos de una oferta, con los rangos de QvaPay
// En una edición por partes el máximo por orden puede superar lo que queda disponible
// (QvaPay toma el menor de los dos al aplicar), así que no se compara con el monto
export function offerTerms(b: Record<string, unknown>, flexible: boolean, editing = false) {
	const amount = round2(Number(b.amount))
	const price = Number(b.price)
	if (!(amount >= 0.1 && amount <= 10_000)) return { error: 'El monto debe estar entre 0,1 y 10.000 USD' }
	if (!(price > 0)) return { error: 'Pon el precio por cada USD' }
	const receive = round2(amount * price)
	if (!(receive >= 0.1 && receive <= 100_000_000)) return { error: 'El total a recibir está fuera de los límites de QvaPay' }
	let orderMin: number | undefined
	let orderMax: number | undefined
	if (flexible) {
		orderMin = round2(Number(b.orderMin))
		orderMax = round2(Number(b.orderMax))
		if (!(orderMin > 0 && orderMax >= orderMin && (editing || orderMax <= amount)))
			return { error: editing ? 'Revisa el mínimo y el máximo por orden: mínimo ≤ máximo' : 'Revisa el mínimo y el máximo por orden: mínimo ≤ máximo ≤ monto' }
	}
	let requirements: Requirements | undefined
	if (b.requirements && typeof b.requirements === 'object') {
		requirements = {}
		for (const [k, v] of Object.entries(b.requirements as Record<string, unknown>)) {
			const n = Number(v)
			if (!n) continue
			const allowed = REQUIREMENTS[k as keyof Requirements]
			if (!allowed?.includes(n)) return { error: 'Requisito no válido' }
			requirements[k as keyof Requirements] = n
		}
		if (!Object.keys(requirements).length) requirements = undefined
	}
	return { amount, receive, price, kind: flexible ? ('flexible' as const) : ('fixed' as const), orderMin, orderMax, requirements }
}

// Las calificaciones de una operación (en las de rango, las de esa orden): la que diste y la que te dieron
export function ratingsOf(o: P2POffer, order?: string) {
	const me = o.currentUserId == null ? null : String(o.currentUserId)
	const list = (o.Ratings ?? []).filter((r) => !order || !r.order_id || r.order_id === order)
	const view = (r?: (typeof list)[number]) => (r ? { rating: Number(r.rating), editableUntil: r.editable_until ?? null } : null)
	return {
		mine: me ? view(list.find((r) => String(r.rater) === me)) : null,
		theirs: me ? view(list.find((r) => String(r.rated) === me)) : null,
	}
}

// Lo que muestra el terminal de una oferta (propia o ajena)
export function offerView(o: P2POffer, meUuid: string) {
	const isOwner = o.User?.uuid === meUuid
	const usd = num(o.amount)
	const receive = num(o.receive)
	return {
		offer: o.uuid,
		type: o.type,
		coin: o.coin,
		status: o.status,
		kind: o.offer_kind === 'flexible' ? 'flexible' : 'fixed',
		usd,
		coinAmount: receive,
		price: usd ? receive / usd : 0,
		available: o.available_amount == null ? null : num(o.available_amount),
		reserved: o.reserved_amount == null ? null : num(o.reserved_amount),
		orderMin: o.order_min == null ? null : num(o.order_min),
		orderMax: o.order_max == null ? null : num(o.order_max),
		pause: o.pause ?? null,
		requirements: o.requirements ?? null,
		isPrivate: !!o.private,
		onlyVip: !!o.only_vip,
		isOwner,
		// El detalle de una oferta no siempre trae el conteo de operaciones: sin él, null (no un 0 falso)
		owner: o.User
			? { username: o.User.username, ops: o.User._count ? (o.User._count.P2P ?? 0) + (o.User._count.P2P_Peer ?? 0) : null, rating: o.User.rating_count ? (o.User.rating_avg ?? null) : null }
			: null,
		peer: o.Peer?.username ?? null,
		details: isOwner ? paymentDetails(o.details) : [],
		orders: isOwner
			? (o.Orders ?? []).map((x) => ({ order: x.uuid, status: x.status, usd: num(x.amount), coinAmount: num(x.receive), taker: x.Taker?.username ?? null, createdAt: x.created_at ?? null }))
			: [],
	}
}

// ── Utilidades ─────────────────────────────────────────────────────────

export function json(status: number, body: unknown, headers: Record<string, string> = {}) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
	})
}

// Cookie de sesión: Secure en cuanto la página va por HTTPS
function cookie(url: URL, value: string, maxAge: number) {
	return `sid=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${url.protocol === 'https:' ? '; Secure' : ''}`
}

function parseCookies(header: string | null): Record<string, string> {
	const out: Record<string, string> = {}
	for (const part of (header ?? '').split(';')) {
		const i = part.indexOf('=')
		if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim())
	}
	return out
}

// Las escrituras solo desde nuestra propia página
function sameOrigin(req: Request, url: URL) {
	if (req.headers.get('x-broker') !== '1') return false
	const origin = req.headers.get('origin')
	return !origin || origin === url.origin
}

async function readJson(req: Request): Promise<Record<string, any>> {
	const text = await req.text()
	if (text.length > MAX_BODY) throw new Error('Cuerpo demasiado grande')
	return text ? JSON.parse(text) : {}
}

// Errores de QvaPay en lenguaje claro
function friendly(err: unknown): string {
	if (!(err instanceof QvaPayError)) return (err as Error).message
	const map: Record<string, string> = {
		INSUFFICIENT_SCOPE: 'Tu token no tiene permiso para esto (revisa p2p:buy / p2p:sell en qvapay.com/dev/tokens)',
		PEER_REQUIREMENTS_NOT_MET: 'No cumples los requisitos del anunciante',
		OFFER_PAUSED: 'La oferta está pausada',
		FLEXIBLE_NOT_ENABLED: 'Tu cuenta todavía no puede tomar ofertas por rango',
		ORDER_ALREADY_ACTIVE: 'Ya tienes una orden activa en esa oferta',
		ORDER_IN_DISPUTE: 'La orden está en disputa: la resuelve un moderador',
		KYC_REQUIRED: 'Tu cuenta necesita KYC aprobado',
		DUPLICATE_REQUEST: 'Ya hay una petición igual en curso',
		FLEXIBLE_OFFER_EXISTS: 'Ya tienes una oferta por rango de ese lado en este mercado: edítala o cancélala antes',
		OFFER_HAS_OPEN_ORDERS: 'La oferta tiene órdenes en curso: termínalas o pausa la oferta',
		OFFER_NOT_EDITABLE: 'Alguien tomó la oferta mientras la editabas',
		FLEXIBLE_AMOUNT_REQUIRED: 'Indica cuántos USD tomas',
		INVALID_REQUIREMENTS: 'Requisito no válido',
	}
	if (err.code && map[err.code]) return map[err.code]
	if (err.status === 409) return 'La oferta ya no está disponible (la tomó otra persona o cambió)'
	if (err.status === 429) return 'Demasiadas acciones seguidas: espera unos segundos y vuelve a intentarlo'
	const body = err.body as { error?: string } | undefined
	return body?.error ?? err.message
}
