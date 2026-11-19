import assert from 'node:assert/strict'
import { test } from 'node:test'
import { growthHtml, growthOf, weekOf } from '../worker/growth.ts'

const rows = <T>(results: T[]) => ({ results })
const at = (day: string, h = 15) => Date.parse(`${day}T${String(h).padStart(2, '0')}:00:00Z`)

test('crecimiento: periodos, cuentas nuevas, embudo, cuántas vuelven y compras sin terminar', () => {
	const now = at('2026-11-18')
	const g = growthOf(
		{
			days: 7,
			today: '2026-11-18',
			cur: { from: '2026-11-11', to: '2026-11-17' },
			prev: { from: '2026-11-04', to: '2026-11-10' },
			hits: rows([
				{ day: '2026-11-12', site: 'app', kind: 'visit', ref: 'grupo', n: 10 },
				{ day: '2026-11-12', site: 'app', kind: 'first', ref: 'grupo', n: 2 },
				{ day: '2026-11-05', site: 'site', kind: 'visit', ref: '', n: 4 },
			]),
			seen: rows([
				{ day: '2026-11-05', account: 'ana' },
				{ day: '2026-11-12', account: 'ana' },
				{ day: '2026-11-12', account: 'beto' },
				{ day: '2026-11-14', account: 'beto' },
				{ day: '2026-11-15', account: 'caro' },
			]),
			firsts: rows([
				{ account: 'ana', day: '2026-11-05' },
				{ account: 'beto', day: '2026-11-12' },
				{ account: 'caro', day: '2026-11-15' },
			]),
			events: rows([]),
			trials: rows([{ user: 'beto', at: at('2026-11-12'), days: 7 }]),
			paid: rows([{ user: 'ana', amount: 3.99, at: at('2026-11-13'), created_at: at('2026-11-13') }]),
			pending: rows([
				{ user: 'beto', plan: 'week', at: at('2026-11-16') },
				{ user: 'beto', plan: 'week', at: at('2026-11-16', 18) },
				// Pidió y luego pagó: no está a medias
				{ user: 'ana', plan: 'month', at: at('2026-11-12') },
			]),
			active: rows([{ user: 'ana', plan: 'month', expires_at: now + 86_400_000 }]),
			bounds: { hits: '2026-11-01', accounts: null, live: '2026-11-01', events: null },
		},
		now,
	)
	assert.equal(g.series.length, 7)
	assert.equal(g.kpi.fresh.cur, 2)
	assert.equal(g.kpi.fresh.prev, 1)
	assert.equal(g.kpi.visits.cur, 10)
	assert.equal(g.kpi.visits.prev, 4)
	// Sin eventos no hay con qué comparar
	assert.equal(g.kpi.completed.prev, null)
	assert.deepEqual(g.funnel, { fresh: 2, returned: 1, tried: 1, paid: 0 })
	assert.equal(g.kpi.revenue.cur, 3.99)
	assert.equal(g.pro.paying, 1)
	assert.deepEqual(
		g.pro.pending.map((p) => [p.user, p.tries]),
		[['beto', 2]],
	)
	// ana entró la semana del 2 nov y volvió la del 9
	const ana = g.cohorts.find((c) => c.week === weekOf('2026-11-05'))!
	assert.equal(ana.size, 1)
	assert.equal(ana.after[0], 1)
	assert.equal(g.refs[0].ref, 'grupo')
	const html = growthHtml(g)
	assert.match(html, /Cuentas en el terminal/)
	assert.match(html, /@beto/)
})

test('crecimiento: el periodo empieza donde empiezan los datos (no cuenta ceros de antes)', () => {
	const g = growthOf(
		{
			days: 30,
			today: '2026-11-18',
			cur: { from: '2026-10-19', to: '2026-11-17' },
			prev: { from: '2026-09-19', to: '2026-10-18' },
			hits: rows([]),
			seen: rows([{ day: '2026-11-10', account: 'ana' }]),
			firsts: rows([{ account: 'ana', day: '2026-11-10' }]),
			events: rows([]),
			trials: rows([]),
			paid: rows([]),
			pending: rows([]),
			active: rows([]),
			bounds: { hits: null, accounts: null, live: '2026-11-10', events: null },
		},
		at('2026-11-18'),
	)
	assert.equal(g.series[0].day, '2026-11-10')
	assert.equal(g.kpi.active.prev, null)
})
