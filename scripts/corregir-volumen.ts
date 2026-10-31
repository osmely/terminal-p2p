// Corrige (sin borrar) el volumen guardado con el conteo viejo del feed, que contaba de más: el cierre de una oferta de
// rango que llegaba dos veces sumaba dos veces, y la parte que QvaPay devolvía pausando y reanudando no restaba.
//
//   node scripts/corregir-volumen.ts comparar <día AAAA-MM-DD> [--env staging|prod]
//   node scripts/corregir-volumen.ts plan [--env staging|prod] [--aplicar]
//   node scripts/corregir-volumen.ts deshacer [--env staging|prod]
//
// comparar: nuestras operaciones de ese día de Cuba frente al conteo de 24 h que publica QvaPay, por mercado y lado.
//   Con el conteo nuevo deberían cuadrar; si cuadran, el conteo de QvaPay sirve para corregir los días viejos.
// plan: lo que quedaría en cada mercado, día y lado. Sin --aplicar no toca nada. Con --aplicar (tras escribir el nombre
//   de la base) guarda antes la tabla tal cual en volume_original y luego corrige las horas viejas:
//   1. Las horas que cubre el registro de avisos de staging (feed_trace), exactas: los avisos pasan por el conteo nuevo.
//   2. Los días completos de los mercados con ventana de 24 h: cada hora × (conteo de QvaPay ÷ nuestro conteo del día),
//      de modo que el día cuadre con QvaPay. Los USD, con el mismo factor (es una estimación).
//   3. El resto (días a medias, mercados sin conteo diario de QvaPay): el factor medido con el registro de avisos.
// deshacer: deja las horas corregidas como estaban (desde volume_original).

import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { Book, HOUR_MS, type FeedEvent } from '../worker/livebook.ts'
import { cubaOffset } from '../worker/rates.ts'

const args = process.argv.slice(2)
const mode = args[0]
const env = args.includes('--env') ? args[args.indexOf('--env') + 1] : 'staging'
const apply = args.includes('--aplicar')
if (!['comparar', 'plan', 'deshacer'].includes(mode) || !['staging', 'prod'].includes(env) || (mode === 'comparar' && !/^\d{4}-\d{2}-\d{2}$/.test(args[1] ?? ''))) {
	console.error('Uso: node scripts/corregir-volumen.ts comparar <AAAA-MM-DD> | plan [--aplicar] | deshacer   [--env staging|prod]')
	process.exit(1)
}
const db = env === 'prod' ? 'terminal-p2p' : 'terminal-p2p-staging'
const envArgs = env === 'prod' ? [] : ['--env', 'staging']

// La última hora con el conteo viejo: el libro en vivo corre el nuevo desde las 17:12 (staging) y las 17:25 (prod) UTC
// del 31 oct; esa hora quedó mezclada y la cubre entera el registro de avisos
const LAST_OLD_HOUR = Date.parse('2026-10-31T17:00:00Z')
const DAY_MS = 86_400_000

interface Row {
	coin: string
	hour: number
	side: 'buy' | 'sell'
	ops: number
	usd: number
}

function sql<T>(command: string, base = db, extra = envArgs): T[] {
	const r = spawnSync('npx', ['wrangler', 'd1', 'execute', base, ...extra, '--remote', '--json', '--command', command], { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 })
	if (r.status !== 0) throw new Error(`wrangler falló: ${(r.stderr || r.stdout).slice(-400)}`)
	return JSON.parse(r.stdout)[0].results as T[]
}
function sqlFile(text: string) {
	const file = join(tmpdir(), `corregir-volumen-${Date.now()}.sql`)
	writeFileSync(file, text)
	const r = spawnSync('npx', ['wrangler', 'd1', 'execute', db, ...envArgs, '--remote', '--file', file], { encoding: 'utf8', stdio: 'inherit' })
	if (r.status !== 0) throw new Error('wrangler falló al aplicar')
}
function ask(question: string): Promise<string> {
	const rl = createInterface({ input: process.stdin, output: process.stdout })
	return new Promise((resolve) => rl.question(question, (a) => (rl.close(), resolve(a.trim()))))
}

const cubaDay = (t: number) => new Date(t + cubaOffset(t)).toISOString().slice(0, 10)
const dayStart = (day: string) => {
	const noon = Date.parse(`${day}T12:00:00Z`)
	return Date.parse(`${day}T00:00:00Z`) - cubaOffset(noon)
}
const key = (coin: string, day: string, side: string) => `${coin}|${day}|${side}`
const fmt = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 2 })
const ratio = (a: number, b: number) => (b > 0 ? a / b : null)

