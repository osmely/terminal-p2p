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

export interface ProEnv {
	DB: D1
	// App de comerciante de QvaPay: facturas y quién pagó. Sin ellas no se puede comprar
	QVAPAY_APP_ID?: string
	QVAPAY_APP_SECRET?: string
	// Clave con la que se firman las licencias de 24 h (secreto). Sin ella Pro no funciona
	PRO_KEY?: string
	// Almacén privado con el módulo Pro (module.js), que no está en el repositorio público
	PRO?: { get(key: string): Promise<string | null> }
	// Clave del panel (la misma de las métricas)
	METRICS_KEY?: string
}

export const PLANS = {
	month: { usd: 1.99, days: 30, name: 'mensual' },
	year: { usd: 20, days: 365, name: 'anual' },
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
	tg: number | null // cuenta del simulador que la pidió
	plan: Plan
	amount: number
	invoice: string | null
	status: 'pending' | 'paid'
	license: string | null
	backup_code: string | null
	created_at: number
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
	status?: string
	amount?: number | string
	remote_id?: string
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
	const marked = await db.prepare("UPDATE pro_checkouts SET status = 'paid', license = ? WHERE id = ? AND status = 'pending'").bind(payer.uuid, c.id).run()
	if (!marked.meta?.changes) return true
	const plan = PLANS[c.plan]
	const old = await db.prepare('SELECT uuid, expires_at, backup_hash FROM pro_licenses WHERE uuid = ?').bind(payer.uuid).first<License>()
	// Si pagas durante el mes gratis, lo que te quedaba de él se suma
	const trial = c.print ? await licenseOfPrint(db, c.print, now) : c.tg ? await simLicense(db, c.tg, now) : null
	const trialLeft = trial?.plan === 'trial' ? trial.expires_at : 0
	// Renovar suma el periodo a lo que quedaba
	const expires = Math.max(now, old?.expires_at ?? 0, trialLeft) + plan.days * DAY_MS
	if (old) await db.prepare('UPDATE pro_licenses SET username = ?, plan = ?, expires_at = ?, updated_at = ? WHERE uuid = ?').bind(payer.username, c.plan, expires, now, payer.uuid).run()
	else
		await db
			.prepare('INSERT INTO pro_licenses (uuid, username, plan, expires_at, backup_hash, revoked, created_at, updated_at) VALUES (?, ?, ?, ?, NULL, 0, ?, ?)')
			.bind(payer.uuid, payer.username, c.plan, expires, now, now)
			.run()
	// El código de respaldo se crea al comprar por primera vez; el navegador que pagó lo recoge una vez
	if (!old?.backup_hash) {
		const code = await newBackup(db, payer.uuid, now)
		await db.prepare('UPDATE pro_checkouts SET backup_code = ? WHERE id = ?').bind(code, c.id).run()
	}
	if (c.print) await attachPrint(db, payer.uuid, c.print, now)
	if (c.tg) await linkSim(db, c.tg, payer.uuid)
	return true
}

// ── Compartido con el simulador ──────────────────────────────────────

export async function activeLicense(db: D1, uuid: string | null | undefined, now: number): Promise<License | null> {
	if (!uuid) return null
	const l = await db.prepare('SELECT uuid, username, plan, expires_at, backup_hash, revoked FROM pro_licenses WHERE uuid = ?').bind(uuid).first<License>()
	return l && !l.revoked && l.expires_at > now ? l : null
}

async function simLicense(db: D1, tg: number, now: number) {
	const u = await db.prepare('SELECT pro_license FROM sim_users WHERE tg_id = ?').bind(tg).first<{ pro_license: string | null }>()
	return activeLicense(db, u?.pro_license, now)
}

