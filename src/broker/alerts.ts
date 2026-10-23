// Avisos de "Mis operaciones": compara dos lecturas seguidas de tus operaciones
// y dice qué cambió que merezca avisarte (te pagaron, tomaron tu oferta,
// mensaje nuevo, se acaba el plazo de pago…). Sin estado propio: quien llama
// guarda la lectura anterior y las claves ya avisadas.

import { COINS } from '../terminal/market.ts'
import type { Trade } from './trades.ts'

export type AlertKind = 'taken' | 'paid' | 'released' | 'dispute' | 'chat' | 'expiring' | 'left'

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
// Una oferta fija puede tomarse, abandonarse y volver a tomarse: cada trato es otro aviso
const deal = (t: Trade) => `${t.id}:${t.counterparty?.username ?? ''}`

export function tradeAlerts(
	prev: { trades: Trade[]; openOffers: Trade[] } | null,
	next: Trade[],
	now: number,
	sent: ReadonlySet<string>,
	nextOpen: Trade[] = [],
): Alert[] {
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
				push(t, 'expiring', `${deal(t)}:expiring`, `Quedan ${Math.max(1, Math.round(left / 60_000))} min para pagar`, `Transfiere ${money} a ${who(t)} y marca el pago.`, true)
		}

		// Sin lectura anterior no se sabe qué es nuevo
		if (!prev) continue

		if (!p) {
			// Una oferta tuya que estaba publicada (o que aparece ya tomada)
			if (t.role === 'owner' && ACTIVE.has(t.status) && (wasOpen.has(t.id) || t.status === 'processing'))
				push(
					t,
					'taken',
					`${deal(t)}:taken`,
					'Tomaron tu oferta',
					`${who(t)} ${t.side === 'sell' ? 'te compra' : 'te vende'} ${fmt(t.usd)} USD. ${t.payer ? `Te toca pagar ${money}.` : `Espera su pago de ${money}.`}`,
					t.payer,
				)
			continue
		}

		if (p.status !== t.status) {
			if (t.status === 'paid' && !t.payer) push(t, 'paid', `${deal(t)}:paid`, 'Te pagaron: comprueba y libera', `${who(t)} marcó el pago de ${money}. Míralo en tu banco antes de liberar.`, true)
			else if (t.status === 'completed' && t.payer) push(t, 'released', `${deal(t)}:released`, `Te liberaron ${fmt(t.usd)} USD`, `${who(t)} completó la operación.`)
			else if (t.status === 'revision') push(t, 'dispute', `${deal(t)}:dispute`, 'La operación pasó a disputa', `Un moderador revisará el chat con ${who(t)}.`)
		}

		const newMessage = t.chat && p.chat && (t.chat.lastId && p.chat.lastId ? t.chat.lastId !== p.chat.lastId : t.chat.count > p.chat.count)
		if (newMessage && t.chat && !t.chat.lastMine)
			push(t, 'chat', `${t.id}:chat:${t.chat.lastId ?? t.chat.count}`, `Mensaje de ${who(t)}`, t.chat.lastText?.trim() || 'Te envió una imagen.')
	}

	// Una oferta tuya que vuelve a estar publicada porque la contraparte se fue. Se detecta por la
	// operación que estaba en curso o por la pausa automática de QvaPay (taker_left): esta última
	// avisa también si la tomaron y la dejaron entre dos lecturas, sin llegar a verla en curso
	if (prev) {
		const wasPaused = new Map(prev.openOffers.map((o) => [o.id, o.pause]))
		for (const o of nextOpen) {
			const p = before.get(o.id)
			const wasActive = !!p && ACTIVE.has(p.status)
			const pp = wasPaused.get(o.id)
			const freshPause = o.pause?.reason === 'taker_left' && !(pp?.reason === 'taker_left' && pp.until === o.pause.until)
			if (!wasActive && !freshPause) continue
			const until = o.pause?.until ? new Date(o.pause.until).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' }) : null
			push(
				o,
				'left',
				`${o.id}:left:${o.pause?.until ?? (p ? deal(p) : '')}`,
				'La contraparte dejó tu oferta',
				`${p ? who(p) : 'Quien la tomó'} canceló o se le venció el plazo. ${until ? `Tu oferta vuelve al mercado a las ${until}: revisa el precio mientras tanto.` : 'Tu oferta vuelve al mercado.'}`,
			)
		}
	}
	return out
}

// Operaciones que esperan algo de ti ahora mismo (para el contador del título)
export const pendingCount = (trades: Trade[]) => trades.filter((t) => t.actions.includes('pay') || t.actions.includes('release')).length
