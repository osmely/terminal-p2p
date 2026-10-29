// API de "Mis operaciones". Corre en el navegador de cada usuario con su
// propio token: el dinero nunca pasa por aquí, sigue en el escrow de QvaPay.
// Usa Request/Response estándar, así que también se prueba en Node.

import { P2P_FEE } from '../qvapay/fees.ts'
import type { SavedMethod } from '../qvapay/types.ts'
import { logger } from '../log.ts'
import { QvaPayError, type QvaPayClient } from '../qvapay/client.ts'
import { num, type CreateOfferBody, type EditOfferBody, type Me, type P2POffer, type P2PUser, type PaymentField, type Requirements } from '../qvapay/types.ts'
import { COINS, type Market } from '../terminal/market.ts'
import { reputationScore } from '../terminal/ranking.ts'
import { pendingCount, tradeAlerts } from './alerts.ts'
import { tradeStats } from './stats.ts'
import { orderTrades, paymentDetails, toTrades, type Trade } from './trades.ts'

const STATS_MS = 10 * 60_000

export interface Account {
	sid: string
	me: Me
	client: QvaPayClient
	// Huella del token para el plan Pro: HMAC del token calculado aquí, en el navegador. El servidor solo
	// ve esta huella (de la que no se puede sacar el token)
	print?: string
	// Tus operaciones completadas y tu valoración en P2P (para saber qué ofertas con requisitos puedes tomar)
	stats?: { completed: number; rating: number | null; at: number }
}

// Dónde vive la cuenta conectada (en el navegador: su almacenamiento local)
export interface AccountStore {
	get(sid: string | undefined): Promise<Account | null>
	connect(sid: string, token: string, opts?: { remember?: boolean }): Promise<Account>
	disconnect(sid: string): Promise<void>
	newSid(): string
	// Bloqueada en Terminal P2P: se olvida la cuenta en memoria (el token se queda guardado) y un rato no se pregunta
	blocked?(sid: string | undefined, err: QvaPayError): void
}

// Bloqueada desde el panel de Terminal P2P (el relé responde 403 con este código)
const isBlocked = (err: unknown): err is QvaPayError => err instanceof QvaPayError && err.code === 'TP_ACCOUNT_BLOCKED'

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
// Imágenes del chat: los tipos que acepta QvaPay y un tope (el terminal las reduce antes de enviarlas)
const CHAT_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif'])
export const CHAT_IMAGE_MAX = 2 * 1024 * 1024

const REQUIREMENTS: Record<keyof Requirements, number[]> = {
	min_completed: [5, 10, 25, 50, 100],
	min_rating: [4, 4.5],
	min_account_days: [7, 30, 90, 180, 365],
	min_trustscore: [50, 85],
}

// Lectura anterior de cada cuenta, para saber qué cambió
interface Seen {
	user: string
	last: { trades: Trade[]; openOffers: Trade[] } | null
	sent: Set<string>
}

