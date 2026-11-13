import assert from 'node:assert/strict'
import { test } from 'node:test'
import './i18n-es.ts'
import { Broker, type AccountStore } from '../src/broker/routes.ts'
import { QvaPayError, type QvaPayClient } from '../src/qvapay/client.ts'
import type { P2POffer } from '../src/qvapay/types.ts'

// QvaPay simulado: el usuario "yo" ya tomó dos ofertas
function fakeQvaPay() {
	const calls: string[] = []
	// Cada lectura del chat (aparte, para no mezclarla con las escrituras que comprueban otras pruebas)
	const chats: string[] = []
	const other = { uuid: 's1', username: 'otro' }
	const me = { uuid: 'me', username: 'yo' }
	const offers: Record<string, P2POffer> = {
		// Compro USD: me toca pagar
		a1: { uuid: 'a1', type: 'sell', coin: 'BANK_CUP', amount: '20', receive: '20100', status: 'processing', User: other, Peer: me, details: { 'Nro de tarjeta': '9200 1111' } },
		// Vendo USD: me pagaron, me toca liberar
		b1: { uuid: 'b1', type: 'buy', coin: 'BANK_CUP', amount: '30', receive: '30300', status: 'paid', User: other, Peer: me, tx_id: 'REF-7' },
	}
	const client = {
		me: async () => ({ uuid: 'me', username: 'yo', balance: 100, kyc: true, golden_check: false, p2p_enabled: true }),
		extended: async () => (calls.push('extended'), { uuid: 'me', username: 'yo', balance: 100, kyc: true, golden_check: false, p2p_enabled: true, p2p_completed_count: 42, p2p_average_rating: 4.8, p2p_raters_count: 30 }),
		getOffer: async (uuid: string) => structuredClone(offers[uuid]),
		listOffers: async () => ({ current_page: 1, per_page: 50, total: 2, data: Object.values(offers) }),
		getChat: async (uuid: string) => (chats.push(uuid), [{ id: '1', peer_id: 's1', message: 'hola', image: null, created_at: '2026-11-11T12:00:00Z' }]),
		markPaid: async (uuid: string, tx: string) => {
			calls.push(`paid:${uuid}:${tx}`)
			offers[uuid].status = 'paid'
		},
		markReceived: async (uuid: string) => {
			calls.push(`received:${uuid}`)
			offers[uuid].status = 'completed'
			return { amount: 29.92, fee: 0.08, gross_amount: 30 }
		},
		cancelOrder: async (uuid: string) => (calls.push(`cancel:${uuid}`), { message: 'P2P cancelada' }),
		editOffer: async (uuid: string, body: unknown) => void calls.push(`edit:${uuid}:${JSON.stringify(body)}`),
		sendChatImage: async (uuid: string, file: Blob, name: string, message?: string) => void calls.push(`image:${uuid}:${file.size}:${name}:${message ?? ''}`),
	}
	return { client: client as unknown as QvaPayClient, calls, chats, offers }
}

const BASE = 'https://terminalp2p.com/api/broker'
const HEADERS = { 'Content-Type': 'application/json', 'X-Broker': '1', Cookie: 'sid=sid1' }

async function setup() {
	const fake = fakeQvaPay()
	const acc = { sid: 'sid1', me: await fake.client.me(), client: fake.client }
	const accounts = { get: async (sid?: string) => (sid === 'sid1' ? acc : null) } as unknown as AccountStore
	const broker = new Broker({ accounts, market: { wake() {} }, dryRun: false })
	const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = HEADERS) => {
		const res = (await broker.handle(new Request(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })))!
		return { status: res.status, body: await res.json() }
	}
	return { fake, post: (p: string, b: unknown, h?: Record<string, string>) => call('POST', p, b, h), get: (p: string, h?: Record<string, string>) => call('GET', p, undefined, h) }
}

