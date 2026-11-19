// Crecimiento: lo primero del panel de métricas. ¿Crecemos, de dónde llega la gente, cuánta vuelve y dónde se queda
// por el camino? Junta lo que ya se guarda en otras tablas, sin datos nuevos de nadie:
//   · cuentas en el terminal: live_seen (cada cuenta conectada al libro en vivo, por día) y account_first (su primer día)
//   · visitas y enlaces: hits (contadores anónimos por día)
//   · operaciones y volumen: events (métricas anónimas del P2P, ver metrics.ts)
//   · Pro: pruebas, pagos y compras sin terminar (pro_days, pro_checkouts, pro_licenses)
// Los periodos son días completos (hasta ayer, hora de Cuba) y se comparan con los mismos días justo antes. Hoy, que va
// en curso, sale aparte

import { cubaDate } from './informal.ts'
import { summarize, type MetricEvent } from './metrics.ts'
import type { D1 } from './rates.ts'

const DAY_MS = 86_400_000
// Semanas de cuentas nuevas que se siguen en «Cuántas vuelven», y cuántas semanas después de la primera
const COHORT_WEEKS = 8
const COHORT_AFTER = 4
const REFS_SHOWN = 8

const addDays = (day: string, k: number) => {
	const d = new Date(`${day}T12:00:00Z`)
	d.setUTCDate(d.getUTCDate() + k)
	return d.toISOString().slice(0, 10)
}
const dayRange = (from: string, to: string) => {
	const out: string[] = []
	for (let d = from; d <= to; d = addDays(d, 1)) out.push(d)
	return out
}
// Lunes de la semana de un día
export const weekOf = (day: string) => {
	const d = new Date(`${day}T12:00:00Z`)
	return addDays(day, -((d.getUTCDay() + 6) % 7))
}

export interface Window {
	from: string
	to: string
}

export interface GrowthDay {
	day: string
	active: number
	fresh: number
	visits: number
	web: number
	app: number
	completed: number
	volume: number
}

export interface Kpi {
	cur: number
	prev: number | null
	spark: number[]
}

export interface Growth {
	days: number
	today: string
	cur: Window
	prev: Window
	// Desde qué día hay datos de cada cosa (para no comparar con un periodo a medias)
	since: { accounts: string | null; hits: string | null; events: string | null }
	series: GrowthDay[]
	kpi: { active: Kpi; fresh: Kpi; completed: Kpi; volume: Kpi; visits: Kpi; revenue: Kpi }
	now: { active: number; fresh: number; completed: number; visits: number }
	funnel: { fresh: number; returned: number; tried: number; paid: number }
	refs: { ref: string; others?: number; visits: number; connect: number; first: number }[]
	cohorts: { week: string; size: number; after: (number | null)[]; partial: boolean[] }[]
	pro: {
		paying: number
		trying: number
		trials: number
		purchases: number
		revenue: number
		// De todas las pruebas ya acabadas, cuántas terminaron en pago
		trialsEnded: number
		trialsPaid: number
		pending: { user: string; plans: string[]; tries: number; last: number; proUntil: number | null; proPlan: string | null }[]
	}
}

type Row<T> = { results: T[] }

export async function loadGrowth(db: D1, days: number, now = Date.now()): Promise<Growth> {
	const today = cubaDate(now)
	const cur = { from: addDays(today, -days), to: addDays(today, -1) }
	const prev = { from: addDays(cur.from, -days), to: addDays(cur.from, -1) }
	const cohortFrom = addDays(weekOf(today), -7 * (COHORT_WEEKS - 1))
	const seenFrom = prev.from < cohortFrom ? prev.from : cohortFrom
	const evFrom = Date.parse(`${prev.from}T00:00:00Z`) - DAY_MS

	const [hits, seen, firsts, events, trials, paid, pending, active, bounds] = await Promise.all([
		db.prepare("SELECT day, site, kind, ref, n FROM hits WHERE day >= ? AND site != 'bot'").bind(prev.from).all<{ day: string; site: string; kind: string; ref: string; n: number }>(),
		db.prepare('SELECT day, account FROM live_seen WHERE day >= ?').bind(seenFrom).all<{ day: string; account: string }>(),
		db
			.prepare('SELECT account, MIN(day) AS day FROM (SELECT account, day FROM account_first UNION ALL SELECT account, MIN(day) AS day FROM live_seen GROUP BY account) GROUP BY account')
			.all<{ account: string; day: string }>(),
		db
			.prepare('SELECT t, event, status, offer, ord, coin, side, usd, source, via, err, ms FROM events WHERE t >= ? ORDER BY t')
			.bind(evFrom)
			.all<MetricEvent>(),
		db.prepare("SELECT LOWER(l.username) AS user, d.created_at AS at, d.days FROM pro_days d JOIN pro_licenses l ON l.uuid = d.license WHERE d.kind = 'trial'").all<{ user: string; at: number; days: number }>(),
		db
			.prepare("SELECT LOWER(COALESCE(l.username, c.requester)) AS user, c.amount, c.paid_at AS at, c.created_at FROM pro_checkouts c LEFT JOIN pro_licenses l ON l.uuid = c.license WHERE c.status = 'paid' AND c.refunded_at IS NULL")
			.all<{ user: string; amount: number; at: number | null; created_at: number }>(),
		db
			.prepare(
				"SELECT LOWER(COALESCE(c.requester, (SELECT l.username FROM pro_prints p JOIN pro_licenses l ON l.uuid = p.license WHERE p.print = c.print LIMIT 1))) AS user, c.plan, c.created_at AS at FROM pro_checkouts c WHERE c.status = 'pending'",
			)
			.all<{ user: string | null; plan: string; at: number }>(),
		db
			.prepare('SELECT LOWER(username) AS user, plan, expires_at FROM pro_licenses WHERE merged_into IS NULL AND COALESCE(revoked, 0) = 0')
			.all<{ user: string; plan: string; expires_at: number }>(),
		db
			.prepare("SELECT (SELECT MIN(day) FROM hits WHERE site != 'bot') AS hits, (SELECT MIN(day) FROM account_first) AS accounts, (SELECT MIN(day) FROM live_seen) AS live, (SELECT MIN(t) FROM events) AS events")
			.first<{ hits: string | null; accounts: string | null; live: string | null; events: number | null }>(),
	])
	return growthOf({ days, today, cur, prev, hits, seen, firsts, events, trials, paid, pending, active, bounds }, now)
}

