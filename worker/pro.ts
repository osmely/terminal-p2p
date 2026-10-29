// Plan Pro de Terminal P2P (app.terminalp2p.com/pro/*).
//
// Quién es cada usuario lo dice QvaPay: al pagar una factura de nuestra app, la API de comerciante
// devuelve quién la pagó (PaidBy); y al conectar la cuenta, el perfil que el relé trae de QvaPay deja
// firmado de quién es la huella de ese token (session.ts: readWho). El token nunca se guarda: de cada
// dispositivo solo vemos su huella (HMAC del token). Con ella se pregunta si eres Pro y se recoge el
// módulo Pro, firmado para ti. Pro va con la cuenta: cualquier dispositivo donde la conectes entra solo.

import { hex, hmac, sign, verify } from './crypto.ts'
import { adminPage, askKey, pageHead, panel, searchIcon, type AdminTab } from './admin.ts'
import { authorized } from './metrics.ts'
import type { D1 } from './rates.ts'
import { clearWho, readWho, sessionCookie, sessionToken } from './session.ts'
import { alertsReady, notify, tgEsc, type AlertEnv } from './alerts.ts'
import { GRACE_MS, INCIDENT_NAME, openIncidents, recordIncident, resolveIncident, type Incident } from './incidents.ts'
import { cleanRadarHit, connectBot, linked, linkUrl, radarButton, radarText, tellDays, tellPaid, tellRefund, tellUser, unlink, botWebhook } from './userbot.ts'
import { ORDERS_PAUSED_MSG, ordersPaused, proEnabled, setOrdersPaused, setProEnabled } from './flags.ts'
import { dailyPostOn, lastPosts, POST_HOUR, setDailyPost, testDailyPost } from './community.ts'
import { liveSimulate, liveStatus, type LiveEnv } from './livebook.ts'
import { ACCESS_NAME, accessError, accessOf, activeBlocks, blockOf, isActive, liftBlock, setBlock, type AccessLevel, type Block } from './blocks.ts'

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
}

export const PLANS = {
	week: { usd: 1.99, days: 7, name: '7 días' },
	month: { usd: 4.99, days: 30, name: '30 días' },
	quarter: { usd: 12.99, days: 90, name: '90 días' },
	year: { usd: 39.99, days: 365, name: '365 días' },
} as const
export type Plan = keyof typeof PLANS
// Para las consultas de cuentas con días comprados (las demás son trial y gift)
const PAID_PLANS_SQL = Object.keys(PLANS).map((p) => `'${p}'`).join(', ')

// Devolución completa en los días siguientes al primer pago (a mano: QvaPay no tiene devoluciones por API)
export const REFUND_DAYS = 7
export const TRIAL_DAYS = 14
// Topes de días gratis nuevos: por IP y día (amplio: muchos comparten IP en Cuba) y en total por día. No hacen
// imposible inventar cuentas (el servidor no ve el token), pero lo vuelven lento y caro
export const TRIAL_PER_IP_DAY = 10
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
export type DayKind = 'trial' | 'purchase' | 'gift' | 'refund' | 'adjust'