test('mis operaciones: acciones según el lado y liberación protegida', async () => {
	const { fake, post, get } = await setup()
	const { body } = await get('/trades')
	const byId = Object.fromEntries(body.trades.map((t: { id: string }) => [t.id, t]))
	assert.deepEqual(byId.a1.actions, ['pay', 'cancel'])
	assert.deepEqual(byId.b1.actions, ['release', 'dispute'])

	// El detalle trae los datos del vendedor para pagarle
	const detail = await get('/trade?offer=a1')
	assert.deepEqual(detail.body.ownerDetails, [{ name: 'Nro de tarjeta', value: '9200 1111' }])

	// Liberar con la operación en "esperando pago" está prohibido
	const early = await post('/trade/action', { offer: 'a1', action: 'release' })
	assert.equal(early.status, 400)
	assert.match(early.body.error, /no en pagado/)

	// Pagar exige referencia
	assert.equal((await post('/trade/action', { offer: 'a1', action: 'paid' })).status, 400)
	assert.equal((await post('/trade/action', { offer: 'a1', action: 'paid', txId: 'REF-9' })).status, 200)

	// Con la operación en "pagado" sí se libera
	const ok = await post('/trade/action', { offer: 'b1', action: 'release' })
	assert.equal(ok.status, 200)
	assert.match(ok.body.message, /Liberado/)
	assert.deepEqual(fake.calls, ['paid:a1:REF-9', 'received:b1'])
})

test('tu oferta por rango ya completada: el detalle trae sus partes para calificar cada una', async () => {
	const { fake, get } = await setup()
	const me = { uuid: 'me', username: 'yo' }
	fake.offers.r1 = {
		uuid: 'r1', type: 'sell', coin: 'BANK_CUP', amount: '30', receive: '31500', status: 'completed', offer_kind: 'flexible', User: me,
		Orders: [
			{ uuid: 'o1', amount: '20', receive: '21000', status: 'completed', Taker: { uuid: 't1', username: 'ana' }, my_rating: { rating: '5' } },
			{ uuid: 'o2', amount: '10', receive: '10500', status: 'completed', Taker: { uuid: 't2', username: 'luis' }, my_rating: null },
			{ uuid: 'o3', amount: '5', receive: '5250', status: 'cancelled', Taker: { uuid: 't3', username: 'pepe' } },
		],
	}
	const whole = await get('/trade?offer=r1')
	assert.deepEqual(
		whole.body.parts.map((p: { order: string; counterparty: string; usd: number; rated: number | null }) => [p.order, p.counterparty, p.usd, p.rated]),
		[['o1', 'ana', 20, 5], ['o2', 'luis', 10, null]],
	)
	// Una parte abierta por su orden ya no lista partes: allí van las estrellas
	assert.equal((await get('/trade?offer=r1&order=o2')).body.parts, null)
})

test('liberar dos veces: la segunda no llega a QvaPay, y si ya se liberó por fuera no es un error', async () => {
	const { fake, post } = await setup()
	// QvaPay sigue diciendo «pagado» justo después de liberar
	const real = fake.client.markReceived.bind(fake.client)
	fake.client.markReceived = (async (uuid: string) => {
		const r = await real(uuid)
		fake.offers[uuid].status = 'paid'
		return r
	}) as typeof fake.client.markReceived
	assert.match((await post('/trade/action', { offer: 'b1', action: 'release' })).body.message, /Liberado/)
	const again = await post('/trade/action', { offer: 'b1', action: 'release' })
	assert.deepEqual([again.status, again.body.message], [200, 'Ya estaba liberada: QvaPay tarda unos segundos en marcarla completada.'])
	assert.deepEqual(fake.calls, ['received:b1'])

	// Liberada desde la web de QvaPay mientras tenías el terminal abierto: QvaPay contesta 403 y ya está completada
	const me = { uuid: 'me', username: 'yo' }
	fake.offers.b2 = { uuid: 'b2', type: 'buy', coin: 'BANK_CUP', amount: '10', receive: '10100', status: 'paid', User: { uuid: 's1', username: 'otro' }, Peer: me }
	fake.client.markReceived = (async (uuid: string) => {
		fake.offers[uuid].status = 'completed'
		throw new QvaPayError(403, 'No se puede recibir esta oferta')
	}) as typeof fake.client.markReceived
	assert.match((await post('/trade/action', { offer: 'b2', action: 'release' })).body.message, /Ya estaba liberada/)
	// Y ya completada antes de tocar: tampoco se manda
	assert.match((await post('/trade/action', { offer: 'b2', action: 'release' })).body.message, /Ya estaba liberada/)
	// Un 403 con la operación todavía en «pagado» sí es un error
	fake.offers.b3 = { ...fake.offers.b2, uuid: 'b3', status: 'paid' }
	fake.client.markReceived = (async () => {
		throw new QvaPayError(403, 'No se puede recibir esta oferta')
	}) as typeof fake.client.markReceived
	assert.notEqual((await post('/trade/action', { offer: 'b3', action: 'release' })).status, 200)
})

