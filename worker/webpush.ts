// Web Push sin librerías ni Firebase: el mensaje va cifrado para el navegador (RFC 8291, aes128gcm) y la petición
// firmada con nuestra clave VAPID (RFC 8292). El servicio de push de cada navegador (Google, Mozilla, Apple) solo ve
// texto cifrado. Solo WebCrypto: se prueba en Node con el ejemplo del RFC (test/webpush.test.ts)

export interface PushSub {
	endpoint: string
	// Clave pública del navegador (P-256 sin comprimir, 65 bytes) y su secreto de 16 bytes, en base64url
	p256dh: string
	auth: string
}

export interface Vapid {
	// La clave privada como JWK (EC P-256 con d, x, y): el secreto VAPID_PRIVATE_JWK
	jwk: JsonWebKey
	// Quién manda (lo piden los servicios de push para avisar si algo va mal)
	subject: string
}

const enc = new TextEncoder()
type Bytes = Uint8Array
// Para WebCrypto (los tipos de Workers y de Node no se ponen de acuerdo con Uint8Array)
const B = (b: Bytes) => b as unknown as BufferSource

export const b64u = (bytes: Bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
export function unb64u(s: string) {
	const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4))
	return Uint8Array.from(bin, (c) => c.charCodeAt(0))
}

const concat = (...parts: Bytes[]) => {
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
	let i = 0
	for (const p of parts) out.set(p, i), (i += p.length)
	return out
}

// La clave pública VAPID que se le da al navegador al suscribirse (0x04 ‖ x ‖ y)
export const vapidPublic = (jwk: JsonWebKey) => b64u(concat(new Uint8Array([4]), unb64u(jwk.x!), unb64u(jwk.y!)))

// Una clave P-256 a partir de su punto público sin comprimir
const pubJwk = (raw: Bytes): JsonWebKey => ({ kty: 'EC', crv: 'P-256', x: b64u(raw.slice(1, 33)), y: b64u(raw.slice(33, 65)), ext: true })

async function hkdf(salt: Bytes, ikm: Bytes, info: Bytes, bytes: number) {
	const key = await crypto.subtle.importKey('raw', B(ikm), 'HKDF', false, ['deriveBits'])
	return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: B(salt), info: B(info) }, key, bytes * 8))
}

// El cuerpo cifrado de un mensaje (un solo registro). asKeys y salt se pasan solo en las pruebas (el ejemplo del RFC)
export async function encryptPush(payload: Bytes, sub: PushSub, opts: { asKeys?: CryptoKeyPair; salt?: Bytes } = {}) {
	const uaPublic = unb64u(sub.p256dh)
	const authSecret = unb64u(sub.auth)
	const as = opts.asKeys ?? ((await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair)
	const asPublic = new Uint8Array((await crypto.subtle.exportKey('raw', as.publicKey)) as ArrayBuffer)
	const uaKey = await crypto.subtle.importKey('jwk', pubJwk(uaPublic), { name: 'ECDH', namedCurve: 'P-256' }, false, [])
	const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey } as never, as.privateKey, 256))
	const ikm = await hkdf(authSecret, shared, concat(enc.encode('WebPush: info\0'), uaPublic, asPublic), 32)
	const salt = opts.salt ?? crypto.getRandomValues(new Uint8Array(16))
	const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16)
	const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12)
	const key = await crypto.subtle.importKey('raw', B(cek), 'AES-GCM', false, ['encrypt'])
	// 0x02: el último (y único) registro
	const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: B(nonce) }, key, B(concat(payload, new Uint8Array([2])))))
	const rs = new Uint8Array([0, 0, 16, 0]) // 4096
	return concat(salt, rs, new Uint8Array([asPublic.length]), asPublic, sealed)
}

// La firma VAPID para un servicio de push (su origen): «vapid t=<JWT>, k=<clave pública>»
export async function vapidAuth(endpoint: string, v: Vapid, now = Date.now()) {
	const aud = new URL(endpoint).origin
	const head = b64u(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })))
	const body = b64u(enc.encode(JSON.stringify({ aud, exp: Math.floor(now / 1000) + 12 * 3600, sub: v.subject })))
	const key = await crypto.subtle.importKey('jwk', { ...v.jwk, key_ops: ['sign'] }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'])
	const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, B(enc.encode(`${head}.${body}`))))
	return `vapid t=${head}.${body}.${b64u(sig)}, k=${vapidPublic(v.jwk)}`
}

// gone: el navegador ya no tiene esa suscripción (404/410): hay que borrarla
export interface PushResult {
	ok: boolean
	status: number
	gone: boolean
}

// Manda un mensaje (JSON) a una suscripción. ttlS: cuánto lo guarda el servicio de push si el dispositivo está apagado
export async function sendPush(sub: PushSub, message: unknown, v: Vapid, opts: { ttlS?: number; urgency?: 'normal' | 'high'; topic?: string; fetcher?: typeof fetch } = {}): Promise<PushResult> {
	const body = await encryptPush(enc.encode(JSON.stringify(message)), sub)
	const headers: Record<string, string> = {
		Authorization: await vapidAuth(sub.endpoint, v),
		'Content-Encoding': 'aes128gcm',
		'Content-Type': 'application/octet-stream',
		TTL: String(opts.ttlS ?? 3600),
		Urgency: opts.urgency ?? 'normal',
	}
	// Un mensaje con el mismo topic reemplaza al que aún no se entregó (hasta 32 caracteres base64url)
	if (opts.topic) headers.Topic = opts.topic.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32)
	const res = await (opts.fetcher ?? fetch)(sub.endpoint, { method: 'POST', headers, body: B(body), signal: AbortSignal.timeout(10_000) })
	return { ok: res.ok, status: res.status, gone: res.status === 404 || res.status === 410 }
}

// Un par de claves VAPID nuevo (para el secreto): node -e "import('./worker/webpush.ts').then(m => m.newVapidJwk()).then(j => console.log(JSON.stringify(j)))"
export async function newVapidJwk() {
	const k = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign'])) as CryptoKeyPair
	const { kty, crv, d, x, y } = (await crypto.subtle.exportKey('jwk', k.privateKey)) as JsonWebKey
	return { kty, crv, d, x, y }
}
