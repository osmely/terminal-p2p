import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { tokenPrint, whoToken } from '../worker/session.ts'
import { accessOf, BLOCKED_MSG, profileAccess, relayAccess, restrictedWrite, setBlock, liftBlock } from '../worker/blocks.ts'
import { proAdmin as proAdminRaw, proApi, type ProEnv } from '../worker/pro.ts'
import { simApi, type SimEnv } from '../worker/sim.ts'

// D1 sobre SQLite en memoria, con las migraciones del proyecto y Pro encendido
function memD1() {
	const db = new DatabaseSync(':memory:')
	for (const f of readdirSync('migrations').sort()) db.exec(readFileSync(`migrations/${f}`, 'utf8'))
	db.exec("INSERT INTO app_flags (key, value, updated_at) VALUES ('pro', '1', 0)")
	const stmt = (sql: string, args: unknown[] = []) => ({
		bind: (...a: unknown[]) => stmt(sql, a),
		all: async () => ({ results: db.prepare(sql).all(...(args as never[])) as never[] }),
		first: async () => (db.prepare(sql).get(...(args as never[])) ?? null) as never,
		run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...(args as never[])).changes) } }),
	})
	return { db, d1: { prepare: (sql: string) => stmt(sql), batch: async (ss: { run: () => Promise<unknown> }[]) => Promise.all(ss.map((s) => s.run())) } }
}

const T0 = Date.parse('2026-10-28T12:00:00Z')
const DAY = 86_400_000
const KEY = 'clave'
const TOKEN = { ana: '11|tokenDeAna', ana2: '12|otroTokenDeAna', leo: '21|tokenDeLeo' }

// Una petición al relé con el token de alguien y, si se pide, la cookie con su cuenta confirmada
async function relayReq(method: string, path: string, token: string, username?: string) {
	const headers: Record<string, string> = { Authorization: `Bearer ${token}` }
	if (username) headers.Cookie = `tpw=${await whoToken(await tokenPrint(token), `u-${username}`, username, KEY, T0)}`
	return new Request(`https://app.terminalp2p.com/qp${path}`, { method, headers })
}
const pass = async (d1: unknown, method: string, path: string, token: string, username?: string, now = T0) => {
	const r = await relayAccess(d1 as never, KEY, await relayReq(method, path, token, username), path, now)
	return r ? `${r.status} ${(await r.json()).code}` : 'ok'
}

test('restringida: no publica, toma ni edita ofertas; sí paga, libera, cancela, pausa, chatea y califica', () => {
	const U = '0b0e1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d'
	for (const p of ['/p2p/create', `/p2p/${U}/apply`, `/p2p/${U}/edit`]) assert.equal(restrictedWrite('POST', p), true, p)
	for (const p of [`/p2p/${U}/paid`, `/p2p/${U}/received`, `/p2p/${U}/cancel`, `/p2p/${U}/pause`, `/p2p/${U}/chat`, `/p2p/${U}/rate`]) assert.equal(restrictedWrite('POST', p), false, p)
	assert.equal(restrictedWrite('GET', '/p2p'), false)
	assert.equal(restrictedWrite('PATCH', `/p2p/${U}/rate`), false)
})

