// Plan Pro de Terminal P2P (app.terminalp2p.com/pro/*).
//
// Quién es cada usuario lo dice QvaPay: al pagar una factura de nuestra app, la API de comerciante
// devuelve quién la pagó (PaidBy); y al conectar la cuenta, el perfil que el relé trae de QvaPay deja
// firmado de quién es la huella de ese token (session.ts: readWho). El token nunca se guarda: de cada
// dispositivo solo vemos su huella (HMAC del token). Con ella se pregunta si eres Pro y se recoge el
// módulo Pro, firmado para ti. Pro va con la cuenta: cualquier dispositivo donde la conectes entra solo.

import { hex, hmac, sign, unb64url, verify } from './crypto.ts'
import { adminPage, askKey, pageHead, panel, searchIcon, type AdminTab } from './admin.ts'
import { authorized } from './metrics.ts'
import { cubaOffset, inCuba, type D1 } from './rates.ts'
import { clearWho, readWho, sessionCookie, sessionToken } from './session.ts'
import { alertsReady, notify, panelUrl, tgEsc, type AlertEnv } from './alerts.ts'
import { seal, sendBackup, snapshot } from './backup.ts'
import { GRACE_MS, INCIDENT_NAME, openIncidents, recordIncident, resolveIncident, type Incident } from './incidents.ts'
import { cleanRadarHit, connectBot, linked, linkUrl, radarButton, radarText, tellDays, tellPaid, tellRefund, tellUser, unlink, botWebhook } from './userbot.ts'
import { ORDERS_PAUSED_MSG, ordersPaused, proEnabled, setOrdersPaused, setProEnabled } from './flags.ts'
import { dailyPostOn, lastPosts, POST_HOUR, setDailyPost, testDailyPost } from './community.ts'
import { COINS } from '../src/terminal/market.ts'
import { liveClients, liveSimulate, liveStatus, type LagStats, type LiveClient, type LiveEnv, type LiveState } from './livebook.ts'
import { cubaDate, liveDay, SLOT_MS, type LiveDay } from './livehistory.ts'
import { addAlert, deleteAlert, latestRates, listAlerts, MAX_ALERTS } from './ratealerts.ts'
import { offerAlertsOn, setOfferAlerts } from './offeralerts.ts'
import { ACCESS_NAME, accessError, accessOf, activeBlocks, blockOf, isActive, liftBlock, setBlock, type AccessLevel, type Block } from './blocks.ts'
import { BODY_MAX, cleanupInbox, ctaOf, isSegment, listInbox, markRead, retireMessage, SEGMENTS, segmentAccounts, sendInbox, sentMessages, TITLE_MAX, type InboxEnv } from './inbox.ts'
import { diagOf, hourKey, logUser, timeline, type DiagEntry, type LogKind, type TimelineFilter, type TimelineRow } from './userlog.ts'

export interface ProEnv extends AlertEnv {
	DB: D1
	// App de comerciante de QvaPay: facturas y quién pagó. Sin ellas no se puede comprar
	QVAPAY_APP_ID?: string
	QVAPAY_APP_SECRET?: string
	// Clave con la que se firman las licencias de 24 h (secreto). Sin ella Pro no funciona
	PRO_KEY?: string
	// Almacén privado con el módulo Pro (module.js), que no está en el repositorio público, y la copia diaria
	// de las tablas de Pro (backup/pro/AAAA-MM-DD)
	PRO?: { get(key: string): Promise<string | null>; put?(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void> }
	// Clave del panel (la misma de las métricas)
	METRICS_KEY?: string
	// El grupo de la comunidad, donde sale la «Tasa QvaPay del día»
	COMMUNITY_CHAT?: string
	// Clave con que se cifra la copia diaria que va a Telegram (secreto; guárdala tú: sin ella no se puede restaurar)
	BACKUP_KEY?: string
}

export const PLANS = {
	week: { usd: 1.99, days: 7, name: '7 días' },
	month: { usd: 3.99, days: 30, name: '30 días' },
	quarter: { usd: 9.99, days: 90, name: '90 días' },
} as const
export type Plan = keyof typeof PLANS
// Para las consultas de cuentas con días comprados (las demás son trial y gift)
const PAID_PLANS_SQL = Object.keys(PLANS).map((p) => `'${p}'`).join(', ')

// Las compras no se devuelven, salvo error en el pago (pagada dos veces, paquete equivocado…): eso lo decides tú desde el
// panel. Para «no me convence» están los días gratis
export const NO_REFUNDS = 'Las compras no se reembolsan. Si tienes alguna dificultad, consúltanos en el grupo de Telegram: t.me/terminalp2p'
// Al devolver, cada día usado se cobra a lo que vale un día comprando la semana (el día más caro): así un paquete
// largo, usado unos días y devuelto, no sale más barato que la semana. Se guarda en cada compra al pedirla
export const USED_DAY_USD = PLANS.week.usd / PLANS.week.days
// Los días gratis: el terminal y la web los reciben de aquí (statusOf, data-trial en worker/index.ts)
export const TRIAL_DAYS = 7
// Topes de días gratis nuevos: por IP y día (amplio: muchos comparten IP en Cuba) y en total por día. No hacen
// imposible inventar cuentas (el servidor no ve el token), pero lo vuelven lento y caro
export const TRIAL_PER_IP_DAY = 30
export const TRIAL_PER_DAY = 1000
// Facturas sin pagar que puede tener abiertas una cuenta en la última hora: más es un error o un abuso, y solo
// frena a esa cuenta. Pedir una exige la cuenta de QvaPay confirmada, así que no se pueden inventar
export const PENDING_PER_ACCOUNT = 5
// Facturas pendientes de la última hora en total: freno de emergencia, muy por encima de lo normal
export const PENDING_MAX = 1000
const DAY_MS = 86_400_000
const HOUR_MS = 3_600_000
// Avisos del radar por Telegram que puede recibir una cuenta en una hora
const RADAR_TG_PER_HOUR = 30
const LICENSE_MS = DAY_MS // la licencia firmada vale un día y el terminal la renueva sola
const CHECKOUT_MS = 60 * 60_000
// Con días de Pro (pagados o regalados) solo se compran más cuando quedan pocos; con los días gratis, siempre
export const RENEW_DAYS = 5
// Una factura pendiente se reutiliza si aún le queda margen para pagarla
const REUSE_MS = 45 * 60_000
const PAY_URL = 'https://www.qvapay.com/pay/'
const QVAPAY = 'https://api.qvapay.com'
const PRINT = /^[0-9a-f]{64}$/

export interface License {
	uuid: string
	username: string
	plan: string
	expires_at: number
	backup_hash: string | null
	revoked: number
}

interface Checkout {
	id: string
	print: string // '' si se pidió desde el simulador
	tg: number | null // facturas antiguas pedidas desde el simulador (ya no se puede comprar allí)
	plan: Plan
	amount: number
	invoice: string | null
	status: 'pending' | 'paid'
	license: string | null
	backup_code: string | null
	created_at: number
	paid_at: number | null
	requester: string | null // la cuenta conectada al terminal que la pidió (confirmada por QvaPay al conectar)
	payer: string | null // quien pagó, según QvaPay
	day_usd: number | null // lo que vale cada día usado si la devuelve (el día de la semana cuando la compró)
}

export class ProError extends Error {
	readonly status: number
	constructor(status: number, message: string) {
		super(message)
		this.status = status
	}
}

const json = (status: number, body: unknown) =>
	new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } })


// ── Licencias y dispositivos ─────────────────────────────────────────

export async function licenseOfPrint(db: D1, print: string, now: number): Promise<License | null> {
	const l = await db
		.prepare('SELECT l.uuid, l.username, l.plan, l.expires_at, l.backup_hash, l.revoked FROM pro_prints p JOIN pro_licenses l ON l.uuid = p.license WHERE p.print = ?')
		.bind(print)
		.first<License>()
	return l && !l.revoked && l.expires_at > now ? l : null
}

// Añade un dispositivo a una licencia. Sin tope: solo se añaden los de la propia cuenta (o el que pagó)
export async function attachPrint(db: D1, license: string, print: string, now: number) {
	await db
		.prepare('INSERT INTO pro_prints (print, license, added_at, seen_at) VALUES (?, ?, ?, ?) ON CONFLICT(print) DO UPDATE SET license = excluded.license, seen_at = excluded.seen_at')
		.bind(print, license, now, now)
		.run()
}

// ── Libro de movimientos de días ─────────────────────────────────────
// Cada usuario de QvaPay tiene una sola cuenta Pro (qp:usuario). Todo lo que cambia sus días (los gratis, una
// compra, un regalo, una devolución, un ajuste) pasa por aquí y queda apuntado en pro_days con el motivo y el
// saldo de antes y de después. Nada se borra: una devolución resta los días de esa compra y ya

export const accountOf = (username: string) => `qp:${username.toLowerCase()}`
// Cuánto tiempo después de acabarse los días el terminal sigue avisando de que se acabaron
const ENDED_SHOWN_MS = 7 * 86_400_000
// «Usa mucho el terminal»: en las últimas 2 semanas, al menos 3 días y 5 horas con él abierto (live_seen)
const HEAVY_DAYS = 3
const HEAVY_MINUTES = 300
const HEAVY_SPAN_DAYS = 14
export async function heavyUse(db: D1, username: string, now: number) {
	const from = inCuba(now - HEAVY_SPAN_DAYS * 86_400_000).toISOString().slice(0, 10)
	const r = await db
		.prepare('SELECT COUNT(*) AS days, COALESCE(SUM(minutes), 0) AS minutes FROM live_seen WHERE account = ? AND day >= ?')
		.bind(username.toLowerCase(), from)
		.first<{ days: number; minutes: number }>()
	return r && r.days >= HEAVY_DAYS && r.minutes >= HEAVY_MINUTES ? { days: r.days, hours: Math.round(r.minutes / 60) } : null
}
export type DayKind = 'trial' | 'purchase' | 'gift' | 'refund' | 'adjust'

export async function addDays(
	db: D1,
	username: string,
	m: { kind: DayKind; days: number; plan?: string; checkout?: string | null; note?: string | null; actor: 'system' | 'admin' },
	now: number,
) {
	const id = accountOf(username)
	const old = await db.prepare('SELECT expires_at, plan, revoked FROM pro_licenses WHERE uuid = ?').bind(id).first<{ expires_at: number; plan: string; revoked: number }>()
	const days = Math.trunc(m.days)
	// El tipo de días que tiene ahora: el de lo último que sumó (los gratis permiten comprar más cuando quiera). Al
	// devolver una compra, el de lo último que sumó y sigue en pie (si compró sobre los gratis, vuelven a ser gratis)
	const kept =
		m.kind === 'refund'
			? await db
					.prepare(
						"SELECT d.kind, c.plan FROM pro_days d LEFT JOIN pro_checkouts c ON c.id = d.checkout WHERE d.license = ? AND d.days > 0 AND d.kind != 'adjust' AND (d.checkout IS NULL OR c.refunded_at IS NULL) ORDER BY d.id DESC LIMIT 1",
					)
					.bind(id)
					.first<{ kind: string; plan: string | null }>()
			: null
	const keptPlan = kept?.kind === 'purchase' ? kept.plan : kept?.kind === 'trial' || kept?.kind === 'gift' ? kept.kind : null
	const plan = days > 0 && m.kind !== 'adjust' ? (m.plan ?? m.kind) : (keptPlan ?? old?.plan ?? m.plan ?? m.kind)
	// La cuenta y su movimiento van juntos (batch es una transacción): o quedan los dos o ninguno. Los días se cuentan
	// dentro de la base desde lo que tenga la cuenta en ese momento: si dos cambios llegan a la vez (dos facturas
	// pagadas, un regalo mientras paga), ninguno pisa al otro. Sumar cuenta desde hoy si ya había vencido; restar nunca
	// deja la cuenta antes de hoy (ni toca una ya vencida). Pagar no levanta una suspensión: los días se suman y sigue
	// suspendida hasta que la reactives (o le devuelvas el dinero)
	await db.batch([
		db
			.prepare(
				`INSERT INTO pro_days (license, kind, days, expires_before, expires_after, checkout, note, actor, created_at)
				SELECT ?1, ?2, ?3, b.e, CASE WHEN ?3 >= 0 THEN MAX(?4, COALESCE(b.e, 0)) + ?3 * ${DAY_MS} WHEN b.e > ?4 THEN MAX(?4, b.e + ?3 * ${DAY_MS}) ELSE COALESCE(b.e, ?4) END, ?5, ?6, ?7, ?4
				FROM (SELECT (SELECT expires_at FROM pro_licenses WHERE uuid = ?1) AS e) b`,
			)
			.bind(id, m.kind, days, now, m.checkout ?? null, m.note ?? null, m.actor),
		db
			.prepare(
				`INSERT INTO pro_licenses (uuid, username, plan, expires_at, backup_hash, revoked, created_at, updated_at)
				VALUES (?1, ?2, ?3, (SELECT expires_after FROM pro_days WHERE license = ?1 ORDER BY id DESC LIMIT 1), NULL, 0, ?4, ?4)
				ON CONFLICT(uuid) DO UPDATE SET username = excluded.username, plan = excluded.plan, expires_at = excluded.expires_at, updated_at = excluded.updated_at`,
			)
			.bind(id, username, plan, now),
	])
	const r = await db
		.prepare('SELECT expires_before, expires_after FROM pro_days WHERE license = ? AND kind = ? AND created_at = ? AND checkout IS ? ORDER BY id DESC LIMIT 1')
		.bind(id, m.kind, now, m.checkout ?? null)
		.first<{ expires_before: number | null; expires_after: number }>()
	return { license: id, before: r?.expires_before ?? null, after: r?.expires_after ?? now, suspended: !!old?.revoked }
}

// Cuánto se devuelve de una compra: lo que pagó menos sus días usados, cada uno a lo que vale un día de la semana
// (USED_DAY_USD, el guardado en la compra), y nunca más que la parte de sus días que no usó. Qué días
// quedan de cada compra sale de rehacer su libro de días (pro_days) en orden: los días se gastan en el orden en que se
// sumaron (los gratis, regalos o compras que ya tenía van antes), y devolver una compra quita lo que le quedaba a ella,
// con lo que las de detrás se adelantan. Solo cuentan como usados los días completos: el día en curso todavía se
// devuelve. Se redondea a centavos hacia abajo
export interface DayRow {
	license: string
	kind: string
	days: number
	expires_before: number | null
	expires_after: number
	checkout: string | null
	created_at: number
}
export interface Left {
	days: number // los que sumó la compra
	ms: number // lo que le queda sin gastar
}
export function purchasesLeft(rows: DayRow[], now: number) {
	const q: { checkout: string | null; ms: number }[] = []
	const left = new Map<string, Left>()
	let at = rows[0]?.created_at ?? now
	const total = () => q.reduce((t, s) => t + s.ms, 0)
	// El tiempo que pasa se gasta desde el principio de la cola
	const spend = (to: number) => {
		let ms = Math.max(0, to - at)
		at = Math.max(at, to)
		while (ms > 0 && q.length) {
			const k = Math.min(ms, q[0].ms)
			q[0].ms -= k
			ms -= k
			if (q[0].ms <= 0) q.shift()
		}
	}
	// Restar días quita del final (lo último que se gastaría)
	const cut = (ms: number) => {
		while (ms > 0 && q.length) {
			const s = q[q.length - 1]
			const k = Math.min(ms, s.ms)
			s.ms -= k
			ms -= k
			if (s.ms <= 0) q.pop()
		}
	}
	for (const r of rows) {
		spend(r.created_at)
		// Lo que el libro dice que tenía la cuenta: manda sobre lo calculado (días que entraron sin movimiento, como los
		// de una licencia juntada, van delante)
		const had = Math.max(0, (r.expires_before ?? 0) - r.created_at)
		const t = total()
		if (had > t + 1000) q.unshift({ checkout: null, ms: had - t })
		else if (had < t - 1000) cut(t - had)
		const delta = Math.max(0, r.expires_after - r.created_at) - had
		if (r.kind === 'purchase' && r.checkout) left.set(r.checkout, { days: r.days, ms: 0 })
		if (delta > 0) q.push({ checkout: r.kind === 'purchase' ? r.checkout : null, ms: delta })
		else if (delta < 0) {
			let ms = -delta
			const s = r.kind === 'refund' && r.checkout ? q.find((x) => x.checkout === r.checkout) : undefined
			if (s) {
				const k = Math.min(ms, s.ms)
				s.ms -= k
				ms -= k
				if (s.ms <= 0) q.splice(q.indexOf(s), 1)
			}
			cut(ms)
		}
	}
	spend(now)
	for (const s of q) if (s.checkout && left.has(s.checkout)) left.get(s.checkout)!.ms += s.ms
	return left
}
export function quoteOf(amount: number, l: Left | undefined, dayUsd: number | null = null) {
	if (!l || !(l.days > 0)) return { days: l?.days ?? 0, used: l?.days ?? 0, unused: 0, usd: 0 }
	const used = Math.min(l.days, Math.max(0, Math.floor((l.days * DAY_MS - l.ms) / DAY_MS)))
	const unused = l.ms > 0 ? l.days - used : 0
	const back = Math.min(amount - (l.days - unused) * (dayUsd ?? USED_DAY_USD), (amount * unused) / l.days)
	return { days: l.days, used: l.days - unused, unused, usd: unused > 0 ? Math.max(0, Math.floor(back * 100 + 1e-6) / 100) : 0 }
}
export type Quote = ReturnType<typeof quoteOf>
// Lo que les queda a las compras de esas cuentas (una consulta para todas)
export async function leftOf(db: D1, licenses: string[], now: number) {
	const ids = [...new Set(licenses.filter(Boolean))]
	const out = new Map<string, Left>()
	for (let i = 0; i < ids.length; i += 50) {
		const part = ids.slice(i, i + 50)
		const { results } = await db
			.prepare(`SELECT license, kind, days, expires_before, expires_after, checkout, created_at FROM pro_days WHERE license IN (${part.map(() => '?').join(',')}) ORDER BY license, id`)
			.bind(...part)
			.all<DayRow>()
		for (const id of part) for (const [k, v] of purchasesLeft(results.filter((r) => r.license === id), now)) out.set(k, v)
	}
	return out
}
export async function refundQuote(db: D1, checkout: string, now: number) {
	const c = await db.prepare("SELECT license, amount, day_usd FROM pro_checkouts WHERE id = ? AND status = 'paid'").bind(checkout).first<{ license: string; amount: number; day_usd: number | null }>()
	return c ? quoteOf(c.amount, (await leftOf(db, [c.license], now)).get(checkout), c.day_usd) : null
}

// Devolver una compra: se restan los días que no usó de ella, se apunta lo que se le devuelve (en la compra y en su
// devolución) y se da por devuelta. Los dispositivos y el resto de sus días siguen igual. El dinero va de la cuenta de
// la app a quien pagó (payRefund) o lo transfieres tú
export async function refundCheckout(db: D1, checkout: string, note: string | null, now: number) {
	const c = await db
		.prepare("SELECT c.id, c.plan, c.amount, c.license, COALESCE(c.payer, l.username) AS payer, l.username FROM pro_checkouts c JOIN pro_licenses l ON l.uuid = c.license WHERE c.id = ? AND c.status = 'paid' AND c.refunded_at IS NULL")
		.bind(checkout)
		.first<{ id: string; plan: Plan; amount: number; license: string; payer: string; username: string }>()
	if (!c) return null
	const q = await refundQuote(db, c.id, now)
	if (!q || !(q.usd > 0)) throw new ProError(409, 'Ya se usaron todos los días de esa compra: no queda nada que devolver')
	const marked = await db.prepare('UPDATE pro_checkouts SET refunded_at = ?, refund_usd = ? WHERE id = ? AND refunded_at IS NULL').bind(now, q.usd, c.id).run()
	if (!marked.meta?.changes) return null
	try {
		const r = await addDays(db, c.username, { kind: 'refund', days: -q.unused, checkout: c.id, note, actor: 'admin' }, now)
		await db.prepare('UPDATE pro_refunds SET amount = ? WHERE checkout = ?').bind(q.usd, c.id).run()
		return { ...c, ...r, refund: q }
	} catch (err) {
		// Sin quitarle los días no puede quedar devuelta (si no, aprobarla otra vez diría «ya se devolvió»). Salvo que la
		// base sí los quitara y solo se perdiera su respuesta
		if (!(await daysOf(db, c.id, 'refund'))) await db.prepare('UPDATE pro_checkouts SET refunded_at = NULL, refund_usd = NULL WHERE id = ?').bind(c.id).run()
		throw err
	}
}

// ¿Ya consta en el libro el movimiento de días de esa compra? (si la base no responde, se da por no)
const daysOf = (db: D1, checkout: string, kind: DayKind) =>
	db
		.prepare('SELECT 1 FROM pro_days WHERE checkout = ? AND kind = ?')
		.bind(checkout, kind)
		.first()
		.catch(() => null)

// Lo que el terminal necesita saber: si eres Pro, hasta cuándo y la licencia firmada para recoger el módulo
// Y los paquetes con sus precios y los días gratis: así solo están escritos aquí (la web los recibe igual, worker/index.ts)
export async function statusOf(env: ProEnv, l: License | null, now: number) {
	if (!l) return { pro: false, enabled: true, plans: planList(), trialDays: TRIAL_DAYS }
	const license = await sign({ u: l.uuid, n: l.username, e: l.expires_at, x: now + LICENSE_MS }, env.PRO_KEY!)
	return { pro: true, enabled: true, username: l.username, plan: l.plan, expiresAt: l.expires_at, license, plans: planList(), trialDays: TRIAL_DAYS }
}
export const planList = () => (Object.keys(PLANS) as Plan[]).map((id) => ({ id, name: PLANS[id].name, usd: PLANS[id].usd, days: PLANS[id].days }))

// ── Devoluciones en pasos ────────────────────────────────────────────
// Pedida → aprobada (se le quitan los días de esa compra que no usó) → transferida (con QvaPay o la marcas tú). O
// rechazada, con un motivo que el usuario ve. Ahora solo las haces tú (en un paso, adminRefund); las pedidas por el
// usuario son de cuando podía pedirlas desde «Mi cuenta», y se aprueban o rechazan igual

export type RefundStatus = 'requested' | 'approved' | 'transferred' | 'rejected'
export interface Refund {
	id: string
	checkout: string
	license: string
	amount: number
	payee: string
	status: RefundStatus
	reason: string | null
	requested_by: 'user' | 'admin'
	requested_at: number
	decided_at: number | null
	decision_note: string | null
	transferred_at: number | null
	transfer_ref: string | null
}

// La compra pagada y a quién se le devolvería (quien la pagó)
const refundable = (db: D1, checkout: string) =>
	db
		.prepare(
			`SELECT c.id, c.plan, c.amount, c.license, COALESCE(c.payer, l.username) AS payee, c.refunded_at
			FROM pro_checkouts c JOIN pro_licenses l ON l.uuid = c.license WHERE c.id = ? AND c.status = 'paid'`,
		)
		.bind(checkout)
		.first<{ id: string; plan: Plan; amount: number; license: string; payee: string; refunded_at: number | null }>()

export async function requestRefund(db: D1, license: string, checkout: string, reason: string, by: 'user' | 'admin', now: number) {
	const c = await refundable(db, checkout)
	if (!c || c.license !== license) throw new ProError(404, 'Esa compra no es tuya o no existe')
	if (c.refunded_at) throw new ProError(409, 'Esa compra ya se devolvió')
	if (await db.prepare('SELECT 1 FROM pro_refunds WHERE checkout = ?').bind(checkout).first()) throw new ProError(409, 'Ya pediste la devolución de esa compra')
	// Lo que se devolvería hoy (al aprobarla se calcula otra vez, con los días que entonces queden)
	const q = await refundQuote(db, checkout, now)
	if (!q || !(q.usd > 0)) throw new ProError(409, 'Ya usaste todos los días de esa compra: no queda nada que devolver')
	const id = `rf-${crypto.randomUUID()}`
	await db
		.prepare("INSERT INTO pro_refunds (id, checkout, license, amount, payee, status, reason, requested_by, requested_at) VALUES (?, ?, ?, ?, ?, 'requested', ?, ?, ?)")
		.bind(id, checkout, license, q.usd, c.payee, reason.slice(0, 300) || null, by, now)
		.run()
	return id
}

const refundRow = (db: D1, id: string) => db.prepare('SELECT * FROM pro_refunds WHERE id = ?').bind(id).first<Refund>()

// Aprobar: se le quitan los días de esa compra. Queda pendiente que transfieras el dinero. Los días se quitan
// antes de darla por aprobada: si la compra ya no se puede devolver, la devolución sigue pedida
export async function approveRefund(db: D1, id: string, note: string | null, now: number) {
	const r = await refundRow(db, id)
	if (!r || r.status !== 'requested') throw new ProError(409, 'Esa devolución no está pendiente de aprobar')
	// Si ya se le quitaron los días (una aprobación anterior cuya respuesta se perdió), solo falta darla por aprobada
	if (!(await refundCheckout(db, r.checkout, note ?? r.reason, now)) && !(await daysOf(db, r.checkout, 'refund'))) throw new ProError(409, 'Esa compra ya se devolvió o no consta como pagada')
	await db.prepare("UPDATE pro_refunds SET status = 'approved', decided_at = ?, decision_note = ? WHERE id = ? AND status = 'requested'").bind(now, note, id).run()
	return (await refundRow(db, id))!
}

