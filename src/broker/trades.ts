// Convierte "mis ofertas" de QvaPay (GET /p2p?my=true) en operaciones vistas
// desde el usuario: qué lado juega, si le toca pagar y qué puede hacer ahora.

import { num, type P2POffer, type P2PUser, type Pause } from '../qvapay/types.ts'

export type Action = 'pay' | 'cancel' | 'wait_payment' | 'release' | 'dispute' | 'wait_release' | 'wait_moderator' | 'rate' | 'cancel_offer'

export interface Trade {
	id: string
	offerUuid: string
	order: string | null
	coin: string
	offerType: 'buy' | 'sell'
	role: 'owner' | 'taker'
	// Desde el usuario: compra o vende USD
	side: 'buy' | 'sell'
	// Paga por fuera (transferencia) quien compra USD
	payer: boolean
	status: string
	usd: number
	coinAmount: number
	price: number
	counterparty: { username: string; ops: number; rating: number | null; image?: string | null } | null
	kind: 'fixed' | 'flexible'
	updatedAt: string | null
	// Fin del plazo de pago (solo tiene sentido mientras se espera el pago)
	expiresAt: string | null
	// Resumen del chat de las operaciones en curso, para avisar de mensajes nuevos
	chat?: ChatSummary | null
	actions: Action[]
	// Solo en tus ofertas publicadas
	pause?: Pause | null
	available?: number | null
	orderMin?: number | null
	orderMax?: number | null
	isPrivate?: boolean
}

export interface ChatSummary {
	count: number
	// El último mensaje: un mensaje nuevo cambia este id aunque la API devuelva un número fijo de mensajes
	lastId?: string | null
	lastMine: boolean
	lastText: string | null
}

const FINAL = new Set(['completed', 'cancelled'])

function party(u?: P2PUser | null) {
	if (!u) return null
	return { username: u.username, ops: (u._count?.P2P ?? 0) + (u._count?.P2P_Peer ?? 0), rating: u.rating_count ? (u.rating_avg ?? null) : null, image: u.image ?? null }
}

export function actionsFor(status: string, payer: boolean, role: 'owner' | 'taker', hasPeer: boolean): Action[] {
	if (status === 'open') return role === 'owner' && !hasPeer ? ['cancel_offer'] : []
	if (status === 'processing') return payer ? ['pay', 'cancel'] : ['wait_payment', 'dispute']
	if (status === 'paid') return payer ? ['wait_release'] : ['release', 'dispute']
	if (status === 'revision') return ['wait_moderator']
	if (status === 'completed') return ['rate']
	return []
}

export function toTrades(offers: P2POffer[], meUuid: string): { trades: Trade[]; openOffers: Trade[] } {
	const trades: Trade[] = []
	const openOffers: Trade[] = []
	for (const o of offers) {
		const isOwner = o.User?.uuid === meUuid
		const kind = o.offer_kind === 'flexible' ? 'flexible' : 'fixed'

		// Parte tomada de una oferta por rango ajena
		if (!isOwner && o.my_order) {
			const side = o.type === 'sell' ? 'buy' : 'sell'
			const usd = num(o.my_order.amount)
			const coinAmount = num(o.my_order.receive)
			trades.push({
				id: `${o.uuid}:${o.my_order.uuid}`,
				offerUuid: o.uuid,
				order: o.my_order.uuid,
				coin: o.coin,
				offerType: o.type,
				role: 'taker',
				side,
				payer: side === 'buy',
				status: o.my_order.status,
				usd,
				coinAmount,
				price: usd ? coinAmount / usd : 0,
				counterparty: party(o.User),
				kind,
				updatedAt: o.my_order.created_at ?? o.updated_at ?? null,
				expiresAt: o.my_order.payment_window_expires_at ?? o.payment_window_expires_at ?? null,
				actions: actionsFor(o.my_order.status, side === 'buy', 'taker', true),
			})
			continue
		}

		// Una oferta ajena que volvió a estar abierta ya no es una operación tuya
		if (!isOwner && o.status === 'open') continue

		const role = isOwner ? 'owner' : 'taker'
		// Dueño de una sell o taker de una buy: vende USD
		const side: 'buy' | 'sell' = (o.type === 'sell') === isOwner ? 'sell' : 'buy'
		const usd = num(o.amount)
		const coinAmount = num(o.receive)
		const t: Trade = {
			id: o.uuid,
			offerUuid: o.uuid,
			order: null,
			coin: o.coin,
			offerType: o.type,
			role,
			side,
			payer: side === 'buy',
			status: o.status,
			usd,
			coinAmount,
			price: usd ? coinAmount / usd : 0,
			counterparty: party(isOwner ? o.Peer : o.User),
			kind,
			updatedAt: o.updated_at ?? null,
			expiresAt: o.payment_window_expires_at ?? null,
			actions: actionsFor(o.status, side === 'buy', role, !!o.Peer),
		}
		if (o.status === 'open' && isOwner) {
			t.pause = o.pause ?? null
			t.available = o.available_amount == null ? null : num(o.available_amount)
			t.orderMin = o.order_min == null ? null : num(o.order_min)
			t.orderMax = o.order_max == null ? null : num(o.order_max)
			t.isPrivate = !!o.private
			openOffers.push(t)
		}
		else if (!FINAL.has(o.status) || o.status === 'completed') trades.push(t)
	}
	return { trades, openOffers }
}

// Órdenes que otros tomaron de una oferta por rango tuya. Solo vienen en el
// detalle de la oferta (GET /p2p/:uuid), no en el listado
export function orderTrades(o: P2POffer, meUuid: string): Trade[] {
	if (o.User?.uuid !== meUuid) return []
	// Dueño de una venta: vende USD y recibe el pago; dueño de una compra: paga
	const side: 'buy' | 'sell' = o.type === 'sell' ? 'sell' : 'buy'
	return (o.Orders ?? [])
		.filter((x) => x.status !== 'cancelled')
		.map((x) => {
			const usd = num(x.amount)
			const coinAmount = num(x.receive)
			return {
				id: `${o.uuid}:${x.uuid}`,
				offerUuid: o.uuid,
				order: x.uuid,
				coin: o.coin,
				offerType: o.type,
				role: 'owner' as const,
				side,
				payer: side === 'buy',
				status: x.status,
				usd,
				coinAmount,
				price: usd ? coinAmount / usd : 0,
				counterparty: party(x.Taker),
				kind: 'flexible' as const,
				updatedAt: x.created_at ?? null,
				expiresAt: x.payment_window_expires_at ?? null,
				actions: actionsFor(x.status, side === 'buy', 'owner', true),
			}
		})
}

// Los datos de pago llegan como objeto o como lista según la ruta
export function paymentDetails(d: P2POffer['details']): { name: string; value: string }[] {
	if (!d) return []
	if (Array.isArray(d)) return d.filter((x) => x && x.value)
	return Object.entries(d).map(([name, value]) => ({ name, value: String(value) }))
}
