import test from 'node:test'
import assert from 'node:assert/strict'
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure'
import { decrypt, encrypt, getConversationKey } from 'nostr-tools/nip44'
import { hexToBytes } from '@noble/hashes/utils.js'
import { chatKeys, contentFor, fiatAmountOk, identityPayload, keyring, lnAddressOf, lnAddressOk, messageJson, openChat, openFromMostro, pubOf, verifyText, wordsOk, wrapChat, wrapToMostro, type NostrEvent } from '../web/mostro.ts'
import { bookOf, lnAddress, parseNode, parseOrder, relaysOf, type NostrEvent as BookEvent } from '../worker/nostr.ts'

const WORDS = 'leader monkey parrot ring guide accident before fence cannon height naive bean'
const ORDER = '6848f26e-bed1-47c3-8a6a-db8688e871e9'
const nodeSk = hexToBytes('f258e73f07386d37133718b6127f873dd7c391b8f43b331ff8254034a13d2943')
const NODE = getPublicKey(nodeSk)

test('mostro: el mensaje se escribe como lo serializa Mostro (sus firmas se comprueban sobre ese texto)', () => {
	// Orden con rango tomada con dirección Lightning: version, request_id, trade_index, id, action, payload
	assert.equal(
		messageJson({ wrapper: 'order', action: 'take-sell', id: ORDER, requestId: 7, tradeIndex: 3, payload: { payment_request: [null, 'ana@ln.tips', 15000] } }),
		`{"order":{"version":2,"request_id":7,"trade_index":3,"id":"${ORDER}","action":"take-sell","payload":{"payment_request":[null,"ana@ln.tips",15000]}}}`,
	)
	// Sin id no va la clave; request_id y trade_index van como null y el payload vacío también
	assert.equal(messageJson({ wrapper: 'restore', action: 'last-trade-index' }), '{"restore":{"version":2,"request_id":null,"trade_index":null,"action":"last-trade-index","payload":null}}')
	assert.equal(messageJson({ wrapper: 'order', action: 'rate-user', id: ORDER, payload: { rating_user: 5 } }), `{"order":{"version":2,"request_id":null,"trade_index":null,"id":"${ORDER}","action":"rate-user","payload":{"rating_user":5}}}`)
	assert.throws(() => messageJson({ wrapper: 'order', action: 'cancel', id: 'no-es-un-uuid' }))
})

test('mostro: las claves salen de las 12 palabras por la ruta de Mostro y no cambian', () => {
	assert.ok(wordsOk(WORDS))
	assert.ok(wordsOk(`  ${WORDS.toUpperCase()} `))
	assert.ok(!wordsOk('leader monkey parrot'))
	const a = keyring(WORDS)
	const b = keyring(WORDS)
	assert.equal(pubOf(a.at(0)), pubOf(b.at(0)))
	assert.notEqual(pubOf(a.at(0)), pubOf(a.at(1)))
	// NIP-06 da otra clave (m/44'/1237'/0'/0/0): la de Mostro es la de su propia cuenta 38383'
	assert.notEqual(pubOf(a.at(0)), '17162c921dc4d2518f9a101db33695df1afb56ab82f5ff3e5da6eec3ca5cd917')
	assert.throws(() => a.at(-1))
})

test('mostro: reputación = firma de la operación + prueba de identidad atada a la clave de la operación', () => {
	const k = keyring(WORDS)
	const trade = k.at(1)
	const m = { wrapper: 'order' as const, action: 'take-sell', id: ORDER, tradeIndex: 1, payload: { payment_request: [null, 'ana@ln.tips', null] as [null, string, null] } }
	const json = messageJson(m)
	const [msg, sig, proof] = JSON.parse(contentFor(m, trade, k.at(0)))
	assert.equal(JSON.stringify(msg), json)
	assert.ok(verifyText(json, sig, pubOf(trade)))
	assert.equal(proof[0], pubOf(k.at(0)))
	assert.ok(verifyText(identityPayload(pubOf(trade), json), proof[1], pubOf(k.at(0))))
	// La prueba no vale para otra clave de operación
	assert.ok(!verifyText(identityPayload(pubOf(k.at(2)), json), proof[1], pubOf(k.at(0))))
	// Sin identidad (o la misma clave): modo privado, sin firmas
	assert.equal(contentFor(m, trade, null), `[${json},null,null]`)
	assert.equal(contentFor(m, trade, trade), `[${json},null,null]`)
})

