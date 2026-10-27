// Contadores anónimos de visitas: cuántas sesiones abren la web, el terminal y el simulador cada día, cuántos
// navegadores conectan su cuenta y por qué enlace llegaron (?de=…). Solo se suma 1 a un contador del día: sin
// cookies, sin IP, sin ningún identificador del navegador ni de la cuenta. Lo manda public/app/hit.js

import { panel } from './admin.ts'
import { cubaDate } from './informal.ts'
import type { D1 } from './rates.ts'

const SITES = new Set(['site', 'app', 'sim'])
const KINDS = new Set(['visit', 'connect', 'first'])
const REF = /^[a-z0-9_-]{1,20}$/

export interface Hit {
	site: string
	kind: string
	ref: string
}

// Lo que llega del navegador, limpio; null si no vale. Conectar solo se cuenta en el terminal
export function cleanHit(b: unknown): Hit | null {
	const o = (b ?? {}) as Record<string, unknown>
	const site = String(o.site ?? '')
	const kind = String(o.kind ?? '')
	const ref = String(o.ref ?? '').toLowerCase()
	if (!SITES.has(site) || !KINDS.has(kind) || (kind !== 'visit' && site !== 'app')) return null
	return { site, kind, ref: REF.test(ref) ? ref : '' }
}

export async function saveHit(db: D1, h: Hit, now = Date.now()) {
	await db
		.prepare('INSERT INTO hits (day, site, kind, ref, n) VALUES (?, ?, ?, ?, 1) ON CONFLICT(day, site, kind, ref) DO UPDATE SET n = n + 1')
		.bind(cubaDate(now), h.site, h.kind, h.ref)
		.run()
}

export async function loadHits(db: D1, days: number, now = Date.now()) {
	const since = cubaDate(now - (days - 1) * 86_400_000)
	const { results } = await db.prepare('SELECT day, site, kind, ref, n FROM hits WHERE day >= ? ORDER BY day DESC').bind(since).all<{ day: string; site: string; kind: string; ref: string; n: number }>()
	const byDay = new Map<string, Record<string, number>>()
	const byRef = new Map<string, Record<string, number>>()
	const total: Record<string, number> = {}
	for (const r of results) {
		const key = r.kind === 'visit' ? r.site : r.kind
		const d = byDay.get(r.day) ?? {}
		d[key] = (d[key] ?? 0) + r.n
		byDay.set(r.day, d)
		const f = byRef.get(r.ref) ?? {}
		f[key] = (f[key] ?? 0) + r.n
		byRef.set(r.ref, f)
		total[key] = (total[key] ?? 0) + r.n
	}
	const reach = (v: Record<string, number>) => (v.site ?? 0) + (v.app ?? 0) + (v.sim ?? 0)
	return {
		total,
		byDay: [...byDay].map(([day, v]) => ({ day, ...v }) as Record<string, number | string>),
		byRef: [...byRef].sort((a, b) => reach(b[1]) - reach(a[1])).map(([ref, v]) => ({ ref, ...v }) as Record<string, number | string>),
	}
}

const n = (v: number | undefined) => (v ?? 0).toLocaleString('es')
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

export function hitsHtml(h: Awaited<ReturnType<typeof loadHits>>) {
	const cols = (r: Record<string, number | string>) => ['site', 'app', 'sim', 'connect', 'first'].map((k) => `<td>${n(r[k] as number | undefined)}</td>`).join('')
	const head = '<th>Web</th><th>Terminal</th><th>Simulador</th><th>Conectadas</th><th>Nuevas</th>'
	const table = (first: string, rows: string) =>
		rows ? `<div class="wrap"><table><thead><tr><th>${first}</th>${head}</tr></thead><tbody>${rows}</tbody></table></div>` : '<p class="empty">Aún no hay visitas contadas en este periodo.</p>'
	return `<div class="cards">
<div class="card"><span>Visitas a la web</span><b>${n(h.total.site)}</b><small>sesiones del navegador</small></div>
<div class="card"><span>Visitas al terminal</span><b>${n(h.total.app)}</b></div>
<div class="card"><span>Visitas al simulador</span><b>${n(h.total.sim)}</b></div>
<div class="card"><span>Cuentas conectadas</span><b>${n(h.total.connect)}</b><small>navegadores por día, sumados</small></div>
<div class="card"><span>Conectan por primera vez</span><b>${n(h.total.first)}</b><small>navegadores nuevos</small></div>
</div>
${panel('De dónde llegan', table('Enlace', h.byRef.map((r) => `<tr><td>${r.ref ? `<code>?de=${esc(String(r.ref))}</code>` : '<span class="note">directo o sin marcar</span>'}</td>${cols(r)}</tr>`).join('')), { sub: 'Por el ?de= del enlace con el que entraron (se recuerda al pasar de la web al terminal)', flush: true })}
${panel('Visitas por día', table('Día', h.byDay.map((d) => `<tr><td>${d.day}</td>${cols(d)}</tr>`).join('')), { sub: 'Hora de Cuba · una visita por sesión del navegador · conectadas: una por navegador y día', flush: true })}`
}
