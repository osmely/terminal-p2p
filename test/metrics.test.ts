import assert from 'node:assert/strict'
import { test } from 'node:test'
import { actionOf, authorized, clientEvent, fingerprint, parseMeta, relayEvent, sameSecret, summarize, type MetricEvent } from '../worker/metrics.ts'

const OFFER = '0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d'
const ORDER = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const NOW = Date.parse('2026-10-23T16:00:00Z')
const SALT = 'clave-de-prueba'

test('métricas: qué escrituras del relé cuentan', () => {
	assert.deepEqual(actionOf('POST', '/p2p/create'), { event: 'create', offer: '' })
	assert.deepEqual(actionOf('POST', `/p2p/${OFFER}/apply`), { event: 'take', offer: OFFER })
	assert.deepEqual(actionOf('POST', `/p2p/${OFFER}/received`), { event: 'release', offer: OFFER })
	assert.deepEqual(actionOf('PATCH', `/p2p/${OFFER}/rate`), { event: 'rate', offer: OFFER })
	assert.equal(actionOf('POST', `/p2p/${OFFER}/chat`), null)
	assert.equal(actionOf('POST', `/p2p/${OFFER}/edit`), null)
	assert.equal(actionOf('GET', `/p2p/${OFFER}`), null)
})

test('huella: estable con la misma clave, distinta sin ella y sin el identificador', async () => {
	const a = await fingerprint(OFFER, SALT)
	assert.equal(a, await fingerprint(OFFER, SALT))
	assert.equal(a.length, 24)
	assert.ok(!a.includes(OFFER.slice(0, 8)))
	// Con otra clave sale otra huella: sin la clave secreta no se puede recalcular
	assert.notEqual(a, await fingerprint(OFFER, 'otra-clave'))
	assert.equal(await fingerprint(OFFER, ''), '')
	assert.equal(await fingerprint('no-es-uuid', SALT), '')
	assert.equal(await fingerprint(null, SALT), '')
})

test('clave del panel: comparación en tiempo constante y HTTP Basic', async () => {
	assert.equal(await sameSecret('abc', 'abc'), true)
	assert.equal(await sameSecret('abc', 'abd'), false)
	assert.equal(await sameSecret('', 'abc'), false)
	const basic = (pass: string) => new Request('https://x/admin/metrics', { headers: { Authorization: `Basic ${btoa(`yo:${pass}`)}` } })
	assert.equal(await authorized(basic('s3creta:con:dos-puntos'), 's3creta:con:dos-puntos'), true)
	assert.equal(await authorized(basic('mala'), 's3creta'), false)
	assert.equal(await authorized(new Request('https://x'), 's3creta'), false)
	assert.equal(await authorized(basic('x'), undefined), false)
	// Con tildes o eñes el navegador la manda en UTF-8 (como pide charset="UTF-8")
	const utf8 = (pass: string) => new Request('https://x/admin', { headers: { Authorization: `Basic ${Buffer.from(`yo:${pass}`, 'utf8').toString('base64')}` } })
	assert.equal(await authorized(utf8('contraseña-ñandú'), 'contraseña-ñandú'), true)
	assert.equal(await authorized(utf8('contrasena-nandu'), 'contraseña-ñandú'), false)
})

test('X-TP-Meta: solo valores válidos', () => {
	assert.deepEqual(parseMeta('coin=BANK_CUP&side=sell&usd=50.555'), { coin: 'BANK_CUP', side: 'sell', usd: 50.56, via: '' })
	assert.deepEqual(parseMeta('coin=BANK_CUP&side=buy&usd=20&via=swap'), { coin: 'BANK_CUP', side: 'buy', usd: 20, via: 'swap' })
	assert.deepEqual(parseMeta('coin=<script>&side=x&usd=9999999&via=<b>'), { coin: '', side: '', usd: 0, via: '' })
	assert.deepEqual(parseMeta(null), { coin: '', side: '', usd: 0, via: '' })
})