test('mostro: el evento al nodo va firmado por la clave de la operación, cifrado para el nodo y con caducidad', () => {
	const k = keyring(WORDS)
	const trade = k.at(1)
	const ev = wrapToMostro({ wrapper: 'order', action: 'fiat-sent', id: ORDER }, trade, k.at(0), NODE, 1_794_400_000)
	assert.equal(ev.kind, 14)
	assert.equal(ev.pubkey, pubOf(trade))
	assert.deepEqual(ev.tags, [['p', NODE], ['expiration', String(1_794_400_000 + 30 * 86400)]])
	const plain = JSON.parse(decrypt(ev.content, getConversationKey(nodeSk, ev.pubkey)))
	assert.equal(plain[0].order.action, 'fiat-sent')
	assert.equal(plain.length, 3)
	// Con prueba de trabajo, el id empieza con esos bits a cero
	const mined = wrapToMostro({ wrapper: 'order', action: 'fiat-sent', id: ORDER }, trade, k.at(0), NODE, 1_794_400_000, 8)
	assert.ok(mined.id.startsWith('00'))
	assert.throws(() => wrapToMostro({ wrapper: 'order', action: 'fiat-sent', id: ORDER }, trade, null, NODE, 1, 30))
	assert.throws(() => wrapToMostro({ wrapper: 'order', action: 'fiat-sent', id: ORDER }, trade, null, 'nodo', 1))
})

test('mostro: lo que manda el nodo se abre solo si es suyo, para esta clave y bien firmado', () => {
	const trade = keyring(WORDS).at(1)
	const me = pubOf(trade)
	const reply = (content: string, o: { sk?: Uint8Array; p?: string } = {}) =>
		finalizeEvent({ kind: 14, created_at: 1_794_400_000, tags: [['p', o.p ?? me]], content: encrypt(content, getConversationKey(o.sk ?? nodeSk, me)) }, o.sk ?? nodeSk) as NostrEvent
	const body = `[{"order":{"version":2,"request_id":null,"trade_index":null,"id":"${ORDER}","action":"hold-invoice-payment-accepted","payload":{"order":{"id":"${ORDER}","amount":7851,"seller_trade_pubkey":"${NODE}"}}}},null,null]`
	const msg = openFromMostro(reply(body), trade, NODE)!
	assert.equal(msg.action, 'hold-invoice-payment-accepted')
	assert.equal(msg.id, ORDER)
	assert.equal((msg.payload as { order: { amount: number } }).order.amount, 7851)
	const cant = openFromMostro(reply('[{"cant-do":{"version":2,"request_id":null,"trade_index":null,"action":"cant-do","payload":{"cant_do":"not_found"}}},null,null]'), trade, NODE)!
	assert.equal(cant.wrapper, 'cant-do')
	// De otro autor, para otra clave, manipulado o que no es JSON: nada
	const other = hexToBytes('548f68890c49fa42f104c60352395e60ff030b0b407e955f1eed1400d6c0347a')
	assert.equal(openFromMostro(reply(body, { sk: other }), trade, NODE), null)
	assert.equal(openFromMostro(reply(body, { p: NODE }), trade, NODE), null)
	// Manipulado tras firmarlo (como llega por la red: JSON recién leído, sin la marca de «ya verificado» de nostr-tools)
	assert.equal(openFromMostro({ ...JSON.parse(JSON.stringify(reply(body))), created_at: 1 }, trade, NODE), null)
	assert.equal(openFromMostro(reply('hola'), trade, NODE), null)
})

test('mostro chat: las claves compartidas salen igual que en el vector de la especificación', () => {
	const alice = hexToBytes('548f68890c49fa42f104c60352395e60ff030b0b407e955f1eed1400d6c0347a')
	const bob = hexToBytes('f258e73f07386d37133718b6127f873dd7c391b8f43b331ff8254034a13d2943')
	assert.equal(pubOf(alice), '000053c3b4773182e7c4c1b72b272d34be01bf4414a6a25c998977c516a46a01')
	const a = chatKeys(alice, pubOf(bob))
	const b = chatKeys(bob, pubOf(alice))
	assert.equal(a.convPub, 'bceb1cd2a8e98ee9729122a1693edcc39c3ace04582ff96a26705c5e4078a6f2')
	assert.equal(a.signPub, '1dba04571059183f76b148119cfa6f8004dad30cb4e810180a6df17386a7f0b4')
	assert.equal(b.convPub, a.convPub)
	assert.equal(b.signPub, a.signPub)
})