// Una toma de la orden inteligente o del radar. pay: comprando, a quién pagar, cuánto y hasta cuándo
type Pay = { details: { name: string; value: string }[]; expiresAt: string | null; coinAmount: number }
// code: el de QvaPay o el nuestro (p. ej. TP_ACCOUNT_RESTRICTED: tu cuenta tiene limitado el terminal)
type TakeStep = { offer: string; user: string; status: 'pending' | 'taken' | 'skipped' | 'failed' | 'stuck'; order: string | null; error?: string; code?: string; pay?: Pay }

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
	private swapQuotes = new Map<string, { user: string; at: number; offers: SwapOffer[] }>()

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
				case 'GET /print': {
					const acc = await this.accounts.get(ctx.sid).catch(() => null)
					return json(200, { print: acc?.print ?? null })
				}
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
				case 'GET /stats':
					return await this.stats(acc)
				case 'GET /trade':
					return await this.trade(ctx, acc)
				case 'POST /trade/action':
					return await this.action(ctx, acc)
				case 'POST /trade/image':
					return await this.chatImage(ctx, acc)
				case 'GET /coins':
					return await this.coins(acc)
				case 'GET /payment-methods':
					return await this.paymentMethods(acc)
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
				case 'POST /smart':
					return await this.smart(ctx, acc)
				case 'POST /radar/take':
					return await this.radarTake(ctx, acc)
				case 'GET /peer':
					return await this.peer(ctx, acc)
				case 'GET /swap/quote':
					return await this.swapQuote(ctx, acc)
				case 'POST /swap':
					return await this.swap(ctx, acc)
			}
			return json(404, { error: 'Ruta desconocida' })
		} catch (err) {
			const msg = friendly(err)
			if (!(err instanceof QvaPayError)) log.error(`${route}: ${(err as Error).message}`)
			if (isBlocked(err)) this.accounts.blocked?.(ctx.sid, err)
			// Los códigos nuestros (TP_…) llegan al terminal para que pueda reaccionar (p. ej. avisar del bloqueo)
			const code = err instanceof QvaPayError && err.code?.startsWith('TP_') ? err.code : undefined
			return json(err instanceof QvaPayError && err.status < 500 ? 400 : 500, { error: msg, ...(code ? { code } : {}) })
		}
	}

	// ── Cuenta ──────────────────────────────────────────────────────────

	private async me({ sid }: Ctx) {
		// Bloqueada en Terminal P2P: sale desconectada, con el motivo para que el terminal lo diga
		const off = (err: QvaPayError) => {
			this.accounts.blocked?.(sid, err)
			return json(200, { connected: false, dryRun: this.dryRun, blocked: friendly(err) })
		}
		let acc: Account | null
		try {
			acc = await this.accounts.get(sid)
		} catch (err) {
			if (isBlocked(err)) return off(err)
			acc = null
		}
		if (!acc) return json(200, { connected: false, dryRun: this.dryRun })
		let me: Account['me']
		try {
			me = await acc.client.me()
		} catch (err) {
			if (isBlocked(err)) return off(err)
			me = acc.me
		}
		acc.me = me
		// Cambian poco: se piden como mucho cada STATS_MS (el saldo, en cambio, en cada /me)
		if (!acc.stats || Date.now() - acc.stats.at > STATS_MS) {
			const x = await acc.client.extended().catch(() => null)
			if (x) acc.stats = { completed: x.p2p_completed_count ?? 0, rating: x.p2p_raters_count ? (x.p2p_average_rating ?? null) : null, at: Date.now() }
		}
		return json(200, {
			connected: true,
			dryRun: this.dryRun,
			username: me.username,
			balance: me.balance,
			kyc: me.kyc,
			p2pEnabled: me.p2p_enabled,
			gold: me.golden_check,
			image: me.image ?? null,
			p2pCompleted: acc.stats?.completed ?? null,
			p2pRating: acc.stats?.rating ?? null,
			// La comisión al liberar (la paga quien compra; GOLD no): el terminal muestra los netos con ella
			p2pFee: P2P_FEE,
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
		// En el navegador las peticiones a /api/broker no llevan cookie: la cuenta se borra siempre
		await this.accounts.disconnect(sid ?? '')
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

	// «Mi cuenta»: estadísticas con tus últimas ofertas y tomas (hasta STATS_PAGES páginas de QvaPay)
	private async stats(acc: Account) {
		const trades: Trade[] = []
		let pages = 0
		let more = true
		while (more && pages < STATS_PAGES) {
			const list = await acc.client.listOffers({ my: true, take: 50, page: ++pages })
			trades.push(...toTrades(list.data, acc.me.uuid).trades)
			more = list.data.length === 50 && pages * 50 < list.total
		}
		return json(200, { stats: tradeStats(trades), partial: more })
	}

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
			counterpartyImage: (isOwner ? (ord?.Taker ?? o.Peer) : o.User)?.image ?? null,
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

	// Lo que el usuario guardó en QvaPay para cobrar (tarjetas, cuentas): solo para rellenar su formulario
	private async paymentMethods(acc: Account) {
		const list = await acc.client.paymentMethods().catch(() => [])
		const fields = (d: SavedMethod['details']) =>
			typeof d === 'string' ? (d.trim() ? { '': d.trim() } : {}) : Object.fromEntries(Object.entries(d ?? {}).filter(([, v]) => typeof v === 'string' && v.trim()))
		const methods = (Array.isArray(list) ? list : []).map((m) => ({ name: m.name, coin: m.coin?.tick ?? null, fields: fields(m.details) })).filter((m) => Object.keys(m.fields).length)
		return json(200, { methods })
	}

	private async offer({ url }: Ctx, acc: Account) {
		const o = await acc.client.getOffer(url.searchParams.get('offer') ?? '')
		return json(200, offerView(o, acc.me.uuid))
	}

	private async createOffer({ req }: Ctx, acc: Account) {
		const body = createBody(await readJson(req))
		if ('error' in body) return json(400, body)
		const r = await acc.client.createOffer(body)
		return json(200, { ok: true, offer: r.p2p.uuid, message: r.duplicate ? 'La oferta ya estaba publicada' : 'Oferta publicada' })
	}

	// ── Orden inteligente ───────────────────────────────────────────────

	// Como una orden límite de exchange: toma lo que se pueda de lo que ya cruza con tu precio y publica el
	// resto. No se cancela nunca nada: una oferta que ya no sirve (cambió, desapareció) se salta y su parte
	// se suma a lo que publicas. Antes y después de cada toma se vuelve a leer la oferta, para no tomar nada
	// que ya no cruce y para confirmar de verdad lo tomado (un corte de red puede esconder una toma hecha)
	private async smart({ req }: Ctx, acc: Account) {
		const b = await readJson(req)
		const side: 'buy' | 'sell' | null = b.side === 'buy' || b.side === 'sell' ? b.side : null
		const coin = String(b.coin ?? '')
		const limit = Number(b.price)
		if (!side || !TICKS.has(coin) || !(limit > 0)) return json(400, { error: 'Orden no válida' })
		const takes = (Array.isArray(b.takes) ? b.takes : []).map((t: { offer?: unknown; amount?: unknown }) => ({ offer: String(t?.offer ?? ''), amount: round2(Number(t?.amount)) }))
		if (!takes.length || takes.length > SMART_TAKES) return json(400, { error: `La orden inteligente toma entre 1 y ${SMART_TAKES} ofertas` })
		// La oferta para el resto llega siempre (aunque sea por 0): si se salta alguna toma, su parte va ahí
		const template = (b.offer && typeof b.offer === 'object' ? b.offer : {}) as Record<string, unknown>
		const baseRest = round2(Math.max(0, Number(template.amount) || 0))
		const details = side === 'sell' ? payDetails(b.details) : []
		if (side === 'sell' && !details.length) return json(400, { error: 'Pon tus datos para recibir el pago' })
		const total = round2(takes.reduce((s: number, t: { amount: number }) => s + t.amount, 0) + baseRest)
		// El resto con su monto final, validado. Siempre entero, nunca por partes: así son como mucho tres
		// operaciones y, comprando, como mucho tres pagos
		const restBody = (amount: number) => createBody({ ...template, type: side, coin, amount, kind: 'fixed', orderMin: undefined, orderMax: undefined })
		// Si todo saliera mal, se publicaría el total: tiene que ser publicable ya
		const check = restBody(total)
		if ('error' in check) return json(400, check)

		const steps: TakeStep[] = takes.map((t: { offer: string }) => ({ offer: t.offer, user: '—', status: 'pending', order: null }))
		const notes: string[] = []

		if (side === 'sell') {
			// Vendiendo, entre lo que tomas y lo que publicas se reserva el total
			const me = await acc.client.me()
			acc.me = me
			if (total > num(me.balance) + 1e-9) return json(200, { ok: false, nothingDone: true, error: `No tienes saldo suficiente: necesitas ${total.toLocaleString('en-US')} USD y tienes ${num(me.balance).toLocaleString('en-US')}.`, steps })
		}

		let chatSent: boolean | undefined
		for (const [i, t] of takes.entries()) {
			const r = await this.takeStep(acc, t, side, coin, limit, details, 'smart')
			steps[i] = r.step
			notes.push(...r.notes)
			if (r.chatSent !== undefined) chatSent = (chatSent ?? true) && r.chatSent
		}

		// 3) Publicar el resto: lo planeado más lo que no se pudo tomar
		const missed = round2(takes.reduce((s: number, t: { amount: number }, i: number) => s + (steps[i].status === 'skipped' || steps[i].status === 'failed' ? t.amount : 0), 0))
		const rest = round2(baseRest + missed)
		let published: string | null = null
		let publishError: string | undefined
		if (rest >= 0.1) {
			try {
				const body = restBody(rest)
				if ('error' in body) throw new Error(body.error)
				published = (await acc.client.createOffer(body)).p2p.uuid
			} catch (e) {
				publishError = friendly(e)
			}
		}
		return json(200, { ok: true, steps, published, rest, publishError, chatSent, notes })
	}

	// Una toma de la orden inteligente o del radar: 1) comprueba que la oferta sigue sirviendo tal como se planeó,
	// 2) la toma y lo confirma con una lectura nueva (un corte de red puede esconder una toma hecha) y 3) vendiendo,
	// le manda tus datos de pago al comprador por el chat. Nunca cancela nada
	private async takeStep(acc: Account, t: { offer: string; amount: number }, side: 'buy' | 'sell', coin: string, limit: number, details: { label: string; value: string }[], via: string) {
		const step: TakeStep = { offer: t.offer, user: '—', status: 'pending', order: null }
		const notes: string[] = []
		const o = await acc.client.getOffer(t.offer).catch(() => null)
		step.user = o?.User?.username ?? '—'
		const user = step.user
		const problem = takeProblem(o, t.amount, side, coin, limit, acc.me.uuid)
		if (problem) return { step: { ...step, status: 'skipped' as const, error: problem }, notes }
		const flexible = o!.offer_kind === 'flexible'
		const before = new Set((o!.Orders ?? []).map((x) => x.uuid))
		let error: string | undefined
		let code: string | undefined
		let order: string | null = null
		try {
			order = (await acc.client.applyOffer(o!.uuid, flexible ? t.amount : undefined, { coin, side: o!.type, usd: t.amount, via })).order ?? null
		} catch (e) {
			error = friendly(e)
			code = e instanceof QvaPayError ? e.code : undefined
		}
		const now = await acc.client.getOffer(o!.uuid).catch(() => null)
		const held = now ? heldTake(now, flexible, before, order, acc.me.uuid) : error ? 'unknown' : { order, price: null }
		if (held === 'unknown') {
			// No se sabe si quedó tomada: no se cuenta como tomada ni como libre (podrías comprar de más) y se avisa
			notes.push(`No se pudo confirmar si la oferta de @${user} quedó tomada: revísala en «Mis operaciones». Sus ${t.amount.toLocaleString('en-US')} USD no se sumaron a tu oferta.`)
			return { step: { ...step, status: 'stuck' as const, error: `no se pudo confirmar si quedó tomada (${error})` }, notes }
		}
		if (!held) return { step: { ...step, status: 'failed' as const, error: error ?? 'no quedó tomada', ...(code ? { code } : {}) }, notes }
		step.status = 'taken'
		step.order = held.order
		if (side === 'buy' && now) {
			const ord = held.order ? now.Orders?.find((x) => x.uuid === held.order) : undefined
			step.pay = {
				details: paymentDetails(now.details),
				expiresAt: ord?.payment_window_expires_at ?? now.payment_window_expires_at ?? null,
				coinAmount: round2(t.amount * (held.price ?? limit)),
			}
		}
		// Su dueño cambió el precio justo antes de tomarla: no se cancela, se avisa (comprando, la puedes
		// cancelar tú sin disputa mientras no la hayas pagado)
		if (held.price != null && (side === 'buy' ? held.price > limit * (1 + 1e-9) : held.price < limit * (1 - 1e-9)))
			notes.push(
				`@${user} cambió el precio justo antes: ${side === 'buy' ? 'compraste' : 'vendiste'} a ${held.price.toLocaleString('en-US')}, ${side === 'buy' ? 'por encima' : 'por debajo'} de tu ${limit.toLocaleString('en-US')}.${side === 'buy' ? ' Si no la has pagado, puedes cancelarla en «Mis operaciones» sin disputa.' : ''}`,
			)
		// Vendiendo, el comprador recibe tus datos por el chat
		let chatSent: boolean | undefined
		if (side === 'sell') {
			const text = `Hola. Vendo ${t.amount} USD desde Terminal P2P. Págame aquí:\n${details.map((d) => `${d.label}: ${d.value}`).join('\n')}`
			chatSent = await acc.client
				.sendChat(o!.uuid, text.slice(0, 599), held.order ?? undefined)
				.then(() => true)
				.catch(() => false)
			if (!chatSent) notes.push(`No se pudo mandar tus datos a @${user}: escríbeselos por el chat de la operación.`)
		}
		return { step, notes, chatSent }
	}

	// Radar de Pro: toma una oferta que cumplió tus reglas, con las mismas comprobaciones que la orden
	// inteligente (sigue igual, cruza con tu precio, su dueño tiene historial) y sin publicar nada
	private async radarTake({ req }: Ctx, acc: Account) {
		const b = await readJson(req)
		const side: 'buy' | 'sell' | null = b.side === 'buy' || b.side === 'sell' ? b.side : null
		const coin = String(b.coin ?? '')
		const limit = Number(b.price)
		const t = { offer: String(b.offer ?? ''), amount: round2(Number(b.amount)) }
		if (!side || !TICKS.has(coin) || !(limit > 0) || !t.offer || !(t.amount >= 0.1)) return json(400, { error: 'Toma no válida' })
		const details = side === 'sell' ? payDetails(b.details) : []
		if (side === 'sell' && !details.length) return json(400, { error: 'Pon tus datos para recibir el pago' })
		if (side === 'sell') {
			const me = await acc.client.me()
			acc.me = me
			if (t.amount > num(me.balance) + 1e-9) return json(200, { ok: false, error: `No tienes saldo suficiente: necesitas ${t.amount.toLocaleString('en-US')} USD y tienes ${num(me.balance).toLocaleString('en-US')}.` })
		}
		const r = await this.takeStep(acc, t, side, coin, limit, details, 'radar')
		return json(200, { ok: r.step.status === 'taken', ...r })
	}

	private async editOffer({ req }: Ctx, acc: Account) {
		const b = await readJson(req)
		const o = await acc.client.getOffer(String(b.offer ?? ''))
		if (o.User?.uuid !== acc.me.uuid) return json(403, { error: 'Solo puedes editar tus ofertas' })
		if (o.status !== 'open') return json(400, { error: 'Solo se edita una oferta publicada y sin contraparte' })
		const flexible = o.offer_kind === 'flexible'
		// Pasar una fija a por partes: lleva sus límites por orden y se valida como al publicarla (máximo ≤ monto)
		const toFlexible = !flexible && b.toFlexible === true
		const terms = offerTerms(b, flexible || toFlexible, flexible)
		if ('error' in terms) return json(400, terms)
		const body: EditOfferBody = flexible
			? { available_amount: terms.amount, receive: terms.receive, order_min: terms.orderMin, order_max: terms.orderMax }
			: toFlexible
				? { offer_kind: 'flexible', amount: terms.amount, receive: terms.receive, order_min: terms.orderMin, order_max: terms.orderMax }
				: { amount: terms.amount, receive: terms.receive }
		if (b.requirements !== undefined) body.requirements = terms.requirements ?? {}
		if (typeof b.onlyVip === 'boolean' && b.onlyVip !== !!o.only_vip) body.only_vip = b.onlyVip ? 1 : 0
		// QvaPay solo deja pasarla de privada a pública
		if (b.makePublic === true && o.private) body.private = false
		// El mensaje público lo guarda QvaPay solo a cuentas GOLD (a las demás lo ignora sin decir nada); vaciarlo, cualquiera
		if (typeof b.message === 'string') {
			const message = b.message.trim().slice(0, 79)
			if (message !== (o.message ?? '')) {
				if (message && !acc.me.golden_check) return json(400, { error: 'El mensaje público es solo para cuentas GOLD de QvaPay' })
				body.message = message || null
			}
		}
		await acc.client.editOffer(o.uuid, body)
		return json(200, { ok: true, message: toFlexible ? 'Oferta actualizada: ahora se toma por partes' : 'Oferta actualizada' })
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
		const r = await acc.client.applyOffer(o.uuid, amount, { coin: o.coin, side: o.type, usd: amount ?? num(o.amount) })
		return json(200, { ok: true, offer: o.uuid, order: r.order ?? null, message: 'Tomaste la oferta' })
	}

	// Imagen al chat de una operación (un comprobante, una captura del banco)
	private async chatImage({ req }: Ctx, acc: Account) {
		const form = await req.formData()
		const file = form.get('file')
		const offer = String(form.get('offer') ?? '')
		const order = form.get('order') ? String(form.get('order')) : undefined
		const message = String(form.get('message') ?? '').trim().slice(0, 599)
		if (!(file instanceof Blob) || !CHAT_IMAGE_TYPES.has(file.type)) return json(400, { error: 'Solo se pueden enviar imágenes JPG, PNG o GIF' })
		if (file.size > CHAT_IMAGE_MAX) return json(413, { error: 'La imagen es demasiado grande (máximo 2 MB)' })
		const ext = file.type === 'image/png' ? 'png' : file.type === 'image/gif' ? 'gif' : 'jpg'
		await acc.client.sendChatImage(offer, file, `imagen.${ext}`, message || undefined, order)
		return json(200, { ok: true })
	}

	// ── Ficha de un usuario ─────────────────────────────────────────────

	// Su perfil y sus ofertas abiertas en todos los mercados. QvaPay no da el historial de otro
	// usuario: solo lo que tiene publicado ahora. El perfil llega con sus ofertas; sin ninguna
	// abierta, profile es null y el terminal usa lo que ya sabe de él
	private async peer({ url }: Ctx, acc: Account) {
		const user = (url.searchParams.get('user') ?? '').replace(/^@/, '')
		if (!/^[A-Za-z0-9._-]{1,40}$/.test(user)) return json(400, { error: 'Usuario no válido' })
		const res = await acc.client.listOffers({ peer: user, take: PEER_TAKE })
		const mine = res.data.filter((o) => o.User?.username?.toLowerCase() === user.toLowerCase() && o.status === 'open')
		return json(200, { user, profile: peerProfile(mine[0]?.User), offers: mine.map(peerOffer), total: res.total })
	}

	// ── Vender ya: vender saldo a la mejor oferta de compra de una cuenta VIP ──

	// Ofertas de compra de cuentas VIP en un mercado, de mejor a peor precio, y la mejor en la que cabe
	// ?amount. Sin las solo-VIP (no las puede tomar cualquiera), las propias, las de requisitos que no
	// cumples y las de precio atípico. Se leen de QvaPay como mucho cada SWAP_FRESH_MS (o con ?fresh=1)
	private async swapQuote({ url }: Ctx, acc: Account) {
		const coin = url.searchParams.get('coin') ?? ''
		if (!TICKS.has(coin)) return json(400, { error: 'Mercado no válido' })
		let q = this.swapQuotes.get(coin)
		if (!q || q.user !== acc.me.uuid || url.searchParams.get('fresh') === '1' || Date.now() - q.at > SWAP_FRESH_MS) {
			const res = await acc.client.listOffers({ type: 'buy', coin, vip_maker: 1, orderBy: 'best_rate', orderType: 'desc', take: SWAP_TAKE })
			const offers = res.data
				.filter((o) => o.status === 'open' && !o.pause && !o.only_vip && o.User?.uuid !== acc.me.uuid && o.requirements_met !== false)
				.map(swapOffer)
				.filter((o) => o.usd > 0 && o.price > 0)
			q = { user: acc.me.uuid, at: Date.now(), offers: dropOutliers(offers).sort((a, b) => b.price - a.price) }
			this.swapQuotes.set(coin, q)
		}
		return json(200, { coin, offers: q.offers, best: bestSwap(q.offers, round2(Number(url.searchParams.get('amount')))), at: q.at })
	}

	// Toma la oferta y le pasa al VIP por el chat dónde pagarte. Antes comprueba con el estado
	// fresco que sigue abierta, que es de una cuenta VIP y que el precio no bajó del que viste
	private async swap({ req }: Ctx, acc: Account) {
		const b = await readJson(req)
		const o = await acc.client.getOffer(String(b.offer ?? ''))
		if (o.User?.uuid === acc.me.uuid) return json(400, { error: 'Es tu propia oferta' })
		if (o.type !== 'buy' || o.User?.vip === false) return json(400, { error: 'Vender ya solo vende a ofertas de compra de cuentas VIP' })
		if (o.status !== 'open' || o.pause) return json(409, { error: 'Esa oferta ya no está disponible. Actualizo el precio.' })
		const q = swapOffer(o)
		const minPrice = Number(b.minPrice)
		if (minPrice > 0 && q.price < minPrice * (1 - 1e-9)) return json(409, { error: `El precio bajó a ${q.price.toLocaleString('en-US')} mientras decidías. Revisa el nuevo precio.` })
		const amount = round2(Number(b.amount))
		if (q.kind === 'flexible' ? !(amount >= (q.orderMin ?? 0) && amount <= q.orderMax!) : amount !== q.usd)
			return json(409, { error: 'El monto ya no cabe en esa oferta. Actualizo el precio.' })
		const details = (Array.isArray(b.details) ? b.details : [])
			.map((d: { name?: unknown; label?: unknown; value?: unknown }) => ({ label: String(d?.label ?? d?.name ?? '').slice(0, 60), value: String(d?.value ?? '').trim().slice(0, 200) }))
			.filter((d: { label: string; value: string }) => d.label && d.value)
			.slice(0, 10)
		if (!details.length) return json(400, { error: 'Pon tus datos para recibir el pago' })
		// Saldo fresco: no se vende más de lo que tienes
		const me = await acc.client.me()
		acc.me = me
		if (amount > num(me.balance)) return json(400, { error: `No tienes saldo suficiente: tienes ${num(me.balance).toLocaleString('en-US')} USD` })
		const r = await acc.client.applyOffer(o.uuid, q.kind === 'flexible' ? amount : undefined, { coin: o.coin, side: o.type, usd: amount, via: 'swap' })
		this.swapQuotes.delete(o.coin)
		const order = r.order ?? undefined
		// Si el chat falla, la orden ya está tomada: se avisa para que los mande a mano
		const text = `Hola. Vendo ${amount} USD desde Terminal P2P. Págame aquí:\n${details.map((d: { label: string; value: string }) => `${d.label}: ${d.value}`).join('\n')}`
		const chatSent = await acc.client
			.sendChat(o.uuid, text.slice(0, 599), order)
			.then(() => true)
			.catch(() => false)
		return json(200, { ok: true, offer: o.uuid, order: order ?? null, chatSent, message: 'Venta en marcha' })
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
				const usd = num((order ? o.Orders?.find((x) => x.uuid === order)?.amount : undefined) ?? o.amount)
				const r = await c.markReceived(offer, order, { coin: o.coin, side: o.type, usd })
				return json(200, { ok: true, message: r && r.amount != null ? `Liberado: la contraparte recibe ${Number(r.amount).toLocaleString('en-US')} USD netos (comisión ${Number(r.fee ?? 0).toLocaleString('en-US')}).` : 'Liberado' })
			}
			case 'cancel_offer': {
				// Estado fresco: si alguien la tomó mientras la tenías abierta, cancelarla en QvaPay no la cancela,
				// abre una disputa con quien la tomó (venta) o la devuelve al mercado (compra). Solo se cancela
				// publicada; en una por partes QvaPay ya rechaza cancelarla entera con órdenes en curso
				const o = await c.getOffer(offer)
				if (o.offer_kind !== 'flexible' && o.status !== 'open')
					return json(409, { error: 'Alguien acaba de tomar tu oferta y ya no se puede cancelar: ábrela para ver la operación.', status: o.status })
				const r = await c.cancelOrder(offer, order)
				return json(200, { ok: true, message: r.message })
			}
			case 'cancel':
			case 'dispute': {
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
				return json(200, { ok: true, message: 'Calificación guardada' })
			}
		}
		return json(400, { error: 'Acción desconocida' })
	}
}