test('publicar sin datos de pago (como en QvaPay) y con el mensaje público', async () => {
	const { fake, post } = await setup()
	const sent: unknown[] = []
	;(fake.client as unknown as { createOffer: (b: unknown) => Promise<unknown> }).createOffer = async (b) => (sent.push(b), { p2p: { uuid: 'n1' }, duplicate: false })
	const r = await post('/offer/create', { type: 'buy', coin: 'BANK_CUP', amount: 10, price: 500, details: [{ name: 'Nro de tarjeta', value: '' }], message: ' Lee el mensaje fijado ' })
	assert.equal(r.status, 200)
	const body = sent[0] as { details: unknown[]; message?: string }
	assert.deepEqual([body.details, body.message], [[], 'Lee el mensaje fijado'])
	// Una venta con solo algunos datos: van los que se rellenaron
	await post('/offer/create', { type: 'sell', coin: 'BANK_CUP', amount: 10, price: 500, details: [{ name: 'Nro de tarjeta', value: '9200 1111' }, { name: 'Celular', value: '' }] })
	assert.deepEqual((sent[1] as { details: unknown[] }).details, [{ name: 'Nro de tarjeta', value: '9200 1111' }])
})

test('cancelar tu oferta: si alguien la acaba de tomar no se manda nada a QvaPay', async () => {
	const { fake, post } = await setup()
	const me = { uuid: 'me', username: 'yo' }
	// Tu venta, que el terminal aún veía publicada, ya la tomó alguien: cancelarla abriría una disputa
	fake.offers.c1 = { uuid: 'c1', type: 'sell', coin: 'BANK_CUP', amount: '10', receive: '10500', status: 'processing', User: me, Peer: { uuid: 's1', username: 'otro' } }
	fake.offers.c2 = { uuid: 'c2', type: 'sell', coin: 'BANK_CUP', amount: '10', receive: '10500', status: 'open', User: me }
	const taken = await post('/trade/action', { offer: 'c1', action: 'cancel_offer' })
	assert.equal(taken.status, 409)
	assert.match(taken.body.error, /acaba de tomar/)
	assert.equal((await post('/trade/action', { offer: 'c2', action: 'cancel_offer' })).status, 200)
	assert.deepEqual(fake.calls, ['cancel:c2'])
	// Ya cancelada (un toque repetido o desde otra pestaña): sale bien y no se vuelve a pedir a QvaPay
	fake.offers.c3 = { uuid: 'c3', type: 'sell', coin: 'BANK_CUP', amount: '10', receive: '10500', status: 'cancelled', User: me }
	const again = await post('/trade/action', { offer: 'c3', action: 'cancel_offer' })
	assert.equal(again.status, 200)
	assert.match(again.body.message, /ya estaba cancelada/)
	assert.deepEqual(fake.calls, ['cancel:c2'])
})

test('sin sesión no hay operaciones y los POST ajenos se rechazan', async () => {
	const { post, get } = await setup()
	assert.equal((await get('/trades', {})).status, 401)
	assert.equal((await post('/trade/action', { offer: 'b1', action: 'release' }, { 'Content-Type': 'application/json', Cookie: 'sid=sid1' })).status, 403)
	assert.equal(
		(await post('/trade/action', { offer: 'b1', action: 'release' }, { ...HEADERS, Origin: 'https://evil.example' })).status,
		403,
	)
})

