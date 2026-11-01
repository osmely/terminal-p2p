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

test('cambiar una calificación: si QvaPay dice ALREADY_RATED, se reenvía con PATCH', async (t) => {
	const real = globalThis.fetch
	t.after(() => (globalThis.fetch = real))
	const calls: string[] = []
	globalThis.fetch = (async (_url: string, init: RequestInit) => {
		calls.push(String(init.method))
		if (init.method === 'POST') return new Response(JSON.stringify({ error: 'Ya calificaste', code: 'ALREADY_RATED' }), { status: 400 })
		return new Response(JSON.stringify({ message: 'Rating updated' }), { status: 200 })
	}) as typeof fetch
	const c = new QvaPayClient({ token: 'x', dryRun: false, baseUrl: 'https://qp.test' })
	await c.rate('7c9e6679-7425-40de-944b-e07fc1f90ae7', 'o1', 3)
	assert.deepEqual(calls, ['POST', 'PATCH'])
})

test('cambiar una nota que el terminal ya ve: directo con PATCH; si aún no había nota, se califica con POST', async (t) => {
	const real = globalThis.fetch
	t.after(() => (globalThis.fetch = real))
	const U = '7c9e6679-7425-40de-944b-e07fc1f90ae7'
	const calls: string[] = []
	let rated = true
	globalThis.fetch = (async (_url: string, init: RequestInit) => {
		calls.push(String(init.method))
		if (init.method === 'PATCH' && !rated) return new Response(JSON.stringify({ error: 'No has calificado', code: 'NOT_RATED' }), { status: 404 })
		return new Response(JSON.stringify({ message: 'ok' }), { status: 200 })
	}) as typeof fetch
	const c = new QvaPayClient({ token: 'x', dryRun: false, baseUrl: 'https://qp.test' })
	await c.rate(U, undefined, 4, undefined, true)
	assert.deepEqual(calls, ['PATCH'])
	calls.length = 0
	rated = false
	await c.rate(U, undefined, 4, undefined, true)
	assert.deepEqual(calls, ['PATCH', 'POST'])
})

test('si el cambio no vale y tampoco se puede calificar de nuevo, el error es el del cambio (p. ej. plazo vencido)', async (t) => {
	const real = globalThis.fetch
	t.after(() => (globalThis.fetch = real))
	globalThis.fetch = (async (_url: string, init: RequestInit) =>
		init.method === 'PATCH'
			? new Response(JSON.stringify({ error: 'El plazo para cambiarla terminó', code: 'RATING_LOCKED' }), { status: 403 })
			: new Response(JSON.stringify({ error: 'Ya calificaste', code: 'ALREADY_RATED' }), { status: 400 })) as typeof fetch
	const c = new QvaPayClient({ token: 'x', dryRun: false, baseUrl: 'https://qp.test' })
	await assert.rejects(c.rate('7c9e6679-7425-40de-944b-e07fc1f90ae7', undefined, 2, undefined, true), /RATING_LOCKED/)
})
