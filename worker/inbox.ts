// Buzón del terminal: mensajes del equipo (a una cuenta, a varias, a un grupo o a todos) y avisos del sistema. Al
// mandarlo, a quien tiene el terminal abierto le salta al momento (el libro en vivo le dice «tienes mensaje» y el
// terminal lo pide con su cuenta) y, si se elige, también al móvil por los avisos push. Solo se guarda el mensaje, a
// quién va y si lo leyó; caduca a los 30 días y se borra

import { deliverPush, type PushEnv, type PushMsg } from './push.ts'
import { inCuba, type D1 } from './rates.ts'

const DAY_MS = 86_400_000
export const INBOX_DAYS = 30
const LIST_MAX = 30
export const TITLE_MAX = 80
export const BODY_MAX = 600

// Grupos a los que se puede escribir desde el panel. Se resuelven al mandar (quien entra después en el grupo no lo ve)
export const SEGMENTS = {
	heavy: 'Usan mucho el terminal y nunca probaron Pro',
	trial: 'Con los días gratis de Pro ahora',
	pro: 'Con Pro ahora (gratis, comprado o regalado)',
	ended: 'Se les acabó Pro en los últimos 7 días',
	active: 'Abrieron el terminal en las últimas 2 semanas',
} as const
export type Segment = keyof typeof SEGMENTS
export const isSegment = (s: string): s is Segment => Object.hasOwn(SEGMENTS, s)

export interface InboxEnv extends Partial<PushEnv> {
	DB: D1
	LIVE?: { idFromName(name: string): unknown; get(id: never): { fetch(url: string, init?: RequestInit): Promise<Response> } }
}

const dayOf = (ms: number) => inCuba(ms).toISOString().slice(0, 10)

export async function segmentAccounts(db: D1, seg: Segment, now: number): Promise<string[]> {
	const from14 = dayOf(now - 14 * DAY_MS)
	const rows = await (() => {
		if (seg === 'heavy')
			return db
				.prepare("SELECT account FROM live_seen WHERE day >= ? AND COALESCE(active, minutes) > 0 GROUP BY account HAVING COUNT(*) >= 3 AND SUM(COALESCE(active, minutes)) >= 300 AND NOT EXISTS (SELECT 1 FROM pro_licenses WHERE uuid = 'qp:' || account)")
				.bind(from14)
				.all<{ account: string }>()
		if (seg === 'active') return db.prepare('SELECT DISTINCT account FROM live_seen WHERE day >= ?').bind(from14).all<{ account: string }>()
		const where = {
			trial: "plan = 'trial' AND expires_at > ?1",
			pro: 'expires_at > ?1',
			ended: 'expires_at <= ?1 AND expires_at > ?1 - 604800000',
		}[seg]
		return db.prepare(`SELECT DISTINCT lower(username) AS account FROM pro_licenses WHERE revoked = 0 AND merged_into IS NULL AND ${where}`).bind(now).all<{ account: string }>()
	})()
	return [...new Set(rows.results.map((r) => r.account.toLowerCase()).filter(Boolean))]
}

// Lo que se puede poner en el botón del mensaje: abrir Pro o una dirección https
export function ctaOf(raw: string): string | null {
	const v = raw.trim()
	if (!v) return null
	if (v === 'pro') return 'pro'
	try {
		const u = new URL(v)
		return u.protocol === 'https:' ? u.href : null
	} catch {
		return null
	}
}

export interface NewMessage {
	to: 'all' | string[]
	title: string
	body: string
	cta?: string | null
	ctaLabel?: string | null
	kind?: 'admin' | 'system'
	segment?: string | null
	actor?: string | null
	push?: boolean
	days?: number
}

// El libro en vivo avisa a los terminales abiertos de esas cuentas (o de todas) de que hay mensaje nuevo
async function pingLive(env: InboxEnv, users: string[] | null) {
	if (!env.LIVE) return 0
	const r = await env.LIVE.get(env.LIVE.idFromName('book') as never)
		.fetch('https://live/inbox', { method: 'POST', body: JSON.stringify({ users }) })
		.catch(() => null)
	if (!r?.ok) {
		console.warn(`buzón: el libro en vivo no avisó (${r ? `${r.status} ${(await r.text().catch(() => '')).slice(0, 100)}` : 'sin respuesta'})`)
		return 0
	}
	const d = (await r.json().catch(() => null)) as { sent?: number } | null
	return d?.sent ?? 0
}

