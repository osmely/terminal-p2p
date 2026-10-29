import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Broker } from '../src/broker/routes.ts'
import { BrowserAccounts } from '../web/accounts.ts'

const memStorage = () => {
	const m = new Map<string, string>()
	return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), m }
}

function mockQvaPay(valid: Set<string>) {
	const real = globalThis.fetch
	globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
		const token = (new Headers(init?.headers).get('authorization') ?? '').replace('Bearer ', '')
		if (valid.has(token)) return new Response(JSON.stringify({ uuid: 'u1', username: 'pepe', balance: 1, kyc: true, golden_check: false, p2p_enabled: true }))
		return new Response('{"error":"Unauthorized"}', { status: 401 })
	}) as typeof fetch
	return () => (globalThis.fetch = real)
}

test('el token se queda en el navegador: sesión por defecto, local si se pide recordar', async (t) => {
	t.after(mockQvaPay(new Set(['tok'])))
	const session = memStorage()
	const local = memStorage()
	const acc = new BrowserAccounts({ storage: { session, local }, baseUrl: 'https://x/qp' })
	await acc.connect('browser', 'tok')
	assert.equal(session.m.get('tp.token'), 'tok')
	assert.equal(local.m.size, 0)
	await acc.connect('browser', 'tok', { remember: true })
	assert.equal(local.m.get('tp.token'), 'tok')
	assert.equal(session.m.size, 0)
	await acc.disconnect()
	assert.equal(local.m.size + session.m.size, 0)
	assert.equal(await acc.get(), null)
})

test('un token revocado se borra del navegador', async (t) => {
	t.after(mockQvaPay(new Set()))
	const local = memStorage()
	local.setItem('tp.token', 'viejo')
	const acc = new BrowserAccounts({ storage: { session: memStorage(), local }, baseUrl: 'https://x/qp' })
	assert.equal(await acc.reader(), null)
	assert.equal(local.m.size, 0)
})

test('desconectar desde el terminal borra el token aunque la petición no lleve cookie', async (t) => {
	t.after(mockQvaPay(new Set(['tok'])))
	const local = memStorage()
	const acc = new BrowserAccounts({ storage: { session: memStorage(), local }, baseUrl: 'https://x/qp' })
	await acc.connect('browser', 'tok', { remember: true })
	const broker = new Broker({ accounts: acc, market: { wake() {} }, dryRun: false })
	// Así llama el navegador: Request construido en la página, sin cookie de sesión
	const res = await broker.handle(new Request('https://terminalp2p.com/api/broker/disconnect', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Broker': '1' }, body: '{}' }))
	assert.equal(res!.status, 200)
	assert.equal(local.m.size, 0)
	assert.equal(await acc.get(), null)
	const me = await broker.handle(new Request('https://terminalp2p.com/api/broker/me'))
	assert.equal((await me!.json()).connected, false)
})

test('otra pestaña desconecta o cambia de cuenta: esta deja de usar el token que tenía en memoria', async (t) => {
	t.after(mockQvaPay(new Set(['tok', 'otro'])))
	const local = memStorage()
	const acc = new BrowserAccounts({ storage: { session: memStorage(), local }, baseUrl: 'https://x/qp' })
	await acc.connect('browser', 'tok', { remember: true })
	assert.ok(await acc.get())
	// Otra pestaña desconecta: borra el token compartido
	local.removeItem('tp.token')
	assert.equal(await acc.get(), null)
	// Otra pestaña conecta otro token: esta pasa a usarlo
	const before = (await acc.connect('browser', 'tok', { remember: true })).print
	local.setItem('tp.token', 'otro')
	const now = await acc.get()
	assert.ok(now)
	assert.notEqual(now.print, before)
})

test('sin almacenamiento (bloqueado) la cuenta sigue conectada en memoria', async (t) => {
	t.after(mockQvaPay(new Set(['tok'])))
	const broken = { getItem: () => { throw new Error('bloqueado') }, setItem: () => { throw new Error('bloqueado') }, removeItem: () => { throw new Error('bloqueado') } }
	const acc = new BrowserAccounts({ storage: { session: broken, local: broken }, baseUrl: 'https://x/qp' })
	await acc.connect('browser', 'tok')
	assert.ok(await acc.get())
})

test('cuenta bloqueada en Terminal P2P: /me lo dice, el token se queda guardado, un minuto sin preguntar y al levantarlo vuelve sola', async (t) => {
	const real = globalThis.fetch
	let blocked = false
	let calls = 0
	globalThis.fetch = (async () => {
		calls++
		if (blocked) return new Response(JSON.stringify({ error: 'Tu cuenta tiene bloqueado el uso de Terminal P2P.', code: 'TP_ACCOUNT_BLOCKED' }), { status: 403 })
		return new Response(JSON.stringify({ uuid: 'u1', username: 'pepe', balance: 1, kyc: true, golden_check: false, p2p_enabled: true }))
	}) as typeof fetch
	t.after(() => (globalThis.fetch = real))
	let now = 1_000_000
	const local = memStorage()
	const acc = new BrowserAccounts({ storage: { session: memStorage(), local }, baseUrl: 'https://x/qp', now: () => now })
	await acc.connect('browser', 'tok', { remember: true })
	const broker = new Broker({ accounts: acc, market: { wake() {} }, dryRun: false })
	const me = async () => (await broker.handle(new Request('https://terminalp2p.com/api/broker/me')))!.json()
	assert.equal((await me()).connected, true)
	// Con el terminal abierto: la siguiente revisión de la cuenta ya lo sabe
	blocked = true
	assert.deepEqual(await me(), { connected: false, dryRun: false, blocked: 'Tu cuenta tiene bloqueado el uso de Terminal P2P.' })
	assert.equal(local.m.get('tp.token'), 'tok')
	// Durante un minuto no se vuelve a preguntar
	const before = calls
	assert.equal((await me()).blocked, 'Tu cuenta tiene bloqueado el uso de Terminal P2P.')
	assert.equal(await acc.reader(), null)
	assert.equal(calls, before)
	// Levantado: pasado el minuto vuelve a entrar con el mismo token
	blocked = false
	now += 61_000
	assert.equal((await me()).connected, true)
})