// El conteo de 24 h de QvaPay de cada día de Cuba: el último registro de ese día, si su ventana es de 24 h
function qvapayDays(from: number, to: number) {
	const rows = sql<{ coin: string; t: number; count_buy: number | null; count_sell: number | null; window_h: number | null }>(
		`SELECT coin, t, count_buy, count_sell, window_h FROM rates WHERE t >= ${from} AND t < ${to}`,
	)
	const last = new Map<string, (typeof rows)[number]>()
	for (const r of rows) {
		const k = `${r.coin}|${cubaDay(r.t)}`
		if (!last.has(k) || last.get(k)!.t < r.t) last.set(k, r)
	}
	const out = new Map<string, number>()
	for (const [k, r] of last) {
		// El último registro debe ser de la última media hora del día (si no, el día no está cubierto)
		if (r.window_h !== 24 || dayStart(k.split('|')[1]) + DAY_MS - r.t > 30 * 60_000) continue
		const [coin, day] = k.split('|')
		if (r.count_buy != null) out.set(key(coin, day, 'buy'), r.count_buy)
		if (r.count_sell != null) out.set(key(coin, day, 'sell'), r.count_sell)
	}
	return out
}

// Las horas exactas: los avisos del registro de staging pasados por el conteo nuevo (los mismos avisos llegan a prod)
function exactHours() {
	const ev = sql<{ at: number; event: string; uuid: string; coin: string; type: string; offer_kind: string | null; change: string | null; status: string; amount: string; available: string | null; receive: string; upd: string | null }>(
		`SELECT at, event, uuid, coin, type, offer_kind, change, status, amount, available, receive, json_extract(data, '$.updated_at') AS upd FROM feed_trace ORDER BY id`,
		'terminal-p2p-staging',
		['--env', 'staging'],
	)
	if (!ev.length) return { hours: new Map<string, Row>(), from: 0, to: 0 }
	const book = new Book()
	const hours = new Map<string, Row>()
	for (const e of ev) {
		const data = { uuid: e.uuid, coin: e.coin, type: e.type, offer_kind: e.offer_kind ?? undefined, change: e.change, status: e.status, amount: e.amount, available_amount: e.available, receive: e.receive, updated_at: e.upd ?? undefined }
		const tr = book.apply({ event: e.event, data } as FeedEvent, e.at)?.trade
		if (!tr) continue
		const hour = Math.floor(tr.t / HOUR_MS) * HOUR_MS
		const side = tr.side === 'ask' ? 'sell' : 'buy'
		const k = `${e.coin}|${hour}|${side}`
		const r = hours.get(k) ?? hours.set(k, { coin: e.coin, hour, side, ops: 0, usd: 0 }).get(k)!
		r.ops += tr.ops
		r.usd = Math.round((r.usd + tr.ops * tr.usd) * 100) / 100
	}
	// Solo las horas enteras dentro del registro, y no más allá de la última con el conteo viejo
	const from = Math.ceil(ev[0].at / HOUR_MS) * HOUR_MS
	const to = Math.min(Math.floor(ev.at(-1)!.at / HOUR_MS) * HOUR_MS, LAST_OLD_HOUR + HOUR_MS)
	return { hours, from, to }
}

// Reparte un total entero entre las horas, en proporción a lo que tenía cada una (el método del mayor resto)
function spread(values: number[], target: number) {
	const sum = values.reduce((a, b) => a + b, 0)
	if (!sum) return values.map(() => 0)
	const raw = values.map((v) => (v * target) / sum)
	const out = raw.map(Math.floor)
	let left = target - out.reduce((a, b) => a + b, 0)
	const order = raw.map((v, i) => [v - Math.floor(v), i] as const).sort((a, b) => b[0] - a[0])
	for (let j = 0; left > 0 && j < order.length; j++, left--) out[order[j][1]]++
	return out
}