test('el relé corta a la cuenta restringida o bloqueada, también sin la cookie, y nunca a las demás', async () => {
	const { d1 } = memD1()
	const U = '0b0e1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d'
	// Sin nadie con límites, todo pasa
	assert.equal(await pass(d1, 'POST', '/p2p/create', TOKEN.ana, 'ana'), 'ok')
	await setBlock(d1 as never, 'Ana', 'restricted', 'publica ofertas falsas', T0 + 7 * DAY, T0)
	assert.equal(await pass(d1, 'GET', '/p2p', TOKEN.ana, 'ana'), 'ok')
	assert.equal(await pass(d1, 'POST', '/p2p/create', TOKEN.ana, 'ana'), '403 TP_ACCOUNT_RESTRICTED')
	assert.equal(await pass(d1, 'POST', `/p2p/${U}/apply`, TOKEN.ana, 'ana'), '403 TP_ACCOUNT_RESTRICTED')
	assert.equal(await pass(d1, 'POST', `/p2p/${U}/paid`, TOKEN.ana, 'ana'), 'ok')
	assert.equal(await pass(d1, 'POST', `/p2p/${U}/received`, TOKEN.ana, 'ana'), 'ok')
	// Lo ve en lenguaje claro, sin tu motivo
	const r = await relayAccess(d1 as never, KEY, await relayReq('POST', '/p2p/create', TOKEN.ana, 'ana'), '/p2p/create', T0)
	const body = await r!.json()
	assert.match(body.error, /no puedes publicar, tomar ni editar ofertas[\s\S]*terminar las operaciones que tienes abiertas[\s\S]*@terminalp2p/)
	assert.doesNotMatch(body.error, /falsas/)
	// Ya se vio su huella con la cookie: sin ella también se la reconoce
	assert.equal(await pass(d1, 'POST', '/p2p/create', TOKEN.ana), '403 TP_ACCOUNT_RESTRICTED')
	// Otra cuenta, nada
	assert.equal(await pass(d1, 'POST', '/p2p/create', TOKEN.leo, 'leo'), 'ok')
	assert.equal(await pass(d1, 'POST', '/p2p/create', TOKEN.leo), 'ok')
	// Bloqueada: nada pasa, ni leer
	await setBlock(d1 as never, 'ana', 'blocked', 'estafa confirmada', null, T0)
	assert.equal(await pass(d1, 'GET', '/p2p', TOKEN.ana, 'ana'), '403 TP_ACCOUNT_BLOCKED')
	assert.equal(await pass(d1, 'POST', `/p2p/${U}/received`, TOKEN.ana), '403 TP_ACCOUNT_BLOCKED')
	// Levantado: vuelve a todo al momento
	assert.equal(await liftBlock(d1 as never, 'ana', T0), true)
	assert.equal(await pass(d1, 'POST', '/p2p/create', TOKEN.ana, 'ana'), 'ok')
	assert.equal(await liftBlock(d1 as never, 'ana', T0), false)
})

test('el límite con fecha se acaba solo', async () => {
	const { d1 } = memD1()
	await setBlock(d1 as never, 'ana', 'blocked', 'revisión', T0 + DAY, T0)
	assert.equal(await pass(d1, 'GET', '/p2p', TOKEN.ana, 'ana', T0 + DAY - 1), '403 TP_ACCOUNT_BLOCKED')
	assert.equal(await pass(d1, 'GET', '/p2p', TOKEN.ana, 'ana', T0 + DAY), 'ok')
	assert.equal(await accessOf(d1 as never, { username: 'ana' }, T0 + DAY + 60_000), null)
})

test('al conectar un token nuevo, el perfil de QvaPay delata a la cuenta bloqueada aunque no traiga la cookie', async () => {
	const { d1 } = memD1()
	await setBlock(d1 as never, 'ana', 'blocked', 'cuenta robada', null, T0)
	const req = await relayReq('GET', '/user', TOKEN.ana2)
	const r = await profileAccess(d1 as never, req, { uuid: 'u-ana', username: 'Ana' }, T0)
	assert.equal(r?.status, 403)
	assert.match((await r!.json()).error, /bloqueado el uso de Terminal P2P[\s\S]*qvapay\.com/)
	// Desde entonces ese token se reconoce en cualquier petición
	assert.equal(await pass(d1, 'GET', '/p2p', TOKEN.ana2), '403 TP_ACCOUNT_BLOCKED')
	// Otra cuenta conecta sin problema; una restringida conecta (solo se le apunta la huella)
	assert.equal(await profileAccess(d1 as never, await relayReq('GET', '/user', TOKEN.leo), { username: 'leo' }, T0), null)
	await setBlock(d1 as never, 'leo', 'restricted', 'spam', null, T0)
	assert.equal(await profileAccess(d1 as never, await relayReq('GET', '/user', TOKEN.leo), { username: 'leo' }, T0), null)
	assert.equal(await pass(d1, 'POST', '/p2p/create', TOKEN.leo), '403 TP_ACCOUNT_RESTRICTED')
})

// ── Pro, simulador y panel ───────────────────────────────────────────

async function proAdmin(req: Request, env: ProEnv, now: number) {
	const res = await proAdminRaw(req, env, now)
	if (res.status !== 303) return res
	const cookie = res.headers.get('set-cookie')?.split(';')[0]
	return proAdminRaw(new Request(new URL(res.headers.get('location')!, req.url), { headers: { Authorization: req.headers.get('authorization')!, ...(cookie ? { Cookie: cookie } : {}) } }), env, now)
}