// Primer mes gratis. Las llaves dicen quién ya lo usó (una sola vez cada una); si alguna ya se usó, no hay otro
export async function startTrial(db: D1, license: string, username: string, keys: string[], now: number) {
	for (const k of keys) if (await db.prepare('SELECT 1 FROM pro_trials WHERE key = ?').bind(k).first()) throw new ProError(409, 'Ya usaste tu mes gratis. Hazte Pro para seguir.')
	if (await activeLicense(db, license, now)) throw new ProError(409, 'Ya tienes tu mes gratis activo')
	await db
		.prepare("INSERT INTO pro_licenses (uuid, username, plan, expires_at, revoked, created_at, updated_at) VALUES (?, ?, 'trial', ?, 0, ?, ?) ON CONFLICT(uuid) DO UPDATE SET plan = 'trial', expires_at = excluded.expires_at, updated_at = excluded.updated_at")
		.bind(license, username, now + TRIAL_DAYS * DAY_MS, now, now)
		.run()
	for (const k of keys) await db.prepare('INSERT OR IGNORE INTO pro_trials (key, license, created_at) VALUES (?, ?, ?)').bind(k, license, now).run()
}

// La cuenta del simulador (Telegram) queda vinculada a la licencia: los Pro operan todos los mercados
export async function linkSim(db: D1, tg: number, license: string) {
	await db.prepare('UPDATE sim_users SET pro_license = ? WHERE tg_id = ?').bind(license, tg).run()
}

// Factura para hacerse Pro (o renovar) desde el terminal (con la huella del dispositivo) o desde el
// simulador (con la cuenta de Telegram). El aviso de pago va siempre al dominio del terminal
export async function createCheckout(env: ProEnv, who: { print?: string; tg?: number }, plan: Plan, origin: string, now: number, fetcher: typeof fetch = fetch) {
	if (!(plan in PLANS)) throw new ProError(400, 'Plan no válido')
	const id = `pro-${crypto.randomUUID()}`
	const p = PLANS[plan]
	const inv = await qvapay<{ transaction_uuid?: string; url?: string }>(
		env,
		'/v2/create_invoice',
		{
			amount: p.usd,
			description: `Terminal P2P Pro · plan ${p.name}`,
			remote_id: id,
			webhook: `${origin.replace('://sim.', '://app.')}/api/pro/webhook`,
			expire_at: new Date(now + CHECKOUT_MS).toISOString(),
		},
		fetcher,
	)
	if (!inv.transaction_uuid || !inv.url) throw new ProError(502, 'QvaPay no devolvió la factura')
	await env.DB.prepare("INSERT INTO pro_checkouts (id, print, tg, plan, amount, invoice, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)")
		.bind(id, who.print ?? '', who.tg ?? null, plan, p.usd, inv.transaction_uuid, now)
		.run()
	return { id, url: inv.url }
}

