import assert from 'node:assert/strict'
import { test } from 'node:test'
import { allowed, relay } from '../worker/relay.ts'

const U = '7c9e6679-7425-40de-944b-e07fc1f90ae7'

test('el relé solo deja pasar las rutas que usa la app', () => {
	for (const [m, p] of [['GET', '/user'], ['GET', '/p2p'], ['GET', '/p2p/averages'], ['GET', `/p2p/${U}`], ['GET', `/p2p/${U}/chat`], ['POST', `/p2p/${U}/received`], ['POST', `/p2p/${U}/chat`]])
		assert.ok(allowed(m, p), `${m} ${p}`)
	for (const [m, p] of [
		['POST', '/transaction/transfer'], // mover saldo: nunca
		['POST', '/withdraw'],
		['POST', '/p2p/create'],
		['POST', `/p2p/${U}/apply`],
		['DELETE', `/p2p/${U}`],
		['GET', '/user/../withdraw'],
		['GET', `/p2p/${U}/../../withdraw`],
		['POST', '/user'],
	])
		assert.ok(!allowed(m, p), `${m} ${p}`)
})

test('reenvía solo autorización y tipo, sin cookies, y rechaza escrituras ajenas', async (t) => {
	const real = globalThis.fetch
	t.after(() => (globalThis.fetch = real))
	let seen: { url: string; headers: Headers } | undefined
	globalThis.fetch = (async (url: string, init: RequestInit) => {
		seen = { url, headers: new Headers(init.headers) }
		return new Response('{"ok":1}', { status: 200, headers: { 'content-type': 'application/json', 'set-cookie': 'x=1' } })
	}) as typeof fetch

	const url = new URL('https://terminalp2p.com/qp/p2p?coin=BANK_CUP')
	const res = await relay(new Request(url, { headers: { Authorization: 'Bearer t', Cookie: 'sid=secreto', 'X-Otro': '1' } }), url)
	assert.equal(res.status, 200)
	assert.equal(res.headers.get('set-cookie'), null)
	assert.equal(res.headers.get('cache-control'), 'no-store')
	assert.equal(seen!.url, 'https://api.qvapay.com/p2p?coin=BANK_CUP')
	assert.equal(seen!.headers.get('authorization'), 'Bearer t')
	assert.equal(seen!.headers.get('cookie'), null)
	assert.equal(seen!.headers.get('x-otro'), null)

	const post = new URL(`https://terminalp2p.com/qp/p2p/${U}/received`)
	const evil = await relay(new Request(post, { method: 'POST', headers: { Origin: 'https://evil.example' }, body: '{}' }), post)
	assert.equal(evil.status, 403)
	const blocked = new URL('https://terminalp2p.com/qp/withdraw')
	assert.equal((await relay(new Request(blocked, { method: 'POST', headers: { Origin: 'https://terminalp2p.com' }, body: '{}' }), blocked)).status, 404)
})
