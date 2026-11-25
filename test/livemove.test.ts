import assert from 'node:assert/strict'
import { test } from 'node:test'
import { copyLive, exportPage, importPage, liveActive, liveName } from '../worker/livebook.ts'

// Un almacenamiento de Durable Object en memoria: list en orden de clave, con start (incluido), prefix y limit
function fakeStorage(init: Record<string, unknown> = {}) {
	const m = new Map<string, unknown>(Object.entries(init))
	return {
		m,
		async list<T>(o: { start?: string; prefix?: string; limit?: number }) {
			const keys = [...m.keys()].sort().filter((k) => (!o.start || k >= o.start) && (!o.prefix || k.startsWith(o.prefix)))
			return new Map(keys.slice(0, o.limit ?? keys.length).map((k) => [k, m.get(k) as T]))
		},
		async put(entries: Record<string, unknown>) {
			assert.ok(Object.keys(entries).length <= 128, 'de 128 en 128 como mucho')
			for (const [k, v] of Object.entries(entries)) m.set(k, v)
		},
	}
}
// Un libro como lo ve el Worker: sus rutas de mudanza sobre su almacenamiento; el activo no acepta escrituras
function fakeBook(storage: ReturnType<typeof fakeStorage>, active = false) {
	return {
		async fetch(u: string, init?: RequestInit) {
			const url = new URL(u)
			if (url.pathname === '/move/export') return Response.json(await exportPage(storage, url.searchParams.get('start') ?? undefined, url.searchParams.get('prefix') ?? undefined))
			if (url.pathname === '/move/import') {
				if (active) return Response.json({ error: 'activo' }, { status: 409 })
				return Response.json({ written: await importPage(storage, JSON.parse(String(init?.body)).entries) })
			}
			return new Response('no', { status: 404 })
		},
	}
}

test('libro activo: «book» de siempre, o el de LIVE_NAME; los demás duermen', () => {
	assert.equal(liveName({}), 'book')
	assert.equal(liveName({ LIVE_NAME: 'book-b' }), 'book-b')
	assert.equal(liveActive('book', {}), true)
	assert.equal(liveActive('book-b', {}), false)
	assert.equal(liveActive('book', { LIVE_NAME: 'book-b' }), false)
	assert.equal(liveActive('book-b', { LIVE_NAME: 'book-b' }), true)
	// Sin saber su nombre se porta como siempre: activo solo si no se pidió otro
	assert.equal(liveActive(undefined, {}), true)
	assert.equal(liveActive(undefined, { LIVE_NAME: 'book-b' }), false)
})

test('mudanza: copia todo, página a página y en orden, sin perder ni repetir claves', async () => {
	const init: Record<string, unknown> = { meta: { events: 3, synced: ['ETECSA:ask'] }, recent: [{ t: 1 }] }
	for (let i = 0; i < 1203; i++) init[`o:${String(i).padStart(5, '0')}`] = { uuid: `u${i}`, price: i / 10 }
	init['rs:ana'] = { username: 'ana', sealed: 'xx' }
	init['rsx:ana'] = { day: '2026-11-25', usd: 7.52, open: [], applies: [] }
	init['rsf:ana'] = [{ offer: 'o1', status: 'taken' }]
	const from = fakeStorage(init)
	const to = fakeStorage()
	const r = await copyLive(fakeBook(from, true), fakeBook(to))
	assert.equal(r.copied, Object.keys(init).length)
	assert.equal(r.pages, 3) // 500 + 500 + 208
	assert.deepEqual(Object.fromEntries([...to.m].sort()), Object.fromEntries(Object.entries(init).sort()))
})

test('mudanza: con prefijo solo esas claves; al activo no se le escribe', async () => {
	const from = fakeStorage({ 'o:1': 1, 'rs:ana': { a: 1 }, 'rsf:ana': [], 'rsx:ana': { usd: 1 }, recent: [] })
	const to = fakeStorage({ 'rsx:ana': { usd: 0 } })
	const r = await copyLive(fakeBook(from, true), fakeBook(to), 'rs')
	assert.equal(r.copied, 3)
	assert.deepEqual([...to.m.keys()].sort(), ['rs:ana', 'rsf:ana', 'rsx:ana'])
	assert.deepEqual(to.m.get('rsx:ana'), { usd: 1 }) // lo del activo pisa lo que tuviera
	await assert.rejects(copyLive(fakeBook(from), fakeBook(fakeStorage(), true)), /no aceptó/)
})