test('mostro chat: un mensaje va y vuelve, y se descarta lo que no cumple cada comprobación', () => {
	const alice = hexToBytes('548f68890c49fa42f104c60352395e60ff030b0b407e955f1eed1400d6c0347a')
	const bob = hexToBytes('f258e73f07386d37133718b6127f873dd7c391b8f43b331ff8254034a13d2943')
	const ka = chatKeys(alice, pubOf(bob))
	const kb = chatKeys(bob, pubOf(alice))
	const both = [pubOf(alice), pubOf(bob)]
	const T = 1_794_400_000
	const { outer, inner } = wrapChat('Paga a la tarjeta 9200…', alice, ka, T)
	assert.deepEqual(outer.tags, [['p', ka.convPub]])
	assert.equal(outer.pubkey, ka.signPub)
	const got = openChat(outer, kb, both, T + 5)!
	assert.equal(got.content, 'Paga a la tarjeta 9200…')
	assert.equal(got.id, inner.id)
	assert.equal(got.pubkey, pubOf(alice))
	// Firmado por alguien que no es parte de la operación
	assert.equal(openChat(outer, kb, [pubOf(bob)], T), null)
	// Del futuro (más de un minuto por delante de este reloj)
	assert.equal(openChat(outer, kb, both, T - 120), null)
	// Otro autor o dos «p»
	const stranger = hexToBytes('0101010101010101010101010101010101010101010101010101010101010101')
	const forged = finalizeEvent({ kind: 14, created_at: T, tags: [['p', ka.convPub]], content: outer.content }, stranger) as NostrEvent
	assert.equal(openChat(forged, kb, both, T), null)
	const twoP = finalizeEvent({ kind: 14, created_at: T, tags: [['p', ka.convPub], ['p', ka.convPub]], content: outer.content }, ka.sign) as NostrEvent
	assert.equal(openChat(twoP, kb, both, T), null)
	// Un mensaje viejo vuelto a envolver ahora: la hora de dentro y la de fuera no cuadran
	const rewrap = finalizeEvent({ kind: 14, created_at: T + 600, tags: [['p', ka.convPub]], content: encrypt(JSON.stringify(inner), getConversationKey(ka.conv, ka.convPub)) }, ka.sign) as NostrEvent
	assert.equal(openChat(rewrap, kb, both, T + 600), null)
})

test('mostro: cantidades enteras dentro del rango y direcciones Lightning', () => {
	assert.ok(fiatAmountOk(5000, 5000, 15000))
	assert.ok(fiatAmountOk(15000, 5000, 15000))
	assert.ok(!fiatAmountOk(4999, 5000, 15000))
	assert.ok(!fiatAmountOk(5000.5, 5000, 15000))
	assert.ok(lnAddressOk('ana.perez@walletofsatoshi.com'))
	assert.ok(!lnAddressOk('ana@localhost'))
	assert.ok(!lnAddressOk('https://evil.com'))
	assert.ok(!lnAddressOk('ana@ln.tips "x"'))
	assert.ok(!lnAddressOk('ana@127.0.0.1'))
	// Solo el usuario es el de QvaPay
	assert.equal(lnAddressOf(' @Ana_Perez '), 'ana_perez@qvpay.me')
	assert.equal(lnAddressOf('ana@blink.sv'), 'ana@blink.sv')
})