// Devolver directamente desde el panel (te lo pidió por Telegram): se apunta como pedida por ti y aprobada. Si
// antes la rechazaste y cambias de idea, la misma devolución vuelve a pedida y se aprueba
export async function adminRefund(db: D1, checkout: string, note: string | null, now: number) {
	const c = await refundable(db, checkout)
	if (!c || c.refunded_at) throw new ProError(409, 'Ese pago no existe o ya se devolvió')
	const old = await db.prepare('SELECT id, status FROM pro_refunds WHERE checkout = ?').bind(checkout).first<{ id: string; status: RefundStatus }>()
	if (old?.status === 'rejected')
		await db
			.prepare("UPDATE pro_refunds SET status = 'requested', requested_by = 'admin', reason = COALESCE(?, reason), requested_at = ?, decided_at = NULL, decision_note = NULL WHERE id = ? AND status = 'rejected'")
			.bind(note, now, old.id)
			.run()
	else if (old && old.status !== 'requested') throw new ProError(409, 'Esa compra ya tiene una devolución aprobada')
	const id = old?.id ?? (await requestRefund(db, c.license, checkout, note ?? '', 'admin', now))
	return approveRefund(db, id, note, now)
}

export async function transferRefund(db: D1, id: string, ref: string | null, now: number) {
	const moved = await db.prepare("UPDATE pro_refunds SET status = 'transferred', transferred_at = ?, transfer_ref = ? WHERE id = ? AND status = 'approved'").bind(now, ref, id).run()
	if (!moved.meta?.changes) throw new ProError(409, 'Esa devolución no está aprobada pendiente de transferir')
	return (await refundRow(db, id))!
}

// Pagar una devolución aprobada desde la cuenta de la app (QvaPay: POST /transaction/transfer con las credenciales de
// la app; hace falta «Transferencias internas» en sus permisos avanzados). El monto y a quién salen de la base, nunca
// del formulario: lo que pagó esa compra, a la cuenta (uuid) que la pagó. La clave de idempotencia es la devolución:
// aunque se pulse dos veces o se corte la conexión, QvaPay no paga dos veces. Si QvaPay no la hace, sigue aprobada
export async function payRefund(env: ProEnv, id: string, now: number, fetcher: typeof fetch = fetch) {
	const db = env.DB
	const r = await db
		.prepare('SELECT r.*, c.amount AS paid, c.payer_uuid FROM pro_refunds r JOIN pro_checkouts c ON c.id = r.checkout WHERE r.id = ?')
		.bind(id)
		.first<Refund & { paid: number; payer_uuid: string | null }>()
	if (!r || r.status !== 'approved') throw new ProError(409, 'Esa devolución no está aprobada pendiente de transferir')
	if (!r.payer_uuid) throw new ProError(409, 'No consta la cuenta de QvaPay que pagó esa compra: hazla a mano y márcala transferida')
	if (!(r.amount > 0 && r.amount <= r.paid)) throw new ProError(409, 'El monto de la devolución no cuadra con lo que se pagó')
	if (!env.QVAPAY_APP_ID || !env.QVAPAY_APP_SECRET) throw new ProError(503, 'Faltan las credenciales de la app de QvaPay')
	const res = await fetcher(`${QVAPAY}/transaction/transfer`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'app-id': env.QVAPAY_APP_ID, 'app-secret': env.QVAPAY_APP_SECRET },
		body: JSON.stringify({ amount: r.amount, to: r.payer_uuid, description: 'Devolución de Terminal P2P Pro', idempotency_key: `tp-refund-${r.id}` }),
	})
	const data = (await res.json().catch(() => ({}))) as { success?: boolean; transaction?: string; error?: string; message?: string; code?: string }
	if (res.status === 409) throw new ProError(409, 'QvaPay todavía está procesando esa transferencia: vuelve a pulsar en unos segundos (no se paga dos veces)')
	if (res.status === 403 && /allowed_transfer/i.test(data.error ?? ''))
		throw new ProError(403, 'La app de QvaPay no tiene activadas las transferencias (Permisos avanzados de API → Transferencias internas). Actívalas o hazla a mano')
	if (!res.ok || !data.transaction) throw new ProError(502, `QvaPay no hizo la transferencia: ${data.error ?? data.message ?? res.status}. Sigue aprobada: vuelve a intentarlo o hazla a mano`)
	return transferRefund(db, r.id, data.transaction, now)
}

// Rechazar: no se toca nada; el motivo lo ve el usuario en «Mi cuenta»
export async function rejectRefund(db: D1, id: string, note: string, now: number) {
	if (!note) throw new ProError(400, 'Escribe el motivo del rechazo: lo verá el usuario')
	const moved = await db.prepare("UPDATE pro_refunds SET status = 'rejected', decided_at = ?, decision_note = ? WHERE id = ? AND status = 'requested'").bind(now, note, id).run()
	if (!moved.meta?.changes) throw new ProError(409, 'Esa devolución no está pendiente de aprobar')
	return (await refundRow(db, id))!
}

// ── QvaPay: facturas y quién pagó ────────────────────────────────────

async function qvapay<T>(env: ProEnv, path: string, body: unknown, fetcher: typeof fetch): Promise<T> {
	if (!env.QVAPAY_APP_ID || !env.QVAPAY_APP_SECRET) throw new ProError(503, 'Los pagos aún no están activados')
	const res = await fetcher(`${QVAPAY}${path}`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'app-id': env.QVAPAY_APP_ID, 'app-secret': env.QVAPAY_APP_SECRET },
		body: JSON.stringify(body),
	})
	const data = (await res.json().catch(() => ({}))) as T & { error?: string; message?: string }
	if (!res.ok) throw new ProError(502, `QvaPay: ${data.error ?? data.message ?? res.status}`)
	return data
}

interface Transaction {
	uuid?: string
	status?: string
	amount?: number | string
	remote_id?: string
	created_at?: string
	PaidBy?: { uuid?: string; username?: string } | null
}

// Da por pagada una factura solo si QvaPay lo confirma al consultarla (nunca por lo que diga un aviso).
// Idempotente: si dos avisos llegan a la vez, solo uno la marca
export async function settle(env: ProEnv, c: Checkout, now: number, fetcher: typeof fetch = fetch): Promise<boolean> {
	if (c.status === 'paid') return true
	if (!c.invoice) return false
	const { transaction: t } = await qvapay<{ transaction?: Transaction }>(env, `/v2/transactions/${encodeURIComponent(c.invoice)}`, {}, fetcher)
	const payer = t?.PaidBy
	if (t?.status !== 'paid' || !payer?.uuid || !payer.username) return false
	if (t.remote_id && t.remote_id !== c.id) return false
	// La factura es nuestra (se consulta por su uuid y lleva nuestro remote_id) y su importe lo fija QvaPay. Se
	// admite una diferencia pequeña por si QvaPay informa el importe tras alguna comisión
	if (!(Number(t.amount) >= c.amount * (1 - AMOUNT_SLACK) - 1e-6)) return false
	const db = env.DB
	// Pro queda a nombre de la cuenta conectada al terminal aunque pague otra (p. ej. con otra sesión abierta
	// en qvapay.com). Desde el simulador no hay cuenta de QvaPay conectada: a nombre de quien paga
	const owner = c.requester ?? payer.username
	const key = accountOf(owner)
	const marked = await db
		.prepare("UPDATE pro_checkouts SET status = 'paid', license = ?, paid_at = ?, payer = ?, payer_uuid = ? WHERE id = ? AND status = 'pending'")
		.bind(key, now, payer.username, payer.uuid, c.id)
		.run()
	if (!marked.meta?.changes) return true
	let r: Awaited<ReturnType<typeof addDays>>
	try {
		r = await addDays(db, owner, { kind: 'purchase', days: PLANS[c.plan].days, plan: c.plan, checkout: c.id, note: `${PLANS[c.plan].name} · ${c.amount} USD · pagó @${payer.username}`, actor: 'system' }, now)
	} catch (err) {
		// Si la base guardó los días y solo se perdió su respuesta, la compra ya está hecha: volver a pendiente los
		// sumaría otra vez en el próximo repaso
		if (await daysOf(db, c.id, 'purchase')) {
			console.error(`pro: factura ${c.id}: los días ya constaban tras un fallo (${(err as Error).message})`)
			return true
		}
		// Sin sus días no puede quedar como pagada: vuelve a pendiente y el próximo repaso la activa
		await db.prepare("UPDATE pro_checkouts SET status = 'pending', license = NULL, paid_at = NULL WHERE id = ?").bind(c.id).run()
		throw err
	}
	const other = owner.toLowerCase() !== payer.username.toLowerCase() ? ` (pagó @${tgEsc(payer.username)})` : ''
	// Una cuenta suspendida no puede pedir facturas, pero sí pagar una que pidió antes: sigue suspendida y decides tú
	if (r.suspended)
		await notify(env, `⚠️ <b>Pagó una cuenta suspendida</b>\n@${tgEsc(owner)} compró <b>${PLANS[c.plan].name}</b> · ${c.amount} USD${other}\nSus días se sumaron, pero sigue suspendida: reactívala o devuélvele el dinero.`, `/admin/pro?u=${encodeURIComponent(owner)}`, fetcher)
	else {
		await notify(env, `💰 <b>Pago nuevo</b>\n@${tgEsc(owner)} compró <b>${PLANS[c.plan].name}</b> · ${c.amount} USD${other}\nTiene Pro hasta el ${hDay(r.after)}`, `/admin/pro?u=${encodeURIComponent(owner)}`, fetcher)
		await tellPaid(env, key, owner, PLANS[c.plan].days, c.amount, r.after, fetcher)
	}
	if (c.print) await attachPrint(db, key, c.print, now)
	return true
}

const AMOUNT_SLACK = 0.03

// Facturas pendientes de la última hora, confirmadas con QvaPay aunque nadie las esté mirando: si se
// pidió otra después, se cerró la pestaña o el aviso de QvaPay no llegó. Lo lanza el cron cada minuto
// (todas) y la consulta de estado de cada dispositivo (solo las suyas). Con margen tras la hora de la factura, por si
// se pagó en su último minuto y el aviso de QvaPay no llegó; y si hay más de un lote, cada minuto otras al azar, así
// ninguna se queda sin mirar aunque haya muchas abandonadas
const PENDING_BATCH = 25
const SETTLE_GRACE_MS = 15 * 60_000
export async function settlePending(env: ProEnv, now: number, who: { print?: string } = {}, fetcher: typeof fetch = fetch) {
	const [filter, arg] = who.print ? [' AND print = ?', who.print] : ['', null]
	const since = now - CHECKOUT_MS - SETTLE_GRACE_MS
	const { results } = await env.DB.prepare(`SELECT * FROM pro_checkouts WHERE status = 'pending' AND created_at > ? AND invoice IS NOT NULL${filter} ORDER BY RANDOM() LIMIT ?`)
		.bind(...(arg === null ? [since, PENDING_BATCH] : [since, arg, PENDING_BATCH]))
		.all<Checkout>()
	for (const c of results)
		try {
			await settle(env, c, now, fetcher)
		} catch (err) {
			console.error(`pro: factura ${c.id}: ${(err as Error).message}`)
		}
}

// ── Que no se pierda ningún pago ─────────────────────────────────────
// Los pagos no se borran nunca (las devoluciones solo se marcan) y la base (D1) se puede restaurar a cualquier
// minuto de los últimos 30 días. Además: QvaPay guarda cada factura con nuestro identificador (remote_id) y
// quién pagó, así que cada día se repasan con QvaPay, y cada día se deja una copia de las tablas de Pro en el KV

const RECONCILE_PAGES = 5 // las 500 facturas más recientes
const BACKUP_TTL_S = 120 * 86_400

export interface Reconciled {
	checked: number
	activated: string[]
	// Pagadas en QvaPay y que aquí no constan (p. ej. si se perdiera la base): para activarlas o devolverlas
	unknown: { invoice: string; remoteId: string; amount: number; payer: string | null; paidAt: string | null }[]
}

export async function reconcile(env: ProEnv, now: number, fetcher: typeof fetch = fetch, pages = RECONCILE_PAGES): Promise<Reconciled> {
	const db = env.DB
	const out: Reconciled = { checked: 0, activated: [], unknown: [] }
	for (let page = 1; page <= pages; page++) {
		const { transactions = [] } = await qvapay<{ transactions?: Transaction[] }>(env, '/v2/transactions', { page, take: 100 }, fetcher)
		for (const t of transactions) {
			if (t.status !== 'paid' || !t.uuid || !t.remote_id?.startsWith('pro-')) continue
			out.checked++
			const c = await db.prepare('SELECT * FROM pro_checkouts WHERE id = ?').bind(t.remote_id).first<Checkout>()
			if (c?.status === 'paid') continue
			if (c && (await settle(env, c, now, fetcher))) {
				out.activated.push(c.id)
				continue
			}
			// No consta aquí, o QvaPay la da por pagada y aun así no se pudo activar (importe, pagador…): a «Pendientes»,
			// para que nadie se quede pagado y sin sus días sin que lo sepas
			const d = await qvapay<{ transaction?: Transaction }>(env, `/v2/transactions/${encodeURIComponent(t.uuid)}`, {}, fetcher)
			out.unknown.push({ invoice: t.uuid, remoteId: t.remote_id, amount: Number(t.amount), payer: d.transaction?.PaidBy?.username ?? null, paidAt: t.created_at ?? null })
		}
		if (transactions.length < 100) break
	}
	return out
}

// Lo que el repaso no supo activar queda en «Pendientes» hasta que lo actives (y sale de ahí si ya consta)
export async function recordIssues(db: D1, r: Reconciled, now: number) {
	for (const u of r.unknown)
		await db
			.prepare('INSERT INTO pro_issues (invoice, remote_id, payer, amount, paid_at, found_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(invoice) DO NOTHING')
			.bind(u.invoice, u.remoteId, u.payer, u.amount, u.paidAt, now)
			.run()
	await db.prepare("UPDATE pro_issues SET resolved_at = ? WHERE resolved_at IS NULL AND remote_id IN (SELECT id FROM pro_checkouts WHERE status = 'paid')").bind(now).run()
}

// Lo que requiere que hagas algo: devoluciones por decidir y por transferir, y pagos cobrados sin activar
export async function pendingWork(db: D1) {
	const [refunds, issues] = await Promise.all([
		db
			.prepare("SELECT r.*, l.username FROM pro_refunds r JOIN pro_licenses l ON l.uuid = r.license WHERE r.status IN ('requested', 'approved') ORDER BY r.status DESC, r.requested_at")
			.all<Refund & { username: string }>()
			.then((x) => x.results),
		db
			.prepare('SELECT * FROM pro_issues WHERE resolved_at IS NULL ORDER BY found_at')
			.all<{ invoice: string; remote_id: string | null; payer: string | null; amount: number; paid_at: string | null; found_at: number }>()
			.then((x) => x.results),
	])
	return { refunds, issues, count: refunds.length + issues.length }
}