test('conectar: límite de intentos por IP', async () => {
	const { post } = await setup()
	const h = { ...HEADERS, 'cf-connecting-ip': '203.0.113.9' }
	for (let i = 0; i < 10; i++) assert.equal((await post('/connect', { token: 'x' }, h)).status, 400)
	assert.equal((await post('/connect', { token: 'x' }, h)).status, 429)
})

test('editar tu oferta: requisitos, solo VIP, pública, por partes y mensaje', async () => {
	const { fake, post } = await setup()
	const me = { uuid: 'me', username: 'yo' }
	fake.offers.e1 = { uuid: 'e1', type: 'sell', coin: 'BANK_CUP', amount: '10', receive: '10500', status: 'open', User: me, private: true, requirements: { min_trustscore: 50 } }
	const edit = (b: Record<string, unknown>) => post('/offer/edit', { offer: 'e1', amount: 10, price: 1050, ...b })
	const last = () => JSON.parse(fake.calls.at(-1)!.split(':').slice(2).join(':'))

	// Requisitos (se conserva el de la web), solo VIP y de privada a pública
	assert.equal((await edit({ requirements: { min_completed: 25, min_trustscore: 50 }, onlyVip: true, makePublic: true })).status, 200)
	assert.deepEqual(last(), { amount: 10, receive: 10500, requirements: { min_completed: 25, min_trustscore: 50 }, only_vip: 1, private: false })

	// A por partes: con sus límites y sin pasarse del monto
	assert.equal((await edit({ toFlexible: true, orderMin: 2, orderMax: 20 })).status, 400)
	const flex = await edit({ toFlexible: true, orderMin: 2, orderMax: 5 })
	assert.equal(flex.status, 200)
	assert.match(flex.body.message, /por partes/)
	assert.deepEqual(last(), { offer_kind: 'flexible', amount: 10, receive: 10500, order_min: 2, order_max: 5 })

	// El mensaje público es de GOLD: sin GOLD no se manda; vaciarlo sí
	const n = fake.calls.length
	assert.equal((await edit({ message: 'Pago rápido' })).status, 400)
	assert.equal(fake.calls.length, n)
	fake.offers.e1.message = 'viejo'
	assert.equal((await edit({ message: '' })).status, 200)
	assert.deepEqual(last(), { amount: 10, receive: 10500, message: null })

	// Requisito con un valor que QvaPay no acepta
	assert.equal((await edit({ requirements: { min_completed: 7 } })).status, 400)
})

test('imagen al chat: solo imágenes y con tope de tamaño', async () => {
	const { fake } = await setup()
	const acc = { sid: 'sid1', me: await fake.client.me(), client: fake.client }
	const broker = new Broker({ accounts: { get: async () => acc } as unknown as AccountStore, market: { wake() {} }, dryRun: false })
	const send = async (blob: Blob, message = '') => {
		const form = new FormData()
		form.append('offer', 'a1')
		form.append('message', message)
		form.append('file', blob)
		const res = (await broker.handle(new Request(BASE + '/trade/image', { method: 'POST', headers: { 'X-Broker': '1', Cookie: 'sid=sid1' }, body: form })))!
		return res.status
	}
	assert.equal(await send(new Blob([new Uint8Array(1000)], { type: 'image/png' }), 'comprobante'), 200)
	assert.equal(await send(new Blob(['<svg/>'], { type: 'image/svg+xml' })), 400)
	assert.equal(await send(new Blob([new Uint8Array(2 * 1024 * 1024 + 1)], { type: 'image/jpeg' })), 413)
	assert.deepEqual(fake.calls, ['image:a1:1000:imagen.png:comprobante'])

	// Se corta sin respuesta (conexión lenta): avisa de que pudo llegar en vez del error del navegador
	fake.client.sendChatImage = async () => {
		throw new DOMException('signal timed out', 'TimeoutError')
	}
	const form = new FormData()
	form.append('offer', 'a1')
	form.append('file', new Blob([new Uint8Array(1000)], { type: 'image/jpeg' }))
	const res = (await broker.handle(new Request(BASE + '/trade/image', { method: 'POST', headers: { 'X-Broker': '1', Cookie: 'sid=sid1' }, body: form })))!
	assert.equal(res.status, 504)
	assert.match(((await res.json()) as { error: string }).error, /Mira el chat antes de reintentar/)
})

