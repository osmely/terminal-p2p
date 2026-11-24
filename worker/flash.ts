// Ofertas relámpago: fijas que alguien tomó en muy poco tiempo desde que se pudieron tomar. Salen del historial del
// feed (feed_log, 30 días) y se cruzan con las acciones del terminal (events, por la huella de la oferta) para saber si
// las tomó el radar, alguien desde el terminal a mano u otro de fuera. Solo para el panel de métricas

import { COINS } from '../src/terminal/market.ts'
import { panel } from './admin.ts'
import { fingerprint } from './metrics.ts'
import type { D1 } from './rates.ts'

// Relámpago: tomada en menos de esto desde que se pudo tomar
export const FLASH_MS = 5_000
// Las que se listan en el panel (las más recientes)
const FLASH_LIST = 100
// El historial del feed se guarda 30 días
export const FEED_DAYS = 30

export type FlashWho = 'radar' | 'terminal' | 'other'
export interface Flash {
	t: number
	coin: string
	type: string
	usd: number
	price: number
	owner: string
	ms: number
	who: FlashWho
	// Nuestro radar la intentó y no la consiguió
	radarLost: boolean
}
export interface FlashData {
	days: number
	since: number | null
	// Fijas tomadas que vimos aparecer (con su duración) y cuántas de ellas fueron relámpago
	taken: number
	flash: Flash[]
	p50: number | null
	buckets: { label: string; n: number }[]
	byOwner: { owner: string; n: number; ms: number }[]
	who: Record<FlashWho, number>
	radarLost: number
}

const quantile = (v: number[], q: number) => {
	if (!v.length) return null
	const s = [...v].sort((a, b) => a - b)
	return s[Math.min(s.length - 1, Math.floor(q * s.length))]
}

