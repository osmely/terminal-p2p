import { logger } from '../log.ts'
import { QVAPAY_BUCKETS, RateLimiter, type BucketName } from '../ratelimit.ts'
import type {
	Averages,
	ChatMessage,
	CoinCategory,
	CompletedRates,
	CreateOfferBody,
	EditOfferBody,
	ListParams,
	Me,
	P2POffer,
	Paginated,
	SavedMethod,
} from './types.ts'

const log = logger('qvapay')

export const API_BASE = 'https://api.qvapay.com'

export class QvaPayError extends Error {
	readonly status: number
	readonly code?: string
	readonly body: unknown

	constructor(status: number, message: string, code?: string, body?: unknown) {
		super(`${status}${code ? ` ${code}` : ''}: ${message}`)
		this.status = status
		this.code = code
		this.body = body
	}
}

interface RequestOpts {
	bucket: BucketName
	query?: Record<string, string | number | boolean | undefined>
	body?: unknown
	// Un formulario con archivo (imagen del chat): va tal cual y el navegador pone su Content-Type
	form?: FormData
	// Las escrituras solo se reintentan ante 429 (no se ejecutaron), salvo `idempotent`
	write?: boolean
	idempotent?: boolean
	// Mercado, lado y monto de la operación para las métricas anónimas del relé de Terminal P2P
	// (cabecera X-TP-Meta: el relé no la reenvía a QvaPay)
	meta?: OpMeta
}

