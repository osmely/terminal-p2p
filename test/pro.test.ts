import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { readWho, tokenPrint, whoCookie, whoToken } from '../worker/session.ts'
import { PRO_DEVICES, proAdmin, proApi, type ProEnv } from '../worker/pro.ts'

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
		// Listado de facturas de la app, las más recientes primero (como QvaPay)
		if (url.endsWith('/v2/transactions')) {
			const { page = 1, take = 30 } = JSON.parse(String(init?.body ?? '{}'))
			const list = [...invoices].reverse().map(([uuid, i]) => ({ uuid, remote_id: i.remote_id, amount: i.amount, status: i.status, created_at: new Date(T0).toISOString() }))
			return Response.json({ transactions: list.slice((page - 1) * take, page * take) })
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
	// `username` en el cuerpo hace de la cuenta que QvaPay confirmó al pasar el perfil por el relé (cookie tpw)
	const call = async (method: string, path: string, body?: unknown) => {
		const req = new Request(`https://app.terminalp2p.com${path}`, { method, headers: { 'Content-Type': 'application/json', ...(await whoHeader(body, now)) }, body: body === undefined ? undefined : JSON.stringify(body) })
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

test('con días de Pro de sobra no se compran más hasta que queden 5; una factura pendiente de los mismos días se reutiliza', async () => {
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
	assert.match(r.body.error, /cuando te queden 5 o menos/)
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
	assert.match(mod.body, /licencia de @ana \(qp:ana\)/)
	assert.match(mod.body, /window\.TPProUser="ana"/)
	assert.match(mod.body, /console\.log\("pro"\)$/)
	assert.equal((await s.get('/pro/module.js?l=falsa')).status, 403)
	// La licencia firmada caduca en un día
	s.tick(86_400_000 + 1)
	assert.equal((await s.get(`/pro/module.js?l=${encodeURIComponent(result.license)}`)).status, 403)
})

test('panel: regalar una licencia (con código para activarla), revocarla y restaurarla', async () => {
	const s = setup()
	const form = (fields: Record<string, string>, auth = 'panel') =>
		proAdmin(new Request('https://app.terminalp2p.com/admin/pro', { method: 'POST', headers: { Authorization: `Basic ${btoa(`x:${auth}`)}` }, body: new URLSearchParams(fields) }), s.env, T0)
	assert.equal((await form({ action: 'gift', username: 'leo' }, 'mala')).status, 401)
	const html = await (await form({ action: 'gift', username: '@leo', days: '7' })).text()
	const code = html.match(/TP-[2-9A-Z]{4}-[2-9A-Z]{4}-[2-9A-Z]{4}/)![0]
	assert.equal((await s.post('/pro/claim', { print: P1, code })).body.pro, true)
	await form({ action: 'revoke', uuid: 'gift:leo' })
	assert.equal((await s.post('/pro/status', { print: P1 })).body.pro, false)
	// Restaurar la deja como estaba: el mismo dispositivo vuelve a ser Pro sin hacer nada
	await form({ action: 'restore', uuid: 'gift:leo' })
	assert.equal((await s.post('/pro/status', { print: P1 })).body.pro, true)
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

test('30 días gratis al conectar la cuenta: una vez por usuario de QvaPay y por dispositivo; si compra, los días que quedaban se suman', async () => {
	const s = setup()
	// Sin usuario conectado (solo la huella) no se activa nada
	assert.equal((await s.post('/pro/status', { print: P1 })).body.pro, false)
	const r = await s.post('/pro/status', { print: P1, username: 'Ana' })
	assert.deepEqual([r.body.pro, r.body.plan, r.body.expiresAt, r.body.started], [true, 'trial', T0 + 30 * 86_400_000, true])
	// La siguiente consulta ya no los vuelve a dar
	assert.equal((await s.post('/pro/status', { print: P1, username: 'Ana' })).body.started, false)
	// Otro token (otro dispositivo) con la misma cuenta: entra solo en sus mismos días, sin otros 30
	const other = (await s.post('/pro/status', { print: P2, username: 'ana' })).body
	assert.deepEqual([other.pro, other.started, other.expiresAt], [true, false, T0 + 30 * 86_400_000])
	// Ni otro usuario desde el mismo dispositivo (que además ya tiene sus días)
	assert.equal((await s.post('/pro/status', { print: P3, username: 'leo' })).body.started, true)
	assert.equal((await s.post('/pro/status', { print: P3, username: 'eva' })).body.started, false)
	// A los 10 días compra 30 días: le quedaban 20 gratis, que se suman
	s.tick(10 * 86_400_000)
	const c = await s.post('/pro/checkout', { print: P1, plan: 'month' })
	s.q.pay([...s.q.invoices.keys()].at(-1)!, 'ana')
	const paid = (await s.status(c.body.id)).body
	assert.equal(paid.plan, 'month')
	assert.equal(paid.expiresAt, T0 + 30 * 86_400_000 + 30 * 86_400_000)
})

test('panel: devolver un pago revoca la licencia y dice cuánto transferir', async () => {
	const s = setup()
	const { checkout } = await buy(s)
	const form = (fields: Record<string, string>) =>
		proAdmin(new Request('https://app.terminalp2p.com/admin/pro', { method: 'POST', headers: { Authorization: `Basic ${btoa('x:panel')}` }, body: new URLSearchParams(fields) }), s.env, T0)
	const html = await (await form({ action: 'refund', checkout: checkout.id })).text()
	assert.match(html, /transfiere <b>1,99 USD<\/b> a <b>@ana<\/b>/)
	assert.equal((await s.post('/pro/status', { print: P1 })).body.pro, false)
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
	const s = setup()
	const c = (await s.post('/pro/checkout', { print: P1, plan: 'month' })).body
	s.q.pay('inv-1', 'ana')
	assert.equal((await s.status(c.id, P2)).status, 404)
	// El dueño sigue recibiendo su código
	assert.match((await s.status(c.id)).body.backupCode, /^TP-/)
	// Ya no hay consulta por GET con solo el identificador
	assert.equal((await s.get(`/pro/checkout?id=${c.id}`)).status, 404)
})

test('panel: quién pagó, desde dónde se pidió, facturas sin pagar (comprobables a mano) y licencias con su detalle', async () => {
	const s = setup()
	// @leo la pide en el terminal y la paga otra cuenta de QvaPay (@pepe)
	await s.post('/pro/checkout', { print: P2, plan: 'month', username: 'leo' })
	s.q.pay('inv-1', 'pepe')
	// Otra se pide desde un dispositivo sin cuenta conocida y queda sin confirmar (nadie la mira y pasa más de una hora)
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
	assert.match(html, /Terminal · @leo/)
	assert.match(html, /Terminal · <span/)
	assert.match(html, /caducada/)
	// Comprobar a mano: QvaPay la da por pagada y se activa
	const id = (s.db.prepare("SELECT id FROM pro_checkouts WHERE invoice = 'inv-1'").get() as { id: string }).id
	assert.match(await panel({ action: 'check', checkout: id }), /ya está activada/)
	html = await panel()
	assert.match(html, /<b>@pepe<\/b> <span class="note">para @leo<\/span>/)
	assert.match(html, /Ingresos totales<\/span><b>1,99 USD/)
	// Buscar por usuario
	assert.doesNotMatch(await panel(undefined, '?q=nadie'), /<b>@pepe<\/b>/)
	assert.match(await panel(undefined, '?q=PEPE'), /<b>@pepe<\/b>/)
})

test('paga otra cuenta (otra sesión abierta en qvapay.com): Pro queda a nombre de la conectada y la devolución va a quien pagó', async () => {
	const s = setup()
	// Conectado como @Ana en el terminal, pero en qvapay.com estaba abierta la sesión de @pepe
	const c = (await s.post('/pro/checkout', { print: P1, plan: 'month', username: '@Ana' })).body
	s.q.pay('inv-1', 'pepe')
	const r = (await s.status(c.id)).body
	assert.deepEqual([r.status, r.pro, r.username], ['paid', true, 'Ana'])
	// Si luego Ana paga con su propia cuenta, renueva la misma licencia
	s.tick(27 * 86_400_000)
	const c2 = (await s.post('/pro/checkout', { print: P1, plan: 'month', username: 'Ana' })).body
	s.q.pay('inv-2', 'ana')
	assert.equal((await s.status(c2.id)).body.expiresAt, T0 + 60 * 86_400_000)
	assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM pro_licenses').get()?.n, 1)
	// En el panel: pagó @pepe para @Ana; devolver el primer pago es transferir a @pepe
	const form = (fields?: Record<string, string>) =>
		proAdmin(
			new Request('https://app.terminalp2p.com/admin/pro', { method: fields ? 'POST' : 'GET', headers: { Authorization: `Basic ${btoa('x:panel')}` }, body: fields ? new URLSearchParams(fields) : undefined }),
			s.env,
			s.now(),
		).then((x) => x.text())
	assert.match(await form(), /<b>@pepe<\/b> <span class="note">para @Ana<\/span>/)
	assert.match(await form({ action: 'refund', checkout: c.id }), /transfiere <b>1,99 USD<\/b> a <b>@pepe<\/b>/)
})

test('repaso diario con QvaPay: activa un pago que se quedó sin activar y recupera uno que aquí no consta', async () => {
	const { reconcile, recover } = await import('../worker/pro.ts')
	const s = setup()
	// Se pide y se paga, pero nadie lo mira en la primera hora (y el cron ya no lo revisa)
	await s.post('/pro/checkout', { print: P1, plan: 'month', username: 'ana' })
	s.q.pay('inv-1', 'ana')
	s.tick(5 * 60 * 60_000)
	// Otro pago cuya fila se perdió aquí (como si se perdiera la base)
	await s.post('/pro/checkout', { print: P2, plan: 'year', username: 'leo' })
	s.q.pay('inv-2', 'leo')
	s.db.prepare("DELETE FROM pro_checkouts WHERE invoice = 'inv-2'").run()
	const r = await reconcile(s.env, s.now(), s.q.fetcher)
	assert.equal(r.checked, 2)
	assert.equal(r.activated.length, 1)
	assert.equal((await s.post('/pro/status', { print: P1 })).body.pro, true)
	assert.deepEqual(r.unknown.map((u) => [u.invoice, u.payer, u.amount]), [['inv-2', 'leo', 20]])
	// Se recupera desde lo que dice QvaPay: 365 días para quien pagó, con la devolución posible
	assert.deepEqual(await recover(s.env, 'inv-2', s.now(), s.q.fetcher), { username: 'leo', plan: 'year' })
	const lic = s.db.prepare("SELECT username, plan, expires_at FROM pro_licenses WHERE uuid = 'qp:leo'").get() as { username: string; plan: string; expires_at: number }
	assert.deepEqual([lic.username, lic.plan, lic.expires_at], ['leo', 'year', s.now() + 365 * 86_400_000])
	assert.equal((s.db.prepare("SELECT payer FROM pro_checkouts WHERE invoice = 'inv-2'").get() as { payer: string }).payer, 'leo')
	// Un segundo repaso ya no encuentra nada pendiente
	const again = await reconcile(s.env, s.now(), s.q.fetcher)
	assert.deepEqual([again.activated.length, again.unknown.length], [0, 0])
})

test('copias: CSV de pagos con quién pagó, copia completa sin códigos de respaldo y copia diaria en el KV', async () => {
	const { backupPro } = await import('../worker/pro.ts')
	const kv = new Map<string, { value: string; ttl?: number }>()
	const s = setup({ PRO: { get: async (k: string) => kv.get(k)?.value ?? null, put: async (k: string, value: string, o?: { expirationTtl?: number }) => void kv.set(k, { value, ttl: o?.expirationTtl }) } })
	const c = (await s.post('/pro/checkout', { print: P1, plan: 'month', username: 'Ana' })).body
	s.q.pay('inv-1', 'pepe')
	await s.status(c.id)
	const get = (q: string) => proAdmin(new Request(`https://app.terminalp2p.com/admin/pro?${q}`, { headers: { Authorization: `Basic ${btoa('x:panel')}` } }), s.env, s.now())
	const csv = await (await get('export=pagos')).text()
	const [head, row] = csv.trim().split('\n')
	assert.equal(head, 'pagado,pago,pago_uuid,para,dias,importe_usd,factura_qvapay,id,devuelto')
	assert.match(row, /,pepe,u-pepe,Ana,30,1.99,inv-1,pro-/)
	const copy = JSON.parse(await (await get('export=copia')).text())
	assert.equal(copy.checkouts.length, 1)
	assert.equal('backup_code' in copy.checkouts[0], false)
	assert.equal(copy.licenses[0].uuid, 'qp:ana')
	// Sin la clave del panel no se descarga nada
	assert.equal((await proAdmin(new Request('https://app.terminalp2p.com/admin/pro?export=pagos'), s.env, s.now())).status, 401)
	const key = await backupPro(s.env, s.now())
	assert.equal(key, `backup/pro/${new Date(s.now()).toISOString().slice(0, 10)}`)
	assert.equal(kv.get(key!)?.ttl, 120 * 86_400)
	assert.equal(JSON.parse(kv.get(key!)!.value).checkouts[0].payer, 'pepe')
})

test('ningún código ni migración borra licencias, pagos o días gratis usados', () => {
	const sources = [...readdirSync('worker').map((f) => `worker/${f}`), ...readdirSync('migrations').map((f) => `migrations/${f}`)]
	for (const f of sources) {
		const text = readFileSync(f, 'utf8')
		assert.doesNotMatch(text, /DELETE\s+FROM\s+pro_(licenses|checkouts|trials)\b/i, f)
		assert.doesNotMatch(text, /DROP\s+TABLE\s+(IF\s+EXISTS\s+)?pro_/i, f)
	}
})

test('topes contra abusos: días gratis por IP y día, facturas pendientes en total y códigos de 6 cifras por minuto', async () => {
	const { TRIAL_PER_IP_DAY, PENDING_MAX } = await import('../worker/pro.ts')
	const s = setup()
	// Desde la misma IP, solo TRIAL_PER_IP_DAY cuentas nuevas reciben días gratis ese día
	const got: boolean[] = []
	for (let i = 0; i < TRIAL_PER_IP_DAY + 2; i++) got.push((await s.post('/pro/status', { print: i.toString(16).padStart(64, 'e'), username: `nuevo${i}` })).body.started)
	assert.equal(got.filter(Boolean).length, TRIAL_PER_IP_DAY)
	assert.deepEqual(got.slice(-2), [false, false])
	// Al día siguiente, vuelve a haber cupo (y la limpieza borra las huellas viejas)
	s.tick(86_400_000)
	assert.equal((await s.post('/pro/status', { print: 'f'.repeat(64), username: 'otroDia' })).body.started, true)
	const { cleanupPro } = await import('../worker/pro.ts')
	s.tick(3 * 86_400_000)
	await cleanupPro(s.env.DB, s.now())
	assert.equal((s.db.prepare('SELECT COUNT(*) AS n FROM pro_trial_ips').get() as { n: number }).n, 0)
	// Con demasiadas facturas pendientes en la última hora, no se crean más
	const ins = s.db.prepare("INSERT INTO pro_checkouts (id, print, plan, amount, invoice, status, created_at) VALUES (?, ?, 'month', 1.99, ?, 'pending', ?)")
	for (let i = 0; i < PENDING_MAX; i++) ins.run(`pro-x${i}`, 'x', `inv-x${i}`, s.now())
	const r = await s.post('/pro/checkout', { print: P1, plan: 'month' })
	assert.equal(r.status, 503)
	// Códigos de 6 cifras: el tope global corta los intentos; el de respaldo no cuenta
	const capped = setup({ PAIR_LIMIT: { limit: async () => ({ success: false }) } })
	assert.equal((await capped.post('/pro/claim', { print: P1, code: '123 456' })).status, 429)
	assert.equal((await capped.post('/pro/claim', { print: P1, code: 'TP-AAAA-BBBB-CCCC' })).status, 400)
})

test('la cuenta la confirma QvaPay: el usuario que diga el navegador no cuenta, y un dispositivo nuevo con tu cuenta entra solo en tu Pro', async () => {
	const s = setup()
	// Un usuario escrito en el cuerpo, sin la cookie del relé, no activa días gratis ni gasta los de nadie
	const req = new Request('https://app.terminalp2p.com/pro/status', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ print: P4, username: 'ana' }) })
	assert.equal((await (await proApi(req, new URL(req.url), s.env, s.now(), s.q.fetcher))!.json()).started, false)
	assert.equal((await s.post('/pro/status', { print: P1, username: 'ana' })).body.started, true)
	// Una cookie de identidad de otra huella (otro token) no vale para esta
	const stolen = await whoToken(P1, 'u-ana', 'ana', 'clave', s.now())
	const req2 = new Request('https://app.terminalp2p.com/pro/status', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: `tpw=${stolen}` }, body: JSON.stringify({ print: P3 }) })
	assert.equal((await (await proApi(req2, new URL(req2.url), s.env, s.now(), s.q.fetcher))!.json()).pro, false)
	// Ana compra en P1; en P2 conecta su cuenta y ya es Pro, sin código de 6 cifras
	await buy(s, P1, 'month', 'ana')
	const p2 = (await s.post('/pro/status', { print: P2, username: 'ana' })).body
	assert.deepEqual([p2.pro, p2.plan], [true, 'month'])
	// Sin tope de dispositivos para los suyos: P1 sigue dentro, y un tercero también
	assert.equal((await s.post('/pro/status', { print: P4, username: 'Ana' })).body.pro, true)
	assert.equal((await s.post('/pro/status', { print: P1 })).body.pro, true)
	// Comprar «para otra cuenta» ya no se puede: la factura va a la cuenta confirmada de quien la pide
	const c = (await s.post('/pro/checkout', { print: P3, plan: 'month', username: 'leo' })).body
	s.q.pay([...s.q.invoices.keys()].at(-1)!, 'leo')
	await s.status(c.id, P3)
	assert.deepEqual({ ...s.db.prepare("SELECT license FROM pro_prints WHERE print = ?").get(P3) }, { license: "qp:leo" })
})