test('/me trae tus operaciones y tu valoración de P2P, pedidas como mucho cada 10 minutos', async () => {
	const { fake, get } = await setup()
	const a = await get('/me')
	assert.equal(a.body.p2pCompleted, 42)
	assert.equal(a.body.p2pRating, 4.8)
	await get('/me')
	assert.equal(fake.calls.filter((c) => c === 'extended').length, 1)
})

test('detalle de una operación: con chat=0 trae el estado sin leer el chat', async () => {
	const { fake, get } = await setup()
	const full = await get('/trade?offer=a1')
	assert.equal(full.body.chat.length, 1)
	assert.equal(full.body.chat[0].text, 'hola')
	assert.equal(fake.chats.filter((c) => c === 'a1').length, 1)
	const light = await get('/trade?offer=a1&chat=0')
	assert.equal(light.status, 200)
	assert.equal(light.body.chat, null)
	assert.equal(light.body.status, 'processing')
	// No se pidió el chat a QvaPay otra vez
	assert.equal(fake.chats.filter((c) => c === 'a1').length, 1)
})

test('tomar una oferta pausada: dice por qué y, si es la pausa automática, a qué hora vuelve (hora de Cuba)', async () => {
	const { fake, post } = await setup()
	fake.offers.p1 = { uuid: 'p1', type: 'sell', coin: 'BANK_CUP', amount: '20', receive: '20100', status: 'open', User: { uuid: 's1', username: 'otro' }, pause: { reason: 'taker_left', until: '2026-10-27T20:10:00.000Z' } } as P2POffer
	const auto = await post('/offer/apply', { offer: 'p1' })
	assert.equal(auto.status, 409)
	assert.match(auto.body.error, /en pausa unos minutos porque se fue quien la tomó: vuelve al mercado a las 16:10/)
	fake.offers.p1.pause = { reason: 'owner', until: null }
	assert.match((await post('/offer/apply', { offer: 'p1' })).body.error, /Su dueño pausó la oferta/)
})