// ── Ficha de un usuario ────────────────────────────────────────────────

const PEER_TAKE = 100

export function peerProfile(u: P2PUser | undefined | null) {
	if (!u) return null
	const owner = u._count?.P2P ?? 0
	const taker = u._count?.P2P_Peer ?? 0
	return {
		username: u.username,
		image: u.image ?? null,
		kyc: !!u.kyc,
		vip: !!u.vip,
		gold: !!u.golden_check,
		phone: u.phone_verified ?? null,
		telegram: u.telegram_verified ?? null,
		// Operaciones completadas: publicando él la oferta y tomando las de otros
		opsOwner: owner,
		opsTaker: taker,
		rating: u.rating_count ? (u.rating_avg ?? null) : null,
		ratings: u.rating_count ?? 0,
		score: reputationScore(u.rating_count ? (u.rating_avg ?? null) : null, owner + taker),
	}
}

export function peerOffer(o: P2POffer) {
	const amount = num(o.amount)
	const flexible = o.offer_kind === 'flexible'
	const usd = flexible ? num(o.available_amount ?? o.amount) : amount
	return {
		offer: o.uuid,
		coin: o.coin,
		type: o.type,
		price: amount > 0 ? num(o.receive) / amount : 0,
		usd,
		kind: flexible ? ('flexible' as const) : ('fixed' as const),
		orderMin: flexible && o.order_min != null ? num(o.order_min) : null,
		orderMax: flexible ? Math.min(o.order_max != null ? num(o.order_max) : usd, usd) : null,
		vipOnly: !!o.only_vip,
		requirements: o.requirements ?? null,
		// Si los cumples (solo lo sabe el detalle, con tu cuenta): null cuando no pide nada
		requirementsMet: o.requirements_met ?? null,
		requirementsMissing: o.requirements_missing ?? [],
		paused: !!o.pause,
		createdAt: o.created_at ?? null,
		updatedAt: o.updated_at ?? null,
	}
}