test('evento de publicar y de liberar, sin datos de usuario', async () => {
	const create = await relayEvent(
		{
			method: 'POST',
			path: '/p2p/create',
			query: new URLSearchParams(),
			body: JSON.stringify({ coin: 'BANK_CUP', type: 'sell', amount: 25, details: [{ name: 'Tarjeta', value: '9200' }] }),
			meta: null,
			response: new Response(JSON.stringify({ p2p: { uuid: OFFER, User: { username: 'ana' } } })),
		},
		SALT,
		NOW,
	)
	assert.deepEqual({ ...create, offer: create!.offer.length }, { t: NOW, event: 'create', status: 'ok', offer: 24, ord: '', coin: 'BANK_CUP', side: 'sell', usd: 25, source: 'relay', via: '' })
	assert.ok(!JSON.stringify(create).includes('9200') && !JSON.stringify(create).includes('ana'))

	const release = await relayEvent(
		{ method: 'POST', path: `/p2p/${OFFER}/received`, query: new URLSearchParams({ order: ORDER }), meta: 'coin=BANK_CUP&side=sell&usd=10', response: new Response(JSON.stringify({ amount: 9.9, fee: 0.1, gross_amount: 10.5 })) },
		SALT,
		NOW,
	)
	assert.deepEqual([release!.event, release!.usd, release!.offer, release!.ord], ['release', 10.5, await fingerprint(OFFER, SALT), await fingerprint(ORDER, SALT)])

	const failed = await relayEvent({ method: 'POST', path: `/p2p/${OFFER}/apply`, query: new URLSearchParams(), body: '{}', meta: null, response: new Response('{}', { status: 400 }) }, SALT, NOW)
	assert.equal(failed!.status, 'error')
})

test('aviso del navegador: solo "completed" con un identificador válido', async () => {
	const e = await clientEvent({ event: 'completed', offer: OFFER, coin: 'ZELLE', side: 'buy', usd: 30 }, SALT, NOW)
	assert.deepEqual([e!.event, e!.source, e!.coin, e!.usd], ['completed', 'client', 'ZELLE', 30])
	assert.equal(await clientEvent({ event: 'create', offer: OFFER }, SALT), null)
	assert.equal(await clientEvent({ event: 'completed', offer: 'x' }, SALT), null)
})

test('embudos: publicadas, con contraparte, completadas', () => {
	const ev = (event: MetricEvent['event'], offer: string, o: Partial<MetricEvent> = {}): MetricEvent => ({ t: NOW, event, status: 'ok', offer, ord: '', coin: 'BANK_CUP', side: 'sell', usd: 0, source: 'relay', via: '', ...o })
	const s = summarize(
		[
			ev('create', 'a', { usd: 50 }),
			ev('release', 'a', { usd: 50 }),
			ev('create', 'b', { usd: 20 }),
			ev('create', 'c', { status: 'error' }),
			ev('take', 'x', { coin: 'ZELLE', usd: 30 }),
			ev('paid', 'x'),
			ev('completed', 'x', { usd: 30, source: 'client', coin: 'ZELLE' }),
			// La misma operación vista por las dos partes cuenta una vez
			ev('release', 'x', { usd: 30, coin: 'ZELLE' }),
			ev('take', 'y', { coin: 'ZELLE' }),
		],
		30,
	)
	assert.deepEqual([s.created, s.createdTaken, s.createdCompleted], [2, 1, 1])
	assert.deepEqual([s.taken, s.takenPaid, s.takenCompleted], [2, 1, 1])
	assert.deepEqual([s.completed, s.volume], [2, 80])
	assert.deepEqual(s.errors, { create: 1 })
	assert.deepEqual(
		s.byCoin.map((c) => [c.coin, c.created, c.taken, c.completed, c.volume]),
		[
			['BANK_CUP', 2, 0, 1, 50],
			['ZELLE', 0, 2, 1, 30],
		],
	)
	assert.deepEqual(s.byDay.map((d) => [d.day, d.created, d.taken, d.paid, d.completed]), [['2026-10-23', 2, 2, 1, 2]])
	assert.deepEqual([s.swaps, s.swapsCompleted, s.swapVolume], [0, 0, 0])
})

test('Vender ya: ventas empezadas y completadas, también en ofertas por partes', () => {
	const ev = (event: MetricEvent['event'], offer: string, o: Partial<MetricEvent> = {}): MetricEvent => ({ t: NOW, event, status: 'ok', offer, ord: '', coin: 'BANK_CUP', side: 'buy', usd: 0, source: 'relay', via: '', ...o })
	const s = summarize(
		[
			ev('take', 'v', { usd: 40, via: 'swap' }),
			// El navegador la ve completada (la liberó el VIP) con la huella de la orden
			ev('completed', 'v', { ord: 'o1', usd: 40, source: 'client' }),
			ev('take', 'w', { usd: 15, via: 'swap' }),
			ev('take', 'z', { usd: 10 }),
			ev('completed', 'z', { usd: 10, source: 'client' }),
		],
		30,
	)
	assert.deepEqual([s.swaps, s.swapsCompleted, s.swapVolume], [2, 1, 40])
	assert.deepEqual([s.taken, s.completed, s.volume], [3, 2, 50])
})
