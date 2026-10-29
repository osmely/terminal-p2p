// Copias. Tres capas, por si pasa algo raro:
//   · Time Travel de D1 (Cloudflare): cualquier momento de los últimos 30 días, de toda la base
//   · la copia diaria en el KV (backup/pro/AAAA-MM-DD, 120 días): todas las tablas de Pro, en claro
//   · la misma copia, cifrada, al grupo privado de avisos por Telegram: fuera de Cloudflare, por si se pierde la cuenta.
//     Los domingos va la copia completa: toda la base (también el histórico de tasas, el volumen, las métricas y el
//     simulador)
// El cifrado es AES-GCM con una clave sacada de BACKUP_KEY (PBKDF2), que solo tiene quien lleva Terminal P2P: ni
// Telegram ni nadie con el archivo puede leerla. Se descifra y se restaura con scripts/restaurar-copia.ts

import { alertsReady, type AlertEnv } from './alerts.ts'
import type { D1 } from './rates.ts'

// Las tablas de Pro que se copian. Fuera, lo pasajero: códigos de un solo uso, topes de días gratis por IP, avisos
// del radar ya mandados
export const BACKUP_TABLES = [
	'pro_licenses',
	'pro_days',
	'pro_checkouts',
	'pro_refunds',
	'pro_prints',
	'pro_trials',
	'pro_telegram',
	'pro_tg_sent',
	'pro_notes',
	'pro_issues',
	'pro_incidents',
	'pro_audit',
	'user_blocks',
	'user_block_prints',
] as const

// Copias de antes (v1), con otros nombres
const V1_NAMES: Record<string, string> = { licenses: 'pro_licenses', days: 'pro_days', prints: 'pro_prints', checkouts: 'pro_checkouts', trials: 'pro_trials' }

export type Row = Record<string, unknown>
export interface Snapshot {
	v: 2
	at: string
	tables: Record<string, Row[]>
}

export async function snapshot(db: D1, now: number): Promise<Snapshot> {
	const tables: Record<string, Row[]> = {}
	for (const t of BACKUP_TABLES) {
		const rows = (await db.prepare(`SELECT * FROM ${t}`).all<Row>()).results
		// Los códigos de respaldo de antes no hacen falta para nada
		tables[t] = t === 'pro_checkouts' ? rows.map(({ backup_code: _, ...r }) => r) : rows
	}
	return { v: 2, at: new Date(now).toISOString(), tables }
}

// Lo que no se copia en la completa: tablas internas de Cloudflare y de SQLite, y el control de migraciones (para
// restaurar en una base vacía, primero se aplican las migraciones)
const SKIP = /^(_cf_|sqlite_|d1_migrations$)/
// De a tantas filas por consulta, para no traer una tabla grande de golpe
const PAGE = 5000

// Toda la base: cada tabla, fila a fila
export async function fullSnapshot(db: D1, now: number): Promise<Snapshot> {
	const list = (await db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY name").all<{ name: string; sql: string | null }>()).results.filter((r) => !SKIP.test(r.name))
	const tables: Record<string, Row[]> = {}
	for (const { name: t, sql } of list) {
		// Un orden fijo para paginar: el rowid o, en las tablas sin él (WITHOUT ROWID), su clave primaria
		const order = /without\s+rowid/i.test(sql ?? '')
			? (await db.prepare('SELECT name FROM pragma_table_info(?) WHERE pk > 0 ORDER BY pk').bind(t).all<{ name: string }>()).results.map((c) => c.name).join(', ')
			: 'rowid'
		const rows: Row[] = []
		for (let off = 0; ; off += PAGE) {
			const page = (await db.prepare(`SELECT * FROM ${t} ORDER BY ${order} LIMIT ? OFFSET ?`).bind(PAGE, off).all<Row>()).results
			rows.push(...(t === 'pro_checkouts' ? page.map(({ backup_code: _, ...r }) => r) : page))
			if (page.length < PAGE) break
		}
		tables[t] = rows
	}
	return { v: 2, at: new Date(now).toISOString(), tables }
}

// Una copia en cualquier formato (v1 del KV o v2) como tablas
export function tablesOf(s: unknown): Record<string, Row[]> {
	const o = s as { v?: number; tables?: Record<string, Row[]> } & Record<string, unknown>
	if (o?.v === 2 && o.tables) return o.tables
	const out: Record<string, Row[]> = {}
	for (const [k, t] of Object.entries(V1_NAMES)) if (Array.isArray(o?.[k])) out[t] = o[k] as Row[]
	return out
}

// ── Cifrado ───────────────────────────────────────────────────────────

// Cloudflare no deja más de 100,000 iteraciones de PBKDF2
const ITER = 100_000
const b64 = (u: Uint8Array) => btoa(Array.from(u, (c) => String.fromCharCode(c)).join(''))
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))

async function keyOf(passphrase: string, salt: Uint8Array<ArrayBuffer>, iter: number) {
	const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey'])
	return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
}

