// Tasas del mercado informal cubano según elTOQUE (tasas.eltoque.com), guardadas en D1.
// Una mediana por divisa y día de Cuba, en CUP. Se guardan tal cual las da elTOQUE:
// sus términos piden citarlo como fuente y no modificar los datos.

import { cubaOffset, type D1 } from './rates.ts'

const UPSTREAM = 'https://tasas.eltoque.com/v1/trmi'
// Las que se muestran. BTC y TRX vienen con valores irregulares y no se guardan
export const CURRENCIES = ['USD', 'ECU', 'MLC', 'USDT_TRC20'] as const
export type Currency = (typeof CURRENCIES)[number]
// Primer día con datos en elTOQUE
export const FIRST_DAY = '2020-12-01'
// Días que faltan que el cron rellena en cada pasada. La documentación de elTOQUE habla de 60
// peticiones por minuto, pero en la práctica la clave se bloquea varios minutos a partir de unas
// 10 por minuto: una cada 7 s y 7 por pasada (cada 10 min) como mucho. El histórico desde 2020
// se completa así en unos dos días y medio, empezando por lo más reciente
const BACKFILL_PER_RUN = 6
const GAP_MS = 7000
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms))

export interface InformalRow {
	day: string
	cur: Currency
	rate: number
}

// "YYYY-MM-DD" del día de Cuba en el que cae t
export const cubaDate = (t: number) => new Date(t + cubaOffset(t)).toISOString().slice(0, 10)
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10)

export function rowsFromTasas(tasas: unknown, day: string): InformalRow[] {
	const rows: InformalRow[] = []
	if (!tasas || typeof tasas !== 'object') return rows
	for (const cur of CURRENCIES) {
		const v = (tasas as Record<string, unknown>)[cur]
		if (typeof v === 'number' && Number.isFinite(v) && v > 0) rows.push({ day, cur, rate: v })
	}
	return rows
}

// Sin día: las últimas 24 h. Con día: ese día completo, en hora de Cuba (como responde elTOQUE)
async function fetchTasas(token: string, day?: string) {
	const url = new URL(UPSTREAM)
	if (day) {
		url.searchParams.set('date_from', `${day} 00:00:01`)
		url.searchParams.set('date_to', `${day} 23:59:59`)
	}
	const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } })
	if (!res.ok) throw Object.assign(new Error(`elTOQUE respondió ${res.status}`), { status: res.status })
	return ((await res.json()) as { tasas?: unknown }).tasas
}

function save(db: D1, rows: InformalRow[], final: boolean, now: number) {
	const stmt = db.prepare('INSERT OR REPLACE INTO informal (day, cur, rate, final, t) VALUES (?, ?, ?, ?, ?)')
	return rows.length ? db.batch(rows.map((r) => stmt.bind(r.day, r.cur, r.rate, final ? 1 : 0, now))) : Promise.resolve()
}

// Lo llama el cron: la tasa de hoy (últimas 24 h, se va actualizando), los días cerrados
// que faltan en el último mes y, poco a poco, el histórico hasta el primer día de elTOQUE
export async function syncInformal(db: D1, token: string, now = Date.now(), gapMs = GAP_MS) {
	const today = cubaDate(now)
	await save(db, rowsFromTasas(await fetchTasas(token), today), false, now)

	const { results } = await db.prepare('SELECT day FROM informal WHERE final = 1 AND day >= ? GROUP BY day').bind(FIRST_DAY).all<{ day: string }>()
	const done = new Set(results.map((r) => r.day))
	const missing: string[] = []
	// Primero lo reciente (de ayer hacia atrás), luego lo más antiguo que falte
	for (let d = addDays(today, -1); d >= FIRST_DAY && missing.length < BACKFILL_PER_RUN; d = addDays(d, -1)) if (!done.has(d)) missing.push(d)
	let saved = 0
	for (const day of missing) {
		await pause(gapMs)
		let tasas: unknown
		try {
			tasas = await fetchTasas(token, day)
		} catch (err) {
			// Con el límite superado se sigue en la próxima pasada
			if ((err as { status?: number }).status === 429) break
			throw err
		}
		const rows = rowsFromTasas(tasas, day)
		// Un día sin datos se marca igual para no volver a pedirlo
		await save(db, rows.length ? rows : [{ day, cur: 'USD', rate: 0 }], true, now)
		saved++
	}
	return saved
}

// Serie diaria desde `since` (día de Cuba), una fila por día con las divisas como columnas
export async function informalSince(db: D1, since: string) {
	const { results } = await db
		.prepare(
			`SELECT day,
			        MAX(CASE WHEN cur = 'USD' THEN rate END)        AS usd,
			        MAX(CASE WHEN cur = 'ECU' THEN rate END)        AS eur,
			        MAX(CASE WHEN cur = 'MLC' THEN rate END)        AS mlc,
			        MAX(CASE WHEN cur = 'USDT_TRC20' THEN rate END) AS usdt,
			        MIN(final)                                      AS final
			   FROM informal WHERE day >= ? AND rate > 0
			  GROUP BY day ORDER BY day`,
		)
		.bind(since)
		.all<{ day: string; usd: number | null; eur: number | null; mlc: number | null; usdt: number | null; final: number }>()
	return results.map((r) => ({ ...r, t: noonCuba(r.day), final: r.final === 1 }))
}

// Mediodía de ese día en Cuba (ms UTC), para dibujarlo junto a las barras diarias
export function noonCuba(day: string) {
	const noon = Date.parse(`${day}T12:00:00Z`)
	return noon - cubaOffset(noon + 5 * 3600_000)
}

// Lo último guardado y, para ver la tendencia, el día anterior y los de hace 7 y 30 días
// (el día cerrado más reciente que no pase de esa fecha; null si aún no está guardado)
export async function latestInformal(db: D1, now = Date.now()) {
	const today = cubaDate(now)
	const rows = await informalSince(db, addDays(today, -35))
	const last = rows.at(-1) ?? null
	const closed = rows.filter((r) => r.final && r.day !== last?.day)
	const upTo = (n: number) => closed.filter((r) => r.day <= addDays(last?.day ?? today, -n) && r.day >= addDays(last?.day ?? today, -n - 3)).at(-1) ?? null
	return { source: 'elTOQUE', url: 'https://eltoque.com/tasas-de-cambio-de-moneda-en-cuba-hoy', last, prev: closed.at(-1) ?? null, d7: upTo(7), d30: upTo(30) }
}