test('mi cartera de acciones: solo lectura, con números limpios, y sin el permiso «read» lo dice', async () => {
	const { fake, get } = await setup()
	const asked: string[] = []
	let mode: 'ok' | 'scope' = 'ok'
	Object.assign(fake.client, {
		stocksPortfolio: async (page: number, take: number) => {
			asked.push(`${page}:${take}`)
			if (mode === 'scope') throw new QvaPayError(403, 'sin permiso', 'INSUFFICIENT_SCOPE')
			return {
				success: true,
				data: {
					positions: [
						{ id: '1', symbol: 'AAPL', quantity: '1.279832', avg_cost: 175.4, current_price: 178.52, market_value: 228.48, cost_basis: 224.49, unrealized_pnl: 3.99, unrealized_pnl_percent: 1.78 },
						{ symbol: '<b>', quantity: 1 },
						{ symbol: 'NVDA', quantity: 0 },
					],
					summary: { total_market_value: 228.48, total_cost_basis: 224.49, total_unrealized_pnl: 3.99, total_unrealized_pnl_percent: 1.78, market_open: true },
					trades: [
						{ uuid: 'u1', symbol: 'AAPL', type: 'buy', quantity: 0.279832, market_price: 178.25, effective_price: 178.68, spread_percent: 0.24, fee_amount: 0.25, total_amount: 50.25, realized_pnl: null, after_hours: false, created_at: '2025-03-17T15:30:00.000Z' },
						{ symbol: 'AAPL', type: 'raro', quantity: 1, effective_price: 1, total_amount: 1, created_at: 'x' },
					],
				},
			}
		},
	})
	const r = await get('/stocks/portfolio?page=2')
	assert.equal(r.status, 200)
	assert.deepEqual(asked, ['2:20'])
	assert.deepEqual(r.body.positions, [{ symbol: 'AAPL', quantity: 1.279832, avgCost: 175.4, price: 178.52, value: 228.48, cost: 224.49, pnl: 3.99, pnlPct: 1.78 }])
	assert.deepEqual(r.body.summary, { value: 228.48, cost: 224.49, pnl: 3.99, pnlPct: 1.78 })
	assert.deepEqual(r.body.trades, [{ id: 'u1', symbol: 'AAPL', side: 'buy', quantity: 0.279832, marketPrice: 178.25, price: 178.68, spreadPct: 0.24, fee: 0.25, total: 50.25, realizedPnl: null, afterHours: false, at: Date.parse('2025-03-17T15:30:00.000Z') }])
	assert.equal(r.body.more, false)
	// Página fuera de rango: la primera
	await get('/stocks/portfolio?page=abc')
	assert.equal(asked.at(-1), '1:20')
	mode = 'scope'
	const denied = await get('/stocks/portfolio')
	assert.equal(denied.status, 400)
	assert.equal(denied.body.code, 'NO_READ')
	// Sin cuenta conectada, nada
	assert.equal((await get('/stocks/portfolio', { 'X-Broker': '1' })).status, 401)
})

