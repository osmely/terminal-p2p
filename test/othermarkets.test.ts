import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import type { FeedEvent } from '../worker/livebook.ts'
import { alertOther, loadOther, OtherMarkets, otherHtml, saveOther } from '../worker/othermarkets.ts'

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

const T = Date.parse('2026-11-05T18:00:00Z')
const ev = (event: string, d: Partial<FeedEvent['data']>): FeedEvent => ({
	event,
	data: { uuid: 'o1', type: 'sell', coin: 'USDTBSC', amount: '90', receive: '90.18', status: 'open', updated_at: new Date(T).toISOString(), offer_kind: 'fixed', ...d },
})

test('otros mercados: cuenta ofertas, tomas y completadas una vez; los del terminal no cuentan', () => {
	const m = new OtherMarkets(new Set(['BANK_CUP']))
	assert.equal(m.add(ev('p2p.created', {}), T), true)
	assert.equal(m.add(ev('p2p.created', {}), T), false) // repetido
	m.add(ev('p2p.applied', {}), T)
	m.add(ev('p2p.completed', { status: 'completed' }), T)
	m.add(ev('p2p.completed', { status: 'completed' }), T)
	assert.equal(m.add(ev('p2p.created', { uuid: 'o2', coin: 'BANK_CUP' }), T), false)
	assert.deepEqual(m.take(), [{ coin: 'USDTBSC', day: '2026-11-05', offers: 1, taken: 1, done: 1, usd: 90 }])
	assert.equal(m.hasPending(), false)
})

test('otros mercados: de una oferta por rango cuenta lo tomado que cambia', () => {
	const m = new OtherMarkets(new Set())
	const r = (event: string, available: string, change: string | null) => ev(event, { uuid: 'r1', coin: 'PAYPAL', offer_kind: 'flexible', amount: '200', available_amount: available, change })
	m.add(r('p2p.range_created', '200', null), T)
	m.add(r('p2p.range_updated', '150', 'taken'), T)
	m.add(r('p2p.range_updated', '150', 'taken'), T) // repetido: no cambia nada
	m.add(r('p2p.range_updated', '170', 'returned'), T)
	assert.deepEqual(m.take(), [{ coin: 'PAYPAL', day: '2026-11-05', offers: 1, taken: 1, done: 0, usd: 30 }])
})

test('otros mercados: se guardan por día, se resumen en 7 días y se avisa una vez al pasar el umbral', async () => {
	const { d1 } = memD1()
	await saveOther(d1, [
		{ coin: 'USDTBSC', day: '2026-11-04', offers: 3, taken: 2, done: 12, usd: 300 },
		{ coin: 'PAYPAL', day: '2026-11-05', offers: 1, taken: 0, done: 0, usd: 0 },
	])
	await saveOther(d1, [{ coin: 'USDTBSC', day: '2026-11-05', offers: 1, taken: 1, done: 9, usd: 250 }])
	await saveOther(d1, [{ coin: 'USDTBSC', day: '2026-10-20', offers: 50, taken: 50, done: 50, usd: 5000 }]) // fuera de los 7 días
	const rows = await loadOther(d1, T)
	assert.deepEqual(
		rows.map((r) => [r.coin, r.done, r.usd, r.days]),
		[
			['USDTBSC', 21, 550, 2],
			['PAYPAL', 0, 0, 1],
		],
	)
	assert.match(otherHtml(rows, (t, b) => `<h2>${t}</h2>${b}`), /USDTBSC<\/code> <span class="note">pasa el umbral/)
	const texts: string[] = []
	const send = async (_env: unknown, text: string) => (texts.push(text), true)
	assert.deepEqual(await alertOther(d1, {}, T, send), ['USDTBSC'])
	assert.deepEqual(await alertOther(d1, {}, T, send), []) // ya avisado
	assert.match(texts[0], /USDTBSC[\s\S]*21 operaciones, 550 USD/)
})