// El repaso de cada mañana, al grupo de avisos: lo de ayer y lo que queda pendiente
export async function dailyDigest(env: ProEnv, r: Reconciled | null, now: number, fetcher: typeof fetch = fetch) {
	const db = env.DB
	const day = await db
		.prepare(
			`SELECT (SELECT COUNT(*) FROM pro_checkouts WHERE status = 'paid' AND paid_at > ?1) AS pays,
				(SELECT COALESCE(SUM(amount), 0) FROM pro_checkouts WHERE status = 'paid' AND paid_at > ?1) AS usd,
				(SELECT COUNT(*) FROM pro_days WHERE kind = 'trial' AND created_at > ?1) AS trials`,
		)
		.bind(now - DAY_MS)
		.first<{ pays: number; usd: number; trials: number }>()
	const p = await pendingWork(db)
	const asked = p.refunds.filter((x) => x.status === 'requested')
	const owed = p.refunds.filter((x) => x.status === 'approved')
	const oldest = owed.length ? Math.floor((now - Math.min(...owed.map((x) => x.decided_at ?? x.requested_at))) / DAY_MS) : 0
	const n = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`
	const yesterday = `Últimas 24 h: ${n(day?.pays ?? 0, 'pago', 'pagos')} (${hUsd(day?.usd ?? 0)}) · ${n(day?.trials ?? 0, 'cuenta nueva', 'cuentas nuevas')} con días gratis`
	const lines = [
		asked.length ? `↩️ ${n(asked.length, 'devolución por decidir', 'devoluciones por decidir')}` : '',
		owed.length ? `⏳ ${n(owed.length, 'devolución aprobada', 'devoluciones aprobadas')} sin transferir${oldest ? ` (la más antigua, hace ${n(oldest, 'día', 'días')})` : ''}: debes ${hUsd(owed.reduce((t, x) => t + x.amount, 0))}` : '',
		p.issues.length ? `⚠️ ${n(p.issues.length, 'pago cobrado', 'pagos cobrados')} en QvaPay sin activar` : '',
		r?.activated.length ? `🔧 Activados al repasar con QvaPay: ${r.activated.length}` : '',
	].filter(Boolean)
	const text = lines.length ? `📋 <b>Repaso diario</b>\n${yesterday}\n\n${lines.join('\n')}` : `✅ <b>Repaso diario: todo en orden</b>\n${yesterday}\nNada pendiente.`
	return notify(env, text, '/admin/pro', fetcher)
}

// Una factura pagada que aquí no consta: se recrea con lo que dice QvaPay (los días según el importe) y se
// activa para quien pagó
export async function recover(env: ProEnv, invoice: string, now: number, fetcher: typeof fetch = fetch) {
	const { transaction: t } = await qvapay<{ transaction?: Transaction }>(env, `/v2/transactions/${encodeURIComponent(invoice)}`, {}, fetcher)
	if (t?.status !== 'paid' || !t.remote_id?.startsWith('pro-') || !t.PaidBy?.username) throw new ProError(400, 'QvaPay no la da por pagada')
	// Si la factura ya consta aquí, sus días son los de su plan; si no, los del importe
	const known = await env.DB.prepare('SELECT * FROM pro_checkouts WHERE id = ?').bind(t.remote_id).first<Checkout>()
	const plan = known?.plan ?? (Object.keys(PLANS) as Plan[]).find((p) => Math.abs(PLANS[p].usd - Number(t.amount)) <= PLANS[p].usd * AMOUNT_SLACK + 0.005)
	if (!plan) throw new ProError(400, `Importe sin días asociados: ${t.amount} USD. Dale los días a mano desde su ficha.`)
	if (!known)
		await env.DB.prepare("INSERT OR IGNORE INTO pro_checkouts (id, print, tg, plan, amount, invoice, status, created_at, day_usd) VALUES (?, '', NULL, ?, ?, ?, 'pending', ?, ?)")
			.bind(t.remote_id, plan, PLANS[plan].usd, invoice, Date.parse(t.created_at ?? '') || now, USED_DAY_USD)
			.run()
	const c = (await env.DB.prepare('SELECT * FROM pro_checkouts WHERE id = ?').bind(t.remote_id).first<Checkout>())!
	// Solo se da por resuelta si de verdad quedó activada
	if (!(await settle(env, c, now, fetcher))) throw new ProError(409, `QvaPay la da por pagada (${t.amount} USD) pero no se pudo activar sola. Dale los días a mano desde la ficha de @${t.PaidBy.username}.`)
	await env.DB.prepare('UPDATE pro_issues SET resolved_at = ? WHERE invoice = ? AND resolved_at IS NULL').bind(now, invoice).run()
	return { username: t.PaidBy.username, plan }
}

// Una factura que alguien dice haber pagado, por su uuid o el enlace que lo lleva: lo que dice QvaPay de ella y lo
// que consta aquí. No cambia nada (activarla es «recover»)
const INVOICE_ID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i
export async function invoiceFacts(env: ProEnv, input: string, fetcher: typeof fetch = fetch) {
	const invoice = input.match(INVOICE_ID)?.[0].toLowerCase()
	if (!invoice) throw new ProError(400, 'Pega el uuid de la factura o el enlace que lo lleva.')
	let t: Transaction | undefined
	try {
		t = (await qvapay<{ transaction?: Transaction }>(env, `/v2/transactions/${invoice}`, {}, fetcher)).transaction
	} catch (err) {
		if (err instanceof ProError && err.status === 502) throw new ProError(404, `QvaPay no la encuentra entre las facturas de la app (${err.message}).`)
		throw err
	}
	if (!t) throw new ProError(404, 'QvaPay no la encuentra entre las facturas de la app.')
	const ours = !!t.remote_id?.startsWith('pro-')
	const known = ours
		? await env.DB.prepare('SELECT c.*, l.username AS owner FROM pro_checkouts c LEFT JOIN pro_licenses l ON l.uuid = c.license WHERE c.id = ?')
				.bind(t.remote_id)
				.first<Checkout & { refunded_at: number | null; owner: string | null }>()
		: null
	return { invoice, paid: t.status === 'paid', status: t.status ?? '?', amount: Number(t.amount), payer: t.PaidBy?.username ?? null, createdAt: Date.parse(t.created_at ?? '') || null, ours, known }
}

// Todas las tablas de Pro (sin los códigos de respaldo por recoger, que se ven una sola vez)
// La copia de cada día: en el KV (en claro, 120 días) y, cifrada, a tu grupo de avisos por Telegram (backup.ts). Los
// domingos (hora de Cuba) la de Telegram es la completa, de toda la base
export async function backupPro(env: ProEnv, now: number, fetcher: typeof fetch = fetch) {
	if (!env.PRO?.put) return null
	const key = `backup/pro/${new Date(now).toISOString().slice(0, 10)}`
	await env.PRO.put(key, JSON.stringify(await snapshot(env.DB, now)), { expirationTtl: BACKUP_TTL_S })
	try {
		await sendBackup(env, now, fetcher, inCuba(now).toLocaleString('en-US', { timeZone: 'UTC', weekday: 'short' }) === 'Sun')
	} catch (err) {
		console.error(`pro, copia a Telegram: ${(err as Error).message}`)
	}
	return key
}

// ── Compartido con el simulador ──────────────────────────────────────

export async function activeLicense(db: D1, uuid: string | null | undefined, now: number): Promise<License | null> {
	if (!uuid) return null
	const l = await db.prepare('SELECT uuid, username, plan, expires_at, backup_hash, revoked FROM pro_licenses WHERE uuid = ?').bind(uuid).first<License>()
	return l && !l.revoked && l.expires_at > now ? l : null
}


// Los días gratis, cuando el usuario los activa (una vez por usuario de QvaPay y por dispositivo, con topes por
// IP y por día). 'used': ese usuario o ese dispositivo ya los usó; 'busy': se llegó a un tope
async function freeDays(db: D1, username: string, print: string, now: number, ip: string): Promise<'ok' | 'used' | 'busy'> {
	if (!(await trialAvailable(db, username, print))) return 'used'
	const day = new Date(now).toISOString().slice(0, 10)
	const n = async (sql: string, ...args: unknown[]) => (await db.prepare(sql).bind(...args).first<{ n: number | null }>())?.n ?? 0
	if ((await n('SELECT n FROM pro_trial_ips WHERE day = ? AND ip = ?', day, ip)) >= TRIAL_PER_IP_DAY) return 'busy'
	if ((await n('SELECT COALESCE(SUM(n), 0) AS n FROM pro_trial_ips WHERE day = ?', day)) >= TRIAL_PER_DAY) {
		console.error(`pro: tope diario de días gratis (${TRIAL_PER_DAY}) alcanzado`)
		return 'busy'
	}
	let license: string
	try {
		license = await startTrial(db, username, trialKeys(username, print), now)
	} catch (err) {
		if (err instanceof ProError) return 'used'
		throw err
	}
	await attachPrint(db, license, print, now)
	await db.prepare('INSERT INTO pro_trial_ips (day, ip, n) VALUES (?, ?, 1) ON CONFLICT(day, ip) DO UPDATE SET n = n + 1').bind(day, ip).run()
	return 'ok'
}

const trialKeys = (username: string, print: string) => [`qp:${username.toLowerCase()}`, `print:${print}`]
// ¿Puede activar sus días gratis? Ni ese usuario de QvaPay ni ese dispositivo los han usado
async function trialAvailable(db: D1, username: string, print: string) {
	const [a, b] = trialKeys(username, print)
	return !(await db.prepare('SELECT 1 FROM pro_trials WHERE key IN (?, ?)').bind(a, b).first())
}

// Huella de la IP para los topes: con la clave de Pro, así no se puede volver a la IP
export const ipPrint = async (req: Request, key: string) => hex(await hmac(key, `ip:${req.headers.get('cf-connecting-ip') ?? 'local'}`)).slice(0, 32)

// Limpieza diaria: las huellas de IP solo valen para el tope del día
export async function cleanupPro(db: D1, now: number) {
	await db.prepare('DELETE FROM pro_trial_ips WHERE day < ?').bind(new Date(now - 2 * DAY_MS).toISOString().slice(0, 10)).run()
	// Las incidencias descartadas, a los seis meses
	await db.prepare('DELETE FROM pro_incidents WHERE resolved_at < ?').bind(now - 180 * DAY_MS).run()
}

// Los días gratis. Las llaves dicen quién ya los usó (una sola vez cada una); si alguna ya se usó, no hay otro
export async function startTrial(db: D1, username: string, keys: string[], now: number) {
	for (const k of keys) if (await db.prepare('SELECT 1 FROM pro_trials WHERE key = ?').bind(k).first()) throw new ProError(409, `Ya usaste tus ${TRIAL_DAYS} días gratis`)
	// Las llaves se apuntan antes que los días: de dos peticiones a la vez, solo la que apunta la primera los recibe
	const license = accountOf(username)
	const first = await db.prepare('INSERT OR IGNORE INTO pro_trials (key, license, created_at) VALUES (?, ?, ?)').bind(keys[0], license, now).run()
	if (!first.meta?.changes) throw new ProError(409, `Ya usaste tus ${TRIAL_DAYS} días gratis`)
	for (const k of keys.slice(1)) await db.prepare('INSERT OR IGNORE INTO pro_trials (key, license, created_at) VALUES (?, ?, ?)').bind(k, license, now).run()
	await addDays(db, username, { kind: 'trial', days: TRIAL_DAYS, note: 'Días gratis activados', actor: 'system' }, now)
	return license
}

// Factura para comprar días de Pro desde el terminal: para la cuenta de QvaPay confirmada de ese dispositivo
export async function createCheckout(env: ProEnv, who: { print: string; username: string }, plan: Plan, origin: string, now: number, fetcher: typeof fetch = fetch) {
	if (!(plan in PLANS)) throw new ProError(400, 'Plan no válido')
	const db = env.DB
	const l = await db.prepare('SELECT plan, expires_at, revoked FROM pro_licenses WHERE uuid = ? AND merged_into IS NULL').bind(accountOf(who.username)).first<{ plan: string; expires_at: number; revoked: number }>()
	if (l?.revoked) throw new ProError(403, 'Tu cuenta Pro está suspendida. Escríbenos a @terminalp2p si crees que es un error.')
	// Con días comprados, se compran más en los últimos RENEW_DAYS; con días gratis o regalados (no pagó), cuando quiera
	if (l && l.plan !== 'trial' && l.plan !== 'gift' && l.expires_at - now > RENEW_DAYS * DAY_MS) throw new ProError(409, `Aún te quedan días de Pro. Podrás añadir más cuando te queden ${RENEW_DAYS} o menos.`)
	// Si ya tiene una factura pendiente del mismo plan, la misma: así no se pagan dos por error
	const open = await db
		.prepare("SELECT id, invoice FROM pro_checkouts WHERE status = 'pending' AND created_at > ? AND plan = ? AND print = ? AND invoice IS NOT NULL ORDER BY created_at DESC LIMIT 1")
		.bind(now - REUSE_MS, plan, who.print)
		.first<{ id: string; invoice: string }>()
	if (open) return { id: open.id, url: `${PAY_URL}${open.invoice}` }
	const mine = await db.prepare("SELECT COUNT(*) AS n FROM pro_checkouts WHERE status = 'pending' AND created_at > ? AND requester = ?").bind(now - CHECKOUT_MS, who.username).first<{ n: number }>()
	if ((mine?.n ?? 0) >= PENDING_PER_ACCOUNT) throw new ProError(429, 'Ya pediste varios pagos en la última hora. Paga uno de los que abriste o inténtalo más tarde.')
	const pending = await db.prepare("SELECT COUNT(*) AS n FROM pro_checkouts WHERE status = 'pending' AND created_at > ?").bind(now - CHECKOUT_MS).first<{ n: number }>()
	if ((pending?.n ?? 0) >= PENDING_MAX) {
		console.error(`pro: ${pending?.n} facturas pendientes en la última hora; no se crean más`)
		throw new ProError(503, 'Ahora mismo no se pueden pedir pagos. Inténtalo en unos minutos.')
	}
	const id = `pro-${crypto.randomUUID()}`
	const p = PLANS[plan]
	const inv = await qvapay<{ transaction_uuid?: string; url?: string }>(
		env,
		'/v2/create_invoice',
		{
			amount: p.usd,
			description: `Terminal P2P Pro · ${p.name}`,
			remote_id: id,
			webhook: `${origin}/api/pro/webhook`,
			expire_at: new Date(now + CHECKOUT_MS).toISOString(),
		},
		fetcher,
	)
	if (!inv.transaction_uuid || !inv.url) throw new ProError(502, 'QvaPay no devolvió la factura')
	await db.prepare("INSERT INTO pro_checkouts (id, print, tg, plan, amount, invoice, status, created_at, requester, day_usd) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)")
		.bind(id, who.print, null, plan, p.usd, inv.transaction_uuid, now, who.username, USED_DAY_USD)
		.run()
	return { id, url: inv.url }
}

// Cómo va una factura (y se comprueba con QvaPay si sigue pendiente). Solo responde al dispositivo que la
// pidió: el identificador de la factura lo ve también quien la paga
export async function checkoutStatus(env: ProEnv, id: string, owner: { print: string }, now: number, fetcher: typeof fetch = fetch) {
	const db = env.DB
	const c = await db.prepare('SELECT * FROM pro_checkouts WHERE id = ?').bind(id).first<Checkout>()
	if (!c || c.print !== owner.print) throw new ProError(404, 'Pago no encontrado')
	if (c.status === 'pending' && now - c.created_at < CHECKOUT_MS) await settlePending(env, now, owner, fetcher)
	// Si mientras tanto pagó otra factura suya (p. ej. una que pidió antes que esta), cuenta como esta
	const fresh = (await db
		.prepare("SELECT * FROM pro_checkouts WHERE print = ? AND (id = ? OR (status = 'paid' AND paid_at > ?)) ORDER BY status = 'paid' DESC, paid_at DESC LIMIT 1")
		.bind(owner.print, c.id, c.created_at)
		.first<Checkout>())!
	if (fresh.status !== 'paid') return { checkout: fresh, body: { status: now - c.created_at < CHECKOUT_MS ? 'pending' : 'expired' } }
	const l = await licenseOfPrint(db, fresh.print, now)
	return { checkout: fresh, body: { status: 'paid', ...(await statusOf(env, l, now)) } }
}

// ── «Mi cuenta» en el terminal ───────────────────────────────────────

// La cuenta de este dispositivo: la que confirmó QvaPay o, si no, la de su huella (aunque esté suspendida o vencida)
async function deviceAccount(req: Request, db: D1, print: string, key: string, now: number) {
	const who = await readWho(req.headers.get('cookie'), print, key, now)
	if (who) return accountOf(who.username)
	return (await db.prepare('SELECT license FROM pro_prints WHERE print = ?').bind(print).first<{ license: string }>())?.license ?? null
}

// Lo que el usuario ve de su cuenta: días, su historial (sin tus notas internas) y sus compras, con la devolución si
// le hiciste una
export async function accountView(db: D1, license: string | null, now: number) {
	const l = license ? await db.prepare('SELECT uuid, username, plan, expires_at, revoked FROM pro_licenses WHERE uuid = ? AND merged_into IS NULL').bind(license).first<License>() : null
	if (!l) return { account: null, moves: [], purchases: [] }
	const moves = (
		await db.prepare('SELECT kind, days, expires_after, checkout, note, created_at FROM pro_days WHERE license = ? ORDER BY created_at DESC, id DESC LIMIT 100').bind(l.uuid).all<{ kind: string; days: number; expires_after: number; checkout: string | null; note: string | null; created_at: number }>()
	).results.map((m) => ({
		at: m.created_at,
		kind: m.kind,
		days: m.days,
		until: m.expires_after,
		// Tus motivos de regalos, ajustes y devoluciones los ve; las compras ya dicen qué fueron
		note: ['gift', 'adjust', 'refund'].includes(m.kind) ? m.note : null,
	}))
	const paid = (
		await db
			.prepare(
				`SELECT c.id, c.plan, c.amount, COALESCE(c.paid_at, c.created_at) AS at, c.refunded_at, r.status AS rstatus, r.amount AS ramount, r.decision_note, r.requested_at AS rat, r.transferred_at AS tat, r.transfer_ref
				FROM pro_checkouts c LEFT JOIN pro_refunds r ON r.checkout = c.id WHERE c.license = ? AND c.status = 'paid' ORDER BY at DESC`,
			)
			.bind(l.uuid)
			.all<{ id: string; plan: Plan; amount: number; at: number; refunded_at: number | null; rstatus: RefundStatus | null; ramount: number | null; decision_note: string | null; rat: number | null; tat: number | null; transfer_ref: string | null }>()
	).results
	const purchases = paid.map((p) => ({
		id: p.id,
		at: p.at,
		days: PLANS[p.plan]?.days ?? 0,
		amount: p.amount,
		// Ya devuelta: cuándo y la referencia de la transferencia en QvaPay con que se le devolvió
		refund: p.rstatus
			? {
					status: p.rstatus,
					usd: p.ramount,
					note: p.rstatus === 'rejected' ? p.decision_note : null,
					at: p.rat,
					...(p.rstatus === 'transferred' ? { transferredAt: p.tat, ref: p.transfer_ref } : {}),
				}
			: null,
	}))
	return {
		account: { username: l.username, plan: l.plan, expiresAt: l.expires_at, suspended: !!l.revoked, active: !l.revoked && l.expires_at > now },
		moves,
		purchases,
		telegram: await linked(db, l.uuid),
	}
}

// ── Rutas ────────────────────────────────────────────────────────────

const readBody = async (req: Request) => (await req.json().catch(() => ({}))) as Record<string, unknown>
const printOf = (v: unknown) => {
	const p = String(v ?? '').toLowerCase()
	if (!PRINT.test(p)) throw new ProError(400, 'Dispositivo no válido')
	return p
}

// Lo que cada ruta deja en el traceo de la cuenta (userlog.ts): la ruta rellena lo que sabe y, al responder, se apunta
// una línea; también cuando el servidor dice que no. Sin `kind`, solo se apuntan los errores
interface Trace {
	kind?: LogKind
	account?: string | null
	print?: string | null
	detail?: string
	dk?: string
	skip?: boolean
}

export async function proApi(req: Request, url: URL, env: ProEnv, now = Date.now(), fetcher: typeof fetch = fetch): Promise<Response | null> {
	const path = url.pathname
	if (!path.startsWith('/pro/') && path !== '/api/pro/webhook') return null
	if (!env.PRO_KEY) return json(503, { error: 'Pro aún no está disponible' })
	const t: Trace = {}
	const res = await proRoute(req, url, env as ProEnv & { PRO_KEY: string }, now, fetcher, t)
	await traceRoute(req, env, `${req.method} ${path}`, res, t, now)
	return res
}

async function traceRoute(req: Request, env: ProEnv, route: string, res: Response, t: Trace, now: number) {
	const failed = res.status >= 400
	if (t.skip || (!t.kind && !failed)) return
	// De quién: lo que supo la ruta o, si no, la cuenta que confirmó QvaPay para esa huella o la dueña de su licencia
	let account = t.account ?? null
	if (!account && t.print) {
		account =
			(await readWho(req.headers.get('cookie'), t.print, env.PRO_KEY!, now))?.username ??
			(await env.DB.prepare('SELECT l.username FROM pro_prints p JOIN pro_licenses l ON l.uuid = p.license WHERE p.print = ?').bind(t.print).first<{ username: string }>())?.username ??
			null
	}
	if (!account && !t.print) return
	const error = failed ? String(((await res.clone().json().catch(() => ({}))) as { error?: unknown }).error ?? `error ${res.status}`) : ''
	const detail = failed ? `${t.kind ? (t.detail ? `${t.detail} · ` : '') : `${route} · `}${res.status}: ${error}` : t.detail
	await logUser(env.DB, { account, print: t.print, kind: t.kind ?? 'error', ok: !failed, detail, dk: failed ? null : t.dk }, now)
}

async function proRoute(req: Request, url: URL, env: ProEnv & { PRO_KEY: string }, now: number, fetcher: typeof fetch, t: Trace): Promise<Response> {
	const path = url.pathname
	const db = env.DB
	const route = `${req.method} ${path}`
	try {
		// Con Pro apagado en el panel: nadie es Pro ni puede comprar, y no empiezan los días gratis. La consulta de
		// estado sigue dejando la sesión del simulador, y los avisos de pago de QvaPay se siguen atendiendo
		if (!(await proEnabled(db, now)) && !['POST /pro/status', 'POST /pro/leave', 'POST /pro/rotate', 'POST /pro/webhook', 'POST /api/pro/webhook', 'POST /pro/telegram/webhook', 'POST /pro/telegram/unlink', 'POST /pro/diag', 'POST /pro/inbox', 'POST /pro/inbox/read'].includes(route)) return json(404, { error: 'Pro aún no está disponible' })
		// El buzón: los mensajes de tu cuenta (la que confirmó QvaPay) y marcar leídos. Va aunque Pro esté apagado
		if (route === 'POST /pro/inbox' || route === 'POST /pro/inbox/read') {
			const b = await readBody(req)
			const who = await readWho(req.headers.get('cookie'), printOf(b.print), env.PRO_KEY, now)
			t.skip = true
			if (!who) return json(403, { error: 'Conecta tu cuenta de QvaPay para ver tus mensajes', code: 'TP_WHO' })
			if (route === 'POST /pro/inbox/read') await markRead(db, who.username, Array.isArray(b.ids) ? b.ids.map(Number) : [], now)
			return json(200, await listInbox(db, who.username, now))
		}
		// ¿Este dispositivo es Pro?
		if (route === 'POST /pro/status') {
			const b = await readBody(req)
			const print = printOf(b.print)
			Object.assign(t, { kind: 'status', print, dk: hourKey('status', print, now) })
			if (!(await proEnabled(db, now))) {
				t.detail = 'Abrió el terminal (Pro apagado)'
				const off = json(200, { pro: false, enabled: false })
				off.headers.set('Set-Cookie', sessionCookie(url, await sessionToken(print, env.PRO_KEY, now)))
				return off
			}
			await settlePending(env, now, { print }, fetcher)
			let l = await licenseOfPrint(db, print, now)
			// La cuenta de QvaPay de este token, confirmada por QvaPay (no por lo que diga el navegador)
			const who = await readWho(req.headers.get('cookie'), print, env.PRO_KEY, now)
			const username = who?.username
			// Una cuenta bloqueada no es Pro ni entra en el simulador (se le cierra la sesión compartida)
			t.account = username ?? l?.username
			if ((await accessOf(db, { username: username ?? l?.username, print }, now))?.level === 'blocked') {
				Object.assign(t, { kind: 'denied', detail: 'Cuenta bloqueada: sin Pro ni simulador', dk: hourKey('denied', print, now) })
				const res = json(200, { pro: false, enabled: true, canTrial: false, blocked: true, plans: planList(), trialDays: TRIAL_DAYS })
				res.headers.set('Set-Cookie', sessionCookie(url, '', 0))
				return res
			}
			// Un dispositivo nuevo con tu cuenta entra solo en tu Pro (comprado o de los días gratis)
			if (!l && username) {
				l = await activeLicense(db, accountOf(username), now)
				if (l) {
					await attachPrint(db, l.uuid, print, now)
					await logUser(db, { account: username, print, kind: 'device', detail: 'Dispositivo nuevo: entró en su Pro' }, now)
				}
			}
			if (l) await db.prepare('UPDATE pro_prints SET seen_at = ? WHERE print = ?').bind(now, print).run()
			// Los días gratis no empiezan solos: si aún puede, el terminal le ofrece activarlos (POST /pro/trial)
			const canTrial = !l && !!username && (await trialAvailable(db, username, print))
			// «Ya los usaste» solo si se sabe de quién es el token (con dos cuentas en el mismo navegador, la otra pestaña
			// no lo sabe hasta que vuelve a pedir su perfil)
			const trialUsed = !l && !!username && !canTrial
			t.detail = l
				? `Abrió el terminal · Pro ${({ trial: 'gratis', gift: 'regalado' } as Record<string, string>)[l.plan] ?? 'comprado'} hasta el ${hDay(l.expires_at)}`
				: `Abrió el terminal · sin Pro${canTrial ? ' (puede probarlo gratis)' : trialUsed ? ' (ya usó los días gratis)' : username ? '' : ' · sin saber de quién es el token'}`
			// La sesión compartida con el simulador: con ella entra sin otro login y hereda tus días de Pro
			// Se le acabaron hace poco: el terminal se lo dice (con un botón para comprar días) aunque no tenga Telegram
			const ended =
				!l && username
					? await db
							.prepare('SELECT plan, expires_at FROM pro_licenses WHERE uuid = ? AND revoked = 0 AND merged_into IS NULL AND expires_at <= ? AND expires_at > ?')
							.bind(accountOf(username), now, now - ENDED_SHOWN_MS)
							.first<{ plan: string; expires_at: number }>()
					: null
			// Usa mucho el terminal y nunca probó Pro: el terminal le invita a probarlo (sus días y horas de las últimas 2 semanas)
			const usage = canTrial ? await heavyUse(db, username!, now) : null
			const res = json(200, { ...(await statusOf(env, l, now)), canTrial, trialUsed, ...(ended ? { ended: { plan: ended.plan, at: ended.expires_at } } : {}), ...(usage ? { usage } : {}) })
			res.headers.set('Set-Cookie', sessionCookie(url, await sessionToken(print, env.PRO_KEY, now)))
			return res
		}

		// Activar los días gratis (lo pulsa el usuario en el terminal). Con la cuenta que confirmó QvaPay
		if (route === 'POST /pro/trial') {
			const print = printOf((await readBody(req)).print)
			const who = await readWho(req.headers.get('cookie'), print, env.PRO_KEY, now)
			Object.assign(t, { kind: 'trial', print, account: who?.username, detail: 'Activar los días gratis' })
			if (!who) return json(403, { error: 'Conecta tu cuenta de QvaPay para activar tus días gratis', code: 'TP_WHO' })
			if ((await accessOf(db, { username: who.username, print }, now))?.level === 'blocked') return accessError('blocked')
			if (await activeLicense(db, accountOf(who.username), now)) return json(409, { error: 'Ya tienes Pro activo' })
			const r = await freeDays(db, who.username, print, now, await ipPrint(req, env.PRO_KEY))
			if (r === 'used') return json(409, { error: `Ya usaste tus ${TRIAL_DAYS} días gratis en esta cuenta o en este dispositivo` })
			if (r === 'busy') return json(429, { error: 'Ahora mismo no se pueden activar más días gratis desde tu conexión. Inténtalo mañana.' })
			const started = await licenseOfPrint(db, print, now)
			t.detail = `Activó sus ${TRIAL_DAYS} días gratis${started ? `, hasta el ${hDay(started.expires_at)}` : ''}`
			const res = json(200, { ...(await statusOf(env, started, now)), canTrial: false, started: true })
			res.headers.set('Set-Cookie', sessionCookie(url, await sessionToken(print, env.PRO_KEY, now)))
			return res
		}

		// Desconectaste tu cuenta en el terminal: el simulador también sale
		if (route === 'POST /pro/leave') {
			const res = json(200, { ok: true })
			res.headers.append('Set-Cookie', sessionCookie(url, '', 0))
			res.headers.append('Set-Cookie', clearWho(url))
			return res
		}

		// Comprar o renovar: factura de QvaPay para este dispositivo
		if (route === 'POST /pro/checkout') {
			const b = await readBody(req)
			const print = printOf(b.print)
			// Pro queda a nombre de la cuenta confirmada de este dispositivo. Sin ella no hay factura: así nadie puede
			// llenar la app de QvaPay de facturas con huellas inventadas y dejar a los demás sin poder comprar
			const who = await readWho(req.headers.get('cookie'), print, env.PRO_KEY, now)
			const plan = String(b.plan) as Plan
			Object.assign(t, { kind: 'checkout', print, account: who?.username, detail: `Comprar ${PLANS[plan]?.name ?? plan}` })
			if (!who) return json(403, { error: 'Conecta tu cuenta de QvaPay para comprar Pro', code: 'TP_WHO' })
			if ((await accessOf(db, { username: who.username, print }, now))?.level === 'blocked') return accessError('blocked')
			const c = await createCheckout(env, { print, username: who.username }, plan, url.origin, now, fetcher)
			t.detail = `Pidió la factura de ${PLANS[plan].name} (${PLANS[plan].usd} USD) · ${c.id}`
			return json(200, c)
		}

		// El navegador que pagó pregunta cómo va su factura
		if (route === 'POST /pro/checkout/status') {
			// La pregunta se repite cada pocos segundos: el pago queda en el traceo desde la factura
			t.skip = true
			const b = await readBody(req)
			return json(200, (await checkoutStatus(env, String(b.id ?? ''), { print: printOf(b.print) }, now, fetcher)).body)
		}

		// «Mi cuenta»: días, historial y compras de la cuenta de este dispositivo
		if (route === 'POST /pro/account') {
			const print = printOf((await readBody(req)).print)
			t.print = print
			return json(200, await accountView(db, await deviceAccount(req, db, print, env.PRO_KEY, now), now))
		}

		// Ya no se piden devoluciones desde el terminal (los terminales viejos aún tienen el botón)
		if (route === 'POST /pro/refund') return json(410, { error: NO_REFUNDS })


		// Avisos por Telegram: el enlace para conectar el chat desde «Mi cuenta», dejar de recibirlos, y lo que el
		// usuario le escribe al bot (lo manda Telegram, con su clave)
		if (route === 'POST /pro/telegram/link') {
			const print = printOf((await readBody(req)).print)
			const license = await deviceAccount(req, db, print, env.PRO_KEY, now)
			Object.assign(t, { kind: 'telegram', print, account: license, detail: 'Pidió el enlace para conectar los avisos de Telegram' })
			if (!license || !(await db.prepare('SELECT 1 FROM pro_licenses WHERE uuid = ? AND merged_into IS NULL').bind(license).first())) return json(403, { error: 'Conecta tu cuenta para recibir avisos' })
			const url = await linkUrl(env, license, now, fetcher)
			if (!url) return json(503, { error: 'Los avisos por Telegram no están disponibles ahora mismo' })
			return json(200, { url })
		}
		if (route === 'POST /pro/telegram/unlink') {
			const print = printOf((await readBody(req)).print)
			const license = await deviceAccount(req, db, print, env.PRO_KEY, now)
			Object.assign(t, { kind: 'telegram', print, account: license, detail: 'Desconectó los avisos de Telegram' })
			if (license) await unlink(db, license)
			return json(200, await accountView(db, license, now))
		}
		// Avisos de tasa por Telegram (ratealerts.ts): los suyos, poner uno y quitar uno. Y los de sus ofertas
		// (offeralerts.ts): activarlos o no. Solo con Pro activo
		if (route === 'POST /pro/alerts' || route === 'POST /pro/alerts/add' || route === 'POST /pro/alerts/delete' || route === 'POST /pro/alerts/offers') {
			const b = await readBody(req)
			const print = printOf(b.print)
			const license = await deviceAccount(req, db, print, env.PRO_KEY, now)
			Object.assign(t, { kind: 'telegram', print, account: license, detail: 'Avisos de tasa' })
			const l = license ? await db.prepare('SELECT expires_at, revoked FROM pro_licenses WHERE uuid = ? AND merged_into IS NULL').bind(license).first<{ expires_at: number; revoked: number }>() : null
			if (!license || !l || l.revoked || l.expires_at <= now) return json(403, { error: 'Los avisos de tasa son parte de Pro' })
			if (route === 'POST /pro/alerts/add') {
				const err = await addAlert(db, license, b, now)
				if (err) return json(400, { error: err })
				t.detail = `Puso un aviso de tasa: ${String(b.coin)} cuando ${b.dir === 'up' ? 'suba de' : 'baje de'} ${Number(b.price)}`
			} else if (route === 'POST /pro/alerts/delete') {
				await deleteAlert(db, license, Number(b.id))
				t.detail = 'Quitó un aviso de tasa'
			} else if (route === 'POST /pro/alerts/offers') {
				// El feed dice el uuid de QvaPay del dueño de cada oferta: sale de la cookie que firma el relé con el perfil de QvaPay
				const who = await readWho(req.headers.get('cookie'), print, env.PRO_KEY!, now)
				if (b.on && (!who || accountOf(who.username) !== license)) return json(409, { error: 'Vuelve a conectar tu cuenta de QvaPay en este navegador y prueba otra vez' })
				await setOfferAlerts(db, license, who?.uuid ?? '', !!b.on, now)
				t.detail = b.on ? 'Activó los avisos de sus ofertas' : 'Quitó los avisos de sus ofertas'
			} else t.skip = true
			return json(200, { alerts: await listAlerts(db, license), offers: await offerAlertsOn(db, license), telegram: await linked(db, license), rates: await latestRates(db, COINS.map((c) => c.tick), now), max: MAX_ALERTS })
		}
		if (route === 'POST /pro/telegram/webhook') {
			t.skip = true
			return botWebhook(req, env, now, fetcher)
		}

		// Radar: el terminal te avisa por Telegram de una oferta que encontró o tomó. Solo con Pro activo, una vez por
		// oferta (aunque el radar corra en varias pestañas) y con tope por hora
		if (route === 'POST /pro/radar/alert') {
			const b = await readBody(req)
			const l = await licenseOfPrint(db, printOf(b.print), now)
			Object.assign(t, { kind: 'radar', print: printOf(b.print), account: l?.username, detail: 'Aviso del radar' })
			if (!l) {
				// Sin Pro: si esta huella tuvo Pro y se le acabó hace más del margen, el radar sigue corriendo donde no debe
				const was = await db
					.prepare('SELECT l.uuid, l.username, l.expires_at FROM pro_prints p JOIN pro_licenses l ON l.uuid = p.license WHERE p.print = ?')
					.bind(printOf(b.print))
					.first<{ uuid: string; username: string; expires_at: number }>()
				if (!was || was.expires_at < now - GRACE_MS)
					await recordIncident(env, { kind: 'radar_no_pro', username: was?.username ?? null, license: was?.uuid ?? null, detail: was ? `Su Pro venció el ${hDay(was.expires_at)}` : 'Desde un dispositivo sin Pro' }, now, fetcher)
				return json(403, { error: 'El radar es parte de Pro' })
			}
			if ((await accessOf(db, { username: l.username }, now))?.level === 'blocked') return accessError('blocked')
			const hit = cleanRadarHit(b)
			if (!hit) return json(400, { error: 'Aviso no válido' })
			t.detail = `${hit.kind === 'found' ? 'Encontró' : 'Tomó'} ${hit.side === 'buy' ? 'comprar' : 'vender'} ${hit.usd} USD a ${hit.price} en ${hit.coin}${hit.peer ? ` · @${hit.peer}` : ''} · oferta ${hit.offer}`
			await db.prepare('DELETE FROM pro_radar_sent WHERE at < ?').bind(now - DAY_MS).run()
			const recent = await db.prepare('SELECT COUNT(*) AS n FROM pro_radar_sent WHERE license = ? AND at > ?').bind(l.uuid, now - HOUR_MS).first<{ n: number }>()
			if ((recent?.n ?? 0) >= RADAR_TG_PER_HOUR) return json(429, { error: 'Demasiados avisos del radar en la última hora' })
			const claim = await db.prepare('INSERT OR IGNORE INTO pro_radar_sent (license, offer, kind, at) VALUES (?, ?, ?, ?)').bind(l.uuid, hit.offer, hit.kind, now).run()
			if (!claim.meta?.changes) {
				t.detail += ' · ya avisada'
				return json(200, { ok: true, sent: false, repeated: true })
			}
			const sent = await tellUser(env, l.uuid, radarText(hit), radarButton(env, hit), fetcher)
			// Si no salió (sin chat conectado, Telegram caído), no cuenta como mandado
			if (!sent) await db.prepare('DELETE FROM pro_radar_sent WHERE license = ? AND offer = ? AND kind = ?').bind(l.uuid, hit.offer, hit.kind).run()
			t.detail += sent ? ' · enviado por Telegram' : ' · no salió por Telegram (sin chat conectado o Telegram falló)'
			return json(200, { ok: true, sent })
		}

		// Ya no se mandan diagnósticos desde el terminal: las dificultades se consultan en el grupo de Telegram (los terminales
		// viejos aún tienen el botón)
		if (route === 'POST /pro/diag') return json(410, { error: 'Consúltanos en el grupo de Telegram: t.me/terminalp2p' })

		// Aviso de QvaPay: solo dice qué factura mirar; se confirma consultándola
		if (req.method === 'POST' && (path === '/pro/webhook' || path === '/api/pro/webhook')) {
			t.skip = true
			const text = await req.text()
			let b: Record<string, unknown> = {}
			try {
				b = JSON.parse(text)
			} catch {
				b = Object.fromEntries(new URLSearchParams(text))
			}
			const inner = (b.transaction ?? b.data ?? {}) as Record<string, unknown>
			const ids = [b.remote_id, inner.remote_id].filter(Boolean).map(String)
			const invoices = [b.transaction_uuid, b.uuid, inner.uuid, inner.transaction_uuid].filter(Boolean).map(String)
			let c: Checkout | null = null
			for (const id of ids) c ??= await db.prepare('SELECT * FROM pro_checkouts WHERE id = ?').bind(id).first<Checkout>()
			for (const inv of invoices) c ??= await db.prepare('SELECT * FROM pro_checkouts WHERE invoice = ?').bind(inv).first<Checkout>()
			if (c) await settle(env, c, now, fetcher)
			return json(200, { ok: true })
		}

		// Cambiaste de token en este navegador: la huella vieja autoriza a la nueva
		// Cambió el token en este navegador: lo de la huella vieja pasa a la nueva, pero solo si las dos son de la misma
		// cuenta de QvaPay (la del token nuevo la confirma QvaPay, cookie del relé). Si no, es otra persona que entró en
		// el mismo navegador: no se le pasa nada (ni el Pro ni la cuenta del simulador)
		if (route === 'POST /pro/rotate') {
			const b = await readBody(req)
			const from = printOf(b.from)
			const to = printOf(b.to)
			const who = await readWho(req.headers.get('cookie'), to, env.PRO_KEY, now)
			const owned = await db
				.prepare('SELECT l.uuid, l.username FROM pro_prints p JOIN pro_licenses l ON l.uuid = p.license WHERE p.print = ?')
				.bind(from)
				.first<{ uuid: string; username: string }>()
			const same = !!who && !!owned && who.username.toLowerCase() === owned.username.toLowerCase()
			Object.assign(t, {
				kind: 'rotate',
				print: to,
				account: who?.username,
				detail: !owned ? 'Cambió de token (el anterior no tenía Pro)' : same ? `Cambió de token: su Pro pasa al nuevo` : `Entró otra cuenta en un navegador donde estaba @${owned.username}: no se le pasa nada`,
				// Dos cuentas en pestañas del mismo navegador se turnan en cada recarga: una vez por hora basta
				dk: same ? undefined : hourKey('rotate', `${from}>${to}`, now),
			})
			if (same) await db.prepare('UPDATE sim_ids SET key = ? WHERE key = ? AND NOT EXISTS (SELECT 1 FROM sim_ids WHERE key = ?)').bind(`print:${to}`, `print:${from}`, `print:${to}`).run()
			if (!(await proEnabled(db, now))) return json(200, { pro: false, enabled: false })
			const l = same ? await licenseOfPrint(db, from, now) : null
			if (!l) return json(200, await statusOf(env, await licenseOfPrint(db, to, now), now))
			const owner = await db.prepare('SELECT license FROM pro_prints WHERE print = ?').bind(to).first<{ license: string }>()
			if (owner && owner.license !== l.uuid) return json(409, { error: 'Ese dispositivo ya pertenece a otra licencia' })
			await db.prepare('DELETE FROM pro_prints WHERE print = ?').bind(from).run()
			await attachPrint(db, l.uuid, to, now)
			return json(200, await statusOf(env, l, now))
		}

		// El módulo Pro, firmado con el usuario de la licencia (si aparece una copia, se sabe de quién salió)
		if (route === 'GET /pro/module.js') {
			const raw = String(url.searchParams.get('l') ?? '')
			const lic = raw ? await verify<{ u: string; n: string; e: number; x: number }>(raw, env.PRO_KEY) : null
			if (!lic) {
				if (raw) {
					const c = claimOf(raw)
					const detail = c ? `La firma no es nuestra. Dice ser @${c.n} (sin verificar)${c.e ? `, con Pro hasta el ${hDay(c.e)}` : ''}` : 'La firma de la licencia no es nuestra'
					await recordIncident(env, { kind: 'module_forged', detail, tag: c?.n }, now, fetcher)
				}
				return json(403, { error: 'Licencia no válida' })
			}
			Object.assign(t, { kind: 'module', account: lic.n, detail: 'Descargó el módulo Pro', dk: hourKey('module', lic.u, now) })
			const l = await db.prepare('SELECT revoked, expires_at FROM pro_licenses WHERE uuid = ?').bind(lic.u).first<{ revoked: number; expires_at: number }>()
			// Una licencia vieja (de días ya vencidos, pasado el margen) solo es incidencia si hoy tampoco tiene Pro
			if (lic.e < now - GRACE_MS && !(l && !l.revoked && l.expires_at > now))
				await recordIncident(env, { kind: 'module_expired', username: lic.n, license: lic.u, detail: `Su Pro venció el ${hDay(l?.expires_at ?? lic.e)}` }, now, fetcher)
			// Sin las dos fechas no es una licencia (las otras firmas con la misma clave, como la de la cuenta, no las llevan)
			if (!(lic.x > now) || !(lic.e > now)) return json(403, { error: 'Licencia no válida' })
			if (!l || l.revoked) {
				if (l?.revoked) await recordIncident(env, { kind: 'module_revoked', username: lic.n, license: lic.u }, now, fetcher)
				return json(403, { error: 'Licencia revocada' })
			}
			if ((await accessOf(db, { username: lic.n }, now))?.level === 'blocked') return accessError('blocked')
			const code = await env.PRO?.get('module.js')
			if (!code) return json(404, { error: 'El módulo Pro aún no está publicado' })
			// TPProMark: la licencia con que se descargó; el terminal la manda al relé (X-TP-Pro) para reconocer las copias
			const mark = `/* Terminal P2P Pro · licencia de @${lic.n} (${lic.u}) · uso personal, no lo compartas */\nwindow.TPProUser=${JSON.stringify(lic.n)};window.TPProMark=${JSON.stringify(raw)};\n`
			return new Response(mark + code, { headers: { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'private, no-store' } })
		}

		return json(404, { error: 'Ruta desconocida' })
	} catch (err) {
		if (err instanceof ProError) return json(err.status, { error: err.message })
		console.error(`pro ${route}: ${(err as Error).message}`)
		return json(500, { error: 'Algo falló. Inténtalo de nuevo.' })
	}
}

// Lo que dice una licencia cuya firma no es nuestra (sin fiarse de nada): el usuario y hasta cuándo, para la incidencia.
// Nunca se guarda la licencia entera
function claimOf(raw: string): { n: string; e: number | null } | null {
	try {
		const p = JSON.parse(unb64url(raw.split('.')[0])) as { n?: unknown; e?: unknown }
		const n = typeof p.n === 'string' && /^[a-z0-9_.-]{1,40}$/i.test(p.n) ? p.n.toLowerCase() : null
		const e = typeof p.e === 'number' && Number.isFinite(p.e) && p.e > 0 && p.e < 8.64e15 ? p.e : null
		return n ? { n, e } : null
	} catch {
		return null
	}
}

// ── Panel (/admin/pro, con la clave del panel de métricas) ───────────

const escHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

// ── Panel: piezas compartidas ────────────────────────────────────────
// Horas de Cuba, como el resto del proyecto
const hUsd = (n: number) => `${(Math.round(n * 100) / 100).toLocaleString('en-US')} USD`
const hWhen = (ms: number) => inCuba(ms).toLocaleString('es', { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
const hDay = (ms: number) => inCuba(ms).toLocaleDateString('es', { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric' })
const hShort = (s: string) => `<span title="${escHtml(s)}">${escHtml(s.slice(0, 8))}…</span>`
const userLink = (u: string) => `<a href="/admin/pro?u=${encodeURIComponent(u)}"><b>@${escHtml(u)}</b></a>`
const copyBtn = (text: string, label = 'Copiar') =>
	`<button type="button" class="ghost" onclick="navigator.clipboard.writeText(${escHtml(JSON.stringify(text))});this.textContent='Copiado'">${label}</button>`
const KIND_NAME: Record<string, string> = { trial: 'Días gratis', purchase: 'Compra', gift: 'Regalo', refund: 'Devolución', adjust: 'Ajuste', import: 'Saldo inicial' }
const REFUND_STATUS: Record<RefundStatus, string> = { requested: 'Pedida', approved: 'Aprobada: falta transferir', transferred: 'Transferida', rejected: 'Rechazada' }

// Devolver una compra desde una tabla: el motivo se pide al pulsar, para que la fila no lleve un formulario entero
// Devolver una compra desde el panel: lo que se devolvería hoy (los días que no usó); sin días por usar, nada
const refundButton = (checkout: string, q: Quote, payer: string, back = '') =>
	q.usd > 0
		? `<form method="post" style="display:inline" onsubmit="var m=prompt('¿Devolver ${q.usd} USD a @${escHtml(payer)} (lo pagado menos ${q.used} días usados a precio de semana; le quedan ${q.unused} de ${q.days})? Se le quitan los días que no usó y luego le pagas desde la devolución.\\n\\nMotivo (puede verlo el usuario en «Mi cuenta»):','');if(m===null)return false;this.note.value=m">${back}<input type="hidden" name="checkout" value="${escHtml(checkout)}"><input type="hidden" name="note"><button class="ghost" name="action" value="refund">Devolver ${q.usd} USD</button></form>`
		: '<span class="note">ya usó todos sus días</span>'

// La referencia de una devolución: si es el uuid de la transferencia, enlaza a su detalle en QvaPay
const refLink = (ref: string) =>
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ref)
		? `<a href="https://www.qvapay.com/transaction/${ref}" target="_blank" rel="noopener">${ref}</a>`
		: escHtml(ref)

// Una devolución con lo que toca hacer en su paso. `u`: volver a la ficha de ese usuario tras la acción
function refundHtml(r: Refund & { username?: string }, u?: string) {
	const back = u ? `<input type="hidden" name="u" value="${escHtml(u)}">` : ''
	const head = `<div class="rf-head"><span class="pill ${r.status}">${REFUND_STATUS[r.status]}</span>${r.username ? ` ${userLink(r.username)}` : ''} · <b>${hUsd(r.amount)}</b> · pedida ${r.requested_by === 'user' ? 'por el usuario' : 'por ti'} el ${hWhen(r.requested_at)}</div>`
	const reason = r.reason ? `<p class="note">Motivo: «${escHtml(r.reason)}»</p>` : ''
	let act = ''
	if (r.status === 'requested')
		act = `<form method="post" class="row">${back}<input type="hidden" name="id" value="${escHtml(r.id)}"><input name="note" placeholder="nota (al rechazar, el motivo: lo ve el usuario)" style="flex:1 1 240px">
			<button name="action" value="refund-approve" onclick="return confirm('¿Aprobar? Se le quitan los días de esa compra. Luego le transfieres ${hUsd(r.amount)} a @${escHtml(r.payee)}.')">Aprobar</button>
			<button class="ghost" name="action" value="refund-reject">Rechazar</button></form>`
	else if (r.status === 'approved')
		act = `<form method="post" class="row" onsubmit="return confirm('¿Pagar ${hUsd(r.amount)} a @${escHtml(r.payee)} desde la cuenta de la app? Sale al momento y no se puede deshacer.')">${back}<input type="hidden" name="id" value="${escHtml(r.id)}"><button name="action" value="refund-pay">Pagar ${hUsd(r.amount)} a @${escHtml(r.payee)} con QvaPay</button><span class="note">a la cuenta que pagó la compra, desde la de la app</span></form>
			<details class="note" style="margin-top:8px"><summary>¿La transferiste tú a mano?</summary><p>${copyBtn(r.payee, 'Copiar usuario')} ${copyBtn(String(r.amount), 'Copiar monto')}</p>
			<form method="post" class="row">${back}<input type="hidden" name="id" value="${escHtml(r.id)}"><input name="ref" placeholder="referencia de la transferencia en QvaPay" style="flex:1 1 240px"><button class="ghost" name="action" value="refund-transfer">Marcar transferida</button></form></details>`
	else if (r.status === 'transferred') act = `<p class="note">Transferida el ${hWhen(r.transferred_at ?? r.decided_at ?? r.requested_at)}${r.transfer_ref ? ` · ref. ${refLink(r.transfer_ref)}` : ''}</p>`
	else act = `<p class="note">Rechazada el ${hWhen(r.decided_at ?? r.requested_at)}: «${escHtml(r.decision_note ?? '')}»</p>`
	return `<div class="rf">${head}${reason}${r.decision_note && r.status !== 'rejected' ? `<p class="note">Tu nota: ${escHtml(r.decision_note)}</p>` : ''}${act}</div>`
}

// La ficha de un cliente: todo lo suyo en una página y lo que se puede hacer con su cuenta
// ── Actividad de una cuenta (el traceo, userlog.ts) ───────────────────

const ACT_PAGE = 50
const hWhenS = (ms: number) => inCuba(ms).toLocaleString('es', { timeZone: 'UTC', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' })
const LOG_NAME: Record<string, string> = {
	login: '🔑 Conexión',
	status: '👁 Terminal',
	device: '📱 Dispositivo',
	trial: '🎁 Días gratis',
	leave: '🚪 Salió',
	checkout: '🧾 Factura',
	refund: '↩️ Devolución',
	telegram: '✈️ Telegram',
	radar: '📡 Radar',
	rotate: '🔁 Cambio de token',
	module: '★ Módulo Pro',
	denied: '⛔ Acceso',
	sim: '📈 Simulador',
	diag: '📋 Diagnóstico',
	error: '⚠️ Error',
}
const ACT_FILTERS: [TimelineFilter, string][] = [
	['actions', 'Lo que hizo'],
	['errors', 'Solo lo que salió mal'],
	['all', 'Todo (también abrir el terminal)'],
]

// Una fila de la línea de tiempo: qué fue y lo que se sabe de ello
function activityRow(r: TimelineRow) {
	const f = (r.detail ?? '').split('|')
	let what = ''
	let detail = ''
	if (r.src === 'log') {
		what = LOG_NAME[r.kind] ?? escHtml(r.kind)
		detail = escHtml(r.detail ?? '')
	} else if (r.src === 'days') {
		const days = Number(f[0])
		what = `📅 ${KIND_NAME[r.kind] ?? escHtml(r.kind)}`
		detail = `<b class="${days < 0 ? 'ask' : 'bid'}">${days > 0 ? '+' : ''}${days} días</b> · Pro hasta el ${hDay(Number(f[1]))}${f[3] ? ` · «${escHtml(f.slice(3).join('|'))}»` : ''}${f[2] === 'admin' ? ' · <span class="note">lo hiciste tú</span>' : ''}`
	} else if (r.src === 'paid') {
		what = '💵 Pagó'
		detail = `${escHtml(PLANS[r.kind as Plan]?.name ?? r.kind)} · <b>${hUsd(Number(f[0]))}</b>${f[1] ? ` · pagó @${escHtml(f[1])}` : ''}${f[2] ? ` · factura ${hShort(f[2])}` : ''}`
	} else if (r.src === 'refund') {
		what = `↩️ ${({ requested: 'Devolución pedida', approved: 'Devolución aprobada', rejected: 'Devolución rechazada', transferred: 'Devolución transferida' } as Record<string, string>)[r.kind] ?? escHtml(r.kind)}`
		const extra = f.slice(r.kind === 'requested' ? 2 : 1).join('|')
		detail = `<b>${hUsd(Number(f[0]))}</b>${r.kind === 'requested' ? ` · la pidió ${f[1] === 'admin' ? 'tú' : 'el usuario'}` : ''}${extra ? ` · ${r.kind === 'transferred' ? `ref. ${refLink(extra)}` : `«${escHtml(extra)}»`}` : ''}`
	} else if (r.src === 'incident') {
		what = '🚩 Incidencia'
		detail = `${escHtml(INCIDENT_NAME[r.kind as keyof typeof INCIDENT_NAME] ?? r.kind)}${f.slice(1).join('|') ? ` · ${escHtml(f.slice(1).join('|'))}` : ''}${Number(f[0]) > 1 ? ` · ${f[0]} veces` : ''}`
	} else if (r.src === 'audit') {
		what = '🛠 Tú, en el panel'
		detail = escHtml(r.detail ?? r.kind)
	} else if (r.src === 'tg') {
		const via = r.kind.match(/^(push|inbox)-/)?.[1]
		const k = via ? r.kind.slice(via.length + 1) : r.kind
		what = via === 'push' ? '📱 Aviso al móvil' : via === 'inbox' ? '🔔 Aviso en el buzón' : '✈️ Aviso por Telegram'
		detail = k.startsWith('exp3') ? 'Le quedan 3 días o menos' : k.startsWith('exp0') ? 'Se le acabaron los días' : escHtml(r.kind)
	} else if (r.src === 'diag') {
		what = '📋 Diagnóstico'
		detail = `<a href="/admin/pro?diag=${Number(f[0])}">Ver lo que envió</a> · ${Number(f[1])} líneas${f.slice(2).join('|') ? ` · «${escHtml(f.slice(2).join('|').slice(0, 200))}»` : ''}`
	}
	return `<tr${r.ok ? '' : ' class="bad"'}><td class="mono" style="white-space:nowrap">${hWhenS(r.at)}</td><td style="white-space:nowrap">${what}${r.ok ? '' : ' <span class="pill rejected">no</span>'}</td><td style="white-space:normal">${detail || '<span class="note">—</span>'}</td><td>${r.print ? hShort(r.print) : ''}</td></tr>`
}

async function activityPanel(env: ProEnv, username: string, url?: URL) {
	const page = pageOf(url, 'act')
	const raw = url?.searchParams.get('actf') as TimelineFilter | null
	const filter: TimelineFilter = raw && ACT_FILTERS.some(([k]) => k === raw) ? raw : 'actions'
	const { rows, total } = await timeline(env.DB, username, ACT_PAGE, (page - 1) * ACT_PAGE, filter)
	const tabs = ACT_FILTERS.map(([k, label]) => {
		const u = new URL(url ?? 'https://x/admin/pro')
		u.searchParams.set('u', username)
		u.searchParams.set('actf', k)
		u.searchParams.delete('act')
		return k === filter ? `<b>${label}</b>` : `<a href="${escHtml(`${u.pathname}${u.search}`)}#actividad">${label}</a>`
	}).join(' · ')
	const body = `<div class="panel-b"><p class="note">${tabs}</p></div><div class="wrap"><table class="left"><thead><tr><th>Cuándo</th><th>Qué</th><th>Detalle</th><th>Huella</th></tr></thead><tbody>${rows.map(activityRow).join('') || '<tr><td colspan="4" class="empty">Nada todavía.</td></tr>'}</tbody></table></div>${pager(url, 'act', page, ACT_PAGE, total) ? `<div class="panel-b">${pager(url, 'act', page, ACT_PAGE, total)}</div>` : ''}`
	return `<div id="actividad">${panel('Actividad', body, { sub: 'Todo lo que el servidor hizo con esta cuenta o le dio, y lo que hiciste tú. Lo que hace en el P2P no: eso solo está en su navegador (diagnósticos) y en QvaPay. Hora de Cuba; se guarda 180 días.', flush: true })}</div>`
}

// Un diagnóstico de los que se mandaban desde «Mi cuenta» (ya no: se consulta en el grupo de Telegram). Los que hay
// siguen en la ficha hasta que se borran (180 días)
async function diagPage(env: ProEnv, id: number) {
	const d = await diagOf(env.DB, id)
	if (!d) return proPage(env, 'pro-cuentas', 'Diagnóstico', `${pageHead('Diagnóstico', 'No existe (o ya se borró: se guardan 180 días).')}`)
	let entries: DiagEntry[] = []
	try {
		entries = JSON.parse(d.body)
	} catch {}
	const KIND: Record<string, string> = { api: 'Petición', error: 'Error', toast: 'Aviso', pro: 'Pro', account: 'Cuenta', page: 'Página' }
	const rows = entries
		.slice()
		.reverse()
		.map((e) => `<tr${e.kind === 'error' || e.data?.ok === false ? ' class="bad"' : ''}><td class="mono" style="white-space:nowrap">${hWhenS(e.t)}</td><td>${escHtml(KIND[e.kind] ?? e.kind)}</td><td style="white-space:normal">${escHtml(e.msg)}</td><td class="mono" style="white-space:normal">${e.data ? Object.entries(e.data).map(([k, v]) => `${escHtml(k)}=${escHtml(String(v))}`).join(' · ') : ''}</td></tr>`)
		.join('')
	const who = d.account ? userLink(d.account) : 'alguien sin identificar'
	return proPage(
		env,
		'pro-cuentas',
		'Diagnóstico',
		`${d.account ? `<a class="crumb" href="/admin/pro?u=${encodeURIComponent(d.account)}#actividad">← @${escHtml(d.account)}</a>` : ''}
		${pageHead(`Diagnóstico de ${who}`, `Enviado el ${hWhen(d.at)} desde el dispositivo ${d.print ? hShort(d.print) : '—'} · ${d.entries} líneas de su navegador, la más reciente arriba`)}
		${panel('Lo que cuenta', `<div class="panel-b"><p>«${escHtml(d.note ?? '')}»</p></div>`, { flush: true })}
		${panel('Lo que apuntó su navegador', `<div class="wrap"><table class="left"><thead><tr><th>Cuándo</th><th>Qué</th><th>Detalle</th><th>Datos</th></tr></thead><tbody>${rows || '<tr><td colspan="4" class="empty">Sin líneas.</td></tr>'}</tbody></table></div>`, { flush: true })}`,
	)
}

async function clientPage(env: ProEnv, username: string, notice: string, now: number, url?: URL) {
	const db = env.DB
	const id = accountOf(username)
	const l = await db
		.prepare('SELECT uuid, username, plan, expires_at, revoked, created_at FROM pro_licenses WHERE uuid = ? AND merged_into IS NULL')
		.bind(id)
		.first<License & { created_at: number }>()
	const name = l?.username ?? username
	const u = escHtml(name)
	const block = await blockOf(db, name)
	const blockPill = block && isActive(block, now) ? ` <span class="pill rejected">${ACCESS_NAME[block.level]} en el terminal</span>` : ''
	if (!l)
		return proPage(
			env,
			'pro-cuentas',
			`@${u}`,
			`<a class="crumb" href="/admin/pro?view=cuentas">← Cuentas</a>${pageHead(`@${u}${blockPill}`, 'No tiene cuenta Pro todavía. Puedes darle días: se le activan al conectar su cuenta en el terminal.', writeTo(u))}${notice}${panel('Dar o quitar días', daysForm(name))}${panel('Acceso al terminal', accessForm(name, block, now), { sub: ACCESS_HELP })}${await activityPanel(env, name, url)}`,
		)
	const all = <T>(sql: string) => db.prepare(sql).bind(id).all<T>().then((r) => r.results)
	const tg = await db.prepare('SELECT linked_at FROM pro_telegram WHERE license = ?').bind(id).first<{ linked_at: number }>()
	const [refunds, pays, moves, devices, notes, trials] = await Promise.all([
		all<Refund>('SELECT * FROM pro_refunds WHERE license = ? ORDER BY requested_at DESC'),
		all<Checkout & { refunded_at: number | null; refund_usd: number | null }>("SELECT c.* FROM pro_checkouts c WHERE c.license = ? AND c.status = 'paid' ORDER BY COALESCE(c.paid_at, c.created_at) DESC"),
		all<{ kind: string; days: number; expires_after: number; note: string | null; actor: string; created_at: number; checkout: string | null }>('SELECT * FROM pro_days WHERE license = ? ORDER BY created_at DESC, id DESC'),
		all<{ print: string; added_at: number; seen_at: number }>('SELECT print, added_at, seen_at FROM pro_prints WHERE license = ? ORDER BY seen_at DESC'),
		all<{ text: string; created_at: number }>('SELECT text, created_at FROM pro_notes WHERE license = ? ORDER BY created_at DESC'),
		all<{ key: string; created_at: number }>('SELECT key, created_at FROM pro_trials WHERE license = ? ORDER BY created_at'),
	])
	const left = Math.ceil((l.expires_at - now) / DAY_MS)
	const state = l.revoked ? '<span class="pill rejected">Suspendida</span>' : left > 0 ? `<span class="pill approved-ok">Pro · ${left} días</span>` : '<span class="pill">Vencida</span>'
	// Lo devuelto de cada compra (las devueltas antes del prorrateo, todo) y lo que se queda
	const back_ = (p: { amount: number; refunded_at: number | null; refund_usd: number | null }) => (p.refunded_at ? (p.refund_usd ?? p.amount) : 0)
	const refundedTotal = pays.reduce((t, p) => t + back_(p), 0)
	const paidTotal = pays.reduce((t, p) => t + p.amount, 0) - refundedTotal
	const refundOf = new Map(refunds.map((r) => [r.checkout, r]))
	const lefts = await leftOf(db, [id], now)
	const back = `<input type="hidden" name="u" value="${u}">`
	const payRows = pays
		.map((p) => {
			const r = refundOf.get(p.id)
			// Una rechazada se puede devolver igual si cambias de idea
			const act = r
				? `<span class="pill ${r.status}">${REFUND_STATUS[r.status]}</span>${r.status === 'rejected' && !p.refunded_at ? ` ${refundButton(p.id, quoteOf(p.amount, lefts.get(p.id), p.day_usd), p.payer ?? name, back)}` : ''}`
				: refundButton(p.id, quoteOf(p.amount, lefts.get(p.id), p.day_usd), p.payer ?? name, back)
			return `<tr><td>${hWhen(p.paid_at ?? p.created_at)}</td><td>${escHtml(PLANS[p.plan]?.name ?? p.plan)}</td><td class="num">${hUsd(p.amount)}</td><td>@${escHtml(p.payer ?? '?')}</td><td>${p.invoice ? hShort(p.invoice) : '—'}</td><td>${act}</td></tr>`
		})
		.join('')
	const moveRows = moves
		.map(
			(m) =>
				`<tr><td>${hWhen(m.created_at)}</td><td>${KIND_NAME[m.kind] ?? escHtml(m.kind)}</td><td class="num ${m.days < 0 ? 'ask' : 'bid'}">${m.days > 0 ? '+' : ''}${m.days}</td><td>${hDay(m.expires_after)}</td><td style="white-space:normal">${m.note ? escHtml(m.note) : '<span class="note">—</span>'}${m.actor === 'admin' ? ' <span class="note">· tú</span>' : ''}</td></tr>`,
		)
		.join('')
	const deviceRows = devices.map((d) => `<tr><td class="mono">${hShort(d.print)}</td><td>${hDay(d.added_at)}</td><td>${hWhen(d.seen_at)}</td></tr>`).join('')
	const suspend = `<form method="post" class="row">${back}<input type="hidden" name="uuid" value="${escHtml(l.uuid)}"><button class="${l.revoked ? '' : 'danger'}" name="action" value="${l.revoked ? 'restore' : 'revoke'}"${l.revoked ? '' : ` onclick="return confirm('¿Suspender a @${u}? Deja de ser Pro hasta que la reactives; sus días no se pierden.')"`}>${l.revoked ? 'Reactivar' : 'Suspender'}</button></form>`
	const table = (head: string, rows: string, cols: number, empty: string) =>
		`<div class="wrap"><table class="left"><thead><tr>${head}</tr></thead><tbody>${rows || `<tr><td colspan="${cols}" class="empty">${empty}</td></tr>`}</tbody></table></div>`
	return proPage(
		env,
		'pro-cuentas',
		`@${u}`,
		`<a class="crumb" href="/admin/pro?view=cuentas">← Cuentas</a>
		${pageHead(`@${u} ${state}${blockPill}`, `Cuenta <span class="mono">${escHtml(l.uuid)}</span> · ${tg ? `avisos por Telegram desde el ${hDay(tg.linked_at)}` : 'sin avisos por Telegram'} · días gratis usados: ${trials.map((t) => `${escHtml(t.key.startsWith('print:') ? 'un dispositivo' : t.key)} (${hDay(t.created_at)})`).join(', ') || 'ninguno'}`, `${writeTo(u)} ${suspend}`)}
		${notice}
		<div class="cards">
			<div class="card"><span>Pro hasta</span><b>${hDay(l.expires_at)}</b><small>${left > 0 ? `${left} días` : 'vencido'} · ${escHtml((l.plan in PLANS ? 'comprados' : (({ trial: 'gratis', gift: 'regalados' } as Record<string, string>)[l.plan] ?? l.plan)))}</small></div>
			<div class="card"><span>Pagado</span><b>${hUsd(paidTotal)}</b><small>${pays.length} pagos${refundedTotal ? ` · devuelto ${hUsd(refundedTotal)}` : ''}</small></div>
			<div class="card"><span>Cliente desde</span><b>${hDay(l.created_at)}</b><small>${devices.length} dispositivos${devices[0] ? ` · usado ${hDay(devices[0].seen_at)}` : ''}</small></div>
		</div>
		${refunds.length ? panel('Devoluciones', refunds.map((r) => refundHtml(r, name)).join(''), { flush: true }) : ''}
		<div class="grid3">
			${panel('Dar o quitar días', daysForm(name), { sub: 'Lo ve en su historial, con el motivo' })}
			${panel('Notas', `<div class="panel-b"><form method="post" class="row">${back}<input type="hidden" name="license" value="${escHtml(l.uuid)}"><input name="text" placeholder="escribió por Telegram, le prometí…" required style="flex:1 1 160px"><button name="action" value="note">Guardar</button></form></div>${notes.map((n) => `<p class="noteline"><span class="note">${hWhen(n.created_at)}</span>${escHtml(n.text)}</p>`).join('')}`, { sub: 'Solo las ves tú', flush: true })}
			${panel('Dispositivos', table('<th>Huella</th><th>Desde</th><th>Último uso</th>', deviceRows, 3, 'Ninguno.'), { flush: true })}
		</div>
		${panel('Pagos', table('<th>Pagado</th><th>Días</th><th class="num">Importe</th><th>Pagó</th><th>Factura</th><th>Devolución</th>', payRows, 6, 'Sin pagos.'), { flush: true })}
		${panel('Acceso al terminal', accessForm(name, block, now), { sub: `${ACCESS_HELP} «Suspender», arriba, solo le quita Pro.` })}
		${panel('Movimientos de días', table('<th>Cuándo</th><th>Qué</th><th class="num">Días</th><th>Pro hasta</th><th>Motivo</th>', moveRows, 5, 'Sin movimientos.'), { flush: true })}
		${await activityPanel(env, name, url)}`,
	)
}

// Restringir o bloquear el terminal a un usuario, o levantarlo. Sin usuario: el formulario lo pide
const ACCESS_HELP =
	'Restringida: no publica, toma ni edita ofertas desde el terminal, pero termina las que tiene abiertas. Bloqueada: el terminal, Pro y el simulador no le funcionan (las abiertas las termina en qvapay.com). Solo cierra Terminal P2P, no su cuenta de QvaPay. Tarda menos de un minuto en aplicarse.'
function accessForm(username: string | null, b: Block | null, now: number) {
	const who = username
		? `<input type="hidden" name="u" value="${escHtml(username)}"><input type="hidden" name="username" value="${escHtml(username)}">`
		: '<input name="username" placeholder="usuario de QvaPay" required style="flex:1 1 150px">'
	const state = b && isActive(b, now)
		? `<p><span class="pill rejected">${ACCESS_NAME[b.level]}</span> ${b.until ? `hasta el ${hWhen(b.until)}` : 'hasta que la levantes'} <span class="note">· desde el ${hWhen(b.created_at)}</span></p><p class="note">Motivo: «${escHtml(b.reason)}»</p>
			<form method="post" class="row" style="margin:10px 0">${who}<button class="ghost" name="action" value="access-lift" onclick="return confirm('¿Levantar el límite? Vuelve a usar el terminal con normalidad.')">Levantar</button></form>`
		: username
			? `<p class="note">Sin límites: usa el terminal con normalidad.${b ? ` Lo último: ${ACCESS_NAME[b.level].toLowerCase()}, ${b.lifted_at ? `levantado el ${hDay(b.lifted_at)}` : `venció el ${hDay(b.until ?? now)}`}.` : ''}</p>`
			: ''
	const confirmJs = `return confirm('¿Aplicar a @'+(this.username.value||'')+'? '+(this.level.value==='blocked'?'El terminal, Pro y el simulador dejan de funcionarle.':'No podrá publicar, tomar ni editar ofertas desde el terminal.'))`
	return `${state}<form method="post" class="row" onsubmit="${escHtml(confirmJs)}"><input type="hidden" name="action" value="access-set">${who}
		<select name="level"><option value="restricted">Restringir</option><option value="blocked">Bloquear</option></select>
		<select name="days"><option value="1">1 día</option><option value="7" selected>7 días</option><option value="30">30 días</option><option value="0">hasta que la levante</option></select>
		<input name="reason" placeholder="motivo (solo lo ves tú)" required style="flex:1 1 200px"><button class="danger">${isActive(b, now) ? 'Cambiar' : 'Aplicar'}</button></form>`
}

const daysForm = (username?: string) =>
	`<form method="post" class="row"><input type="hidden" name="action" value="days">${username ? `<input type="hidden" name="u" value="${escHtml(username)}"><input type="hidden" name="username" value="${escHtml(username)}">` : '<input name="username" placeholder="usuario de QvaPay" required style="flex:1 1 160px">'}<input name="days" type="number" value="7" style="width:80px" title="Negativo para quitar"> <span class="note">días (negativo para quitar)</span><input name="note" placeholder="motivo (lo ve el usuario en su historial)" required style="flex:1 1 220px"><label class="note"><input type="checkbox" name="tell" value="1" checked> avisarle por Telegram</label><button>Apuntar</button></form>`


// Pagos en CSV (uno por fila, con quién pagó y su identificador en QvaPay) o copia completa de Pro en JSON
// Mes en hora de Cuba (AAAA-MM)
const cubaMonth = (ms: number) => inCuba(ms).toLocaleString('en-CA', { timeZone: 'UTC', year: 'numeric', month: '2-digit' }).slice(0, 7)

// Las cuentas del negocio, mes a mes: lo cobrado, lo devuelto, el neto, clientes nuevos y los que repiten
export async function proReport(db: D1, now: number) {
	const pays = (
		await db
			.prepare("SELECT license, amount, COALESCE(paid_at, created_at) AS at, refunded_at FROM pro_checkouts WHERE status = 'paid' AND license IS NOT NULL ORDER BY at")
			.all<{ license: string; amount: number; at: number; refunded_at: number | null }>()
	).results
	const trials = (await db.prepare("SELECT license, created_at FROM pro_days WHERE kind = 'trial'").all<{ license: string; created_at: number }>()).results
	type Month = { month: string; pays: number; gross: number; refunded: number; refunds: number; newPaying: number; renewals: number; trials: number }
	const months = new Map<string, Month>()
	const m = (k: string) => {
		let x = months.get(k)
		if (!x) months.set(k, (x = { month: k, pays: 0, gross: 0, refunded: 0, refunds: 0, newPaying: 0, renewals: 0, trials: 0 }))
		return x
	}
	const seen = new Map<string, number>()
	for (const p of pays) {
		const x = m(cubaMonth(p.at))
		x.pays++
		x.gross += p.amount
		const n = (seen.get(p.license) ?? 0) + 1
		seen.set(p.license, n)
		if (n === 1) x.newPaying++
		else x.renewals++
		if (p.refunded_at) {
			const r = m(cubaMonth(p.refunded_at))
			r.refunds++
			r.refunded += p.amount
		}
	}
	for (const t of trials) m(cubaMonth(t.created_at)).trials++
	const list = [...months.values()].sort((a, b) => b.month.localeCompare(a.month)).map((x) => ({ ...x, gross: Math.round(x.gross * 100) / 100, refunded: Math.round(x.refunded * 100) / 100, net: Math.round((x.gross - x.refunded) * 100) / 100 }))
	const buyers = [...seen.values()]
	const trialAccounts = new Set(trials.map((t) => t.license))
	const converted = [...trialAccounts].filter((l) => seen.has(l)).length
	const active = await db
		.prepare(`SELECT COUNT(*) AS n FROM pro_licenses WHERE merged_into IS NULL AND revoked = 0 AND expires_at > ? AND plan IN (${PAID_PLANS_SQL})`)
		.bind(now)
		.first<{ n: number }>()
	return {
		months: list,
		buyers: buyers.length,
		repeat: buyers.filter((n) => n > 1).length,
		trialAccounts: trialAccounts.size,
		converted,
		paidCount: pays.length,
		refundedCount: pays.filter((p) => p.refunded_at).length,
		activePaid: active?.n ?? 0,
	}
}

// Renovaciones: de cada compra que ya llegó a su fin, si la cuenta volvió a comprar (antes de quedarse sin días o
// después) o se fue; por paquete, y quién sigue abriendo el terminal. Una compra «llega a su fin» cuando la cuenta
// compra otra vez o cuando se le acaban los días; mientras le queden días, todavía no cuenta. Las devueltas no cuentan
export async function renewalReport(db: D1, now: number) {
	const buys = (
		await db
			.prepare(
				`SELECT c.license, c.plan, COALESCE(c.paid_at, c.created_at) AS at, d.expires_before AS before, l.username, l.expires_at AS ends
				FROM pro_checkouts c JOIN pro_licenses l ON l.uuid = c.license LEFT JOIN pro_days d ON d.checkout = c.id AND d.kind = 'purchase'
				WHERE c.status = 'paid' AND c.refunded_at IS NULL ORDER BY at`,
			)
			.all<{ license: string; plan: string; at: number; before: number | null; username: string; ends: number }>()
	).results
	const seen = new Map(
		(await db.prepare('SELECT license, MAX(seen_at) AS seen FROM pro_prints GROUP BY license').all<{ license: string; seen: number }>()).results.map((x) => [x.license, x.seen]),
	)
	const days = (p: string) => PLANS[p as Plan]?.days ?? 0
	type Row = { plan: string; bought: number; due: number; renewed: number; longer: number }
	const byPlan = new Map<string, Row>(Object.keys(PLANS).map((p) => [p, { plan: p, bought: 0, due: 0, renewed: 0, longer: 0 }]))
	const accounts = new Map<string, { username: string; buys: typeof buys }>()
	for (const b of buys) {
		const a = accounts.get(b.license) ?? { username: b.username, buys: [] }
		a.buys.push(b)
		accounts.set(b.license, a)
	}
	let onTime = 0
	let late = 0
	let lapsed = 0
	const gaps: number[] = []
	for (const { buys: list } of accounts.values()) {
		list.forEach((b, i) => {
			const row = byPlan.get(b.plan) ?? byPlan.set(b.plan, { plan: b.plan, bought: 0, due: 0, renewed: 0, longer: 0 }).get(b.plan)!
			row.bought++
			const next = list[i + 1]
			if (next) {
				row.due++
				row.renewed++
				if (days(next.plan) > days(b.plan)) row.longer++
				// Los días que pasó sin Pro antes de volver a comprar (0 si compró antes de que se le acabaran)
				const gap = next.before && next.before < next.at ? (next.at - next.before) / DAY_MS : 0
				if (gap > 0) {
					late++
					gaps.push(gap)
				} else onTime++
			} else if (b.ends <= now) {
				row.due++
				lapsed++
			}
		})
	}
	const sorted = gaps.sort((a, b) => a - b)
	const active = (
		await db
			.prepare('SELECT uuid, plan FROM pro_licenses WHERE merged_into IS NULL AND revoked = 0 AND expires_at > ?')
			.bind(now)
			.all<{ uuid: string; plan: string }>()
	).results
	// Quién abrió el terminal en los últimos 7 días, de las cuentas con Pro ahora (comprado, gratis o regalado)
	const week = now - 7 * DAY_MS
	const usage = (kind: 'paid' | 'trial' | 'gift') => {
		const xs = active.filter((l) => (kind === 'paid' ? l.plan in PLANS : l.plan === kind))
		return { total: xs.length, recent: xs.filter((l) => (seen.get(l.uuid) ?? 0) >= week).length }
	}
	const clients = [...accounts.entries()]
		.map(([license, a]) => ({ username: a.username, buys: a.buys.length, plans: a.buys.map((b) => b.plan), first: a.buys[0].at, ends: a.buys[0].ends, seen: seen.get(license) ?? null }))
		.sort((a, b) => b.buys - a.buys || b.first - a.first)
	return {
		due: onTime + late + lapsed,
		renewed: onTime + late,
		onTime,
		late,
		lapsed,
		medianGap: sorted.length ? Math.round(sorted[Math.floor((sorted.length - 1) / 2)]) : null,
		byPlan: [...byPlan.values()],
		usage: { paid: usage('paid'), trial: usage('trial'), gift: usage('gift') },
		clients,
	}
}

async function reportsPage(env: ProEnv, notice: string, now: number) {
	const [r, rn] = await Promise.all([proReport(env.DB, now), renewalReport(env.DB, now)])
	const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)} %` : '—')
	const thisMonth = r.months.find((x) => x.month === cubaMonth(now))
	const lastMonth = r.months.find((x) => x.month === cubaMonth(Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), 0, 12)))
	const name = (ym: string) => new Date(`${ym}-15T12:00:00Z`).toLocaleDateString('es', { month: 'long', year: 'numeric' })
	const card = (label: string, value: string, small = '') => `<div class="card"><span>${label}</span><b>${value}</b>${small ? `<small>${small}</small>` : ''}</div>`
	const rows = r.months
		.slice(0, 24)
		.map(
			(x) =>
				`<tr><td style="text-transform:capitalize">${name(x.month)}</td><td>${x.pays}</td><td>${hUsd(x.gross)}</td><td>${x.refunded ? `<span class="ask">${hUsd(x.refunded)}</span> <span class="note">(${x.refunds})</span>` : '—'}</td><td><b>${hUsd(x.net)}</b></td><td>${x.newPaying}</td><td>${x.renewals}</td><td>${x.trials}</td></tr>`,
		)
		.join('')
	const planRows = rn.byPlan
		.map((x) => `<tr><td>${escHtml(PLANS[x.plan as Plan]?.name ?? x.plan)}</td><td>${x.bought}</td><td>${x.due}</td><td>${x.renewed}</td><td><b>${pct(x.renewed, x.due)}</b></td><td>${x.longer}</td></tr>`)
		.join('')
	const clientRows = rn.clients
		.slice(0, 50)
		.map(
			(c) =>
				`<tr><td>${userLink(c.username)}</td><td>${c.buys}</td><td>${c.plans.map((p) => PLANS[p as Plan]?.days ?? p).join(' → ')}</td><td>${hDay(c.first)}</td><td>${c.ends > now ? hDay(c.ends) : '<span class="note">vencido</span>'}</td><td>${c.seen ? hDay(c.seen) : '—'}</td></tr>`,
		)
		.join('')
	const use = (u: { total: number; recent: number }) => `${pct(u.recent, u.total)} <span class="note">(${u.recent} de ${u.total})</span>`
	const renewals = `<h2 class="sec-title">Renovaciones</h2>
		<div class="cards">
			${card('Renuevan al acabar', pct(rn.renewed, rn.due), `${rn.renewed} de ${rn.due} compras que ya acabaron`)}
			${card('Sin quedarse sin días', pct(rn.onTime, rn.renewed), `${rn.onTime} renovaron antes de que se les acabaran`)}
			${card('Vuelven después', String(rn.late), rn.medianGap === null ? 'tras quedarse sin Pro' : `tras ${rn.medianGap} días sin Pro (mediana)`)}
			${card('Se fueron', String(rn.lapsed), 'se les acabaron los días y no han vuelto')}
		</div>
		<div class="grid2">${panel(
			'Por paquete',
			`<div class="wrap"><table><thead><tr><th>Paquete</th><th>Compras</th><th>Ya acabaron</th><th>Renovaron</th><th>Renuevan</th><th>A uno más largo</th></tr></thead><tbody>${planRows}</tbody></table></div>`,
			{ flush: true, foot: 'Una compra acaba cuando la cuenta vuelve a comprar o se queda sin días; mientras le queden, no cuenta. «A uno más largo»: la siguiente compra fue de más días.' },
		)}${panel(
			'Abrieron el terminal en los últimos 7 días',
			`<div class="wrap"><table><thead><tr><th>Cuentas con Pro ahora</th><th>Lo usaron</th></tr></thead><tbody><tr><td>Días comprados</td><td>${use(rn.usage.paid)}</td></tr><tr><td>Días gratis</td><td>${use(rn.usage.trial)}</td></tr><tr><td>Días regalados</td><td>${use(rn.usage.gift)}</td></tr></tbody></table></div>`,
			{ flush: true, foot: 'Cuenta como uso la última vez que alguno de sus dispositivos abrió el terminal con Pro.' },
		)}</div>
		${panel(
			'Clientes',
			`<div class="wrap"><table class="left"><thead><tr><th>Usuario</th><th class="num">Compras</th><th>Paquetes (días)</th><th>Primera compra</th><th>Pro hasta</th><th>Último uso</th></tr></thead><tbody>${clientRows || '<tr><td colspan="6" class="empty">Todavía no hay compras.</td></tr>'}</tbody></table></div>`,
			{ flush: true, sub: rn.clients.length > 50 ? `Los 50 que más han comprado, de ${rn.clients.length}` : 'Los que más han comprado primero' },
		)}`
	return proPage(
		env,
		'pro-informes',
		'Informes de Pro',
		`${pageHead('Informes', 'Meses en hora de Cuba. Las devoluciones cuentan en el mes en que se aprobaron.', '<a class="btn" href="/admin/pro?export=informe">Descargar CSV</a>')}${notice}
		<div class="cards">
			${card('Neto este mes', hUsd(thisMonth?.net ?? 0), `${thisMonth?.pays ?? 0} pagos · devuelto ${hUsd(thisMonth?.refunded ?? 0)}`)}
			${card('Neto el mes pasado', hUsd(lastMonth?.net ?? 0), `${lastMonth?.pays ?? 0} pagos`)}
			${card('Con días pagados ahora', String(r.activePaid), 'cuentas con Pro comprado activo')}
			${card('Repiten compra', pct(r.repeat, r.buyers), `${r.repeat} de ${r.buyers} que compraron`)}
			${card('De gratis a pago', pct(r.converted, r.trialAccounts), `${r.converted} de ${r.trialAccounts} con días gratis`)}
			${card('Devoluciones', pct(r.refundedCount, r.paidCount), `${r.refundedCount} de ${r.paidCount} pagos`)}
		</div>
		${panel('Por meses', `<div class="wrap"><table><thead><tr><th>Mes</th><th>Pagos</th><th>Cobrado</th><th>Devuelto</th><th>Neto</th><th>Nuevos</th><th>Repiten</th><th>Días gratis</th></tr></thead><tbody>${rows || '<tr><td colspan="8" class="empty">Todavía no hay datos.</td></tr>'}</tbody></table></div>`, { flush: true, foot: '«Nuevos»: su primera compra. «Repiten»: compras de quien ya había comprado. «Días gratis»: cuentas que empezaron sus días gratis ese mes.' })}
		${renewals}`,
	)
}

