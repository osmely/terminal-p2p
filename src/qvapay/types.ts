// Formas de respuesta de la API P2P de QvaPay (https://www.qvapay.com/docs/p2p/list).
// Los decimales llegan como string en el listado y como number en el detalle.

export type Num = string | number
export type OfferType = 'buy' | 'sell'
export type OfferStatus = 'open' | 'processing' | 'paid' | 'revision' | 'completed' | 'cancelled'

export interface P2PUser {
	uuid: string
	username: string
	name?: string
	kyc?: boolean
	vip?: boolean
	golden_check?: boolean
	rating_avg?: number
	rating_count?: number
	_count?: { P2P?: number; P2P_Peer?: number }
}

export interface Pause {
	reason: 'owner' | 'taker_left'
	until: string | null
}

export interface P2POrder {
	uuid: string
	amount: Num
	receive: Num
	status: string
	payment_window_expires_at?: string | null
	tx_id?: string | null
	created_at?: string
	Taker?: P2PUser
}

export interface P2POffer {
	uuid: string
	type: OfferType
	coin: string
	amount: Num
	receive: Num
	status: OfferStatus
	only_vip?: boolean
	private?: boolean
	offer_kind?: 'fixed' | 'flexible'
	available_amount?: Num | null
	reserved_amount?: Num | null
	order_min?: Num | null
	order_max?: Num | null
	pause?: Pause | null
	requirements?: Record<string, number> | null
	created_at?: string
	updated_at?: string
	// Fin del plazo para pagar una vez tomada la oferta
	payment_window_expires_at?: string | null
	User?: P2PUser
	Peer?: P2PUser | null
	Orders?: P2POrder[]
	// Solo visibles para el creador y la contraparte
	details?: Record<string, string> | { name: string; value: string }[] | null
	tx_id?: string | null
	// Con my=true, en una oferta por rango de la que tomaste una parte
	my_order?: { uuid: string; amount: Num; receive: Num; status: string; created_at?: string; payment_window_expires_at?: string | null } | null
	requirements_met?: boolean
}

// Datos de una moneda (GET /coins): working_data son los campos de pago que pide
export interface PaymentField {
	name: string
	type?: string
	label?: string
	placeholder?: string
	required?: boolean
	options?: { value: string }[]
}

export interface Coin {
	tick: string
	name: string
	enabled_p2p?: boolean
	working_data?: PaymentField[] | null
}

export interface CoinCategory {
	name: string
	Coins?: Coin[]
}

export type Requirements = Partial<Record<'min_completed' | 'min_rating' | 'min_account_days' | 'min_trustscore', number>>

export interface CreateOfferBody {
	type: OfferType
	coin: string
	amount: number
	receive: number
	details: { name: string; value: string }[]
	offer_kind?: 'fixed' | 'flexible'
	order_min?: number
	order_max?: number
	requirements?: Requirements
	only_vip?: 0 | 1
	private?: 0 | 1
	message?: string
	idempotency_key?: string
}

export interface EditOfferBody {
	amount?: number
	available_amount?: number
	receive?: number
	order_min?: number
	order_max?: number
	requirements?: Requirements
	message?: string | null
	only_vip?: 0 | 1
}

export interface Paginated<T> {
	current_page: number
	data: T[]
	per_page: number
	total: number
	promoted?: { slot: unknown; offer: P2POffer | null } | null
}

export interface ListParams {
	page?: number
	take?: number
	type?: OfferType
	coin?: string
	orderBy?: 'updated_at' | 'created_at' | 'amount' | 'receive' | 'ratio' | 'best_rate' | 'rating' | 'trades'
	orderType?: 'asc' | 'desc'
	my?: boolean
	status?: OfferStatus
	offer_kind?: 'fixed' | 'flexible'
}

export interface ChatMessage {
	id: string
	peer_id: string
	message: string | null
	image: string | null
	created_at: string
	is_moderator?: boolean
	moderator_name?: string | null
}

export interface Averages {
	[coin: string]: {
		name: string
		average: number
		average_buy: number
		average_sell: number
		median?: number
		median_buy?: number
		median_sell?: number
		count: number
		window_hours?: number
	}
}

// GET /p2p/completed_pairs_average: tasas de las operaciones completadas (48 h, sin fecha)
export interface CompletedRates {
	average: number
	average_buy: number
	average_sell: number
	median_buy: number
	median_sell: number
	count: number
	window_hours: number
	offers: number[]
}

export interface Me {
	uuid: string
	username: string
	balance: number
	kyc: boolean
	golden_check: boolean
	p2p_enabled: boolean
}

export const num = (v: Num | null | undefined): number => (v == null ? 0 : typeof v === 'number' ? v : Number(v))
