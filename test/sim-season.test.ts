import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { Engine, freshState, type SimState } from '../src/sim/engine.ts'
import { rollover, season, summaryText } from '../worker/sim.ts'

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

const MON = Date.parse('2026-10-26T04:00:00Z') // lunes 26 de octubre, 00:00 en Cuba (UTC-4)

test('temporada: de lunes 00:00 a lunes 00:00, hora de Cuba (también con el cambio de hora)', () => {
	assert.deepEqual(season(MON), { id: '2026-10-26', start: MON, end: Date.parse('2026-11-02T05:00:00Z') })
	assert.equal(season(MON - 1).id, '2026-10-19')
	assert.equal(season(Date.parse('2026-11-01T12:00:00Z')).id, '2026-10-26')
	// La semana del cambio de hora termina a las 00:00 de Cuba, ya en UTC-5
	assert.equal(season(Date.parse('2026-11-02T04:30:00Z')).id, '2026-10-26')
	assert.equal(season(Date.parse('2026-11-02T05:00:00Z')).id, '2026-11-02')
})

test('al empezar la semana: clasificación final, borrador del resumen y todos a 10.000 USDT', async () => {
	const { db, d1 } = memD1()
	const prev = '2026-10-19'
	const add = (id: number, name: string, trades: number, cash: number, benched = 0, compete = 1, telegram = true) => {
		const s: SimState = { ...freshState(MON - 86_400_000, undefined, prev), tradeCount: trades }
		s.balances.USDT.free = cash
		db.prepare('INSERT INTO sim_players (id, tg_id, first_name, username, photo_url, compete, created_at, last_seen) VALUES (?, ?, ?, ?, NULL, ?, 0, 0)').run(
			id,
			telegram ? id * 100 : null,
			telegram ? name : null,
			telegram && id !== 3 ? name.toLowerCase() : null,
			compete,
		)
		db.prepare('INSERT INTO sim_accounts VALUES (?, ?, ?, 0, ?, 0, 0, 0, 0, ?, ?)').run(id, JSON.stringify(s), cash, trades, prev, benched)
	}
	add(1, 'Ana', 5, 11_000)
	add(2, 'Luis', 3, 9_500)
	add(3, 'Eva', 2, 20_000) // solo 2 operaciones: no entra
	add(4, 'Leo', 8, 30_000, 1) // reinició a mitad de semana: no entra
	add(5, 'Sol', 9, 50_000, 0, 0) // juega en privado: no entra
	add(6, 'Max', 9, 60_000, 0, 1, false) // apuntado pero sin Telegram vinculado: no entra
	db.prepare("INSERT INTO sim_meta VALUES ('season', ?)").run(prev)

	assert.equal(await rollover(d1, MON + 1000, async () => ({})), true)
	const results = db.prepare('SELECT rank, name, round(pnl_pct, 1) AS pnl FROM sim_results ORDER BY rank').all()
	assert.deepEqual(results.map((r) => ({ ...(r as object) })), [
		{ rank: 1, name: '@ana', pnl: 10 },
		{ rank: 2, name: '@luis', pnl: -5 },
	])
	const draft = JSON.parse((db.prepare("SELECT value FROM sim_meta WHERE key = 'draft'").get() as { value: string }).value)
	assert.equal(draft.posted, false)
	assert.match(draft.text, /🥇 @ana <b>\+10,00%<\/b>/)
	assert.match(draft.text, /Compitieron 2 jugadores/)
	// Todos empiezan la temporada nueva con 10.000 USDT, sin operaciones ni banquillo
	const accs = db.prepare('SELECT season, trades, benched, equity, state FROM sim_accounts').all() as { season: string; trades: number; benched: number; equity: number; state: string }[]
	assert.ok(accs.every((a) => a.season === '2026-10-26' && a.trades === 0 && a.benched === 0 && a.equity === 10_000))
	assert.equal(new Engine(JSON.parse(accs[0].state)).account({}).equity, 10_000)
	// Otra llamada en la misma semana no hace nada
	assert.equal(await rollover(d1, MON + 60_000, async () => ({})), false)
	assert.equal((db.prepare('SELECT COUNT(*) AS n FROM sim_results').get() as { n: number }).n, 2)
})

test('la primera vez solo marca la temporada en curso, sin tocar las cuentas', async () => {
	const { db, d1 } = memD1()
	const s = { ...freshState(MON), tradeCount: 2 }
	db.prepare('INSERT INTO sim_players (id, created_at, last_seen) VALUES (1, 0, 0)').run()
	db.prepare("INSERT INTO sim_accounts VALUES (1, ?, 10000, 0, 2, 0, 0, 0, 0, '', 0)").run(JSON.stringify(s))
	assert.equal(await rollover(d1, MON + 1000), false)
	const a = db.prepare('SELECT season, trades, state FROM sim_accounts').get() as { season: string; trades: number; state: string }
	assert.deepEqual([a.season, a.trades, JSON.parse(a.state).season], ['2026-10-26', 2, '2026-10-26'])
})

test('resumen sin nadie con 3 operaciones', () => {
	assert.match(summaryText('2026-10-19', []), /nadie llegó a las 3 operaciones/)
	assert.doesNotMatch(summaryText('2026-10-19', []), /Compitieron/)
	assert.match(summaryText('2026-10-19', [{ name: '<x>', pnlPct: 1 }]), /&lt;x&gt;/)
})