// Cómo va una factura (y se comprueba con QvaPay si sigue pendiente). El código de respaldo nuevo se
// entrega una sola vez, a quien la pidió
export async function checkoutStatus(env: ProEnv, id: string, now: number, fetcher: typeof fetch = fetch) {
	const db = env.DB
	const c = await db.prepare('SELECT * FROM pro_checkouts WHERE id = ?').bind(id).first<Checkout>()
	if (!c) throw new ProError(404, 'Pago no encontrado')
	if (c.status === 'pending' && now - c.created_at < CHECKOUT_MS) await settle(env, c, now, fetcher)
	const fresh = (await db.prepare('SELECT * FROM pro_checkouts WHERE id = ?').bind(c.id).first<Checkout>())!
	if (fresh.status !== 'paid') return { checkout: fresh, body: { status: now - c.created_at < CHECKOUT_MS ? 'pending' : 'expired' } }
	if (fresh.backup_code) await db.prepare('UPDATE pro_checkouts SET backup_code = NULL WHERE id = ?').bind(c.id).run()
	const l = fresh.print ? await licenseOfPrint(db, fresh.print, now) : await activeLicense(db, fresh.license, now)
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
			const print = printOf((await readBody(req)).print)
			const l = await licenseOfPrint(db, print, now)
			if (l) await db.prepare('UPDATE pro_prints SET seen_at = ? WHERE print = ?').bind(now, print).run()
			return json(200, await statusOf(env, l, now))
		}

		// Comprar o renovar: factura de QvaPay para este dispositivo
		if (route === 'POST /pro/checkout') {
			const b = await readBody(req)
			return json(200, await createCheckout(env, { print: printOf(b.print) }, String(b.plan) as Plan, url.origin, now, fetcher))
		}

		// El navegador que pagó pregunta cómo va su factura
		if (route === 'GET /pro/checkout') return json(200, (await checkoutStatus(env, String(url.searchParams.get('id') ?? ''), now, fetcher)).body)

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

		// Primer mes gratis en el terminal: una vez por usuario de QvaPay y por dispositivo
		if (route === 'POST /pro/trial') {
			const b = await readBody(req)
			const print = printOf(b.print)
			const username = String(b.username ?? '').replace(/^@/, '').trim()
			if (!/^[A-Za-z0-9._-]{1,40}$/.test(username)) return json(400, { error: 'Conecta tu cuenta de QvaPay' })
			if (await licenseOfPrint(db, print, now)) return json(409, { error: 'Este dispositivo ya es Pro' })
			const license = `trial:qp:${username.toLowerCase()}`
			await startTrial(db, license, username, [`qp:${username.toLowerCase()}`, `print:${print}`], now)
			await attachPrint(db, license, print, now)
			return json(200, await statusOf(env, await licenseOfPrint(db, print, now), now))
		}

		// Cambiaste de token en este navegador: la huella vieja autoriza a la nueva
		if (route === 'POST /pro/rotate') {
			const b = await readBody(req)
			const from = printOf(b.from)
			const to = printOf(b.to)
			const l = await licenseOfPrint(db, from, now)
			if (!l) return json(200, { pro: false })
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

export async function proAdmin(req: Request, env: ProEnv, now = Date.now()): Promise<Response> {
	if (!(await authorized(req, env.METRICS_KEY))) return askKey()
	const db = env.DB
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
				notice = `<p>Licencia para <b>@${escHtml(username)}</b> hasta ${new Date(expires).toLocaleDateString('es')}. Pásale este código para que lo pegue en «Ya soy Pro»:</p><p class="code">${code}</p>`
			}
		}
		// Devolver un pago: se revoca la licencia (también en el simulador) y se apunta; el dinero se
		// transfiere a mano desde QvaPay a quien pagó
		if (action === 'refund') {
			const id = String(f.get('checkout') ?? '')
			const c = await db.prepare("SELECT c.id, c.amount, c.license, l.username FROM pro_checkouts c JOIN pro_licenses l ON l.uuid = c.license WHERE c.id = ? AND c.status = 'paid' AND c.refunded_at IS NULL").bind(id).first<{ id: string; amount: number; license: string; username: string }>()
			if (!c) notice = '<p class="note">Ese pago no existe o ya se devolvió.</p>'
			else {
				await db.prepare('UPDATE pro_checkouts SET refunded_at = ? WHERE id = ?').bind(now, c.id).run()
				await db.prepare('UPDATE pro_licenses SET revoked = 1, updated_at = ? WHERE uuid = ?').bind(now, c.license).run()
				await db.prepare('DELETE FROM pro_prints WHERE license = ?').bind(c.license).run()
				await db.prepare('UPDATE sim_users SET pro_license = NULL WHERE pro_license = ?').bind(c.license).run()
				notice = `<p class="ok">Licencia de @${escHtml(c.username)} revocada. Ahora transfiere <b>${c.amount.toLocaleString('es')} USD</b> a <b>@${escHtml(c.username)}</b> desde tu cuenta de QvaPay.</p>`
			}
		}
		if (action === 'revoke' || action === 'restore') {
			await db.prepare('UPDATE pro_licenses SET revoked = ?, updated_at = ? WHERE uuid = ?').bind(action === 'revoke' ? 1 : 0, now, uuid).run()
			if (action === 'revoke') await db.prepare('DELETE FROM pro_prints WHERE license = ?').bind(uuid).run()
			notice = `<p class="ok">${action === 'revoke' ? 'Licencia revocada y sus dispositivos fuera' : 'Licencia restaurada'}.</p>`
		}
	}
	const { results } = await db
		.prepare('SELECT l.uuid, l.username, l.plan, l.expires_at, l.revoked, (SELECT COUNT(*) FROM pro_prints p WHERE p.license = l.uuid) AS devices FROM pro_licenses l ORDER BY l.expires_at DESC LIMIT 500')
		.all<License & { devices: number }>()
	const active = results.filter((l) => !l.revoked && l.expires_at > now).length
	// Pagos de cada licencia: el primero marca el plazo de devolución; se puede devolver el último sin devolver
	const pays = (await db.prepare("SELECT id, license, amount, created_at, refunded_at FROM pro_checkouts WHERE status = 'paid' ORDER BY created_at").all<{ id: string; license: string; amount: number; created_at: number; refunded_at: number | null }>()).results
	const payCell = (uuid: string) => {
		const ps = pays.filter((p) => p.license === uuid)
		if (!ps.length) return '<span class="note">sin pagos</span>'
		const total = ps.reduce((s, p) => s + p.amount, 0)
		const last = ps.at(-1)!
		const inTime = now - ps[0].created_at < REFUND_DAYS * DAY_MS
		const refund = last.refunded_at
			? `<span class="note">devuelto el ${new Date(last.refunded_at).toLocaleDateString('es')}</span>`
			: `<form method="post" style="display:inline" onsubmit="return confirm('¿Devolver ${last.amount} USD? Se revoca la licencia y luego haces tú la transferencia en QvaPay.')"><input type="hidden" name="checkout" value="${escHtml(last.id)}"><button class="ghost" name="action" value="refund">Devolver ${last.amount.toLocaleString('es')} USD</button></form>${inTime ? '' : ` <span class="note">fuera de los ${REFUND_DAYS} días</span>`}`
		return `${ps.length} · ${total.toLocaleString('es')} USD ${refund}`
	}
	const rows = results
		.map(
			(l) => `<tr><td>@${escHtml(l.username)}</td><td>${escHtml(l.plan)}</td><td>${new Date(l.expires_at).toLocaleDateString('es')}${l.revoked ? ' <span class="note">(revocada)</span>' : l.expires_at < now ? ' <span class="note">(vencida)</span>' : ''}</td><td>${l.devices}</td><td>${payCell(l.uuid)}</td>
			<td><form method="post"><input type="hidden" name="uuid" value="${escHtml(l.uuid)}"><button class="ghost" name="action" value="${l.revoked ? 'restore' : 'revoke'}">${l.revoked ? 'Restaurar' : 'Revocar'}</button></form></td></tr>`,
		)
		.join('')
	return adminPage(
		'pro',
		'Pro',
		`<h1>Usuarios Pro</h1><p class="note">${active} activos · ${results.length} en total. De cada usuario solo se guarda su usuario de QvaPay, su plan y la huella de sus dispositivos, nunca el token.</p>${notice}
		<h2>Regalar una licencia</h2><form method="post" class="row"><input type="hidden" name="action" value="gift"><input name="username" placeholder="usuario de QvaPay" required><input name="days" type="number" value="30" min="1" style="width:90px"> días <button>Crear</button></form>
		<h2>Licencias</h2><div class="wrap"><table class="left"><tr><th>Usuario</th><th>Plan</th><th>Hasta</th><th>Dispositivos</th><th>Pagos</th><th></th></tr>${rows || '<tr><td colspan="6" class="empty">Todavía no hay usuarios Pro.</td></tr>'}</table></div>
		<p class="note">Política: sin renovación automática; devolución completa en los ${REFUND_DAYS} días siguientes al primer pago. Si Pro falla por nuestra culpa, en vez de devolver se regalan los días perdidos (Regalar una licencia).</p>`,
	)
}
