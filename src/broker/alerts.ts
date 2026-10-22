// Avisos de "Mis operaciones": compara dos lecturas seguidas de tus operaciones
// y dice qué cambió que merezca avisarte (te pagaron, tomaron tu oferta,
// mensaje nuevo, se acaba el plazo de pago…). Sin estado propio: quien llama
// guarda la lectura anterior y las claves ya avisadas.

import { COINS } from '../terminal/market.ts'
import type { Trade } from './trades.ts'

export type AlertKind = 'taken' | 'paid' | 'released' | 'dispute' | 'chat' | 'expiring'

export interface Alert {
	// Única por suceso: sirve para no repetir el aviso
	key: string
	kind: AlertKind
	title: string
	body: string
	offer: string
	order: string | null
	// Requiere que hagas algo (pagar o liberar)
	urgent: boolean
}

// Aviso de plazo cuando quedan 5 minutos o menos
export const EXPIRING_MS = 5 * 60_000

const ACTIVE = new Set(['processing', 'paid', 'revision'])
const fmt = (n: number) => n.toLocaleString('es', { maximumFractionDigits: 2 })
const unit = (coin: string) => COINS.find((c) => c.tick === coin)?.unit ?? coin
const who = (t: Trade) => (t.counterparty ? `@${t.counterparty.username}` : 'La contraparte')

export function tradeAlerts(prev: { trades: Trade[]; openOffers: Trade[] } | null, next: Trade[], now: number, sent: ReadonlySet<string>): Alert[] {
	const out: Alert[] = []
	const push = (t: Trade, kind: AlertKind, key: string, title: string, body: string, urgent = false) => {
		if (sent.has(key)) return
		out.push({ key, kind, title, body, offer: t.offerUuid, order: t.order, urgent })
	}

	const before = new Map(prev?.trades.map((t) => [t.id, t]))
	const wasOpen = new Set(prev?.openOffers.map((t) => t.id))

	for (const t of next) {
		const p = before.get(t.id)
		const money = `${fmt(t.coinAmount)} ${unit(t.coin)}`

		// El plazo se avisa también en la primera lectura: es justo cuando más importa
		if (t.payer && t.status === 'processing' && t.expiresAt) {
			const left = Date.parse(t.expiresAt) - now
			if (left > 0 && left <= EXPIRING_MS)
				push(t, 'expiring', `${t.id}:expiring`, `Quedan ${Math.max(1, Math.round(left / 60_000))} min para pagar`, `Transfiere ${money} a ${who(t)} y marca el pago.`, true)
		}

		// Sin lectura anterior no se sabe qué es nuevo
		if (!prev) continue

		if (!p) {
			// Una oferta tuya que estaba publicada (o que aparece ya tomada)
			if (t.role === 'owner' && ACTIVE.has(t.status) && (wasOpen.has(t.id) || t.status === 'processing'))
				push(
					t,
					'taken',
					`${t.id}:taken`,
					'Tomaron tu oferta',
					`${who(t)} ${t.side === 'sell' ? 'te compra' : 'te vende'} ${fmt(t.usd)} USD. ${t.payer ? `Te toca pagar ${money}.` : `Espera su pago de ${money}.`}`,
					t.payer,
				)
			continue
		}

		if (p.status !== t.status) {
			if (t.status === 'paid' && !t.payer) push(t, 'paid', `${t.id}:paid`, 'Te pagaron: comprueba y libera', `${who(t)} marcó el pago de ${money}. Míralo en tu banco antes de liberar.`, true)
			else if (t.status === 'completed' && t.payer) push(t, 'released', `${t.id}:released`, `Te liberaron ${fmt(t.usd)} USD`, `${who(t)} completó la operación.`)
			else if (t.status === 'revision') push(t, 'dispute', `${t.id}:dispute`, 'La operación pasó a disputa', `Un moderador revisará el chat con ${who(t)}.`)
		}

		if (t.chat && p.chat && t.chat.count > p.chat.count && !t.chat.lastMine)
			push(t, 'chat', `${t.id}:chat:${t.chat.count}`, `Mensaje de ${who(t)}`, t.chat.lastText?.trim() || 'Te envió una imagen.')
	}
	return out
}

// Operaciones que esperan algo de ti ahora mismo (para el contador del título)
export const pendingCount = (trades: Trade[]) => trades.filter((t) => t.actions.includes('pay') || t.actions.includes('release')).length