test('comprobantes: la lista, subir solo fotos o PDF hasta 4 MB, el archivo y los errores en claro', async () => {
	const { fake } = await setup()
	const A = '1f0c6b1e-5d7a-4d2e-9a53-4a2f0a0d9a11'
	const seen: string[] = []
	const c = fake.client as unknown as Record<string, unknown>
	c.attachments = async (uuid: string, order?: string) => (
		seen.push(`list:${uuid}:${order ?? ''}`),
		{
			attachments: [
				{ uuid: A, kind: 'pdf', mime: 'application/pdf', size: 245120, mine: true, created_at: '2026-11-06T15:04:05.000Z' },
				{ uuid: '../../withdraw', kind: 'image', mime: 'image/jpeg', size: 1, mine: true, created_at: '2026-11-06T15:04:05.000Z' },
			],
			limits: { max_bytes: 4194304, max_per_party: 5, remaining: 4, can_upload: true, proof_replaces_tx_id: true },
		}
	)
	c.uploadAttachment = async (uuid: string, file: Blob, name: string, order?: string) => (seen.push(`up:${uuid}:${file.size}:${name}:${order ?? ''}`), { attachment: {} })
	c.attachmentFile = async (uuid: string, id: string, order?: string) => (seen.push(`file:${uuid}:${id}:${order ?? ''}`), new Blob([new Uint8Array([1, 2, 3])], { type: 'text/html' }))
	const acc = { sid: 'sid1', me: await fake.client.me(), client: fake.client }
	const broker = new Broker({ accounts: { get: async () => acc } as unknown as AccountStore, market: { wake() {} }, dryRun: false })
	const H = { 'X-Broker': '1', Cookie: 'sid=sid1' }

	// La lista, con la orden de la oferta por rango y sin lo que no es un comprobante de verdad
	let res = (await broker.handle(new Request(BASE + '/trade/proofs?offer=a1&order=o1', { headers: H })))!
	const list = (await res.json()) as { proofs: { id: string; pdf: boolean; mine: boolean }[]; limits: Record<string, unknown> }
	assert.deepEqual(list.proofs.map((p) => [p.id, p.pdf, p.mine]), [[A, true, true]])
	assert.deepEqual(list.limits, { maxBytes: 4194304, maxPerParty: 5, remaining: 4, canUpload: true, proofReplacesTx: true })

	const send = async (blob: Blob, order?: string) => {
		const form = new FormData()
		form.append('offer', 'a1')
		if (order) form.append('order', order)
		form.append('file', blob)
		return (await broker.handle(new Request(BASE + '/trade/proof', { method: 'POST', headers: H, body: form })))!
	}
	assert.equal((await send(new Blob([new Uint8Array(1000)], { type: 'application/pdf' }), 'o1')).status, 200)
	assert.equal((await send(new Blob([new Uint8Array(1000)], { type: 'image/webp' }))).status, 200)
	assert.equal((await send(new Blob(['<svg/>'], { type: 'image/svg+xml' }))).status, 400)
	assert.equal((await send(new Blob([new Uint8Array(1000)], { type: 'image/gif' }))).status, 400)
	assert.equal((await send(new Blob([new Uint8Array(4 * 1024 * 1024 + 1)], { type: 'image/jpeg' }))).status, 413)

	// El archivo: lo que no es un tipo admitido nunca llega como algo que el navegador interprete
	res = (await broker.handle(new Request(BASE + `/trade/proof?offer=a1&order=o1&id=${A}`, { headers: H })))!
	assert.equal(res.status, 200)
	assert.equal(res.headers.get('content-type'), 'application/octet-stream')
	assert.equal((await res.arrayBuffer()).byteLength, 3)
	assert.equal((await broker.handle(new Request(BASE + '/trade/proof?offer=a1&id=../../withdraw', { headers: H })))!.status, 400)
	assert.deepEqual(seen, ['list:a1:o1', 'up:a1:1000:comprobante.pdf:o1', 'up:a1:1000:comprobante.webp:', `file:a1:${A}:o1`])

	// Errores de QvaPay en palabras claras
	c.uploadAttachment = async () => {
		throw new QvaPayError(403, 'Forbidden', 'ATTACHMENT_PAYER_ONLY')
	}
	res = await send(new Blob([new Uint8Array(10)], { type: 'image/png' }))
	assert.equal(res.status, 400)
	assert.match(((await res.json()) as { error: string }).error, /Solo quien paga/)
	c.uploadAttachment = async () => {
		throw new QvaPayError(409, 'Conflict', 'ATTACHMENT_LIMIT')
	}
	assert.match(((await (await send(new Blob([new Uint8Array(10)], { type: 'image/png' }))).json()) as { error: string }).error, /todos los comprobantes/)
	// Sin respuesta: pudo subirse, y como no se puede borrar, no se manda otra vez a ciegas
	c.uploadAttachment = async () => {
		throw new DOMException('signal timed out', 'TimeoutError')
	}
	res = await send(new Blob([new Uint8Array(10)], { type: 'image/png' }))
	assert.equal(res.status, 504)
	assert.match(((await res.json()) as { error: string }).error, /Mira la lista antes de reintentar/)
	c.attachmentFile = async () => {
		throw new QvaPayError(404, 'Not found')
	}
	assert.equal((await broker.handle(new Request(BASE + `/trade/proof?offer=a1&id=${A}`, { headers: H })))!.status, 404)
})

test('marcar pagado: sin referencia solo con tu comprobante', async () => {
	const { fake, post } = await setup()
	assert.equal((await post('/trade/action', { offer: 'a1', action: 'paid', txId: '' })).status, 400)
	assert.equal(fake.offers.a1.status, 'processing')
	const r = await post('/trade/action', { offer: 'a1', action: 'paid', txId: '', proof: true })
	assert.equal(r.status, 200)
	assert.ok(fake.calls.includes('paid:a1:'))
	// Sin comprobante válido QvaPay lo rechaza: se dice qué falta
	fake.client.markPaid = async () => {
		throw new QvaPayError(400, 'Bad request', 'PAYMENT_PROOF_REQUIRED')
	}
	const e = await post('/trade/action', { offer: 'a1', action: 'paid', txId: '', proof: true })
	assert.equal(e.status, 400)
	assert.match(e.body.error, /referencia de tu transferencia o sube antes el comprobante/)
})
