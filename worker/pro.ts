// Plan Pro de Terminal P2P (app.terminalp2p.com/pro/*).
//
// Quién es cada usuario lo dice QvaPay con el propio pago: al pagar una factura de nuestra app, la
// API de comerciante devuelve quién la pagó (PaidBy), con su uuid y su usuario verificados. El token
// de QvaPay nunca llega aquí: de cada dispositivo solo vemos una huella (HMAC del token calculado en
// el navegador). Con esa huella se pregunta si eres Pro y se recoge el módulo Pro, firmado para ti.
// Un dispositivo nuevo entra con un código de 6 cifras generado desde otro que ya es Pro, o con el
// código de respaldo (que cambia cada vez que se usa).

import { sha256, sign, verify } from './crypto.ts'
import { adminPage, askKey } from './admin.ts'
import { authorized } from './metrics.ts'
import type { D1 } from './rates.ts'
import { sessionCookie, sessionToken } from './session.ts'

export interface ProEnv {
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
}

export const PLANS = {
	month: { usd: 1.99, days: 30, name: '30 días' },
	year: { usd: 20, days: 365, name: '365 días' },
} as const
export type Plan = keyof typeof PLANS

export const PRO_DEVICES = 2
// Devolución completa en los días siguientes al primer pago (a mano: QvaPay no tiene devoluciones por API)
export const REFUND_DAYS = 7
export const TRIAL_DAYS = 30
const DAY_MS = 86_400_000
const LICENSE_MS = DAY_MS // la licencia firmada vale un día y el terminal la renueva sola
const PAIR_MS = 5 * 60_000
const CHECKOUT_MS = 60 * 60_000
// Con días de Pro (pagados o regalados) solo se compran más cuando quedan pocos; con los días gratis, siempre
export const RENEW_DAYS = 5
// Una factura pendiente se reutiliza si aún le queda margen para pagarla
const REUSE_MS = 45 * 60_000
const PAY_URL = 'https://www.qvapay.com/pay/'
const QVAPAY = 'https://api.qvapay.com'
const PRINT = /^[0-9a-f]{64}$/
// Sin caracteres que se confundan al copiarlos a mano (0/O, 1/I/L)
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'

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
	requester: string | null // la cuenta conectada al terminal que la pidió (la dice el navegador)
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

const random = (n: number, alphabet = ALPHABET) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => alphabet[b % alphabet.length]).join('')
export const newBackupCode = () => `TP-${random(4)}-${random(4)}-${random(4)}`
const normCode = (c: string) => c.toUpperCase().replace(/[^0-9A-Z]/g, '')
const backupHash = (code: string) => sha256(`pro-backup:${normCode(code)}`)

// ── Licencias y dispositivos ─────────────────────────────────────────

export async function licenseOfPrint(db: D1, print: string, now: number): Promise<License | null> {
	const l = await db
		.prepare('SELECT l.uuid, l.username, l.plan, l.expires_at, l.backup_hash, l.revoked FROM pro_prints p JOIN pro_licenses l ON l.uuid = p.license WHERE p.print = ?')
		.bind(print)
		.first<License>()
	return l && !l.revoked && l.expires_at > now ? l : null
}

// Añade un dispositivo a una licencia; si ya tiene PRO_DEVICES, sale el que lleva más tiempo sin usarse
export async function attachPrint(db: D1, license: string, print: string, now: number) {
	await db
		.prepare('INSERT INTO pro_prints (print, license, added_at, seen_at) VALUES (?, ?, ?, ?) ON CONFLICT(print) DO UPDATE SET license = excluded.license, seen_at = excluded.seen_at')
		.bind(print, license, now, now)
		.run()
	await db
		.prepare('DELETE FROM pro_prints WHERE license = ? AND print NOT IN (SELECT print FROM pro_prints WHERE license = ? ORDER BY seen_at DESC, rowid DESC LIMIT ?)')
		.bind(license, license, PRO_DEVICES)
		.run()
}

async function newBackup(db: D1, license: string, now: number) {
	const code = newBackupCode()
	await db.prepare('UPDATE pro_licenses SET backup_hash = ?, updated_at = ? WHERE uuid = ?').bind(await backupHash(code), now, license).run()
	return code
}

