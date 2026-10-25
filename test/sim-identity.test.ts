import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { proApi, type ProEnv } from '../worker/pro.ts'
import { canTrade, simApi, type SimEnv } from '../worker/sim.ts'

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

// QvaPay de comerciante simulado: crea facturas y dice quién pagó cada una
function fakeQvaPay() {
	const invoices = new Map<string, { remote_id: string; amount: number; status: string; PaidBy: { uuid: string; username: string } | null }>()
	const fetcher = (async (input: string | URL, init?: RequestInit) => {
		const url = String(input)
		if (url.endsWith('/v2/create_invoice')) {
			const b = JSON.parse(String(init?.body))
			const uuid = `inv-${invoices.size + 1}`
			invoices.set(uuid, { remote_id: b.remote_id, amount: b.amount, status: 'pending', PaidBy: null })
			return Response.json({ transaction_uuid: uuid, url: `https://www.qvapay.com/pay/${uuid}` })
		}
		const m = url.match(/\/v2\/transactions\/(.+)$/)
		return Response.json({ transaction: (m && invoices.get(decodeURIComponent(m[1]))) ?? null })
	}) as typeof fetch
	const pay = (uuid: string, username: string) => Object.assign(invoices.get(uuid)!, { status: 'paid', PaidBy: { uuid: `u-${username}`, username } })
	return { fetcher, pay }
}

const P1 = 'a'.repeat(64)
const P2 = 'b'.repeat(64)
const P3 = 'c'.repeat(64)
const P4 = 'd'.repeat(64)

function setup() {
	const { db, d1 } = memD1()
	const q = fakeQvaPay()
	const env = { DB: d1, QVAPAY_APP_ID: 'app', QVAPAY_APP_SECRET: 'secreto', PRO_KEY: 'clave', METRICS_KEY: 'panel' }
	// El terminal (app.terminalp2p.com): devuelve el cuerpo y la cookie de sesión que deja
	const terminal = async (path: string, body: unknown) => {
		const req = new Request(`https://app.terminalp2p.com${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
		const res = (await proApi(req, new URL(req.url), env as ProEnv, Date.now(), q.fetcher))!
		const cookie = res.headers.get('set-cookie')?.match(/^tpid=([^;]*)/)?.[1] ?? null
		return { status: res.status, body: await res.json(), cookie }
	}
	// El simulador (sim.terminalp2p.com), con la cookie del terminal si la hay
	const sim = async (method: string, path: string, cookie: string | null, body?: unknown) => {
		const headers: Record<string, string> = { Origin: 'https://sim.terminalp2p.com', 'Content-Type': 'application/json' }
		if (cookie) headers.Cookie = `tpid=${cookie}`
		const req = new Request(`https://sim.terminalp2p.com${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
		const res = await simApi(req, new URL(req.url), env as unknown as SimEnv)
		return { status: res.status, location: res.headers.get('location'), body: res.headers.get('content-type')?.includes('json') ? await res.json() : null }
	}
	const keys = () => (db.prepare('SELECT key, player FROM sim_ids ORDER BY key').all() as { key: string; player: number }[]).map((r) => `${r.key.slice(0, 12)}→${r.player}`)
	return { db, q, terminal, sim, keys }
}

test('sin la sesión del terminal no se juega; con ella se entra sin otro login', async () => {
	const s = setup()
	assert.deepEqual((await s.sim('GET', '/api/me', null)).body, { player: null, pro: null })
	assert.equal((await s.sim('GET', '/api/state', null)).status, 401)
	// Al conectar la cuenta en el terminal, su consulta de estado deja la cookie
	const { cookie } = await s.terminal('/pro/status', { print: P1 })
	assert.ok(cookie)
	const me = (await s.sim('GET', '/api/me', cookie)).body
	assert.deepEqual([typeof me.player.id, me.pro], ['number', null])
	assert.equal((await s.sim('GET', '/api/state', cookie)).body.account.equity, 10_000)
	// Una cookie inventada no vale
	assert.equal((await s.sim('GET', '/api/state', 'x.y')).status, 401)
	// Al desconectar en el terminal, se borra
	const leave = await s.terminal('/pro/leave', {})
	assert.equal(leave.cookie, '')
})

test('el plan se hereda del terminal; la cuenta pasa al dueño de la licencia y sigue del mes gratis al pago y a otro dispositivo', async () => {
	const s = setup()
	const c1 = (await s.terminal('/pro/status', { print: P1 })).cookie
	const id = (await s.sim('GET', '/api/me', c1)).body.player.id
	assert.deepEqual(s.keys(), [`print:aaaaaa→${id}`])
	// Sin Pro: BTC y ETH; vender lo que ya tienes siempre se puede
	assert.deepEqual([canTrade(false, 'BTCUSDT', 'BUY'), canTrade(false, 'SOLUSDT', 'BUY'), canTrade(false, 'SOLUSDT', 'SELL'), canTrade(true, 'SOLUSDT', 'BUY')], [true, false, true, true])
	// Mes gratis en el terminal: el simulador lo ve al momento, y la cuenta pasa a ir con @ana
	await s.terminal('/pro/trial', { print: P1, username: 'Ana' })
	let me = (await s.sim('GET', '/api/me', c1)).body
	assert.deepEqual([me.player.id, me.pro.plan], [id, 'trial'])
	assert.deepEqual(s.keys(), [`user:ana→${id}`])
	// Paga el plan mensual: otra licencia (qp:ana), la misma cuenta del simulador
	await s.terminal('/pro/checkout', { print: P1, plan: 'month', username: 'Ana' })
	s.q.pay('inv-1', 'ana')
	await s.terminal('/pro/status', { print: P1 })
	me = (await s.sim('GET', '/api/me', c1)).body
	assert.deepEqual([me.player.id, me.pro.plan], [id, 'month'])
	// Otro dispositivo de Ana, añadido con el código de 6 cifras: la misma cuenta
	const { code } = (await s.terminal('/pro/pair', { print: P1 })).body
	await s.terminal('/pro/claim', { print: P2, code })
	const c2 = (await s.terminal('/pro/status', { print: P2 })).cookie
	assert.equal((await s.sim('GET', '/api/me', c2)).body.player.id, id)
})

test('cambiar de token en el terminal: la cuenta del simulador pasa a la huella nueva', async () => {
	const s = setup()
	const old = (await s.terminal('/pro/status', { print: P3 })).cookie
	const id = (await s.sim('GET', '/api/me', old)).body.player.id
	// El terminal ve una huella distinta: primero pregunta con la nueva y luego pide pasar lo de la vieja
	const fresh = (await s.terminal('/pro/status', { print: P4 })).cookie
	assert.equal((await s.terminal('/pro/rotate', { from: P3, to: P4 })).body.pro, false)
	assert.equal((await s.sim('GET', '/api/me', fresh)).body.player.id, id)
})
