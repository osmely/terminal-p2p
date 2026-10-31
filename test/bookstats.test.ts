import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { recordBook } from '../worker/bookstats.ts'
import type { BookRefs, LiveEnv } from '../worker/livebook.ts'

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

const AT = Date.parse('2026-10-31T12:00:30Z')
const stat = { offers: 4, outliers: 1, best: 1050, usd: 900, usd1: 150, usd3: 450, top1: 0.5, top3: 0.9, age: 3, fill100: 1052, fill500: 1070 }

test('histórico del libro: una fila por mercado y lado completo, con la mediana de lo completado como referencia de lo atípico', async () => {
	const { db, d1 } = memD1()
	db.exec(`INSERT INTO rates (coin, t, median, median_buy, median_sell) VALUES ('BANK_CUP', ${AT - 600_000}, 1060, 1055, 1065), ('ZELLE', ${AT - 7 * 3600_000}, 1.1, NULL, NULL)`)
	let asked: BookRefs | null = null
	const env = {
		DB: d1,
		LIVE: {
			idFromName: () => 'book',
			get: () => ({
				fetch: async (_: string, init?: RequestInit) => {
					asked = JSON.parse(String(init?.body)).refs
					return Response.json({ stale: false, sides: [{ coin: 'BANK_CUP', side: 'ask', stat }, { coin: 'BANK_CUP', side: 'bid', stat: { ...stat, best: 1040 } }] })
				},
			}),
		},
	} as unknown as LiveEnv
	assert.equal(await recordBook(env, AT), 2)
	// La de ZELLE es de hace 7 h: no sirve de referencia
	assert.deepEqual(asked, { BANK_CUP: { ask: 1065, bid: 1055 } })
	const rows = db.prepare('SELECT coin, t, side, best, usd1, fill500, stale FROM book_stats ORDER BY side').all() as Record<string, unknown>[]
	assert.deepEqual(rows.map((r) => [r.coin, r.t, r.side, r.best, r.usd1, r.fill500, r.stale]), [
		['BANK_CUP', Date.parse('2026-10-31T12:00:00Z'), 'ask', 1050, 150, 1070, 0],
		['BANK_CUP', Date.parse('2026-10-31T12:00:00Z'), 'bid', 1040, 150, 1070, 0],
	])
	// Repetir la misma franja no duplica
	assert.equal(await recordBook(env, AT + 1000), 2)
	assert.equal(db.prepare('SELECT COUNT(*) AS n FROM book_stats').get()?.n, 2)
})

test('histórico del libro: sin libro en vivo o sin lados completos, nada', async () => {
	const { db, d1 } = memD1()
	assert.equal(await recordBook({ DB: d1 } as unknown as LiveEnv, AT), 0)
	const empty = { DB: d1, LIVE: { idFromName: () => 'book', get: () => ({ fetch: async () => Response.json({ stale: true, sides: [] }) }) } } as unknown as LiveEnv
	assert.equal(await recordBook(empty, AT), 0)
	assert.equal(db.prepare('SELECT COUNT(*) AS n FROM book_stats').get()?.n, 0)
})