// ── Vender ya ──────────────────────────────────────────────────────────

const SWAP_TAKE = 30
const SWAP_FRESH_MS = 15_000
// Lejos de la mediana de las ofertas VIP: casi siempre un error de tipeo
const SWAP_OUTLIER_PCT = 0.35

export interface SwapOffer {
	offer: string
	price: number
	usd: number
	kind: 'fixed' | 'flexible'
	orderMin: number | null
	orderMax: number | null
	user: string
	ops: number | null
	rating: number | null
	gold: boolean
}

export function swapOffer(o: P2POffer): SwapOffer {
	const amount = num(o.amount)
	const flexible = o.offer_kind === 'flexible'
	const usd = flexible ? num(o.available_amount ?? o.amount) : amount
	const u = o.User
	return {
		offer: o.uuid,
		price: amount > 0 ? num(o.receive) / amount : 0,
		usd,
		kind: flexible ? 'flexible' : 'fixed',
		orderMin: flexible && o.order_min != null ? num(o.order_min) : null,
		// QvaPay toma el menor entre el máximo por orden y lo que queda
		orderMax: flexible ? Math.min(o.order_max != null ? num(o.order_max) : usd, usd) : null,
		user: u?.username ?? '—',
		ops: u?._count ? (u._count.P2P ?? 0) + (u._count.P2P_Peer ?? 0) : null,
		rating: u?.rating_count ? (u.rating_avg ?? null) : null,
		gold: !!u?.golden_check,
	}
}