test('nostr: comprobar una dirección Lightning en su dominio (LUD-16)', async () => {
	const asked: string[] = []
	const fake = (status: number, body: unknown) =>
		(async (u: string | URL | Request) => {
			asked.push(String(u))
			return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })
		}) as typeof fetch
	const pay = { tag: 'payRequest', callback: 'https://www.qvapay.com/.well-known/lnurlp/ana/callback', minSendable: 137000, maxSendable: 544210000, metadata: JSON.stringify([['text/plain', 'Pago a ana en QvaPay'], ['text/identifier', 'ana@qvpay.me']]) }
	assert.deepEqual(await lnAddress('Ana@QvPay.me', fake(200, pay)), { ok: true, min: 137, max: 544210, text: 'Pago a ana en QvaPay', qvapay: true })
	assert.equal(asked.pop(), 'https://qvpay.me/.well-known/lnurlp/ana')
	assert.deepEqual(await lnAddress('nadie@qvpay.me', fake(404, { status: 'ERROR', reason: 'not found' })), { ok: false, reason: 'Esa dirección no existe' })
	assert.equal((await lnAddress('ana@ejemplo.com', fake(200, { tag: 'withdrawRequest' }))).ok, false)
	assert.equal((await lnAddress('ana@ejemplo.com', fake(200, { ...pay, callback: 'http://inseguro.com/cb' }))).ok, false)
	assert.equal((await lnAddress('ana@ejemplo.com', fake(200, 'x'.repeat(20_000)))).ok, false)
	// Lo que no es una dirección no sale del servidor
	asked.length = 0
	for (const bad of ['ana@localhost', 'ana@10.0.0.1', 'ana@a.b/c', 'https://x.com']) assert.equal((await lnAddress(bad, fake(200, pay))).ok, false)
	assert.equal(asked.length, 0)
	const down = (async () => {
		throw new Error('timeout')
	}) as typeof fetch
	assert.deepEqual(await lnAddress('ana@caido.com', down), { ok: false, reason: 'caido.com no responde' })
})

test('nostr: las órdenes de Mostro traen lo que hace falta para tomarlas, y el libro, sus nodos', () => {
	const S = 1_794_400_000
	const node = 'a'.repeat(64)
	const order: BookEvent = {
		pubkey: node,
		created_at: S - 60,
		kind: 38383,
		tags: [['d', ORDER], ['k', 'sell'], ['f', 'CUP'], ['s', 'pending'], ['amt', '0'], ['fa', '5000', '15000'], ['premium', '18'], ['y', 'mostro', 'Kmbalache'], ['source', `mostro:${ORDER}?relays=wss://relay.mostro.network,wss://nos.lol/,ws://inseguro.com,wss://a.b/ruta&mostro=${node}`]],
	}
	const o = parseOrder(order, { CUP: 900_000_00 }, S * 1000)!
	assert.deepEqual(o.take, { id: ORDER, node, relays: ['wss://relay.mostro.network', 'wss://nos.lol'] })
	// De otra plataforma o con un id que no es de Mostro: no se toma desde aquí
	assert.equal(parseOrder({ ...order, tags: order.tags.map((t) => (t[0] === 'y' ? ['y', 'robosats'] : t)) }, {}, S * 1000)!.take, null)
	assert.equal(parseOrder({ ...order, tags: order.tags.map((t) => (t[0] === 'd' ? ['d', 'o1'] : t)) }, {}, S * 1000)!.take, null)
	assert.deepEqual(relaysOf('mostro:x?relays=wss%3A%2F%2Frelay.mostro.network'), ['wss://relay.mostro.network'])
	assert.deepEqual(relaysOf('https://hodlhodl.com/offers/1'), [])

	const info = (at: number, tags: string[][]): BookEvent => ({ pubkey: node, created_at: at, kind: 38385, tags })
	const old = info(S - 600, [['protocol_version', '1']])
	const now = info(S - 60, [['mostro_version', '0.20.0'], ['protocol_version', '2'], ['pow', '0'], ['pow_first_contact', '0'], ['fee', '0.005'], ['min_order_amount', '100'], ['max_order_amount', '1000000'], ['bond_enabled', 'false'], ['expiration_seconds', '900']])
	const book = bookOf([order, now, old, info(S, [['protocol_version', '2']]).pubkey === node ? { ...info(S, []), pubkey: 'b'.repeat(64) } : old], { CUP: 90_000_000 }, [], S * 1000)
	assert.deepEqual(Object.keys(book.nodes), [node])
	assert.deepEqual(book.nodes[node], { version: '0.20.0', protocol: 2, pow: 0, powFirst: 0, fee: 0.005, minSats: 100, maxSats: 1_000_000, bonds: false, stepS: 900, at: (S - 60) * 1000 })
	// Sin la etiqueta es un nodo viejo: protocolo 1
	assert.equal(parseNode(info(S, []))!.protocol, 1)
})
