// Compara el volumen que suma el feed de QvaPay (tabla volume, worker/livebook-do.ts) con las operaciones que QvaPay
// publica firmadas en Nostr (tabla qp_nostr_trades, worker/qpnostr.ts), por mercado y lado. Solo lee.
//
//   node scripts/comparar-volumen-nostr.ts [--env staging|prod] [--desde AAAA-MM-DD] [--horas MERCADO]
//
// Sin --desde, desde la primera hora entera con operaciones de Nostr guardadas; hasta la última hora cerrada.
// --horas BANK_CUP: además, hora por hora de ese mercado (hora de Cuba).
// En Nostr van aparte las de la tesorería de QvaPay (maker = platform), que el feed cuenta como cualquier otra.

import { spawnSync } from 'node:child_process'
import { inCuba } from '../worker/rates.ts'

const args = process.argv.slice(2)
const opt = (k: string) => (args.includes(k) ? args[args.indexOf(k) + 1] : undefined)
const env = opt('--env') ?? 'staging'
const from = opt('--desde')
const hoursOf = opt('--horas')
if (!['staging', 'prod'].includes(env) || (from && !/^\d{4}-\d{2}-\d{2}$/.test(from)) || (hoursOf && !/^[A-Z_]+$/.test(hoursOf))) {
	console.error('Uso: node scripts/comparar-volumen-nostr.ts [--env staging|prod] [--desde AAAA-MM-DD] [--horas MERCADO]')
	process.exit(1)
}
const db = env === 'prod' ? 'terminal-p2p' : 'terminal-p2p-staging'
const envArgs = env === 'prod' ? [] : ['--env', 'staging']
const HOUR_MS = 3600_000

function sql<T>(command: string): T[] {
	const r = spawnSync('npx', ['wrangler', 'd1', 'execute', db, ...envArgs, '--remote', '--json', '--command', command], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
	if (r.status !== 0) throw new Error(`wrangler falló: ${(r.stderr || r.stdout).slice(-400)}`)
	return JSON.parse(r.stdout)[0].results as T[]
}

const first = sql<{ t: number | null }>('SELECT MIN(at) AS t FROM qp_nostr_trades')[0]?.t
if (!first) {
	console.log('Aún no hay operaciones de Nostr guardadas (las deja el cron cada 10 minutos)')
	process.exit(0)
}
const start = from ? Date.parse(`${from}T04:00:00Z`) : Math.ceil(first / HOUR_MS) * HOUR_MS
const end = Math.floor(Date.now() / HOUR_MS) * HOUR_MS
if (end <= start) {
	console.log('Todavía no hay ninguna hora entera con las dos fuentes')
	process.exit(0)
}

interface Row {
	coin: string
	hour: number
	side: string
	ops: number
	usd: number
}
const feed = sql<Row>(`SELECT coin, hour, side, ops, usd FROM volume WHERE hour >= ${start} AND hour < ${end}`)
const nostr = sql<Row & { plat: number }>(
	`SELECT coin, (at / ${HOUR_MS}) * ${HOUR_MS} AS hour, side, plat, COUNT(*) AS ops, SUM(usd) AS usd FROM qp_nostr_trades WHERE coin IS NOT NULL AND at >= ${start} AND at < ${end} GROUP BY coin, hour, side, plat`,
)
const other = sql<{ f: string; pm: string; ops: number; usd: number }>(
	`SELECT f, pm, COUNT(*) AS ops, SUM(usd) AS usd FROM qp_nostr_trades WHERE coin IS NULL AND at >= ${start} AND at < ${end} GROUP BY f, pm ORDER BY usd DESC`,
)

interface Sum {
	feedOps: number
	feedUsd: number
	ops: number
	usd: number
	platOps: number
	platUsd: number
}
const zero = (): Sum => ({ feedOps: 0, feedUsd: 0, ops: 0, usd: 0, platOps: 0, platUsd: 0 })
const by = new Map<string, Sum>()
const hourly = new Map<number, Sum>()
const add = (key: string, hour: number, coin: string, f: (s: Sum) => void) => {
	f(by.get(key) ?? by.set(key, zero()).get(key)!)
	if (coin === hoursOf) f(hourly.get(hour) ?? hourly.set(hour, zero()).get(hour)!)
}
for (const r of feed)
	add(`${r.coin} ${r.side}`, r.hour, r.coin, (s) => {
		s.feedOps += r.ops
		s.feedUsd += r.usd
	})
for (const r of nostr)
	add(`${r.coin} ${r.side}`, r.hour, r.coin, (s) => {
		s.ops += r.ops
		s.usd += r.usd
		if (r.plat) {
			s.platOps += r.ops
			s.platUsd += r.usd
		}
	})

const n = (v: number) => v.toLocaleString('en-US', { maximumFractionDigits: 2, minimumFractionDigits: 2 })
const pct = (a: number, b: number) => (b ? `${a >= b ? '+' : ''}${(((a - b) / b) * 100).toFixed(1)} %` : a ? 'solo feed' : '—')
const cuba = (t: number) => inCuba(t).toISOString().slice(0, 16).replace('T', ' ')

console.log(`${env}: ${cuba(start)} → ${cuba(end)} (hora de Cuba), ${(end - start) / HOUR_MS} h`)
console.log('Feed − Nostr en %: positivo = el feed cuenta más\n')
const table = (rows: [string, Sum][]) =>
	console.table(
		rows.map(([k, s]) => ({
			'': k,
			'feed ops': s.feedOps,
			'nostr ops': s.ops,
			'ops Δ': pct(s.feedOps, s.ops),
			'feed USD': n(s.feedUsd),
			'nostr USD': n(s.usd),
			'USD Δ': pct(s.feedUsd, s.usd),
			'tesorería ops': s.platOps || '',
			'tesorería USD': s.platUsd ? n(s.platUsd) : '',
		})),
	)
const rows = [...by.entries()].sort((a, b) => b[1].usd + b[1].feedUsd - (a[1].usd + a[1].feedUsd))
const total = rows.reduce((t, [, s]) => {
	for (const k of Object.keys(t) as (keyof Sum)[]) t[k] += s[k]
	return t
}, zero())
table([...rows, ['TOTAL', total]])
if (other.length) {
	console.log('\nEn Nostr, sin mercado en el terminal:')
	console.table(other.map((r) => ({ moneda: r.f, método: r.pm, ops: r.ops, USD: n(r.usd) })))
}
if (hoursOf) {
	console.log(`\n${hoursOf}, hora a hora (Cuba):`)
	table([...hourly.entries()].sort((a, b) => a[0] - b[0]).map(([h, s]) => [cuba(h), s]))
}