interface Raw {
	days: number
	today: string
	cur: Window
	prev: Window
	hits: Row<{ day: string; site: string; kind: string; ref: string; n: number }>
	seen: Row<{ day: string; account: string }>
	firsts: Row<{ account: string; day: string }>
	events: Row<MetricEvent>
	trials: Row<{ user: string; at: number; days: number }>
	paid: Row<{ user: string; amount: number; at: number | null; created_at: number }>
	pending: Row<{ user: string | null; plan: string; at: number }>
	active: Row<{ user: string; plan: string; expires_at: number }>
	bounds: { hits: string | null; accounts: string | null; live: string | null; events: number | null } | null
}

// Todo el cálculo, aparte de las consultas (así se prueba con filas a mano)
export function growthOf(r: Raw, now: number): Growth {
	const { days, today, cur, prev } = r
	const firstOf = new Map(r.firsts.results.map((f) => [f.account, f.day]))
	const minDay = (a: string | null | undefined, b: string | null | undefined) => (a && b ? (a < b ? a : b) : (a ?? b ?? null))
	const since = {
		accounts: minDay(r.bounds?.accounts, r.bounds?.live),
		hits: r.bounds?.hits ?? null,
		events: r.bounds?.events != null ? cubaDate(r.bounds.events) : null,
	}

	// Por día: cuentas activas y nuevas, visitas, operaciones
	const blank = (day: string): GrowthDay => ({ day, active: 0, fresh: 0, visits: 0, web: 0, app: 0, completed: 0, volume: 0 })
	const byDay = new Map(dayRange(prev.from, today).map((d) => [d, blank(d)]))
	const activeSets = new Map<string, Set<string>>()
	for (const s of r.seen.results) {
		const set = activeSets.get(s.day) ?? (activeSets.set(s.day, new Set()), activeSets.get(s.day)!)
		set.add(s.account)
	}
	for (const [day, set] of activeSets) {
		const d = byDay.get(day)
		if (d) d.active = set.size
	}
	for (const day of firstOf.values()) {
		const d = byDay.get(day)
		if (d) d.fresh++
	}
	const refs = new Map<string, { visits: number; connect: number; first: number }>()
	for (const h of r.hits.results) {
		const d = byDay.get(h.day)
		if (d && h.kind === 'visit') {
			d.visits += h.n
			if (h.site === 'site') d.web += h.n
			if (h.site === 'app') d.app += h.n
		}
		if (h.day < cur.from || h.day > cur.to) continue
		const f = refs.get(h.ref) ?? (refs.set(h.ref, { visits: 0, connect: 0, first: 0 }), refs.get(h.ref)!)
		if (h.kind === 'visit') f.visits += h.n
		else if (h.kind === 'connect') f.connect += h.n
		else if (h.kind === 'first') f.first += h.n
	}
	for (const e of summarize(r.events.results, days * 2 + 1).byDay) {
		const d = byDay.get(e.day)
		if (d) {
			d.completed = e.completed
			d.volume = Math.round(e.volume * 100) / 100
		}
	}

	const inside = (w: Window) => [...byDay.values()].filter((d) => d.day >= w.from && d.day <= w.to)
	// Los días de antes de que hubiera datos no cuentan como ceros: el periodo empieza donde empiezan los datos
	const start = [since.accounts, since.hits, since.events].filter((d): d is string => !!d).sort().at(-1) ?? cur.from
	const series = inside(cur).filter((d) => d.day >= start)
	const before = inside(prev)
	const full = (start: string | null) => !!start && start <= prev.from
	const sum = (rows: GrowthDay[], k: keyof Omit<GrowthDay, 'day'>) => rows.reduce((s, d) => s + d[k], 0)
	const avg = (rows: GrowthDay[], k: keyof Omit<GrowthDay, 'day'>) => {
		const from = k === 'active' ? (since.accounts ?? '') : ''
		const kept = rows.filter((d) => d.day >= from)
		return kept.length ? sum(kept, k) / kept.length : 0
	}

	// Pro: lo cobrado por día, para su cifra y su tendencia
	const revenueOf = new Map<string, number>()
	for (const p of r.paid.results) if (p.at) revenueOf.set(cubaDate(p.at), (revenueOf.get(cubaDate(p.at)) ?? 0) + p.amount)
	const revenue = (w: Window) => [...revenueOf].filter(([d]) => d >= w.from && d <= w.to).reduce((s, [, v]) => s + v, 0)
	const proSince = r.paid.results.length || r.trials.results.length ? cubaDate(Math.min(...r.trials.results.map((t) => t.at), ...r.paid.results.map((p) => p.created_at))) : null

	const kpi = (k: keyof Omit<GrowthDay, 'day'>, start: string | null, mean = false): Kpi => ({
		cur: mean ? avg(series, k) : sum(series, k),
		prev: full(start) ? (mean ? avg(before, k) : sum(before, k)) : null,
		spark: series.map((d) => d[k]),
	})
	const t = byDay.get(today)!

	// Del primer día al pago: cuentas nuevas del periodo, cuántas volvieron otro día, probaron Pro y pagaron
	const fresh = [...firstOf].filter(([, d]) => d >= cur.from && d <= cur.to).map(([a]) => a)
	const daysOf = new Map<string, Set<string>>()
	for (const s of r.seen.results) (daysOf.get(s.account) ?? (daysOf.set(s.account, new Set()), daysOf.get(s.account)!)).add(s.day)
	const tried = new Set(r.trials.results.map((x) => x.user))
	const payers = new Set(r.paid.results.map((x) => x.user))
	const returned = fresh.filter((a) => [...(daysOf.get(a) ?? [])].some((d) => d > firstOf.get(a)!))

	// Cuántas vuelven: por la semana de su primer día, el % que volvió a verse cada semana siguiente
	const thisWeek = weekOf(today)
	const cohortStart = addDays(thisWeek, -7 * (COHORT_WEEKS - 1))
	const weeksOf = new Map<string, Set<string>>()
	for (const [a, set] of daysOf) weeksOf.set(a, new Set([...set].map(weekOf)))
	const groups = new Map<string, string[]>()
	for (const [a, d] of firstOf) {
		const w = weekOf(d)
		if (w >= cohortStart) (groups.get(w) ?? (groups.set(w, []), groups.get(w)!)).push(a)
	}
	const cohorts = [...groups]
		.sort((a, b) => (a[0] < b[0] ? 1 : -1))
		.map(([week, accounts]) => {
			const after: (number | null)[] = []
			const partial: boolean[] = []
			for (let k = 1; k <= COHORT_AFTER; k++) {
				const w = addDays(week, 7 * k)
				if (w > thisWeek) break
				after.push(accounts.filter((a) => weeksOf.get(a)?.has(w)).length / accounts.length)
				partial.push(w === thisWeek)
			}
			return { week, size: accounts.length, after, partial }
		})

	// Enlaces: los que más traen, el resto junto y los directos siempre
	const named = [...refs].filter(([ref]) => ref).sort((a, b) => b[1].visits - a[1].visits)
	const shown = named.slice(0, REFS_SHOWN).map(([ref, v]) => ({ ref, ...v }))
	const rest = named.slice(REFS_SHOWN)
	const direct = refs.get('')
	const refRows = [...shown, ...(direct ? [{ ref: '', ...direct }] : [])].sort((a, b) => b.visits - a.visits)
	if (rest.length)
		refRows.push({
			ref: '',
			others: rest.length,
			visits: rest.reduce((s, [, v]) => s + v.visits, 0),
			connect: rest.reduce((s, [, v]) => s + v.connect, 0),
			first: rest.reduce((s, [, v]) => s + v.first, 0),
		} as Growth['refs'][number])

	// Pro
	const activeNow = r.active.results.filter((l) => l.expires_at > now)
	const isTrial = (plan: string) => plan === 'trial' || plan === 'gift'
	const inCur = (ms: number) => {
		const d = cubaDate(ms)
		return d >= cur.from && d <= cur.to
	}
	const ended = r.trials.results.filter((x) => x.at + x.days * DAY_MS < now)
	const licenseOf = new Map(r.active.results.map((l) => [l.user, l]))
	const lastPaid = new Map<string, number>()
	for (const p of r.paid.results) lastPaid.set(p.user, Math.max(lastPaid.get(p.user) ?? 0, p.at ?? p.created_at))
	const stuck = new Map<string, Growth['pro']['pending'][number]>()
	for (const p of r.pending.results) {
		if (!p.user || !inCur(p.at) || (lastPaid.get(p.user) ?? 0) > p.at) continue
		const s = stuck.get(p.user) ?? { user: p.user, plans: [], tries: 0, last: 0, proUntil: null, proPlan: null }
		s.tries++
		s.last = Math.max(s.last, p.at)
		if (!s.plans.includes(p.plan)) s.plans.push(p.plan)
		const l = licenseOf.get(p.user)
		s.proUntil = l?.expires_at ?? null
		s.proPlan = l?.plan ?? null
		stuck.set(p.user, s)
	}

	return {
		days,
		today,
		cur,
		prev,
		since,
		series,
		kpi: {
			active: kpi('active', since.accounts, true),
			fresh: kpi('fresh', since.accounts),
			completed: kpi('completed', since.events),
			volume: kpi('volume', since.events),
			visits: kpi('visits', since.hits),
			revenue: { cur: revenue(cur), prev: full(proSince) ? revenue(prev) : null, spark: series.map((d) => revenueOf.get(d.day) ?? 0) },
		},
		now: { active: t.active, fresh: t.fresh, completed: t.completed, visits: t.visits },
		funnel: { fresh: fresh.length, returned: returned.length, tried: fresh.filter((a) => tried.has(a)).length, paid: fresh.filter((a) => payers.has(a)).length },
		refs: refRows,
		cohorts,
		pro: {
			paying: activeNow.filter((l) => !isTrial(l.plan)).length,
			trying: activeNow.filter((l) => isTrial(l.plan)).length,
			trials: r.trials.results.filter((x) => inCur(x.at)).length,
			purchases: r.paid.results.filter((p) => p.at && inCur(p.at)).length,
			revenue: Math.round(revenue(cur) * 100) / 100,
			trialsEnded: ended.length,
			trialsPaid: ended.filter((x) => payers.has(x.user)).length,
			pending: [...stuck.values()].sort((a, b) => b.last - a.last),
		},
	}
}