// Lo que el terminal necesita saber: si eres Pro, hasta cuándo y la licencia firmada para recoger el módulo
export async function statusOf(env: ProEnv, l: License | null, now: number) {
	if (!l) return { pro: false }
	const license = await sign({ u: l.uuid, n: l.username, e: l.expires_at, x: now + LICENSE_MS }, env.PRO_KEY!)
	return { pro: true, username: l.username, plan: l.plan, expiresAt: l.expires_at, license }
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
	if (Number(t.amount) + 1e-6 < c.amount) return false
	const db = env.DB
	// Pro queda a nombre de la cuenta conectada al terminal aunque pague otra (p. ej. con otra sesión abierta
	// en qvapay.com). Desde el simulador no hay cuenta de QvaPay conectada: a nombre de quien paga
	const owner = c.requester ?? payer.username
	const key = `qp:${owner.toLowerCase()}`
	const marked = await db
		.prepare("UPDATE pro_checkouts SET status = 'paid', license = ?, paid_at = ?, payer = ?, payer_uuid = ? WHERE id = ? AND status = 'pending'")
		.bind(key, now, payer.username, payer.uuid, c.id)
		.run()
	if (!marked.meta?.changes) return true
	const plan = PLANS[c.plan]
	const old = await db.prepare('SELECT uuid, expires_at, backup_hash, revoked FROM pro_licenses WHERE uuid = ?').bind(key).first<License>()
	// Lo que le quedaba a quien la pidió (sus días gratis, un regalo u otra licencia) se suma
	const mine = c.print ? await licenseOfPrint(db, c.print, now) : null
	const left = mine && mine.uuid !== key ? mine.expires_at : 0
	// Renovar suma el periodo a lo que quedaba (lo devuelto no cuenta)
	const expires = Math.max(now, old && !old.revoked ? old.expires_at : 0, left) + plan.days * DAY_MS
	if (old) await db.prepare('UPDATE pro_licenses SET username = ?, plan = ?, expires_at = ?, revoked = 0, updated_at = ? WHERE uuid = ?').bind(owner, c.plan, expires, now, key).run()
	else
		await db
			.prepare('INSERT INTO pro_licenses (uuid, username, plan, expires_at, backup_hash, revoked, created_at, updated_at) VALUES (?, ?, ?, ?, NULL, 0, ?, ?)')
			.bind(key, owner, c.plan, expires, now, now)
			.run()
	// El código de respaldo se crea al comprar por primera vez; el navegador que pagó lo recoge una vez
	if (!old?.backup_hash) {
		const code = await newBackup(db, key, now)
		await db.prepare('UPDATE pro_checkouts SET backup_code = ? WHERE id = ?').bind(code, c.id).run()
	}
	if (c.print) await attachPrint(db, key, c.print, now)
	return true
}

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
			if (c) {
				if (await settle(env, c, now, fetcher)) out.activated.push(c.id)
				continue
			}
			const d = await qvapay<{ transaction?: Transaction }>(env, `/v2/transactions/${encodeURIComponent(t.uuid)}`, {}, fetcher)
			out.unknown.push({ invoice: t.uuid, remoteId: t.remote_id, amount: Number(t.amount), payer: d.transaction?.PaidBy?.username ?? null, paidAt: t.created_at ?? null })
		}
		if (transactions.length < 100) break
	}
	return out
}

// Una factura pagada que aquí no consta: se recrea con lo que dice QvaPay (los días según el importe) y se
// activa para quien pagó
export async function recover(env: ProEnv, invoice: string, now: number, fetcher: typeof fetch = fetch) {
	const { transaction: t } = await qvapay<{ transaction?: Transaction }>(env, `/v2/transactions/${encodeURIComponent(invoice)}`, {}, fetcher)
	if (t?.status !== 'paid' || !t.remote_id?.startsWith('pro-') || !t.PaidBy?.username) throw new ProError(400, 'QvaPay no la da por pagada')
	const plan = (Object.keys(PLANS) as Plan[]).find((p) => Math.abs(PLANS[p].usd - Number(t.amount)) < 0.005)
	if (!plan) throw new ProError(400, `Importe sin días asociados: ${t.amount} USD`)
	await env.DB.prepare("INSERT OR IGNORE INTO pro_checkouts (id, print, tg, plan, amount, invoice, status, created_at) VALUES (?, '', NULL, ?, ?, ?, 'pending', ?)")
		.bind(t.remote_id, plan, PLANS[plan].usd, invoice, Date.parse(t.created_at ?? '') || now)
		.run()
	const c = (await env.DB.prepare('SELECT * FROM pro_checkouts WHERE id = ?').bind(t.remote_id).first<Checkout>())!
	await settle(env, c, now, fetcher)
	return { username: t.PaidBy.username, plan }
}

