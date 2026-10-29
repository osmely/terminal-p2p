import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { sign } from '../worker/crypto.ts'
import { relayIncident } from '../worker/incidents.ts'
import { proAdmin as proAdminRaw, proApi, type ProEnv } from '../worker/pro.ts'
import { withoutPro } from '../worker/rates.ts'
import { tokenPrint, whoToken } from '../worker/session.ts'

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
const P1 = 'a'.repeat(64)

// El panel sigue la redirección tras cada acción (con el aviso en la cookie)
async function proAdmin(req: Request, env: ProEnv, now: number) {
	const res = await proAdminRaw(req, env, now)
	if (res.status !== 303) return res
	const cookie = res.headers.get('set-cookie')?.split(';')[0]
	return proAdminRaw(new Request(new URL(res.headers.get('location')!, req.url), { headers: { Authorization: req.headers.get('authorization')!, ...(cookie ? { Cookie: cookie } : {}) } }), env, now)
}

function setup() {
	const { db, d1 } = memD1()
	const sent: string[] = []
	const env = { DB: d1, PRO_KEY: KEY, METRICS_KEY: 'panel', TELEGRAM_BOT_TOKEN: 'bot', ALERT_CHAT: '-1', PRO: { get: async () => 'window.TPProSmart={}' } } as unknown as ProEnv
	const fetcher = (async (input: string | URL, init?: RequestInit) => {
		if (String(input).includes('api.telegram.org')) sent.push(JSON.parse(String(init?.body)).text)
		return Response.json({ ok: true })
	}) as typeof fetch
	let now = T0
	const who = async (print: string, username?: string): Promise<Record<string, string>> => (username ? { Cookie: `tpw=${await whoToken(print, `u-${username}`, username, KEY, now)}` } : {})
	const pro = async (method: string, path: string, body: Record<string, unknown> = {}, username?: string) => {
		const req = new Request(`https://app.terminalp2p.com${path}`, { method, headers: { 'Content-Type': 'application/json', ...(await who(String(body.print ?? ''), username)) }, body: method === 'GET' ? undefined : JSON.stringify(body) })
		const res = (await proApi(req, new URL(req.url), env, now, fetcher))!
		return { status: res.status, body: res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text() }
	}
	const panel = (fields?: Record<string, string>, query = '') =>
		proAdmin(
			new Request(`https://app.terminalp2p.com/admin/pro${query}`, { method: fields ? 'POST' : 'GET', headers: { Origin: 'https://app.terminalp2p.com', Authorization: `Basic ${btoa('x:panel')}` }, body: fields ? new URLSearchParams(fields) : undefined }),
			env,
			now,
		).then((r) => r.text())
	const incidents = () => db.prepare('SELECT kind, username, license, count FROM pro_incidents WHERE resolved_at IS NULL ORDER BY id').all().map((r) => ({ ...r }))
	return { db, d1, env, fetcher, sent, pro, panel, incidents, tick: (ms: number) => (now += ms), now: () => now }
}

// Una petición al relé con el token de alguien, su cuenta confirmada (cookie) y la marca del módulo que lleve
async function relayReq(token: string, username: string | null, mark: string, now: number) {
	const headers: Record<string, string> = { Authorization: `Bearer ${token}`, 'X-TP-Pro': mark }
	if (username) headers.Cookie = `tpw=${await whoToken(await tokenPrint(token), `u-${username}`, username, KEY, now)}`
	return new Request('https://app.terminalp2p.com/qp/p2p', { headers })
}

