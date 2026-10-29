import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { BACKUP_TABLES, isSealed, open, restoreSql, seal, sendBackup, snapshot, tablesOf } from '../worker/backup.ts'

// D1 sobre SQLite en memoria, con las migraciones del proyecto
function memD1() {
	const db = new DatabaseSync(':memory:')
	for (const f of readdirSync('migrations').sort()) db.exec(readFileSync(`migrations/${f}`, 'utf8'))
	const stmt = (sql: string, args: unknown[] = []) => ({
		bind: (...a: unknown[]) => stmt(sql, a),
		all: async () => ({ results: db.prepare(sql).all(...(args as never[])) as never[] }),
		first: async () => (db.prepare(sql).get(...(args as never[])) ?? null) as never,
		run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...(args as never[])).changes) } }),
	})
	return { db, d1: { prepare: (sql: string) => stmt(sql), batch: async (ss: { run: () => Promise<unknown> }[]) => Promise.all(ss.map((s) => s.run())) } }
}

const T0 = Date.parse('2026-10-29T09:00:00Z')

// Algo de Pro en cada tabla importante, con comillas y nulos para el SQL
function fill(db: DatabaseSync) {
	db.exec(`INSERT INTO pro_licenses (uuid, username, plan, expires_at, backup_hash, revoked, created_at, updated_at) VALUES ('qp:ana', 'ana', 'month', ${T0 + 9e8}, NULL, 0, ${T0}, ${T0})`)
	db.exec(`INSERT INTO pro_days (license, kind, days, expires_before, expires_after, checkout, note, actor, created_at) VALUES ('qp:ana', 'purchase', 30, NULL, ${T0 + 9e8}, 'pro-1', 'pagó @ana''s', 'system', ${T0})`)
	db.exec(`INSERT INTO pro_checkouts (id, print, tg, plan, amount, invoice, status, license, backup_code, created_at, paid_at, requester, payer, payer_uuid) VALUES ('pro-1', 'p', NULL, 'month', 4.99, 'inv-1', 'paid', 'qp:ana', 'viejo', ${T0}, ${T0}, 'ana', 'ana', 'u-ana')`)
	db.exec(`INSERT INTO pro_refunds (id, checkout, license, amount, payee, status, reason, requested_by, requested_at) VALUES ('rf-1', 'pro-1', 'qp:ana', 4.99, 'ana', 'requested', 'no me sirvió; "nada"', 'user', ${T0})`)
	db.exec(`INSERT INTO user_blocks (username, level, reason, until, created_at, lifted_at) VALUES ('leo', 'restricted', 'spam', NULL, ${T0}, NULL)`)
	db.exec(`INSERT INTO pro_audit (at, action, target, detail) VALUES (${T0}, 'days', 'ana', 'regalo')`)
}

test('la copia lleva todas las tablas de Pro, sin los códigos de respaldo de antes', async () => {
	const { db, d1 } = memD1()
	fill(db)
	const s = await snapshot(d1 as never, T0)
	assert.deepEqual(Object.keys(s.tables), [...BACKUP_TABLES])
	assert.equal(s.tables.pro_refunds.length, 1)
	assert.equal(s.tables.user_blocks[0].username, 'leo')
	assert.equal('backup_code' in s.tables.pro_checkouts[0], false)
	// Las copias de antes (v1, en el KV) también se leen
	assert.deepEqual(Object.keys(tablesOf({ at: 'x', licenses: [], days: [], prints: [], checkouts: [], trials: [] })), ['pro_licenses', 'pro_days', 'pro_prints', 'pro_checkouts', 'pro_trials'])
})

test('cifrada: solo se abre con la clave; con otra o tocada, falla', async () => {
	const text = JSON.stringify({ hola: 'ñandú', n: [1, 2, 3] })
	const sealed = await seal(text, 'clave larga de prueba')
	assert.equal(isSealed(sealed), true)
	assert.doesNotMatch(sealed, /ñandú|hola/)
	assert.equal(await open(sealed, 'clave larga de prueba'), text)
	await assert.rejects(open(sealed, 'otra clave'), /Clave equivocada/)
	const e = JSON.parse(sealed)
	e.data = e.data.slice(0, -4) + (e.data.endsWith('AAAA') ? 'BBBB' : 'AAAA')
	await assert.rejects(open(JSON.stringify(e), 'clave larga de prueba'), /Clave equivocada o archivo dañado/)
})