// Cada fija tomada entera (applied) con la última vez que se pudo tomar antes (created, reopened o resumed)
export async function loadFlash(db: D1, days: number, salt: string | undefined, now = Date.now()): Promise<FlashData> {
	const d = Math.min(days, FEED_DAYS)
	const from = now - d * 86_400_000
	const [{ results }, first] = await Promise.all([
		db
			.prepare(
				`SELECT a.offer, a.t, a.coin, a.type, a.amount, a.receive, COALESCE(a.username, o.username, '') AS owner,
					a.t - o.t AS ms, a.rx - o.rx AS rx_ms
				FROM feed_log a JOIN feed_log o ON o.offer = a.offer AND o.kind = 'fixed' AND o.event IN ('created', 'reopened', 'resumed')
					AND o.t = (SELECT MAX(t) FROM feed_log x WHERE x.offer = a.offer AND x.event IN ('created', 'reopened', 'resumed') AND x.t <= a.t)
				WHERE a.kind = 'fixed' AND a.event = 'applied' AND a.t >= ?
				ORDER BY a.t DESC`,
			)
			.bind(from)
			.all<{ offer: string; t: number; coin: string; type: string; amount: number; receive: number; owner: string; ms: number; rx_ms: number }>(),
		db.prepare('SELECT MIN(t) AS t FROM feed_log').first<{ t: number | null }>(),
	])
	// La duración con las horas de QvaPay; si no cuadran (negativa), con las de llegada
	const rows = results.map((r) => ({ ...r, dur: r.ms >= 0 ? r.ms : Math.max(0, r.rx_ms) }))
	const fast = rows.filter((r) => r.dur < FLASH_MS)
	// Qué hizo el terminal con cada una: tomada por el radar, a mano, o el radar la intentó y perdió
	const prints = new Map<string, string>()
	if (salt) for (const r of fast) prints.set(await fingerprint(r.offer, salt), r.offer)
	const mine = new Map<string, { radar: boolean; hand: boolean; lost: boolean }>()
	const keys = [...prints.keys()].filter(Boolean)
	for (let i = 0; i < keys.length; i += 90) {
		const part = keys.slice(i, i + 90)
		const { results: ev } = await db
			.prepare(`SELECT offer, status, via FROM events WHERE event = 'take' AND source = 'relay' AND offer IN (${part.map(() => '?').join(', ')})`)
			.bind(...part)
			.all<{ offer: string; status: string; via: string }>()
		for (const e of ev) {
			const id = prints.get(e.offer)!
			const m = mine.get(id) ?? { radar: false, hand: false, lost: false }
			if (e.status === 'ok') e.via.startsWith('radar') ? (m.radar = true) : (m.hand = true)
			else if (e.via.startsWith('radar')) m.lost = true
			mine.set(id, m)
		}
	}
	const flash: Flash[] = fast.map((r) => {
		const m = mine.get(r.offer)
		return {
			t: r.t,
			coin: r.coin,
			type: r.type,
			usd: r.amount,
			price: r.amount > 0 ? r.receive / r.amount : 0,
			owner: r.owner,
			ms: r.dur,
			who: m?.radar ? 'radar' : m?.hand ? 'terminal' : 'other',
			radarLost: !!m?.lost && !m.radar,
		}
	})
	const owners = new Map<string, number[]>()
	for (const f of flash) owners.set(f.owner || '—', [...(owners.get(f.owner || '—') ?? []), f.ms])
	const edges: [string, number, number][] = [
		['menos de 0.5 s', 0, 500],
		['0.5 a 1 s', 500, 1000],
		['1 a 2 s', 1000, 2000],
		['2 a 5 s', 2000, FLASH_MS],
	]
	return {
		days: d,
		since: first?.t ?? null,
		taken: rows.length,
		flash,
		p50: quantile(
			flash.map((f) => f.ms),
			0.5,
		),
		buckets: edges.map(([label, lo, hi]) => ({ label, n: flash.filter((f) => f.ms >= lo && f.ms < hi).length })),
		byOwner: [...owners]
			.map(([owner, ms]) => ({ owner, n: ms.length, ms: quantile(ms, 0.5) ?? 0 }))
			.sort((a, b) => b.n - a.n)
			.slice(0, 10),
		who: {
			radar: flash.filter((f) => f.who === 'radar').length,
			terminal: flash.filter((f) => f.who === 'terminal').length,
			other: flash.filter((f) => f.who === 'other').length,
		},
		radarLost: flash.filter((f) => f.radarLost).length,
	}
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
const n = (v: number) => v.toLocaleString('en-US', { maximumFractionDigits: 2 })
const secs = (ms: number) => `${(ms / 1000).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} s`
const coinName = (t: string) => COINS.find((c) => c.tick === t)?.name ?? t
const hhmm = (t: number) =>
	new Date(t).toLocaleString('es-ES', { timeZone: 'America/Havana', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
const WHO: Record<FlashWho, string> = { radar: '<b>Nuestro radar</b>', terminal: 'Terminal, a mano', other: 'Otro, de fuera' }

export function flashHtml(f: FlashData) {
	const card = (label: string, value: string, sub = '') => `<div class="card"><span>${label}</span><b>${value}</b>${sub ? `<small>${sub}</small>` : ''}</div>`
	const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : '—')
	const total = f.flash.length
	const since = f.since ? `Desde el ${hhmm(f.since)} (hora de Cuba)` : 'Aún no hay historial del feed'
	const table = (head: string[], rows: string, left = false) =>
		rows
			? `<div class="wrap"><table${left ? ' class="left"' : ''}><thead><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div>`
			: '<p class="empty">Ninguna todavía en este periodo.</p>'
	return `<div class="cards">
${card('Ofertas relámpago', n(total), `fijas tomadas en menos de ${FLASH_MS / 1000} s, de ${n(f.taken)} fijas tomadas`)}
${card('La mitad duró menos de', f.p50 == null ? '—' : secs(f.p50))}
${card('Las tomó nuestro radar', n(f.who.radar), `${pct(f.who.radar, total)} · a mano desde el terminal: ${n(f.who.terminal)}`)}
${card('Se las llevó otro', n(f.who.other), `${pct(f.who.other, total)} · el radar lo intentó y perdió: ${n(f.radarLost)}`)}
</div>
${panel(
	'Qué tan rápido las toman',
	table(
		['Duró', 'Ofertas', 'Parte'],
		f.buckets.map((b) => `<tr><td>${b.label}</td><td class="num">${n(b.n)}</td><td class="num">${pct(b.n, total)}</td></tr>`).join(''),
	),
	{ sub: 'De que se pudo tomar a que la tomaron, con las horas de QvaPay', flush: true },
)}
${panel(
	'Anunciantes con más ofertas relámpago',
	table(
		['Anunciante', 'Ofertas', 'La mitad duró menos de'],
		f.byOwner.map((o) => `<tr><td>${o.owner === '—' ? '—' : `@${esc(o.owner)}`}</td><td class="num">${n(o.n)}</td><td class="num">${secs(o.ms)}</td></tr>`).join(''),
	),
	{ flush: true },
)}
${panel(
	'Ofertas relámpago detectadas',
	table(
		['Cuándo', 'Mercado', 'Oferta', 'QUSD', 'Precio', 'Anunciante', 'Duró', 'La tomó'],
		f.flash
			.slice(0, FLASH_LIST)
			.map(
				(x) =>
					`<tr><td>${hhmm(x.t)}</td><td>${esc(coinName(x.coin))}</td><td>${x.type === 'sell' ? 'Venta' : 'Compra'}</td><td class="num">${n(x.usd)}</td><td class="num">${n(x.price)}</td><td>${x.owner ? `@${esc(x.owner)}` : '—'}</td><td class="num">${secs(x.ms)}</td><td>${WHO[x.who]}${x.radarLost ? ' <span class="note">(nuestro radar llegó tarde)</span>' : ''}</td></tr>`,
			)
			.join(''),
		true,
	),
	{
		sub: `${since}. Las ${FLASH_LIST} más recientes. «Otro, de fuera» es quien no la tomó desde el terminal: un bot propio o alguien en la web de QvaPay`,
		flush: true,
		foot: `El historial del feed se guarda ${FEED_DAYS} días: en los rangos más largos se ven solo esos días. Solo ofertas fijas tomadas enteras que vimos aparecer.`,
	},
)}`
}