test('el módulo con una licencia vencida (pasado el margen), de una cuenta suspendida o falsa queda como incidencia; dentro del margen, no', async () => {
	const s = setup()
	await s.pro('POST', '/pro/status', { print: P1 }, 'ana')
	await s.pro('POST', '/pro/trial', { print: P1 }, 'ana')
	const license = (await s.pro('POST', '/pro/status', { print: P1 }, 'ana')).body.license as string
	// Con Pro, el módulo llega con la marca de su licencia (el terminal la manda al relé)
	const mod = await s.pro('GET', `/pro/module.js?l=${encodeURIComponent(license)}`)
	assert.equal(mod.status, 200)
	assert.match(mod.body, /window\.TPProMark="/)
	// Se le acaban los 14 días: a las pocas horas, con el terminal abierto, todavía no es incidencia
	s.tick(14 * DAY + 3 * 3600_000)
	assert.equal((await s.pro('GET', `/pro/module.js?l=${encodeURIComponent(license)}`)).status, 403)
	assert.deepEqual(s.incidents(), [])
	// Pasado el margen, sí (y una sola fila que cuenta las veces)
	s.tick(DAY)
	await s.pro('GET', `/pro/module.js?l=${encodeURIComponent(license)}`)
	await s.pro('GET', `/pro/module.js?l=${encodeURIComponent(license)}`)
	assert.deepEqual(s.incidents(), [{ kind: 'module_expired', username: 'ana', license: 'qp:ana', count: 2 }])
	assert.equal(s.sent.length, 1)
	assert.match(s.sent[0], /Incidencia de Pro[\s\S]*@ana/)
	// Una firma que no es nuestra
	const forged = await sign({ u: 'qp:leo', n: 'leo', e: s.now() + DAY, x: s.now() + DAY }, 'otra-clave')
	assert.equal((await s.pro('GET', `/pro/module.js?l=${encodeURIComponent(forged)}`)).status, 403)
	assert.equal(s.incidents()[1].kind, 'module_forged')
})

test('una copia del módulo en uso: de otra cuenta o con los días vencidos se apunta; si renovó, no', async () => {
	const s = setup()
	const mark = await sign({ u: 'qp:ana', n: 'ana', e: T0 + 30 * DAY, x: T0 + DAY }, KEY)
	s.db.prepare("INSERT INTO pro_licenses (uuid, username, plan, expires_at, revoked, created_at, updated_at) VALUES ('qp:ana', 'ana', 'month', ?, 0, ?, ?)").run(T0 + 30 * DAY, T0, T0)
	// La de ana, en su propia cuenta y con días: nada
	await relayIncident(s.env, KEY, await relayReq('11|tokenAna', 'ana', mark, T0), T0, s.fetcher)
	assert.deepEqual(s.incidents(), [])
	// La misma copia en la cuenta de leo
	await relayIncident(s.env, KEY, await relayReq('21|tokenLeo', 'leo', mark, T0), T0, s.fetcher)
	assert.deepEqual(s.incidents(), [{ kind: 'module_shared', username: 'leo', license: 'qp:ana', count: 1 }])
	// Pasados 31 días ana no renovó: sigue usándolo con los días vencidos
	const later = T0 + 31 * DAY + 3600_000
	s.db.prepare("UPDATE pro_licenses SET expires_at = ? WHERE uuid = 'qp:ana'").run(T0 + 30 * DAY)
	await relayIncident(s.env, KEY, await relayReq('11|tokenAna', 'ana', mark, later), later, s.fetcher)
	assert.equal(s.incidents()[1].kind, 'module_after_expiry')
	// Otra copia (otra marca) de quien sí renovó: la marca es vieja pero sus días de hoy mandan
	const mark2 = await sign({ u: 'qp:eva', n: 'eva', e: T0 + 7 * DAY, x: T0 + DAY }, KEY)
	s.db.prepare("INSERT INTO pro_licenses (uuid, username, plan, expires_at, revoked, created_at, updated_at) VALUES ('qp:eva', 'eva', 'month', ?, 0, ?, ?)").run(T0 + 60 * DAY, T0, T0)
	await relayIncident(s.env, KEY, await relayReq('31|tokenEva', 'eva', mark2, later), later, s.fetcher)
	assert.equal(s.incidents().length, 2)
})

test('avisos del radar sin Pro desde un dispositivo que lo tuvo (pasado el margen) son incidencia', async () => {
	const s = setup()
	await s.pro('POST', '/pro/status', { print: P1 }, 'ana')
	await s.pro('POST', '/pro/trial', { print: P1 }, 'ana')
	const hit = { print: P1, offer: '0b0e1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d', kind: 'found', coin: 'BANK_CUP', side: 'ask', price: 500, usd: 10 }
	s.tick(14 * DAY + 3600_000)
	assert.equal((await s.pro('POST', '/pro/radar/alert', hit)).status, 403)
	assert.deepEqual(s.incidents(), [])
	s.tick(DAY)
	assert.equal((await s.pro('POST', '/pro/radar/alert', hit)).status, 403)
	assert.deepEqual(s.incidents(), [{ kind: 'radar_no_pro', username: 'ana', license: 'qp:ana', count: 1 }])
})

test('panel: las incidencias abiertas, con el número en el menú, restringir o bloquear en un clic y descartar', async () => {
	const s = setup()
	const mark = await sign({ u: 'qp:ana', n: 'ana', e: T0 + 30 * DAY, x: T0 + DAY }, KEY)
	s.db.prepare("INSERT INTO pro_licenses (uuid, username, plan, expires_at, revoked, created_at, updated_at) VALUES ('qp:ana', 'ana', 'month', ?, 0, ?, ?)").run(T0 + 30 * DAY, T0, T0)
	// Otro token que en la prueba de antes (el relé mira cada copia como mucho cada 10 minutos)
	await relayIncident(s.env, KEY, await relayReq('22|otroTokenLeo', 'leo', mark, T0), T0, s.fetcher)
	let html = await s.panel(undefined, '?view=incidencias')
	assert.match(html, /Incidencias<\/span><em>1<\/em>/)
	assert.match(html, /@leo[\s\S]*Usa una copia del módulo Pro de otra cuenta[\s\S]*La copia es de @ana/)
	assert.match(html, /value="access-set"[\s\S]*value="restricted"[\s\S]*value="7"[\s\S]*Restringir/)
	// Restringirlo desde ahí: queda con su límite y la fila lo dice
	html = await s.panel({ action: 'access-set', username: 'leo', level: 'restricted', days: '7', reason: 'Incidencia: copia del módulo' }, '?view=incidencias')
	assert.match(html, /@leo<\/b> queda <b>restringida/)
	assert.match(html, /<span class="pill rejected">Restringida<\/span>/)
	// Descartarla: se cierra y el menú vuelve a cero
	const id = String((s.db.prepare('SELECT id FROM pro_incidents').get() as { id: number }).id)
	html = await s.panel({ action: 'incident-resolve', id }, '?view=incidencias')
	assert.match(html, /Incidencia descartada/)
	assert.match(html, /Ninguna incidencia abierta/)
	assert.doesNotMatch(html, /Incidencias<\/span><em>/)
})

test('el histórico sin Pro no lleva el reparto en compras y ventas ni los USD de cada barra', () => {
	const full = {
		points: [],
		daily: [{ t: 1, day: '2026-10-28', ops: 10, buy: 6, sell: 4, partial: false }],
		volume: { bucketMs: 3600_000, since: 0, bars: [{ t: 0, ops: 5, usd: 120, buy: 3, sell: 2, buyUsd: 70, sellUsd: 50 }] },
	}
	assert.deepEqual(withoutPro(full), {
		points: [],
		daily: [{ t: 1, day: '2026-10-28', ops: 10, partial: false }],
		volume: { bucketMs: 3600_000, since: 0, bars: [{ t: 0, ops: 5 }] },
	})
	assert.equal(withoutPro({ ...full, volume: null }).volume, null)
})
