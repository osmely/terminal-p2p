// Los mercados de QvaPay que el terminal no sigue (USDTBSC, PAYPAL, SBERBANK…). El feed los manda todos y el libro
// solo usa sus 10: aquí se cuentan los demás por mercado y día (ofertas nuevas, tomadas y volumen, contado como en los
// mercados del terminal) para ver cuáles tienen movimiento. Al pasar el umbral en 7 días se avisa una vez al grupo
// privado de avisos, para decidir si se añade. Solo cifras: ni ofertas ni dueños

import { notify, type AlertEnv } from './alerts.ts'
import { cubaDate } from './informal.ts'
import type { FeedEvent } from './livebook.ts'
import type { D1 } from './rates.ts'

export const ALERT_DONE = 20
export const ALERT_USD = 500
const WEEK_MS = 7 * 86_400_000
const SEEN_KEEP_MS = 3 * 86_400_000
const SEEN_MAX = 20_000
// Como en el libro: lo que cambia lo tomado de una oferta por rango
const TRADE_CHANGES = new Set(['taken', 'returned', 'paused', 'resumed'])

export interface OtherRow {
	coin: string
	day: string
	offers: number
	taken: number
	done: number
	usd: number
}

const num = (v: unknown) => {
	const n = Number(v)
	return Number.isFinite(n) ? n : 0
}
const round2 = (n: number) => Math.round(n * 100) / 100

export class OtherMarkets {
	private pending = new Map<string, OtherRow>()
	// Lo ya contado (los eventos llegan repetidos) y lo tomado de cada oferta por rango, para contar solo lo que cambia
	private seen = new Map<string, number>()
	private filled = new Map<string, { usd: number; at: number }>()

	private ticks: Set<string>

	constructor(ticks: Set<string>) {
		this.ticks = ticks
	}

	// Un evento del feed. Devuelve si contó algo (los de los mercados del terminal no cuentan aquí)
	add(e: FeedEvent, now = Date.now()): boolean {
		const d = e?.data
		if (!d?.uuid || !d.coin || this.ticks.has(d.coin) || (d.type !== 'buy' && d.type !== 'sell')) return false
		const at = Math.min(now, Date.parse(d.updated_at ?? '') || Date.parse(e.sent_at ?? '') || now)
		const amount = num(d.amount)
		let offers = 0
		let taken = 0
		let done = 0
		let usd = 0
		if ((e.event === 'p2p.created' || e.event === 'p2p.range_created') && d.status === 'open' && this.first(`n:${d.uuid}`, now)) offers = 1
		if (e.event === 'p2p.applied' && this.first(`t:${d.uuid}`, now)) taken = 1
		if (e.event === 'p2p.completed' && d.status === 'completed' && amount > 0 && this.first(`d:${d.uuid}`, now)) {
			done = 1
			usd = amount
		}
		const flexible = d.offer_kind === 'flexible' || e.event.startsWith('p2p.range_')
		if (flexible && d.available_amount != null && amount > 0) {
			const now2 = Math.max(0, amount - num(d.available_amount))
			const prev = this.filled.get(d.uuid)
			this.filled.set(d.uuid, { usd: now2, at: now })
			const delta = prev ? round2(now2 - prev.usd) : 0
			if (delta && TRADE_CHANGES.has(d.change ?? '')) {
				if (d.change === 'taken' && delta > 0) taken += 1
				done += delta > 0 ? 1 : -1
				usd += delta
			}
		}
		this.prune(now)
		if (!offers && !taken && !done && !usd) return false
		const day = cubaDate(at)
		const key = `${d.coin}|${day}`
		const row = this.pending.get(key) ?? { coin: d.coin, day, offers: 0, taken: 0, done: 0, usd: 0 }
		row.offers += offers
		row.taken += taken
		row.done += done
		row.usd = round2(row.usd + usd)
		this.pending.set(key, row)
		return true
	}

	hasPending() {
		return this.pending.size > 0
	}

	// Lo contado desde la última vez, y se vacía
	take(): OtherRow[] {
		const rows = [...this.pending.values()]
		this.pending.clear()
		return rows
	}

	private first(key: string, now: number) {
		if (this.seen.has(key)) return false
		this.seen.set(key, now)
		return true
	}