export function dropOutliers<T extends { price: number }>(offers: T[]): T[] {
	if (offers.length < 3) return offers
	const sorted = offers.map((o) => o.price).sort((a, b) => a - b)
	const mid = sorted[Math.floor(sorted.length / 2)]
	return offers.filter((o) => Math.abs(o.price / mid - 1) <= SWAP_OUTLIER_PCT)
}

// Mejor oferta en la que cabe un monto: las de rango aceptan cualquier monto entre su mínimo y
// su máximo; las fijas se toman enteras. offers viene ordenado de mejor a peor precio
export function bestSwap<T extends Pick<SwapOffer, 'usd' | 'kind' | 'orderMin' | 'orderMax'>>(offers: T[], amount: number): T | null {
	if (!(amount > 0)) return null
	return offers.find((o) => (o.kind === 'flexible' ? amount >= (o.orderMin ?? 0) && amount <= (o.orderMax ?? o.usd) : Math.abs(o.usd - amount) < 0.005)) ?? null
}

// ── Ofertas: validación y vista ────────────────────────────────────────

const round2 = (n: number) => Math.round(n * 100) / 100

// Cuerpo para publicar una oferta, validado (de /offer/create y del resto de una orden inteligente)
function createBody(b: Record<string, unknown>): CreateOfferBody | { error: string } {
	const type = b.type === 'buy' || b.type === 'sell' ? b.type : null
	const coin = String(b.coin ?? '')
	if (!type || !TICKS.has(coin)) return { error: 'Elige si compras o vendes USD y el mercado' }
	const terms = offerTerms(b, b.kind === 'flexible')
	if (terms.error !== undefined) return { error: terms.error }
	const details = (Array.isArray(b.details) ? b.details : [])
		.map((d: { name?: unknown; value?: unknown }) => ({ name: String(d?.name ?? '').slice(0, 60), value: String(d?.value ?? '').trim().slice(0, 200) }))
		.filter((d: { name: string; value: string }) => d.name && d.value)
		.slice(0, 10)
	if (!details.length) return { error: 'Completa tus datos de pago' }
	const key = String(b.idempotencyKey ?? '')
	return {
		type,
		coin,
		amount: terms.amount,
		receive: terms.receive,
		details,
		// Pública salvo que pidas lo contrario (como en QvaPay): se anuncia en su canal de Telegram
		private: b.private === true ? 1 : 0,
		only_vip: b.onlyVip ? 1 : 0,
		...(terms.kind === 'flexible' ? { offer_kind: 'flexible' as const, order_min: terms.orderMin, order_max: terms.orderMax } : {}),
		...(terms.requirements ? { requirements: terms.requirements } : {}),
		...(typeof b.message === 'string' && b.message.trim() ? { message: b.message.trim().slice(0, 79) } : {}),
		...(/^[A-Za-z0-9._-]{8,64}$/.test(key) ? { idempotency_key: key } : {}),
	}
}