function setup() {
	const { db, d1 } = memD1()
	const env = { DB: d1, PRO_KEY: KEY, METRICS_KEY: 'panel', QVAPAY_APP_ID: 'app', QVAPAY_APP_SECRET: 'secreto' } as unknown as ProEnv
	const fetcher = (async (input: string | URL) => {
		if (String(input).endsWith('/v2/create_invoice')) return Response.json({ transaction_uuid: 'inv-1', url: 'https://www.qvapay.com/pay/inv-1' })
		return Response.json({ transaction: null })
	}) as typeof fetch
	const who = async (print: string, username?: string): Promise<Record<string, string>> => (username ? { Cookie: `tpw=${await whoToken(print, `u-${username}`, username, KEY, T0)}` } : {})
	const pro = async (method: string, path: string, body: Record<string, unknown>, username?: string) => {
		const req = new Request(`https://app.terminalp2p.com${path}`, { method, headers: { 'Content-Type': 'application/json', ...(await who(String(body.print ?? ''), username)) }, body: method === 'GET' ? undefined : JSON.stringify(body) })
		const res = (await proApi(req, new URL(req.url), env, T0, fetcher))!
		return { status: res.status, cookie: res.headers.get('set-cookie'), body: res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text() }
	}
	const panel = (fields?: Record<string, string>, query = '') =>
		proAdmin(
			new Request(`https://app.terminalp2p.com/admin/pro${query}`, { method: fields ? 'POST' : 'GET', headers: { Origin: 'https://app.terminalp2p.com', Authorization: `Basic ${btoa('x:panel')}` }, body: fields ? new URLSearchParams(fields) : undefined }),
			env,
			T0,
		).then((r) => r.text())
	return { db, d1, env, pro, panel }
}

const P1 = 'a'.repeat(64)
const P2 = 'b'.repeat(64)

test('bloqueada: no es Pro, no compra ni activa días gratis, no recoge el módulo, ni avisa el radar; restringida sigue siendo Pro', async () => {
	const s = setup()
	await s.pro('POST', '/pro/status', { print: P1 }, 'ana')
	assert.equal((await s.pro('POST', '/pro/trial', { print: P1 }, 'ana')).body.started, true)
	const license = (await s.pro('POST', '/pro/status', { print: P1 }, 'ana')).body.license
	// Restringida: Pro sigue igual
	await setBlock(s.d1 as never, 'ana', 'restricted', 'spam', null, T0)
	assert.equal((await s.pro('POST', '/pro/status', { print: P1 }, 'ana')).body.pro, true)
	// Bloqueada: Pro desaparece, la sesión del simulador se cierra y nada de Pro le funciona
	await setBlock(s.d1 as never, 'ana', 'blocked', 'estafa', null, T0)
	const st = await s.pro('POST', '/pro/status', { print: P1 }, 'ana')
	assert.deepEqual([st.body.pro, st.body.blocked, st.body.canTrial], [false, true, false])
	assert.match(st.cookie!, /^tpid=; .*Max-Age=0/)
	// También sin la cookie de su cuenta: la huella de su dispositivo Pro la delata
	assert.equal((await s.pro('POST', '/pro/status', { print: P1 })).body.blocked, true)
	assert.equal((await s.pro('POST', '/pro/checkout', { print: P1, plan: 'month' }, 'ana')).body.error.includes('bloqueado'), true)
	assert.equal((await s.pro('POST', '/pro/trial', { print: P2 }, 'ana')).status, 403)
	assert.equal((await s.pro('GET', `/pro/module.js?l=${encodeURIComponent(license)}`, {})).status, 403)
	assert.equal((await s.pro('POST', '/pro/radar/alert', { print: P1 })).status, 403)
	// Otro usuario, todo normal
	await s.pro('POST', '/pro/status', { print: P2 }, 'leo')
	assert.equal((await s.pro('POST', '/pro/checkout', { print: P2, plan: 'month' }, 'leo')).status, 200)
	// Levantado, vuelve a ser Pro con sus días
	await liftBlock(s.d1 as never, 'ana', T0)
	assert.equal((await s.pro('POST', '/pro/status', { print: P1 }, 'ana')).body.pro, true)
})