// ── La página ────────────────────────────────────────────────────────

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
const num = (v: number, dec = 0) => v.toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec })
const usd = (v: number) => `${num(v, v >= 1000 || Number.isInteger(v) ? 0 : 2)} USD`
const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic']
const shortDay = (day: string) => `${Number(day.slice(8))} ${MONTHS[Number(day.slice(5, 7)) - 1]}`
const WEEKDAYS = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb']
const longDay = (day: string) => `${WEEKDAYS[new Date(`${day}T12:00:00Z`).getUTCDay()]} ${shortDay(day)}`
const PLAN_NAMES: Record<string, string> = { week: '7 días', month: '30 días', quarter: '90 días', trial: 'prueba', gift: 'regalo' }

const ARROW_UP = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 13V3M3.5 7.5 8 3l4.5 4.5"/></svg>'
const ARROW_DOWN = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3v10M3.5 8.5 8 13l4.5-4.5"/></svg>'

// La variación contra el periodo anterior: flecha y % (subir es bueno en todas estas cifras)
export function delta(k: Kpi, label: string) {
	if (k.prev === null) return `<span class="delta none" title="Aún no hay datos de todo el periodo anterior">sin periodo anterior</span>`
	const was = `title="${label[0].toUpperCase() + label.slice(1)}: ${num(k.prev, Number.isInteger(k.prev) ? 0 : 1)}"`
	if (k.prev === 0) return k.cur ? `<span class="delta up" ${was}>${ARROW_UP}nuevo</span>` : `<span class="delta flat" ${was}>igual</span>`
	const p = (k.cur - k.prev) / k.prev
	if (Math.abs(p) < 0.005) return `<span class="delta flat" ${was}>igual</span>`
	return `<span class="delta ${p > 0 ? 'up' : 'down'}" ${was}>${p > 0 ? ARROW_UP : ARROW_DOWN}${num(Math.abs(p) * 100)}%</span>`
}