// Todas las tablas de Pro (sin los códigos de respaldo por recoger, que se ven una sola vez)
export async function proSnapshot(db: D1, now: number) {
	const all = async (t: string) => (await db.prepare(`SELECT * FROM ${t}`).all<Record<string, unknown>>()).results
	const checkouts = (await all('pro_checkouts')).map(({ backup_code: _, ...c }) => c)
	return { at: new Date(now).toISOString(), licenses: await all('pro_licenses'), prints: await all('pro_prints'), checkouts, trials: await all('pro_trials') }
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


// Los 30 días gratis de quien conecta su cuenta por primera vez (false si ese usuario o ese dispositivo ya los usó)
async function freeDays(db: D1, username: string, print: string, now: number) {
	const license = `trial:qp:${username.toLowerCase()}`
	try {
		await startTrial(db, license, username, [`qp:${username.toLowerCase()}`, `print:${print}`], now)
	} catch (err) {
		if (err instanceof ProError) return false
		throw err
	}
	await attachPrint(db, license, print, now)
	return true
}

// Los 30 días gratis. Las llaves dicen quién ya los usó (una sola vez cada una); si alguna ya se usó, no hay otro
export async function startTrial(db: D1, license: string, username: string, keys: string[], now: number) {
	for (const k of keys) if (await db.prepare('SELECT 1 FROM pro_trials WHERE key = ?').bind(k).first()) throw new ProError(409, 'Ya usaste tus 30 días gratis')
	if (await activeLicense(db, license, now)) throw new ProError(409, 'Ya tienes tus días gratis activos')
	await db
		.prepare("INSERT INTO pro_licenses (uuid, username, plan, expires_at, revoked, created_at, updated_at) VALUES (?, ?, 'trial', ?, 0, ?, ?) ON CONFLICT(uuid) DO UPDATE SET plan = 'trial', expires_at = excluded.expires_at, updated_at = excluded.updated_at")
		.bind(license, username, now + TRIAL_DAYS * DAY_MS, now, now)
		.run()
	for (const k of keys) await db.prepare('INSERT OR IGNORE INTO pro_trials (key, license, created_at) VALUES (?, ?, ?)').bind(k, license, now).run()
}

// Factura para comprar días de Pro desde el terminal (con la huella del dispositivo)
export async function createCheckout(env: ProEnv, who: { print: string; username?: string }, plan: Plan, origin: string, now: number, fetcher: typeof fetch = fetch) {
	if (!(plan in PLANS)) throw new ProError(400, 'Plan no válido')
	const db = env.DB
	const l = await licenseOfPrint(db, who.print, now)
	if (l && l.plan !== 'trial' && l.expires_at - now > RENEW_DAYS * DAY_MS) throw new ProError(409, `Aún te quedan días de Pro. Podrás añadir más cuando te queden ${RENEW_DAYS} o menos.`)
	// Si ya tiene una factura pendiente del mismo plan, la misma: así no se pagan dos por error
	const open = await db
		.prepare("SELECT id, invoice FROM pro_checkouts WHERE status = 'pending' AND created_at > ? AND plan = ? AND print = ? AND invoice IS NOT NULL ORDER BY created_at DESC LIMIT 1")
		.bind(now - REUSE_MS, plan, who.print)
		.first<{ id: string; invoice: string }>()
	if (open) return { id: open.id, url: `${PAY_URL}${open.invoice}` }
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
		.bind(id, who.print, null, plan, p.usd, inv.transaction_uuid, now, who.username ?? null)
		.run()
	return { id, url: inv.url }
}

// Cómo va una factura (y se comprueba con QvaPay si sigue pendiente). El código de respaldo nuevo se
// entrega una sola vez, a quien la pidió
// Solo responde al dispositivo que pidió la factura: la respuesta lleva
// el código de respaldo y el identificador de la factura lo ve también quien la paga
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
	if (fresh.backup_code) await db.prepare('UPDATE pro_checkouts SET backup_code = NULL WHERE id = ?').bind(fresh.id).run()
	const l = await licenseOfPrint(db, fresh.print, now)
	return { checkout: fresh, body: { status: 'paid', backupCode: fresh.backup_code ?? null, ...(await statusOf(env, l, now)) } }
}

// Un código para entrar en Pro: el de 6 cifras (desde un dispositivo Pro, un uso, 5 min) o el de
// respaldo (que cambia cada vez que se usa). Devuelve la licencia y, si se usó el de respaldo, el nuevo
export async function claimCode(db: D1, raw: string, now: number): Promise<{ license: string; backupCode: string | null } | null> {
	const code = raw.trim()
	if (/^\d{3}[\s-]?\d{3}$/.test(code)) {
		const pairing = code.replace(/\D/g, '')
		const row = await db.prepare('SELECT license FROM pro_pairings WHERE code = ? AND expires_at > ?').bind(pairing, now).first<{ license: string }>()
		if (!row) return null
		await db.prepare('DELETE FROM pro_pairings WHERE code = ?').bind(pairing).run()
		return { license: row.license, backupCode: null }
	}
	if (normCode(code).length < 14) return null
	const row = await db.prepare('SELECT uuid FROM pro_licenses WHERE backup_hash = ? AND revoked = 0').bind(await backupHash(code)).first<{ uuid: string }>()
	if (!row) return null
	return { license: row.uuid, backupCode: await newBackup(db, row.uuid, now) }
}

// ── Rutas ────────────────────────────────────────────────────────────