	private prune(now: number) {
		if (this.seen.size + this.filled.size < SEEN_MAX) return
		for (const [k, t] of this.seen) if (now - t > SEEN_KEEP_MS) this.seen.delete(k)
		for (const [k, f] of this.filled) if (now - f.at > SEEN_KEEP_MS) this.filled.delete(k)
		// Si aun así no cabe, fuera lo más viejo (los Map guardan el orden de entrada)
		for (const m of [this.seen, this.filled] as Map<string, unknown>[]) {
			const extra = m.size - SEEN_MAX / 2
			if (extra > 0) for (const k of [...m.keys()].slice(0, extra)) m.delete(k)
		}
	}
}

// Suma lo contado a D1 (una fila por mercado y día)
export async function saveOther(db: D1, rows: OtherRow[]) {
	if (!rows.length) return
	const stmt = db.prepare(
		'INSERT INTO market_other (coin, day, offers, taken, done, usd) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (coin, day) DO UPDATE SET offers = offers + excluded.offers, taken = taken + excluded.taken, done = done + excluded.done, usd = usd + excluded.usd',
	)
	await db.batch(rows.map((r) => stmt.bind(r.coin, r.day, r.offers, r.taken, r.done, r.usd)))
}

export interface OtherSummary {
	coin: string
	offers: number
	taken: number
	done: number
	usd: number
	days: number
}

// Los últimos 7 días por mercado, de más a menos volumen
export async function loadOther(db: D1, now = Date.now()): Promise<OtherSummary[]> {
	const { results } = await db
		.prepare(
			'SELECT coin, SUM(offers) AS offers, SUM(taken) AS taken, SUM(done) AS done, SUM(usd) AS usd, COUNT(*) AS days FROM market_other WHERE day >= ? GROUP BY coin ORDER BY usd DESC, done DESC, offers DESC LIMIT 60',
		)
		.bind(cubaDate(now - WEEK_MS + 86_400_000))
		.all<OtherSummary>()
	return results
}

// Los que pasaron el umbral en 7 días y aún no se avisaron: se avisa uno por uno y se apunta para no repetir
export async function alertOther(db: D1, env: AlertEnv, now = Date.now(), send = notify): Promise<string[]> {
	const { results } = await db
		.prepare(
			'SELECT coin, SUM(offers) AS offers, SUM(taken) AS taken, SUM(done) AS done, SUM(usd) AS usd FROM market_other WHERE day >= ? AND coin NOT IN (SELECT coin FROM market_other_alert) GROUP BY coin HAVING SUM(done) >= ? OR SUM(usd) >= ?',
		)
		.bind(cubaDate(now - WEEK_MS + 86_400_000), ALERT_DONE, ALERT_USD)
		.all<OtherSummary>()
	const sent: string[] = []
	for (const r of results) {
		const text = `📊 <b>Mercado con movimiento: ${r.coin}</b>\nEl terminal no lo sigue. En 7 días: ${fmt(r.done)} operaciones, ${fmt(r.usd)} USD, ${fmt(r.offers)} ofertas nuevas y ${fmt(r.taken)} tomadas.\n¿Lo añadimos al terminal?`
		if (!(await send(env, text, '/admin/metrics'))) continue
		await db.prepare('INSERT OR IGNORE INTO market_other_alert (coin, at) VALUES (?, ?)').bind(r.coin, now).run()
		sent.push(r.coin)
	}
	return sent
}

const fmt = (v: number) => (v ?? 0).toLocaleString('en-US', { maximumFractionDigits: 2 })
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

// La sección del panel de métricas
export function otherHtml(rows: OtherSummary[], panel: (title: string, body: string, o?: { sub?: string; flush?: boolean }) => string) {
	const body = rows.length
		? `<div class="wrap"><table><thead><tr><th>Mercado</th><th>Ofertas nuevas</th><th>Tomadas</th><th>Operaciones</th><th>Volumen USD</th><th>Días con algo</th></tr></thead><tbody>${rows
				.map(
					(r) =>
						`<tr><td><code>${esc(r.coin)}</code>${r.done >= ALERT_DONE || r.usd >= ALERT_USD ? ' <span class="note">pasa el umbral</span>' : ''}</td><td>${fmt(r.offers)}</td><td>${fmt(r.taken)}</td><td>${fmt(r.done)}</td><td>${fmt(r.usd)}</td><td>${r.days}</td></tr>`,
				)
				.join('')}</tbody></table></div>`
		: '<p class="empty">Aún no hay nada contado de otros mercados.</p>'
	return panel('Mercados que no seguimos · últimos 7 días', body, {
		sub: `Del feed de QvaPay, con su código de mercado. Operaciones y volumen se cuentan como en los mercados del terminal. Se avisa por Telegram (una vez) al pasar ${ALERT_DONE} operaciones o ${ALERT_USD} USD en 7 días`,
		flush: true,
	})
}