const AUDIT_NAME: Record<string, string> = {
	days: 'Días', refund: 'Devolución (directa)', 'refund-approve': 'Devolución aprobada', 'refund-reject': 'Devolución rechazada', 'refund-transfer': 'Devolución transferida', 'refund-pay': 'Devolución pagada con QvaPay', note: 'Nota',
	'access-set': 'Restringir o bloquear', 'access-lift': 'Levantar límite', 'incident-resolve': 'Descartar incidencia', 'backup-send': 'Mandar copia a Telegram', 'backup-send-full': 'Mandar copia completa a Telegram', revoke: 'Suspender', restore: 'Reactivar', recover: 'Activar pago', check: 'Comprobar factura', reconcile: 'Repasar con QvaPay', 'pro-on': 'Encender Pro', 'pro-off': 'Apagar Pro',
	'orders-pause': 'Pausar ofertas', 'orders-resume': 'Reanudar ofertas', 'alert-test': 'Aviso de prueba', 'daily-on': 'Encender tasa del día', 'daily-off': 'Apagar tasa del día', 'daily-test': 'Probar tasa del día',
}

const AUDIT_PAGE = 100
async function auditPage(env: ProEnv, notice: string, now: number, url?: URL) {
	const page = pageOf(url, 'p')
	const total = (await env.DB.prepare('SELECT COUNT(*) AS n FROM pro_audit').first<{ n: number }>())?.n ?? 0
	const { results } = await env.DB.prepare(`SELECT * FROM pro_audit ORDER BY at DESC, id DESC LIMIT ${AUDIT_PAGE} OFFSET ${(page - 1) * AUDIT_PAGE}`).all<{ at: number; action: string; target: string | null; detail: string | null }>()
	const rows = results
		.map((a) => `<tr><td>${hWhen(a.at)}</td><td><b>${escHtml(AUDIT_NAME[a.action] ?? a.action)}</b></td><td>${a.target ? escHtml(a.target) : '—'}</td><td style="white-space:normal">${escHtml(a.detail ?? '')}</td></tr>`)
		.join('')
	return proPage(
		env,
		'pro-registro',
		'Registro de Pro',
		`${pageHead('Registro', 'Todo lo que se hace en este panel, lo más reciente primero. No se puede borrar ni editar.')}${notice}
		${panel('Acciones', `<div class="wrap"><table class="left"><thead><tr><th>Cuándo</th><th>Qué</th><th>Sobre</th><th>Detalle</th></tr></thead><tbody>${rows || '<tr><td colspan="4" class="empty">Todavía no hay acciones.</td></tr>'}</tbody></table></div>`, { flush: true, sub: count(total, 'acción', 'acciones'), foot: pager(url, 'p', page, AUDIT_PAGE, total) || undefined })}`,
	)
}

