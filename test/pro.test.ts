import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { PRO_DEVICES, proAdmin, proApi, type ProEnv } from '../worker/pro.ts'

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
	const calls: string[] = []
	const fetcher = (async (input: string | URL, init?: RequestInit) => {
		const url = String(input)
		const h = new Headers(init?.headers)
		calls.push(url.replace('https://api.qvapay.com', ''))
		if (h.get('app-id') !== 'app' || h.get('app-secret') !== 'secreto') return new Response('{"error":"credenciales"}', { status: 401 })
		if (url.endsWith('/v2/create_invoice')) {
			const b = JSON.parse(String(init?.body))
			const uuid = `inv-${invoices.size + 1}`
			invoices.set(uuid, { remote_id: b.remote_id, amount: b.amount, status: 'pending', PaidBy: null })
			return Response.json({ transaction_uuid: uuid, url: `https://www.qvapay.com/pay/${uuid}` })
		}
		const m = url.match(/\/v2\/transactions\/(.+)$/)
		if (m) return Response.json({ transaction: invoices.get(decodeURIComponent(m[1])) ?? null })
		return new Response('{}', { status: 404 })
	}) as typeof fetch
	const pay = (uuid: string, username = 'ana', amount?: number) => Object.assign(invoices.get(uuid)!, { status: 'paid', PaidBy: { uuid: `u-${username}`, username }, ...(amount ? { amount } : {}) })
	return { fetcher, pay, calls, invoices }
}

const T0 = Date.parse('2026-10-25T12:00:00Z')
const P1 = 'a'.repeat(64)
const P2 = 'b'.repeat(64)
const P3 = 'c'.repeat(64)
const P4 = 'd'.repeat(64)