test('el relé deja firmada la cuenta del perfil de QvaPay junto a la huella de ese mismo token', async () => {
	const url = new URL('https://app.terminalp2p.com/qp/user')
	const token = '123|tokenDePrueba'
	const set = (await whoCookie(url, `Bearer ${token}`, { uuid: '9d7c6f2e-1111-4222-8333-944455556666', username: 'Ana', balance: 5 }, 'clave', T0))!
	assert.match(set, /^tpw=[^;]+; HttpOnly; SameSite=Lax; Path=\/; Max-Age=\d+; Domain=terminalp2p\.com; Secure$/)
	const cookie = set.split(';')[0]
	const print = await tokenPrint(token)
	assert.deepEqual(await readWho(cookie, print, 'clave', T0), { print, uuid: '9d7c6f2e-1111-4222-8333-944455556666', username: 'Ana' })
	// Ni con otra huella, ni firmada con otra clave (staging/producción), ni caducada
	assert.equal(await readWho(cookie, P1, 'clave', T0), null)
	assert.equal(await readWho(cookie, print, 'otra', T0), null)
	assert.equal(await readWho(cookie, print, 'clave', T0 + 31 * 86_400_000), null)
	// Sin token o con una respuesta que no es un perfil, nada
	assert.equal(await whoCookie(url, null, { uuid: '9d7c6f2e-1111-4222-8333-944455556666', username: 'Ana' }, 'clave'), null)
	assert.equal(await whoCookie(url, `Bearer ${token}`, { error: 'Unauthenticated' }, 'clave'), null)
})