// Tendencia mínima dentro de una cifra: una línea, sin ejes
function spark(values: number[]) {
	if (values.length < 2) return ''
	const max = Math.max(...values, 1)
	const pts = values.map((v, i) => `${((i / (values.length - 1)) * 100).toFixed(2)},${(26 - (v / max) * 24).toFixed(2)}`).join(' ')
	return `<svg class="spark" viewBox="0 0 100 28" preserveAspectRatio="none" aria-hidden="true"><polyline points="${pts}" vector-effect="non-scaling-stroke"/></svg>`
}

function tile(label: string, value: string, k: Kpi | null, sub: string, compare: string) {
	return `<div class="kpi"><span class="kpi-l">${label}</span><b class="kpi-v">${value}</b><div class="kpi-d">${k ? delta(k, compare) : ''}<small>${sub}</small></div>${k ? spark(k.spark) : ''}</div>`
}

// Datos de un gráfico para el script de la página (lo dibuja a la medida de la pantalla, con su lectura al pasar)
export type Chart = {
	labels: string[]
	fmt: 'int' | 'usd'
	series: { name: string; kind: 'line' | 'bar' | 'area'; color: string; values: (number | null)[]; width?: number }[]
	// Opcional: en qué puntos poner etiqueta en el eje y con qué texto corto
	ticks?: number[]
	short?: Record<number, string>
}
export const chart = (id: string, c: Chart, title: string) =>
	`<div class="chart" id="${id}" role="img" aria-label="${esc(title)}"><script type="application/json">${JSON.stringify(c).replace(/</g, '\\u003c')}</script></div>`

export const legend = (items: [string, string, 'line' | 'bar'][]) =>
	`<div class="legend">${items.map(([name, color, kind]) => `<span><i class="key ${kind}" style="--c:${color}"></i>${name}</span>`).join('')}</div>`

// La misma tabla que el gráfico, para leer cada valor sin pasar el ratón
const dataTable = (head: string[], rows: string[][]) =>
	`<details class="tv"><summary>Ver los datos</summary><div class="wrap"><table><thead><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows
		.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`)
		.join('')}</tbody></table></div></details>`

// En un año, los gráficos van por semana (un año de días no se lee)
function bucketed(g: Growth) {
	if (g.days < 365) return g.series.map((d) => ({ ...d, label: shortDay(d.day), long: longDay(d.day) }))
	const map = new Map<string, GrowthDay & { n: number }>()
	for (const d of g.series) {
		const w = weekOf(d.day)
		const x = map.get(w) ?? (map.set(w, { day: w, active: 0, fresh: 0, visits: 0, web: 0, app: 0, completed: 0, volume: 0, n: 0 }), map.get(w)!)
		x.active += d.active
		x.fresh += d.fresh
		x.visits += d.visits
		x.web += d.web
		x.app += d.app
		x.completed += d.completed
		x.volume += d.volume
		x.n++
	}
	return [...map.values()].map((x) => ({ ...x, active: Math.round(x.active / x.n), label: shortDay(x.day), long: `semana del ${shortDay(x.day)}` }))
}

const pctText = (a: number, b: number) => (b ? `${num((a / b) * 100)}%` : '—')

export function growthHtml(g: Growth) {
	const k = g.kpi
	const compare = g.days === 7 ? 'la semana anterior' : `los ${g.days} días anteriores`
	const first = g.series[0]?.day ?? g.cur.from
	const range = `${shortDay(first)} – ${shortDay(g.cur.to)}${first > g.cur.from ? ' <span>(los datos empiezan aquí)</span>' : ''}`
	const pts = bucketed(g)
	const perWeek = g.days >= 365
	const unit = perWeek ? 'por semana' : 'por día'

	const today = `<div class="today"><span class="live-dot" aria-hidden="true"></span><b>Hoy, hasta ahora</b><span><b>${num(g.now.active)}</b> cuentas activas</span><span><b>${num(g.now.fresh)}</b> nuevas</span><span><b>${num(
		g.now.completed,
	)}</b> operaciones completadas</span><span><b>${num(g.now.visits)}</b> visitas</span></div>`

	const tiles = `<div class="kpis">