async function main() {
	if (mode === 'comparar') {
		const day = args[1]
		const from = dayStart(day)
		const ours = sql<Row>(`SELECT coin, hour, side, ops, usd FROM volume WHERE hour >= ${from} AND hour < ${from + DAY_MS}`)
		const qp = qvapayDays(from, from + DAY_MS + HOUR_MS)
		const sum = new Map<string, number>()
		for (const r of ours) sum.set(key(r.coin, day, r.side), (sum.get(key(r.coin, day, r.side)) ?? 0) + r.ops)
		console.log(`Día ${day} de Cuba: nuestras operaciones frente al conteo de QvaPay`)
		let a = 0
		let b = 0
		for (const k of [...new Set([...sum.keys(), ...qp.keys()])].sort()) {
			const [coin, , side] = k.split('|')
			const o = sum.get(k) ?? 0
			const q = qp.get(k)
			if (q != null) (a += o), (b += q)
			const d = q ? `${(((o - q) / q) * 100).toFixed(1)}%` : '—'
			console.log(`  ${coin.padEnd(14)} ${side.padEnd(4)} nuestro ${String(o).padStart(5)}   QvaPay ${q == null ? '  sin conteo diario' : String(q).padStart(5)}   ${d}`)
		}
		console.log(`  Total con conteo de QvaPay: nuestro ${a}, QvaPay ${b} (${b ? (((a - b) / b) * 100).toFixed(1) : '—'}%)`)
		return
	}

	const exists = sql<{ n: number }>(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'volume_original'`)[0].n > 0
	if (mode === 'deshacer') {
		if (!exists) return console.log('No hay volume_original: no se ha corregido nada')
		if ((await ask(`Escribe ${db} para dejar el volumen como estaba: `)) !== db) return console.log('No se tocó nada')
		sqlFile(`UPDATE volume SET ops = (SELECT o.ops FROM volume_original o WHERE o.coin = volume.coin AND o.hour = volume.hour AND o.side = volume.side),
			usd = (SELECT o.usd FROM volume_original o WHERE o.coin = volume.coin AND o.hour = volume.hour AND o.side = volume.side)
			WHERE hour <= ${LAST_OLD_HOUR} AND EXISTS (SELECT 1 FROM volume_original o WHERE o.coin = volume.coin AND o.hour = volume.hour AND o.side = volume.side);`)
		return console.log('Listo: las horas corregidas vuelven a tener lo que tenían')
	}

	// plan
	if (exists && apply) return console.log('Ya hay volume_original: ya se corrigió. Usa «deshacer» antes de volver a aplicar')
	const old = sql<Row>(`SELECT coin, hour, side, ops, usd FROM ${exists ? 'volume_original' : 'volume'} WHERE hour <= ${LAST_OLD_HOUR} ORDER BY hour`)
	if (!old.length) return console.log('No hay horas viejas que corregir')
	const first = old[0].hour
	const qp = qvapayDays(dayStart(cubaDay(first)), LAST_OLD_HOUR + 2 * DAY_MS)
	const exact = exactHours()
	const isExact = (h: number) => h >= exact.from && h < exact.to

	// Por mercado, día y lado: lo nuestro (viejo) y, en las horas exactas, lo de verdad
	const byDay = new Map<string, Row[]>()
	for (const r of old) {
		const k = key(r.coin, cubaDay(r.hour), r.side)
		;(byDay.get(k) ?? byDay.set(k, []).get(k)!).push(r)
	}
	// Un día está completo si nuestro registro lo cubre entero (el primero y el último quedan a medias)
	const firstDay = cubaDay(first)
	const lastDay = cubaDay(LAST_OLD_HOUR)

	// El factor medido con el registro: lo exacto ÷ lo viejo en sus horas, por mercado y lado, y de todos juntos
	const measured = new Map<string, { o: number; e: number; u: number; eu: number }>()
	for (const r of old) {
		if (!isExact(r.hour)) continue
		const e = exact.hours.get(`${r.coin}|${r.hour}|${r.side}`)
		for (const k of [`${r.coin}|${r.side}`, `*|${r.side}`]) {
			const m = measured.get(k) ?? measured.set(k, { o: 0, e: 0, u: 0, eu: 0 }).get(k)!
			m.o += r.ops
			m.u += r.usd
			m.e += e?.ops ?? 0
			m.eu += e?.usd ?? 0
		}
	}
	const measuredFor = (coin: string, side: string) => {
		const m = measured.get(`${coin}|${side}`)
		const all = measured.get(`*|${side}`)
		const use = m && m.o >= 5 ? m : all
		return use ? { ops: ratio(use.e, use.o) ?? 1, usd: ratio(use.eu, use.u) ?? 1, how: use === m ? 'registro del mercado' : 'registro, todos' } : { ops: 1, usd: 1, how: 'sin cambio' }
	}
	// El factor de QvaPay de un día completo
	const anchored = (coin: string, day: string, side: string) => {
		if (day === firstDay || day === lastDay) return null
		const q = qp.get(key(coin, day, side))
		const ours = (byDay.get(key(coin, day, side)) ?? []).reduce((t, r) => t + r.ops, 0)
		return q != null && ours > 0 ? { f: q / ours, q } : null
	}
	const nextDay = (day: string) => new Date(Date.parse(`${day}T12:00:00Z`) + DAY_MS).toISOString().slice(0, 10)

	const updates: Row[] = []
	const report: string[] = []
	let before = { ops: 0, usd: 0 }
	let after = { ops: 0, usd: 0 }
	for (const [k, rows] of [...byDay].sort()) {
		const [coin, day, side] = k.split('|')
		const exactRows = rows.filter((r) => isExact(r.hour))
		const rest = rows.filter((r) => !isExact(r.hour))
		const out: Row[] = exactRows.map((r) => {
			const e = exact.hours.get(`${r.coin}|${r.hour}|${r.side}`)
			return { ...r, ops: e?.ops ?? 0, usd: e?.usd ?? 0 }
		})
		let how = rest.length ? '' : 'exacto (registro)'
		if (rest.length) {
			const a = anchored(coin, day, side) ?? (day === firstDay ? anchored(coin, nextDay(day), side) : null)
			const m = measuredFor(coin, side)
			const fOps = a ? a.f : m.ops
			const fUsd = a ? a.f : m.usd
			how = (a ? (day === firstDay ? `QvaPay del ${nextDay(day)}` : `QvaPay (${a.q})`) : m.how) + (exactRows.length ? ' + horas exactas' : '')
			const target = Math.round(rest.reduce((t, r) => t + r.ops, 0) * fOps)
			const ops = rest.some((r) => r.ops < 0) ? rest.map((r) => Math.round(r.ops * fOps)) : spread(rest.map((r) => r.ops), target)
			rest.forEach((r, i) => out.push({ ...r, ops: ops[i], usd: Math.round(r.usd * fUsd * 100) / 100 }))
		}
		const o = { ops: rows.reduce((t, r) => t + r.ops, 0), usd: rows.reduce((t, r) => t + r.usd, 0) }
		const n = { ops: out.reduce((t, r) => t + r.ops, 0), usd: out.reduce((t, r) => t + r.usd, 0) }
		before = { ops: before.ops + o.ops, usd: before.usd + o.usd }
		after = { ops: after.ops + n.ops, usd: after.usd + n.usd }
		report.push(`  ${day} ${coin.padEnd(14)} ${side.padEnd(4)} ${String(o.ops).padStart(5)} → ${String(n.ops).padEnd(5)} ${fmt(o.usd).padStart(10)} → ${fmt(n.usd).padEnd(10)} USD  ${how}`)
		for (const r of out) {
			const was = rows.find((x) => x.hour === r.hour)!
			if (was.ops !== r.ops || Math.abs(was.usd - r.usd) > 0.004) updates.push(r)
		}
	}

	console.log(`Base ${db}: horas viejas del ${cubaDay(first)} al ${lastDay} (hasta las ${new Date(LAST_OLD_HOUR).toISOString().slice(11, 16)} UTC)`)
	console.log(`Registro de avisos: horas exactas de ${exact.from ? new Date(exact.from).toISOString().slice(0, 16) : '—'} a ${exact.to ? new Date(exact.to).toISOString().slice(0, 16) : '—'} UTC`)
	for (const side of ['buy', 'sell']) {
		const m = measured.get(`*|${side}`)
		if (m) console.log(`Factor medido (${side}): operaciones ${(ratio(m.e, m.o) ?? 1).toFixed(3)}, USD ${(ratio(m.eu, m.u) ?? 1).toFixed(3)}`)
	}
	console.log('  día        mercado        lado   ops antes → después     USD antes → después')
	console.log(report.join('\n'))
	console.log(`Total: ${before.ops} → ${after.ops} operaciones, ${fmt(before.usd)} → ${fmt(after.usd)} USD (${updates.length} horas cambian)`)

	// Comprobación: en las horas exactas, qué habría dado el factor de QvaPay del día anterior frente a lo de verdad
	let est = 0
	let real = 0
	for (const r of old.filter((r) => isExact(r.hour))) {
		const a = anchored(r.coin, cubaDay(r.hour - DAY_MS), r.side)
		if (!a) continue
		est += r.ops * a.f
		real += exact.hours.get(`${r.coin}|${r.hour}|${r.side}`)?.ops ?? 0
	}
	if (real) console.log(`Comprobación en las horas exactas: el factor de QvaPay del día anterior daría ${est.toFixed(0)} operaciones; de verdad fueron ${real} (${(((est - real) / real) * 100).toFixed(1)}%)`)

	if (!apply) return console.log('No se tocó nada. Para aplicarlo: --aplicar')
	if ((await ask(`Escribe ${db} para guardar la copia en volume_original y corregir ${updates.length} horas: `)) !== db) return console.log('No se tocó nada')
	const q = (s: string) => `'${s.replace(/'/g, "''")}'`
	sqlFile(
		[
			'CREATE TABLE volume_original AS SELECT * FROM volume;',
			...updates.map((r) => `UPDATE volume SET ops = ${r.ops}, usd = ${r.usd} WHERE coin = ${q(r.coin)} AND hour = ${r.hour} AND side = ${q(r.side)};`),
		].join('\n'),
	)
	console.log('Listo. La copia de antes queda en volume_original («deshacer» la devuelve)')
}

main().catch((err) => {
	console.error(err.message)
	process.exit(1)
})
