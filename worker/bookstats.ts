// El histórico del libro (tabla book_stats), para el análisis de mercado: cada 10 minutos, con la tasa recién guardada,
// una foto de cada mercado y lado del libro en vivo (livebook.ts, Book.stats). Solo números del mercado, ninguna oferta
// ni usuario. Lo atípico se mide contra la mediana de lo completado, como en el terminal

import { COINS } from '../src/terminal/market.ts'
import { liveSnapshot, type BookRefs, type LiveEnv } from './livebook.ts'

const SLOT_MS = 10 * 60_000
// Una tasa más vieja no sirve de referencia (sin ella no se marca nada como atípico)
const REF_MAX_AGE_MS = 6 * 3600_000

export async function recordBook(env: LiveEnv, at: number) {
	const db = env.DB
	// La última tasa de cada mercado, una consulta por mercado: la clave es mercado y hora, así cada una lee una fila
	const last = await Promise.all(
		COINS.map((c) =>
			db
				.prepare('SELECT coin, t, median, median_buy, median_sell FROM rates WHERE coin = ? ORDER BY t DESC LIMIT 1')
				.bind(c.tick)
				.first<{ coin: string; t: number; median: number | null; median_buy: number | null; median_sell: number | null }>(),
		),
	)
	const refs: BookRefs = {}
	for (const r of last) if (r && at - r.t < REF_MAX_AGE_MS) refs[r.coin] = { ask: r.median_sell ?? r.median, bid: r.median_buy ?? r.median }
	const snap = await liveSnapshot(env, refs)
	if (!snap?.sides.length) {
		if (env.LIVE) console.error(`histórico del libro: ${snap ? 'ningún lado está completo' : 'el libro en vivo no respondió'}`)
		return 0
	}
	const t = Math.floor(at / SLOT_MS) * SLOT_MS
	const stmt = db.prepare(
		'INSERT OR IGNORE INTO book_stats (coin, t, side, offers, outliers, best, usd, usd1, usd3, top1, top3, age, fill100, fill500, stale) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
	)
	await db.batch(
		snap.sides.map(({ coin, side, stat: s }) =>
			stmt.bind(coin, t, side, s.offers, s.outliers, s.best, s.usd, s.usd1, s.usd3, s.top1, s.top3, s.age, s.fill100, s.fill500, snap.stale ? 1 : 0),
		),
	)
	return snap.sides.length
}
