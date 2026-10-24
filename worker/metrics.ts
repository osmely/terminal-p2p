// Métricas anónimas: qué se publica, se toma y se completa desde Terminal P2P.
//
// El relé anota cada acción del P2P que pasa por él (publicar, tomar, pagar, liberar,
// cancelar, calificar) y el navegador avisa cuando ve completada una operación que empezó
// aquí. Se guarda el tipo de acción, el resultado, el mercado, el lado y el monto. Nada
// de usuario, token ni IP: la oferta y la orden van como huellas HMAC-SHA-256 con una clave
// secreta (METRICS_SALT), que sirven para unir "publicada" con "completada" pero no para saber
// de qué oferta se trata, ni siquiera teniendo la base y una lista de ofertas.

import { COINS } from '../src/terminal/market.ts'
import { cubaDate } from './informal.ts'
import type { D1 } from './rates.ts'

export type EventKind = 'create' | 'take' | 'paid' | 'release' | 'cancel' | 'rate' | 'completed'

export interface MetricEvent {
	t: number
	event: EventKind
	status: 'ok' | 'error'
	offer: string
	ord: string
	coin: string
	side: string
	usd: number
	source: 'relay' | 'client'
	// Parte del terminal desde la que se hizo: 'swap' para «Vender ya», '' para el resto
	via: string
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const TICKS = new Set<string>(COINS.map((c) => c.tick))
const MAX_USD = 100_000

// Acción del P2P según la ruta del relé (sin el prefijo /qp). Editar, pausar y el chat no cuentan
const ACTIONS: Record<string, EventKind> = { apply: 'take', paid: 'paid', received: 'release', cancel: 'cancel', rate: 'rate' }
export function actionOf(method: string, path: string): { event: EventKind; offer: string } | null {
	if (method === 'POST' && path === '/p2p/create') return { event: 'create', offer: '' }
	const m = /^\/p2p\/([0-9a-f-]{36})\/(\w+)$/.exec(path)
	if (!m || !UUID.test(m[1]) || !(m[2] in ACTIONS) || (method !== 'POST' && !(method === 'PATCH' && m[2] === 'rate'))) return null
	return { event: ACTIONS[m[2]], offer: m[1] }
}

// Huella irreversible de un identificador de QvaPay: HMAC con la clave secreta METRICS_SALT.
// Sin la clave no se puede recalcular aunque se conozca el identificador
const hmacKeys = new Map<string, Promise<CryptoKey>>()
export async function fingerprint(id: string | null | undefined, salt: string) {
	if (!id || !UUID.test(id) || !salt) return ''
	let key = hmacKeys.get(salt)
	if (!key) {
		key = crypto.subtle.importKey('raw', new TextEncoder().encode(salt), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
		hmacKeys.set(salt, key)
	}
	const mac = await crypto.subtle.sign('HMAC', await key, new TextEncoder().encode(id))
	return [...new Uint8Array(mac).slice(0, 12)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

const cleanCoin = (v: unknown) => (typeof v === 'string' && TICKS.has(v) ? v : '')
const cleanSide = (v: unknown) => (v === 'buy' || v === 'sell' ? v : '')
const cleanUsd = (v: unknown) => {
	const n = Number(v)
	return Number.isFinite(n) && n > 0 && n <= MAX_USD ? Math.round(n * 100) / 100 : 0
}

// Datos que el navegador añade a sus escrituras para el relé (X-TP-Meta). No se reenvían a QvaPay
export function parseMeta(header: string | null) {
	const p = new URLSearchParams(header ?? '')
	return { coin: cleanCoin(p.get('coin')), side: cleanSide(p.get('side')), usd: cleanUsd(p.get('usd')), via: p.get('via') === 'swap' ? 'swap' : '' }
}

const tryJson = (s: string | undefined) => {
	try {
		return s ? (JSON.parse(s) as Record<string, unknown>) : {}
	} catch {
		return {}
	}
}

// Evento de una escritura que pasó por el relé: la petición, la respuesta de QvaPay y X-TP-Meta
export async function relayEvent(
	a: { method: string; path: string; query: URLSearchParams; body?: string; meta: string | null; response: Response },
	salt: string,
	now = Date.now(),
): Promise<MetricEvent | null> {
	const action = actionOf(a.method, a.path)
	if (!action) return null
	const meta = parseMeta(a.meta)
	const req = tryJson(a.body)
	const ok = a.response.ok
	const res = ok && (action.event === 'create' || action.event === 'release') ? tryJson(await a.response.text().catch(() => '')) : {}
	let offer = action.offer
	let { coin, side, usd } = meta
	if (action.event === 'create') {
		offer = String((res.p2p as { uuid?: string } | undefined)?.uuid ?? '')
		coin ||= cleanCoin(req.coin)
		side ||= cleanSide(req.type)
		usd ||= cleanUsd(req.amount ?? req.available_amount)
	}
	if (action.event === 'take') usd ||= cleanUsd(req.amount)
	// Al liberar, QvaPay devuelve el monto bruto de la operación
	if (action.event === 'release') usd = cleanUsd(res.gross_amount) || usd
	return {
		t: now,
		event: action.event,
		status: ok ? 'ok' : 'error',
		offer: await fingerprint(offer, salt),
		ord: await fingerprint(a.query.get('order'), salt),
		coin,
		side,
		usd,
		source: 'relay',
		via: meta.via,
	}
}

// Aviso del navegador: una operación que empezó aquí se completó (la liberó la contraparte)
export async function clientEvent(body: unknown, salt: string, now = Date.now()): Promise<MetricEvent | null> {
	const b = (body ?? {}) as Record<string, unknown>
	if (b.event !== 'completed' || typeof b.offer !== 'string' || !UUID.test(b.offer)) return null
	return {
		t: now,
		event: 'completed',
		status: 'ok',
		offer: await fingerprint(b.offer, salt),
		ord: await fingerprint(typeof b.order === 'string' ? b.order : null, salt),
		coin: cleanCoin(b.coin),
		side: cleanSide(b.side),
		usd: cleanUsd(b.usd),
		source: 'client',
		via: '',
	}
}

export async function saveEvent(db: D1, e: MetricEvent) {
	await db
		.prepare('INSERT INTO events (t, event, status, offer, ord, coin, side, usd, source, via) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
		.bind(e.t, e.event, e.status, e.offer, e.ord, e.coin, e.side, e.usd, e.source, e.via)
		.all()
}

// ── Resumen para el panel ─────────────────────────────────────────────

export interface Summary {
	days: number
	created: number
	createdTaken: number
	createdCompleted: number
	taken: number
	takenPaid: number
	takenCompleted: number
	completed: number
	volume: number
	// «Vender ya»: ventas empezadas, cuántas se completaron y su volumen
	swaps: number
	swapsCompleted: number
	swapVolume: number
	errors: Record<string, number>
	byCoin: { coin: string; created: number; taken: number; completed: number; volume: number }[]
	byDay: { day: string; created: number; taken: number; paid: number; completed: number; volume: number }[]
}

// Se calcula en memoria: son pocas filas (una por acción) y así no hay consultas costosas en D1
export function summarize(rows: MetricEvent[], days: number): Summary {
	const key = (e: MetricEvent) => `${e.offer}:${e.ord}`
	const ok = rows.filter((e) => e.status === 'ok' && e.offer)
	const coinOf = new Map<string, string>()
	const usdOf = new Map<string, number>()
	for (const e of ok) {
		if (e.coin && !coinOf.has(e.offer)) coinOf.set(e.offer, e.coin)
		if (e.usd && (e.event === 'release' || e.event === 'completed' || !usdOf.has(key(e)))) usdOf.set(key(e), e.usd)
	}
	const offersWith = (...kinds: EventKind[]) => new Set(ok.filter((e) => kinds.includes(e.event)).map((e) => e.offer))
	const created = offersWith('create')
	const taken = offersWith('take')
	const paid = offersWith('paid')
	const done = offersWith('release', 'completed')
	// Operaciones completadas: cada orden de una oferta por partes cuenta aparte
	const doneKeys = new Set(ok.filter((e) => e.event === 'release' || e.event === 'completed').map(key))
	const offerOfKey = (k: string) => k.slice(0, k.indexOf(':'))
	// Una oferta publicada aquí tuvo contraparte si después hubo pago o liberación sobre ella
	const engaged = offersWith('paid', 'release', 'completed', 'take')
	const usdDone = (k: string) => usdOf.get(k) ?? usdOf.get(`${offerOfKey(k)}:`) ?? 0
	const volume = [...doneKeys].reduce((s, k) => s + usdDone(k), 0)
	// Las ofertas de los VIP suelen ser por partes y las toman otros también, pero aquí solo llegan
	// las operaciones de quien usa el terminal: lo completado sobre una oferta vendida con «Vender ya» es suyo
	const swapOffers = new Set(ok.filter((e) => e.event === 'take' && e.via === 'swap').map((e) => e.offer))
	const swapDone = [...doneKeys].filter((k) => swapOffers.has(offerOfKey(k)))

	const errors: Record<string, number> = {}
	for (const e of rows) if (e.status === 'error') errors[e.event] = (errors[e.event] ?? 0) + 1

	const coins = new Map<string, Summary['byCoin'][number]>()
	const row = (c: string) => coins.get(c) ?? (coins.set(c, { coin: c, created: 0, taken: 0, completed: 0, volume: 0 }), coins.get(c)!)
	for (const o of created) row(coinOf.get(o) ?? '').created++
	for (const o of taken) row(coinOf.get(o) ?? '').taken++
	for (const k of doneKeys) {
		const r = row(coinOf.get(offerOfKey(k)) ?? '')
		r.completed++
		r.volume += usdOf.get(k) ?? usdOf.get(`${offerOfKey(k)}:`) ?? 0
	}

	const byDayMap = new Map<string, Summary['byDay'][number]>()
	const seen = new Set<string>()
	for (const e of [...ok].sort((a, b) => a.t - b.t)) {
		const day = cubaDate(e.t)
		const d = byDayMap.get(day) ?? (byDayMap.set(day, { day, created: 0, taken: 0, paid: 0, completed: 0, volume: 0 }), byDayMap.get(day)!)
		// Cada cosa cuenta una vez, el día en que pasó por primera vez
		const id = `${e.event === 'completed' ? 'release' : e.event}:${e.event === 'create' || e.event === 'take' ? e.offer : key(e)}`
		if (seen.has(id)) continue
		seen.add(id)
		if (e.event === 'create') d.created++
		else if (e.event === 'take') d.taken++
		else if (e.event === 'paid') d.paid++
		else if (e.event === 'release' || e.event === 'completed') {
			d.completed++
			d.volume += usdOf.get(key(e)) ?? usdOf.get(`${e.offer}:`) ?? 0
		}
	}

	return {
		days,
		created: created.size,
		createdTaken: [...created].filter((o) => engaged.has(o)).length,
		createdCompleted: [...created].filter((o) => done.has(o)).length,
		taken: taken.size,
		takenPaid: [...taken].filter((o) => paid.has(o) || done.has(o)).length,
		takenCompleted: [...taken].filter((o) => done.has(o)).length,
		completed: doneKeys.size,
		volume: Math.round(volume * 100) / 100,
		swaps: ok.filter((e) => e.event === 'take' && e.via === 'swap').length,
		swapsCompleted: swapDone.length,
		swapVolume: Math.round(swapDone.reduce((s, k) => s + usdDone(k), 0) * 100) / 100,
		errors,
		byCoin: [...coins.values()].sort((a, b) => b.completed - a.completed || b.created - a.created),
		byDay: [...byDayMap.values()].sort((a, b) => (a.day < b.day ? 1 : -1)),
	}
}

export async function loadSummary(db: D1, days: number, now = Date.now()) {
	const { results } = await db
		.prepare('SELECT t, event, status, offer, ord, coin, side, usd, source, via FROM events WHERE t >= ? ORDER BY t LIMIT 100000')
		.bind(now - days * 86_400_000)
		.all<MetricEvent>()
	return summarize(results, days)
}

// ── Panel privado (HTTP Basic con la clave METRICS_KEY) ───────────────

// Igualdad en tiempo constante: se comparan los SHA-256 de las dos cadenas byte a byte, sin
// cortar en la primera diferencia, para que el tiempo de respuesta no dé pistas de la clave
export async function sameSecret(a: string, b: string) {
	const enc = new TextEncoder()
	const [x, y] = await Promise.all([crypto.subtle.digest('SHA-256', enc.encode(a)), crypto.subtle.digest('SHA-256', enc.encode(b))])
	const u = new Uint8Array(x)
	const v = new Uint8Array(y)
	let diff = 0
	for (let i = 0; i < u.length; i++) diff |= u[i] ^ v[i]
	return diff === 0
}

export async function authorized(req: Request, key: string | undefined) {
	if (!key) return false
	const h = req.headers.get('authorization') ?? ''
	if (!h.startsWith('Basic ')) return false
	let pass = ''
	try {
		pass = atob(h.slice(6)).split(/:(.*)/s)[1] ?? ''
	} catch {
		return false
	}
	return sameSecret(pass, key)
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
const n = (v: number) => v.toLocaleString('es', { maximumFractionDigits: 2 })
const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : '—')
const coinName = (t: string) => COINS.find((c) => c.tick === t)?.name ?? 'Sin identificar'
const EVENT_NAMES: Record<string, string> = { create: 'Publicar', take: 'Tomar', paid: 'Marcar pagado', release: 'Liberar', cancel: 'Cancelar', rate: 'Calificar', completed: 'Completada' }

export function panelHtml(s: Summary) {
	const card = (label: string, value: string, sub = '') => `<div class="card"><span>${label}</span><b>${value}</b>${sub ? `<small>${sub}</small>` : ''}</div>`
	const step = (label: string, value: number, of: number | null) => `<li><b>${n(value)}</b><span>${label}</span>${of != null ? `<em>${pct(value, of)}</em>` : ''}</li>`
	const ranges = [7, 30, 90, 365].map((d) => `<a href="?days=${d}" class="${d === s.days ? 'on' : ''}">${d === 365 ? '1 año' : `${d} días`}</a>`).join('')
	const errors = Object.entries(s.errors)
	return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>Métricas · Terminal P2P</title>
<style>
:root{--bg:#0a0d12;--surface:#10151c;--line:#1e2733;--text:#e7ecf3;--text2:#a9b4c3;--muted:#7a8799;--accent:#5b8cff;--bid:#1fc28b;--ask:#f6465d;color-scheme:dark}
@media (prefers-color-scheme:light){:root{--bg:#f6f8fb;--surface:#fff;--line:#e3e8ef;--text:#121821;--text2:#3f4b5b;--muted:#6b7788;--accent:#2f6bff;--bid:#0f9d6e;--ask:#d9304a;color-scheme:light}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 system-ui,-apple-system,'Segoe UI',sans-serif}
main{width:min(1040px,100% - 32px);margin:32px auto 64px}h1{margin:0;font-size:24px}h2{margin:36px 0 12px;font-size:17px}
.top{display:flex;flex-wrap:wrap;gap:12px;align-items:center;justify-content:space-between}.note{color:var(--muted);font-size:13px;margin-top:6px}
.ranges{display:flex;gap:6px}.ranges a{padding:5px 12px;border-radius:999px;border:1px solid var(--line);color:var(--text2);text-decoration:none;font-size:13px}.ranges a.on{color:var(--accent);border-color:var(--accent)}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin-top:20px}
.card{display:flex;flex-direction:column;gap:4px;padding:16px;border-radius:12px;background:var(--surface);border:1px solid var(--line)}.card span{font-size:13px;color:var(--muted)}.card b{font:600 26px ui-monospace,Menlo,monospace}.card small{color:var(--text2);font-size:12.5px}
.funnels{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:12px}
.funnel{padding:16px;border-radius:12px;background:var(--surface);border:1px solid var(--line)}.funnel h3{margin:0 0 4px;font-size:15px}.funnel p{margin:0 0 12px;color:var(--muted);font-size:12.5px}
.funnel ol{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px}.funnel li{display:grid;grid-template-columns:70px 1fr auto;align-items:baseline;gap:10px;padding:8px 10px;border-radius:8px;background:var(--bg)}
.funnel li b{font:600 18px ui-monospace,Menlo,monospace}.funnel li em{font-style:normal;color:var(--bid);font:600 13px ui-monospace,Menlo,monospace}
table{width:100%;border-collapse:collapse;background:var(--surface);border:1px solid var(--line);border-radius:12px;overflow:hidden;font-size:14px}
th,td{padding:9px 12px;text-align:right;border-bottom:1px solid var(--line);white-space:nowrap}th:first-child,td:first-child{text-align:left}th{color:var(--muted);font-size:12px;font-weight:600}td{font-family:ui-monospace,Menlo,monospace}td:first-child{font-family:inherit}
.wrap{overflow-x:auto}.empty{color:var(--muted);padding:16px;text-align:center}
</style></head><body><main>
<div class="top"><div><h1>Métricas de Terminal P2P</h1><p class="note">Acciones del P2P hechas desde el terminal. Anónimas: sin usuario, token ni IP.</p></div><nav class="ranges">${ranges}</nav></div>
<div class="cards">
${card('Ofertas publicadas aquí', n(s.created))}
${card('Operaciones tomadas aquí', n(s.taken))}
${card('Operaciones completadas', n(s.completed), 'liberadas aquí o vistas completadas por quien las empezó aquí')}
${card('Volumen completado', `${n(s.volume)} USD`)}
${card('Vender ya', n(s.swaps), `${n(s.swapsCompleted)} completadas · ${n(s.swapVolume)} USD`)}
</div>
<h2>Embudos</h2>
<div class="funnels">
<div class="funnel"><h3>Ofertas publicadas desde el terminal</h3><p>De las ofertas creadas aquí, cuántas tuvieron contraparte y cuántas llegaron a completar al menos una operación.</p><ol>
${step('publicadas', s.created, null)}${step('con contraparte', s.createdTaken, s.created)}${step('con al menos una operación completada', s.createdCompleted, s.created)}</ol></div>
<div class="funnel"><h3>Ofertas tomadas desde el terminal</h3><p>De las ofertas que alguien tomó aquí, cuántas se pagaron y cuántas se completaron.</p><ol>
${step('tomadas', s.taken, null)}${step('pagadas', s.takenPaid, s.taken)}${step('completadas', s.takenCompleted, s.taken)}</ol></div>
<div class="funnel"><h3>Vender ya</h3><p>Ventas de saldo a ofertas VIP hechas con «Vender ya», y cuántas se completaron.</p><ol>
${step('ventas empezadas', s.swaps, null)}${step('completadas', s.swapsCompleted, s.swaps)}</ol></div>
</div>
<h2>Por mercado</h2>
<div class="wrap">${
		s.byCoin.length
			? `<table><thead><tr><th>Mercado</th><th>Publicadas</th><th>Tomadas</th><th>Completadas</th><th>Volumen (USD)</th></tr></thead><tbody>${s.byCoin
					.map((c) => `<tr><td>${esc(coinName(c.coin))}</td><td>${n(c.created)}</td><td>${n(c.taken)}</td><td>${n(c.completed)}</td><td>${n(c.volume)}</td></tr>`)
					.join('')}</tbody></table>`
			: '<p class="empty">Aún no hay acciones en este periodo.</p>'
	}</div>
<h2>Por día (hora de Cuba)</h2>
<div class="wrap">${
		s.byDay.length
			? `<table><thead><tr><th>Día</th><th>Publicadas</th><th>Tomadas</th><th>Pagadas</th><th>Completadas</th><th>Volumen (USD)</th></tr></thead><tbody>${s.byDay
					.map((d) => `<tr><td>${d.day}</td><td>${n(d.created)}</td><td>${n(d.taken)}</td><td>${n(d.paid)}</td><td>${n(d.completed)}</td><td>${n(d.volume)}</td></tr>`)
					.join('')}</tbody></table>`
			: '<p class="empty">Aún no hay acciones en este periodo.</p>'
	}</div>
<h2>Errores de QvaPay</h2>
<p class="note">${errors.length ? errors.map(([k, v]) => `${EVENT_NAMES[k] ?? k}: ${n(v)}`).join(' · ') : 'Ninguno en este periodo.'}</p>
<p class="note">Una operación completada se cuenta si se liberó desde el terminal o si quien la empezó aquí la vio completada en «Mis operaciones». Las acciones hechas en la web de QvaPay no se ven.</p>
</main></body></html>`
}
