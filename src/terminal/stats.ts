// Intención y actividad de un mercado, calculadas en el servidor con el libro completo (worker/livebook-do.ts) y
// mandadas a los terminales: así todos ven el mismo valor, sin depender de qué llegó antes al navegador ni de los
// filtros de cada uno. La fórmula es la misma que usa el terminal cuando no recibe el libro del servidor (app.js)

import type { CompletedRates } from '../qvapay/types.ts'
import { isOutlier, type Level } from './market.ts'

export interface Intent {
	// 0 = más venden, 100 = más compran
	score: number
	// Parte de la profundidad a ±2 % del medio que es compra (0–1)
	depth: number
	// Distancia del medio a la mediana de lo completado (null sin mediana)
	drift: number | null
	bidUsd: number
	askUsd: number
	mid: number
	doneMedian: number | null
}

const median = (xs: number[]) => {
	if (!xs.length) return null
	const s = [...xs].sort((a, b) => a - b)
	const m = Math.floor(s.length / 2)
	return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

// La referencia para lo atípico, como en el libro del terminal: las medianas de lo completado (con al menos 3)
export const referenceOf = (done: CompletedRates | null) => (done && done.count >= 3 ? { buy: done.median_buy || done.average_buy, sell: done.median_sell || done.average_sell } : null)

// Un 70 % sale de la profundidad a ±2 % del medio (USD que se quieren comprar frente a los que se quieren vender) y un
// 30 % de dónde está el medio respecto a la mediana de lo completado (±2 % llena la escala). Sin las ofertas que solo
// pueden tomar los VIP ni las de precio atípico, como el libro del terminal con sus filtros de siempre
export function intentOf(asks: Level[], bids: Level[], done: CompletedRates | null): Intent | null {
	const ref = referenceOf(done)
	const ok = (side: 'ask' | 'bid') => (l: Level) => !l.vipOnly && !isOutlier(l.price, ref?.[side === 'ask' ? 'sell' : 'buy'] ?? null, side)
	const a = asks.filter(ok('ask'))
	const b = bids.filter(ok('bid'))
	const ask = a[0]?.price
	const bid = b[0]?.price
	const mid = ask && bid ? (ask + bid) / 2 : (ask ?? bid)
	if (!mid) return null
	const askUsd = a.filter((l) => l.price <= mid * 1.02).reduce((s, l) => s + l.usd, 0)
	const bidUsd = b.filter((l) => l.price >= mid * 0.98).reduce((s, l) => s + l.usd, 0)
	if (!(bidUsd + askUsd > 0)) return null
	const doneMedian = done?.offers?.length ? median(done.offers) : null
	const depth = bidUsd / (bidUsd + askUsd)
	const drift = doneMedian ? Math.max(-1, Math.min(1, (mid / doneMedian - 1) / 0.02)) : 0
	return { score: Math.round((0.7 * depth + 0.3 * ((drift + 1) / 2)) * 100), depth, drift: doneMedian ? mid / doneMedian - 1 : null, bidUsd, askUsd, mid, doneMedian }
}