// Incidencias: quién usa (o intenta usar) Pro sin tenerlo. Desde cada una, restringir o bloquear su terminal (lo de
// «Acceso al terminal») o descartarla si no lo es
const INCIDENTS_PAGE = 50
async function incidentsPage(env: ProEnv, notice: string, now: number, url?: URL) {
	const page = pageOf(url, 'p')
	const total = (await env.DB.prepare('SELECT COUNT(*) AS n FROM pro_incidents WHERE resolved_at IS NULL').first<{ n: number }>())?.n ?? 0
	const list = await openIncidents(env.DB, INCIDENTS_PAGE, (page - 1) * INCIDENTS_PAGE)
	const blocked = await activeBlocks(env.DB, now)
	const limits = new Map(blocked.map((b) => [b.username.toLowerCase(), b.level]))
	const act = (i: Incident) => {
		const done = `<form method="post" style="display:inline"><input type="hidden" name="id" value="${i.id}"><button class="ghost" name="action" value="incident-resolve">Descartar</button></form>`
		if (!i.username) return done
		const limit = limits.get(i.username)
		if (limit) return `<span class="pill rejected">${ACCESS_NAME[limit]}</span> ${done}`
		const reason = escHtml(`Incidencia: ${INCIDENT_NAME[i.kind]}`)
		const set = (level: AccessLevel, days: number, label: string, cls: string) =>
			`<form method="post" style="display:inline" onsubmit="return confirm('¿${label} a @${escHtml(i.username!)}${days ? ` ${days} días` : ' hasta que lo levantes'}?')"><input type="hidden" name="action" value="access-set"><input type="hidden" name="username" value="${escHtml(i.username!)}"><input type="hidden" name="level" value="${level}"><input type="hidden" name="days" value="${days}"><input type="hidden" name="reason" value="${reason}"><button class="${cls}">${label}</button></form>`
		return `${set('restricted', 7, 'Restringir', 'ghost')} ${set('blocked', 0, 'Bloquear', 'danger')} ${done}`
	}
	const rows = list
		.map(
			(i) =>
				`<tr><td>${hWhen(i.last_at)}</td><td>${i.username ? userLink(i.username) : '<span class="note">sin identificar</span>'}</td><td style="white-space:normal"><b>${escHtml(INCIDENT_NAME[i.kind] ?? i.kind)}</b>${i.detail ? `<br><span class="note">${escHtml(i.detail)}</span>` : ''}${i.license && i.license !== `qp:${i.username}` ? `<br><span class="note">licencia ${userLink(i.license.slice(3))}</span>` : ''}</td><td class="num">${i.count}</td><td>${hWhen(i.first_at)}</td><td class="num">${act(i)}</td></tr>`,
		)
		.join('')
	return proPage(
		env,
		'pro-incidencias',
		'Incidencias',
		`${pageHead('Incidencias', 'Quién usa o intenta usar Pro sin tenerlo, según lo que ve el servidor. Nada se bloquea solo: míralo y decide. Quien tenía el terminal abierto cuando se le acabaron los días tiene un día de margen antes de aparecer aquí.')}${notice}
		${panel('Abiertas', `<div class="wrap"><table class="left"><thead><tr><th>Última vez</th><th>Usuario</th><th>Qué</th><th class="num">Veces</th><th>Primera vez</th><th></th></tr></thead><tbody>${rows || '<tr><td colspan="6" class="empty">Ninguna incidencia abierta.</td></tr>'}</tbody></table></div>`, { flush: true, foot: pager(url, 'p', page, INCIDENTS_PAGE, total) || undefined })}`,
	)
}

