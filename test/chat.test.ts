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

test('comprobantes: con la orden en la URL, pagado sin tx_id con comprobante y el archivo tal cual', async (t) => {
	const real = globalThis.fetch
	t.after(() => (globalThis.fetch = real))
	const U = '7c9e6679-7425-40de-944b-e07fc1f90ae7'
	const A = '1f0c6b1e-5d7a-4d2e-9a53-4a2f0a0d9a11'
	const calls: { url: string; method: string; body: unknown; auth: string | null }[] = []
	globalThis.fetch = (async (url: URL | string, init: RequestInit = {}) => {
		calls.push({ url: String(url), method: init.method ?? 'GET', body: init.body, auth: new Headers(init.headers).get('authorization') })
		if (String(url).includes(`/attachments/${A}`)) return new Response(new Uint8Array([37, 80, 68, 70]), { status: 200, headers: { 'content-type': 'application/pdf' } })
		if (String(url).includes('/attachments/')) return new Response(JSON.stringify({ error: 'No encontrado' }), { status: 404 })
		if (init.method === 'POST' && String(url).includes('/attachments')) return new Response(JSON.stringify({ attachment: { uuid: A } }), { status: 201 })
		if (String(url).includes('/attachments')) return new Response(JSON.stringify({ attachments: [], limits: { max_bytes: 4194304, max_per_party: 5, remaining: 5, can_upload: true, proof_replaces_tx_id: true } }), { status: 200 })
		return new Response('{"message":"ok"}', { status: 200 })
	}) as typeof fetch
	const c = new QvaPayClient({ token: 'x', dryRun: false, baseUrl: 'https://qp.test' })

	assert.equal((await c.attachments(U, 'o1')).limits?.remaining, 5)
	assert.equal(calls.at(-1)!.url, `https://qp.test/p2p/${U}/attachments?order=o1`)

	await c.uploadAttachment(U, new Blob([new Uint8Array(10)], { type: 'image/png' }), 'comprobante.png', 'o1')
	assert.equal(calls.at(-1)!.url, `https://qp.test/p2p/${U}/attachments?order=o1`)
	assert.ok(calls.at(-1)!.body instanceof FormData)
	assert.equal(((calls.at(-1)!.body as FormData).get('file') as File).name, 'comprobante.png')

	// El token va en la cabecera, nunca en la URL
	const blob = await c.attachmentFile(U, A, 'o1')
	assert.equal(calls.at(-1)!.url, `https://qp.test/p2p/${U}/attachments/${A}?order=o1`)
	assert.equal(calls.at(-1)!.auth, 'Bearer x')
	assert.equal(blob.type, 'application/pdf')
	await assert.rejects(c.attachmentFile(U, '00000000-0000-0000-0000-000000000000'), (e: { status?: number }) => e.status === 404)

	await c.markPaid(U, '', 'o1')
	assert.equal(calls.at(-1)!.body, '{}')
	await c.markPaid(U, 'REF-1')
	assert.equal(calls.at(-1)!.body, '{"tx_id":"REF-1"}')
})
