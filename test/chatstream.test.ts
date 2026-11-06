import assert from 'node:assert/strict'
import { test } from 'node:test'
import { QvaPayClient, SseParser } from '../src/qvapay/client.ts'
import { relay } from '../worker/relay.ts'

const U = '7c9e6679-7425-40de-944b-e07fc1f90ae7'

test('SSE: eventos partidos en trozos, con nombre o sin él; comentarios y retry no cuentan', () => {
	const got: [string, string][] = []
	const p = new SseParser((e, d) => got.push([e, d]))
	p.push('retry: 10000\nevent: init\nda')
	p.push('ta: connected\n\n: keepalive 1\n\ndata: {"id":"1"}\r\n\r\ndata: a\ndata: b\n')
	assert.deepEqual(got, [
		['init', 'connected'],
		['message', '{"id":"1"}'],
	])
	p.push('\n')
	assert.deepEqual(got.at(-1), ['message', 'a\nb'])
})

test('chatStream: pide el flujo con el token y la orden, y pasa solo los mensajes', async (t) => {
	const real = globalThis.fetch
	t.after(() => (globalThis.fetch = real))
	let seen: { url: string; headers: Headers } | undefined
	globalThis.fetch = (async (url: URL, init: RequestInit) => {
		seen = { url: String(url), headers: new Headers(init.headers) }
		const body = new ReadableStream({
			start(c) {
				const enc = new TextEncoder()
				c.enqueue(enc.encode('retry: 10000\nevent: init\ndata: connected\n\n'))
				c.enqueue(enc.encode('data: {"id":"7","peer_id":"p","message":"hola","image":null,"created_at":"2026-11-06T04:00:00Z"}\n\ndata: roto\n\n'))
				c.close()
			},
		})
		return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
	}) as typeof fetch
	const client = new QvaPayClient({ token: 'tok', dryRun: false, baseUrl: 'https://terminalp2p.com/qp' })
	const msgs: string[] = []
	await client.chatStream(U, 'o1', (m) => msgs.push(m.message ?? ''), new AbortController().signal)
	assert.deepEqual(msgs, ['hola'])
	assert.equal(seen!.url, `https://terminalp2p.com/qp/p2p/${U}/chat/stream?order=o1`)
	assert.equal(seen!.headers.get('authorization'), 'Bearer tok')

	globalThis.fetch = (async () => new Response('{"error":"No eres participante"}', { status: 403 })) as unknown as typeof fetch
	await assert.rejects(client.chatStream(U, undefined, () => {}, new AbortController().signal), (e: { status: number }) => e.status === 403)
})

test('el relé pide el flujo del chat como event-stream', async (t) => {
	const real = globalThis.fetch
	t.after(() => (globalThis.fetch = real))
	let accept: string | null = null
	globalThis.fetch = (async (_url: string, init: RequestInit) => {
		accept = new Headers(init.headers).get('accept')
		return new Response('event: init\ndata: connected\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } })
	}) as typeof fetch
	const url = new URL(`https://terminalp2p.com/qp/p2p/${U}/chat/stream`)
	const res = await relay(new Request(url, { headers: { Authorization: 'Bearer t' } }), url)
	assert.equal(accept, 'text/event-stream')
	assert.equal(res.headers.get('content-type'), 'text/event-stream')
	assert.equal(res.headers.get('cache-control'), 'no-store')
	assert.match(await res.text(), /event: init/)
})
