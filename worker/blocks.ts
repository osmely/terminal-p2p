// Cuentas restringidas o bloqueadas desde el panel, por seguridad (estafas, abusos, una cuenta robada).
//
// A cada usuario se le reconoce como en Pro: por la cuenta que QvaPay confirmó para la huella de su token (la cookie
// que firma el relé, session.ts) o, si la petición no la trae, por la huella de un dispositivo ya visto de esa cuenta
// (los de Pro y los que pasaron por el relé). El token nunca se guarda. Esto cierra Terminal P2P, no QvaPay: quien
// esté bloqueado puede seguir operando en qvapay.com

import type { D1 } from './rates.ts'
import { readWho, tokenPrint } from './session.ts'

export type AccessLevel = 'restricted' | 'blocked'
export interface Block {
	username: string
	level: AccessLevel
	reason: string
	until: number | null
	created_at: number
	lifted_at: number | null
}

export const ACCESS_NAME: Record<AccessLevel, string> = { restricted: 'Restringida', blocked: 'Bloqueada' }
// Lo que ve el usuario (nunca tu motivo)
export const RESTRICTED_MSG =
	'Tu cuenta tiene limitado el uso de Terminal P2P: desde aquí no puedes publicar, tomar ni editar ofertas, pero sí terminar las operaciones que tienes abiertas. Si crees que es un error, escríbenos a @terminalp2p.'
export const BLOCKED_MSG =
	'Tu cuenta tiene bloqueado el uso de Terminal P2P. Las operaciones que tengas abiertas, termínalas en qvapay.com. Si crees que es un error, escríbenos a @terminalp2p.'
export const accessError = (level: AccessLevel) =>
	new Response(JSON.stringify({ error: level === 'blocked' ? BLOCKED_MSG : RESTRICTED_MSG, code: level === 'blocked' ? 'TP_ACCOUNT_BLOCKED' : 'TP_ACCOUNT_RESTRICTED' }), {
		status: 403,
		headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
	})

// Lo que una cuenta restringida no puede hacer en el relé: publicar, tomar (también el radar y la orden
// inteligente, que toman con esto) ni editar ofertas. Pagar, liberar, cancelar, pausar, el chat y calificar, sí
export const restrictedWrite = (method: string, path: string) => method === 'POST' && (path === '/p2p/create' || /^\/p2p\/[^/]+\/(apply|edit)$/.test(path))

// Cada instancia recuerda la lista medio minuto: el relé la mira en cada petición sin leer la base cada vez
const TTL_MS = 30_000
type Snapshot = { at: number; users: Map<string, { level: AccessLevel; until: number | null }>; prints: Map<string, string> }
const cache = new WeakMap<object, Snapshot>()

async function snapshot(db: D1, now: number): Promise<Snapshot> {
	const hit = cache.get(db)
	if (hit && now - hit.at < TTL_MS) return hit
	const active = 'b.lifted_at IS NULL AND (b.until IS NULL OR b.until > ?)'
	const users = (await db.prepare(`SELECT b.username, b.level, b.until FROM user_blocks b WHERE ${active}`).bind(now).all<{ username: string; level: AccessLevel; until: number | null }>()).results
	const prints = users.length
		? (
				await db
					.prepare(
						`SELECT p.print, b.username FROM pro_prints p JOIN user_blocks b ON p.license = 'qp:' || b.username WHERE ${active}
						UNION SELECT x.print, x.username FROM user_block_prints x JOIN user_blocks b ON b.username = x.username WHERE ${active}`,
					)
					.bind(now, now)
					.all<{ print: string; username: string }>()
			).results
		: []
	const s: Snapshot = { at: now, users: new Map(users.map((u) => [u.username, { level: u.level, until: u.until }])), prints: new Map(prints.map((p) => [p.print, p.username])) }
	cache.set(db, s)
	return s
}

// ¿Hay alguien restringido o bloqueado? Si no, el relé ni calcula huellas
export const anyBlocks = async (db: D1, now = Date.now()) => (await snapshot(db, now)).users.size > 0