// Desde la ficha: escribirle al buzón del terminal
const writeTo = (u: string) => `<a class="btn ghost" href="/admin/pro?view=buzon&amp;to=${encodeURIComponent(u)}">Escribirle al buzón</a>`

// El buzón del panel: escribir un mensaje y lo que se ha mandado (a cuántos, cuántos lo leyeron)
async function inboxPage(env: ProEnv, notice: string, now: number, url?: URL) {
	const to = (url?.searchParams.get('to') ?? '').replace(/^@/, '')
	const sizes = await Promise.all((Object.keys(SEGMENTS) as (keyof typeof SEGMENTS)[]).map(async (k) => [k, (await segmentAccounts(env.DB, k, now)).length] as const))
	const opts = [
		`<option value="users"${to ? ' selected' : ''}>Usuarios concretos</option>`,
		...sizes.map(([k, n]) => `<option value="seg:${k}">${escHtml(SEGMENTS[k])} (${n.toLocaleString('en-US')})</option>`),
		'<option value="all">Todos</option>',
	].join('')
	const form = `<div class="panel-b"><form method="post" onsubmit="var a=this.audience.value;return confirm(a==='all'?'¿Mandar a TODOS los usuarios?':a.indexOf('seg:')===0?'¿Mandar a '+this.audience.selectedOptions[0].text+'?':'¿Mandar el mensaje?')" style="display:grid;gap:10px;max-width:720px">
		<input type="hidden" name="action" value="inbox-send">
		<label class="note">A quién<br><select name="audience" style="width:100%" onchange="this.form.to.parentNode.style.display=this.value==='users'?'':'none'">${opts}</select></label>
		<label class="note">Usuarios de QvaPay (separados por coma o espacio)<br><input name="to" value="${escHtml(to)}" placeholder="thebear, otrousuario" style="width:100%"></label>
		<label class="note">Título<br><input name="title" maxlength="${TITLE_MAX}" required style="width:100%" placeholder="Tienes 7 días de Pro gratis"></label>
		<label class="note">Texto<br><textarea name="body" maxlength="${BODY_MAX}" required style="min-height:110px;font:inherit" placeholder="Lo que quieras contarle"></textarea></label>
		<div class="row"><label class="note" style="flex:1 1 200px">Botón (opcional): «pro» abre Pro, o una dirección https<br><input name="cta" placeholder="pro" style="width:100%"></label><label class="note" style="flex:1 1 160px">Texto del botón<br><input name="cta_label" maxlength="30" placeholder="Probar Pro" style="width:100%"></label></div>
		<label class="note" style="display:flex;gap:8px;align-items:center"><input type="checkbox" name="push" value="1" style="width:auto;margin:0"> enviarlo también al móvil (a quien activó los avisos)</label>
		<div><button>Mandar</button> <span class="note">Le salta al momento a quien tiene el terminal abierto; el resto lo ve al entrar. Caduca a los 30 días.</span></div>
	</form></div>`
	const sent = await sentMessages(env.DB)
	const rows = sent
		.map((m) => {
			const live = m.expires_at > now
			const aud = m.audience === 'all' ? 'Todos' : m.segment && Object.hasOwn(SEGMENTS, m.segment) ? `${escHtml(SEGMENTS[m.segment as keyof typeof SEGMENTS])} · ${count(m.recipients, 'cuenta', 'cuentas')}` : count(m.recipients, 'cuenta', 'cuentas')
			const retire = live && m.kind === 'admin' ? `<form method="post" style="display:inline" onsubmit="return confirm('¿Retirar el mensaje de todos los buzones?')"><input type="hidden" name="action" value="inbox-retire"><input type="hidden" name="id" value="${m.id}"><button class="ghost">Retirar</button></form>` : ''
			return `<tr><td>${hWhen(m.created_at)}</td><td style="white-space:normal"><b>${escHtml(m.title)}</b><br><span class="note">${escHtml(m.body.slice(0, 140))}${m.body.length > 140 ? '…' : ''}</span>${m.cta ? `<br><span class="note">botón «${escHtml(m.cta_label ?? '')}» → ${escHtml(m.cta)}</span>` : ''}</td><td style="white-space:normal">${m.kind === 'system' ? '<span class="pill">sistema</span> ' : ''}${aud}</td><td class="num">${m.reads.toLocaleString('en-US')}</td><td class="num">${m.pushed ? m.pushed.toLocaleString('en-US') : '—'}</td><td>${live ? `hasta el ${hDay(m.expires_at)}` : '<span class="note">caducado</span>'}</td><td class="num">${retire}</td></tr>`
		})
		.join('')
	return proPage(
		env,
		'pro-buzon',
		'Buzón',
		`${pageHead('Buzón', 'Mensajes al buzón del terminal: a usuarios concretos, a un grupo o a todos. Salen en la campanita del terminal y, a quien lo tiene abierto, le saltan al momento.')}${notice}
		${panel('Escribir', form)}
		${panel('Mandados', `<div class="wrap"><table class="left"><thead><tr><th>Cuándo</th><th>Mensaje</th><th>A quién</th><th class="num">Leído</th><th class="num">Móviles</th><th>Se ve</th><th></th></tr></thead><tbody>${rows || '<tr><td colspan="7" class="empty">Aún no se ha mandado nada.</td></tr>'}</tbody></table></div>`, { flush: true })}`,
	)
}