test('restaurar: de la copia cifrada a una base vacía queda todo igual', async () => {
	const a = memD1()
	fill(a.db)
	const sealed = await seal(JSON.stringify(await snapshot(a.d1 as never, T0)), 'k')
	// Otra base, con algo distinto en una tabla (se reemplaza) y algo fuera de Pro (no se toca)
	const b = memD1()
	b.db.exec(`INSERT INTO user_blocks (username, level, reason, until, created_at, lifted_at) VALUES ('otro', 'blocked', 'x', NULL, 1, NULL)`)
	b.db.exec(`INSERT INTO rates (coin, t, average) VALUES ('BANK_CUP', 1, 1)`)
	b.db.exec(restoreSql(tablesOf(JSON.parse(await open(sealed, 'k')))))
	for (const t of BACKUP_TABLES) {
		const rows = (d: DatabaseSync) => d.prepare(`SELECT * FROM ${t}`).all().map((r) => JSON.stringify(t === 'pro_checkouts' ? { ...r, backup_code: null } : r))
		assert.deepEqual(rows(b.db), rows(a.db), t)
	}
	assert.equal((b.db.prepare('SELECT COUNT(*) AS n FROM rates').get() as { n: number }).n, 1)
})

test('la copia cifrada va al grupo de avisos como archivo; sin clave, no se manda', async () => {
	const { db, d1 } = memD1()
	fill(db)
	const sent: { url: string; body: FormData }[] = []
	const fetcher = (async (url: string, init?: RequestInit) => (sent.push({ url, body: init?.body as FormData }), Response.json({ ok: true }))) as typeof fetch
	const env = { DB: d1, TELEGRAM_BOT_TOKEN: 'bot', ALERT_CHAT: '-1', BACKUP_KEY: 'clave' }
	assert.equal(await sendBackup({ ...env, BACKUP_KEY: undefined } as never, T0, fetcher), null)
	const r = await sendBackup(env as never, T0, fetcher)
	assert.equal(r?.day, '2026-10-29')
	assert.match(sent[0].url, /\/botbot\/sendDocument$/)
	assert.equal(sent[0].body.get('chat_id'), '-1')
	assert.match(String(sent[0].body.get('caption')), /Copia de Pro del 2026-10-29, cifrada: 1 cuentas, 1 compras, 1 devoluciones/)
	const file = sent[0].body.get('document') as File
	assert.equal(file.name, 'terminalp2p-pro-2026-10-29.copia')
	const back = JSON.parse(await open(await file.text(), 'clave'))
	assert.equal(back.tables.pro_licenses[0].username, 'ana')
})

test('la copia completa trae toda la base (tasas, simulador, métricas…) y se restaura igual en una base nueva', async () => {
	const { fullSnapshot } = await import('../worker/backup.ts')
	const a = memD1()
	fill(a.db)
	a.db.exec(`INSERT INTO rates (coin, t, average) VALUES ('BANK_CUP', 1, 500), ('BANK_CUP', 2, 501)`)
	a.db.exec(`INSERT INTO hits (day, site, kind, ref, n) VALUES ('2026-10-29', 'app', 'visit', '', 3)`)
	const s = await fullSnapshot(a.d1 as never, T0)
	const names = Object.keys(s.tables)
	assert.ok(names.includes('rates') && names.includes('sim_players') && names.includes('pro_refunds'))
	assert.ok(!names.some((n) => /^(_cf_|sqlite_|d1_migrations)/.test(n)))
	// Base nueva: las migraciones crean las tablas y la copia las llena
	const b = memD1()
	b.db.exec(restoreSql(tablesOf(JSON.parse(await open(await seal(JSON.stringify(s), 'k'), 'k')))))
	for (const t of names) {
		const rows = (d: DatabaseSync) => d.prepare(`SELECT * FROM ${t}`).all().map((r) => JSON.stringify(t === 'pro_checkouts' ? { ...r, backup_code: null } : r))
		assert.deepEqual(rows(b.db), rows(a.db), t)
	}
})

test('los domingos (hora de Cuba) la copia que va a Telegram es la completa', async () => {
	const { backupPro } = await import('../worker/pro.ts')
	const { db, d1 } = memD1()
	fill(db)
	const names: string[] = []
	const fetcher = (async (_u: string, init?: RequestInit) => (names.push(((init?.body as FormData).get('document') as File).name), Response.json({ ok: true }))) as typeof fetch
	const env = { DB: d1, TELEGRAM_BOT_TOKEN: 'bot', ALERT_CHAT: '-1', BACKUP_KEY: 'k', PRO: { get: async () => null, put: async () => {} } }
	await backupPro(env as never, Date.parse('2026-10-29T09:00:00Z'), fetcher) // jueves
	await backupPro(env as never, Date.parse('2026-11-01T09:00:00Z'), fetcher) // domingo
	assert.deepEqual(names, ['terminalp2p-pro-2026-10-29.copia', 'terminalp2p-completa-2026-11-01.copia'])
})