// El acceso de un usuario (por su cuenta confirmada o por la huella de su token): null si no tiene límites
export async function accessOf(db: D1, who: { username?: string | null; print?: string | null }, now = Date.now()) {
	const s = await snapshot(db, now)
	if (!s.users.size) return null
	const name = who.username?.toLowerCase() ?? (who.print ? s.prints.get(who.print) : undefined)
	const b = name ? s.users.get(name) : undefined
	if (!name || !b || (b.until !== null && b.until <= now)) return null
	return { username: name, level: b.level }
}

// Una huella vista de una cuenta con límites: la próxima vez se la reconoce aunque no traiga la cookie
export async function rememberPrint(db: D1, username: string, print: string, now: number) {
	const name = username.toLowerCase()
	const s = cache.get(db)
	if (s?.prints.get(print) === name) return
	await db
		.prepare('INSERT INTO user_block_prints (print, username, seen_at) VALUES (?, ?, ?) ON CONFLICT(print) DO UPDATE SET username = excluded.username, seen_at = excluded.seen_at')
		.bind(print, name, now)
		.run()
	s?.prints.set(print, name)
}

export async function setBlock(db: D1, username: string, level: AccessLevel, reason: string, until: number | null, now: number) {
	await db
		.prepare(
			`INSERT INTO user_blocks (username, level, reason, until, created_at, lifted_at) VALUES (?, ?, ?, ?, ?, NULL)
			ON CONFLICT(username) DO UPDATE SET level = excluded.level, reason = excluded.reason, until = excluded.until, created_at = excluded.created_at, lifted_at = NULL`,
		)
		.bind(username.toLowerCase(), level, reason, until, now)
		.run()
	cache.delete(db)
}

export async function liftBlock(db: D1, username: string, now: number) {
	const r = await db.prepare('UPDATE user_blocks SET lifted_at = ? WHERE username = ? AND lifted_at IS NULL').bind(now, username.toLowerCase()).run()
	cache.delete(db)
	return !!r.meta?.changes
}

// Para el panel: el de una cuenta (aunque ya haya vencido o lo levantaras) y los que siguen en vigor
export const blockOf = (db: D1, username: string) => db.prepare('SELECT * FROM user_blocks WHERE username = ?').bind(username.toLowerCase()).first<Block>()
export const activeBlocks = async (db: D1, now: number) =>
	(await db.prepare('SELECT * FROM user_blocks WHERE lifted_at IS NULL AND (until IS NULL OR until > ?) ORDER BY created_at DESC').bind(now).all<Block>()).results
export const isActive = (b: Block | null, now: number) => !!b && b.lifted_at === null && (b.until === null || b.until > now)

// ── El relé ──────────────────────────────────────────────────────────

const bearer = (req: Request) => req.headers.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() || null

// ¿Puede seguir esta petición del relé (`path` sin el prefijo /qp)? Bloqueada: nada. Restringida: ni publicar, ni
// tomar, ni editar ofertas. Sin nadie con límites, ni se calcula la huella
export async function relayAccess(db: D1, key: string | undefined, req: Request, path: string, now = Date.now()): Promise<Response | null> {
	const token = bearer(req)
	if (!token || !(await anyBlocks(db, now))) return null
	const print = await tokenPrint(token)
	const who = key ? await readWho(req.headers.get('cookie'), print, key, now) : null
	const a = await accessOf(db, { username: who?.username, print }, now)
	if (!a) return null
	if (who) await rememberPrint(db, a.username, print, now)
	return a.level === 'blocked' || restrictedWrite(req.method, path) ? accessError(a.level) : null
}

// Al conectar, el perfil que devuelve QvaPay dice quién es el dueño del token aunque la petición no traiga la
// cookie: si tiene límites se apunta la huella de ese token y, si está bloqueada, no llega a conectar
export async function profileAccess(db: D1, req: Request, me: unknown, now = Date.now()): Promise<Response | null> {
	const name = (me as { username?: unknown } | null)?.username
	const token = bearer(req)
	if (typeof name !== 'string' || !token) return null
	const a = await accessOf(db, { username: name }, now)
	if (!a) return null
	await rememberPrint(db, a.username, await tokenPrint(token), now)
	return a.level === 'blocked' ? accessError('blocked') : null
}
