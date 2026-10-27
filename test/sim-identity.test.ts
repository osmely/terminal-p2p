import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { whoToken } from '../worker/session.ts'
import { proApi, type ProEnv } from '../worker/pro.ts'
import { canTrade, simApi, type SimEnv } from '../worker/sim.ts'

// La cookie que deja el relé cuando QvaPay devuelve el perfil de ese token: aquí, del `username` del cuerpo
async function whoHeader(body: unknown, now = Date.now()): Promise<Record<string, string>> {
	const b = (body ?? {}) as { print?: string; username?: string }
	if (!b.print || !b.username) return {}
	const n = b.username.replace(/^@/, '')
	return { Cookie: `tpw=${await whoToken(b.print, `u-${n.toLowerCase()}`, n, 'clave', now)}` }
}


// D1 sobre SQLite en memoria, con las migraciones del proyecto
function memD1() {
	const db = new DatabaseSync(':memory:')
	for (const f of readdirSync('migrations').sort()) db.exec(readFileSync(`migrations/${f}`, 'utf8'))
	// Pro encendido en el panel (las pruebas de Pro apagado lo apagan)
	db.exec("INSERT INTO app_flags (key, value, updated_at) VALUES ('pro', '1', 0)")
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
		const req = new Request(`https://app.terminalp2p.com${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(await whoHeader(body)) }, body: JSON.stringify(body) })
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
	return { db, d1, q, terminal, sim, keys }
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

test('Pro se hereda del terminal; la cuenta pasa al dueño de la licencia y sigue de los días gratis a los comprados y a otro dispositivo', async () => {
	const s = setup()
	const c1 = (await s.terminal('/pro/status', { print: P1 })).cookie
	const id = (await s.sim('GET', '/api/me', c1)).body.player.id
	assert.deepEqual(s.keys(), [`print:aaaaaa→${id}`])
	// Sin Pro: BTC y ETH; vender lo que ya tienes siempre se puede
	assert.deepEqual([canTrade(false, 'BTCUSDT', 'BUY'), canTrade(false, 'SOLUSDT', 'BUY'), canTrade(false, 'SOLUSDT', 'SELL'), canTrade(true, 'SOLUSDT', 'BUY')], [true, false, true, true])
	// Conecta la cuenta en el terminal (con su usuario) y activa sus 30 días gratis: el simulador lo ve al
	// momento, y la cuenta pasa a ir con @ana
	assert.equal((await s.terminal('/pro/status', { print: P1, username: 'Ana' })).body.canTrial, true)
	assert.equal((await s.terminal('/pro/trial', { print: P1, username: 'Ana' })).body.started, true)
	let me = (await s.sim('GET', '/api/me', c1)).body
	assert.deepEqual([me.player.id, me.pro.plan], [id, 'trial'])
	assert.deepEqual(s.keys(), [`user:ana→${id}`])
	// Paga el plan mensual: otra licencia (qp:ana), la misma cuenta del simulador
	await s.terminal('/pro/checkout', { print: P1, plan: 'month', username: 'Ana' })
	s.q.pay('inv-1', 'ana')
	await s.terminal('/pro/status', { print: P1 })
	me = (await s.sim('GET', '/api/me', c1)).body
	assert.deepEqual([me.player.id, me.pro.plan], [id, 'month'])
	// Otro dispositivo de Ana: al conectar su cuenta entra solo en su Pro, con la misma cuenta del simulador
	const c2 = (await s.terminal('/pro/status', { print: P2, username: 'Ana' })).cookie
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

test('con Pro apagado en el panel: sin días gratis ni compras, y el simulador solo con BTC y ETH', async () => {
	const { setProEnabled } = await import('../worker/flags.ts')
	const s = setup()
	await setProEnabled(s.d1, false)
	const st = await s.terminal('/pro/status', { print: P1, username: 'Ana' })
	assert.deepEqual([st.body.pro, st.body.enabled, st.body.started], [false, false, undefined])
	assert.ok(st.cookie) // la sesión del simulador sí se deja
	assert.equal((await s.terminal('/pro/checkout', { print: P1, plan: 'month' })).status, 404)
	assert.equal((await s.terminal('/pro/trial', { print: P1, username: 'Ana' })).status, 404)
	const cfg = (await s.sim('GET', '/api/config', null)).body
	assert.deepEqual([cfg.pro, cfg.markets.map((m: { symbol: string }) => m.symbol)], [false, ['BTCUSDT', 'ETHUSDT']])
	assert.equal((await s.sim('GET', '/api/me', st.cookie)).body.pro, null)
	// Al encenderlo, se le ofrecen los 30 días gratis y los activa
	await setProEnabled(s.d1, true)
	assert.equal((await s.terminal('/pro/status', { print: P1, username: 'Ana' })).body.canTrial, true)
	assert.equal((await s.terminal('/pro/trial', { print: P1, username: 'Ana' })).body.started, true)
	assert.ok((await s.sim('GET', '/api/config', null)).body.markets.length > 2)
})

test('estadísticas del simulador en el panel: jugadores, quién entró cada día, operaciones y mercados', async () => {
	const { simAdmin } = await import('../worker/sim.ts')
	const { freshState } = await import('../src/sim/engine.ts')
	const s = setup()
	for (const p of [P1, P2, P3]) await s.sim('GET', '/api/me', (await s.terminal('/pro/status', { print: p })).cookie)
	// Una cuenta que operó BTC dos veces y ETH una
	const st = freshState(Date.now())
	st.trades = [{ symbol: 'BTCUSDT' }, { symbol: 'BTCUSDT' }, { symbol: 'ETHUSDT' }] as never
	s.db.prepare('INSERT OR REPLACE INTO sim_accounts (player, state, equity, pnl_pct, trades, open_orders, checked_at, updated_at, version) VALUES (1, ?, 10100, 1, 3, 1, 0, 0, 0)').run(JSON.stringify(st))
	s.db.prepare("UPDATE sim_days SET orders = 3 WHERE player = 1").run()
	const page = (key = 'panel') =>
		simAdmin(new Request('https://app.terminalp2p.com/admin/sim', { headers: { Authorization: `Basic ${btoa(`x:${key}`)}` } }), { DB: s.d1, METRICS_KEY: 'panel' } as never).then(async (r) => ({ status: r.status, html: await r.text() }))
	assert.equal((await page('mala')).status, 401)
	const { html } = await page()
	assert.match(html, /<span>Jugadores<\/span><b>3<\/b>/)
	assert.match(html, /<span>Entraron hoy<\/span><b>3<\/b>/)
	assert.match(html, /<span>Han operado<\/span><b>1<\/b><small>33 % de los jugadores/)
	assert.match(html, /<tr><td>hoy<\/td><td>3<\/td><td>3<\/td><td>1<\/td><td>3<\/td><\/tr>/)
	assert.match(html, /<tr><td>BTC<\/td><td>2<\/td><td>1<\/td><\/tr><tr><td>ETH<\/td><td>1<\/td><td>1<\/td><\/tr>/)
})

test('con la cuenta confirmada por QvaPay, la misma cuenta del simulador en todos sus dispositivos aunque no sea Pro', async () => {
	const s = setup()
	await s.d1.prepare("UPDATE app_flags SET value = '0' WHERE key = 'pro'").run()
	// Primer dispositivo, aún sin identidad: va con la huella; al confirmarse la cuenta pasa a @ana con su saldo
	const c1 = (await s.terminal('/pro/status', { print: P1 })).cookie
	const id = (await s.sim('GET', '/api/me', c1)).body.player.id
	const who1 = await whoToken(P1, 'u-ana', 'ana', 'clave')
	const withWho = (c: string | null, who: string) => `${c};tpw=${who}`
	assert.equal((await s.sim('GET', '/api/me', withWho(c1, who1))).body.player.id, id)
	assert.deepEqual(s.keys(), [`user:ana→${id}`])
	// Otro dispositivo con la misma cuenta: la misma partida
	const c2 = (await s.terminal('/pro/status', { print: P2 })).cookie
	assert.equal((await s.sim('GET', '/api/me', withWho(c2, await whoToken(P2, 'u-ana', 'ana', 'clave')))).body.player.id, id)
	// La identidad de otra huella no vale: ese dispositivo sigue con la suya
	assert.notEqual((await s.sim('GET', '/api/me', withWho(c2, who1))).body.player.id, id)
})
