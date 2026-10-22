// API de "Mis operaciones". Corre en el navegador de cada usuario con su
// propio token: el dinero nunca pasa por aquí, sigue en el escrow de QvaPay.
// Usa Request/Response estándar, así que también se prueba en Node.

import { logger } from '../log.ts'
import { QvaPayError, type QvaPayClient } from '../qvapay/client.ts'
import { num, type Me } from '../qvapay/types.ts'
import type { Market } from '../terminal/market.ts'
import { pendingCount, tradeAlerts } from './alerts.ts'
import { paymentDetails, toTrades, type Trade } from './trades.ts'

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
			if (err instanceof QvaPayError && err.status === 401) return json(400, { error: 'QvaPay rechazó el token: revisa que esté completo y no revocado.' })
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
		await Promise.all(
			trades
				.filter((t) => CHAT_ACTIVE.has(t.status))
				.slice(0, CHAT_WATCH)
				.map(async (t) => {
					const chat = await acc.client.getChat(t.offerUuid, t.order ?? undefined).catch(() => null)
					const last = chat?.at(-1)
					t.chat = chat ? { count: chat.length, lastMine: last?.peer_id === acc.me.uuid, lastText: last?.message?.slice(0, 140) ?? null } : null
				}),
		)
		// Los avisos se calculan contra la lectura anterior de esta misma cuenta
		if (this.seen?.user !== acc.me.uuid) this.seen = { user: acc.me.uuid, last: null, sent: new Set() }
		const seen = this.seen
		const alerts = tradeAlerts(seen.last, trades, Date.now(), seen.sent)
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
		return json(200, {
			offer,
			order: order ?? null,
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
				return json(200, { ok: true, message: `Liberado. Neto ${r.amount} USD, comisión ${r.fee}.` })
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
	}
	if (err.code && map[err.code]) return map[err.code]
	if (err.status === 409) return 'La oferta ya no está disponible (la tomó otra persona o cambió)'
	if (err.status === 429) return 'QvaPay pide esperar: demasiadas peticiones seguidas'
	const body = err.body as { error?: string } | undefined
	return body?.error ?? err.message
}