function setup(extra: Partial<ProEnv> = {}) {
	const { db, d1 } = memD1()
	const q = fakeQvaPay()
	const env: ProEnv = { DB: d1, QVAPAY_APP_ID: 'app', QVAPAY_APP_SECRET: 'secreto', PRO_KEY: 'clave', METRICS_KEY: 'panel', ...extra }
	let now = T0
	const call = async (method: string, path: string, body?: unknown) => {
		const req = new Request(`https://app.terminalp2p.com${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
		const res = (await proApi(req, new URL(req.url), env, now, q.fetcher))!
		return { status: res.status, body: res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text() }
	}
	return {
		db,
		env,
		q,
		call,
		tick: (ms: number) => (now += ms),
		now: () => now,
		post: (p: string, b: unknown) => call('POST', p, b),
		get: (p: string) => call('GET', p),
		status: (id: string, print = P1) => call('POST', '/pro/checkout/status', { id, print }),
	}
}

// Compra completa: factura, pago en QvaPay y el navegador recoge el resultado
async function buy(s: ReturnType<typeof setup>, print = P1, plan = 'month', username = 'ana') {
	const c = await s.post('/pro/checkout', { print, plan })
	const inv = [...s.q.invoices.keys()].at(-1)!
	s.q.pay(inv, username)
	return { checkout: c.body, result: (await s.status(c.body.id, print)).body }
}

test('comprar: factura de QvaPay, quién pagó lo confirma QvaPay y el código de respaldo se entrega una vez', async () => {
	const s = setup()
	const c = await s.post('/pro/checkout', { print: P1, plan: 'month' })
	assert.equal(c.status, 200)
	assert.match(c.body.url, /^https:\/\/www\.qvapay\.com\/pay\/inv-1$/)
	assert.deepEqual(s.q.invoices.get('inv-1')?.amount, 1.99)
	// Sin pagar sigue pendiente y no es Pro
	assert.equal((await s.status(c.body.id)).body.status, 'pending')
	assert.equal((await s.post('/pro/status', { print: P1 })).body.pro, false)
	s.q.pay('inv-1', 'ana')
	const r = (await s.status(c.body.id)).body
	assert.equal(r.status, 'paid')
	assert.equal(r.pro, true)
	assert.equal(r.username, 'ana')
	assert.match(r.backupCode, /^TP-[2-9A-Z]{4}-[2-9A-Z]{4}-[2-9A-Z]{4}$/)
	assert.equal(r.expiresAt, T0 + 30 * 86_400_000)
	// Una segunda consulta ya no devuelve el código (solo lo tiene quien compró)
	assert.equal((await s.status(c.body.id)).body.backupCode, null)
	const st = (await s.post('/pro/status', { print: P1 })).body
	assert.deepEqual([st.pro, st.username, st.plan], [true, 'ana', 'month'])
	// En la base: el usuario y la huella, nunca un token
	assert.deepEqual({ ...s.db.prepare('SELECT username, plan FROM pro_licenses').get() }, { username: 'ana', plan: 'month' })
})

test('renovar suma el periodo y no cambia el código de respaldo', async () => {
	const s = setup()
	await buy(s)
	s.tick(26 * 86_400_000)
	const { result } = await buy(s, P1, 'year')
	assert.equal(result.expiresAt, T0 + (30 + 365) * 86_400_000)
	assert.equal(result.backupCode, null)
})

test('siendo Pro no se puede pagar hasta los últimos 5 días; una factura pendiente del mismo plan se reutiliza', async () => {
	const s = setup()
	// Dos clics en «Mensual»: la misma factura, no dos
	const a = (await s.post('/pro/checkout', { print: P1, plan: 'month' })).body
	assert.deepEqual((await s.post('/pro/checkout', { print: P1, plan: 'month' })).body, a)
	assert.equal(s.q.invoices.size, 1)
	// Otro plan sí es otra factura
	assert.notEqual((await s.post('/pro/checkout', { print: P1, plan: 'year' })).body.id, a.id)
	s.q.pay('inv-1', 'ana')
	assert.equal((await s.status(a.id)).body.status, 'paid')
	// Ya es Pro con 30 días: no puede pagar otra vez
	const r = await s.post('/pro/checkout', { print: P1, plan: 'month' })
	assert.equal(r.status, 409)
	assert.match(r.body.error, /últimos 5 días/)
	// En los últimos 5 días, sí
	s.tick(26 * 86_400_000)
	assert.equal((await s.post('/pro/checkout', { print: P1, plan: 'month' })).status, 200)
})

test('no se da por pagada si QvaPay no lo confirma, si paga menos o si el aviso es falso', async () => {
	const s = setup()
	const c = await s.post('/pro/checkout', { print: P1, plan: 'year' })
	// Un aviso cualquiera no basta: se consulta a QvaPay y sigue pendiente
	await s.post('/api/pro/webhook', { remote_id: c.body.id, status: 'paid' })
	assert.equal((await s.post('/pro/status', { print: P1 })).body.pro, false)
	// Pagó menos de lo que vale el plan
	s.q.pay('inv-1', 'ana', 1)
	assert.equal((await s.status(c.body.id)).body.status, 'pending')
	// Pagado de verdad: el aviso de QvaPay lo activa
	s.q.pay('inv-1', 'ana', 20)
	await s.post('/api/pro/webhook', { transaction_uuid: 'inv-1' })
	assert.equal((await s.post('/pro/status', { print: P1 })).body.pro, true)
})

test('cambiar de token: la huella vieja autoriza a la nueva y deja de valer', async () => {
	const s = setup()
	await buy(s)
	const r = await s.post('/pro/rotate', { from: P1, to: P2 })
	assert.equal(r.body.pro, true)
	assert.equal((await s.post('/pro/status', { print: P2 })).body.pro, true)
	assert.equal((await s.post('/pro/status', { print: P1 })).body.pro, false)
	// Una huella que no es Pro no autoriza nada
	assert.equal((await s.post('/pro/rotate', { from: P3, to: P4 })).body.pro, false)
})

test('añadir dispositivo con un código de 6 cifras: un solo uso y 5 minutos', async () => {
	const s = setup()
	await buy(s)
	assert.equal((await s.post('/pro/pair', { print: P3 })).status, 403)
	const { code } = (await s.post('/pro/pair', { print: P1 })).body
	assert.match(code, /^\d{6}$/)
	const ok = await s.post('/pro/claim', { print: P2, code })
	assert.equal(ok.body.pro, true)
	// Ya usado
	assert.equal((await s.post('/pro/claim', { print: P3, code })).status, 400)
	// Caducado
	const late = (await s.post('/pro/pair', { print: P1 })).body.code
	s.tick(5 * 60_000 + 1)
	assert.equal((await s.post('/pro/claim', { print: P3, code: late })).status, 400)
})

test(`como mucho ${PRO_DEVICES} dispositivos: el que entra expulsa al que lleva más tiempo sin usarse`, async () => {
	const s = setup()
	await buy(s)
	s.tick(1000)
	await s.post('/pro/claim', { print: P2, code: (await s.post('/pro/pair', { print: P1 })).body.code })
	s.tick(1000)
	await s.post('/pro/status', { print: P1 }) // P1 se usa: P2 queda como el más antiguo
	s.tick(1000)
	await s.post('/pro/claim', { print: P3, code: (await s.post('/pro/pair', { print: P1 })).body.code })
	const pro = async (p: string) => (await s.post('/pro/status', { print: p })).body.pro
	assert.deepEqual([await pro(P1), await pro(P2), await pro(P3)], [true, false, true])
})

test('código de respaldo: entra un dispositivo nuevo y el código cambia (uno compartido sirve una vez)', async () => {
	const s = setup()
	const { result } = await buy(s)
	const first = result.backupCode as string
	const r = await s.post('/pro/claim', { print: P2, code: first.toLowerCase().replace(/-/g, ' ') })
	assert.equal(r.body.pro, true)
	assert.notEqual(r.body.backupCode, first)
	assert.equal((await s.post('/pro/claim', { print: P3, code: first })).status, 400)
	// Desde un dispositivo Pro se puede pedir otro (y el anterior deja de valer)
	const next = (await s.post('/pro/backup', { print: P2 })).body.backupCode
	assert.equal((await s.post('/pro/claim', { print: P4, code: r.body.backupCode })).status, 400)
	assert.equal((await s.post('/pro/claim', { print: P4, code: next })).body.pro, true)
})

test('el módulo Pro sale firmado con el usuario, y nunca sin licencia válida o revocada', async () => {
	const store = new Map([['module.js', 'console.log("pro")']])
	const s = setup({ PRO: { get: async (k) => store.get(k) ?? null } })
	const { result } = await buy(s)
	const mod = await s.get(`/pro/module.js?l=${encodeURIComponent(result.license)}`)
	assert.equal(mod.status, 200)
	assert.match(mod.body, /licencia de @ana \(u-ana\)/)
	assert.match(mod.body, /window\.TPProUser="ana"/)
	assert.match(mod.body, /console\.log\("pro"\)$/)
	assert.equal((await s.get('/pro/module.js?l=falsa')).status, 403)
	// La licencia firmada caduca en un día
	s.tick(86_400_000 + 1)
	assert.equal((await s.get(`/pro/module.js?l=${encodeURIComponent(result.license)}`)).status, 403)
})

test('panel: regalar una licencia (con código para activarla) y revocarla', async () => {
	const s = setup()
	const form = (fields: Record<string, string>, auth = 'panel') =>
		proAdmin(new Request('https://app.terminalp2p.com/admin/pro', { method: 'POST', headers: { Authorization: `Basic ${btoa(`x:${auth}`)}` }, body: new URLSearchParams(fields) }), s.env, T0)
	assert.equal((await form({ action: 'gift', username: 'leo' }, 'mala')).status, 401)
	const html = await (await form({ action: 'gift', username: '@leo', days: '7' })).text()
	const code = html.match(/TP-[2-9A-Z]{4}-[2-9A-Z]{4}-[2-9A-Z]{4}/)![0]
	assert.equal((await s.post('/pro/claim', { print: P1, code })).body.pro, true)
	await form({ action: 'revoke', uuid: 'gift:leo' })
	assert.equal((await s.post('/pro/status', { print: P1 })).body.pro, false)
})

test('sin credenciales de QvaPay no se puede comprar, y una huella mal formada se rechaza', async () => {
	const s = setup({ QVAPAY_APP_SECRET: undefined })
	assert.equal((await s.post('/pro/checkout', { print: P1, plan: 'month' })).status, 503)
	assert.equal((await s.post('/pro/status', { print: 'token-en-claro' })).status, 400)
	assert.equal((await s.post('/pro/checkout', { print: P1, plan: 'vitalicio' })).status, 400)
})

test('huella del token: siempre la misma para el mismo token, distinta entre tokens y sin revelarlo', async () => {
	const { tokenPrint } = await import('../web/accounts.ts')
	const a = await tokenPrint('1234|secreto')
	assert.match(a, /^[0-9a-f]{64}$/)
	assert.equal(await tokenPrint('1234|secreto'), a)
	assert.notEqual(await tokenPrint('1234|otro'), a)
	assert.ok(!a.includes('secreto'))
})

test('simulador: sin Pro solo BTC y ETH (y vender lo que ya tienes); con Pro, todos los mercados', async () => {
	const { canTrade } = await import('../worker/sim.ts')
	const s = setup()
	s.db.prepare("INSERT INTO sim_users (tg_id, first_name, created_at, last_login) VALUES (7, 'Ana', 0, 0)").run()
	const ok = (sym: string, side = 'BUY') => canTrade(s.env.DB, 7, sym as never, side, T0)
	assert.deepEqual([await ok('BTCUSDT'), await ok('ETHUSDT'), await ok('SOLUSDT'), await ok('SOLUSDT', 'SELL'), await ok('PEPEUSDT', 'SHORT')], [true, true, false, true, false])
	// Vincula su Telegram con un código de 6 cifras de su terminal Pro
	await buy(s)
	const { claimCode, linkSim } = await import('../worker/pro.ts')
	const { code } = (await s.post('/pro/pair', { print: P1 })).body
	const got = await claimCode(s.env.DB, code, T0)
	await linkSim(s.env.DB, 7, got!.license)
	assert.deepEqual([await ok('SOLUSDT'), await ok('TAOUSDT', 'SHORT')], [true, true])
	// Si la licencia vence, vuelve a BTC y ETH
	assert.equal(await canTrade(s.env.DB, 7, 'SOLUSDT' as never, 'BUY', T0 + 31 * 86_400_000), false)
})

test('simulador: hacerse Pro desde el simulador vincula esa cuenta de Telegram y da el código para el terminal', async () => {
	const { createCheckout, checkoutStatus } = await import('../worker/pro.ts')
	const { canTrade } = await import('../worker/sim.ts')
	const s = setup()
	s.db.prepare("INSERT INTO sim_users (tg_id, first_name, created_at, last_login) VALUES (9, 'Leo', 0, 0)").run()
	const c = await createCheckout(s.env, { tg: 9 }, 'year', 'https://sim.terminalp2p.com', T0, s.q.fetcher)
	assert.equal(s.q.invoices.get('inv-1')?.amount, 20)
	s.q.pay('inv-1', 'leo')
	const { checkout, body: raw } = await checkoutStatus(s.env, c.id, { tg: 9 }, T0, s.q.fetcher)
	const body = raw as { status: string; backupCode: string }
	assert.equal(checkout.tg, 9)
	assert.equal(body.status, 'paid')
	assert.match(body.backupCode, /^TP-/)
	assert.equal(await canTrade(s.env.DB, 9, 'DOGEUSDT' as never, 'BUY', T0), true)
	// Con ese código, el terminal también queda Pro
	assert.equal((await s.post('/pro/claim', { print: P2, code: body.backupCode })).body.pro, true)
})

test('primer mes gratis: una vez por usuario de QvaPay y por dispositivo; si paga, los días que quedaban se suman', async () => {
	const s = setup()
	const r = await s.post('/pro/trial', { print: P1, username: 'Ana' })
	assert.deepEqual([r.status, r.body.pro, r.body.plan, r.body.expiresAt], [200, true, 'trial', T0 + 30 * 86_400_000])
	// Otro token (otro dispositivo) con el mismo usuario: no hay otro mes gratis
	assert.equal((await s.post('/pro/trial', { print: P2, username: 'ana' })).status, 409)
	// Ni otro usuario desde el mismo dispositivo
	assert.equal((await s.post('/pro/trial', { print: P1, username: 'leo' })).status, 409)
	// A los 10 días paga el plan mensual: le quedaban 20 días de prueba, que se suman
	s.tick(10 * 86_400_000)
	const c = await s.post('/pro/checkout', { print: P1, plan: 'month' })
	s.q.pay([...s.q.invoices.keys()].at(-1)!, 'ana')
	const paid = (await s.status(c.body.id)).body
	assert.equal(paid.plan, 'month')
	assert.equal(paid.expiresAt, T0 + 30 * 86_400_000 + 30 * 86_400_000)
})

test('primer mes gratis en el simulador: una vez por cuenta de Telegram', async () => {
	const { startTrial, linkSim } = await import('../worker/pro.ts')
	const { canTrade } = await import('../worker/sim.ts')
	const s = setup()
	s.db.prepare("INSERT INTO sim_users (tg_id, first_name, created_at, last_login) VALUES (5, 'Eva', 0, 0)").run()
	await startTrial(s.env.DB, 'trial:tg:5', 'Eva', ['tg:5'], T0)
	await linkSim(s.env.DB, 5, 'trial:tg:5')
	assert.equal(await canTrade(s.env.DB, 5, 'SOLUSDT' as never, 'BUY', T0), true)
	await assert.rejects(startTrial(s.env.DB, 'trial:tg:5', 'Eva', ['tg:5'], T0 + 31 * 86_400_000), /Ya usaste tu mes gratis/)
	assert.equal(await canTrade(s.env.DB, 5, 'SOLUSDT' as never, 'BUY', T0 + 31 * 86_400_000), false)
})

test('panel: devolver un pago revoca la licencia (también en el simulador) y dice cuánto transferir', async () => {
	const s = setup()
	const { checkout } = await buy(s)
	s.db.prepare("INSERT INTO sim_users (tg_id, first_name, created_at, last_login, pro_license) VALUES (3, 'Ana', 0, 0, 'u-ana')").run()
	const form = (fields: Record<string, string>) =>
		proAdmin(new Request('https://app.terminalp2p.com/admin/pro', { method: 'POST', headers: { Authorization: `Basic ${btoa('x:panel')}` }, body: new URLSearchParams(fields) }), s.env, T0)
	const html = await (await form({ action: 'refund', checkout: checkout.id })).text()
	assert.match(html, /transfiere <b>1,99 USD<\/b> a <b>@ana<\/b>/)
	assert.equal((await s.post('/pro/status', { print: P1 })).body.pro, false)
	assert.equal((s.db.prepare('SELECT pro_license FROM sim_users WHERE tg_id = 3').get() as { pro_license: string | null }).pro_license, null)
	// No se devuelve dos veces
	assert.match(await (await form({ action: 'refund', checkout: checkout.id })).text(), /ya se devolvió/)
})

test('factura pagada sin que nadie la mire: la confirma la consulta de estado del dispositivo o el cron', async () => {
	const { settlePending } = await import('../worker/pro.ts')
	const s = setup()
	// Pide la factura, cierra la pestaña y paga desde el móvil: al volver, la consulta de estado la confirma
	await s.post('/pro/checkout', { print: P1, plan: 'month' })
	s.q.pay('inv-1', 'ana')
	const st = (await s.post('/pro/status', { print: P1 })).body
	assert.deepEqual([st.pro, st.username], [true, 'ana'])
	// Otro dispositivo paga y nadie vuelve: el cron la confirma igual
	await s.post('/pro/checkout', { print: P2, plan: 'month' })
	s.q.pay('inv-2', 'leo')
	await settlePending(s.env, s.now(), {}, s.q.fetcher)
	assert.equal(s.db.prepare("SELECT status FROM pro_checkouts WHERE invoice = 'inv-2'").get()?.status, 'paid')
	// Las facturas de hace más de una hora ya no se consultan
	await s.post('/pro/checkout', { print: P3, plan: 'month' })
	s.tick(61 * 60_000)
	const before = s.q.calls.length
	await settlePending(s.env, s.now(), {}, s.q.fetcher)
	assert.equal(s.q.calls.length, before)
})

test('pide una factura, luego otra, y paga la primera: la pantalla que espera la segunda también se entera', async () => {
	const s = setup()
	const first = (await s.post('/pro/checkout', { print: P1, plan: 'month' })).body
	s.tick(60_000)
	const second = (await s.post('/pro/checkout', { print: P1, plan: 'year' })).body
	s.tick(60_000)
	s.q.pay('inv-1', 'ana')
	const r = (await s.status(second.id)).body
	assert.deepEqual([r.status, r.pro], ['paid', true])
	assert.match(r.backupCode, /^TP-/)
	assert.equal((await s.status(first.id)).body.backupCode, null)
	// Al renovar, el pago anterior (de antes de pedir esta) no cuenta como pago de esta
	s.tick(26 * 86_400_000)
	const renewal = (await s.post('/pro/checkout', { print: P1, plan: 'month' })).body
	assert.equal((await s.status(renewal.id)).body.status, 'pending')
})

test('el estado de una factura solo se lo da a quien la pidió: otro no se lleva el código de respaldo', async () => {
	const { checkoutStatus } = await import('../worker/pro.ts')
	const s = setup()
	const c = (await s.post('/pro/checkout', { print: P1, plan: 'month' })).body
	s.q.pay('inv-1', 'ana')
	assert.equal((await s.status(c.id, P2)).status, 404)
	await assert.rejects(checkoutStatus(s.env, c.id, { tg: 1 }, s.now(), s.q.fetcher), /Pago no encontrado/)
	// El dueño sigue recibiendo su código
	assert.match((await s.status(c.id)).body.backupCode, /^TP-/)
	// Ya no hay consulta por GET con solo el identificador
	assert.equal((await s.get(`/pro/checkout?id=${c.id}`)).status, 404)
})

test('panel: quién pagó, desde dónde se pidió, facturas sin pagar (comprobables a mano) y licencias con su detalle', async () => {
	const { createCheckout } = await import('../worker/pro.ts')
	const s = setup()
	s.db.prepare("INSERT INTO sim_users (tg_id, first_name, username, created_at, last_login) VALUES (9, 'Leo', 'leo_tg', 0, 0)").run()
	// Leo la pide en el simulador y la paga otra cuenta de QvaPay (@pepe)
	await createCheckout(s.env, { tg: 9 }, 'month', 'https://sim.terminalp2p.com', T0, s.q.fetcher)
	s.q.pay('inv-1', 'pepe')
	// Otra se pide en el terminal y queda sin confirmar (nadie la mira y pasa más de una hora)
	await s.post('/pro/checkout', { print: P1, plan: 'year' })
	s.tick(2 * 60 * 60_000)
	const panel = (fields?: Record<string, string>, query = '') =>
		proAdmin(
			new Request(`https://app.terminalp2p.com/admin/pro${query}`, { method: fields ? 'POST' : 'GET', headers: { Authorization: `Basic ${btoa('x:panel')}` }, body: fields ? new URLSearchParams(fields) : undefined }),
			s.env,
			s.now(),
			s.q.fetcher,
		).then((r) => r.text())
	let html = await panel()
	assert.match(html, /Facturas sin pagar/)
	assert.match(html, /Simulador · @leo_tg/)
	assert.match(html, /Terminal · <span/)
	assert.match(html, /caducada/)
	// Comprobar a mano: QvaPay la da por pagada y se activa
	const id = (s.db.prepare("SELECT id FROM pro_checkouts WHERE invoice = 'inv-1'").get() as { id: string }).id
	assert.match(await panel({ action: 'check', checkout: id }), /ya está activada/)
	html = await panel()
	assert.match(html, /<b>@pepe<\/b>/)
	assert.match(html, /@leo_tg/) // la cuenta del simulador vinculada a la licencia de @pepe
	assert.match(html, /Ingresos totales<\/span><b>1,99 USD/)
	// Buscar por usuario
	assert.doesNotMatch(await panel(undefined, '?q=nadie'), /<b>@pepe<\/b>/)
	assert.match(await panel(undefined, '?q=PEPE'), /<b>@pepe<\/b>/)
})
