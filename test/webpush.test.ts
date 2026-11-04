import assert from 'node:assert/strict'
import { test } from 'node:test'
import { b64u, encryptPush, newVapidJwk, sendPush, unb64u, vapidAuth, vapidPublic, type PushSub } from '../worker/webpush.ts'

const enc = new TextEncoder()
const jwkOf = (d: string, pub: string): JsonWebKey => {
	const p = unb64u(pub)
	return { kty: 'EC', crv: 'P-256', d, x: b64u(p.slice(1, 33)), y: b64u(p.slice(33, 65)) }
}

// RFC 8291, apéndice A: las mismas claves y sal dan exactamente el mismo cuerpo cifrado
test('webpush: cifra igual que el ejemplo del RFC 8291', async () => {
	const asPub = 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8'
	const as = jwkOf('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw', asPub)
	const asKeys = {
		privateKey: await crypto.subtle.importKey('jwk', as, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']),
		publicKey: await crypto.subtle.importKey('raw', unb64u(asPub), { name: 'ECDH', namedCurve: 'P-256' }, true, []),
	}
	const sub: PushSub = {
		endpoint: 'https://push.example.net/push/JzLQ3raZJfFBR0aqvOMsLrt54w4rJUsV',
		p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
		auth: 'BTBZMqHH6r4Tts7J_aSIgg',
	}
	const body = await encryptPush(enc.encode('When I grow up, I want to be a watermelon'), sub, { asKeys, salt: unb64u('DGv6ra1nlYgDCS1FRnbzlw') })
	assert.equal(
		b64u(body),
		'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
	)
})

// Lo que haría el navegador: con su clave privada y el secreto, descifra el mensaje
type Bytes = Uint8Array<ArrayBuffer>
async function decrypt(body: Bytes, uaKeys: CryptoKeyPair, uaPublic: Bytes, auth: Bytes) {
	const salt = body.slice(0, 16)
	const idlen = body[20]
	const asPublic = body.slice(21, 21 + idlen)
	const sealed = body.slice(21 + idlen)
	const asKey = await crypto.subtle.importKey('raw', asPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, [])
	const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: asKey }, uaKeys.privateKey, 256))
	const hk = async (s: Bytes, ikm: Bytes, info: Bytes, n: number) =>
		new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: s, info }, await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']), n * 8))
	const info = new Uint8Array([...enc.encode('WebPush: info\0'), ...uaPublic, ...asPublic])
	const ikm = await hk(auth, shared, info, 32)
	const cek = await hk(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16)
	const nonce = await hk(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12)
	const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']), sealed))
	assert.equal(plain.at(-1), 2)
	return new TextDecoder().decode(plain.slice(0, -1))
}

test('webpush: sendPush manda el mensaje cifrado, firmado con VAPID, y dice si la suscripción ya no existe', async () => {
	const ua = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair
	const uaPublic = new Uint8Array(await crypto.subtle.exportKey('raw', ua.publicKey))
	const auth = crypto.getRandomValues(new Uint8Array(16))
	const sub: PushSub = { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', p256dh: b64u(uaPublic), auth: b64u(auth) }
	const jwk = await newVapidJwk()
	const v = { jwk, subject: 'https://terminalp2p.com' }
	let got: { url: string; headers: Record<string, string>; body: Bytes } | null = null
	const fetcher = (async (url: string, init: RequestInit) => {
		got = { url, headers: init.headers as Record<string, string>, body: init.body as Bytes }
		return new Response(null, { status: 201 })
	}) as unknown as typeof fetch
	const r = await sendPush(sub, { title: 'Te pagaron', body: 'Comprueba y libera' }, v, { urgency: 'high', topic: 'o1:paid', fetcher })
	assert.deepEqual(r, { ok: true, status: 201, gone: false })
	assert.equal(got!.url, sub.endpoint)
	assert.equal(got!.headers['Content-Encoding'], 'aes128gcm')
	assert.equal(got!.headers.Urgency, 'high')
	assert.equal(got!.headers.Topic, 'o1paid')
	assert.deepEqual(JSON.parse(await decrypt(got!.body, ua, uaPublic, auth)), { title: 'Te pagaron', body: 'Comprueba y libera' })

	// La firma: un JWT ES256 para el origen del servicio de push, verificable con la clave pública que damos al navegador
	const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(got!.headers.Authorization)!
	assert.equal(m[4], vapidPublic(jwk))
	const claims = JSON.parse(new TextDecoder().decode(unb64u(m[2])))
	assert.equal(claims.aud, 'https://fcm.googleapis.com')
	assert.equal(claims.sub, 'https://terminalp2p.com')
	const pub = await crypto.subtle.importKey('raw', unb64u(m[4]), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'])
	assert.ok(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, unb64u(m[3]), enc.encode(`${m[1]}.${m[2]}`)))

	const gone = await sendPush(sub, {}, v, { fetcher: (async () => new Response(null, { status: 410 })) as unknown as typeof fetch })
	assert.deepEqual(gone, { ok: false, status: 410, gone: true })
	assert.match(await vapidAuth('https://web.push.apple.com/x', v), /^vapid t=/)
})
