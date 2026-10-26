// Libro cruzado: alguien vende más barato de lo que otro compra. Comprar a uno y venderle al otro deja la
// diferencia, pero son dos operaciones aparte, y solo cuentan las ofertas que tú puedes tomar de verdad.

import type { Level } from './market.ts'

export interface Cross {
	ask: Level // la venta que tomas (compras USD)
	bid: Level // la compra que tomas (vendes USD)
	buyUsd: number // lo que compras
	sellUsd: number // lo que vendes (lo comprado menos la comisión de QvaPay)
	cost: number // lo que pagas en la moneda del mercado
	profit: number // lo que te queda en la moneda del mercado
	pct: number // profit / cost
	leftUsd: number // USD que te sobran si la venta es fija y más pequeña que lo comprado
}

// Solo las que puedes tomar: ni precios raros, ni solo VIP, ni con requisitos que no cumples, ni las tuyas
export const takeable = (l: Level, me?: string | null) => !l.outlier && !l.vipOnly && l.requirementsMet !== false && (!me || l.user !== me)

const round2 = (n: number) => Math.round(n * 100) / 100
// Lo que se puede tomar de una oferta: la fija, entera; la de rango, entre su mínimo y su máximo
const range = (l: Level): [number, number] => (l.kind === 'flexible' ? [l.orderMin ?? 0.1, Math.min(l.orderMax ?? l.usd, l.usd)] : [l.usd, l.usd])

// Cómo encajan una venta y una compra: vendes todo lo que te deja la compra con lo que te llega de la venta
// (al comprar, QvaPay se queda su comisión de los USD). null si no encajan o no queda nada
export function pairCross(ask: Level, bid: Level, fee: number): Cross | null {
	const [buyMin, buyMax] = range(ask)
	const [sellMin, sellMax] = range(bid)
	const sellUsd = round2(Math.min(sellMax, buyMax * (1 - fee)))
	if (!(sellUsd >= sellMin) || !(sellUsd > 0)) return null
	const buyUsd = round2(Math.min(buyMax, Math.max(buyMin, sellUsd / (1 - fee))))
	const cost = buyUsd * ask.price
	const leftUsd = round2(Math.max(0, buyUsd * (1 - fee) - sellUsd))
	// Lo que sobra se valora a lo que costó: no suma ganancia, pero tampoco se pierde
	const profit = sellUsd * bid.price + leftUsd * ask.price - cost
	if (!(profit > 0)) return null
	return { ask, bid, buyUsd, sellUsd, cost, profit, pct: profit / cost, leftUsd }
}

// La mejor pareja entre las primeras ofertas que puedes tomar de cada lado (mejor primero en cada lista)
export function bestCross(asks: Level[], bids: Level[], fee: number, me?: string | null, depth = 5): Cross | null {
	const a = asks.filter((l) => takeable(l, me)).slice(0, depth)
	const b = bids.filter((l) => takeable(l, me)).slice(0, depth)
	let best: Cross | null = null
	for (const ask of a)
		for (const bid of b) {
			if (bid.price <= ask.price) continue
			const c = pairCross(ask, bid, fee)
			if (c && (!best || c.profit > best.profit)) best = c
		}
	return best
}