const pipe = async (data: Uint8Array<ArrayBuffer>, t: CompressionStream | DecompressionStream) => new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(t)).arrayBuffer())

// El archivo cifrado: un JSON con lo necesario para descifrarlo (menos la clave) y los datos comprimidos y cifrados
export async function seal(text: string, passphrase: string) {
	const salt = crypto.getRandomValues(new Uint8Array(16))
	const iv = crypto.getRandomValues(new Uint8Array(12))
	const zipped = await pipe(new TextEncoder().encode(text), new CompressionStream('gzip'))
	const data = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await keyOf(passphrase, salt, ITER), zipped))
	return JSON.stringify({ tp: 'terminalp2p-copia', v: 1, kdf: 'PBKDF2-SHA256', iter: ITER, cipher: 'AES-256-GCM', gzip: true, salt: b64(salt), iv: b64(iv), data: b64(data) })
}

export const isSealed = (text: string) => /^\s*\{\s*"tp"\s*:\s*"terminalp2p-copia"/.test(text)

// Con una clave equivocada (o el archivo tocado) falla: AES-GCM lo detecta
export async function open(sealed: string, passphrase: string) {
	const e = JSON.parse(sealed) as { iter: number; salt: string; iv: string; data: string; gzip?: boolean }
	let plain: Uint8Array<ArrayBuffer>
	try {
		plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(e.iv) }, await keyOf(passphrase, unb64(e.salt), e.iter), unb64(e.data)))
	} catch {
		throw new Error('Clave equivocada o archivo dañado')
	}
	return new TextDecoder().decode(e.gzip ? await pipe(plain, new DecompressionStream('gzip')) : plain)
}

// ── Fuera de Cloudflare ───────────────────────────────────────────────

export interface BackupEnv extends AlertEnv {
	DB: D1
	BACKUP_KEY?: string
}

// La copia cifrada, al grupo privado de avisos como archivo: la de Pro o (full) toda la base. Sin BACKUP_KEY o sin el
// bot, no se manda
export async function sendBackup(env: BackupEnv, now: number, fetcher: typeof fetch = fetch, full = false) {
	if (!env.BACKUP_KEY || !alertsReady(env)) return null
	const s = full ? await fullSnapshot(env.DB, now) : await snapshot(env.DB, now)
	const sealed = await seal(JSON.stringify(s), env.BACKUP_KEY)
	const day = s.at.slice(0, 10)
	const n = (t: string) => (s.tables[t] ?? []).length
	const rows = Object.values(s.tables).reduce((a, r) => a + r.length, 0)
	const form = new FormData()
	form.append('chat_id', env.ALERT_CHAT!)
	form.append(
		'caption',
		`${env.STAGING === '1' ? '🧪 STAGING · ' : ''}🗄 ${full ? `Copia completa del ${day}, cifrada: ${Object.keys(s.tables).length} tablas, ${rows.toLocaleString('en-US')} filas (Pro, tasas, volumen, métricas y simulador)` : `Copia de Pro del ${day}, cifrada: ${n('pro_licenses')} cuentas, ${n('pro_checkouts')} compras, ${n('pro_refunds')} devoluciones`}. Guárdala; se restaura con scripts/restaurar-copia.ts y tu BACKUP_KEY.`,
	)
	form.append('document', new Blob([sealed], { type: 'application/json' }), `terminalp2p-${full ? 'completa' : 'pro'}-${env.STAGING === '1' ? 'staging-' : ''}${day}.copia`)
	const res = await fetcher(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendDocument`, { method: 'POST', body: form })
	const j = (await res.json().catch(() => ({}))) as { ok?: boolean; description?: string }
	if (!j.ok) throw new Error(`Telegram no aceptó la copia: ${j.description ?? res.status}`)
	return { day, bytes: sealed.length, rows, full }
}

// ── Restaurar ─────────────────────────────────────────────────────────

const sqlValue = (v: unknown) => (v === null || v === undefined ? 'NULL' : typeof v === 'number' ? (Number.isFinite(v) ? String(v) : 'NULL') : typeof v === 'boolean' ? (v ? '1' : '0') : `'${String(v).replace(/'/g, "''")}'`)

// El SQL que deja esas tablas exactamente como en la copia (las demás no se tocan)
export function restoreSql(tables: Record<string, Row[]>) {
	const out: string[] = []
	for (const [t, rows] of Object.entries(tables)) {
		if (!/^[a-z_]+$/.test(t)) throw new Error(`Tabla con nombre raro: ${t}`)
		out.push(`DELETE FROM ${t};`)
		for (const r of rows) {
			const cols = Object.keys(r)
			if (cols.some((c) => !/^[a-z_]+$/.test(c))) throw new Error(`Columna con nombre raro en ${t}`)
			out.push(`INSERT INTO ${t} (${cols.join(', ')}) VALUES (${cols.map((c) => sqlValue(r[c])).join(', ')});`)
		}
	}
	return `${out.join('\n')}\n`
}