${tile('Cuentas activas al día', num(k.active.cur, 1), k.active, 'promedio, con su cuenta conectada', compare)}
${tile('Cuentas nuevas', num(k.fresh.cur), k.fresh, 'su primer día en el terminal', compare)}
${tile('Operaciones completadas', num(k.completed.cur), k.completed, 'empezadas desde el terminal', compare)}
${tile('Volumen completado', usd(Math.round(k.volume.cur)), k.volume, 'de esas operaciones', compare)}
${tile('Visitas', num(k.visits.cur), k.visits, 'a la web, el terminal y el simulador', compare)}
${tile('Ingresos de Pro', usd(k.revenue.cur), k.revenue, `${num(g.pro.paying)} pagando · ${num(g.pro.trying)} en prueba ahora`, compare)}
</div>`

	const usersChart = `<section class="panel"><div class="panel-h"><div><h2>Cuentas en el terminal</h2><p>Cuentas distintas conectadas ${perWeek ? 'al día (promedio de cada semana)' : 'cada día'} y cuántas entraron por primera vez</p></div>${legend([
		['Activas', 'var(--s1)', 'line'],
		['Nuevas', 'var(--s2)', 'bar'],
	])}</div><div class="panel-b">${chart(
		'ch-users',
		{
			labels: pts.map((p) => p.long),
			fmt: 'int',
			series: [
				{ name: 'Nuevas', kind: 'bar', color: 'var(--s2)', values: pts.map((p) => p.fresh) },
				{ name: 'Activas', kind: 'line', color: 'var(--s1)', values: pts.map((p) => p.active) },
			],
		},
		'Cuentas activas y nuevas',
	)}${dataTable(
		[perWeek ? 'Semana' : 'Día', 'Activas', 'Nuevas'],
		[...pts].reverse().map((p) => [p.long, num(p.active), num(p.fresh)]),
	)}</div></section>`

	const opsChart = `<div class="grid-2">
<section class="panel"><div class="panel-h"><div><h2>Operaciones completadas</h2><p>${unit[0].toUpperCase() + unit.slice(1)}, empezadas desde el terminal</p></div></div><div class="panel-b">${chart(
		'ch-ops',
		{ labels: pts.map((p) => p.long), fmt: 'int', series: [{ name: 'Completadas', kind: 'bar', color: 'var(--s1)', values: pts.map((p) => p.completed) }] },
		'Operaciones completadas',
	)}${dataTable([perWeek ? 'Semana' : 'Día', 'Completadas'], [...pts].reverse().map((p) => [p.long, num(p.completed)]))}</div></section>
<section class="panel"><div class="panel-h"><div><h2>Volumen completado</h2><p>USD ${unit}</p></div></div><div class="panel-b">${chart(
		'ch-vol',
		{ labels: pts.map((p) => p.long), fmt: 'usd', series: [{ name: 'Volumen', kind: 'area', color: 'var(--s1)', values: pts.map((p) => p.volume) }] },
		'Volumen completado',
	)}${dataTable([perWeek ? 'Semana' : 'Día', 'USD'], [...pts].reverse().map((p) => [p.long, num(p.volume, 2)]))}</div></section>
</div>`

	// Del primer día al pago
	const f = g.funnel
	const steps: [string, number, string][] = [
		['Cuentas nuevas', f.fresh, 'entraron por primera vez en el periodo'],
		['Volvieron otro día', f.returned, 'se conectaron en al menos otro día'],
		['Probaron Pro', f.tried, 'activaron sus días gratis'],
		['Pagaron Pro', f.paid, 'compraron días'],
	]
	const funnel = `<section class="panel"><div class="panel-h"><div><h2>Del primer día al pago</h2><p>Qué hicieron las cuentas que entraron por primera vez en el periodo, hasta hoy</p></div></div><div class="panel-b"><ol class="steps">${steps
		.map(
			([name, v, sub], i) =>
				`<li><div class="step-h"><span>${name}</span><b>${num(v)}</b>${i ? `<em>${pctText(v, f.fresh)} <span>de las nuevas</span></em>` : ''}</div><div class="bar-track"><i style="width:${f.fresh ? Math.max((v / f.fresh) * 100, v ? 1.5 : 0) : 0}%"></i></div><small>${sub}</small></li>`,
		)
		.join('')}</ol></div><div class="panel-f">Las cuentas de los últimos días aún no han tenido tiempo de volver ni de probar Pro: en un periodo corto este embudo siempre se ve más estrecho.</div></section>`

	// De dónde llegan
	const maxVisits = Math.max(1, ...g.refs.map((r) => r.visits))
	const refName = (r: Growth['refs'][number]) => (r.others ? `<span class="note">otros ${num(r.others)} enlaces</span>` : r.ref ? `<code>?de=${esc(r.ref)}</code>` : '<span class="note">directo o sin marcar</span>')
	const channels = `<section class="panel"><div class="panel-h"><div><h2>De dónde llegan</h2><p>Por el enlace con el que entraron (?de=…), en el periodo</p></div></div><div class="panel-b flush">${
		g.refs.length
			? `<div class="wrap"><table class="left"><thead><tr><th>Enlace</th><th>Visitas</th><th class="num">Conectan</th><th class="num">Primera vez</th><th class="num">Convierte</th></tr></thead><tbody>${g.refs
					.map(
						(r) =>
							`<tr><td>${refName(r)}</td><td class="barcell"><span class="minibar"><i style="width:${(r.visits / maxVisits) * 100}%"></i></span>${num(r.visits)}</td><td class="num">${num(r.connect)}</td><td class="num">${num(r.first)}</td><td class="num">${pctText(r.first, r.visits)}</td></tr>`,
					)
					.join('')}</tbody></table></div>`
			: '<p class="empty">Aún no hay visitas en este periodo.</p>'
	}</div><div class="panel-f">Conectan: navegadores con la cuenta conectada, uno por día. Primera vez: navegadores que conectan por primera vez. Convierte: primera vez ÷ visitas.</div></section>`

	// Cuántas vuelven
	const heat = (v: number) => `color-mix(in srgb, var(--s1) ${Math.round(8 + v * 72)}%, var(--surface))`
	const ink = (v: number) => (v >= 0.5 ? '#fff' : 'var(--text)')
	const cohorts = `<section class="panel"><div class="panel-h"><div><h2>Cuántas vuelven</h2><p>Cuentas nuevas de cada semana y el % que volvió a conectarse en las semanas siguientes</p></div></div><div class="panel-b flush">${
		g.cohorts.length
			? `<div class="wrap"><table class="cohort"><thead><tr><th>Primera semana</th><th class="num">Nuevas</th>${Array.from({ length: COHORT_AFTER }, (_, i) => `<th>+${i + 1} sem</th>`).join('')}</tr></thead><tbody>${g.cohorts
					.map(
						(c) =>
							`<tr><td>${shortDay(c.week)}</td><td class="num">${num(c.size)}</td>${Array.from({ length: COHORT_AFTER }, (_, i) =>
								c.after[i] == null
									? '<td class="hm empty-cell"></td>'
									: `<td class="hm${c.partial[i] ? ' partial' : ''}" style="background:${heat(c.after[i]!)};color:${ink(c.after[i]!)}" title="${c.partial[i] ? 'Semana en curso' : ''}">${num(c.after[i]! * 100)}%</td>`,
							).join('')}</tr>`,
					)
					.join('')}</tbody></table></div>`
			: '<p class="empty">Aún no hay cuentas nuevas para seguir.</p>'
	}</div><div class="panel-f">Las semanas empiezan el lunes. Una casilla con borde discontinuo es la semana en curso: aún puede subir.</div></section>`

	// Pro
	const p = g.pro
	const pending = p.pending.length
		? `<div class="wrap"><table class="left"><thead><tr><th>Cuenta</th><th>Quiso comprar</th><th class="num">Intentos</th><th>Último intento</th><th>Pro ahora</th></tr></thead><tbody>${p.pending
				.map(
					(x) =>
						`<tr><td><a href="/admin/pro?u=${encodeURIComponent(x.user)}">@${esc(x.user)}</a></td><td>${x.plans.map((pl) => PLAN_NAMES[pl] ?? esc(pl)).join(', ')}</td><td class="num">${num(x.tries)}</td><td>${longDay(cubaDate(x.last))}</td><td>${
							x.proUntil && x.proUntil > Date.now() ? `<span class="pill transferred">${PLAN_NAMES[x.proPlan ?? ''] ?? 'activo'}</span>` : '<span class="pill">sin Pro</span>'
						}</td></tr>`,
				)
				.join('')}</tbody></table></div>`
		: '<p class="empty">Nadie se quedó a medias en el periodo.</p>'
	const pro = `<section class="panel"><div class="panel-h"><div><h2>Pro</h2><p>Pruebas y pagos del periodo</p></div><div class="panel-a"><a class="btn" href="/admin/pro?view=pagos">Ver pagos</a></div></div><div class="panel-b"><div class="minis">
