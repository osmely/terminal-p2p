import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { flashHtml, loadFlash } from '../worker/flash.ts'
import { fingerprint } from '../worker/metrics.ts'

function memD1() {
	const db = new DatabaseSync(':memory:')
	for (const f of readdirSync('migrations').sort()) db.exec(readFileSync(`migrations/${f}`, 'utf8'))
	const stmt = (sql: string, args: unknown[] = []) => ({
		bind: (...a: unknown[]) => stmt(sql, a),
		all: async () => ({ results: db.prepare(sql).all(...(args as never[])) as never[] }),
		first: async () => (db.prepare(sql).get(...(args as never[])) ?? null) as never,
		run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...(args as never[])).changes) } }),
	})
	return { db, d1: { prepare: (sql: string) => stmt(sql) } }
}

const NOW = Date.parse('2026-11-24T16:00:00Z')
const SALT = 'sal'
const uuid = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`

test('relámpago: fijas tomadas en menos de 5 s desde que se pudieron tomar, y quién las tomó', async () => {
	const { db, d1 } = memD1()
	const log = db.prepare('INSERT INTO feed_log (t, rx, event, offer, coin, type, kind, status, amount, receive, username) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
	const row = (t: number, event: string, i: number, kind = 'fixed', user: string | null = 'fe93gonzalez') =>
		log.run(NOW - 3600_000 + t, NOW - 3600_000 + t + 30, event, uuid(i), 'ETECSA', 'sell', kind, 'open', 3.72, 1080, user)
	row(0, 'created', 1)
	row(180, 'applied', 1) // relámpago, la toma nuestro radar
	row(1000, 'created', 2)
	row(1700, 'applied', 2) // relámpago, otro; nuestro radar perdió
	row(2000, 'created', 3)
	row(9000, 'applied', 3) // 7 s: no es relámpago
	row(10_000, 'created', 4)
	row(60_000, 'paused', 4)
	row(70_000, 'resumed', 4)
	row(70_400, 'applied', 4, 'fixed', null) // cuenta desde que volvió; el usuario sale del aviso anterior
	row(80_000, 'created', 5, 'flexible')
	row(80_100, 'applied', 5, 'flexible') // por rango: no cuenta
	const ev = db.prepare("INSERT INTO events (t, event, status, offer, ord, coin, side, usd, source, via) VALUES (?, 'take', ?, ?, '', 'ETECSA', 'sell', 3.72, 'relay', ?)")
	ev.run(NOW - 3600_000, 'ok', await fingerprint(uuid(1), SALT), 'radar')
	ev.run(NOW - 3600_000, 'error', await fingerprint(uuid(2), SALT), 'radar')
	ev.run(NOW - 3600_000, 'ok', await fingerprint(uuid(4), SALT), '')
	const f = await loadFlash(d1 as never, 7, SALT, NOW)
	assert.equal(f.taken, 3 + 1)
	assert.deepEqual(
		f.flash.map((x) => [x.ms, x.who, x.radarLost, x.owner]),
		[
			[400, 'terminal', false, 'fe93gonzalez'],
			[700, 'other', true, 'fe93gonzalez'],
			[180, 'radar', false, 'fe93gonzalez'],
		],
	)
	assert.deepEqual(f.who, { radar: 1, terminal: 1, other: 1 })
	assert.equal(f.radarLost, 1)
	assert.deepEqual(f.buckets.map((b) => b.n), [2, 1, 0, 0])
	assert.deepEqual(f.byOwner, [{ owner: 'fe93gonzalez', n: 3, ms: 400 }])
	const html = flashHtml(f)
	assert.ok(html.includes('Nuestro radar') && html.includes('nuestro radar llegó tarde') && html.includes('@fe93gonzalez') && html.includes('0.18 s'))
	// Sin historial: la sección lo dice
	assert.ok(flashHtml(await loadFlash(memD1().d1 as never, 7, SALT, NOW)).includes('Aún no hay historial'))
})