// Tus datos para cobrar, tal como se le mandan al comprador por el chat
function payDetails(v: unknown) {
	return (Array.isArray(v) ? v : [])
		.map((d: { name?: unknown; label?: unknown; value?: unknown }) => ({ label: String(d?.label ?? d?.name ?? '').slice(0, 60), value: String(d?.value ?? '').trim().slice(0, 200) }))
		.filter((d) => d.label && d.value)
		.slice(0, 10)
}

// Páginas de 50 que lee «Mi cuenta» para las estadísticas
const STATS_PAGES = 4

// Orden inteligente: hasta 2 tomas (QvaPay deja tomar 2 por minuto)
export const SMART_TAKES = 2
// Solo contrapartes con historial: el plan no elige por ti una cuenta nueva solo porque es la más barata
export const SMART_MIN_OPS = 10
export const SMART_MIN_RATING = 4.5

// Si la oferta, leída justo después de tomarla, quedó de verdad en tus manos: con qué orden (en las por
// rango, la tuya nueva) y a qué precio. null si no la tienes
export function heldTake(o: P2POffer, flexible: boolean, before: Set<string>, order: string | null, me: string): { order: string | null; price: number | null } | null {
	const offerPrice = num(o.amount) > 0 ? num(o.receive) / num(o.amount) : null
	if (flexible) {
		const mine = (o.Orders ?? []).find((x) => (order ? x.uuid === order : !before.has(x.uuid) && x.Taker?.uuid === me) && x.status !== 'cancelled')
		if (!mine) return null
		return { order: mine.uuid, price: num(mine.amount) > 0 && num(mine.receive) > 0 ? num(mine.receive) / num(mine.amount) : offerPrice }
	}
	if (o.Peer?.uuid !== me || o.status === 'open' || o.status === 'cancelled') return null
	return { order: null, price: offerPrice }
}