export async function addDays(
	db: D1,
	username: string,
	m: { kind: DayKind; days: number; plan?: string; checkout?: string | null; note?: string | null; actor: 'system' | 'admin' },
	now: number,
) {
	const id = accountOf(username)
	const old = await db.prepare('SELECT expires_at, plan, revoked FROM pro_licenses WHERE uuid = ?').bind(id).first<{ expires_at: number; plan: string; revoked: number }>()
	const before = old?.expires_at ?? null
	const days = Math.trunc(m.days)
	// Sumar cuenta desde hoy si ya había vencido; restar nunca deja la cuenta antes de hoy (ni toca una ya vencida)
	const after =
		days >= 0 ? Math.max(now, before ?? 0) + days * DAY_MS : before !== null && before > now ? Math.max(now, before + days * DAY_MS) : (before ?? now)
	// El tipo de días que tiene ahora: el de lo último que sumó (los gratis permiten comprar más cuando quiera)
	const plan = days > 0 && m.kind !== 'adjust' ? (m.plan ?? m.kind) : (old?.plan ?? m.plan ?? m.kind)
	// La cuenta y su movimiento van juntos (batch es una transacción): o quedan los dos o ninguno. Pagar no levanta
	// una suspensión: los días se suman y sigue suspendida hasta que la reactives (o le devuelvas el dinero)
	await db.batch([
		old
			? db.prepare('UPDATE pro_licenses SET username = ?, plan = ?, expires_at = ?, updated_at = ? WHERE uuid = ?').bind(username, plan, after, now, id)
			: db.prepare('INSERT INTO pro_licenses (uuid, username, plan, expires_at, backup_hash, revoked, created_at, updated_at) VALUES (?, ?, ?, ?, NULL, 0, ?, ?)').bind(id, username, plan, after, now, now),
		db
			.prepare('INSERT INTO pro_days (license, kind, days, expires_before, expires_after, checkout, note, actor, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
			.bind(id, m.kind, days, before, after, m.checkout ?? null, m.note ?? null, m.actor, now),
	])
	return { license: id, before, after, suspended: !!old?.revoked }
}

// Devolver una compra: se restan sus días (los que queden, si ya gastó parte) y se apunta. Los dispositivos y el
// resto de sus días siguen igual. El dinero lo transfieres tú desde QvaPay a quien pagó
export async function refundCheckout(db: D1, checkout: string, note: string | null, now: number) {
	const c = await db
		.prepare("SELECT c.id, c.plan, c.amount, c.license, COALESCE(c.payer, l.username) AS payer, l.username FROM pro_checkouts c JOIN pro_licenses l ON l.uuid = c.license WHERE c.id = ? AND c.status = 'paid' AND c.refunded_at IS NULL")
		.bind(checkout)
		.first<{ id: string; plan: Plan; amount: number; license: string; payer: string; username: string }>()
	if (!c) return null
	const marked = await db.prepare('UPDATE pro_checkouts SET refunded_at = ? WHERE id = ? AND refunded_at IS NULL').bind(now, c.id).run()
	if (!marked.meta?.changes) return null
	const r = await addDays(db, c.username, { kind: 'refund', days: -(PLANS[c.plan]?.days ?? 0), checkout: c.id, note, actor: 'admin' }, now)
	return { ...c, ...r }
}

// Lo que el terminal necesita saber: si eres Pro, hasta cuándo y la licencia firmada para recoger el módulo
// Y los paquetes con sus precios: así solo están escritos en PLANS (la web los recibe igual, worker/index.ts)
export async function statusOf(env: ProEnv, l: License | null, now: number) {
	if (!l) return { pro: false, enabled: true, plans: planList() }
	const license = await sign({ u: l.uuid, n: l.username, e: l.expires_at, x: now + LICENSE_MS }, env.PRO_KEY!)
	return { pro: true, enabled: true, username: l.username, plan: l.plan, expiresAt: l.expires_at, license, plans: planList() }
}
export const planList = () => (Object.keys(PLANS) as Plan[]).map((id) => ({ id, name: PLANS[id].name, usd: PLANS[id].usd, days: PLANS[id].days }))

// ── Devoluciones en pasos ────────────────────────────────────────────
// Pedida (por el usuario desde «Mi cuenta», o por ti) → aprobada (se le quitan los días de esa compra) →
// transferida (la haces tú en QvaPay y apuntas la referencia). O rechazada, con un motivo que el usuario ve

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

// Una compra se puede devolver si está pagada, no devuelta y dentro del plazo desde la primera compra de la cuenta
export async function refundable(db: D1, checkout: string, now: number) {
	const c = await db
		.prepare(
			`SELECT c.id, c.plan, c.amount, c.license, COALESCE(c.payer, l.username) AS payee, c.refunded_at,
				(SELECT MIN(COALESCE(f.paid_at, f.created_at)) FROM pro_checkouts f WHERE f.license = c.license AND f.status = 'paid') AS first_paid
			FROM pro_checkouts c JOIN pro_licenses l ON l.uuid = c.license WHERE c.id = ? AND c.status = 'paid'`,
		)
		.bind(checkout)
		.first<{ id: string; plan: Plan; amount: number; license: string; payee: string; refunded_at: number | null; first_paid: number | null }>()
	if (!c) return null
	return { ...c, inTime: c.first_paid !== null && now - c.first_paid < REFUND_DAYS * DAY_MS }
}

export async function requestRefund(db: D1, license: string, checkout: string, reason: string, by: 'user' | 'admin', now: number) {
	const c = await refundable(db, checkout, now)
	if (!c || c.license !== license) throw new ProError(404, 'Esa compra no es tuya o no existe')
	if (c.refunded_at) throw new ProError(409, 'Esa compra ya se devolvió')
	if (await db.prepare('SELECT 1 FROM pro_refunds WHERE checkout = ?').bind(checkout).first()) throw new ProError(409, 'Ya pediste la devolución de esa compra')
	if (by === 'user' && !c.inTime) throw new ProError(409, `La devolución se pide en los ${REFUND_DAYS} días siguientes a tu primera compra. Escríbenos a @terminalp2p si es otra cosa.`)
	const id = `rf-${crypto.randomUUID()}`
	await db
		.prepare("INSERT INTO pro_refunds (id, checkout, license, amount, payee, status, reason, requested_by, requested_at) VALUES (?, ?, ?, ?, ?, 'requested', ?, ?, ?)")
		.bind(id, checkout, license, c.amount, c.payee, reason.slice(0, 300) || null, by, now)
		.run()
	return id
}

const refundRow = (db: D1, id: string) => db.prepare('SELECT * FROM pro_refunds WHERE id = ?').bind(id).first<Refund>()

// Aprobar: se le quitan los días de esa compra. Queda pendiente que transfieras el dinero. Los días se quitan
// antes de darla por aprobada: si la compra ya no se puede devolver, la devolución sigue pedida
export async function approveRefund(db: D1, id: string, note: string | null, now: number) {
	const r = await refundRow(db, id)
	if (!r || r.status !== 'requested') throw new ProError(409, 'Esa devolución no está pendiente de aprobar')
	if (!(await refundCheckout(db, r.checkout, note ?? r.reason, now))) throw new ProError(409, 'Esa compra ya se devolvió o no consta como pagada')
	await db.prepare("UPDATE pro_refunds SET status = 'approved', decided_at = ?, decision_note = ? WHERE id = ? AND status = 'requested'").bind(now, note, id).run()
	return (await refundRow(db, id))!
}

// Devolver directamente desde el panel (te lo pidió por Telegram): se apunta como pedida por ti y aprobada. Si
// antes la rechazaste y cambias de idea, la misma devolución vuelve a pedida y se aprueba
export async function adminRefund(db: D1, checkout: string, note: string | null, now: number) {
	const c = await refundable(db, checkout, now)
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
// (todas) y la consulta de estado de cada dispositivo (solo las suyas)
const PENDING_BATCH = 25
export async function settlePending(env: ProEnv, now: number, who: { print?: string } = {}, fetcher: typeof fetch = fetch) {
	const [filter, arg] = who.print ? [' AND print = ?', who.print] : ['', null]
	const { results } = await env.DB.prepare(`SELECT * FROM pro_checkouts WHERE status = 'pending' AND created_at > ? AND invoice IS NOT NULL${filter} ORDER BY created_at DESC LIMIT ?`)
		.bind(...(arg === null ? [now - CHECKOUT_MS, PENDING_BATCH] : [now - CHECKOUT_MS, arg, PENDING_BATCH]))
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
		await env.DB.prepare("INSERT OR IGNORE INTO pro_checkouts (id, print, tg, plan, amount, invoice, status, created_at) VALUES (?, '', NULL, ?, ?, ?, 'pending', ?)")
			.bind(t.remote_id, plan, PLANS[plan].usd, invoice, Date.parse(t.created_at ?? '') || now)
			.run()
	const c = (await env.DB.prepare('SELECT * FROM pro_checkouts WHERE id = ?').bind(t.remote_id).first<Checkout>())!
	// Solo se da por resuelta si de verdad quedó activada
	if (!(await settle(env, c, now, fetcher))) throw new ProError(409, `QvaPay la da por pagada (${t.amount} USD) pero no se pudo activar sola. Dale los días a mano desde la ficha de @${t.PaidBy.username}.`)
	await env.DB.prepare('UPDATE pro_issues SET resolved_at = ? WHERE invoice = ? AND resolved_at IS NULL').bind(now, invoice).run()
	return { username: t.PaidBy.username, plan }
}

// Todas las tablas de Pro (sin los códigos de respaldo por recoger, que se ven una sola vez)
export async function proSnapshot(db: D1, now: number) {
	const all = async (t: string) => (await db.prepare(`SELECT * FROM ${t}`).all<Record<string, unknown>>()).results
	const checkouts = (await all('pro_checkouts')).map(({ backup_code: _, ...c }) => c)
	return { at: new Date(now).toISOString(), licenses: await all('pro_licenses'), days: await all('pro_days'), prints: await all('pro_prints'), checkouts, trials: await all('pro_trials') }
}

export async function backupPro(env: ProEnv, now: number) {
	if (!env.PRO?.put) return null
	const key = `backup/pro/${new Date(now).toISOString().slice(0, 10)}`
	await env.PRO.put(key, JSON.stringify(await proSnapshot(env.DB, now)), { expirationTtl: BACKUP_TTL_S })
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
	if (l && l.plan !== 'trial' && l.expires_at - now > RENEW_DAYS * DAY_MS) throw new ProError(409, `Aún te quedan días de Pro. Podrás añadir más cuando te queden ${RENEW_DAYS} o menos.`)
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
	await db.prepare("INSERT INTO pro_checkouts (id, print, tg, plan, amount, invoice, status, created_at, requester) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)")
		.bind(id, who.print, null, plan, p.usd, inv.transaction_uuid, now, who.username)
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

// Lo que el usuario ve de su cuenta: días, su historial (sin tus notas internas) y sus compras con la devolución
export async function accountView(db: D1, license: string | null, now: number) {
	const l = license ? await db.prepare('SELECT uuid, username, plan, expires_at, revoked FROM pro_licenses WHERE uuid = ? AND merged_into IS NULL').bind(license).first<License>() : null
	if (!l) return { account: null, moves: [], purchases: [], refundDays: REFUND_DAYS }
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
				`SELECT c.id, c.plan, c.amount, COALESCE(c.paid_at, c.created_at) AS at, c.refunded_at, r.status AS rstatus, r.decision_note, r.requested_at AS rat, r.transferred_at AS tat, r.transfer_ref
				FROM pro_checkouts c LEFT JOIN pro_refunds r ON r.checkout = c.id WHERE c.license = ? AND c.status = 'paid' ORDER BY at DESC`,
			)
			.bind(l.uuid)
			.all<{ id: string; plan: Plan; amount: number; at: number; refunded_at: number | null; rstatus: RefundStatus | null; decision_note: string | null; rat: number | null; tat: number | null; transfer_ref: string | null }>()
	).results
	const first = paid.length ? Math.min(...paid.map((p) => p.at)) : null
	const inTime = first !== null && now - first < REFUND_DAYS * DAY_MS
	const purchases = paid.map((p) => ({
		id: p.id,
		at: p.at,
		days: PLANS[p.plan]?.days ?? 0,
		amount: p.amount,
		// Ya devuelta: cuándo y la referencia de la transferencia en QvaPay con que se le devolvió
		refund: p.rstatus
			? {
					status: p.rstatus,
					note: p.rstatus === 'rejected' ? p.decision_note : null,
					at: p.rat,
					...(p.rstatus === 'transferred' ? { transferredAt: p.tat, ref: p.transfer_ref } : {}),
				}
			: null,
		canRefund: inTime && !p.refunded_at && !p.rstatus,
	}))
	return {
		account: { username: l.username, plan: l.plan, expiresAt: l.expires_at, suspended: !!l.revoked, active: !l.revoked && l.expires_at > now },
		moves,
		purchases,
		refundDays: REFUND_DAYS,
		refundUntil: first !== null ? first + REFUND_DAYS * DAY_MS : null,
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

export async function proApi(req: Request, url: URL, env: ProEnv, now = Date.now(), fetcher: typeof fetch = fetch): Promise<Response | null> {
	const path = url.pathname
	if (!path.startsWith('/pro/') && path !== '/api/pro/webhook') return null
	if (!env.PRO_KEY) return json(503, { error: 'Pro aún no está disponible' })
	const db = env.DB
	const route = `${req.method} ${path}`
	try {
		// Con Pro apagado en el panel: nadie es Pro ni puede comprar, y no empiezan los días gratis. La consulta de
		// estado sigue dejando la sesión del simulador, y los avisos de pago de QvaPay se siguen atendiendo
		if (!(await proEnabled(db, now)) && !['POST /pro/status', 'POST /pro/leave', 'POST /pro/rotate', 'POST /pro/webhook', 'POST /api/pro/webhook', 'POST /pro/telegram/webhook', 'POST /pro/telegram/unlink'].includes(route)) return json(404, { error: 'Pro aún no está disponible' })
		// ¿Este dispositivo es Pro?
		if (route === 'POST /pro/status') {
			const b = await readBody(req)
			const print = printOf(b.print)
			if (!(await proEnabled(db, now))) {
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
			if ((await accessOf(db, { username: username ?? l?.username, print }, now))?.level === 'blocked') {
				const res = json(200, { pro: false, enabled: true, canTrial: false, blocked: true, plans: planList() })
				res.headers.set('Set-Cookie', sessionCookie(url, '', 0))
				return res
			}
			// Un dispositivo nuevo con tu cuenta entra solo en tu Pro (comprado o de los días gratis)
			if (!l && username) {
				l = await activeLicense(db, accountOf(username), now)
				if (l) await attachPrint(db, l.uuid, print, now)
			}
			if (l) await db.prepare('UPDATE pro_prints SET seen_at = ? WHERE print = ?').bind(now, print).run()
			// Los días gratis no empiezan solos: si aún puede, el terminal le ofrece activarlos (POST /pro/trial)
			const canTrial = !l && !!username && (await trialAvailable(db, username, print))
			// La sesión compartida con el simulador: con ella entra sin otro login y hereda tus días de Pro
			const res = json(200, { ...(await statusOf(env, l, now)), canTrial })
			res.headers.set('Set-Cookie', sessionCookie(url, await sessionToken(print, env.PRO_KEY, now)))
			return res
		}

		// Activar los días gratis (lo pulsa el usuario en el terminal). Con la cuenta que confirmó QvaPay
		if (route === 'POST /pro/trial') {
			const print = printOf((await readBody(req)).print)
			const who = await readWho(req.headers.get('cookie'), print, env.PRO_KEY, now)
			if (!who) return json(403, { error: 'Conecta tu cuenta de QvaPay para activar tus días gratis' })
			if ((await accessOf(db, { username: who.username, print }, now))?.level === 'blocked') return accessError('blocked')
			if (await activeLicense(db, accountOf(who.username), now)) return json(409, { error: 'Ya tienes Pro activo' })
			const r = await freeDays(db, who.username, print, now, await ipPrint(req, env.PRO_KEY))
			if (r === 'used') return json(409, { error: `Ya usaste tus ${TRIAL_DAYS} días gratis en esta cuenta o en este dispositivo` })
			if (r === 'busy') return json(429, { error: 'Ahora mismo no se pueden activar más días gratis desde tu conexión. Inténtalo mañana.' })
			const res = json(200, { ...(await statusOf(env, await licenseOfPrint(db, print, now), now)), canTrial: false, started: true })
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
			if (!who) return json(403, { error: 'Conecta tu cuenta de QvaPay para comprar Pro' })
			if ((await accessOf(db, { username: who.username, print }, now))?.level === 'blocked') return accessError('blocked')
			return json(200, await createCheckout(env, { print, username: who.username }, String(b.plan) as Plan, url.origin, now, fetcher))
		}

		// El navegador que pagó pregunta cómo va su factura
		if (route === 'POST /pro/checkout/status') {
			const b = await readBody(req)
			return json(200, (await checkoutStatus(env, String(b.id ?? ''), { print: printOf(b.print) }, now, fetcher)).body)
		}

		// «Mi cuenta»: días, historial y compras de la cuenta de este dispositivo
		if (route === 'POST /pro/account') {
			const print = printOf((await readBody(req)).print)
			return json(200, await accountView(db, await deviceAccount(req, db, print, env.PRO_KEY, now), now))
		}

		// Pedir la devolución de una compra (en plazo): queda pendiente de que la apruebes
		if (route === 'POST /pro/refund') {
			const b = await readBody(req)
			const print = printOf(b.print)
			const license = await deviceAccount(req, db, print, env.PRO_KEY, now)
			if (!license) return json(403, { error: 'Conecta tu cuenta para pedir la devolución' })
			const reason = String(b.reason ?? '').trim()
			if (reason.length < 3) return json(400, { error: 'Cuéntanos en pocas palabras por qué la pides' })
			await requestRefund(db, license, String(b.checkout ?? ''), reason, 'user', now)
			const c = await refundable(db, String(b.checkout ?? ''), now)
			const user = license.slice(3)
			if (c)
				await notify(
					env,
					`↩️ <b>Devolución pedida</b>\n@${tgEsc(user)} pide devolver <b>${PLANS[c.plan]?.name ?? c.plan}</b> · ${c.amount} USD\nMotivo: «${tgEsc(reason.slice(0, 300))}»\n${c.inTime ? 'En plazo' : 'Fuera de plazo'} · se transfiere a @${tgEsc(c.payee)}`,
					`/admin/pro?u=${encodeURIComponent(user)}`,
					fetcher,
				)
			return json(200, await accountView(db, license, now))
		}

		// Avisos por Telegram: el enlace para conectar el chat desde «Mi cuenta», dejar de recibirlos, y lo que el
		// usuario le escribe al bot (lo manda Telegram, con su clave)
		if (route === 'POST /pro/telegram/link') {
			const print = printOf((await readBody(req)).print)
			const license = await deviceAccount(req, db, print, env.PRO_KEY, now)
			if (!license || !(await db.prepare('SELECT 1 FROM pro_licenses WHERE uuid = ? AND merged_into IS NULL').bind(license).first())) return json(403, { error: 'Conecta tu cuenta para recibir avisos' })
			const url = await linkUrl(env, license, now, fetcher)
			if (!url) return json(503, { error: 'Los avisos por Telegram no están disponibles ahora mismo' })
			return json(200, { url })
		}
		if (route === 'POST /pro/telegram/unlink') {
			const print = printOf((await readBody(req)).print)
			const license = await deviceAccount(req, db, print, env.PRO_KEY, now)
			if (license) await unlink(db, license)
			return json(200, await accountView(db, license, now))
		}
		if (route === 'POST /pro/telegram/webhook') return botWebhook(req, env, now)

		// Radar: el terminal te avisa por Telegram de una oferta que encontró o tomó. Solo con Pro activo, una vez por
		// oferta (aunque el radar corra en varias pestañas) y con tope por hora
		if (route === 'POST /pro/radar/alert') {
			const b = await readBody(req)
			const l = await licenseOfPrint(db, printOf(b.print), now)
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
			await db.prepare('DELETE FROM pro_radar_sent WHERE at < ?').bind(now - DAY_MS).run()
			const recent = await db.prepare('SELECT COUNT(*) AS n FROM pro_radar_sent WHERE license = ? AND at > ?').bind(l.uuid, now - HOUR_MS).first<{ n: number }>()
			if ((recent?.n ?? 0) >= RADAR_TG_PER_HOUR) return json(429, { error: 'Demasiados avisos del radar en la última hora' })
			const claim = await db.prepare('INSERT OR IGNORE INTO pro_radar_sent (license, offer, kind, at) VALUES (?, ?, ?, ?)').bind(l.uuid, hit.offer, hit.kind, now).run()
			if (!claim.meta?.changes) return json(200, { ok: true, sent: false, repeated: true })
			const sent = await tellUser(env, l.uuid, radarText(hit), radarButton(env, hit), fetcher)
			// Si no salió (sin chat conectado, Telegram caído), no cuenta como mandado
			if (!sent) await db.prepare('DELETE FROM pro_radar_sent WHERE license = ? AND offer = ? AND kind = ?').bind(l.uuid, hit.offer, hit.kind).run()
			return json(200, { ok: true, sent })
		}

		// Aviso de QvaPay: solo dice qué factura mirar; se confirma consultándola
		if (req.method === 'POST' && (path === '/pro/webhook' || path === '/api/pro/webhook')) {
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
		if (route === 'POST /pro/rotate') {
			const b = await readBody(req)
			const from = printOf(b.from)
			const to = printOf(b.to)
			// La cuenta del simulador que iba con la huella vieja pasa a la nueva (si la nueva no tiene ya una)
			await db.prepare('UPDATE sim_ids SET key = ? WHERE key = ? AND NOT EXISTS (SELECT 1 FROM sim_ids WHERE key = ?)').bind(`print:${to}`, `print:${from}`, `print:${to}`).run()
			if (!(await proEnabled(db, now))) return json(200, { pro: false, enabled: false })
			const l = await licenseOfPrint(db, from, now)
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
				if (raw) await recordIncident(env, { kind: 'module_forged', detail: 'La firma de la licencia no es nuestra' }, now, fetcher)
				return json(403, { error: 'Licencia no válida' })
			}
			const l = await db.prepare('SELECT revoked, expires_at FROM pro_licenses WHERE uuid = ?').bind(lic.u).first<{ revoked: number; expires_at: number }>()
			// Una licencia vieja (de días ya vencidos, pasado el margen) solo es incidencia si hoy tampoco tiene Pro
			if (lic.e < now - GRACE_MS && !(l && !l.revoked && l.expires_at > now))
				await recordIncident(env, { kind: 'module_expired', username: lic.n, license: lic.u, detail: `Su Pro venció el ${hDay(l?.expires_at ?? lic.e)}` }, now, fetcher)
			if (lic.x < now || lic.e < now) return json(403, { error: 'Licencia no válida' })
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

// ── Panel (/admin/pro, con la clave del panel de métricas) ───────────

const escHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

// ── Panel: piezas compartidas ────────────────────────────────────────
// Horas de Cuba, como el resto del proyecto
const hUsd = (n: number) => `${(Math.round(n * 100) / 100).toLocaleString('en-US')} USD`
const hWhen = (ms: number) => new Date(ms).toLocaleString('es', { timeZone: 'America/Havana', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
const hDay = (ms: number) => new Date(ms).toLocaleDateString('es', { timeZone: 'America/Havana', day: 'numeric', month: 'short', year: 'numeric' })
const hShort = (s: string) => `<span title="${escHtml(s)}">${escHtml(s.slice(0, 8))}…</span>`
const userLink = (u: string) => `<a href="/admin/pro?u=${encodeURIComponent(u)}"><b>@${escHtml(u)}</b></a>`
const copyBtn = (text: string, label = 'Copiar') =>
	`<button type="button" class="ghost" onclick="navigator.clipboard.writeText(${escHtml(JSON.stringify(text))});this.textContent='Copiado'">${label}</button>`
const KIND_NAME: Record<string, string> = { trial: 'Días gratis', purchase: 'Compra', gift: 'Regalo', refund: 'Devolución', adjust: 'Ajuste', import: 'Saldo inicial' }
const REFUND_STATUS: Record<RefundStatus, string> = { requested: 'Pedida', approved: 'Aprobada: falta transferir', transferred: 'Transferida', rejected: 'Rechazada' }

// Devolver una compra desde una tabla: el motivo se pide al pulsar, para que la fila no lleve un formulario entero
const refundButton = (checkout: string, amount: number, payer: string, back = '') =>
	`<form method="post" style="display:inline" onsubmit="var m=prompt('¿Devolver ${amount} USD a @${escHtml(payer)}? Se le quitan los días de esta compra y luego haces tú la transferencia en QvaPay.\\n\\nMotivo (puede verlo el usuario en «Mi cuenta»):','');if(m===null)return false;this.note.value=m">${back}<input type="hidden" name="checkout" value="${escHtml(checkout)}"><input type="hidden" name="note"><button class="ghost" name="action" value="refund">Devolver</button></form>`

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
		act = `<p>Transfiere <b>${hUsd(r.amount)}</b> a <b>@${escHtml(r.payee)}</b> desde tu cuenta de QvaPay ${copyBtn(r.payee, 'Copiar usuario')} ${copyBtn(String(r.amount), 'Copiar monto')}</p>
			<form method="post" class="row">${back}<input type="hidden" name="id" value="${escHtml(r.id)}"><input name="ref" placeholder="referencia de la transferencia en QvaPay" style="flex:1 1 240px"><button name="action" value="refund-transfer">Marcar transferida</button></form>`
	else if (r.status === 'transferred') act = `<p class="note">Transferida el ${hWhen(r.transferred_at ?? r.decided_at ?? r.requested_at)}${r.transfer_ref ? ` · ref. ${refLink(r.transfer_ref)}` : ''}</p>`
	else act = `<p class="note">Rechazada el ${hWhen(r.decided_at ?? r.requested_at)}: «${escHtml(r.decision_note ?? '')}»</p>`
	return `<div class="rf">${head}${reason}${r.decision_note && r.status !== 'rejected' ? `<p class="note">Tu nota: ${escHtml(r.decision_note)}</p>` : ''}${act}</div>`
}

// La ficha de un cliente: todo lo suyo en una página y lo que se puede hacer con su cuenta
async function clientPage(env: ProEnv, username: string, notice: string, now: number) {
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
			`<a class="crumb" href="/admin/pro?view=cuentas">← Cuentas</a>${pageHead(`@${u}${blockPill}`, 'No tiene cuenta Pro todavía. Puedes darle días: se le activan al conectar su cuenta en el terminal.')}${notice}${panel('Dar o quitar días', daysForm(name))}${panel('Acceso al terminal', accessForm(name, block, now), { sub: ACCESS_HELP })}`,
		)
	const all = <T>(sql: string) => db.prepare(sql).bind(id).all<T>().then((r) => r.results)
	const tg = await db.prepare('SELECT linked_at FROM pro_telegram WHERE license = ?').bind(id).first<{ linked_at: number }>()
	const [refunds, pays, moves, devices, notes, trials] = await Promise.all([
		all<Refund>('SELECT * FROM pro_refunds WHERE license = ? ORDER BY requested_at DESC'),
		all<Checkout & { refunded_at: number | null }>("SELECT * FROM pro_checkouts WHERE license = ? AND status = 'paid' ORDER BY COALESCE(paid_at, created_at) DESC"),
		all<{ kind: string; days: number; expires_after: number; note: string | null; actor: string; created_at: number; checkout: string | null }>('SELECT * FROM pro_days WHERE license = ? ORDER BY created_at DESC, id DESC'),
		all<{ print: string; added_at: number; seen_at: number }>('SELECT print, added_at, seen_at FROM pro_prints WHERE license = ? ORDER BY seen_at DESC'),
		all<{ text: string; created_at: number }>('SELECT text, created_at FROM pro_notes WHERE license = ? ORDER BY created_at DESC'),
		all<{ key: string; created_at: number }>('SELECT key, created_at FROM pro_trials WHERE license = ? ORDER BY created_at'),
	])
	const left = Math.ceil((l.expires_at - now) / DAY_MS)
	const state = l.revoked ? '<span class="pill rejected">Suspendida</span>' : left > 0 ? `<span class="pill approved-ok">Pro · ${left} días</span>` : '<span class="pill">Vencida</span>'
	const paidTotal = pays.filter((p) => !p.refunded_at).reduce((t, p) => t + p.amount, 0)
	const refundedTotal = pays.filter((p) => p.refunded_at).reduce((t, p) => t + p.amount, 0)
	const first = pays.length ? Math.min(...pays.map((p) => p.paid_at ?? p.created_at)) : null
	const inTime = first !== null && now - first < REFUND_DAYS * DAY_MS
	const refundOf = new Map(refunds.map((r) => [r.checkout, r]))
	const back = `<input type="hidden" name="u" value="${u}">`
	const payRows = pays
		.map((p) => {
			const r = refundOf.get(p.id)
			// Una rechazada se puede devolver igual si cambias de idea
			const act = r
				? `<span class="pill ${r.status}">${REFUND_STATUS[r.status]}</span>${r.status === 'rejected' && !p.refunded_at ? ` ${refundButton(p.id, p.amount, p.payer ?? name, back)}` : ''}`
				: refundButton(p.id, p.amount, p.payer ?? name, back)
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
		${pageHead(`@${u} ${state}${blockPill}`, `Cuenta <span class="mono">${escHtml(l.uuid)}</span> · ${tg ? `avisos por Telegram desde el ${hDay(tg.linked_at)}` : 'sin avisos por Telegram'} · días gratis usados: ${trials.map((t) => `${escHtml(t.key.startsWith('print:') ? 'un dispositivo' : t.key)} (${hDay(t.created_at)})`).join(', ') || 'ninguno'}`, suspend)}
		${notice}
		<div class="cards">
			<div class="card"><span>Pro hasta</span><b>${hDay(l.expires_at)}</b><small>${left > 0 ? `${left} días` : 'vencido'} · ${escHtml((l.plan in PLANS ? 'comprados' : (({ trial: 'gratis', gift: 'regalados' } as Record<string, string>)[l.plan] ?? l.plan)))}</small></div>
			<div class="card"><span>Pagado</span><b>${hUsd(paidTotal)}</b><small>${pays.length} pagos${refundedTotal ? ` · devuelto ${hUsd(refundedTotal)}` : ''}</small></div>
			<div class="card"><span>Devolución</span><b>${first === null ? '—' : inTime ? 'En plazo' : 'Fuera'}</b><small>${first === null ? 'sin compras' : `hasta el ${hDay(first + REFUND_DAYS * DAY_MS)}`}</small></div>
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
		${panel('Movimientos de días', table('<th>Cuándo</th><th>Qué</th><th class="num">Días</th><th>Pro hasta</th><th>Motivo</th>', moveRows, 5, 'Sin movimientos.'), { flush: true })}`,
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
const cubaMonth = (ms: number) => new Date(ms).toLocaleString('en-CA', { timeZone: 'America/Havana', year: 'numeric', month: '2-digit' }).slice(0, 7)

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
	days: 'Días', refund: 'Devolución (directa)', 'refund-approve': 'Devolución aprobada', 'refund-reject': 'Devolución rechazada', 'refund-transfer': 'Devolución transferida', note: 'Nota',
	'access-set': 'Restringir o bloquear', 'access-lift': 'Levantar límite', 'incident-resolve': 'Descartar incidencia', revoke: 'Suspender', restore: 'Reactivar', recover: 'Activar pago', check: 'Comprobar factura', reconcile: 'Repasar con QvaPay', 'pro-on': 'Encender Pro', 'pro-off': 'Apagar Pro',
	'orders-pause': 'Pausar ofertas', 'orders-resume': 'Reanudar ofertas', 'alert-test': 'Aviso de prueba', 'daily-on': 'Encender tasa del día', 'daily-off': 'Apagar tasa del día', 'daily-test': 'Probar tasa del día',
}

async function auditPage(env: ProEnv, notice: string, now: number) {
	const { results } = await env.DB.prepare('SELECT * FROM pro_audit ORDER BY at DESC, id DESC LIMIT 300').all<{ at: number; action: string; target: string | null; detail: string | null }>()
	const rows = results
		.map((a) => `<tr><td>${hWhen(a.at)}</td><td><b>${escHtml(AUDIT_NAME[a.action] ?? a.action)}</b></td><td>${a.target ? escHtml(a.target) : '—'}</td><td style="white-space:normal">${escHtml(a.detail ?? '')}</td></tr>`)
		.join('')
	return proPage(
		env,
		'pro-registro',
		'Registro de Pro',
		`${pageHead('Registro', 'Todo lo que se hace en este panel (las últimas 300 acciones). No se puede borrar ni editar.')}${notice}
		${panel('Acciones', `<div class="wrap"><table class="left"><thead><tr><th>Cuándo</th><th>Qué</th><th>Sobre</th><th>Detalle</th></tr></thead><tbody>${rows || '<tr><td colspan="4" class="empty">Todavía no hay acciones.</td></tr>'}</tbody></table></div>`, { flush: true })}`,
	)
}

// Incidencias: quién usa (o intenta usar) Pro sin tenerlo. Desde cada una, restringir o bloquear su terminal (lo de
// «Acceso al terminal») o descartarla si no lo es
async function incidentsPage(env: ProEnv, notice: string, now: number) {
	const list = await openIncidents(env.DB)
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
		${panel('Abiertas', `<div class="wrap"><table class="left"><thead><tr><th>Última vez</th><th>Usuario</th><th>Qué</th><th class="num">Veces</th><th>Primera vez</th><th></th></tr></thead><tbody>${rows || '<tr><td colspan="6" class="empty">Ninguna incidencia abierta.</td></tr>'}</tbody></table></div>`, { flush: true })}`,
	)
}

async function proExport(db: D1, kind: string, now: number) {
	const day = new Date(now).toISOString().slice(0, 10)
	if (kind === 'copia')
		return new Response(JSON.stringify(await proSnapshot(db, now), null, 1), {
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
	if (req.method === 'GET' && exp) return proExport(db, exp, now)
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
				notice = `<p class="ok">Devolución aprobada: se le quitaron los días de esa compra. Ahora transfiere <b>${hUsd(r.amount)}</b> a <b>@${escHtml(r.payee)}</b> desde tu cuenta de QvaPay ${copyBtn(r.payee, 'Copiar usuario')} ${copyBtn(String(r.amount), 'Copiar monto')} y márcala como transferida.</p>`
			}
			if (action === 'refund-approve') {
				const r = await approveRefund(db, String(f.get('id') ?? ''), note, now)
				await tellRefund(env, r, fetcher)
				notice = `<p class="ok">Aprobada: se le quitaron los días de esa compra. Ahora transfiere <b>${hUsd(r.amount)}</b> a <b>@${escHtml(r.payee)}</b> desde tu cuenta de QvaPay ${copyBtn(r.payee, 'Copiar usuario')} ${copyBtn(String(r.amount), 'Copiar monto')} y márcala como transferida.</p>`
			}
			if (action === 'refund-reject') {
				await rejectRefund(db, String(f.get('id') ?? ''), note ?? '', now)
				await tellRefund(env, (await refundRow(db, String(f.get('id') ?? '')))!, fetcher)
				notice = '<p class="ok">Rechazada. El usuario ve el motivo en «Mi cuenta».</p>'
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
				notice = r?.ok ? `<p class="ok">Oferta de prueba en el libro en vivo: vende 20 USD a ${r.price} en CUP Transferencia. No se puede tomar (no existe en QvaPay) y sale sola en menos de un minuto.</p>` : `<p class="note">No se pudo: ${escHtml(r?.error ?? 'el libro en vivo no está disponible')}</p>`
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
				const r = await connectBot(env, url.origin, fetcher)
				notice = r.ok
					? `<p class="ok">El bot ya responde desde ${escHtml(url.host)}: los usuarios pueden conectar sus avisos en «Mi cuenta».</p>`
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
			// Todo lo que sale bien queda en el registro: qué, sobre quién y lo que dijo el panel
			if (action && notice.startsWith('<p class="ok">')) {
				const target = ['username', 'u', 'checkout', 'id', 'invoice', 'uuid', 'license'].map((k) => String(f.get(k) ?? '')).find(Boolean) ?? null
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
	if (client && /^[A-Za-z0-9._-]{1,40}$/.test(client.replace(/^@/, ''))) return clientPage(env, client.replace(/^@/, ''), flash, now)
	if (view === 'informes') return reportsPage(env, flash, now)
	if (view === 'registro') return auditPage(env, flash, now)
	if (view === 'pagos') return paymentsPage(env, flash, now)
	if (view === 'cuentas') return accountsPage(env, flash, now)
	if (view === 'incidencias') return incidentsPage(env, flash, now)
	if (q) return searchPage(env, flash, now, q)
	return homePage(env, flash, now)
}

// Las páginas de Pro llevan en el menú cuántas cosas esperan algo de ti
async function proPage(env: ProEnv, active: AdminTab, title: string, body: string) {
	const incidents = await env.DB.prepare('SELECT COUNT(*) AS n FROM pro_incidents WHERE resolved_at IS NULL').first<{ n: number }>()
	return adminPage(active, title, body, 200, { pro: (await pendingWork(env.DB)).count, 'pro-incidencias': incidents?.n ?? 0 })
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
				(SELECT COALESCE(SUM(amount), 0) FROM pro_checkouts WHERE status = 'paid' AND refunded_at IS NULL AND COALESCE(paid_at, created_at) >= ?2) AS month,
				(SELECT COUNT(*) FROM pro_checkouts WHERE status = 'paid' AND refunded_at IS NULL AND COALESCE(paid_at, created_at) >= ?2) AS monthCount,
				(SELECT COALESCE(SUM(amount), 0) FROM pro_checkouts WHERE status = 'paid' AND refunded_at IS NULL) AS total,
				(SELECT COUNT(*) FROM pro_checkouts WHERE status = 'paid') AS paidCount,
				(SELECT COALESCE(SUM(amount), 0) FROM pro_checkouts WHERE refunded_at IS NOT NULL) AS refunded,
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
			: '<div class="panel-b"><p class="allclear"><i>✓</i>Nada pendiente: ni devoluciones por decidir o transferir, ni pagos sin activar.</p></div>',
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
		<p class="note">Cada día a las 5:00 (hora de Cuba) se repasan los pagos con QvaPay y se guarda una copia de Pro (120 días). La base se puede restaurar a cualquier minuto de los últimos 30 días.</p>
		<p class="note"><a href="/admin/pro?export=pagos">Descargar pagos (CSV)</a> · <a href="/admin/pro?export=copia">Copia completa (JSON)</a></p></div>`
	return proPage(
		env,
		'pro',
		'Pro',
		`${pageHead('Inicio', 'De cada usuario solo se guarda su usuario de QvaPay, hasta cuándo tiene Pro y la huella de sus dispositivos, nunca el token. Quién pagó lo confirma QvaPay.', proSearch())}
		${flash}${cards}${pending}
		<div class="grid2">${panel('Estado', toggles, { flush: true })}${panel('Pagos y copias', upkeep, { foot: `Política: se compran días, nada se cobra solo; devolución completa en los ${REFUND_DAYS} días siguientes a la primera compra. Si Pro falla por nuestra culpa, en vez de devolver se dan los días perdidos.` })}</div>`,
	)
}

// El libro en tiempo real (feed del mercado de QvaPay): si llega, qué tiene y cuántos terminales lo reciben
async function liveForm(env: ProEnv) {
	const live = env as unknown as LiveEnv
	if (!live.LIVE) return ''
	const s = await liveStatus(live)
	if (!s || typeof s.events !== 'number') return '<form class="flag"><b>Libro en tiempo real: sin respuesta</b><span class="note">El objeto del libro no contestó.</span></form>'
	const when = (t: number | null) => (t ? new Date(t).toLocaleString('es', { timeZone: 'America/Havana', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : 'nunca')
	const title = { feed: 'Libro en tiempo real: feed de QvaPay llegando', poll: 'Libro en tiempo real: sin feed, se lee con la app', off: 'Libro en tiempo real: sin feed ni credenciales' }[s.mode]
	const notes = [
		`${s.events.toLocaleString('en-US')} eventos del feed (el último: ${when(s.lastEvent)}).`,
		live.STAGING || !s.stream ? '' : s.stream.on ? `Stream de QvaPay conectado desde ${when(s.stream.since)} (${(s.stream.events ?? 0).toLocaleString('en-US')} eventos por el stream; ${s.stream.connects ?? 0} conexiones desde que arrancó${s.stream.gap != null ? `, el último corte duró ${Math.round(s.stream.gap / 1000)} s` : ''}).` : `Stream de QvaPay desconectado${s.stream.error ? `: ${escHtml(s.stream.error)}` : ''}.`,
		`${s.offers.toLocaleString('en-US')} ofertas en el libro, ${s.owners.toLocaleString('en-US')} anunciantes conocidos y ${(s.acts ?? 0).toLocaleString('en-US')} movimientos de actividad guardados; ${s.clients === 1 ? '1 terminal conectado' : `${s.clients} terminales conectados`} (${s.proClients} con Pro, al instante; el resto, cada 10 s).`,
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

type PayRow = Checkout & { refunded_at: number | null; owner: string | null; first_paid: number | null; rstatus: string | null }
// De dónde se pidió: el simulador (con la cuenta de Telegram) o un dispositivo del terminal (solo su huella)
const origin = (c: PayRow) => (c.tg ? 'Simulador' : `Terminal · ${c.requester ? `@${escHtml(c.requester)}` : proShort(c.print)}`)
const checkouts = (db: D1, where: string, order: string, limit: number, q: string) =>
	db
		.prepare(
			`SELECT c.*, COALESCE(c.payer, l.username) AS payer, l.username AS owner, (SELECT r.status FROM pro_refunds r WHERE r.checkout = c.id) AS rstatus,
				(SELECT MIN(COALESCE(f.paid_at, f.created_at)) FROM pro_checkouts f WHERE f.license = c.license AND f.status = 'paid') AS first_paid
			FROM pro_checkouts c LEFT JOIN pro_licenses l ON l.uuid = c.license
			WHERE ${where} ${q ? 'AND (LOWER(l.username) LIKE ? OR LOWER(c.payer) LIKE ? OR LOWER(c.requester) LIKE ? OR c.id LIKE ? OR c.invoice LIKE ?)' : ''}
			ORDER BY ${order} LIMIT ${limit}`,
		)
		.bind(...(q ? [like(q), like(q), like(q), like(q), like(q)] : []))
		.all<PayRow>()
		.then((r) => r.results)

// Pagos: quién pagó (lo dice QvaPay), desde dónde se pidió y su factura
async function paymentsPanel(env: ProEnv, now: number, q = '') {
	const paid = await checkouts(env.DB, "c.status = 'paid'", 'COALESCE(c.paid_at, c.created_at) DESC', 300, q)
	const rows = paid
		.map((c) => {
			const inTime = c.first_paid !== null && now - c.first_paid < REFUND_DAYS * DAY_MS
			const state = c.rstatus
				? `<span class="pill ${c.rstatus}">${REFUND_STATUS[c.rstatus as RefundStatus]}</span>${c.rstatus === 'rejected' && !c.refunded_at ? ` ${refundButton(c.id, c.amount, c.payer ?? '')}` : ''}`
				: c.refunded_at
					? `<span class="note">devuelto el ${hDay(c.refunded_at)}</span>`
					: `${refundButton(c.id, c.amount, c.payer ?? '')} <span class="note">${inTime ? 'en plazo' : 'fuera de plazo'}</span>`
			return `<tr><td>${hWhen(c.paid_at ?? c.created_at)}</td><td>${c.owner ? userLink(c.owner) : `<b>@${escHtml(c.payer ?? '?')}</b>`}${c.owner && c.owner.toLowerCase() !== (c.payer ?? '').toLowerCase() ? ` <span class="note">pagó @${escHtml(c.payer ?? '?')}</span>` : ''}</td><td>${escHtml(PLANS[c.plan]?.name ?? c.plan)}</td><td class="num">${proUsd(c.amount)}</td><td>${origin(c)}</td><td>${c.invoice ? proShort(c.invoice) : '—'}</td><td>${state}</td></tr>`
		})
		.join('')
	return panel(
		'Pagos',
		`<div class="wrap"><table class="left"><thead><tr><th>Pagado</th><th>Cuenta</th><th>Días</th><th class="num">Importe</th><th>Pedido desde</th><th>Factura</th><th>Devolución</th></tr></thead><tbody>${rows || '<tr><td colspan="7" class="empty">Todavía no hay pagos.</td></tr>'}</tbody></table></div>`,
		{ sub: q ? '' : 'Los últimos 300', flush: true, actions: '<a class="btn" href="/admin/pro?export=pagos">Descargar CSV</a>' },
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
async function accountsPanel(env: ProEnv, now: number, q = '') {
	const { results } = await env.DB
		.prepare(
			`SELECT l.uuid, l.username, l.plan, l.expires_at, l.revoked, l.created_at,
				(SELECT COUNT(*) FROM pro_prints p WHERE p.license = l.uuid) AS devices,
				(SELECT MAX(p.seen_at) FROM pro_prints p WHERE p.license = l.uuid) AS seen,
				(SELECT COUNT(*) FROM pro_checkouts c WHERE c.license = l.uuid AND c.status = 'paid') AS pays,
				(SELECT COALESCE(SUM(c.amount), 0) FROM pro_checkouts c WHERE c.license = l.uuid AND c.status = 'paid' AND c.refunded_at IS NULL) AS paid
			FROM pro_licenses l WHERE l.merged_into IS NULL ${q ? 'AND (LOWER(l.username) LIKE ? OR l.uuid LIKE ?)' : ''} ORDER BY l.revoked, l.expires_at DESC LIMIT 500`,
		)
		.bind(...(q ? [like(q), like(q)] : []))
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
		{ sub: q ? '' : `${results.length} cuentas · haz clic en un usuario para ver su ficha`, flush: true },
	)
}

// Movimientos de días: todo lo que cambió los días de cada cuenta, con el motivo
async function movesPanel(env: ProEnv, q = '') {
	const moves = (
		await env.DB
			.prepare(
				`SELECT d.*, l.username FROM pro_days d JOIN pro_licenses l ON l.uuid = d.license ${q ? 'WHERE LOWER(l.username) LIKE ? OR d.checkout LIKE ?' : ''} ORDER BY d.created_at DESC, d.id DESC LIMIT ${q ? 300 : 100}`,
			)
			.bind(...(q ? [like(q), like(q)] : []))
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
		{ sub: q ? '' : 'Los últimos 100', flush: true },
	)
}

async function paymentsPage(env: ProEnv, flash: string, now: number) {
	return proPage(env, 'pro-pagos', 'Pagos de Pro', `${pageHead('Pagos', 'Quién pagó lo confirma QvaPay. Desde aquí se devuelve una compra: se le quitan sus días y luego haces tú la transferencia.', proSearch())}${flash}${await paymentsPanel(env, now)}${await unpaidPanel(env, now)}`)
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

async function accountsPage(env: ProEnv, flash: string, now: number) {
	return proPage(
		env,
		'pro-cuentas',
		'Cuentas de Pro',
		`${pageHead('Cuentas', 'Una cuenta por usuario de QvaPay, con todos sus dispositivos.', proSearch())}${flash}${await accountsPanel(env, now)}
		${panel('Dar o quitar días', daysForm(), { sub: 'Un regalo, una compensación por un fallo o una corrección. Si aún no ha conectado su cuenta, se le activan al conectarla' })}
		${await blocksPanel(env, now)}
		${await movesPanel(env)}`,
	)
}

async function searchPage(env: ProEnv, flash: string, now: number, q: string) {
	return proPage(
		env,
		'pro',
		`Buscar «${escHtml(q)}»`,
		`${pageHead(`Resultados para «${escHtml(q)}»`, '<a href="/admin/pro">Quitar la búsqueda</a>', proSearch(q))}${flash}${await accountsPanel(env, now, q)}${await paymentsPanel(env, now, q)}${await unpaidPanel(env, now, q)}${await movesPanel(env, q)}`,
	)
}