async function proExport(env: ProEnv, kind: string, now: number) {
	const db = env.DB
	const day = new Date(now).toISOString().slice(0, 10)
	if (kind === 'cifrada') {
		if (!env.BACKUP_KEY) return new Response('Falta BACKUP_KEY: ponla con npx wrangler secret put BACKUP_KEY', { status: 503 })
		return new Response(await seal(JSON.stringify(await snapshot(db, now)), env.BACKUP_KEY), {
			headers: { 'Content-Type': 'application/json', 'Content-Disposition': `attachment; filename="terminalp2p-pro-${day}.copia"`, 'Cache-Control': 'no-store' },
		})
	}
	if (kind === 'copia')
		return new Response(JSON.stringify(await snapshot(db, now), null, 1), {
			headers: { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': `attachment; filename="terminalp2p-pro-${day}.json"`, 'Cache-Control': 'no-store' },
		})
	const cell = (v: unknown) => {
		const t = v == null ? '' : String(v)
		return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t
	}
	const csv = (rows: unknown[][], name: string) =>
		new Response(rows.map((r) => r.map(cell).join(',')).join('\n') + '\n', {
			headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="terminalp2p-${name}-${day}.csv"`, 'Cache-Control': 'no-store' },
		})
	if (kind === 'informe') {
		const r = await proReport(db, now)
		return csv([['mes', 'pagos', 'cobrado_usd', 'devoluciones', 'devuelto_usd', 'neto_usd', 'nuevos', 'repiten', 'dias_gratis'], ...r.months.map((x) => [x.month, x.pays, x.gross, x.refunds, x.refunded, x.net, x.newPaying, x.renewals, x.trials])], 'informe')
	}
	const { results } = await db
		.prepare(
			`SELECT c.id, c.invoice, c.plan, c.amount, c.created_at, c.paid_at, c.refunded_at, COALESCE(c.payer, l.username) AS payer, c.payer_uuid, l.username AS owner, c.requester,
				r.status AS refund_status, r.transferred_at, r.transfer_ref
			FROM pro_checkouts c LEFT JOIN pro_licenses l ON l.uuid = c.license LEFT JOIN pro_refunds r ON r.checkout = c.id WHERE c.status = 'paid' ORDER BY COALESCE(c.paid_at, c.created_at)`,
		)
		.all<{ id: string; invoice: string | null; plan: Plan; amount: number; created_at: number; paid_at: number | null; refunded_at: number | null; payer: string | null; payer_uuid: string | null; owner: string | null; requester: string | null; refund_status: string | null; transferred_at: number | null; transfer_ref: string | null }>()
	const iso = (ms: number | null) => (ms ? new Date(ms).toISOString() : '')
	return csv(
		[
			['pagado', 'pago', 'pago_uuid', 'para', 'dias', 'importe_usd', 'factura_qvapay', 'id', 'devuelto', 'devolucion', 'transferido', 'ref_transferencia'],
			...results.map((r) => [iso(r.paid_at ?? r.created_at), r.payer, r.payer_uuid, r.owner ?? r.requester, PLANS[r.plan]?.days ?? r.plan, r.amount, r.invoice, r.id, iso(r.refunded_at), r.refund_status, iso(r.transferred_at), r.transfer_ref]),
		],
		'pagos',
	)
}

// Tras cada acción el panel redirige a la página (POST → 303 → GET): así recargar no la repite ni el navegador
// pregunta si reenviar el formulario. Lo que dijo el panel viaja en una cookie firmada de un minuto y se enseña
// una sola vez
const FLASH = 'tpflash'
const hasFlash = (req: Request) => (req.headers.get('cookie') ?? '').split(';').some((p) => p.trim().startsWith(`${FLASH}=`))
const flashSet = (url: URL, value: string, maxAgeS: number) =>
	`${FLASH}=${value}; HttpOnly; SameSite=Strict; Path=/admin; Max-Age=${maxAgeS}${url.protocol === 'https:' ? '; Secure' : ''}`

async function flashCookie(url: URL, notice: string, key: string, now: number) {
	// Una cookie no llega a 4 KB: un aviso muy largo se queda en su texto
	const text = notice.replace(/<button[\s\S]*?<\/button>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
	const short = notice.length > 1500 ? `<p class="${notice.startsWith('<p class="ok">') ? 'ok' : 'note'}">${escHtml(text.slice(0, 600))}</p>` : notice
	return flashSet(url, await sign({ k: 'flash', n: encodeURIComponent(short), e: now + 60_000 }, key), 60)
}

async function readFlash(req: Request, key: string, now: number) {
	const raw = (req.headers.get('cookie') ?? '').split(';').map((p) => p.trim()).find((p) => p.startsWith(`${FLASH}=`))
	const f = raw ? await verify<{ k: string; n: string; e: number }>(raw.slice(FLASH.length + 1), key) : null
	if (!f || f.k !== 'flash' || f.e < now) return ''
	try {
		return decodeURIComponent(f.n)
	} catch {
		return ''
	}
}

export async function proAdmin(req: Request, env: ProEnv, now = Date.now(), fetcher: typeof fetch = fetch): Promise<Response> {
	const res = await panelResponse(req, env, now, fetcher)
	if (req.method === 'GET' && hasFlash(req)) res.headers.append('Set-Cookie', flashSet(new URL(req.url), '', 0))
	return res
}

async function panelResponse(req: Request, env: ProEnv, now: number, fetcher: typeof fetch): Promise<Response> {
	if (!(await authorized(req, env.METRICS_KEY))) return askKey()
	const db = env.DB
	// Descargas: los pagos en CSV (para devolver o cuadrar cuentas fuera de aquí) y la copia de todo Pro
	const exp = new URL(req.url).searchParams.get('export')
	if (req.method === 'GET' && exp) return proExport(env, exp, now)
	let notice = ''
	const url = new URL(req.url)
	// La ficha de un usuario (?u=), también al volver de una acción hecha desde ella
	let client = url.searchParams.get('u')
	if (req.method === 'POST') {
		// Solo desde el propio panel: el navegador recuerda la clave y otra web podría mandar formularios aquí
		const from = req.headers.get('origin') ?? (req.headers.get('sec-fetch-site') === 'same-origin' ? url.origin : null)
		if (from !== url.origin) return new Response('Origen no permitido', { status: 403 })
		const f = await req.formData()
		const action = String(f.get('action') ?? '')
		const uuid = String(f.get('uuid') ?? '')
		client = String(f.get('u') ?? '') || client
		try {
			// Dar o quitar días a un usuario, con el motivo (un regalo, una compensación por un fallo, una corrección).
			// Si aún no ha conectado su cuenta, se le activan al conectarla
			if (action === 'days') {
				const username = String(f.get('username') ?? '').replace(/^@/, '').trim()
				const days = Math.trunc(Number(f.get('days')))
				const note = String(f.get('note') ?? '').trim().slice(0, 200)
				if (!/^[A-Za-z0-9._-]{1,40}$/.test(username)) notice = '<p class="note">Usuario no válido.</p>'
				else if (!days || Math.abs(days) > 3650) notice = '<p class="note">Pon cuántos días das (por ejemplo 7) o quitas (−7).</p>'
				else if (!note) notice = '<p class="note">Escribe el motivo: queda en su historial.</p>'
				else {
					const r = await addDays(db, username, { kind: days > 0 ? 'gift' : 'adjust', days, note, actor: 'admin' }, now)
					// Si tiene los avisos conectados (y no está suspendida), se entera al momento
					const told = f.get('tell') === '1' && !r.suspended && (await tellDays(env, r.license, username, days, note, r.after, fetcher))
					const n = Math.abs(days) === 1 ? '1 día' : `${Math.abs(days)} días`
					notice = `<p class="ok">${days > 0 ? `${n} para` : `${n} menos a`} <b>@${escHtml(username)}</b>: tiene Pro hasta el ${hDay(r.after)}.${told ? ' Le avisamos por Telegram.' : ''}</p>`
				}
			}
			// Devolver un pago (te lo pidió por otro lado): queda aprobada, se restan solo los días de esa compra y falta
			// que transfieras el dinero a quien pagó
			const note = String(f.get('note') ?? '').trim().slice(0, 300) || null
			if (action === 'refund') {
				const r = await adminRefund(db, String(f.get('checkout') ?? ''), note, now)
				await tellRefund(env, r, fetcher)
				notice = `<p class="ok">Devolución aprobada: se le quitaron los días de esa compra. Ahora págale <b>${hUsd(r.amount)}</b> a <b>@${escHtml(r.payee)}</b> con el botón «Pagar con QvaPay» de la devolución (o transfiérelo tú a mano y márcala transferida).</p>`
			}
			if (action === 'refund-approve') {
				const r = await approveRefund(db, String(f.get('id') ?? ''), note, now)
				await tellRefund(env, r, fetcher)
				notice = `<p class="ok">Aprobada: se le quitaron los días de esa compra. Ahora págale <b>${hUsd(r.amount)}</b> a <b>@${escHtml(r.payee)}</b> con el botón «Pagar con QvaPay» de la devolución (o transfiérelo tú a mano y márcala transferida).</p>`
			}
			if (action === 'refund-reject') {
				await rejectRefund(db, String(f.get('id') ?? ''), note ?? '', now)
				await tellRefund(env, (await refundRow(db, String(f.get('id') ?? '')))!, fetcher)
				notice = '<p class="ok">Rechazada. El usuario ve el motivo en «Mi cuenta».</p>'
			}
			if (action === 'refund-pay') {
				const r = await payRefund(env, String(f.get('id') ?? ''), now, fetcher)
				await tellRefund(env, r, fetcher)
				notice = `<p class="ok">Devolución pagada: ${hUsd(r.amount)} a <b>@${escHtml(r.payee)}</b> desde la cuenta de la app (transferencia ${escHtml(r.transfer_ref ?? '')}).</p>`
			}
			if (action === 'refund-transfer') {
				const r = await transferRefund(db, String(f.get('id') ?? ''), String(f.get('ref') ?? '').trim().slice(0, 120) || null, now)
				await tellRefund(env, r, fetcher)
				notice = '<p class="ok">Devolución cerrada: transferida.</p>'
			}
			// Restringir o bloquear el terminal a un usuario (por seguridad), o levantarlo
			if (action === 'access-set') {
				const username = String(f.get('username') ?? '').replace(/^@/, '').trim()
				const level = String(f.get('level') ?? '') as AccessLevel
				const days = Math.trunc(Number(f.get('days')))
				const reason = String(f.get('reason') ?? '').trim().slice(0, 300)
				if (!/^[A-Za-z0-9._-]{1,40}$/.test(username)) notice = '<p class="note">Usuario no válido.</p>'
				else if (level !== 'restricted' && level !== 'blocked') notice = '<p class="note">Elige restringir o bloquear.</p>'
				else if (!(days >= 0 && days <= 3650)) notice = '<p class="note">Duración no válida.</p>'
				else if (!reason) notice = '<p class="note">Escribe el motivo (solo lo ves tú).</p>'
				else {
					const until = days ? now + days * DAY_MS : null
					await setBlock(db, username, level, reason, until, now)
					notice = `<p class="ok"><b>@${escHtml(username)}</b> queda ${level === 'blocked' ? '<b>bloqueada</b>: el terminal, Pro y el simulador dejan de funcionarle' : '<b>restringida</b>: no publica, toma ni edita ofertas desde el terminal'} ${until ? `hasta el ${hWhen(until)}` : 'hasta que la levantes'} (en menos de un minuto en todas partes). Motivo: ${escHtml(reason)}.</p>`
				}
			}
			if (action === 'backup-send' || action === 'backup-send-full') {
				const r = await sendBackup(env, now, fetcher, action === 'backup-send-full')
				notice = r
					? `<p class="ok">${r.full ? `Copia completa (${r.rows.toLocaleString('en-US')} filas)` : 'Copia de Pro'} del ${r.day}, cifrada, mandada a tu grupo de avisos (${Math.ceil(r.bytes / 1024).toLocaleString('en-US')} KB).</p>`
					: '<p class="note">No se mandó: falta BACKUP_KEY o el bot de avisos.</p>'
			}
			if (action === 'incident-resolve') {
				const r = await resolveIncident(db, Math.trunc(Number(f.get('id'))), now)
				notice = r.meta?.changes ? '<p class="ok">Incidencia descartada.</p>' : '<p class="note">Esa incidencia ya estaba cerrada.</p>'
			}
			if (action === 'access-lift') {
				const username = String(f.get('username') ?? '').replace(/^@/, '').trim()
				notice = (await liftBlock(db, username, now)) ? `<p class="ok">Límite levantado: <b>@${escHtml(username)}</b> vuelve a usar el terminal con normalidad (en menos de un minuto).</p>` : '<p class="note">Esa cuenta no tenía límites.</p>'
			}
			// Nota interna sobre un cliente
			if (action === 'note') {
				const text = String(f.get('text') ?? '').trim().slice(0, 1000)
				const license = String(f.get('license') ?? '')
				if (text && license.startsWith('qp:')) {
					await db.prepare('INSERT INTO pro_notes (license, text, created_at) VALUES (?, ?, ?)').bind(license, text, now).run()
					notice = '<p class="ok">Nota guardada.</p>'
				}
			}
			// Encender o apagar Pro en la web, el terminal y el simulador
			if (action === 'pro-on' || action === 'pro-off') {
				await setProEnabled(db, action === 'pro-on', now)
				notice = `<p class="ok">${action === 'pro-on' ? 'Pro encendido: ya se ve en la web, el terminal y el simulador' : 'Pro apagado: no se anuncia ni se ofrece en ningún sitio'} (en menos de un minuto en todas partes).</p>`
			}
			// Pausar o reanudar la publicación de ofertas desde el terminal
			// La «Tasa QvaPay del día» en el grupo de la comunidad: encenderla, apagarla y probarla en tu grupo de avisos
			if (action === 'daily-on' || action === 'daily-off') {
				await setDailyPost(db, action === 'daily-on', now)
				notice = `<p class="ok">${action === 'daily-on' ? `La tasa del día saldrá cada mañana a las ${POST_HOUR}:00 (hora de Cuba) en el grupo de la comunidad` : 'La tasa del día deja de publicarse'}.</p>`
			}
			if (action === 'daily-test') {
				const r = await testDailyPost(env, now, fetcher)
				notice = r.ok ? '<p class="ok">Prueba enviada a tu grupo de avisos: así saldría hoy.</p>' : `<p class="note">No salió: ${escHtml(r.description)}</p>`
			}
			// Staging: una venta inventada en el libro en vivo, para probar el radar sin esperar al mercado
			if (action === 'live-sim') {
				const r = await liveSimulate(env as unknown as LiveEnv)
				notice = r?.ok ? `<p class="ok">Oferta de prueba en el libro en vivo: vende 20 USD a ${r.price} en CUP Transferencia. No se puede tomar (no existe en QvaPay) y sale sola en la siguiente lectura completa del libro (unos minutos); mientras, la ve cualquiera que mire el libro de staging.</p>` : `<p class="note">No se pudo: ${escHtml(r?.error ?? 'el libro en vivo no está disponible')}</p>`
			}
			if (action === 'orders-pause' || action === 'orders-resume') {
				await setOrdersPaused(db, action === 'orders-pause', now)
				notice = `<p class="ok">${action === 'orders-pause' ? 'Publicar ofertas desde el terminal queda en pausa: quien lo intente ve el aviso de ajustes' : 'Publicar ofertas desde el terminal vuelve a funcionar'} (en menos de un minuto en todas partes).</p>`
			}
			// Repasar con QvaPay las facturas recientes: activa las pagadas que se quedaron sin activar y enseña las
			// pagadas que aquí no constan
			if (action === 'reconcile')
				try {
					const r = await reconcile(env, now, fetcher)
					await recordIssues(db, r, now)
					// Las pagadas que aquí no constan quedan en «Pendientes», con su botón para activarlas
					notice = `<p class="ok">Repasadas con QvaPay ${r.checked} facturas pagadas. ${r.activated.length ? `Activadas ahora: ${r.activated.length}.` : 'Todas estaban activadas.'}</p>${
						r.unknown.length ? `<p class="note">${r.unknown.length === 1 ? 'Una pagada en QvaPay no consta aquí' : `${r.unknown.length} pagadas en QvaPay no constan aquí`}: está${r.unknown.length === 1 ? '' : 'n'} en «Pendientes» para activarla${r.unknown.length === 1 ? '' : 's'}.</p>` : ''
					}`
				} catch (err) {
					notice = `<p class="note">No se pudo repasar con QvaPay: ${escHtml((err as Error).message)}</p>`
				}
			// Un pago que no se pudo activar solo y ya resolviste tú (días a mano o devolución): sale de «Pendientes»
			if (action === 'issue-done') {
				const r = await db.prepare('UPDATE pro_issues SET resolved_at = ? WHERE invoice = ? AND resolved_at IS NULL').bind(now, String(f.get('invoice') ?? '')).run()
				notice = r.meta?.changes ? '<p class="ok">Marcado como resuelto: sale de Pendientes.</p>' : '<p class="note">Ese pago ya no estaba pendiente.</p>'
			}
			if (action === 'recover')
				try {
					const r = await recover(env, String(f.get('invoice') ?? ''), now, fetcher)
					notice = `<p class="ok">Recuperada: ${escHtml(PLANS[r.plan].name)} para @${escHtml(r.username)}.</p>`
				} catch (err) {
					notice = `<p class="note">No se pudo recuperar: ${escHtml((err as Error).message)}</p>`
				}
			// Una factura por su uuid (la que trae quien dice que pagó): solo se mira, no se apunta en el registro
			if (action === 'invoice-check') notice = invoiceHtml(await invoiceFacts(env, String(f.get('invoice') ?? ''), fetcher))
			// Comprobar a mano una factura sin pagar (también las de hace más de una hora, que el cron ya no mira)
			if (action === 'check') {
				const c = await db.prepare('SELECT * FROM pro_checkouts WHERE id = ?').bind(String(f.get('checkout') ?? '')).first<Checkout>()
				if (!c) notice = '<p class="note">Esa factura no existe.</p>'
				else
					try {
						const paid = await settle(env, c, now, fetcher)
						notice = paid ? '<p class="ok">QvaPay la da por pagada: ya está activada.</p>' : '<p class="note">QvaPay dice que sigue sin pagar.</p>'
					} catch (err) {
						notice = `<p class="note">No se pudo consultar: ${escHtml((err as Error).message)}</p>`
					}
			}
			// Probar el grupo de avisos de Telegram
			// Que Telegram mande a este entorno lo que los usuarios le escriben al bot (conectar sus avisos, /stop)
			if (action === 'bot-connect') {
				// Las rutas de Pro (también el buzón del bot) están en el terminal (app.…), aunque el panel se abra desde la web
				const app = new URL(panelUrl(env))
				const r = await connectBot(env, app.origin, fetcher)
				notice = r.ok
					? `<p class="ok">El bot ya responde desde ${escHtml(app.host)}: los usuarios pueden conectar sus avisos en «Mi cuenta».</p>`
					: `<p class="note">Telegram no aceptó la conexión: ${escHtml(r.description)}</p>`
			}
			if (action === 'alert-test')
				notice = (await notify(env, '🔔 <b>Aviso de prueba</b>\nSi lo ves, los avisos de Pro llegan bien a este grupo.', '/admin/pro', fetcher))
					? '<p class="ok">Aviso de prueba enviado: míralo en el grupo.</p>'
					: '<p class="note">No salió. Revisa el token del bot (TELEGRAM_BOT_TOKEN), el chat (ALERT_CHAT) y que el bot esté en el grupo.</p>'
			// Suspender corta Pro sin tocar sus días ni sus dispositivos: al reactivarla, todo sigue como estaba
			if (action === 'revoke' || action === 'restore') {
				await db.prepare('UPDATE pro_licenses SET revoked = ?, updated_at = ? WHERE uuid = ? AND merged_into IS NULL').bind(action === 'revoke' ? 1 : 0, now, uuid).run()
				notice = `<p class="ok">${action === 'revoke' ? 'Cuenta suspendida: deja de ser Pro (sus días y dispositivos se guardan)' : 'Cuenta reactivada: vuelve a ser Pro con sus días'}.</p>`
			}
			// Buzón: un mensaje a una cuenta, a varias, a un grupo o a todos; salta al momento a quien tiene el terminal
			// abierto y, si se marca, también al móvil
			if (action === 'inbox-send') {
				const aud = String(f.get('audience') ?? '')
				const title = String(f.get('title') ?? '').trim()
				const body = String(f.get('body') ?? '').trim()
				if (!title || !body) throw new ProError(400, 'Falta el título o el texto del mensaje')
				const rawCta = String(f.get('cta') ?? '').trim()
				if (rawCta && !ctaOf(rawCta)) throw new ProError(400, 'El botón solo puede abrir Pro («pro») o una dirección https')
				let to: 'all' | string[]
				let segment: string | null = null
				if (aud === 'all') to = 'all'
				else if (aud === 'users') {
					to = String(f.get('to') ?? '').split(/[\s,;]+/).filter(Boolean)
					if (!to.length) throw new ProError(400, 'Escribe al menos un usuario')
				} else if (aud.startsWith('seg:') && isSegment(aud.slice(4))) {
					segment = aud.slice(4)
					to = await segmentAccounts(db, aud.slice(4) as keyof typeof SEGMENTS, now)
					if (!to.length) throw new ProError(400, `Nadie en «${SEGMENTS[segment as keyof typeof SEGMENTS]}» ahora mismo: no se mandó`)
				} else throw new ProError(400, 'Elige a quién va')
				const r = await sendInbox(env as InboxEnv, { to, title, body, cta: rawCta || null, ctaLabel: String(f.get('cta_label') ?? ''), segment, actor: 'panel', push: f.get('push') === '1' }, now, fetcher)
				if (!r.id) throw new ProError(400, 'Ningún usuario válido')
				notice = `<p class="ok">Mensaje mandado ${to === 'all' ? 'a todos' : `a ${count(r.recipients, 'cuenta', 'cuentas')}`}: le saltó al momento a ${count(r.live, 'terminal abierto', 'terminales abiertos')}${f.get('push') === '1' ? ` y llegó a ${count(r.pushed, 'móvil', 'móviles')}` : ''}.</p>`
			}
			if (action === 'inbox-retire') {
				await retireMessage(db, Number(f.get('id')), now)
				notice = '<p class="ok">Mensaje retirado: ya no se ve en ningún buzón.</p>'
			}
			// Todo lo que sale bien queda en el registro: qué, sobre quién y lo que dijo el panel
			if (action && notice.startsWith('<p class="ok">')) {
				const target = ['username', 'u', 'to', 'checkout', 'id', 'invoice', 'uuid', 'license'].map((k) => String(f.get(k) ?? '')).find(Boolean) ?? null
				const detail = notice.replace(/<button[\s\S]*?<\/button>/g, '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().slice(0, 300)
				await db.prepare('INSERT INTO pro_audit (at, action, target, detail) VALUES (?, ?, ?, ?)').bind(now, action, target, detail).run()
			}
		} catch (err) {
			if (!(err instanceof ProError)) throw err
			notice = `<p class="note">${escHtml(err.message)}</p>`
		}
		// De vuelta a la página desde la que se hizo (la ficha del cliente si venía de ella)
		const back = new URL(url)
		if (client) back.searchParams.set('u', client)
		const headers = new Headers({ Location: back.pathname + back.search, 'Cache-Control': 'no-store' })
		if (notice) headers.set('Set-Cookie', await flashCookie(url, notice, env.METRICS_KEY!, now))
		return new Response(null, { status: 303, headers })
	}
	notice = await readFlash(req, env.METRICS_KEY!, now)
	const flash = notice ? `<div class="flash">${notice}</div>` : ''
	const view = url.searchParams.get('view')
	const q = (url.searchParams.get('q') ?? '').replace(/^@/, '').trim().toLowerCase()
	if (client && /^[A-Za-z0-9._-]{1,40}$/.test(client.replace(/^@/, ''))) return clientPage(env, client.replace(/^@/, ''), flash, now, url)
	const diag = Number(url.searchParams.get('diag'))
	if (Number.isInteger(diag) && diag > 0) return diagPage(env, diag)
	if (view === 'informes') return reportsPage(env, flash, now)
	if (view === 'registro') return auditPage(env, flash, now, url)
	if (view === 'pagos') return paymentsPage(env, flash, now, url)
	if (view === 'cuentas') return accountsPage(env, flash, now, url)
	if (view === 'envivo') return livePage(env, flash, now, url)
	if (view === 'incidencias') return incidentsPage(env, flash, now, url)
	if (view === 'buzon') return inboxPage(env, flash, now, url)
	if (q) return searchPage(env, flash, now, q, url)
	return homePage(env, flash, now)
}

// Las páginas de Pro llevan en el menú cuántas cosas esperan algo de ti
async function proPage(env: ProEnv, active: AdminTab, title: string, body: string) {
	const incidents = await env.DB.prepare('SELECT COUNT(*) AS n FROM pro_incidents WHERE resolved_at IS NULL').first<{ n: number }>()
	return adminPage(active, title, body, 200, { pro: (await pendingWork(env.DB)).count, 'pro-incidencias': incidents?.n ?? 0 })
}

// «1 cuenta», «3 cuentas»
const count = (n: number, one: string, many: string) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`

// Las listas largas van por páginas (?<key>=N, desde 1): nunca se cortan sin avisar
const pageOf = (url: URL | undefined, key: string) => Math.max(1, Math.trunc(Number(url?.searchParams.get(key) ?? 1)) || 1)
function pager(url: URL | undefined, key: string, page: number, size: number, total: number) {
	if (!url || total <= size) return ''
	const link = (p: number) => {
		const u = new URL(url)
		u.searchParams.set(key, String(p))
		return escHtml(`${u.pathname}${u.search}`)
	}
	const pages = Math.ceil(total / size)
	return `<div class="row" style="justify-content:space-between"><span>${((page - 1) * size + 1).toLocaleString('en-US')}–${Math.min(total, page * size).toLocaleString('en-US')} de ${total.toLocaleString('en-US')}</span><span class="row">${page > 1 ? `<a class="btn" href="${link(page - 1)}">‹ Más recientes</a>` : ''}${page < pages ? `<a class="btn" href="${link(page + 1)}">Anteriores ›</a>` : ''}</span></div>`
}

const proSearch = (q = '') => `<form method="get" class="row search" action="/admin/pro">${searchIcon}<input name="q" value="${escHtml(q)}" placeholder="Buscar usuario o factura"></form>`
const proUsd = (n: number) => `${(Math.round(n * 100) / 100).toLocaleString('en-US')} USD`
const proShort = (s: string) => `<span class="mono" title="${escHtml(s)}">${escHtml(s.slice(0, 8))}…</span>`
const like = (q: string) => `%${q}%`

// Inicio: lo pendiente, las cifras del negocio, los interruptores y el repaso de pagos
async function homePage(env: ProEnv, flash: string, now: number) {
	const db = env.DB
	const monthStart = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), 1)
	const sum = await db
		.prepare(
			`SELECT
				(SELECT COUNT(*) FROM pro_licenses WHERE merged_into IS NULL AND revoked = 0 AND expires_at > ?1 AND plan IN (${PAID_PLANS_SQL})) AS paying,
				(SELECT COUNT(*) FROM pro_licenses WHERE merged_into IS NULL AND revoked = 0 AND expires_at > ?1 AND plan = 'trial') AS trials,
				(SELECT COUNT(*) FROM pro_licenses WHERE merged_into IS NULL AND revoked = 0 AND expires_at > ?1 AND plan = 'gift') AS gifts,
				(SELECT COUNT(*) FROM pro_trials) AS trialKeys,
				(SELECT COALESCE(SUM(amount - CASE WHEN refunded_at IS NULL THEN 0 ELSE COALESCE(refund_usd, amount) END), 0) FROM pro_checkouts WHERE status = 'paid' AND COALESCE(paid_at, created_at) >= ?2) AS month,
				(SELECT COUNT(*) FROM pro_checkouts WHERE status = 'paid' AND refunded_at IS NULL AND COALESCE(paid_at, created_at) >= ?2) AS monthCount,
				(SELECT COALESCE(SUM(amount - CASE WHEN refunded_at IS NULL THEN 0 ELSE COALESCE(refund_usd, amount) END), 0) FROM pro_checkouts WHERE status = 'paid') AS total,
				(SELECT COUNT(*) FROM pro_checkouts WHERE status = 'paid') AS paidCount,
				(SELECT COALESCE(SUM(COALESCE(refund_usd, amount)), 0) FROM pro_checkouts WHERE refunded_at IS NOT NULL) AS refunded,
				(SELECT COUNT(*) FROM pro_checkouts WHERE status = 'pending' AND created_at > ?3) AS unpaid`,
		)
		.bind(now, monthStart, now - DAY_MS)
		.first<Record<string, number>>()
	const card = (label: string, value: string, small = '') => `<div class="card"><span>${label}</span><b>${value}</b>${small ? `<small>${small}</small>` : ''}</div>`
	const cards = `<div class="cards">
		${card('Pro con días pagados', String(sum?.paying ?? 0), `${sum?.trials ?? 0} con días gratis · ${sum?.gifts ?? 0} regalados`)}
		${card('Ingresos este mes', proUsd(sum?.month ?? 0), `${sum?.monthCount ?? 0} pagos`)}
		${card('Ingresos totales', proUsd(sum?.total ?? 0), `${sum?.paidCount ?? 0} pagos · devuelto ${proUsd(sum?.refunded ?? 0)}`)}
		${card('Facturas sin pagar', String(sum?.unpaid ?? 0), 'pedidas en las últimas 24 h')}
		${card('Días gratis dados', String(sum?.trialKeys ?? 0), 'usuarios y dispositivos que ya los usaron')}
	</div>`
	// Pendientes: lo que requiere que hagas algo (si está vacío, no hay nada que hacer)
	const work = await pendingWork(db)
	const issueRows = work.issues
		.map(
			(i) =>
				`<div class="rf"><div class="rf-head"><span class="pill approved">Cobrado sin activar</span> @${escHtml(i.payer ?? '?')} · <b>${hUsd(i.amount)}</b>${i.paid_at ? ` <span class="note">· ${escHtml(i.paid_at.slice(0, 16).replace('T', ' '))}</span>` : ''}</div>
				<p class="note">QvaPay lo cobró y no se activó solo (factura ${hShort(i.invoice)}). Actívalo para quien pagó; si no se puede, dale los días a mano desde su ficha o devuélvele el dinero, y márcalo resuelto.</p>
				<form method="post" class="row"><input type="hidden" name="invoice" value="${escHtml(i.invoice)}"><button name="action" value="recover">Activar para @${escHtml(i.payer ?? '?')}</button><button class="ghost" name="action" value="issue-done" onclick="return confirm('¿Ya le diste los días a mano o le devolviste el dinero? Sale de Pendientes.')">Ya lo resolví a mano</button></form></div>`,
		)
		.join('')
	const pending = panel(
		`Pendientes ${work.count ? `<span class="count">${work.count}</span>` : ''}`,
		work.count
			? work.refunds.map((r) => refundHtml(r)).join('') + issueRows
			: '<div class="panel-b"><p class="allclear"><i>✓</i>Nada pendiente: ni devoluciones por transferir, ni pagos sin activar.</p></div>',
		{ sub: work.count ? 'Devoluciones por decidir o transferir y pagos que QvaPay cobró sin activarse' : '', flush: true },
	)
	const proOn = await proEnabled(db, now)
	const tgUsers = (await db.prepare('SELECT COUNT(*) AS n FROM pro_telegram').first<{ n: number }>())?.n ?? 0
	const paused = await ordersPaused(db, now)
	const daily = await dailyPostOn(db)
	const posted = (await lastPosts(db)).results.filter((p) => p.message_id)
	const dailyNote = !env.COMMUNITY_CHAT
		? 'En este entorno no hay grupo de la comunidad configurado (COMMUNITY_CHAT): solo se puede probar.'
		: `${daily ? `Sale cada mañana a las ${POST_HOUR}:00 (hora de Cuba) en el grupo de la comunidad.` : 'Apagada: no se publica nada.'} «Probar» manda el mensaje de hoy a tu grupo de avisos.${posted.length ? ` Última: ${posted[0].day}.` : ''}`
	const dailyForm = `<form method="post" class="flag${daily && env.COMMUNITY_CHAT ? ' on' : ''}"><b>Tasa QvaPay del día ${daily && env.COMMUNITY_CHAT ? 'encendida' : 'apagada'}</b><span class="note">${dailyNote}</span><button class="ghost" name="action" value="daily-test">Probar</button>${
		env.COMMUNITY_CHAT
			? daily
				? '<button class="ghost" name="action" value="daily-off">Apagar</button>'
				: `<button name="action" value="daily-on" onclick="return confirm('¿Publicar cada mañana la tasa del día en el grupo de la comunidad?')">Encender</button>`
			: ''
	}</form>`
	const toggles = `<div class="toggles">${
		proOn
			? `<form method="post" class="flag on"><b>Pro está encendido</b><span class="note">La web lo anuncia, el terminal lo ofrece (${TRIAL_DAYS} días gratis para quien los active) y el simulador abre todos los mercados a quien lo tiene.</span><button class="ghost" name="action" value="pro-off" onclick="return confirm('¿Apagar Pro? Deja de anunciarse y nadie podrá usarlo ni comprarlo hasta que lo enciendas.')">Apagar</button></form>`
			: `<form method="post" class="flag"><b>Pro está apagado</b><span class="note">No se anuncia ni se ofrece: la web no lo menciona, el terminal no tiene orden inteligente ni compras y el simulador solo tiene BTC y ETH.</span><button name="action" value="pro-on" onclick="return confirm('¿Encender Pro? Se anuncia en la web y el terminal ofrece ${TRIAL_DAYS} días gratis a quien los active.')">Encender</button></form>`
	}${
		paused
			? `<form method="post" class="flag paused"><b>Publicar ofertas está en pausa</b><span class="note">Quien intente publicar desde el terminal ve: «${ORDERS_PAUSED_MSG}» Tomar ofertas y cerrar órdenes siguen funcionando.</span><button name="action" value="orders-resume" onclick="return confirm('¿Reanudar la publicación de ofertas desde el terminal?')">Reanudar</button></form>`
			: `<form method="post" class="flag on"><b>Publicar ofertas funciona</b><span class="note">Para cortarlo al momento si aparece un fallo (tomar ofertas y cerrar órdenes siguen funcionando).</span><button class="ghost" name="action" value="orders-pause" onclick="return confirm('¿Pausar la publicación de ofertas desde el terminal? Quien lo intente verá un aviso de ajustes.')">Pausar</button></form>`
	}<form method="post" class="flag${alertsReady(env) ? ' on' : ''}"><b>${alertsReady(env) ? 'Avisos de Telegram activados' : 'Avisos de Telegram sin configurar'}</b><span class="note">${alertsReady(env) ? 'Pagos nuevos, devoluciones pedidas y el repaso de cada mañana llegan a tu grupo.' : 'Falta el token del bot (TELEGRAM_BOT_TOKEN) o el chat del grupo (ALERT_CHAT).'}</span>${alertsReady(env) ? '<button class="ghost" name="action" value="alert-test">Probar</button>' : ''}</form>${
		env.TELEGRAM_BOT_TOKEN
			? `<form method="post" class="flag${tgUsers ? ' on' : ''}"><b>Avisos a los usuarios: ${tgUsers === 1 ? '1 conectado' : `${tgUsers} conectados`}</b><span class="note">Quien lo conecta en «Mi cuenta» recibe la confirmación de cada pago, el aviso 3 días antes de que se le acaben los días y cada paso de su devolución. «Conectar el bot» hace que el bot responda desde este entorno (staging y producción comparten bot: vale el último donde se pulsó).</span><button class="ghost" name="action" value="bot-connect">Conectar el bot</button></form>`
			: ''
	}${dailyForm}${await liveForm(env)}</div>`
	const upkeep = `<div class="stack">
		<form method="post" class="row"><button class="ghost" name="action" value="reconcile" title="Activa las pagadas que se quedaron sin activar y apunta en Pendientes las que aquí no constan">Repasar pagos con QvaPay</button></form>
		<p class="note">Cada día a las 5:00 (hora de Cuba) se repasan los pagos con QvaPay y se guarda una copia de Pro (120 días)${env.BACKUP_KEY ? ', que además te llega cifrada a tu grupo de avisos; los domingos, la copia completa de toda la base' : ''}. La base se puede restaurar a cualquier minuto de los últimos 30 días.</p>
		<p class="note"><a href="/admin/pro?export=pagos">Descargar pagos (CSV)</a> · <a href="/admin/pro?export=copia">Copia completa (JSON)</a>${env.BACKUP_KEY ? ' · <a href="/admin/pro?export=cifrada">Copia cifrada</a>' : ''}</p>
		${env.BACKUP_KEY ? '<form method="post" class="row"><button class="ghost" name="action" value="backup-send">Mandar la copia de Pro a Telegram ahora</button><button class="ghost" name="action" value="backup-send-full">Mandar la copia completa</button></form>' : '<p class="note">Para tener la copia también fuera de Cloudflare, pon una clave con <code>npx wrangler secret put BACKUP_KEY</code> y guárdala en tu gestor de contraseñas.</p>'}</div>`
	return proPage(
		env,
		'pro',
		'Pro',
		`${pageHead('Inicio', 'De cada usuario solo se guarda su usuario de QvaPay, hasta cuándo tiene Pro y la huella de sus dispositivos, nunca el token. Quién pagó lo confirma QvaPay.', proSearch())}
		${flash}${cards}${pending}
		<div class="grid2">${panel('Estado', toggles, { flush: true })}${panel('Pagos y copias', upkeep, { foot: `Política: se compran días, nada se cobra solo y no se devuelven (para probar están los días gratis), salvo error en el pago: lo devuelves tú desde su ficha o Pagos, lo pagado menos los días usados a precio de la semana. Si Pro falla por nuestra culpa, en vez de devolver se dan los días perdidos.` })}</div>`,
	)
}

// Cuánto tardan en llegar los eventos del feed (la mediana y el 90 %)
const secs = (ms: number) => `${(ms / 1000).toLocaleString('en-US', { maximumFractionDigits: 1 })} s`
function lagNote(lag: LiveState['lag']) {
	if (!lag?.sent && !lag?.upd) return ''
	const part = (l: LagStats | null, what: string) => (l ? `${what}: ${secs(l.p50)} la mitad, ${secs(l.p90)} el 90 % (el peor ${secs(l.max)})` : '')
	return `Retraso de los últimos ${(lag.sent ?? lag.upd)!.n} eventos — ${[part(lag.sent, 'desde que QvaPay los manda'), part(lag.upd, 'desde que cambió la oferta')].filter(Boolean).join('; ')}.`
}

// El libro en tiempo real (feed del mercado de QvaPay): si llega, qué tiene y cuántos terminales lo reciben
async function liveForm(env: ProEnv) {
	const live = env as unknown as LiveEnv
	if (!live.LIVE) return ''
	const s = await liveStatus(live)
	if (!s || typeof s.events !== 'number') return '<form class="flag"><b>Libro en tiempo real: sin respuesta</b><span class="note">El objeto del libro no contestó.</span></form>'
	const when = (t: number | null) => (t ? inCuba(t).toLocaleString('es', { timeZone: 'UTC', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : 'nunca')
	const title = { feed: 'Libro en tiempo real: feed de QvaPay llegando', poll: 'Libro en tiempo real: sin feed, se lee con la app', off: 'Libro en tiempo real: sin feed ni credenciales' }[s.mode]
	const notes = [
		`${s.events.toLocaleString('en-US')} eventos del feed (el último: ${when(s.lastEvent)}).`,
		live.STAGING || !s.stream ? '' : s.stream.on ? `Stream de QvaPay conectado desde ${when(s.stream.since)} (${(s.stream.events ?? 0).toLocaleString('en-US')} eventos por el stream; ${s.stream.connects ?? 0} conexiones desde que arrancó${s.stream.gap != null ? `, el último corte duró ${Math.round(s.stream.gap / 1000)} s` : ''}).` : `Stream de QvaPay desconectado${s.stream.error ? `: ${escHtml(s.stream.error)}` : ''}.`,
		`${s.offers.toLocaleString('en-US')} ofertas en el libro, ${s.owners.toLocaleString('en-US')} anunciantes conocidos y ${(s.acts ?? 0).toLocaleString('en-US')} movimientos de actividad guardados; ${s.clients === 1 ? '1 terminal conectado' : `${s.clients} terminales conectados`} (${s.proClients} con Pro, al instante; el resto, cada 10 s).`,
		lagNote(s.lag),
		s.creds ? `Lectura del listado con la app: ${s.readError ? `falla (${escHtml(s.readError)})` : `bien (la última: ${when(s.lastRead)})`}.` : 'Faltan las credenciales de la app (QVAPAY_APP_ID y QVAPAY_APP_SECRET): sin ellas no se saben los nombres ni la reputación.',
		s.lastRejected ? `Último evento rechazado: ${escHtml(s.lastRejected.reason)} (${when(s.lastRejected.at)}).` : '',
		!live.QVAPAY_FEED_SECRET ? 'Falta el secreto del feed (QVAPAY_FEED_SECRET): los eventos se rechazan.' : '',
		live.FEED_FORWARD ? 'Cada evento válido se reenvía a staging.' : live.STAGING ? 'Los eventos llegan reenviados desde producción (el webhook es uno solo).' : '',
	].filter(Boolean)
	// Lo que manda QvaPay tal cual (los últimos 15), para ver qué trae cada evento
	const pretty = (b: string) => {
		try {
			return JSON.stringify(JSON.parse(b), null, 2)
		} catch {
			return b
		}
	}
	const recent = s.recent.length
		? `<details><summary>Últimos ${s.recent.length} eventos tal como llegaron</summary>${s.recent
				.map((r) => `<p class="note">${when(r.at)} · ${r.rejected ? `rechazado: ${escHtml(r.rejected)}` : 'firma válida'}</p><pre style="white-space:pre-wrap;font-size:11px;max-height:260px;overflow:auto">${escHtml(pretty(r.body))}</pre>`)
				.join('')}</details>`
		: ''
	return `<form method="post" class="flag${s.mode === 'feed' ? ' on' : ''}"><b>${title}</b><span class="note">${notes.join(' ')} (versión ${s.version ?? 1})</span>${
		live.STAGING ? '<button class="ghost" name="action" value="live-sim" title="Mete una venta inventada en CUP Transferencia, un 1 % más barata que la mejor">Simular oferta</button>' : ''
	}</form>${recent}`
}

type PayRow = Checkout & { refunded_at: number | null; owner: string | null; rstatus: string | null }
// De dónde se pidió: el simulador (con la cuenta de Telegram) o un dispositivo del terminal (solo su huella)
const origin = (c: PayRow) => (c.tg ? 'Simulador' : `Terminal · ${c.requester ? `@${escHtml(c.requester)}` : proShort(c.print)}`)
const checkoutsWhere = (where: string, q: string) =>
	`WHERE ${where} ${q ? 'AND (LOWER(l.username) LIKE ? OR LOWER(c.payer) LIKE ? OR LOWER(c.requester) LIKE ? OR c.id LIKE ? OR c.invoice LIKE ?)' : ''}`
const checkoutsArgs = (q: string) => (q ? [like(q), like(q), like(q), like(q), like(q)] : [])
const countCheckouts = async (db: D1, where: string, q: string) =>
	(await db.prepare(`SELECT COUNT(*) AS n FROM pro_checkouts c LEFT JOIN pro_licenses l ON l.uuid = c.license ${checkoutsWhere(where, q)}`).bind(...checkoutsArgs(q)).first<{ n: number }>())?.n ?? 0
const checkouts = (db: D1, where: string, order: string, limit: number, q: string, offset = 0) =>
	db
		.prepare(
			`SELECT c.*, COALESCE(c.payer, l.username) AS payer, l.username AS owner, (SELECT r.status FROM pro_refunds r WHERE r.checkout = c.id) AS rstatus
			FROM pro_checkouts c LEFT JOIN pro_licenses l ON l.uuid = c.license
			${checkoutsWhere(where, q)}
			ORDER BY ${order} LIMIT ${limit} OFFSET ${offset}`,
		)
		.bind(...checkoutsArgs(q))
		.all<PayRow>()
		.then((r) => r.results)

// Pagos: quién pagó (lo dice QvaPay), desde dónde se pidió y su factura
const PAYS_PAGE = 50
async function paymentsPanel(env: ProEnv, now: number, q = '', url?: URL) {
	const page = pageOf(url, 'pp')
	const [paid, total] = await Promise.all([checkouts(env.DB, "c.status = 'paid'", 'COALESCE(c.paid_at, c.created_at) DESC', PAYS_PAGE, q, (page - 1) * PAYS_PAGE), countCheckouts(env.DB, "c.status = 'paid'", q)])
	const lefts = await leftOf(env.DB, paid.filter((c) => !c.refunded_at).map((c) => c.license ?? ''), now)
	const rows = paid
		.map((c) => {
			const state = c.rstatus
				? `<span class="pill ${c.rstatus}">${REFUND_STATUS[c.rstatus as RefundStatus]}</span>${c.rstatus === 'rejected' && !c.refunded_at ? ` ${refundButton(c.id, quoteOf(c.amount, lefts.get(c.id), c.day_usd), c.payer ?? '')}` : ''}`
				: c.refunded_at
					? `<span class="note">devuelto el ${hDay(c.refunded_at)}</span>`
					: refundButton(c.id, quoteOf(c.amount, lefts.get(c.id), c.day_usd), c.payer ?? '')
			return `<tr><td>${hWhen(c.paid_at ?? c.created_at)}</td><td>${c.owner ? userLink(c.owner) : `<b>@${escHtml(c.payer ?? '?')}</b>`}${c.owner && c.owner.toLowerCase() !== (c.payer ?? '').toLowerCase() ? ` <span class="note">pagó @${escHtml(c.payer ?? '?')}</span>` : ''}</td><td>${escHtml(PLANS[c.plan]?.name ?? c.plan)}</td><td class="num">${proUsd(c.amount)}</td><td>${origin(c)}</td><td>${c.invoice ? proShort(c.invoice) : '—'}</td><td>${state}</td></tr>`
		})
		.join('')
	return panel(
		'Pagos',
		`<div class="wrap"><table class="left"><thead><tr><th>Pagado</th><th>Cuenta</th><th>Días</th><th class="num">Importe</th><th>Pedido desde</th><th>Factura</th><th>Devolución</th></tr></thead><tbody>${rows || '<tr><td colspan="7" class="empty">Todavía no hay pagos.</td></tr>'}</tbody></table></div>`,
		{ sub: `${count(total, 'pago', 'pagos')}, los más recientes primero`, flush: true, actions: '<a class="btn" href="/admin/pro?export=pagos">Descargar CSV</a>', foot: pager(url, 'pp', page, PAYS_PAGE, total) || undefined },
	)
}

// Facturas sin pagar de la última semana: si alguien dice que pagó y no se activó, se comprueba aquí
async function unpaidPanel(env: ProEnv, now: number, q = '') {
	const pending = await checkouts(env.DB, `c.status = 'pending' AND c.created_at > ${now - 7 * DAY_MS}`, 'c.created_at DESC', 100, q)
	const rows = pending
		.map(
			(c) =>
				`<tr><td>${hWhen(c.created_at)}</td><td>${escHtml(PLANS[c.plan]?.name ?? c.plan)}</td><td class="num">${proUsd(c.amount)}</td><td>${origin(c)}</td><td>${c.invoice ? proShort(c.invoice) : '—'}</td><td>${now - c.created_at < CHECKOUT_MS ? '<span class="pill requested">esperando el pago</span>' : '<span class="pill">caducada</span>'}</td>
				<td class="num"><form method="post"><input type="hidden" name="checkout" value="${escHtml(c.id)}"><button class="ghost" name="action" value="check" title="Preguntar a QvaPay si ya se pagó">Comprobar</button></form></td></tr>`,
		)
		.join('')
	return panel(
		'Facturas sin pagar',
		`<div class="wrap"><table class="left"><thead><tr><th>Pedida</th><th>Días</th><th class="num">Importe</th><th>Pedido desde</th><th>Factura</th><th>Estado</th><th></th></tr></thead><tbody>${rows || '<tr><td colspan="7" class="empty">Ninguna.</td></tr>'}</tbody></table></div>`,
		{ sub: 'De la última semana. Si alguien dice que pagó y no se le activó, «Comprobar» le pregunta a QvaPay', flush: true },
	)
}

// Cuentas: días, vencimiento, dispositivos y lo pagado
const ACCOUNTS_PAGE = 50
async function accountsPanel(env: ProEnv, now: number, q = '', url?: URL) {
	const page = pageOf(url, 'pc')
	const where = `l.merged_into IS NULL ${q ? 'AND (LOWER(l.username) LIKE ? OR l.uuid LIKE ?)' : ''}`
	const args = q ? [like(q), like(q)] : []
	const total = (await env.DB.prepare(`SELECT COUNT(*) AS n FROM pro_licenses l WHERE ${where}`).bind(...args).first<{ n: number }>())?.n ?? 0
	const { results } = await env.DB
		.prepare(
			`SELECT l.uuid, l.username, l.plan, l.expires_at, l.revoked, l.created_at,
				(SELECT COUNT(*) FROM pro_prints p WHERE p.license = l.uuid) AS devices,
				(SELECT MAX(p.seen_at) FROM pro_prints p WHERE p.license = l.uuid) AS seen,
				(SELECT COUNT(*) FROM pro_checkouts c WHERE c.license = l.uuid AND c.status = 'paid') AS pays,
				(SELECT COALESCE(SUM(c.amount - CASE WHEN c.refunded_at IS NULL THEN 0 ELSE COALESCE(c.refund_usd, c.amount) END), 0) FROM pro_checkouts c WHERE c.license = l.uuid AND c.status = 'paid') AS paid
			FROM pro_licenses l WHERE ${where} ORDER BY l.revoked, l.expires_at DESC LIMIT ${ACCOUNTS_PAGE} OFFSET ${(page - 1) * ACCOUNTS_PAGE}`,
		)
		.bind(...args)
		.all<License & { created_at: number; devices: number; seen: number | null; pays: number; paid: number }>()
	const planName = (p: string) => (p in PLANS ? `comprados (${PLANS[p as Plan].days})` : ({ trial: 'gratis', gift: 'regalados' }[p] ?? p))
	// Quién tiene el terminal restringido o bloqueado
	const limits = new Map((await activeBlocks(env.DB, now)).map((b) => [b.username, b.level]))
	const rows = results
		.map((l) => {
			const left = Math.ceil((l.expires_at - now) / DAY_MS)
			const state = l.revoked ? '<span class="pill rejected">Suspendida</span>' : left <= 0 ? '<span class="pill">Vencida</span>' : `<span class="pill approved-ok">${left} días</span>`
			const limit = limits.get(l.username.toLowerCase())
			return `<tr><td>${userLink(l.username)}</td><td>${state}${limit ? ` <span class="pill rejected">${ACCESS_NAME[limit]} en el terminal</span>` : ''}</td><td>${planName(l.plan)}</td><td>${hDay(l.expires_at)}</td><td>${hDay(l.created_at)}</td><td>${l.devices}${l.seen ? ` <span class="note">· usado ${hDay(l.seen)}</span>` : ''}</td><td class="num">${!l.pays ? '<span class="note">sin pagos</span>' : l.paid ? `${proUsd(l.paid)} <span class="note">· ${l.pays}</span>` : '<span class="note">devuelto</span>'}</td>
			<td class="num"><form method="post"><input type="hidden" name="uuid" value="${escHtml(l.uuid)}"><button class="ghost" name="action" value="${l.revoked ? 'restore' : 'revoke'}"${l.revoked ? '' : ` onclick="return confirm('¿Suspender a @${escHtml(l.username)}? Deja de ser Pro hasta que la reactives; sus días no se pierden.')"`}>${l.revoked ? 'Reactivar' : 'Suspender'}</button></form></td></tr>`
		})
		.join('')
	return panel(
		'Cuentas',
		`<div class="wrap"><table class="left"><thead><tr><th>Usuario</th><th>Estado</th><th>Últimos días</th><th>Pro hasta</th><th>Desde</th><th>Dispositivos</th><th class="num">Pagado</th><th></th></tr></thead><tbody>${rows || '<tr><td colspan="8" class="empty">Todavía no hay usuarios Pro.</td></tr>'}</tbody></table></div>`,
		{ sub: `${count(total, 'cuenta', 'cuentas')} · haz clic en un usuario para ver su ficha`, flush: true, foot: pager(url, 'pc', page, ACCOUNTS_PAGE, total) || undefined },
	)
}

// Movimientos de días: todo lo que cambió los días de cada cuenta, con el motivo
const MOVES_PAGE = 50
async function movesPanel(env: ProEnv, q = '', url?: URL) {
	const page = pageOf(url, 'pm')
	const from = `FROM pro_days d JOIN pro_licenses l ON l.uuid = d.license ${q ? 'WHERE LOWER(l.username) LIKE ? OR d.checkout LIKE ?' : ''}`
	const args = q ? [like(q), like(q)] : []
	const total = (await env.DB.prepare(`SELECT COUNT(*) AS n ${from}`).bind(...args).first<{ n: number }>())?.n ?? 0
	const moves = (
		await env.DB
			.prepare(`SELECT d.*, l.username ${from} ORDER BY d.created_at DESC, d.id DESC LIMIT ${MOVES_PAGE} OFFSET ${(page - 1) * MOVES_PAGE}`)
			.bind(...args)
			.all<{ username: string; kind: string; days: number; expires_after: number; note: string | null; actor: string; created_at: number }>()
	).results
	const rows = moves
		.map(
			(m) =>
				`<tr><td>${hWhen(m.created_at)}</td><td>${userLink(m.username)}</td><td>${KIND_NAME[m.kind] ?? escHtml(m.kind)}</td><td class="num ${m.days < 0 ? 'ask' : 'bid'}">${m.days > 0 ? '+' : ''}${m.days}</td><td>${hDay(m.expires_after)}</td><td style="white-space:normal">${m.note ? escHtml(m.note) : '<span class="note">—</span>'}${m.actor === 'admin' ? ' <span class="note">· tú</span>' : ''}</td></tr>`,
		)
		.join('')
	return panel(
		'Movimientos de días',
		`<div class="wrap"><table class="left"><thead><tr><th>Cuándo</th><th>Usuario</th><th>Qué</th><th class="num">Días</th><th>Pro hasta</th><th>Motivo</th></tr></thead><tbody>${rows || '<tr><td colspan="6" class="empty">Todavía no hay movimientos.</td></tr>'}</tbody></table></div>`,
		{ sub: `${count(total, 'movimiento', 'movimientos')}, los más recientes primero`, flush: true, foot: pager(url, 'pm', page, MOVES_PAGE, total) || undefined },
	)
}

// Lo que se sabe de una factura, para quien dice que pagó: si no es un problema de la factura, se ve aquí
function invoiceHtml(r: Awaited<ReturnType<typeof invoiceFacts>>) {
	const head = `Factura ${proShort(r.invoice)}: ${proUsd(r.amount)}${r.createdAt ? `, creada el ${hWhen(r.createdAt)}` : ''}.`
	if (!r.paid) return `<p class="note">${head} QvaPay dice que <b>no está pagada</b> (estado «${escHtml(r.status)}»): no hay pago que activar.</p>`
	const by = `pagada por <b>@${escHtml(r.payer ?? '?')}</b>`
	if (!r.ours) return `<p class="note">${head} Está ${by}, pero <b>no es una factura de Pro</b>: no da días.</p>`
	const c = r.known
	if (c?.status === 'paid')
		return `<p class="note">${head} Está ${by} y <b>ya está activada</b>: ${escHtml(PLANS[c.plan]?.name ?? c.plan)} para ${c.owner ? userLink(c.owner) : '?'}${c.paid_at ? ` desde el ${hWhen(c.paid_at)}` : ''}${c.refunded_at ? `, devuelta el ${hDay(c.refunded_at)}` : ''}.</p>`
	return `<p class="note">${head} Está ${by} y <b>sin activar</b>${c ? '' : ' (no consta aquí)'}.</p>
		<form method="post" class="row"><input type="hidden" name="invoice" value="${escHtml(r.invoice)}"><button name="action" value="recover">Activar para @${escHtml(r.payer ?? '?')}</button></form>`
}

const invoicePanel = () =>
	panel(
		'Comprobar una factura',
		`<form method="post" class="row"><input type="hidden" name="action" value="invoice-check"><input name="invoice" placeholder="uuid de la factura o su enlace" required style="flex:1 1 300px"><button>Comprobar</button></form>`,
		{ sub: 'Para quien dice que pagó y no se le activó: lo que dice QvaPay de esa factura y si ya consta aquí. Si está pagada y sin activar, se puede activar desde aquí' },
	)

async function paymentsPage(env: ProEnv, flash: string, now: number, url: URL) {
	return proPage(env, 'pro-pagos', 'Pagos de Pro', `${pageHead('Pagos', 'Quién pagó lo confirma QvaPay. Desde aquí se devuelve una compra: se le quitan sus días y luego haces tú la transferencia.', proSearch())}${flash}${invoicePanel()}${await paymentsPanel(env, now, '', url)}${await unpaidPanel(env, now)}`)
}

// Las cuentas con el terminal restringido o bloqueado ahora mismo, y el formulario para cualquier usuario
async function blocksPanel(env: ProEnv, now: number) {
	const rows = (await activeBlocks(env.DB, now))
		.map(
			(b) =>
				`<tr><td>${userLink(b.username)}</td><td><span class="pill rejected">${ACCESS_NAME[b.level]}</span></td><td>${b.until ? hWhen(b.until) : 'hasta que la levantes'}</td><td style="white-space:normal">${escHtml(b.reason)}</td><td>${hWhen(b.created_at)}</td>
				<td class="num"><form method="post"><input type="hidden" name="username" value="${escHtml(b.username)}"><button class="ghost" name="action" value="access-lift" onclick="return confirm('¿Levantar el límite a @${escHtml(b.username)}?')">Levantar</button></form></td></tr>`,
		)
		.join('')
	return panel(
		'Acceso al terminal: restringidas y bloqueadas',
		`<div class="wrap"><table class="left"><thead><tr><th>Usuario</th><th>Límite</th><th>Hasta</th><th>Motivo</th><th>Desde</th><th></th></tr></thead><tbody>${rows || '<tr><td colspan="6" class="empty">Ninguna: todos usan el terminal con normalidad.</td></tr>'}</tbody></table></div><div class="panel-b">${accessForm(null, null, now)}</div>`,
		{ sub: ACCESS_HELP, flush: true },
	)
}

async function accountsPage(env: ProEnv, flash: string, now: number, url: URL) {
	return proPage(
		env,
		'pro-cuentas',
		'Cuentas de Pro',
		`${pageHead('Cuentas', 'Una cuenta por usuario de QvaPay, con todos sus dispositivos.', proSearch())}${flash}${await accountsPanel(env, now, '', url)}
		${panel('Dar o quitar días', daysForm(), { sub: 'Un regalo, una compensación por un fallo o una corrección. Si aún no ha conectado su cuenta, se le activan al conectarla' })}
		${await blocksPanel(env, now)}
		${await movesPanel(env, '', url)}`,
	)
}

// ── En vivo: quién tiene el terminal abierto ahora ───────────────────
// Los terminales con una cuenta de QvaPay conectada reciben el libro en vivo: cada uno es una conexión abierta, con la
// cuenta que confirmó QvaPay. No se guarda nada: es lo que hay en este momento (la página se recarga sola)
const LIVE_REFRESH_S = 15
const COIN_NAME = new Map(COINS.map((c) => [c.tick as string, c.name]))
const agoText = (ms: number) => (ms < 60_000 ? `hace ${Math.max(1, Math.round(ms / 1000))} s` : ms < 3_600_000 ? `hace ${Math.round(ms / 60_000)} min` : `hace ${(ms / 3_600_000).toFixed(1)} h`)

export function liveRows(clients: LiveClient[]) {
	const by = new Map<string, { u: string | null; tabs: number; pro: boolean; subs: Set<string>; at: number; seen: number }>()
	for (const c of clients) {
		const k = c.u?.toLowerCase() ?? '—'
		const x = by.get(k) ?? { u: c.u, tabs: 0, pro: false, subs: new Set<string>(), at: Infinity, seen: 0 }
		x.tabs++
		x.pro ||= c.pro
		for (const s of c.subs) x.subs.add(s)
		if (c.at) x.at = Math.min(x.at, c.at)
		x.seen = Math.max(x.seen, c.seen ?? c.at ?? 0)
		by.set(k, x)
	}
	return [...by.values()].sort((a, b) => a.at - b.at)
}

// El día en Cuba (AAAA-MM-DD) en epoch ms: de su medianoche a la siguiente
function cubaDayRange(day: string) {
	const mid = Date.parse(`${day}T00:00:00Z`)
	const from = mid - cubaOffset(mid + 12 * 3600_000)
	return { from, to: from + 86_400_000 }
}
const hHM = (ms: number) => inCuba(ms).toLocaleTimeString('es', { timeZone: 'UTC', hour: '2-digit', minute: '2-digit' })
const minutesText = (m: number) => (m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`)

// La gráfica del día: el máximo de cuentas conectadas a la vez en cada franja de 10 minutos
function liveChart(slots: LiveDay['slots'], from: number) {
	const n = 86_400_000 / SLOT_MS
	const max = Math.max(1, ...slots.map((x) => x.accounts))
	const W = 1440
	const H = 140
	const bw = W / n
	const bars = slots
		.map((x) => {
			const i = Math.round((x.slot - from) / SLOT_MS)
			if (i < 0 || i >= n || !x.accounts) return ''
			const h = Math.max(2, (x.accounts / max) * (H - 18))
			return `<rect x="${(i * bw + 1).toFixed(1)}" y="${(H - h).toFixed(1)}" width="${(bw - 2).toFixed(1)}" height="${h.toFixed(1)}" rx="2" fill="var(--accent)"><title>${hHM(x.slot)}–${hHM(x.slot + SLOT_MS)} · ${count(x.accounts, 'cuenta', 'cuentas')}${x.pro ? ` (${x.pro} con Pro)` : ''} · ${count(x.tabs, 'pestaña', 'pestañas')}</title></rect>`
		})
		.join('')
	const ticks = [0, 3, 6, 9, 12, 15, 18, 21].map((h) => `<text x="${(h * 6 * bw).toFixed(0)}" y="${H + 30}" font-size="24" fill="var(--muted)">${String(h).padStart(2, '0')}:00</text>`).join('')
	return `<svg viewBox="0 -28 ${W} ${H + 64}" width="100%" style="width:100%;height:auto;display:block" role="img" aria-label="Cuentas conectadas a lo largo del día"><line x1="0" x2="${W}" y1="${H}" y2="${H}" stroke="var(--line)"/>${bars}${ticks}<text x="${W}" y="-6" font-size="24" fill="var(--muted)" text-anchor="end">máx. ${max}</text></svg>`
}

async function livePage(env: ProEnv, flash: string, now: number, url: URL) {
	const today = cubaDate(now)
	const asked = url.searchParams.get('d') ?? ''
	const day = /^\d{4}-\d{2}-\d{2}$/.test(asked) && asked <= today ? asked : today
	const isToday = day === today
	const { from, to } = cubaDayRange(day)
	const [clients, hist] = await Promise.all([isToday ? liveClients(env as unknown as LiveEnv) : Promise.resolve(null), liveDay(env.DB, day, from, to)])
	const rows = clients ? liveRows(clients) : []
	const known = rows.filter((r) => r.u)
	const online = new Set(known.map((r) => r.u!.toLowerCase()))
	const table = !clients
		? '<p class="empty">El libro en vivo no responde ahora mismo.</p>'
		: rows.length
			? `<div class="wrap"><table class="left"><thead><tr><th>Cuenta</th><th>Pro</th><th>Mirando</th><th class="num">Pestañas</th><th>Conectada desde</th><th>Última señal</th></tr></thead><tbody>${rows
					.map(
						(r) =>
							`<tr><td>${r.u ? userLink(r.u) : '<span class="note">sin identificar</span>'}</td><td>${r.pro ? '<span class="pill approved-ok">Pro</span>' : '<span class="note">—</span>'}</td><td style="white-space:normal">${[...r.subs].map((s) => escHtml(COIN_NAME.get(s) ?? s)).join(', ') || '<span class="note">ningún mercado (pestaña en segundo plano)</span>'}</td><td class="num">${r.tabs}</td><td>${Number.isFinite(r.at) ? `${hWhenS(r.at)} <span class="note">(${agoText(now - r.at).replace('hace ', '')})</span>` : '—'}</td><td>${r.seen ? agoText(Math.max(0, now - r.seen)) : '—'}</td></tr>`,
					)
					.join('')}</tbody></table></div>`
			: '<p class="empty">Nadie tiene el terminal abierto con su cuenta conectada ahora mismo.</p>'

	// El día: la gráfica y quién estuvo
	const peak = hist.slots.reduce((m, x) => (x.accounts > (m?.accounts ?? 0) ? x : m), null as LiveDay['slots'][number] | null)
	const dayName = inCuba(from + 12 * 3600_000).toLocaleDateString('es', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long' })
	const shift = (d: number) => cubaDate(from + 12 * 3600_000 + d * 86_400_000)
	const nav = `<a class="btn" href="/admin/pro?view=envivo&d=${shift(-1)}">← ${escHtml(shift(-1).slice(5).split('-').reverse().join('/'))}</a>${isToday ? '' : `<a class="btn" href="/admin/pro?view=envivo&d=${shift(1)}">${escHtml(shift(1).slice(5).split('-').reverse().join('/'))} →</a><a class="btn" href="/admin/pro?view=envivo">Hoy</a>`}`
	const seenTable = hist.seen.length
		? `<div class="wrap"><table class="left"><thead><tr><th>Cuenta</th><th>Pro</th><th>Primera vez</th><th>Última vez</th><th class="num">Tiempo conectada</th></tr></thead><tbody>${hist.seen
				.map(
					(x) =>
						`<tr><td>${userLink(x.name)}</td><td>${x.pro ? '<span class="pill approved-ok">Pro</span>' : '<span class="note">—</span>'}</td><td>${hHM(x.first_at)}</td><td>${isToday && online.has(x.account) ? '<span class="pill approved-ok">ahora</span>' : hHM(x.last_at)}</td><td class="num">${minutesText(x.minutes)}</td></tr>`,
				)
				.join('')}</tbody></table></div>`
		: '<p class="empty">Nadie se conectó este día (o aún no se guardaba).</p>'
	const dayCards = `<div class="cards"><div class="card"><span>Cuentas distintas</span><b>${hist.seen.length.toLocaleString('en-US')}</b><small>${isToday ? 'hoy, hasta ahora' : 'ese día'}</small></div><div class="card"><span>Pico a la vez</span><b>${(peak?.accounts ?? 0).toLocaleString('en-US')}</b><small>${peak ? `a las ${hHM(peak.slot)}` : '—'}</small></div><div class="card"><span>Con Pro</span><b>${hist.seen.filter((x) => x.pro).length.toLocaleString('en-US')}</b><small>de las que se conectaron</small></div></div>`

	return proPage(
		env,
		'live',
		'En vivo',
		`${isToday ? `<meta http-equiv="refresh" content="${LIVE_REFRESH_S}">` : ''}${pageHead('En vivo', `Quién tiene el terminal abierto con su cuenta de QvaPay conectada${isToday ? `, ahora y a lo largo del día. Se actualiza cada ${LIVE_REFRESH_S} s` : ''}. Del día se guarda solo quién estuvo y cuánto (nunca qué miraba), 90 días.`, nav)}${flash}
		${
			isToday
				? `<h2 class="sec-title">Ahora</h2><div class="cards"><div class="card"><span>Cuentas conectadas</span><b>${known.length.toLocaleString('en-US')}</b><small>ahora mismo</small></div><div class="card"><span>Pestañas abiertas</span><b>${(clients?.length ?? 0).toLocaleString('en-US')}</b><small>con el libro en vivo</small></div><div class="card"><span>Con Pro</span><b>${known.filter((r) => r.pro).length.toLocaleString('en-US')}</b><small>de las conectadas</small></div></div>
		${panel('Terminales abiertos', table, { flush: !!rows.length, sub: 'Solo los que tienen su cuenta conectada (reciben el libro en vivo). Quien mira sin conectar no sale aquí: eso lo cuentan las visitas de Métricas. La última señal llega cada 25 s mientras la pestaña sigue abierta.' })}`
				: ''
		}
		<h2 class="sec-title">${isToday ? 'Hoy' : escHtml(dayName)}</h2>${dayCards}
		${panel('A lo largo del día', liveChart(hist.slots, from), { sub: 'Cuántas cuentas había conectadas a la vez: el máximo de cada 10 minutos, en hora de Cuba. Pasa el ratón por una barra para ver la franja.' })}
		${panel('Quién se conectó', seenTable, { flush: !!hist.seen.length, sub: 'La primera y la última vez que se la vio con el terminal abierto, y cuánto tiempo en total (se mira cada minuto).' })}`,
	)
}

async function searchPage(env: ProEnv, flash: string, now: number, q: string, url: URL) {
	return proPage(
		env,
		'pro',
		`Buscar «${escHtml(q)}»`,
		`${pageHead(`Resultados para «${escHtml(q)}»`, '<a href="/admin/pro">Quitar la búsqueda</a>', proSearch(q))}${flash}${await accountsPanel(env, now, q, url)}${await paymentsPanel(env, now, q, url)}${await unpaidPanel(env, now, q)}${await movesPanel(env, q, url)}`,
	)
}