// Por qué una oferta ya no sirve para la orden inteligente (null si sirve tal cual se planeó)
export function takeProblem(o: P2POffer | null, amount: number, side: 'buy' | 'sell', coin: string, limit: number, me: string): string | null {
	if (!o) return 'ya no existe'
	if (o.coin !== coin || o.type !== (side === 'buy' ? 'sell' : 'buy')) return 'no corresponde a esta orden'
	if (o.User?.uuid === me) return 'es tuya'
	if (o.status !== 'open' || o.pause) return 'ya no está disponible'
	if (o.only_vip) return 'es solo para cuentas VIP'
	if (o.requirements_met === false) return 'pide requisitos que no cumples'
	// El detalle de una oferta no trae el historial de su dueño (solo el listado del mercado lo trae): si no
	// viene, vale el que se comprobó al hacer el plan con el libro. Si viene, se vuelve a mirar
	const u = o.User
	if (u?._count || u?.rating_count != null) {
		const ops = (u._count?.P2P ?? 0) + (u._count?.P2P_Peer ?? 0)
		const rating = u.rating_count ? (u.rating_avg ?? 0) : 0
		if (ops < SMART_MIN_OPS || rating < SMART_MIN_RATING) return `tiene poco historial (necesita ${SMART_MIN_OPS} operaciones y ${SMART_MIN_RATING} ★)`
	}
	const price = num(o.amount) > 0 ? num(o.receive) / num(o.amount) : 0
	if (side === 'buy' ? price > limit * (1 + 1e-9) : price < limit * (1 - 1e-9)) return `cambió de precio (${price.toLocaleString('en-US')}) y ya no cruza con el tuyo`
	if (o.offer_kind === 'flexible') {
		const min = num(o.order_min ?? 0)
		const max = round2(Math.min(num(o.order_max ?? Infinity), num(o.available_amount ?? o.amount)))
		if (!(amount >= min && amount <= max)) return `ahora admite entre ${min.toLocaleString('en-US')} y ${max.toLocaleString('en-US')} USD`
	} else if (Math.abs(num(o.amount) - amount) > 0.005) return 'cambió de monto'
	return null
}

