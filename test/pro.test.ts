import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { readWho, tokenPrint, whoCookie, whoToken } from '../worker/session.ts'
import { proAdmin as proAdminRaw, proApi, type ProEnv } from '../worker/pro.ts'

// El panel responde a cada acción con una redirección (303) y lo que dijo en una cookie: se sigue como el navegador
async function proAdmin(req: Request, env: ProEnv, now?: number, fetcher?: typeof fetch) {
	const res = await proAdminRaw(req, env, now, fetcher)
	if (res.status !== 303) return res
	const cookie = res.headers.get('set-cookie')?.split(';')[0]
	return proAdminRaw(new Request(new URL(res.headers.get('location')!, req.url), { headers: { Authorization: req.headers.get('authorization')!, ...(cookie ? { Cookie: cookie } : {}) } }), env, now, fetcher)
}

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
	// Avisos a Telegram: se apuntan aquí
	const telegram: { chat_id: string; text: string; url: string }[] = []
	const fetcher = (async (input: string | URL, init?: RequestInit) => {
		const url = String(input)
		if (url.startsWith('https://api.telegram.org/')) {
			if (url.endsWith('/getMe')) return Response.json({ ok: true, result: { username: 'TerminalP2PBot' } })
			const b = JSON.parse(String(init?.body))
			if (url.endsWith('/setWebhook')) {
				telegram.push({ chat_id: 'webhook', text: b.url, url: b.secret_token })
				return Response.json({ ok: true, description: 'Webhook was set' })
			}
			telegram.push({ chat_id: b.chat_id, text: b.text, url: b.reply_markup?.inline_keyboard?.[0]?.[0]?.url })
			return Response.json({ ok: true })
		}
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
	return { fetcher, pay, calls, invoices, telegram }
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

test('comprar: factura de QvaPay y quién pagó lo confirma QvaPay', async () => {
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
	assert.equal(r.expiresAt, T0 + 30 * 86_400_000)
	// Ya no hay códigos de respaldo: Pro va con la cuenta
	assert.equal('backupCode' in r, false)
	const st = (await s.post('/pro/status', { print: P1 })).body
	assert.deepEqual([st.pro, st.username, st.plan], [true, 'ana', 'month'])
	// En la base: el usuario y la huella, nunca un token
	assert.deepEqual({ ...s.db.prepare('SELECT username, plan FROM pro_licenses').get() }, { username: 'ana', plan: 'month' })
})

test('renovar suma el periodo', async () => {
	const s = setup()
	await buy(s)
	s.tick(26 * 86_400_000)
	const { result } = await buy(s, P1, 'year')
	assert.equal(result.expiresAt, T0 + (30 + 365) * 86_400_000)
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

test('panel: dar días con motivo (se activan al conectar su cuenta), quitarlos, suspender y reactivar', async () => {
	const s = setup()
	const form = (fields: Record<string, string>, auth = 'panel') =>
		proAdmin(new Request('https://app.terminalp2p.com/admin/pro', { method: 'POST', headers: { Origin: 'https://app.terminalp2p.com', Authorization: `Basic ${btoa(`x:${auth}`)}` }, body: new URLSearchParams(fields) }), s.env, T0)
	assert.equal((await form({ action: 'days', username: 'leo', days: '7', note: 'x' }, 'mala')).status, 401)
	// Sin motivo no se apunta
	assert.match(await (await form({ action: 'days', username: '@leo', days: '7' })).text(), /Escribe el motivo/)
	assert.match(await (await form({ action: 'days', username: '@leo', days: '7', note: 'compensación por el fallo del 3/11' })).text(), /7 días para <b>@leo<\/b>/)
	const st = (await s.post('/pro/status', { print: P1, username: 'leo' })).body
	assert.deepEqual([st.pro, st.plan, st.started, st.expiresAt], [true, 'gift', false, T0 + 7 * 86_400_000])
	// Quitar días: no lo deja antes de hoy
	await form({ action: 'days', username: 'leo', days: '-3', note: 'me pasé' })
	assert.equal((await s.post('/pro/status', { print: P1 })).body.expiresAt, T0 + 4 * 86_400_000)
	await form({ action: 'days', username: 'leo', days: '-30', note: 'quitar todo' })
	assert.equal((await s.post('/pro/status', { print: P1 })).body.pro, false)
	await form({ action: 'days', username: 'leo', days: '10', note: 'otra vez' })
	// Suspender corta Pro sin tocar sus días ni dispositivos; reactivar lo deja igual
	await form({ action: 'revoke', uuid: 'qp:leo' })
	assert.equal((await s.post('/pro/status', { print: P1 })).body.pro, false)
	await form({ action: 'restore', uuid: 'qp:leo' })
	assert.equal((await s.post('/pro/status', { print: P1 })).body.expiresAt, T0 + 10 * 86_400_000)
	// Todo queda en el libro, con motivo y saldo de antes y después
	const moves = s.db.prepare("SELECT kind, days, note, actor FROM pro_days WHERE license = 'qp:leo' ORDER BY id").all().map((r) => ({ ...r }))
	assert.deepEqual(moves, [
		{ kind: 'gift', days: 7, note: 'compensación por el fallo del 3/11', actor: 'admin' },
		{ kind: 'adjust', days: -3, note: 'me pasé', actor: 'admin' },
		{ kind: 'adjust', days: -30, note: 'quitar todo', actor: 'admin' },
		{ kind: 'gift', days: 10, note: 'otra vez', actor: 'admin' },
	])
})

test('devolver una compra quita solo los días de esa compra; el resto y los dispositivos se quedan', async () => {
	const s = setup()
	const form = (fields: Record<string, string>) =>
		proAdmin(new Request('https://app.terminalp2p.com/admin/pro', { method: 'POST', headers: { Origin: 'https://app.terminalp2p.com', Authorization: `Basic ${btoa('x:panel')}` }, body: new URLSearchParams(fields) }), s.env, s.now())
	await buy(s, P1, 'month')
	s.tick(26 * 86_400_000)
	const { checkout } = await buy(s, P1, 'year')
	// 4 días del mes + 365 del año; devuelve el año: le quedan sus 4 días
	assert.match(await (await form({ action: 'refund', checkout: checkout.id, note: 'no le convenció' })).text(), /transfiere <b>20 USD<\/b> a <b>@ana<\/b>/)
	const st = (await s.post('/pro/status', { print: P1 })).body
	assert.deepEqual([st.pro, st.expiresAt], [true, T0 + 30 * 86_400_000])
	assert.equal((s.db.prepare('SELECT COUNT(*) AS n FROM pro_prints WHERE license = ?').get('qp:ana') as { n: number }).n, 1)
	const last = { ...s.db.prepare("SELECT kind, days, checkout, note FROM pro_days WHERE license = 'qp:ana' ORDER BY id DESC LIMIT 1").get() }
	assert.deepEqual(last, { kind: 'refund', days: -365, checkout: checkout.id, note: 'no le convenció' })
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

test('panel: devolver el único pago deja sin Pro y dice cuánto transferir', async () => {
	const s = setup()
	const { checkout } = await buy(s)
	const form = (fields: Record<string, string>) =>
		proAdmin(new Request('https://app.terminalp2p.com/admin/pro', { method: 'POST', headers: { Origin: 'https://app.terminalp2p.com', Authorization: `Basic ${btoa('x:panel')}` }, body: new URLSearchParams(fields) }), s.env, T0)
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
	assert.equal((await s.status(first.id)).body.status, 'paid')
	// Al renovar, el pago anterior (de antes de pedir esta) no cuenta como pago de esta
	s.tick(26 * 86_400_000)
	const renewal = (await s.post('/pro/checkout', { print: P1, plan: 'month' })).body
	assert.equal((await s.status(renewal.id)).body.status, 'pending')
})

test('el estado de una factura solo se lo da a quien la pidió', async () => {
	const s = setup()
	const c = (await s.post('/pro/checkout', { print: P1, plan: 'month' })).body
	s.q.pay('inv-1', 'ana')
	assert.equal((await s.status(c.id, P2)).status, 404)
	assert.equal((await s.status(c.id)).body.status, 'paid')
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
			new Request(`https://app.terminalp2p.com/admin/pro${query}`, { method: fields ? 'POST' : 'GET', headers: { Origin: 'https://app.terminalp2p.com', Authorization: `Basic ${btoa('x:panel')}` }, body: fields ? new URLSearchParams(fields) : undefined }),
			s.env,
			s.now(),
			s.q.fetcher,
		).then((r) => r.text())
	let html = await panel(undefined, '?view=pagos')
	assert.match(html, /Facturas sin pagar/)
	assert.match(html, /Terminal · @leo/)
	assert.match(html, /Terminal · <span/)
	assert.match(html, /caducada/)
	// Comprobar a mano: QvaPay la da por pagada y se activa
	const id = (s.db.prepare("SELECT id FROM pro_checkouts WHERE invoice = 'inv-1'").get() as { id: string }).id
	assert.match(await panel({ action: 'check', checkout: id }, '?view=pagos'), /ya está activada/)
	assert.match(await panel(undefined, '?view=pagos'), /<b>@leo<\/b><\/a> <span class="note">pagó @pepe<\/span>/)
	assert.match(await panel(), /Ingresos totales<\/span><b>1,99 USD/)
	// Buscar por usuario
	assert.doesNotMatch(await panel(undefined, '?q=nadie'), /pagó @pepe/)
	assert.match(await panel(undefined, '?q=PEPE'), /pagó @pepe/)
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
			new Request('https://app.terminalp2p.com/admin/pro?view=pagos', { method: fields ? 'POST' : 'GET', headers: { Origin: 'https://app.terminalp2p.com', Authorization: `Basic ${btoa('x:panel')}` }, body: fields ? new URLSearchParams(fields) : undefined }),
			s.env,
			s.now(),
		).then((x) => x.text())
	assert.match(await form(), /<b>@Ana<\/b><\/a> <span class="note">pagó @pepe<\/span>/)
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
	assert.equal(head, 'pagado,pago,pago_uuid,para,dias,importe_usd,factura_qvapay,id,devuelto,devolucion,transferido,ref_transferencia')
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

test('topes contra abusos: días gratis por IP y día y facturas pendientes en total', async () => {
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
	// Las rutas de códigos ya no existen
	assert.deepEqual([(await s.post('/pro/claim', { print: P1, code: '123 456' })).status, (await s.post('/pro/pair', { print: P1 })).status], [404, 404])
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

test('migración al libro de movimientos: las licencias sueltas de un usuario se juntan sumando lo que les quedaba', () => {
	const db = new DatabaseSync(':memory:')
	const files = readdirSync('migrations').sort()
	for (const f of files.filter((f) => f < '0019')) db.exec(readFileSync(`migrations/${f}`, 'utf8'))
	const now = Date.now()
	const ins = db.prepare('INSERT INTO pro_licenses (uuid, username, plan, expires_at, revoked, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, 0)')
	ins.run('qp:ana', 'Ana', 'month', now + 20 * 86_400_000, 0)
	ins.run('trial:qp:ana', 'Ana', 'trial', now + 10 * 86_400_000, 0)
	ins.run('gift:ana', 'ana', 'gift', now + 5 * 86_400_000, 0)
	ins.run('trial:qp:leo', 'Leo', 'trial', now + 3 * 86_400_000, 0)
	ins.run('gift:eva', 'eva', 'gift', now - 86_400_000, 0) // vencida
	db.prepare('INSERT INTO pro_prints (print, license, added_at, seen_at) VALUES (?, ?, 0, 0)').run('p1', 'trial:qp:ana')
	db.prepare('INSERT INTO pro_prints (print, license, added_at, seen_at) VALUES (?, ?, 0, 0)').run('p2', 'trial:qp:leo')
	db.prepare('INSERT INTO pro_trials (key, license, created_at) VALUES (?, ?, 0)').run('qp:leo', 'trial:qp:leo')
	db.exec(readFileSync(`migrations/${files.find((f) => f.startsWith('0019'))}`, 'utf8'))
	const acc = (id: string) => db.prepare('SELECT expires_at, merged_into, revoked FROM pro_licenses WHERE uuid = ?').get(id) as { expires_at: number; merged_into: string | null; revoked: number }
	const days = (id: string) => Math.round((acc(id).expires_at - now) / 86_400_000)
	assert.equal(days('qp:ana'), 35)
	assert.equal(days('qp:leo'), 3)
	assert.ok(acc('qp:eva').expires_at < now) // nada que sumar: queda vencida
	// Las viejas no se borran: apuntan a la cuenta y ya no cuentan
	assert.deepEqual({ ...acc('trial:qp:ana') }.merged_into, 'qp:ana')
	assert.equal(acc('gift:ana').revoked, 1)
	assert.deepEqual(db.prepare('SELECT print, license FROM pro_prints ORDER BY print').all().map((r) => ({ ...r })), [
		{ print: 'p1', license: 'qp:ana' },
		{ print: 'p2', license: 'qp:leo' },
	])
	assert.equal((db.prepare("SELECT license FROM pro_trials WHERE key = 'qp:leo'").get() as { license: string }).license, 'qp:leo')
	// Cada cuenta empieza el libro con su saldo
	assert.deepEqual(
		db.prepare("SELECT license, kind, days FROM pro_days ORDER BY license").all().map((r) => ({ ...r })),
		[
			{ license: 'qp:ana', kind: 'import', days: 35 },
			{ license: 'qp:eva', kind: 'import', days: 0 },
			{ license: 'qp:leo', kind: 'import', days: 3 },
		],
	)
})

test('devolución en pasos: la pide el usuario desde «Mi cuenta», la apruebas (se le quitan los días) y la marcas transferida', async () => {
	const s = setup()
	const admin = (fields?: Record<string, string>, query = '') =>
		proAdmin(
			new Request(`https://app.terminalp2p.com/admin/pro${query}`, { method: fields ? 'POST' : 'GET', headers: { Origin: 'https://app.terminalp2p.com', Authorization: `Basic ${btoa('x:panel')}` }, body: fields ? new URLSearchParams(fields) : undefined }),
			s.env,
			s.now(),
		).then((r) => r.text())
	await s.post('/pro/status', { print: P1, username: 'ana' }) // 30 días gratis
	const { checkout } = await buy(s, P1, 'month', 'ana')
	// «Mi cuenta»: su compra se puede devolver
	let acc = (await s.post('/pro/account', { print: P1, username: 'ana' })).body
	assert.deepEqual([acc.account.username, acc.purchases.length, acc.purchases[0].canRefund], ['ana', 1, true])
	assert.deepEqual(acc.moves.map((m: { kind: string; days: number }) => [m.kind, m.days]), [['purchase', 30], ['trial', 30]])
	// Sin motivo no; con motivo queda pedida (y no dos veces)
	assert.equal((await s.post('/pro/refund', { print: P1, username: 'ana', checkout: checkout.id, reason: '' })).status, 400)
	acc = (await s.post('/pro/refund', { print: P1, username: 'ana', checkout: checkout.id, reason: 'no la uso' })).body
	assert.deepEqual([acc.purchases[0].refund.status, acc.purchases[0].canRefund], ['requested', false])
	assert.equal((await s.post('/pro/refund', { print: P1, username: 'ana', checkout: checkout.id, reason: 'otra vez' })).status, 409)
	// Otro usuario no puede pedir la devolución de una compra ajena
	assert.equal((await s.post('/pro/refund', { print: P2, username: 'leo', checkout: checkout.id, reason: 'mía no' })).status, 404)
	// En el panel aparece abierta; al aprobarla se le quitan esos 30 días (le quedan los gratis)
	assert.match(await admin(), /Pendientes <span class="count">1<\/span>/)
	const id = (s.db.prepare('SELECT id FROM pro_refunds').get() as { id: string }).id
	assert.match(await admin({ action: 'refund-approve', id, note: 'ok' }), /transfiere <b>1,99 USD<\/b> a <b>@ana<\/b>/)
	assert.equal((await s.post('/pro/status', { print: P1 })).body.expiresAt, T0 + 30 * 86_400_000)
	// No se aprueba dos veces
	assert.match(await admin({ action: 'refund-approve', id }), /no está pendiente de aprobar/)
	assert.match(await admin({ action: 'refund-transfer', id, ref: 'TX-123' }), /transferida/)
	assert.deepEqual({ ...s.db.prepare('SELECT status, transfer_ref FROM pro_refunds').get() }, { status: 'transferred', transfer_ref: 'TX-123' })
	acc = (await s.post('/pro/account', { print: P1, username: 'ana' })).body
	assert.equal(acc.purchases[0].refund.status, 'transferred')
	assert.match(await admin(), /Nada pendiente/)
})

test('devolución rechazada (el usuario ve el motivo) y fuera de plazo no se puede pedir desde el terminal', async () => {
	const s = setup()
	const admin = (fields: Record<string, string>) =>
		proAdmin(new Request('https://app.terminalp2p.com/admin/pro', { method: 'POST', headers: { Origin: 'https://app.terminalp2p.com', Authorization: `Basic ${btoa('x:panel')}` }, body: new URLSearchParams(fields) }), s.env, s.now()).then((r) => r.text())
	const { checkout } = await buy(s, P1, 'month', 'ana')
	await s.post('/pro/refund', { print: P1, username: 'ana', checkout: checkout.id, reason: 'quiero' })
	const id = (s.db.prepare('SELECT id FROM pro_refunds').get() as { id: string }).id
	assert.match(await admin({ action: 'refund-reject', id }), /Escribe el motivo del rechazo/)
	await admin({ action: 'refund-reject', id, note: 'ya usaste la orden inteligente 20 veces' })
	const acc = (await s.post('/pro/account', { print: P1, username: 'ana' })).body
	assert.deepEqual(acc.purchases[0].refund, { status: 'rejected', note: 'ya usaste la orden inteligente 20 veces', at: T0 })
	assert.equal((await s.post('/pro/status', { print: P1 })).body.pro, true)
	// Otra cuenta, a los 8 días de su primera compra: fuera de plazo
	const b = await buy(s, P2, 'month', 'leo')
	s.tick(8 * 86_400_000)
	const late = await s.post('/pro/refund', { print: P2, username: 'leo', checkout: b.checkout.id, reason: 'tarde' })
	assert.deepEqual([late.status, /7 días/.test(late.body.error)], [409, true])
})

test('panel: la ficha del cliente lo reúne todo, guarda notas y no acepta formularios de otra web', async () => {
	const s = setup()
	const req = (init: RequestInit, query = '') => proAdmin(new Request(`https://app.terminalp2p.com/admin/pro${query}`, init), s.env, s.now())
	const auth = { Authorization: `Basic ${btoa('x:panel')}` }
	await s.post('/pro/status', { print: P1, username: 'ana' })
	await buy(s, P1, 'month', 'ana')
	// Desde otra web (o sin origen), nada
	assert.equal((await req({ method: 'POST', headers: { ...auth, Origin: 'https://malo.example' }, body: new URLSearchParams({ action: 'days', username: 'ana', days: '999', note: 'x' }) })).status, 403)
	assert.equal((await req({ method: 'POST', headers: auth, body: new URLSearchParams({ action: 'pro-off' }) })).status, 403)
	const r = await req({ method: 'POST', headers: { ...auth, Origin: 'https://app.terminalp2p.com' }, body: new URLSearchParams({ action: 'note', license: 'qp:ana', text: 'escribió por Telegram', u: 'ana' }) })
	const html = await r.text()
	assert.match(html, /<h1>@ana <span class="pill approved-ok">Pro · 60 días<\/span><\/h1>/)
	assert.match(html, /Nota guardada/)
	assert.match(html, /escribió por Telegram/)
	assert.match(html, /<h2>Movimientos de días<\/h2>/)
	assert.match(html, /Días gratis/)
	assert.match(html, /Compra/)
	assert.match(html, /En plazo/)
	// Un usuario sin cuenta: se le pueden dar días
	assert.match(await (await req({ headers: auth }, '?u=nadie')).text(), /No tiene cuenta Pro todavía/)
})

test('avisos a Telegram: pago nuevo y devolución pedida, con el botón a la ficha; sin configurar no se manda nada', async () => {
	const quiet = setup()
	await buy(quiet, P1, 'month', 'ana')
	assert.equal(quiet.q.telegram.length, 0)
	const s = setup({ TELEGRAM_BOT_TOKEN: 'bot', ALERT_CHAT: '-100' })
	const { checkout } = await buy(s, P1, 'month', 'ana')
	assert.equal(s.q.telegram.length, 1)
	assert.match(s.q.telegram[0].text, /Pago nuevo[\s\S]*@ana compró <b>30 días<\/b> · 1.99 USD/)
	assert.deepEqual([s.q.telegram[0].chat_id, s.q.telegram[0].url], ['-100', 'https://app.terminalp2p.com/admin/pro?u=ana'])
	await s.post('/pro/refund', { print: P1, username: 'ana', checkout: checkout.id, reason: 'no me <sirve>' })
	assert.match(s.q.telegram[1].text, /Devolución pedida[\s\S]*Motivo: «no me &lt;sirve&gt;»[\s\S]*En plazo/)
	// Staging avisa con su etiqueta y lleva al panel de staging
	const st = setup({ TELEGRAM_BOT_TOKEN: 'bot', ALERT_CHAT: '-100', STAGING: '1' })
	await buy(st, P1, 'month', 'ana')
	assert.match(st.q.telegram[0].text, /^🧪 <b>STAGING<\/b>/)
	assert.equal(st.q.telegram[0].url, 'https://app.staging.terminalp2p.com/admin/pro?u=ana')
})

test('pagos cobrados sin activar: quedan en «Pendientes» hasta activarlos, y el repaso diario lo cuenta', async () => {
	const { recordIssues, dailyDigest, pendingWork } = await import('../worker/pro.ts')
	const s = setup({ TELEGRAM_BOT_TOKEN: 'bot', ALERT_CHAT: '-100' })
	// Una factura pagada en QvaPay que aquí no consta (p. ej. se perdió la base)
	s.q.invoices.set('inv-x', { remote_id: 'pro-perdida', amount: 1.99, status: 'paid', PaidBy: { uuid: 'u-leo', username: 'leo' } })
	await recordIssues(s.env.DB, { checked: 1, activated: [], unknown: [{ invoice: 'inv-x', remoteId: 'pro-perdida', amount: 1.99, payer: 'leo', paidAt: null }] }, s.now())
	assert.equal((await pendingWork(s.env.DB)).count, 1)
	await dailyDigest(s.env, null, s.now(), s.q.fetcher)
	assert.match(s.q.telegram.at(-1)!.text, /Repaso diario[\s\S]*1 pago cobrado en QvaPay sin activar/)
	const admin = (fields?: Record<string, string>) =>
		proAdmin(new Request('https://app.terminalp2p.com/admin/pro', { method: fields ? 'POST' : 'GET', headers: { Origin: 'https://app.terminalp2p.com', Authorization: `Basic ${btoa('x:panel')}` }, body: fields ? new URLSearchParams(fields) : undefined }), s.env, s.now(), s.q.fetcher).then((r) => r.text())
	assert.match(await admin(), /Cobrado sin activar/)
	assert.match(await admin({ action: 'recover', invoice: 'inv-x' }), /Recuperada/)
	assert.equal((await pendingWork(s.env.DB)).count, 0)
	assert.equal((await s.post('/pro/status', { print: P2, username: 'leo' })).body.plan, 'month')
	// Sin nada pendiente, el repaso dice que todo está en orden
	await dailyDigest(s.env, null, s.now(), s.q.fetcher)
	assert.match(s.q.telegram.at(-1)!.text, /todo en orden[\s\S]*Últimas 24 h: 1 pago \(1,99 USD\)/)
	// El botón del panel manda un aviso de prueba
	assert.match(await admin({ action: 'alert-test' }), /Aviso de prueba enviado/)
	assert.match(s.q.telegram.at(-1)!.text, /Aviso de prueba/)
})

test('informes por meses (cobrado, devuelto, neto, nuevos y los que repiten) y registro de lo hecho en el panel', async () => {
	const s = setup()
	const admin = (fields?: Record<string, string>, query = '') =>
		proAdmin(new Request(`https://app.terminalp2p.com/admin/pro${query}`, { method: fields ? 'POST' : 'GET', headers: { Origin: 'https://app.terminalp2p.com', Authorization: `Basic ${btoa('x:panel')}` }, body: fields ? new URLSearchParams(fields) : undefined }), s.env, s.now(), s.q.fetcher)
	await s.post('/pro/status', { print: P1, username: 'ana' }) // días gratis
	await buy(s, P1, 'month', 'ana')
	s.tick(56 * 86_400_000) // le quedan 4 días (30 gratis + 30 comprados): ya puede comprar más
	const second = await buy(s, P1, 'month', 'ana') // repite
	await buy(s, P2, 'year', 'leo') // nuevo, sin días gratis
	await admin({ action: 'refund', checkout: second.checkout.id, note: 'se equivocó' })
	const { proReport } = await import('../worker/pro.ts')
	const r = await proReport(s.env.DB, s.now())
	assert.deepEqual([r.buyers, r.repeat, r.trialAccounts, r.converted, r.paidCount, r.refundedCount], [2, 1, 1, 1, 3, 1])
	const total = r.months.reduce((t, m) => ({ gross: t.gross + m.gross, refunded: t.refunded + m.refunded, newPaying: t.newPaying + m.newPaying, renewals: t.renewals + m.renewals }), { gross: 0, refunded: 0, newPaying: 0, renewals: 0 })
	assert.deepEqual([Math.round(total.gross * 100) / 100, total.refunded, total.newPaying, total.renewals], [23.98, 1.99, 2, 1])
	const page = await (await admin(undefined, '?view=informes')).text()
	assert.match(page, /<h1>Informes<\/h1>/)
	assert.match(page, /Repiten compra<\/span><b>50 %/)
	const csv = await (await admin(undefined, '?export=informe')).text()
	assert.match(csv.split('\n')[0], /^mes,pagos,cobrado_usd,devoluciones,devuelto_usd,neto_usd,nuevos,repiten,dias_gratis$/)
	// El registro: la devolución y una nota quedan; lo que falla no
	await admin({ action: 'note', license: 'qp:ana', text: 'le escribí', u: 'ana' })
	await admin({ action: 'refund', checkout: second.checkout.id })
	const log = s.db.prepare('SELECT action, target FROM pro_audit ORDER BY id').all().map((x) => ({ ...x }))
	assert.deepEqual(log, [
		{ action: 'refund', target: second.checkout.id },
		{ action: 'note', target: 'ana' },
	])
	assert.match(await (await admin(undefined, '?view=registro')).text(), /Nota[\s\S]*Devolución \(directa\)/)
})

test('panel: tras una acción redirige a la página y el aviso sale una sola vez (recargar no repite nada)', async () => {
	const s = setup()
	const auth = { Authorization: `Basic ${btoa('x:panel')}` }
	const res = await proAdminRaw(
		new Request('https://app.terminalp2p.com/admin/pro?u=ana', { method: 'POST', headers: { ...auth, Origin: 'https://app.terminalp2p.com' }, body: new URLSearchParams({ action: 'days', username: 'ana', days: '7', note: 'regalo', u: 'ana' }) }),
		s.env,
		s.now(),
	)
	assert.equal(res.status, 303)
	assert.equal(res.headers.get('location'), '/admin/pro?u=ana')
	const cookie = res.headers.get('set-cookie')!
	assert.match(cookie, /^tpflash=.+; HttpOnly; SameSite=Strict; Path=\/admin; Max-Age=60; Secure$/)
	const get = (headers: Record<string, string>) => proAdminRaw(new Request('https://app.terminalp2p.com/admin/pro?u=ana', { headers: { ...auth, ...headers } }), s.env, s.now())
	const page = await get({ Cookie: cookie.split(';')[0] })
	assert.match(await page.text(), /7 días para <b>@ana<\/b>/)
	assert.match(page.headers.get('set-cookie')!, /^tpflash=; .*Max-Age=0/)
	assert.doesNotMatch(await (await get({})).text(), /7 días para/)
	// Una cookie inventada no mete nada en la página
	assert.doesNotMatch(await (await get({ Cookie: 'tpflash=eyJrIjoiZmxhc2gifQ.falsa' })).text(), /class="ok"/)
	// Y la acción se hizo una sola vez
	assert.equal((s.db.prepare("SELECT COUNT(*) AS n FROM pro_days WHERE license = 'qp:ana'").get() as { n: number }).n, 1)
})

test('avisos al usuario por Telegram: se conecta desde «Mi cuenta» y recibe su pago, sus devoluciones y el fin de sus días', async () => {
	const { webhookSecret, expiryReminders } = await import('../worker/userbot.ts')
	const s = setup({ TELEGRAM_BOT_TOKEN: 'bot', ALERT_CHAT: '-100' })
	const tg = async (text: string, chat = { id: 555, type: 'private' }, secret?: string) => {
		const res = await proApi(
			new Request('https://app.terminalp2p.com/pro/telegram/webhook', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': secret ?? (await webhookSecret(s.env)) },
				body: JSON.stringify({ message: { text, chat } }),
			}),
			new URL('https://app.terminalp2p.com/pro/telegram/webhook'),
			s.env,
			s.now(),
			s.q.fetcher,
		)
		return { status: res!.status, body: (await res!.json().catch(() => null)) as { method?: string; chat_id?: number; text?: string } | null }
	}
	const toUser = () => s.q.telegram.filter((m) => String(m.chat_id) === '555')
	await s.post('/pro/status', { print: P1, username: 'ana' }) // días gratis
	// Sin cuenta conectada no hay enlace
	assert.equal((await s.post('/pro/telegram/link', { print: P2 })).status, 403)
	const { url } = (await s.post('/pro/telegram/link', { print: P1, username: 'ana' })).body
	const code = url.match(/^https:\/\/t\.me\/TerminalP2PBot\?start=([A-Za-z0-9_-]{24})$/)?.[1]
	assert.ok(code, url)
	// Sin la clave de Telegram, nada
	assert.equal((await tg(`/start ${code}`, undefined, 'falsa')).status, 401)
	// En grupos no contesta
	assert.deepEqual((await tg(`/start ${code}`, { id: -100, type: 'supergroup' })).body, { ok: true })
	const hi = (await tg(`/start ${code}`)).body!
	assert.deepEqual([hi.method, hi.chat_id], ['sendMessage', 555])
	assert.match(hi.text!, /¡Hola, @ana! Tu cuenta quedó conectada[\s\S]*\/stop[\s\S]*Tienes Pro hasta el/)
	assert.equal((await s.post('/pro/account', { print: P1, username: 'ana' })).body.telegram, true)
	// El enlace sirve una sola vez
	assert.match((await tg(`/start ${code}`)).body!.text!, /caducó/)
	assert.match((await tg('/start')).body!.text!, /Recibir avisos en Telegram/)
	assert.match((await tg('hola?')).body!.text!, /no leemos los mensajes/)

	// Compra: el aviso al grupo y la confirmación al usuario
	const { checkout } = await buy(s, P1, 'month', 'ana')
	assert.match(toUser()[0].text, /Pago confirmado[\s\S]*Recibimos tus 1,99 USD: <b>30 días de Pro<\/b> para @ana/)
	// Devolución: pedida (no se le avisa: ya lo ve en «Mi cuenta»), aprobada y transferida
	await s.post('/pro/refund', { print: P1, username: 'ana', checkout: checkout.id, reason: 'no la uso' })
	const admin = (fields: Record<string, string>) =>
		proAdmin(new Request('https://app.terminalp2p.com/admin/pro', { method: 'POST', headers: { Origin: 'https://app.terminalp2p.com', Authorization: `Basic ${btoa('x:panel')}` }, body: new URLSearchParams(fields) }), s.env, s.now(), s.q.fetcher).then((r) => r.text())
	const id = (s.db.prepare('SELECT id FROM pro_refunds').get() as { id: string }).id
	await admin({ action: 'refund-approve', id })
	assert.match(toUser()[1].text, /Devolución aprobada[\s\S]*1,99 USD<\/b> a la cuenta de QvaPay @ana/)
	await admin({ action: 'refund-transfer', id, ref: 'TX-9' })
	assert.match(toUser()[2].text, /Devolución enviada[\s\S]*Referencia: <code>TX-9<\/code>/)

	// Devuelta la compra, le quedan los 30 días gratis (su último plan es el comprado): a 2 días, el aviso (una vez); al terminar, otro
	s.tick(28 * 86_400_000)
	assert.equal(await expiryReminders(s.env, s.now(), s.q.fetcher), 1)
	assert.match(toUser()[3].text, /A tu Pro le quedan 2 días<\/b>[\s\S]*renueva desde el terminal/)
	assert.equal(await expiryReminders(s.env, s.now(), s.q.fetcher), 0)
	s.tick(2 * 86_400_000 + 60_000)
	assert.equal(await expiryReminders(s.env, s.now(), s.q.fetcher), 1)
	assert.match(toUser()[4].text, /Tu Pro terminó[\s\S]*tu historial siguen guardados/)

	// /stop lo desconecta y no le llega nada más
	assert.match((await tg('/stop')).body!.text!, /ya no te escribiremos/)
	assert.equal((await s.post('/pro/account', { print: P1, username: 'ana' })).body.telegram, false)
	await buy(s, P1, 'month', 'ana')
	assert.equal(toUser().length, 5)

	// El panel conecta el bot a este entorno, con la clave
	assert.match(await admin({ action: 'bot-connect' }), /El bot ya responde desde app\.terminalp2p\.com/)
	assert.deepEqual(s.q.telegram.at(-1), { chat_id: 'webhook', text: 'https://app.terminalp2p.com/pro/telegram/webhook', url: await webhookSecret(s.env) })
})