const readBody = async (req: Request) => (await req.json().catch(() => ({}))) as Record<string, unknown>
// El usuario de QvaPay conectado al terminal (lo dice el navegador; el servidor no puede comprobarlo)
const usernameOf = (v: unknown) => {
	const u = String(v ?? '').replace(/^@/, '').trim()
	return /^[A-Za-z0-9._-]{1,40}$/.test(u) ? u : undefined
}
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
		// ¿Este dispositivo es Pro?
		if (route === 'POST /pro/status') {
			const b = await readBody(req)
			const print = printOf(b.print)
			await settlePending(env, now, { print }, fetcher)
			let l = await licenseOfPrint(db, print, now)
			// Todos empiezan con 30 días gratis: se activan solos al conectar la cuenta, una vez por usuario de
			// QvaPay y por dispositivo
			const username = usernameOf(b.username)
			const started = !l && !!username && (await freeDays(db, username, print, now))
			if (started) l = await licenseOfPrint(db, print, now)
			if (l) await db.prepare('UPDATE pro_prints SET seen_at = ? WHERE print = ?').bind(now, print).run()
			// La sesión compartida con el simulador: con ella entra sin otro login y hereda tus días de Pro
			const res = json(200, { ...(await statusOf(env, l, now)), started })
			res.headers.set('Set-Cookie', sessionCookie(url, await sessionToken(print, env.PRO_KEY, now)))
			return res
		}

		// Desconectaste tu cuenta en el terminal: el simulador también sale
		if (route === 'POST /pro/leave') {
			const res = json(200, { ok: true })
			res.headers.set('Set-Cookie', sessionCookie(url, '', 0))
			return res
		}

		// Comprar o renovar: factura de QvaPay para este dispositivo
		if (route === 'POST /pro/checkout') {
			const b = await readBody(req)
			return json(200, await createCheckout(env, { print: printOf(b.print), username: usernameOf(b.username) }, String(b.plan) as Plan, url.origin, now, fetcher))
		}

		// El navegador que pagó pregunta cómo va su factura
		if (route === 'POST /pro/checkout/status') {
			const b = await readBody(req)
			return json(200, (await checkoutStatus(env, String(b.id ?? ''), { print: printOf(b.print) }, now, fetcher)).body)
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
			const l = await licenseOfPrint(db, from, now)
			if (!l) return json(200, await statusOf(env, await licenseOfPrint(db, to, now), now))
			const owner = await db.prepare('SELECT license FROM pro_prints WHERE print = ?').bind(to).first<{ license: string }>()
			if (owner && owner.license !== l.uuid) return json(409, { error: 'Ese dispositivo ya pertenece a otra licencia' })
			await db.prepare('DELETE FROM pro_prints WHERE print = ?').bind(from).run()
			await attachPrint(db, l.uuid, to, now)
			return json(200, await statusOf(env, l, now))
		}

		// Desde un dispositivo Pro: código de 6 cifras para añadir otro (un solo uso, 5 minutos)
		if (route === 'POST /pro/pair') {
			const l = await licenseOfPrint(db, printOf((await readBody(req)).print), now)
			if (!l) return json(403, { error: 'Este dispositivo no es Pro' })
			await db.prepare('DELETE FROM pro_pairings WHERE expires_at < ?').bind(now).run()
			let code = ''
			for (let i = 0; i < 5 && !code; i++) {
				const c = random(6, '0123456789')
				const r = await db.prepare('INSERT OR IGNORE INTO pro_pairings (code, license, expires_at) VALUES (?, ?, ?)').bind(c, l.uuid, now + PAIR_MS).run()
				if (r.meta?.changes) code = c
			}
			if (!code) throw new ProError(503, 'Inténtalo de nuevo')
			return json(200, { code, expiresAt: now + PAIR_MS })
		}

		// Un dispositivo nuevo entra con el código de 6 cifras o con el de respaldo
		if (route === 'POST /pro/claim') {
			const b = await readBody(req)
			const print = printOf(b.print)
			const got = await claimCode(db, String(b.code ?? ''), now)
			if (!got) return json(400, { error: 'Código no válido o caducado' })
			await attachPrint(db, got.license, print, now)
			return json(200, { backupCode: got.backupCode, ...(await statusOf(env, await licenseOfPrint(db, print, now), now)) })
		}

		// Desde un dispositivo Pro: un código de respaldo nuevo (el anterior deja de valer)
		if (route === 'POST /pro/backup') {
			const l = await licenseOfPrint(db, printOf((await readBody(req)).print), now)
			if (!l) return json(403, { error: 'Este dispositivo no es Pro' })
			return json(200, { backupCode: await newBackup(db, l.uuid, now) })
		}

		// El módulo Pro, firmado con el usuario de la licencia (si aparece una copia, se sabe de quién salió)
		if (route === 'GET /pro/module.js') {
			const lic = await verify<{ u: string; n: string; e: number; x: number }>(String(url.searchParams.get('l') ?? ''), env.PRO_KEY)
			if (!lic || lic.x < now || lic.e < now) return json(403, { error: 'Licencia no válida' })
			const l = await db.prepare('SELECT revoked FROM pro_licenses WHERE uuid = ?').bind(lic.u).first<{ revoked: number }>()
			if (!l || l.revoked) return json(403, { error: 'Licencia revocada' })
			const code = await env.PRO?.get('module.js')
			if (!code) return json(404, { error: 'El módulo Pro aún no está publicado' })
			const mark = `/* Terminal P2P Pro · licencia de @${lic.n} (${lic.u}) · uso personal, no lo compartas */\nwindow.TPProUser=${JSON.stringify(lic.n)};\n`
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

// Pagos en CSV (uno por fila, con quién pagó y su identificador en QvaPay) o copia completa de Pro en JSON
async function proExport(db: D1, kind: string, now: number) {
	const day = new Date(now).toISOString().slice(0, 10)
	if (kind === 'copia')
		return new Response(JSON.stringify(await proSnapshot(db, now), null, 1), {
			headers: { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': `attachment; filename="terminalp2p-pro-${day}.json"`, 'Cache-Control': 'no-store' },
		})
	const { results } = await db
		.prepare(
			`SELECT c.id, c.invoice, c.plan, c.amount, c.created_at, c.paid_at, c.refunded_at, COALESCE(c.payer, l.username) AS payer, c.payer_uuid, l.username AS owner, c.requester
			FROM pro_checkouts c LEFT JOIN pro_licenses l ON l.uuid = c.license WHERE c.status = 'paid' ORDER BY COALESCE(c.paid_at, c.created_at)`,
		)
		.all<{ id: string; invoice: string | null; plan: Plan; amount: number; created_at: number; paid_at: number | null; refunded_at: number | null; payer: string | null; payer_uuid: string | null; owner: string | null; requester: string | null }>()
	const cell = (v: unknown) => {
		const t = v == null ? '' : String(v)
		return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t
	}
	const iso = (ms: number | null) => (ms ? new Date(ms).toISOString() : '')
	const rows = [
		['pagado', 'pago', 'pago_uuid', 'para', 'dias', 'importe_usd', 'factura_qvapay', 'id', 'devuelto'],
		...results.map((r) => [iso(r.paid_at ?? r.created_at), r.payer, r.payer_uuid, r.owner ?? r.requester, PLANS[r.plan]?.days ?? r.plan, r.amount, r.invoice, r.id, iso(r.refunded_at)]),
	]
	return new Response(rows.map((r) => r.map(cell).join(',')).join('\n') + '\n', {
		headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="terminalp2p-pagos-${day}.csv"`, 'Cache-Control': 'no-store' },
	})
}

export async function proAdmin(req: Request, env: ProEnv, now = Date.now(), fetcher: typeof fetch = fetch): Promise<Response> {
	if (!(await authorized(req, env.METRICS_KEY))) return askKey()
	const db = env.DB
	// Descargas: los pagos en CSV (para devolver o cuadrar cuentas fuera de aquí) y la copia de todo Pro
	const exp = new URL(req.url).searchParams.get('export')
	if (req.method === 'GET' && exp) return proExport(db, exp, now)
	let notice = ''
	if (req.method === 'POST') {
		const f = await req.formData()
		const action = String(f.get('action') ?? '')
		const uuid = String(f.get('uuid') ?? '')
		// Regalo: una licencia sin pago, que la persona activa en su dispositivo con el código que se muestra
		if (action === 'gift') {
			const username = String(f.get('username') ?? '').replace(/^@/, '').trim()
			const days = Math.min(3650, Math.max(1, Number(f.get('days')) || 30))
			if (!/^[A-Za-z0-9._-]{1,40}$/.test(username)) notice = '<p class="note">Usuario no válido.</p>'
			else {
				const id = `gift:${username.toLowerCase()}`
				const old = await db.prepare('SELECT expires_at FROM pro_licenses WHERE uuid = ?').bind(id).first<{ expires_at: number }>()
				const expires = Math.max(now, old?.expires_at ?? 0) + days * DAY_MS
				await db
					.prepare("INSERT INTO pro_licenses (uuid, username, plan, expires_at, revoked, created_at, updated_at) VALUES (?, ?, 'gift', ?, 0, ?, ?) ON CONFLICT(uuid) DO UPDATE SET expires_at = excluded.expires_at, revoked = 0, updated_at = excluded.updated_at")
					.bind(id, username, expires, now, now)
					.run()
				const code = await newBackup(db, id, now)
				notice = `<p>Licencia para <b>@${escHtml(username)}</b> hasta ${new Date(expires).toLocaleDateString('es')}. Pásale este código para que lo pegue en «Ya tengo Pro en otro dispositivo»:</p><p class="code">${code}</p>`
			}
		}
		// Devolver un pago: se revoca la licencia (también en el simulador) y se apunta; el dinero se
		// transfiere a mano desde QvaPay a quien pagó
		if (action === 'refund') {
			const id = String(f.get('checkout') ?? '')
			// El dinero vuelve a quien pagó (según QvaPay), aunque la licencia esté a nombre de otra cuenta
			const c = await db
				.prepare("SELECT c.id, c.amount, c.license, COALESCE(c.payer, l.username) AS username FROM pro_checkouts c JOIN pro_licenses l ON l.uuid = c.license WHERE c.id = ? AND c.status = 'paid' AND c.refunded_at IS NULL")
				.bind(id)
				.first<{ id: string; amount: number; license: string; username: string }>()
			if (!c) notice = '<p class="note">Ese pago no existe o ya se devolvió.</p>'
			else {
				await db.prepare('UPDATE pro_checkouts SET refunded_at = ? WHERE id = ?').bind(now, c.id).run()
				await db.prepare('UPDATE pro_licenses SET revoked = 1, updated_at = ? WHERE uuid = ?').bind(now, c.license).run()
				await db.prepare('DELETE FROM pro_prints WHERE license = ?').bind(c.license).run()
				
				notice = `<p class="ok">Licencia revocada. Ahora transfiere <b>${c.amount.toLocaleString('es')} USD</b> a <b>@${escHtml(c.username)}</b> desde tu cuenta de QvaPay.</p>`
			}
		}
		// Repasar con QvaPay las facturas recientes: activa las pagadas que se quedaron sin activar y enseña las
		// pagadas que aquí no constan
		if (action === 'reconcile')
			try {
				const r = await reconcile(env, now, fetcher)
				notice = `<p class="ok">Repasadas con QvaPay ${r.checked} facturas pagadas. ${r.activated.length ? `Activadas ahora: ${r.activated.length}.` : 'Todas estaban activadas.'}</p>${
					r.unknown.length
						? `<p class="note">Pagadas en QvaPay que aquí no constan:</p>${r.unknown
								.map(
									(u) =>
										`<form method="post" class="row"><input type="hidden" name="invoice" value="${escHtml(u.invoice)}"><span>${u.paidAt ? escHtml(u.paidAt.slice(0, 16).replace('T', ' ')) : ''} · @${escHtml(u.payer ?? '?')} · ${u.amount} USD · ${escHtml(u.invoice)}</span><button class="ghost" name="action" value="recover">Activar para @${escHtml(u.payer ?? '?')}</button></form>`,
								)
								.join('')}`
						: ''
				}`
			} catch (err) {
				notice = `<p class="note">No se pudo repasar con QvaPay: ${escHtml((err as Error).message)}</p>`
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
		// Revocar suspende la licencia sin soltar sus dispositivos: al restaurarla, siguen siendo Pro
		if (action === 'revoke' || action === 'restore') {
			await db.prepare('UPDATE pro_licenses SET revoked = ?, updated_at = ? WHERE uuid = ?').bind(action === 'revoke' ? 1 : 0, now, uuid).run()
			notice = `<p class="ok">${action === 'revoke' ? 'Licencia revocada: sus dispositivos dejan de ser Pro' : 'Licencia restaurada: sus dispositivos vuelven a ser Pro'}.</p>`
		}
	}
	const url = new URL(req.url)
	const q = (url.searchParams.get('q') ?? '').replace(/^@/, '').trim().toLowerCase()
	const like = `%${q}%`

	// Resumen
	const monthStart = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), 1)
	const sum = await db
		.prepare(
			`SELECT
				(SELECT COUNT(*) FROM pro_licenses WHERE revoked = 0 AND expires_at > ?1 AND plan IN ('month', 'year')) AS paying,
				(SELECT COUNT(*) FROM pro_licenses WHERE revoked = 0 AND expires_at > ?1 AND plan = 'trial') AS trials,
				(SELECT COUNT(*) FROM pro_licenses WHERE revoked = 0 AND expires_at > ?1 AND plan = 'gift') AS gifts,
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
	const usd = (n: number) => `${(Math.round(n * 100) / 100).toLocaleString('es')} USD`
	const card = (label: string, value: string, small = '') => `<div class="card"><span>${label}</span><b>${value}</b>${small ? `<small>${small}</small>` : ''}</div>`
	const cards = `<div class="cards">
		${card('Pro con días pagados', String(sum?.paying ?? 0), `${sum?.trials ?? 0} con días gratis · ${sum?.gifts ?? 0} regalados`)}
		${card('Ingresos este mes', usd(sum?.month ?? 0), `${sum?.monthCount ?? 0} pagos`)}
		${card('Ingresos totales', usd(sum?.total ?? 0), `${sum?.paidCount ?? 0} pagos · devuelto ${usd(sum?.refunded ?? 0)}`)}
		${card('Facturas sin pagar', String(sum?.unpaid ?? 0), 'pedidas en las últimas 24 h')}
		${card('Días gratis dados', String(sum?.trialKeys ?? 0), 'usuarios y dispositivos que ya los usaron')}
	</div>`

	// Hora de Cuba, como el resto del proyecto
	const when = (ms: number) => new Date(ms).toLocaleString('es', { timeZone: 'America/Havana', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
	const day = (ms: number) => new Date(ms).toLocaleDateString('es', { timeZone: 'America/Havana', day: 'numeric', month: 'short', year: 'numeric' })
	const short = (s: string) => `<span title="${escHtml(s)}">${escHtml(s.slice(0, 8))}…</span>`
	type Row = Checkout & { refunded_at: number | null; owner: string | null; first_paid: number | null }
	// De dónde se pidió: el simulador (con la cuenta de Telegram) o un dispositivo del terminal (solo su huella)
	const origin = (c: Row) =>
		c.tg ? 'Simulador' : `Terminal · ${c.requester ? `@${escHtml(c.requester)}` : short(c.print)}`
	const checkouts = (where: string, order: string, limit: number) =>
		db
			.prepare(
				`SELECT c.*, COALESCE(c.payer, l.username) AS payer, l.username AS owner,
					(SELECT MIN(COALESCE(f.paid_at, f.created_at)) FROM pro_checkouts f WHERE f.license = c.license AND f.status = 'paid') AS first_paid
				FROM pro_checkouts c LEFT JOIN pro_licenses l ON l.uuid = c.license
				WHERE ${where} ${q ? 'AND (LOWER(l.username) LIKE ? OR LOWER(c.payer) LIKE ? OR LOWER(c.requester) LIKE ? OR c.id LIKE ? OR c.invoice LIKE ?)' : ''}
				ORDER BY ${order} LIMIT ${limit}`,
			)
			.bind(...(q ? [like, like, like, like, like] : []))
			.all<Row>()

	// Pagos: quién pagó (lo dice QvaPay), desde dónde se pidió y su factura
	const paid = (await checkouts("c.status = 'paid'", 'COALESCE(c.paid_at, c.created_at) DESC', 300)).results
	const payRows = paid
		.map((c) => {
			const at = c.paid_at ?? c.created_at
			const inTime = c.first_paid !== null && now - c.first_paid < REFUND_DAYS * DAY_MS
			const state = c.refunded_at
				? `<span class="note">devuelto el ${day(c.refunded_at)}</span>`
				: `<form method="post" style="display:inline" onsubmit="return confirm('¿Devolver ${c.amount} USD a @${escHtml(c.payer ?? '')}? Se revoca su licencia y luego haces tú la transferencia en QvaPay.')"><input type="hidden" name="checkout" value="${escHtml(c.id)}"><button class="ghost" name="action" value="refund">Devolver</button></form>${inTime ? ' <span class="note">en plazo</span>' : ' <span class="note">fuera de plazo</span>'}`
			return `<tr><td>${when(at)}</td><td><b>@${escHtml(c.payer ?? '?')}</b>${c.owner && c.owner.toLowerCase() !== (c.payer ?? '').toLowerCase() ? ` <span class="note">para @${escHtml(c.owner)}</span>` : ''}</td><td>${escHtml(PLANS[c.plan]?.name ?? c.plan)}</td><td>${usd(c.amount)}</td><td>${origin(c)}</td><td>${c.invoice ? short(c.invoice) : '—'}</td><td>${state}</td></tr>`
		})
		.join('')

	// Facturas sin pagar de la última semana: si alguien dice que pagó y no se activó, se comprueba aquí
	const pending = (await checkouts(`c.status = 'pending' AND c.created_at > ${now - 7 * DAY_MS}`, 'c.created_at DESC', 100)).results
	const pendingRows = pending
		.map(
			(c) =>
				`<tr><td>${when(c.created_at)}</td><td>${escHtml(PLANS[c.plan]?.name ?? c.plan)}</td><td>${usd(c.amount)}</td><td>${origin(c)}</td><td>${c.invoice ? short(c.invoice) : '—'}</td><td>${now - c.created_at < CHECKOUT_MS ? 'esperando el pago' : '<span class="note">caducada</span>'}</td>
				<td><form method="post"><input type="hidden" name="checkout" value="${escHtml(c.id)}"><button class="ghost" name="action" value="check" title="Preguntar a QvaPay si ya se pagó">Comprobar</button></form></td></tr>`,
		)
		.join('')

	// Licencias: plan, vencimiento, dispositivos, cuentas del simulador y lo pagado
	const { results } = await db
		.prepare(
			`SELECT l.uuid, l.username, l.plan, l.expires_at, l.revoked, l.created_at,
				(SELECT COUNT(*) FROM pro_prints p WHERE p.license = l.uuid) AS devices,
				(SELECT MAX(p.seen_at) FROM pro_prints p WHERE p.license = l.uuid) AS seen,
				
				(SELECT COUNT(*) FROM pro_checkouts c WHERE c.license = l.uuid AND c.status = 'paid') AS pays,
				(SELECT COALESCE(SUM(c.amount), 0) FROM pro_checkouts c WHERE c.license = l.uuid AND c.status = 'paid' AND c.refunded_at IS NULL) AS paid
			FROM pro_licenses l ${q ? 'WHERE LOWER(l.username) LIKE ? OR l.uuid LIKE ?' : ''} ORDER BY l.revoked, l.expires_at DESC LIMIT 500`,
		)
		.bind(...(q ? [like, like] : []))
		.all<License & { created_at: number; devices: number; seen: number | null; pays: number; paid: number }>()
	const planName = (p: string) => ({ month: '30 días', year: '365 días', trial: '30 días gratis', gift: 'regalo' })[p] ?? p
	const rows = results
		.map((l) => {
			const left = Math.ceil((l.expires_at - now) / DAY_MS)
			const state = l.revoked ? ' <span class="note">(revocada)</span>' : left <= 0 ? ' <span class="note">(vencida)</span>' : ` <span class="note">(${left} días)</span>`
			
			const who = `<b>@${escHtml(l.username)}</b>`
			return `<tr><td>${who}</td><td>${planName(l.plan)}</td><td>${day(l.created_at)}</td><td>${day(l.expires_at)}${state}</td><td>${l.devices}${l.seen ? ` <span class="note">· usado ${day(l.seen)}</span>` : ''}</td><td>${!l.pays ? '<span class="note">sin pagos</span>' : l.paid ? `${l.pays} · ${usd(l.paid)}` : '<span class="note">devuelto</span>'}</td>
			<td><form method="post"><input type="hidden" name="uuid" value="${escHtml(l.uuid)}"><button class="ghost" name="action" value="${l.revoked ? 'restore' : 'revoke'}">${l.revoked ? 'Restaurar' : 'Revocar'}</button></form></td></tr>`
		})
		.join('')
	return adminPage(
		'pro',
		'Pro',
		`<div class="top"><h1>Pro</h1><form method="get" class="row"><input name="q" value="${escHtml(q)}" placeholder="Buscar usuario o factura"><button>Buscar</button>${q ? ' <a href="/admin/pro" class="note">quitar filtro</a>' : ''}</form></div>
		<p class="note">De cada usuario solo se guarda su usuario de QvaPay, hasta cuándo tiene Pro y la huella de sus dispositivos, nunca el token. Quién pagó lo confirma QvaPay. Horas de Cuba.</p>${notice}${cards}
		<div class="top" style="margin-top:16px"><form method="post" class="row"><button class="ghost" name="action" value="reconcile" title="Activa las pagadas que se quedaron sin activar y enseña las que aquí no constan">Repasar pagos con QvaPay</button></form>
		<span class="row"><a class="note" href="/admin/pro?export=pagos">Descargar pagos (CSV)</a> · <a class="note" href="/admin/pro?export=copia">Copia completa (JSON)</a></span></div>
		<p class="note">Cada día a las 5:00 (hora de Cuba) se repasan los pagos con QvaPay y se guarda una copia de Pro (120 días). La base se puede restaurar a cualquier minuto de los últimos 30 días.</p>
		<h2>Pagos</h2><div class="wrap"><table class="left"><tr><th>Pagado</th><th>Pagó</th><th>Días</th><th>Importe</th><th>Pedido desde</th><th>Factura</th><th>Devolución</th></tr>${payRows || '<tr><td colspan="7" class="empty">Todavía no hay pagos.</td></tr>'}</table></div>
		<h2>Facturas sin pagar <span class="note">(última semana)</span></h2><div class="wrap"><table class="left"><tr><th>Pedida</th><th>Días</th><th>Importe</th><th>Pedido desde</th><th>Factura</th><th>Estado</th><th></th></tr>${pendingRows || '<tr><td colspan="7" class="empty">Ninguna.</td></tr>'}</table></div>
		<h2>Licencias</h2><div class="wrap"><table class="left"><tr><th>Usuario</th><th>Últimos días</th><th>Desde</th><th>Hasta</th><th>Dispositivos</th><th>Pagado</th><th></th></tr>${rows || '<tr><td colspan="7" class="empty">Todavía no hay usuarios Pro.</td></tr>'}</table></div>
		<h2>Regalar una licencia</h2><form method="post" class="row"><input type="hidden" name="action" value="gift"><input name="username" placeholder="usuario de QvaPay" required><input name="days" type="number" value="30" min="1" style="width:90px"> días <button>Crear</button></form>
		<p class="note">Política: se compran días, nada se cobra solo; devolución completa en los ${REFUND_DAYS} días siguientes a la primera compra. Si Pro falla por nuestra culpa, en vez de devolver se regalan los días perdidos (Regalar una licencia).</p>`,
	)
}
