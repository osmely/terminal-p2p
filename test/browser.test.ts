import assert from 'node:assert/strict'
import { test } from 'node:test'
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
