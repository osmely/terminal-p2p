import assert from 'node:assert/strict'
import { test } from 'node:test'
import { cubaDate, dayHours, dayRange, noonCuba, rowsFromTasas, syncInformal } from '../worker/informal.ts'
import type { D1 } from '../worker/rates.ts'

test('elTOQUE: solo las divisas que se muestran, tal cual vienen', () => {
	const rows = rowsFromTasas({ BTC: 776.96, ECU: 915, MLC: 573.91, TRX: 4.56, USD: 825, USDT_TRC20: 1030, BNB: 0 }, '2026-10-23')
	assert.deepEqual(
		rows.map((r) => [r.cur, r.rate]),
		[
			['USD', 825],
			['ECU', 915],
			['MLC', 573.91],
			['USDT_TRC20', 1030],
		],
	)
	assert.deepEqual(rowsFromTasas({}, '2020-06-01'), [])
	assert.deepEqual(rowsFromTasas(null, '2020-06-01'), [])
})

test('día de Cuba y mediodía, con el horario de verano', () => {
	// 03:30 UTC del 23 de octubre son las 23:30 del 22 en Cuba (UTC-4)
	assert.equal(cubaDate(Date.parse('2026-10-23T03:30:00Z')), '2026-10-22')
	assert.equal(cubaDate(Date.parse('2026-10-23T04:30:00Z')), '2026-10-23')
	// En diciembre Cuba está en UTC-5
	assert.equal(cubaDate(Date.parse('2026-12-16T04:30:00Z')), '2026-12-15')
	assert.equal(new Date(noonCuba('2026-10-22')).toISOString(), '2026-10-22T16:00:00.000Z')
	assert.equal(new Date(noonCuba('2026-12-15')).toISOString(), '2026-12-15T17:00:00.000Z')
})

// D1 de mentira: guarda las filas en un Map y responde a la consulta de días cerrados
function fakeDb(closed: string[]) {
	const rows = new Map<string, unknown[]>()
	const db: D1 = {
		prepare(sql: string) {
			let args: unknown[] = []
			const stmt = {
				bind(...v: unknown[]) {
					args = v
					return { ...stmt, args: v }
				},
				async all<T>() {
					return { results: closed.map((day) => ({ day })) as T[] }
				},
				async first<T>() {
					return null as T
				},
				args,
				sql,
			}
			return stmt as never
		},
		async batch(stmts) {
			for (const s of stmts as unknown as { args: unknown[] }[]) rows.set(`${s.args[0]}:${s.args[1]}`, s.args)
			return []
		},
	}
	return { db, rows }
}

test('el cron guarda hoy y rellena primero los días recientes que faltan', async () => {
	const asked: (string | null)[] = []
	const real = globalThis.fetch
	globalThis.fetch = (async (input: string | URL) => {
		const url = new URL(String(input))
		const from = url.searchParams.get('date_from')
		asked.push(from ? from.slice(0, 10) : null)
		// El 19 no tiene datos
		const tasas = from?.startsWith('2026-10-19') ? {} : { USD: 825, ECU: 915, MLC: 570, USDT_TRC20: 1030 }
		return new Response(JSON.stringify({ tasas }))
	}) as typeof fetch
	try {
		// Ya están cerrados del 1 de diciembre de 2020 al 17 de octubre de 2026, salvo el 18
		const closed: string[] = []
		for (let t = Date.parse('2020-12-01T00:00:00Z'); t <= Date.parse('2026-10-17T00:00:00Z'); t += 86_400_000) closed.push(new Date(t).toISOString().slice(0, 10))
		const { db, rows } = fakeDb(closed.filter((d) => d !== '2026-10-15'))
		const n = await syncInformal(db, 'token', Date.parse('2026-10-23T14:00:00Z'), 0)
		assert.deepEqual(asked, [null, '2026-10-22', '2026-10-21', '2026-10-20', '2026-10-19', '2026-10-18', '2026-10-15'])
		assert.equal(n, 6)
		// Hoy queda abierto; los días pedidos, cerrados; el día sin datos se marca para no repetirlo
		assert.deepEqual(rows.get('2026-10-23:USD')?.slice(2, 4), [825, 0])
		assert.deepEqual(rows.get('2026-10-22:USDT_TRC20')?.slice(2, 4), [1030, 1])
		assert.deepEqual(rows.get('2026-10-19:USD')?.slice(2, 4), [0, 1])

		// Con el límite superado se para sin error y sigue en la próxima pasada
		asked.length = 0
		let calls = 0
		globalThis.fetch = (async () => (++calls > 2 ? new Response('{}', { status: 429 }) : new Response(JSON.stringify({ tasas: { USD: 830 } })))) as typeof fetch
		const again = fakeDb(closed.filter((d) => d < '2026-10-10'))
		assert.equal(await syncInformal(again.db, 'token', Date.parse('2026-10-23T14:00:00Z'), 0), 1)
	} finally {
		globalThis.fetch = real
	}
})

test('días con cambio de hora: elTOQUE no acepta intervalos de 24 h o más', () => {
	assert.deepEqual([dayHours('2025-11-02'), dayHours('2026-03-08'), dayHours('2026-10-23'), dayHours('2026-11-01')], [25, 23, 24, 25])
	assert.deepEqual(dayRange('2025-11-02'), { from: '2025-11-02 00:00:01', to: '2025-11-02 22:59:59' })
	assert.deepEqual(dayRange('2026-10-23'), { from: '2026-10-23 00:00:01', to: '2026-10-23 23:59:59' })
})

test('un día rechazado no frena el relleno del resto', async () => {
	const asked: string[] = []
	const real = globalThis.fetch
	globalThis.fetch = (async (input: string | URL) => {
		const from = new URL(String(input)).searchParams.get('date_from')
		if (from) asked.push(from.slice(0, 10))
		if (from?.startsWith('2026-10-21')) return new Response('El intervalo de tiempo debe ser menor a 24 horas', { status: 400 })
		return new Response(JSON.stringify({ tasas: { USD: 830 } }))
	}) as typeof fetch
	try {
		const closed: string[] = []
		for (let t = Date.parse('2020-12-01T00:00:00Z'); t <= Date.parse('2026-10-18T00:00:00Z'); t += 86_400_000) closed.push(new Date(t).toISOString().slice(0, 10))
		const { db, rows } = fakeDb(closed)
		assert.equal(await syncInformal(db, 'token', Date.parse('2026-10-23T14:00:00Z'), 0), 3)
		assert.deepEqual(asked, ['2026-10-22', '2026-10-21', '2026-10-20', '2026-10-19'])
		assert.equal(rows.get('2026-10-21:USD'), undefined)
	} finally {
		globalThis.fetch = real
	}
})