<div><span>Pagando ahora</span><b>${num(p.paying)}</b></div>
<div><span>En prueba ahora</span><b>${num(p.trying)}</b></div>
<div><span>Pruebas empezadas</span><b>${num(p.trials)}</b></div>
<div><span>Compras</span><b>${num(p.purchases)}</b><small>${usd(p.revenue)}</small></div>
<div><span>De prueba a pago</span><b>${pctText(p.trialsPaid, p.trialsEnded)}</b><small>${num(p.trialsPaid)} de ${num(p.trialsEnded)} pruebas acabadas</small></div>
</div></div><div class="panel-sub"><h3>Compras sin terminar</h3><p>Pidieron pagar en el periodo y no pagaron después. Vale la pena escribirles.</p></div><div class="panel-b flush">${pending}</div></section>`

	return `<p class="period">${range} <span>· días completos, hora de Cuba · comparado con ${compare}</span></p>
${today}
${tiles}
${usersChart}
${opsChart}
<div class="grid-2">${funnel}${cohorts}</div>
${channels}
${pro}`
}

// Estilos y script de esta parte (el resto del panel usa los de admin.ts)
export const GROWTH_CSS = `
:root{--s1:#5b8cff;--s2:#d95926}
@media (prefers-color-scheme:light){:root{--s1:#2f6bff;--s2:#eb6834}}
.period{margin:-10px 0 14px;color:var(--text);font-weight:600;font-size:13.5px}.period span{color:var(--muted);font-weight:400}
.today{display:flex;flex-wrap:wrap;align-items:center;gap:6px 18px;padding:10px 14px;margin-bottom:12px;border:1px solid var(--line);border-radius:10px;background:var(--surface);font-size:13px;color:var(--text2)}
.today>b{color:var(--text);font-weight:600}.today span b{color:var(--text);font-weight:650}
.live-dot{width:8px;height:8px;border-radius:50%;background:var(--bid);box-shadow:0 0 0 4px color-mix(in srgb,var(--bid) 20%,transparent)}
.kpis{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}
.kpi{position:relative;display:flex;flex-direction:column;padding:16px 18px 14px;border-radius:12px;background:var(--surface);border:1px solid var(--line);box-shadow:var(--shadow);overflow:hidden;min-height:132px}
.kpi-l{font-size:12.5px;color:var(--muted);font-weight:500}
.kpi-v{margin-top:6px;font-size:28px;font-weight:650;letter-spacing:-.02em;font-variant-numeric:normal;line-height:1.15}
.kpi-d{display:flex;flex-wrap:wrap;align-items:center;gap:4px 8px;margin-top:6px;position:relative;z-index:1}.kpi-d small{color:var(--muted);font-size:12px}
.delta{display:inline-flex;align-items:center;gap:3px;padding:1px 7px 1px 5px;border-radius:999px;font-size:12px;font-weight:600;line-height:18px}
.delta svg{width:12px;height:12px;stroke-width:2}
.delta.up{color:var(--bid);background:color-mix(in srgb,var(--bid) 13%,transparent)}.delta.down{color:var(--ask);background:color-mix(in srgb,var(--ask) 12%,transparent)}
.delta.flat,.delta.none{color:var(--muted);background:var(--raised);padding-left:7px;font-weight:500}
.spark{position:absolute;right:14px;top:16px;width:34%;height:30px;fill:none;stroke:var(--s1);stroke-width:1.6;opacity:.55}
.grid-2{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0 20px;align-items:start}
.legend{display:flex;flex-wrap:wrap;gap:4px 14px;font-size:12.5px;color:var(--text2)}.legend span{display:inline-flex;align-items:center;gap:6px}
.key{display:inline-block;background:var(--c)}.key.line{width:14px;height:2px;border-radius:2px}.key.bar{width:10px;height:10px;border-radius:3px}
.chart{position:relative;height:240px;touch-action:pan-y}.chart svg{display:block;width:100%;height:100%;overflow:visible;fill:none;stroke:none;stroke-width:1}
.chart .grid{stroke:var(--line);stroke-width:1}.chart .axis{fill:var(--muted);font-size:11px;font-variant-numeric:tabular-nums}
.chart .xh{stroke:var(--line2);stroke-width:1}
.chart .hit{fill:transparent;cursor:crosshair;outline:none}
.tip{position:absolute;z-index:3;pointer-events:none;min-width:140px;padding:8px 10px;border-radius:8px;background:var(--raised);border:1px solid var(--line2);box-shadow:0 6px 20px rgba(0,0,0,.25);font-size:12.5px;opacity:0;transition:opacity .08s}
.tip.on{opacity:1}.tip p{margin:0 0 4px;color:var(--muted)}.tip div{display:flex;align-items:center;gap:8px}.tip i{width:12px;height:2px;border-radius:2px}.tip b{font-weight:650;color:var(--text)}.tip span{color:var(--text2)}
details.tv{margin-top:10px}details.tv summary{cursor:pointer;color:var(--muted);font-size:12.5px;width:max-content}details.tv summary:hover{color:var(--text)}details.tv .wrap{margin-top:8px;max-height:280px;overflow:auto}
.steps{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:14px}
.step-h{display:flex;align-items:baseline;gap:10px}.step-h span{color:var(--text2);font-size:13px}.step-h b{margin-left:auto;font-size:17px;font-weight:650}
.step-h em{font-style:normal;font-size:12.5px;font-weight:600;color:var(--text);min-width:120px;text-align:right}.step-h em span{color:var(--muted);font-weight:400;font-size:12px}
.steps small{color:var(--muted);font-size:12px}
.bar-track{height:8px;margin:6px 0 4px;border-radius:999px;background:color-mix(in srgb,var(--s1) 14%,var(--surface))}.bar-track i{display:block;height:100%;border-radius:999px;background:var(--s1)}
td.barcell{min-width:180px}.minibar{display:inline-block;width:110px;height:6px;margin-right:10px;border-radius:999px;background:color-mix(in srgb,var(--s1) 14%,var(--surface));vertical-align:middle;overflow:hidden}.minibar i{display:block;height:100%;background:var(--s1);border-radius:999px}
table.cohort td.hm{text-align:center;font-weight:600;font-size:12.5px;border-left:2px solid var(--surface)}table.cohort td.partial{outline:1px dashed var(--muted);outline-offset:-4px}
table.cohort td.empty-cell{background:transparent}
.minis{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:10px}.minis div{padding:12px 14px;border-radius:10px;background:var(--raised)}.minis span{display:block;font-size:12px;color:var(--muted)}.minis b{display:block;margin-top:2px;font-size:20px;font-weight:650;font-variant-numeric:normal}.minis small{color:var(--text2);font-size:12px}
.panel-sub{padding:14px 18px 10px;border-top:1px solid var(--line)}.panel-sub h3{margin:0;font-size:14px;font-weight:600}.panel-sub p{margin:2px 0 0;color:var(--muted);font-size:12.5px}
details.more{margin-top:28px;border-top:1px solid var(--line);padding-top:14px}details.more>summary{cursor:pointer;list-style:none;display:flex;align-items:center;gap:8px;color:var(--text);font-weight:600;font-size:14px}
details.more>summary::-webkit-details-marker{display:none}details.more>summary::before{content:'›';display:inline-block;transition:transform .15s;color:var(--muted);font-size:18px;line-height:1}details.more[open]>summary::before{transform:rotate(90deg)}
details.more>summary small{color:var(--muted);font-weight:400;font-size:12.5px}
@media (max-width:1000px){.grid-2{grid-template-columns:minmax(0,1fr)}.kpis{grid-template-columns:repeat(2,minmax(0,1fr))}.minis{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media (max-width:860px){.kpi{min-height:118px;padding:12px 14px}.kpi-v{font-size:22px}.spark{position:static;order:5;width:100%;height:22px;margin-top:10px}.chart{height:200px}td.barcell{min-width:150px}.minibar{width:70px}}
`

// Dibuja los gráficos a la medida de su caja, con eje, rejilla y la lectura de cada día al pasar (o con las flechas)
export const GROWTH_JS = `(()=>{
const NS='http://www.w3.org/2000/svg'
const el=(n,a,p)=>{const e=document.createElementNS(NS,n);for(const k in a)e.setAttribute(k,a[k]);if(p)p.appendChild(e);return e}
const fmt=(v,f)=>f==='usd'?v.toLocaleString('en-US',{maximumFractionDigits:v<100?2:0})+' USD':v.toLocaleString('en-US',{maximumFractionDigits:1})
const tick=(v,f)=>v>=10000?(v/1000).toLocaleString('en-US',{maximumFractionDigits:1})+'K':v.toLocaleString('en-US')
function nice(max,int){if(max<=0)return [0,1,2,3,4];const raw=max/4,m=Math.pow(10,Math.floor(Math.log10(raw)));let s=[1,2,2.5,5,10].map(x=>x*m).find(x=>x>=raw);if(int)s=Math.max(1,Math.ceil(s));return [0,1,2,3,4].map(i=>+(i*s).toFixed(6))}
function draw(box){
 const c=JSON.parse(box.querySelector('script').textContent)
 box.querySelectorAll('svg,.tip').forEach(x=>x.remove())
 const W=box.clientWidth,H=box.clientHeight,L=40,R=8,T=10,B=26,n=c.labels.length
 if(!n||W<50)return
 const max=Math.max(...c.series.flatMap(s=>s.values).filter(v=>v!=null),0),ticks=nice(max,c.fmt==='int'),top=ticks[4]
 const svg=el('svg',{viewBox:'0 0 '+W+' '+H},box)
 const pw=W-L-R,ph=H-T-B,band=pw/n,x=i=>L+band*(i+.5),y=v=>T+ph-(v/top)*ph
 for(const t of ticks){el('line',{x1:L,x2:W-R,y1:y(t),y2:y(t),class:'grid'},svg);el('text',{x:L-8,y:y(t)+4,'text-anchor':'end',class:'axis'},svg).textContent=tick(t)}
 const every=Math.max(1,Math.ceil(n/Math.max(2,Math.floor(pw/64))))
 let marks=c.ticks||Array.from({length:Math.ceil(n/every)},(_,k)=>k*every)
 if(c.ticks&&c.ticks.length>1){const gap=band*(c.ticks[1]-c.ticks[0]),k=Math.ceil(48/gap);marks=c.ticks.filter((_,j)=>j%k===0)}
 for(const i of marks){const lab=(c.short&&c.short[i])||c.labels[i].replace(/^(semana del |\\S+ (?=\\d))/,'');el('text',{x:x(i),y:H-6,'text-anchor':'middle',class:'axis'},svg).textContent=lab}
 const bw=Math.max(2,Math.min(24,band-2)),bars=c.series.filter(s=>s.kind==='bar')
 for(const s of bars)s.values.forEach((v,i)=>{if(!v)return;const h=Math.max(1,(v/top)*ph),r=Math.min(4,bw/2,h),x0=x(i)-bw/2,y0=T+ph-h
  el('path',{d:'M'+x0+','+(T+ph)+'V'+(y0+r)+'Q'+x0+','+y0+' '+(x0+r)+','+y0+'H'+(x0+bw-r)+'Q'+(x0+bw)+','+y0+' '+(x0+bw)+','+(y0+r)+'V'+(T+ph)+'Z',fill:s.color},svg)})
 for(const s of c.series.filter(s=>s.kind!=='bar')){
  let d='',pen=false,a=-1,b=-1
  s.values.forEach((v,i)=>{if(v==null){pen=false;return}d+=(pen?'L':'M')+x(i).toFixed(1)+','+y(v).toFixed(1);pen=true;if(a<0)a=i;b=i})
  if(!d)continue
  if(s.kind==='area')el('path',{d:d+'L'+x(b)+','+(T+ph)+'L'+x(a)+','+(T+ph)+'Z',fill:s.color,'fill-opacity':.1},svg)
  el('path',{d,fill:'none',stroke:s.color,'stroke-width':s.width||2,'stroke-linejoin':'round','stroke-linecap':'round'},svg)
  if(a===b)el('circle',{cx:x(a),cy:y(s.values[a]),r:4,fill:s.color},svg)
 }
 const xh=el('line',{y1:T,y2:T+ph,class:'xh',visibility:'hidden'},svg)
 const dots=c.series.filter(s=>s.kind!=='bar').map(s=>el('circle',{r:4,fill:s.color,stroke:'var(--surface)','stroke-width':2,visibility:'hidden'},svg))
 const hit=el('rect',{x:L,y:T,width:pw,height:ph,class:'hit',tabindex:0},svg)
 hit.setAttribute('aria-label',box.getAttribute('aria-label')+': usa las flechas para leer cada punto')
 const tip=document.createElement('div');tip.className='tip';box.appendChild(tip)
 let cur=-1
 function show(i){cur=Math.max(0,Math.min(n-1,i));xh.setAttribute('x1',x(cur));xh.setAttribute('x2',x(cur));xh.setAttribute('visibility','visible')
  let k=0;for(const s of c.series){if(s.kind==='bar')continue;const v=s.values[cur];dots[k].setAttribute('cx',x(cur));if(v!=null)dots[k].setAttribute('cy',y(v));dots[k].setAttribute('visibility',v==null?'hidden':'visible');k++}
  tip.replaceChildren();const p=document.createElement('p');p.textContent=c.labels[cur];tip.appendChild(p)
  for(const s of [...c.series].reverse()){const r=document.createElement('div'),i2=document.createElement('i'),b=document.createElement('b'),sp=document.createElement('span');i2.style.background=s.color;b.textContent=s.values[cur]==null?'—':fmt(s.values[cur],c.fmt);sp.textContent=s.name;r.append(i2,b,sp);tip.appendChild(r)}
  tip.classList.add('on');const tw=tip.offsetWidth;let lx=x(cur)+12;if(lx+tw>W)lx=x(cur)-12-tw;tip.style.left=Math.max(0,lx)+'px';tip.style.top=T+'px'}
 function hide(){cur=-1;xh.setAttribute('visibility','hidden');dots.forEach(d=>d.setAttribute('visibility','hidden'));tip.classList.remove('on')}
 hit.addEventListener('pointermove',e=>{const r=svg.getBoundingClientRect();show(Math.floor((e.clientX-r.left-L)/band))})
 hit.addEventListener('pointerleave',hide);hit.addEventListener('blur',hide)
 hit.addEventListener('keydown',e=>{if(e.key==='ArrowRight'||e.key==='ArrowLeft'){e.preventDefault();show(cur<0?n-1:cur+(e.key==='ArrowRight'?1:-1))}else if(e.key==='Escape')hide()})
 hit.addEventListener('focus',()=>show(n-1))
}
const all=()=>document.querySelectorAll('.chart').forEach(draw)
window.drawCharts=all
all();let t;addEventListener('resize',()=>{clearTimeout(t);t=setTimeout(all,120)})
matchMedia('(prefers-color-scheme: dark)').addEventListener('change',all)
})()`
