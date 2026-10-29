// Métricas anónimas: qué se publica, se toma y se completa desde Terminal P2P.
//
// El relé anota cada acción del P2P que pasa por él (publicar, tomar, pagar, liberar,
// cancelar, calificar) y el navegador avisa cuando ve completada una operación que empezó
// aquí. Se guarda el tipo de acción, el resultado, el mercado, el lado y el monto. Nada
// de usuario, token ni IP: la oferta y la orden van como huellas HMAC-SHA-256 con una clave
// secreta (METRICS_SALT), que sirven para unir "publicada" con "completada" pero no para saber
// de qué oferta se trata, ni siquiera teniendo la base y una lista de ofertas.

import { p2pFee } from '../src/qvapay/fees.ts'
import { COINS } from '../src/terminal/market.ts'
import { pageHead, panel, periods } from './admin.ts'
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
	// Si QvaPay la rechazó, por qué: su código o el estado HTTP con su mensaje (errorOf). '' si salió bien
	err?: string
}

// El motivo de un rechazo de QvaPay, sin nada que identifique a nadie: su código si lo da (OFFER_PAUSED) o el estado
// HTTP con el mensaje, sin números, @usuarios ni correos, y corto
export function errorOf(status: number, body: Record<string, unknown>) {
	const code = typeof body.code === 'string' && /^[A-Z][A-Z0-9_]{2,40}$/.test(body.code) ? body.code : ''
	if (code) return code
	const raw = [body.error, body.message].find((v) => typeof v === 'string') as string | undefined
	const msg = (raw ?? '')
		.replace(/\S+@\S+/g, '')
		.replace(/@\w+/g, '@…')
		.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/gi, '…')
		.replace(/\b\d+([.,]\d+)*\b/g, '#')
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, 80)
	return msg ? `${status}: ${msg}` : String(status)
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
	return { coin: cleanCoin(p.get('coin')), side: cleanSide(p.get('side')), usd: cleanUsd(p.get('usd')), via: ['swap', 'smart', 'radar'].includes(p.get('via') ?? '') ? (p.get('via') as string) : '' }
}

const tryJson = (s: string | undefined) => {
	try {
		return s ? (JSON.parse(s) as Record<string, unknown>) : {}
	} catch {
		return {}
	}
}

