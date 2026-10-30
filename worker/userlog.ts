// Traceo de cada cuenta: todo lo que el servidor hizo con ella o le dio, para entender un reclamo o ver un abuso.
// Lo apuntan las rutas de Pro, el relé (al conectar y cuando corta el acceso) y el simulador; el panel lo junta con lo
// que ya guardan otras tablas (días, pagos, devoluciones, incidencias, lo que hiciste tú) en una línea de tiempo por
// cuenta. Nunca el token ni lo que el usuario hace en el P2P: eso queda en su navegador y solo llega si él manda un
// diagnóstico. Se borra a los 180 días

import type { D1 } from './rates.ts'

export type LogKind = 'login' | 'status' | 'device' | 'trial' | 'leave' | 'checkout' | 'refund' | 'telegram' | 'clients' | 'radar' | 'rotate' | 'module' | 'denied' | 'sim' | 'diag' | 'error'

export interface LogEntry {
	account?: string | null
	print?: string | null
	kind: LogKind
	ok?: boolean
	detail?: string | null
	// Clave para no repetir: si ya hay una fila con ella, no se apunta otra
	dk?: string | null
}

export const KEEP_MS = 180 * 86_400_000
const HOUR_MS = 3_600_000

// El usuario, como en las cuentas (`qp:usuario`) o suelto: siempre en minúsculas y sin prefijo
export const accountKey = (a: string | null | undefined) => (a ? a.replace(/^qp:/, '').replace(/^@/, '').toLowerCase() : null)

// Una vez por hora y por lo que sea (la huella, la licencia)
export const hourKey = (kind: LogKind, id: string, now: number) => `${kind}:${id}:${Math.floor(now / HOUR_MS)}`

// Apunta una línea. Nunca rompe la petición que la apunta
export async function logUser(db: D1, e: LogEntry, now: number) {
	try {
		await db
			.prepare('INSERT OR IGNORE INTO user_log (at, account, print, kind, ok, detail, dk) VALUES (?, ?, ?, ?, ?, ?, ?)')
			.bind(now, accountKey(e.account), e.print ?? null, e.kind, e.ok === false ? 0 : 1, e.detail ? e.detail.slice(0, 500) : null, e.dk ?? null)
			.run()
	} catch (err) {
		console.error(`traceo: ${(err as Error).message}`)
	}
}

export async function cleanupLog(db: D1, now: number) {
	await db.prepare('DELETE FROM user_log WHERE at < ?').bind(now - KEEP_MS).run()
	await db.prepare('DELETE FROM user_diag WHERE at < ?').bind(now - KEEP_MS).run()
}

// ── La línea de tiempo de una cuenta ─────────────────────────────────

// src: de qué tabla sale. kind y detail dependen de ella (detail: campos separados por «|»)
export interface TimelineRow {
	at: number
	src: 'log' | 'days' | 'paid' | 'refund' | 'incident' | 'audit' | 'tg' | 'diag'
	kind: string
	ok: number
	detail: string | null
	print: string | null
}

// Lo que el panel ya registra en sus propias tablas no se repite desde el registro de acciones
const AUDIT_SKIP = "('days', 'refund', 'refund-approve', 'refund-reject', 'refund-transfer', 'refund-pay')"

