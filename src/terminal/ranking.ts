// Ranking de usuarios a partir de los libros que ha leído este navegador, con la cuenta de quien
// mira. Se calcula aquí mismo y no sale de aquí: nadie ve un ranking hecho con la lectura de otro.
// Solo entra quien tiene ofertas publicadas ahora (las 50 mejores de cada lado de cada mercado).

import type { Level } from './market.ts'

export type Criterion = 'liquidity' | 'experience' | 'reputation' | 'best' | 'maker' | 'active'
export const CRITERIA: Criterion[] = ['liquidity', 'experience', 'reputation', 'best', 'maker', 'active']

export interface BookSide {
	tick: string
	side: 'ask' | 'bid'
	levels: Level[]
}

export interface UserStats {
	user: string
	kyc: boolean
	vip: boolean
	gold: boolean
	ops: number
	rating: number | null
	// USD ofrecidos: venden (ask) y compran (bid)
	usdAsk: number
	usdBid: number
	offers: number
	markets: string[]
	// Lados de mercado en los que tiene el mejor precio
	best: number
	// Ofertas publicadas o actualizadas en las últimas 24 h, y la más reciente
	recent: number
	lastUpdate: number | null
	// Valoración ajustada por número de operaciones
	score: number | null
}

export interface Ranking {
	criterion: Criterion
	rows: { rank: number; stats: UserStats }[]
}

// Media bayesiana: una valoración cuenta como si se sumaran PRIOR_OPS operaciones de PRIOR_RATING.
// Así un 5,0 con 3 operaciones queda por debajo de un 4,9 con 2.000
export const PRIOR_RATING = 4.5
export const PRIOR_OPS = 30
const DAY_MS = 86_400_000

export const reputationScore = (rating: number | null, ops: number) => (rating == null ? null : (rating * ops + PRIOR_RATING * PRIOR_OPS) / (ops + PRIOR_OPS))

// Junta las ofertas de cada usuario. Sin las de precio atípico (casi siempre errores de tipeo)
export function userStats(sides: BookSide[], now: number): UserStats[] {
	const by = new Map<string, UserStats & { marketSet: Set<string> }>()
	for (const s of sides) {
		const valid = s.levels.filter((l) => !l.outlier)
		// El mejor precio de cada lado, sin las ofertas solo para VIP (como en la cabecera)
		const bestPrice = valid.find((l) => !l.vipOnly)?.price
		const bestUsers = new Set(valid.filter((l) => !l.vipOnly && l.price === bestPrice).map((l) => l.user))
		for (const l of valid) {
			let u = by.get(l.user)
			if (!u) {
				u = { user: l.user, kyc: false, vip: false, gold: false, ops: 0, rating: null, usdAsk: 0, usdBid: 0, offers: 0, markets: [], marketSet: new Set(), best: 0, recent: 0, lastUpdate: null, score: null }
				by.set(l.user, u)
			}
			u.kyc ||= l.kyc
			u.vip ||= l.vip
			u.gold ||= l.gold
			u.ops = Math.max(u.ops, l.ops)
			if (l.rating != null) u.rating = l.rating
			if (s.side === 'ask') u.usdAsk += l.usd
			else u.usdBid += l.usd
			u.offers++
			u.marketSet.add(s.tick)
			const t = l.updatedAt ?? l.createdAt
			if (t != null) {
				if (now - t < DAY_MS) u.recent++
				u.lastUpdate = Math.max(u.lastUpdate ?? 0, t)
			}
		}
		for (const user of bestUsers) by.get(user)!.best++
	}
	return [...by.values()].map(({ marketSet, ...u }) => ({ ...u, markets: [...marketSet], score: reputationScore(u.rating, u.ops) }))
}

const usd = (u: UserStats) => u.usdAsk + u.usdBid

// Orden y quién entra en cada ranking
const RULES: Record<Criterion, { keep: (u: UserStats) => boolean; cmp: (a: UserStats, b: UserStats) => number }> = {
	liquidity: { keep: (u) => usd(u) > 0, cmp: (a, b) => usd(b) - usd(a) },
	experience: { keep: (u) => u.ops > 0, cmp: (a, b) => b.ops - a.ops || usd(b) - usd(a) },
	reputation: { keep: (u) => u.score != null, cmp: (a, b) => b.score! - a.score! || b.ops - a.ops },
	best: { keep: (u) => u.best > 0, cmp: (a, b) => b.best - a.best || usd(b) - usd(a) },
	// Compra y vende a la vez; manda el lado más flojo, que es lo que de verdad pone a los dos lados
	maker: { keep: (u) => u.usdAsk > 0 && u.usdBid > 0, cmp: (a, b) => Math.min(b.usdAsk, b.usdBid) - Math.min(a.usdAsk, a.usdBid) },
	active: { keep: (u) => u.recent > 0, cmp: (a, b) => b.recent - a.recent || (b.lastUpdate ?? 0) - (a.lastUpdate ?? 0) },
}

export function rank(stats: UserStats[], criterion: Criterion, limit = 10): Ranking {
	const { keep, cmp } = RULES[criterion]
	const sorted = stats.filter(keep).sort((a, b) => cmp(a, b) || a.user.localeCompare(b.user))
	return { criterion, rows: sorted.slice(0, limit).map((stats, i) => ({ rank: i + 1, stats })) }
}

// Puesto de cada usuario en cada ranking (para las insignias del libro y al tomar una oferta)
export function positions(stats: UserStats[]): Record<string, Partial<Record<Criterion, number>>> {
	const out: Record<string, Partial<Record<Criterion, number>>> = {}
	for (const c of CRITERIA) for (const { rank: r, stats: u } of rank(stats, c, Infinity).rows) (out[u.user] ??= {})[c] = r
	return out
}