// La comisión que cobró QvaPay al liberar, comparada con la que mostramos (la fija de src/qvapay/fees.ts). Un 0
// es una cuenta GOLD, que no paga. Si no cuadra, el aviso (sin datos de nadie: solo importes) va a los registros
export function feeMismatch(res: Record<string, unknown>): string | null {
	const gross = Number(res.gross_amount)
	const fee = Number(res.fee)
	if (!(gross > 0) || !Number.isFinite(fee) || fee === 0) return null
	const expected = p2pFee(gross)
	if (Math.abs(fee - expected) <= 0.011) return null
	return `comisión del P2P distinta de la esperada: cobró ${fee} de ${gross} USD (${((fee / gross) * 100).toFixed(3)} %), mostramos ${expected}. Revisa P2P_FEE en src/qvapay/fees.ts`
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
	const res = !ok || action.event === 'create' || action.event === 'release' ? tryJson(await a.response.text().catch(() => '')) : {}
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
	if (action.event === 'release') {
		usd = cleanUsd(res.gross_amount) || usd
		const odd = feeMismatch(res)
		if (odd) console.error(odd)
	}
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
		err: ok ? '' : errorOf(a.response.status, res),
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
		.prepare('INSERT INTO events (t, event, status, offer, ord, coin, side, usd, source, via, err) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
		.bind(e.t, e.event, e.status, e.offer, e.ord, e.coin, e.side, e.usd, e.source, e.via, e.err ?? '')
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
	// Por acción: cuántas se intentaron, cuántas rechazó QvaPay y por qué (motivo → veces)
	errors: Record<string, { tries: number; failed: number; why: Record<string, number> }>
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

	const errors: Summary['errors'] = {}
	for (const e of rows) {
		if (e.source !== 'relay') continue
		const x = (errors[e.event] ??= { tries: 0, failed: 0, why: {} })
		x.tries++
		if (e.status !== 'error') continue
		x.failed++
		const why = e.err || 'sin motivo (de antes de apuntarlo)'
		x.why[why] = (x.why[why] ?? 0) + 1
	}
	for (const k of Object.keys(errors)) if (!errors[k].failed) delete errors[k]

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

// Como mucho tantas acciones en memoria. Si alguna vez se llega, cuentan las más recientes (y el panel lo dice)
const MAX_EVENTS = 100_000
const EVENT_COLS = 't, event, status, offer, ord, coin, side, usd, source, via, err'

export async function loadSummary(db: D1, days: number, now = Date.now()) {
	const { results } = await db.prepare(`SELECT ${EVENT_COLS} FROM events WHERE t >= ? ORDER BY t DESC LIMIT ${MAX_EVENTS}`).bind(now - days * 86_400_000).all<MetricEvent>()
	return { ...summarize(results.reverse(), days), truncated: results.length >= MAX_EVENTS }
}

// ── Cifras públicas para la web (/data/stats) ─────────────────────────

// Lo mismo que el panel, sin errores ni detalle: desde la primera acción, las últimas 24 h y los últimos 30 días
export interface PublicStats {
	since: number | null
	created: number
	taken: number
	completed: number
	volume: number
	day: { created: number; taken: number; completed: number; volume: number }
	byDay: { day: string; completed: number; volume: number }[]
}

export function publicStats(rows: MetricEvent[], now = Date.now()): PublicStats {
	const all = summarize(rows, 0)
	const day = summarize(
		rows.filter((e) => e.t >= now - 86_400_000),
		1,
	)
	const from = cubaDate(now - 29 * 86_400_000)
	return {
		since: rows.reduce<number | null>((m, e) => (m === null || e.t < m ? e.t : m), null),
		created: all.created,
		taken: all.taken,
		completed: all.completed,
		volume: all.volume,
		day: { created: day.created, taken: day.taken, completed: day.completed, volume: day.volume },
		byDay: all.byDay
			.filter((d) => d.day >= from)
			.map((d) => ({ day: d.day, completed: d.completed, volume: Math.round(d.volume * 100) / 100 }))
			.reverse(),
	}
}

export async function loadPublicStats(db: D1, now = Date.now()) {
	const { results } = await db.prepare(`SELECT ${EVENT_COLS} FROM events ORDER BY t DESC LIMIT ${MAX_EVENTS}`).all<MetricEvent>()
	return publicStats(results.reverse(), now)
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
		// El navegador manda usuario:contraseña en UTF-8 (pedimos charset="UTF-8"): con tildes o eñes, atob solo
		// da los bytes sueltos y hay que decodificarlos, si no la contraseña nunca coincide
		const bytes = Uint8Array.from(atob(h.slice(6)), (c) => c.charCodeAt(0))
		pass = new TextDecoder().decode(bytes).split(/:(.*)/s)[1] ?? ''
	} catch {
		return false
	}
	return sameSecret(pass, key)
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
const n = (v: number) => v.toLocaleString('en-US', { maximumFractionDigits: 2 })
const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : '—')
const coinName = (t: string) => COINS.find((c) => c.tick === t)?.name ?? 'Sin identificar'
// Los códigos de QvaPay que más salen, en claro (el resto se enseña tal cual)
const ERROR_NAMES: Record<string, string> = {
	INSUFFICIENT_SCOPE: 'el token no tiene ese permiso',
	PEER_REQUIREMENTS_NOT_MET: 'no cumple los requisitos del anunciante',
	OFFER_PAUSED: 'la oferta está pausada',
	FLEXIBLE_NOT_ENABLED: 'su cuenta no puede tomar por rango',
	ORDER_ALREADY_ACTIVE: 'ya tenía una orden en esa oferta',
	ORDER_IN_DISPUTE: 'la orden está en disputa',
	KYC_REQUIRED: 'le falta el KYC',
	DUPLICATE_REQUEST: 'petición repetida',
	FLEXIBLE_OFFER_EXISTS: 'ya tiene una oferta por rango así',
	OFFER_HAS_OPEN_ORDERS: 'la oferta tiene órdenes en curso',
	OFFER_NOT_EDITABLE: 'la tomaron mientras la editaba',
	FLEXIBLE_AMOUNT_REQUIRED: 'faltó el monto',
	INVALID_REQUIREMENTS: 'requisito no válido',
	TP_ACCOUNT_BLOCKED: 'cuenta bloqueada en Terminal P2P',
	TP_ACCOUNT_RESTRICTED: 'cuenta restringida en Terminal P2P',
	TP_ORDERS_PAUSED: 'ofertas pausadas desde el panel',
}
// Sin código, lo que suele querer decir cada estado
const STATUS_NAMES: Record<string, string> = { '400': 'datos no válidos', '401': 'token no válido', '403': 'sin permiso', '404': 'ya no existe', '409': 'ya no estaba disponible', '422': 'datos no válidos', '423': 'bloqueado', '429': 'demasiadas seguidas', '500': 'error de QvaPay', '502': 'QvaPay no respondió', '503': 'QvaPay no disponible' }
const errorName = (why: string) => {
	const name = ERROR_NAMES[why] ?? (/^\d{3}$/.test(why) ? STATUS_NAMES[why] : null)
	return name ? `${esc(name)} <span class="note">${esc(why)}</span>` : esc(why)
}

const EVENT_NAMES: Record<string, string> = { create: 'Publicar', take: 'Tomar', paid: 'Marcar pagado', release: 'Liberar', cancel: 'Cancelar', rate: 'Calificar', completed: 'Completada' }

// En los rangos largos, «Por día» se agrupa por semana (90 días) o por mes (1 año): una fila por periodo
type Period = Summary['byDay'][number] & { label: string }
function byPeriod(byDay: Summary['byDay'], days: number) {
	const p = periods(days)
	const map = new Map<string, Period>()
	for (const d of byDay) {
		const k = p.key(d.day)
		const r = map.get(k) ?? (map.set(k, { day: k, label: p.label(k), created: 0, taken: 0, paid: 0, completed: 0, volume: 0 }), map.get(k)!)
		r.created += d.created
		r.taken += d.taken
		r.paid += d.paid
		r.completed += d.completed
		r.volume += d.volume
	}
	return { ...p, rows: [...map.values()].sort((a, b) => (a.day < b.day ? 1 : -1)) }
}

export function panelHtml(s: Summary & { truncated?: boolean }, visits = '') {
	const card = (label: string, value: string, sub = '') => `<div class="card"><span>${label}</span><b>${value}</b>${sub ? `<small>${sub}</small>` : ''}</div>`
	const step = (label: string, value: number, of: number | null) => `<li><b>${n(value)}</b><span>${label}</span>${of != null ? `<em>${pct(value, of)}</em>` : ''}</li>`
	const ranges = [7, 30, 90, 365].map((d) => `<a href="?days=${d}" class="${d === s.days ? 'on' : ''}">${d === 365 ? '1 año' : `${d} días`}</a>`).join('')
	const errors = Object.entries(s.errors)
	const table = (head: string[], rows: string) =>
		rows ? `<div class="wrap"><table><thead><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div>` : '<p class="empty">Aún no hay acciones en este periodo.</p>'
	return `${pageHead('Métricas', 'Visitas y acciones del P2P hechas desde el terminal. Anónimas: sin usuario, token, IP ni cookies.', `<nav class="ranges">${ranges}</nav>`)}
${s.truncated ? `<p class="note">Este periodo tiene más de ${n(MAX_EVENTS)} acciones: las cifras son de las ${n(MAX_EVENTS)} más recientes.</p>` : ''}
${visits ? `<h2 class="sec-title">Visitas</h2>${visits}<h2 class="sec-title">Acciones del P2P</h2>` : ''}
<div class="cards">
${card('Ofertas publicadas aquí', n(s.created))}
${card('Operaciones tomadas aquí', n(s.taken))}
${card('Operaciones completadas', n(s.completed), 'liberadas aquí o vistas completadas por quien las empezó aquí')}
${card('Volumen completado', `${n(s.volume)} USD`)}
${card('Vender ya', n(s.swaps), `${n(s.swapsCompleted)} completadas · ${n(s.swapVolume)} USD`)}
</div>
<div class="funnels">
<div class="funnel"><h3>Ofertas publicadas desde el terminal</h3><p>De las ofertas creadas aquí, cuántas tuvieron contraparte y cuántas llegaron a completar al menos una operación.</p><ol>
${step('publicadas', s.created, null)}${step('con contraparte', s.createdTaken, s.created)}${step('con al menos una operación completada', s.createdCompleted, s.created)}</ol></div>
<div class="funnel"><h3>Ofertas tomadas desde el terminal</h3><p>De las ofertas que alguien tomó aquí, cuántas se pagaron y cuántas se completaron.</p><ol>
${step('tomadas', s.taken, null)}${step('pagadas', s.takenPaid, s.taken)}${step('completadas', s.takenCompleted, s.taken)}</ol></div>
<div class="funnel"><h3>Vender ya</h3><p>Ventas de saldo a ofertas VIP hechas con «Vender ya», y cuántas se completaron.</p><ol>
${step('ventas empezadas', s.swaps, null)}${step('completadas', s.swapsCompleted, s.swaps)}</ol></div>
</div>
${panel(
	'Por mercado',
	table(['Mercado', 'Publicadas', 'Tomadas', 'Completadas', 'Volumen (USD)'], s.byCoin.map((c) => `<tr><td>${esc(coinName(c.coin))}</td><td>${n(c.created)}</td><td>${n(c.taken)}</td><td>${n(c.completed)}</td><td>${n(c.volume)}</td></tr>`).join('')),
	{ flush: true },
)}
${(() => {
	const p = byPeriod(s.byDay, s.days)
	return panel(
		p.title,
		table([p.column, 'Publicadas', 'Tomadas', 'Pagadas', 'Completadas', 'Volumen (USD)'], p.rows.map((d) => `<tr><td>${esc(d.label)}</td><td>${n(d.created)}</td><td>${n(d.taken)}</td><td>${n(d.paid)}</td><td>${n(d.completed)}</td><td>${n(d.volume)}</td></tr>`).join('')),
		{ sub: 'Hora de Cuba', flush: true },
	)
})()}
${panel(
	'Errores de QvaPay',
	errors.length
		? `<div class="wrap"><table class="left"><thead><tr><th>Acción</th><th class="num">Rechazadas</th><th>Por qué</th></tr></thead><tbody>${errors
				.sort((a, b) => b[1].failed - a[1].failed)
				.map(
					([k, v]) =>
						`<tr><td>${EVENT_NAMES[k] ?? esc(k)}</td><td class="num">${n(v.failed)} <span class="note">de ${n(v.tries)} (${pct(v.failed, v.tries)})</span></td><td style="white-space:normal">${Object.entries(v.why)
							.sort((a, b) => b[1] - a[1])
							.slice(0, 6)
							.map(([w, c]) => `${errorName(w)}: <b>${n(c)}</b>`)
							.join('<br>')}</td></tr>`,
				)
				.join('')}</tbody></table></div>`
		: '<p class="note" style="margin:0">Ninguno en este periodo.</p>',
	{
		flush: errors.length > 0,
		sub: 'Acciones hechas desde el terminal que QvaPay no aceptó. Algunas son normales (otro tomó antes la oferta); muchas iguales suelen ser un fallo nuestro',
		foot: 'Una operación completada se cuenta si se liberó desde el terminal o si quien la empezó aquí la vio completada en «Mis operaciones». Las acciones hechas en la web de QvaPay no se ven.',
	},
)}`
}
