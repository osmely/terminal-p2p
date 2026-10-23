import assert from 'node:assert/strict'
import { test } from 'node:test'
import { QvaPayClient } from '../src/qvapay/client.ts'

test('el chat se ordena del más antiguo al más nuevo (QvaPay lo da al revés)', async (t) => {
	const real = globalThis.fetch
	t.after(() => (globalThis.fetch = real))
	const msg = (id: string, at: string, message: string) => ({ id, p2p_id: '1', peer_id: 'u', message, image: null, created_at: at })
	// Tal como responde QvaPay: el más nuevo primero
	const chat = [msg('3', '2026-10-23T00:36:44Z', 'tercero'), msg('2', '2026-10-23T00:35:40Z', 'segundo'), msg('1', '2026-10-23T00:35:10Z', 'primero')]
	globalThis.fetch = (async () => new Response(JSON.stringify({ message: 'chat', chat }), { status: 200 })) as typeof fetch
	const c = new QvaPayClient({ token: 'x', dryRun: false, baseUrl: 'https://qp.test' })
	const got = await c.getChat('7c9e6679-7425-40de-944b-e07fc1f90ae7')
	assert.deepEqual(got.map((m) => m.message), ['primero', 'segundo', 'tercero'])
	assert.equal(got.at(-1)?.id, '3') // el último es el mensaje más reciente: de ahí salen los avisos
})