test('bloqueada: el simulador no la deja jugar aunque conserve la sesión de antes', async () => {
	const s = setup()
	const st = await s.pro('POST', '/pro/status', { print: P1 }, 'ana')
	const tpid = st.cookie!.match(/^tpid=([^;]*)/)![1]
	const sim = async (path: string) => {
		const req = new Request(`https://sim.terminalp2p.com${path}`, { headers: { Cookie: `tpid=${tpid}; tpw=${await whoToken(P1, 'u-ana', 'ana', KEY, T0)}` } })
		const res = await simApi(req, new URL(req.url), s.env as unknown as SimEnv)
		return { status: res.status, body: await res.json() }
	}
	assert.equal(typeof (await sim('/api/me')).body.player.id, 'number')
	await setBlock(s.d1 as never, 'ana', 'blocked', 'estafa', null, Date.now())
	assert.deepEqual((await sim('/api/me')).body, { player: null, pro: null, blocked: BLOCKED_MSG })
	const state = await sim('/api/state')
	assert.equal(state.status, 403)
	assert.match(state.body.error, /bloqueado/)
	await liftBlock(s.d1 as never, 'ana', Date.now())
	assert.equal((await sim('/api/state')).status, 200)
})

test('panel: restringir, bloquear y levantar desde la ficha o desde Cuentas, con motivo, duración y registro', async () => {
	const s = setup()
	// Sin motivo no se aplica
	assert.match(await s.panel({ action: 'access-set', username: 'ana', u: 'ana', level: 'blocked', days: '7', reason: '' }), /Escribe el motivo/)
	assert.match(await s.panel({ action: 'access-set', username: 'ana', u: 'ana', level: 'nada', days: '7', reason: 'x' }), /Elige restringir o bloquear/)
	// Desde la ficha de alguien que ni tiene Pro: 7 días restringida
	let html = await s.panel({ action: 'access-set', username: 'ana', u: 'ana', level: 'restricted', days: '7', reason: 'ofertas falsas' })
	assert.match(html, /<b>@ana<\/b> queda <b>restringida<\/b>[\s\S]*hasta el/)
	assert.match(html, /Restringida en el terminal/)
	assert.match(html, /Motivo: «ofertas falsas»/)
	assert.equal((await accessOf(s.d1 as never, { username: 'ANA' }, T0))?.level, 'restricted')
	// Cambiar a bloqueada, sin fecha
	html = await s.panel({ action: 'access-set', username: 'ana', u: 'ana', level: 'blocked', days: '0', reason: 'estafa confirmada' })
	assert.match(html, /<b>bloqueada<\/b>[\s\S]*hasta que la levantes/)
	assert.deepEqual({ ...s.db.prepare('SELECT level, until, reason FROM user_blocks').get() }, { level: 'blocked', until: null, reason: 'estafa confirmada' })
	// En Cuentas, la lista de las que tienen límites, y desde ahí se bloquea a cualquiera
	await s.panel({ action: 'access-set', username: '@leo', level: 'restricted', days: '1', reason: 'spam' })
	html = await s.panel(undefined, '?view=cuentas')
	assert.match(html, /Acceso al terminal: restringidas y bloqueadas/)
	assert.match(html, /@ana[\s\S]*Bloqueada[\s\S]*estafa confirmada/)
	assert.match(html, /@leo[\s\S]*Restringida[\s\S]*spam/)
	// Levantar
	assert.match(await s.panel({ action: 'access-lift', username: 'ana', u: 'ana' }), /Límite levantado[\s\S]*Sin límites[\s\S]*levantado el/)
	assert.equal(await accessOf(s.d1 as never, { username: 'ana' }, T0), null)
	assert.match(await s.panel({ action: 'access-lift', username: 'ana' }), /no tenía límites/)
	// Todo queda en el registro
	const audit = s.db.prepare('SELECT action, target FROM pro_audit ORDER BY id').all() as { action: string; target: string }[]
	assert.deepEqual(audit.map((a) => `${a.action} ${a.target}`), ['access-set ana', 'access-set ana', 'access-set @leo', 'access-lift ana'])
	assert.match(await s.panel(undefined, '?view=registro'), /Restringir o bloquear[\s\S]*Levantar límite|Levantar límite[\s\S]*Restringir o bloquear/)
})