export interface OpMeta {
	coin?: string
	side?: string
	usd?: number
	// Desde qué parte del terminal se hizo (p. ej. 'swap' para «Vender ya»)
	via?: string
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export class QvaPayClient {
	readonly dryRun: boolean
	// Sin token solo funcionan los endpoints públicos (/coins, /p2p/averages…)
	private readonly token: string | undefined
	// En el navegador las peticiones pasan por el relé del propio dominio (/qp),
	// porque QvaPay no permite CORS desde otros orígenes
	private readonly baseUrl: string
	private readonly limiter = new RateLimiter(QVAPAY_BUCKETS)

	constructor(opts: { token?: string; dryRun: boolean; baseUrl?: string }) {
		this.baseUrl = (opts.baseUrl ?? API_BASE).replace(/\/$/, '')
		this.token = opts.token
		this.dryRun = opts.dryRun
	}

	// ── Lectura ────────────────────────────────────────────────────────────

	me() {
		return this.request<Me>('GET', '/user', { bucket: 'general' })
	}

	averages() {
		return this.request<Averages>('GET', '/p2p/averages', { bucket: 'averages' })
	}

	completedRates(coin: string) {
		return this.request<CompletedRates>('GET', '/p2p/completed_pairs_average', { bucket: 'completed', query: { coin } })
	}

	listOffers(params: ListParams) {
		const query: RequestOpts['query'] = { ...params, my: params.my ? 'true' : undefined }
		return this.request<Paginated<P2POffer>>('GET', '/p2p', { bucket: 'list', query })
	}

	// Los métodos de pago que el usuario guardó en QvaPay (solo lectura)
	paymentMethods() {
		return this.request<SavedMethod[]>('GET', '/user/payment-methods', { bucket: 'general' })
	}

	async getOffer(uuid: string) {
		const res = await this.request<{ p2p: P2POffer }>('GET', `/p2p/${uuid}`, { bucket: 'general' })
		return res.p2p
	}

	async getChat(uuid: string, order?: string) {
		const res = await this.request<{ chat: ChatMessage[] }>('GET', `/p2p/${uuid}/chat`, {
			bucket: 'general',
			query: { order },
		})
		// QvaPay los devuelve del más nuevo al más antiguo: se ordenan cronológicamente para que
		// el último del array sea el último mensaje (chat de abajo arriba, avisos de mensaje nuevo)
		return [...(res.chat ?? [])].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at) || Number(a.id) - Number(b.id))
	}

	// Monedas y sus campos de pago (público)
	coins() {
		return this.request<CoinCategory[]>('GET', '/coins', { bucket: 'coins' })
	}

	// ── Escritura (en simulación no se envían) ───────────────────────────────────────

	// Publicar una oferta. Con idempotency_key se puede reintentar sin duplicarla
	async createOffer(body: CreateOfferBody) {
		if (this.dryRun) {
			log.info('[DRY] POST /p2p/create', body)
			return { p2p: { uuid: 'dry-run', ...body, status: 'open' } as unknown as P2POffer, duplicate: false }
		}
		return this.request<{ p2p: P2POffer; duplicate?: boolean }>('POST', '/p2p/create', {
			bucket: 'create',
			body,
			write: true,
			idempotent: !!body.idempotency_key,
		})
	}

	async editOffer(uuid: string, body: EditOfferBody) {
		if (this.dryRun) return void log.info(`[DRY] POST /p2p/${uuid}/edit`, body)
		await this.request('POST', `/p2p/${uuid}/edit`, { bucket: 'edit', body, write: true })
	}

	// Pausar es idempotente: repetirlo deja el mismo estado
	async pauseOffer(uuid: string, paused: boolean) {
		if (this.dryRun) return void log.info(`[DRY] POST /p2p/${uuid}/pause`, { paused })
		await this.request('POST', `/p2p/${uuid}/pause`, { bucket: 'pause', body: { paused }, write: true, idempotent: true })
	}

	// Tomar una oferta ajena (en las de rango, una parte entre el mínimo y el máximo)
	async applyOffer(uuid: string, amount?: number, meta?: OpMeta) {
		if (this.dryRun) {
			log.info(`[DRY] POST /p2p/${uuid}/apply`, { amount })
			return { order: null as string | null }
		}
		return this.request<{ message: string; order?: string | null }>('POST', `/p2p/${uuid}/apply`, {
			bucket: 'apply',
			body: amount === undefined ? {} : { amount },
			write: true,
			meta,
		})
	}

	async markPaid(uuid: string, txId: string, order?: string) {
		if (this.dryRun) return void log.info(`[DRY] POST /p2p/${uuid}/paid${order ? `?order=${order}` : ''}`)
		await this.request('POST', `/p2p/${uuid}/paid`, { bucket: 'paid', query: { order }, body: { tx_id: txId }, write: true })
	}

	async markReceived(uuid: string, order?: string, meta?: OpMeta) {
		if (this.dryRun) {
			log.info(`[DRY] POST /p2p/${uuid}/received${order ? `?order=${order}` : ''}`)
			return { amount: 0, fee: 0, gross_amount: 0 }
		}
		return this.request<{ amount: number; fee: number; gross_amount: number }>('POST', `/p2p/${uuid}/received`, {
			bucket: 'received',
			query: { order },
			write: true,
			meta,
		})
	}

	async cancelOrder(uuid: string, order?: string) {
		if (this.dryRun) {
			log.info(`[DRY] POST /p2p/${uuid}/cancel${order ? `?order=${order}` : ''}`)
			return { message: 'dry-run' }
		}
		return this.request<{ message: string; status?: string }>('POST', `/p2p/${uuid}/cancel`, {
			bucket: 'cancel',
			query: { order },
			write: true,
		})
	}

	// Calificar; si ya calificaste, QvaPay pide PATCH para cambiarla (dentro de su plazo de 72 h)
	async rate(uuid: string, order: string | undefined, rating: number, comment?: string) {
		if (this.dryRun) return void log.info(`[DRY] POST /p2p/${uuid}/rate`, { order, rating })
		// Sin etiquetas automáticas: "rápido" o "confiable" no valen para una mala nota
		const opts = { bucket: 'general' as const, body: { order, rating, comment }, write: true }
		try {
			await this.request('POST', `/p2p/${uuid}/rate`, opts)
		} catch (err) {
			if (!(err instanceof QvaPayError && err.code === 'ALREADY_RATED')) throw err
			await this.request('PATCH', `/p2p/${uuid}/rate`, opts)
		}
	}

	// Imagen al chat (JPG, PNG o GIF; QvaPay la reduce a 1000×1000 como mucho), con un texto opcional
	async sendChatImage(uuid: string, file: Blob, name: string, message?: string, order?: string) {
		if (this.dryRun) return void log.info(`[DRY] POST /p2p/${uuid}/chat (imagen)${order ? `?order=${order}` : ''}`)
		const form = new FormData()
		form.append('file', file, name)
		if (message) form.append('message', message)
		await this.request('POST', `/p2p/${uuid}/chat`, { bucket: 'general', query: { order }, form, write: true })
	}

	async sendChat(uuid: string, message: string, order?: string) {
		if (this.dryRun) return void log.info(`[DRY] POST /p2p/${uuid}/chat${order ? `?order=${order}` : ''}`)
		await this.request('POST', `/p2p/${uuid}/chat`, { bucket: 'general', query: { order }, body: { message }, write: true })
	}

	// ── Transporte ─────────────────────────────────────────────────────────

	private async request<T = unknown>(method: string, path: string, opts: RequestOpts): Promise<T> {
		const url = new URL(this.baseUrl + path)
		for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v))

		const maxAttempts = 4
		for (let attempt = 1; ; attempt++) {
			let res: Response
			try {
				res = await this.limiter.run(opts.bucket, () =>
					fetch(url, {
						method,
						// Las lecturas siempre preguntan al servidor: una copia vieja del navegador congelaría precios
						cache: method === 'GET' ? 'no-cache' : undefined,
						headers: {
							...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
							Accept: 'application/json',
							...(opts.body !== undefined && !opts.form ? { 'Content-Type': 'application/json' } : {}),
							...(opts.meta ? { 'X-TP-Meta': new URLSearchParams(Object.entries(opts.meta).filter(([, v]) => v != null).map(([k, v]) => [k, String(v)])).toString() } : {}),
						},
						body: opts.form ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined),
						signal: AbortSignal.timeout(20_000),
					}),
				)
			} catch (err) {
				// Error de red: no sabemos si la escritura llegó, así que solo reintentamos si es idempotente
				if ((!opts.write || opts.idempotent) && attempt < maxAttempts) {
					await sleep(1000 * 2 ** attempt)
					continue
				}
				throw err
			}

			const text = await res.text()
			let data: any = undefined
			try {
				data = text ? JSON.parse(text) : undefined
			} catch {
				data = text
			}

			if (res.ok) return data as T

			const retryable = res.status === 429 || (res.status >= 500 && (!opts.write || opts.idempotent))
			if (retryable && attempt < maxAttempts) {
				const retryAfter = Number(res.headers.get('retry-after')) * 1000 || 2000 * 2 ** attempt
				if (res.status === 429) this.limiter.penalize(opts.bucket, retryAfter)
				log.warn(`${method} ${path} → ${res.status}, reintento ${attempt}/${maxAttempts - 1} en ${retryAfter} ms`)
				await sleep(retryAfter)
				continue
			}

			const message = (data && typeof data === 'object' && (data.error || data.message)) || res.statusText
			throw new QvaPayError(res.status, String(message), data?.code, data)
		}
	}
}
