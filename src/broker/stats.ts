// Estadísticas de trading del usuario («Mi cuenta»), con sus propias operaciones de QvaPay. Se calculan en su
// navegador: a nuestro servidor no llega nada.

import type { Trade } from './trades.ts'

export interface MarketStats {
	coin: string
	ops: number
	usdBought: number
	usdSold: number
	// Precio medio ponderado por USD (moneda del mercado por cada USD); null si no hubo de ese lado
	avgBuy: number | null
	avgSell: number | null
}

export interface TradeStats {
	completed: number
	cancelled: number
	asOwner: number // completadas en ofertas tuyas
	asTaker: number // completadas tomando ofertas de otros
	usdBought: number
	usdSold: number
	months: { month: string; usdBought: number; usdSold: number; ops: number }[] // AAAA-MM, del más reciente
	markets: MarketStats[] // de más a menos volumen
	peers: { username: string; ops: number; usd: number }[] // con quién más operas (hasta 5)
	since: string | null // la operación más antigua que se tuvo en cuenta
}

const round2 = (n: number) => Math.round(n * 100) / 100

export function tradeStats(trades: Trade[]): TradeStats {
	const done = trades.filter((t) => t.status === 'completed')
	const months = new Map<string, { usdBought: number; usdSold: number; ops: number }>()
	const markets = new Map<string, { ops: number; usdBought: number; usdSold: number; coinBought: number; coinSold: number }>()
	const peers = new Map<string, { ops: number; usd: number }>()
	let usdBought = 0
	let usdSold = 0
	for (const t of done) {
		const buy = t.side === 'buy'
		if (buy) usdBought += t.usd
		else usdSold += t.usd
		const month = (t.updatedAt ?? '').slice(0, 7)
		if (month) {
			const m = months.get(month) ?? { usdBought: 0, usdSold: 0, ops: 0 }
			m.ops++
			if (buy) m.usdBought += t.usd
			else m.usdSold += t.usd
			months.set(month, m)
		}
		const k = markets.get(t.coin) ?? { ops: 0, usdBought: 0, usdSold: 0, coinBought: 0, coinSold: 0 }
		k.ops++
		if (buy) {
			k.usdBought += t.usd
			k.coinBought += t.coinAmount
		} else {
			k.usdSold += t.usd
			k.coinSold += t.coinAmount
		}
		markets.set(t.coin, k)
		const who = t.counterparty?.username
		if (who) {
			const p = peers.get(who) ?? { ops: 0, usd: 0 }
			p.ops++
			p.usd += t.usd
			peers.set(who, p)
		}
	}
	const dates = done.map((t) => t.updatedAt).filter((d): d is string => !!d).sort()
	return {
		completed: done.length,
		cancelled: trades.filter((t) => t.status === 'cancelled').length,
		asOwner: done.filter((t) => t.role === 'owner').length,
		asTaker: done.filter((t) => t.role === 'taker').length,
		usdBought: round2(usdBought),
		usdSold: round2(usdSold),
		months: [...months]
			.sort((a, b) => b[0].localeCompare(a[0]))
			.map(([month, m]) => ({ month, usdBought: round2(m.usdBought), usdSold: round2(m.usdSold), ops: m.ops })),
		markets: [...markets]
			.map(([coin, m]) => ({
				coin,
				ops: m.ops,
				usdBought: round2(m.usdBought),
				usdSold: round2(m.usdSold),
				avgBuy: m.usdBought ? round2(m.coinBought / m.usdBought) : null,
				avgSell: m.usdSold ? round2(m.coinSold / m.usdSold) : null,
			}))
			.sort((a, b) => b.usdBought + b.usdSold - (a.usdBought + a.usdSold)),
		peers: [...peers]
			.map(([username, p]) => ({ username, ops: p.ops, usd: round2(p.usd) }))
			.sort((a, b) => b.ops - a.ops || b.usd - a.usd)
			.slice(0, 5),
		since: dates[0] ?? null,
	}
}
