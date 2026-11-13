import assert from 'node:assert/strict'
import { test } from 'node:test'
import { allowed, relay } from '../worker/relay.ts'

const U = '7c9e6679-7425-40de-944b-e07fc1f90ae7'

test('el relé solo deja pasar las rutas que usa la app', () => {
	for (const [m, p] of [['GET', '/user'], ['GET', '/p2p'], ['GET', '/p2p/averages'], ['GET', `/p2p/${U}`], ['GET', `/p2p/${U}/chat`], ['GET', `/p2p/${U}/chat/stream`], ['POST', `/p2p/${U}/received`], ['POST', `/p2p/${U}/chat`], ['POST', '/p2p/create'], ['POST', `/p2p/${U}/apply`], ['POST', `/p2p/${U}/edit`], ['POST', `/p2p/${U}/pause`], ['GET', '/coins'], ['PATCH', `/p2p/${U}/rate`], ['GET', '/user/payment-methods'], ['GET', '/user/extended'], ['GET', '/stocks/portfolio']])
		assert.ok(allowed(m, p), `${m} ${p}`)
	for (const [m, p] of [
		['POST', '/transaction/transfer'], // mover saldo: nunca
		['POST', '/withdraw'],
		['DELETE', `/p2p/${U}`],
		['GET', '/user/../withdraw'],
		['GET', `/p2p/${U}/../../withdraw`],
		['POST', '/user'],
		['PATCH', `/p2p/${U}/edit`],
		['POST', '/user/payment-methods'], // solo leer los guardados, nunca crearlos ni borrarlos
		['DELETE', '/user/payment-methods'],
		['POST', `/p2p/${U}/chat/stream`],
		['POST', '/stocks/NVDA/buy'], // las acciones: solo mirar la cartera, nunca comprar ni vender
		['POST', '/stocks/NVDA/sell'],
		['GET', '/stocks/portfolio/../../withdraw'],
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

test('imagen del chat: el formulario con archivo pasa entero a QvaPay, con tope de tamaño', async (t) => {
	const real = globalThis.fetch
	t.after(() => (globalThis.fetch = real))
	let sent: { type: string | null; bytes: number } | undefined
	globalThis.fetch = (async (_url: string, init: RequestInit) => {
		sent = { type: new Headers(init.headers).get('content-type'), bytes: (init.body as ArrayBuffer).byteLength }
		return new Response('{"message":"1"}', { status: 200, headers: { 'content-type': 'application/json' } })
	}) as typeof fetch
	const url = new URL(`https://terminalp2p.com/qp/p2p/${U}/chat`)
	const post = (bytes: number) => {
		const form = new FormData()
		form.append('file', new Blob([new Uint8Array(bytes).fill(255)], { type: 'image/jpeg' }), 'imagen.jpg')
		return relay(new Request(url, { method: 'POST', headers: { Origin: url.origin, Authorization: 'Bearer t' }, body: form }), url)
	}
	// 200 KB: mucho más que el tope de 64 KB de las escrituras de texto
	assert.equal((await post(200_000)).status, 200)
	assert.match(sent!.type ?? '', /^multipart\/form-data; boundary=/)
	assert.ok(sent!.bytes > 200_000)
	assert.equal((await post(3_200_000)).status, 413)
})

test('comprobantes: listar, subir y bajar, con ?order= de las ofertas por rango y tope de 4 MB', async (t) => {
	const O = '0b8f2c1e-5a7d-4e3b-9c61-2f4d8a9e7b10'
	const A = '1f0c6b1e-5d7a-4d2e-9a53-4a2f0a0d9a11'
	assert.ok(allowed('GET', `/p2p/${U}/attachments`))
	assert.ok(allowed('POST', `/p2p/${U}/attachments`))
	assert.ok(allowed('GET', `/p2p/${U}/attachments/${A}`))
	// Ni borrar ni reemplazar, ni otra cosa colgada de la ruta
	for (const [m, p] of [
		['DELETE', `/p2p/${U}/attachments/${A}`],
		['PUT', `/p2p/${U}/attachments/${A}`],
		['POST', `/p2p/${U}/attachments/${A}`],
		['GET', `/p2p/${U}/attachments/${A}/../../../withdraw`],
		['GET', `/p2p/${U}/attachments/nombre.jpg`],
		['GET', `/p2p/attachments`],
	])
		assert.ok(!allowed(m, p), `${m} ${p}`)

	const real = globalThis.fetch
	t.after(() => (globalThis.fetch = real))
	let sent: { url: string; accept: string | null; type: string | null; bytes: number } | undefined
	globalThis.fetch = (async (url: string, init: RequestInit) => {
		const h = new Headers(init.headers)
		sent = { url, accept: h.get('accept'), type: h.get('content-type'), bytes: (init.body as ArrayBuffer | undefined)?.byteLength ?? 0 }
		if (/attachments\/[^/?]+/.test(url)) return new Response(new Uint8Array([0xff, 0xd8, 0xff]), { status: 200, headers: { 'content-type': 'image/jpeg', 'set-cookie': 'x=1' } })
		return new Response('{"attachment":{}}', { status: 201, headers: { 'content-type': 'application/json' } })
	}) as typeof fetch

	// Subir: el formulario con archivo pasa entero, con la orden
	const up = new URL(`https://terminalp2p.com/qp/p2p/${U}/attachments?order=${O}`)
	const post = (bytes: number) => {
		const form = new FormData()
		form.append('file', new Blob([new Uint8Array(bytes).fill(255)], { type: 'application/pdf' }), 'comprobante.pdf')
		return relay(new Request(up, { method: 'POST', headers: { Origin: up.origin, Authorization: 'Bearer t' }, body: form }), up)
	}
	// 3.5 MB: más que el tope de las imágenes del chat (3 MB), dentro de los 4 MB de un comprobante
	assert.equal((await post(3_500_000)).status, 201)
	assert.equal(sent!.url, `https://api.qvapay.com/p2p/${U}/attachments?order=${O}`)
	assert.match(sent!.type ?? '', /^multipart\/form-data; boundary=/)
	assert.ok(sent!.bytes > 3_500_000)
	sent = undefined
	assert.equal((await post(4 * 1024 * 1024 + 70_000)).status, 413)
	assert.equal(sent, undefined, 'lo que pasa del tope no llega a QvaPay')
	// Desde otra página, no
	const evil = await relay(new Request(up, { method: 'POST', headers: { Origin: 'https://evil.example', Authorization: 'Bearer t' }, body: new FormData() }), up)
	assert.equal(evil.status, 403)

	// Bajar: el archivo tal cual, sin cookies de QvaPay, sin caché y sin que el navegador lo interprete
	const file = new URL(`https://terminalp2p.com/qp/p2p/${U}/attachments/${A}?order=${O}`)
	const res = await relay(new Request(file, { headers: { Authorization: 'Bearer t' } }), file)
	assert.equal(res.status, 200)
	assert.equal(sent!.url, `https://api.qvapay.com/p2p/${U}/attachments/${A}?order=${O}`)
	assert.equal(sent!.accept, '*/*')
	assert.equal(res.headers.get('content-type'), 'image/jpeg')
	assert.equal(res.headers.get('set-cookie'), null)
	assert.equal(res.headers.get('cache-control'), 'no-store')
	assert.equal(res.headers.get('x-content-type-options'), 'nosniff')
	assert.match(res.headers.get('content-security-policy') ?? '', /sandbox/)
	assert.deepEqual([...new Uint8Array(await res.arrayBuffer())], [0xff, 0xd8, 0xff])

	// Listar
	const list = new URL(`https://terminalp2p.com/qp/p2p/${U}/attachments?order=${O}`)
	await relay(new Request(list, { headers: { Authorization: 'Bearer t' } }), list)
	assert.equal(sent!.url, `https://api.qvapay.com/p2p/${U}/attachments?order=${O}`)
	assert.equal(sent!.accept, 'application/json')
})