export async function sendInbox(env: InboxEnv, m: NewMessage, now: number, fetcher: typeof fetch = fetch) {
	const db = env.DB
	const users = m.to === 'all' ? null : [...new Set(m.to.map((u) => u.trim().replace(/^@/, '').toLowerCase()).filter((u) => /^[a-z0-9_.-]{2,40}$/.test(u)))]
	if (users && !users.length) return { id: 0, recipients: 0, live: 0, pushed: 0 }
	const title = m.title.trim().slice(0, TITLE_MAX)
	const body = m.body.trim().slice(0, BODY_MAX)
	const cta = m.cta ? ctaOf(m.cta) : null
	const ctaLabel = cta ? (m.ctaLabel?.trim().slice(0, 30) || (cta === 'pro' ? 'Ver Pro' : 'Abrir')) : null
	const row = await db
		.prepare('INSERT INTO inbox (audience, kind, title, body, cta, cta_label, segment, recipients, created_at, expires_at, actor) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id')
		.bind(users ? 'list' : 'all', m.kind ?? 'admin', title, body, cta, ctaLabel, m.segment ?? null, users?.length ?? 0, now, now + (m.days ?? INBOX_DAYS) * DAY_MS, m.actor ?? null)
		.first<{ id: number }>()
	const id = row!.id
	if (users)
		for (let i = 0; i < users.length; i += 50)
			await db.batch(users.slice(i, i + 50).map((u) => db.prepare('INSERT OR IGNORE INTO inbox_to (account, msg) VALUES (?, ?)').bind(u, id)))
	const live = await pingLive(env, users)
	let pushed = 0
	if (m.push && env.VAPID_PRIVATE_JWK) {
		const msg: PushMsg = { title, body: body.slice(0, 160), tag: `tp:inbox-${id}`, url: '/?buzon=open', urgent: false, kind: 'inbox' }
		// D1 admite como mucho 100 valores por consulta: la lista va de 50 en 50 (un mismo móvil puede salir en dos)
		let owners: { owner: string }[] = []
		if (users)
			for (let i = 0; i < users.length; i += 50) {
				const part = users.slice(i, i + 50)
				owners.push(...(await db.prepare(`SELECT DISTINCT owner FROM push_subs WHERE lower(username) IN (${part.map(() => '?').join(',')})`).bind(...part).all<{ owner: string }>()).results)
			}
		else owners = (await db.prepare('SELECT DISTINCT owner FROM push_subs').all<{ owner: string }>()).results
		owners = [...new Map(owners.map((o) => [o.owner, o])).values()]
		for (const o of owners) pushed += await deliverPush(env as PushEnv, { owner: o.owner, key: `inbox-${id}`, msg }, now, undefined, fetcher)
		await db.prepare('UPDATE inbox SET pushed = ? WHERE id = ?').bind(pushed, id).run()
	}
	return { id, recipients: users?.length ?? 0, live, pushed }
}

export interface InboxItem {
	id: number
	kind: string
	title: string
	body: string
	cta: string | null
	ctaLabel: string | null
	at: number
	read: boolean
}

// Los mensajes de una cuenta (los suyos y los de todos), del más nuevo al más viejo
export async function listInbox(db: D1, account: string, now: number) {
	const a = account.toLowerCase()
	const { results } = await db
		.prepare(
			`SELECT m.id, m.kind, m.title, m.body, m.cta, m.cta_label, m.created_at, r.read_at FROM inbox m
			LEFT JOIN inbox_read r ON r.account = ?1 AND r.msg = m.id
			WHERE m.expires_at > ?2 AND COALESCE(r.hidden, 0) = 0 AND (m.audience = 'all' OR m.id IN (SELECT msg FROM inbox_to WHERE account = ?1))
			ORDER BY m.created_at DESC, m.id DESC LIMIT ${LIST_MAX}`,
		)
		.bind(a, now)
		.all<{ id: number; kind: string; title: string; body: string; cta: string | null; cta_label: string | null; created_at: number; read_at: number | null }>()
	const items: InboxItem[] = results.map((r) => ({ id: r.id, kind: r.kind, title: r.title, body: r.body, cta: r.cta, ctaLabel: r.cta_label, at: r.created_at, read: r.read_at !== null }))
	return { items, unread: items.filter((i) => !i.read).length }
}

// Marcar leídos (los que vio al abrir el buzón)
export async function markRead(db: D1, account: string, ids: number[], now: number) {
	const a = account.toLowerCase()
	const ok = [...new Set(ids.filter((n) => Number.isInteger(n) && n > 0))].slice(0, LIST_MAX)
	if (ok.length) await db.batch(ok.map((id) => db.prepare('INSERT OR IGNORE INTO inbox_read (account, msg, read_at) VALUES (?, ?, ?)').bind(a, id, now)))
	return ok.length
}

// Borrar de tu buzón (solo los tuyos; para los demás el mensaje sigue). Cuenta como leído
export async function hideMessages(db: D1, account: string, ids: number[], now: number) {
	const a = account.toLowerCase()
	const mine = new Set((await listInbox(db, a, now)).items.map((i) => i.id))
	const ok = [...new Set(ids)].filter((id) => mine.has(id))
	if (ok.length)
		await db.batch(ok.map((id) => db.prepare('INSERT INTO inbox_read (account, msg, read_at, hidden) VALUES (?, ?, ?, 1) ON CONFLICT (account, msg) DO UPDATE SET hidden = 1').bind(a, id, now)))
	return ok.length
}

// Lo caducado se borra (con a quién iba y quién lo leyó)
export async function cleanupInbox(db: D1, now: number) {
	const old = 'SELECT id FROM inbox WHERE expires_at <= ?'
	await db.batch([
		db.prepare(`DELETE FROM inbox_to WHERE msg IN (${old})`).bind(now),
		db.prepare(`DELETE FROM inbox_read WHERE msg IN (${old})`).bind(now),
		db.prepare('DELETE FROM inbox WHERE expires_at <= ?').bind(now),
	])
}

// Para el panel: lo mandado y cuántos lo leyeron
export async function sentMessages(db: D1, limit = 50) {
	const { results } = await db
		.prepare('SELECT m.*, (SELECT COUNT(*) FROM inbox_read r WHERE r.msg = m.id) AS reads FROM inbox m ORDER BY m.created_at DESC, m.id DESC LIMIT ?')
		.bind(limit)
		.all<{ id: number; audience: string; kind: string; title: string; body: string; cta: string | null; cta_label: string | null; segment: string | null; recipients: number; pushed: number; created_at: number; expires_at: number; actor: string | null; reads: number }>()
	return results
}

// Retirar un mensaje (deja de verse ya)
export async function retireMessage(db: D1, id: number, now: number) {
	await db.prepare('UPDATE inbox SET expires_at = ? WHERE id = ? AND expires_at > ?').bind(now, id, now).run()
}