// Monto, precio, límites por orden y requisitos de una oferta, con los rangos de QvaPay
// En una edición por partes el máximo por orden puede superar lo que queda disponible
// (QvaPay toma el menor de los dos al aplicar), así que no se compara con el monto
export function offerTerms(b: Record<string, unknown>, flexible: boolean, editing = false) {
	const amount = round2(Number(b.amount))
	const price = Number(b.price)
	if (!(amount >= 0.1 && amount <= 10_000)) return { error: 'El monto debe estar entre 0.1 y 10,000 USD' }
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
	// En una oferta por rango cada orden trae tu valoración (my_rating); la lista general viene vacía
	if (order) {
		const r = o.Orders?.find((x) => x.uuid === order)?.my_rating
		return { mine: r ? { rating: Number(r.rating), editableUntil: r.editable_until ?? null } : null, theirs: null }
	}
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
		// Si tu cuenta los cumple (null si la oferta no pide nada) y, si no, qué falta con tu valor
		requirementsMet: o.requirements_met ?? null,
		requirementsMissing: o.requirements_missing ?? [],
		isPrivate: !!o.private,
		onlyVip: !!o.only_vip,
		message: o.message ?? null,
		isOwner,
		// El detalle de una oferta no siempre trae el conteo de operaciones: sin él, null (no un 0 falso)
		owner: o.User
			? { username: o.User.username, image: o.User.image ?? null, ops: o.User._count ? (o.User._count.P2P ?? 0) + (o.User._count.P2P_Peer ?? 0) : null, rating: o.User.rating_count ? (o.User.rating_avg ?? null) : null }
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