// D1 no acepta más de 5 términos en un mismo UNION: van en grupos de 5, unidos fuera
const TIMELINE = `
	SELECT * FROM (
		SELECT at, 'log' AS src, kind, ok, detail, print FROM user_log WHERE account = ?1
		UNION ALL SELECT created_at, 'days', kind, 1, days || '|' || expires_after || '|' || actor || '|' || COALESCE(note, ''), NULL FROM pro_days WHERE license = ?2
		UNION ALL SELECT paid_at, 'paid', plan, 1, amount || '|' || COALESCE(payer, '') || '|' || COALESCE(invoice, ''), print FROM pro_checkouts WHERE license = ?2 AND status = 'paid' AND paid_at IS NOT NULL
		UNION ALL SELECT requested_at, 'refund', 'requested', 1, amount || '|' || requested_by || '|' || COALESCE(reason, ''), NULL FROM pro_refunds WHERE license = ?2
		UNION ALL SELECT decided_at, 'refund', CASE WHEN status = 'rejected' THEN 'rejected' ELSE 'approved' END, 1, amount || '|' || COALESCE(decision_note, ''), NULL FROM pro_refunds WHERE license = ?2 AND decided_at IS NOT NULL)
	UNION ALL SELECT * FROM (
		SELECT transferred_at, 'refund', 'transferred', 1, amount || '|' || COALESCE(transfer_ref, ''), NULL FROM pro_refunds WHERE license = ?2 AND transferred_at IS NOT NULL
		UNION ALL SELECT first_at, 'incident', kind, 0, count || '|' || COALESCE(detail, ''), NULL FROM pro_incidents WHERE username = ?1
		UNION ALL SELECT at, 'audit', action, 1, COALESCE(detail, ''), NULL FROM pro_audit WHERE lower(target) IN (?1, ?2) AND action NOT IN ${AUDIT_SKIP}
		UNION ALL SELECT at, 'tg', key, 1, NULL, NULL FROM pro_tg_sent WHERE license = ?2
		UNION ALL SELECT at, 'diag', 'diag', 1, id || '|' || entries || '|' || COALESCE(note, ''), print FROM user_diag WHERE account = ?1)`

// Todo, solo lo que salió mal, o sin lo que se repite solo (abrir el terminal, conectar, descargar el módulo)
export type TimelineFilter = 'all' | 'errors' | 'actions'
const FILTERS: Record<TimelineFilter, string> = {
	all: '',
	errors: 'WHERE ok = 0',
	actions: "WHERE NOT (src = 'log' AND kind IN ('status', 'login', 'module'))",
}

export async function timeline(db: D1, username: string, limit: number, offset: number, filter: TimelineFilter = 'all') {
	const u = accountKey(username)!
	const args = [u, `qp:${u}`]
	const all = `SELECT * FROM (${TIMELINE}) ${FILTERS[filter]}`
	const [rows, total] = await Promise.all([
		db.prepare(`${all} ORDER BY at DESC LIMIT ?3 OFFSET ?4`).bind(...args, limit, offset).all<TimelineRow>(),
		db.prepare(`SELECT COUNT(*) AS n FROM (${all})`).bind(...args).first<{ n: number }>(),
	])
	return { rows: rows.results, total: total?.n ?? 0 }
}

// ── Diagnósticos del navegador ───────────────────────────────────────

export interface DiagEntry {
	t: number
	kind: string
	msg: string
	data?: Record<string, string | number | boolean | null>
}

export const DIAG_MAX_ENTRIES = 500
export const DIAG_MAX_BYTES = 200_000
export const DIAG_PER_DAY = 5

// Lo que llega del navegador, limpio: solo campos sueltos y cortos (nada de objetos anidados ni textos largos)
export function cleanDiag(raw: unknown): DiagEntry[] {
	if (!Array.isArray(raw)) return []
	const out: DiagEntry[] = []
	for (const e of raw.slice(-DIAG_MAX_ENTRIES)) {
		if (!e || typeof e !== 'object') continue
		const o = e as Record<string, unknown>
		const t = Number(o.t)
		if (!Number.isFinite(t) || typeof o.kind !== 'string' || typeof o.msg !== 'string') continue
		const data: Record<string, string | number | boolean | null> = {}
		if (o.data && typeof o.data === 'object')
			for (const [k, v] of Object.entries(o.data as Record<string, unknown>).slice(0, 12)) {
				if (!/^[A-Za-z0-9_]{1,24}$/.test(k)) continue
				if (typeof v === 'string') data[k] = v.slice(0, 200)
				else if (typeof v === 'number' || typeof v === 'boolean' || v === null) data[k] = v
			}
		out.push({ t, kind: o.kind.slice(0, 24), msg: o.msg.slice(0, 300), ...(Object.keys(data).length ? { data } : {}) })
	}
	return out
}

export const diagOf = (db: D1, id: number) =>
	db.prepare('SELECT * FROM user_diag WHERE id = ?').bind(id).first<{ id: number; at: number; account: string | null; print: string | null; note: string | null; body: string; entries: number }>()
