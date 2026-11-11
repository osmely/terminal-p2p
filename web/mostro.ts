// Cliente de Mostro (P2P de bitcoin sobre Nostr) en el navegador: solo lo que hace falta para COMPRAR bitcoin tomando
// una orden de venta («take-sell»), con el protocolo v2 de Mostro (mensajes NIP-44 de kind 14).
// Especificación: https://mostro.network/protocol/ (overview, key_management, take_sell, chat).
//
// Las claves salen de 12 palabras (BIP-39) por la ruta de Mostro m/44'/1237'/38383'/0/n: la 0 es la identidad (lleva la
// reputación) y cada operación usa la siguiente (1, 2, …). Son las mismas que usa la app de Mostro: con esas palabras
// se recupera la cuenta allí. Nada de esto sale del navegador salvo los mensajes cifrados que van a los relays.
//
// Este archivo no toca el DOM ni la red: lo usan la página (mostro-page.ts) y las pruebas.

import { finalizeEvent, verifyEvent, getPublicKey } from 'nostr-tools/pure'
import { encrypt as nip44Encrypt, decrypt as nip44Decrypt, getConversationKey } from 'nostr-tools/nip44'
import { minePow } from 'nostr-tools/nip13'
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { hkdf } from '@noble/hashes/hkdf.js'
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js'
import { generateMnemonic, mnemonicToSeedSync, validateMnemonic } from '@scure/bip39'
import { wordlist } from '@scure/bip39/wordlists/english.js'
import { HDKey } from '@scure/bip32'
import { LN_ADDRESS, QVAPAY_LN_DOMAIN } from '../src/nostr-relays.ts'

export const PROTOCOL = 2
// Los mensajes a Mostro caducan en los relays a los 30 días, como los suyos (dm_days)
const MSG_TTL_S = 30 * 86400
// La prueba de trabajo más alta que se está dispuesto a minar en el navegador (bits). Kmbalache pide 0
export const MAX_POW = 16

export interface NostrEvent {
	id: string
	pubkey: string
	created_at: number
	kind: number
	tags: string[][]
	content: string
	sig: string
}

const HEX64 = /^[0-9a-f]{64}$/
export const isHex64 = (s: unknown): s is string => typeof s === 'string' && HEX64.test(s)
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

// ---------------------------------------------------------------- claves

export const newWords = () => generateMnemonic(wordlist, 128)
export const wordsOk = (words: string) => validateMnemonic(normWords(words), wordlist)
export const normWords = (words: string) => words.trim().toLowerCase().split(/\s+/).join(' ')

export interface Keyring {
	// Clave privada del índice n (0 = identidad)
	at(n: number): Uint8Array
}
export function keyring(words: string): Keyring {
	const root = HDKey.fromMasterSeed(mnemonicToSeedSync(normWords(words)))
	const cache = new Map<number, Uint8Array>()
	return {
		at(n) {
			if (!Number.isInteger(n) || n < 0) throw new Error('índice de clave inválido')
			let k = cache.get(n)
			if (!k) {
				const key = root.derive(`m/44'/1237'/38383'/0/${n}`).privateKey
				if (!key) throw new Error('no se pudo derivar la clave')
				k = key
				cache.set(n, k)
			}
			return k
		},
	}
}
export const pubOf = (sk: Uint8Array) => getPublicKey(sk)

// ---------------------------------------------------------------- mensajes a Mostro

// El mensaje lógico. Mostro lo vuelve a serializar al recibirlo y comprueba las firmas sobre ESE texto, así que hay que
// escribirlo exactamente como lo escribe él (serde, MessageKind de mostro-core): version, request_id, trade_index
// (estos dos como null si faltan), id (solo si hay), action y payload (null si no hay)
export interface Outgoing {
	wrapper: 'order' | 'restore' | 'dispute'
	action: string
	id?: string
	requestId?: number | null
	tradeIndex?: number | null
	payload?: Payload | null
}
// Las cargas que manda este cliente (serde «snake_case», variante externa)
export type Payload = { payment_request: [null, string, number | null] } | { amount: number } | { rating_user: number }

export function messageJson(m: Outgoing): string {
	if (m.id !== undefined && !UUID.test(m.id)) throw new Error('id de orden inválido')
	const body: Record<string, unknown> = { version: PROTOCOL, request_id: m.requestId ?? null, trade_index: m.tradeIndex ?? null }
	if (m.id !== undefined) body.id = m.id
	body.action = m.action
	body.payload = m.payload ?? null
	return JSON.stringify({ [m.wrapper]: body })
}

// Firma Schnorr del sha256 del texto, como Message::sign de mostro-core
export const signText = (text: string, sk: Uint8Array) => bytesToHex(schnorr.sign(sha256(utf8ToBytes(text)), sk))
export const verifyText = (text: string, sigHex: string, pubHex: string) => {
	try {
		return schnorr.verify(hexToBytes(sigHex), sha256(utf8ToBytes(text)), hexToBytes(pubHex))
	} catch {
		return false
	}
}
// La identidad firma un texto con la clave de la operación dentro: la prueba no sirve pegada a otro evento
export const identityPayload = (tradePub: string, json: string) => `mostro-transport-v2-identity:${tradePub}:${json}`

// El contenido cifrado: [mensaje, firma de la clave de la operación, [identidad, firma de la identidad]]. Con la misma
// clave para las dos (o sin identidad) va el modo privado: [mensaje, null, null]
export function contentFor(m: Outgoing, tradeSk: Uint8Array, identitySk: Uint8Array | null): string {
	const json = messageJson(m)
	const tradePub = getPublicKey(tradeSk)
	if (!identitySk || getPublicKey(identitySk) === tradePub) return `[${json},null,null]`
	const tradeSig = signText(json, tradeSk)
	const proof = [getPublicKey(identitySk), signText(identityPayload(tradePub, json), identitySk)]
	return `[${json},${JSON.stringify(tradeSig)},${JSON.stringify(proof)}]`
}

// El evento kind 14 que va al nodo: lo firma la clave de la operación, cifrado con NIP-44 entre ella y el nodo.
// nowS: la hora corregida (Mostro descarta lo que llega con más de 10 s)
export function wrapToMostro(m: Outgoing, tradeSk: Uint8Array, identitySk: Uint8Array | null, node: string, nowS: number, pow = 0): NostrEvent {
	if (!isHex64(node)) throw new Error('nodo inválido')
	if (pow > MAX_POW) throw new Error(`el nodo pide una prueba de trabajo de ${pow} bits`)
	const content = nip44Encrypt(contentFor(m, tradeSk, identitySk), getConversationKey(tradeSk, node))
	let ev: { kind: number; created_at: number; tags: string[][]; content: string; pubkey: string } = {
		kind: 14,
		created_at: nowS,
		tags: [
			['p', node],
			['expiration', String(nowS + MSG_TTL_S)],
		],
		content,
		pubkey: getPublicKey(tradeSk),
	}
	if (pow > 0) ev = minePow(ev, pow)
	return finalizeEvent(ev, tradeSk) as NostrEvent
}

// Lo que manda Mostro, ya descifrado: el envoltorio (order, cant-do, restore, rate…) y su cuerpo
export interface Incoming {
	wrapper: string
	action: string
	id: string | null
	requestId: number | null
	tradeIndex: number | null
	payload: unknown
	at: number
}
export function openFromMostro(ev: NostrEvent, tradeSk: Uint8Array, node: string): Incoming | null {
	if (!ev || ev.kind !== 14 || ev.pubkey !== node) return null
	if (!ev.tags?.some((t) => t[0] === 'p' && t[1] === getPublicKey(tradeSk))) return null
	if (typeof ev.content !== 'string' || ev.content.length > 64 * 1024) return null
	if (!verifyEvent(ev)) return null
	let arr: unknown
	try {
		arr = JSON.parse(nip44Decrypt(ev.content, getConversationKey(tradeSk, node)))
	} catch {
		return null
	}
	const first = Array.isArray(arr) ? arr[0] : null
	if (!first || typeof first !== 'object') return null
	const wrapper = Object.keys(first)[0]
	const body = (first as Record<string, Record<string, unknown>>)[wrapper]
	if (!body || typeof body !== 'object' || typeof body.action !== 'string') return null
	return {
		wrapper,
		action: body.action,
		id: typeof body.id === 'string' ? body.id : null,
		requestId: typeof body.request_id === 'number' ? body.request_id : null,
		tradeIndex: typeof body.trade_index === 'number' ? body.trade_index : null,
		payload: body.payload ?? null,
		at: ev.created_at,
	}
}

// ---------------------------------------------------------------- chat con la otra parte (chat.md)

const CONV_INFO = 'mostro:chat:conv:v1'
const SIGN_INFO = 'mostro:chat:sign:v1'
// Desfase de reloj admitido y tamaño máximo de un mensaje
export const CHAT_SKEW_S = 60
const CHAT_MAX_BYTES = 64 * 1024

export interface ChatKeys {
	conv: Uint8Array
	convPub: string
	sign: Uint8Array
	signPub: string
}
// El secreto ECDH de las dos claves de la operación (la x del punto compartido) y dos claves derivadas con HKDF:
// una para cifrar (su pública es la dirección, la «p») y otra para firmar el sobre (su pública es el autor)
export function chatKeys(ownSk: Uint8Array, peerPub: string): ChatKeys {
	if (!isHex64(peerPub)) throw new Error('clave de la otra parte inválida')
	const shared = secp256k1.getSharedSecret(ownSk, hexToBytes(`02${peerPub}`)).slice(1, 33)
	const derive = (info: string) => {
		for (let c = 0; c < 256; c++) {
			const label = c === 0 ? utf8ToBytes(info) : new Uint8Array([...utf8ToBytes(info), c])
			const out = hkdf(sha256, shared, undefined, label, 32)
			if (secp256k1.utils.isValidSecretKey(out)) return out
		}
		throw new Error('no se pudo derivar la clave del chat')
	}
	const conv = derive(CONV_INFO)
	const sign = derive(SIGN_INFO)
	return { conv, convPub: getPublicKey(conv), sign, signPub: getPublicKey(sign) }
}

export function wrapChat(text: string, ownSk: Uint8Array, keys: ChatKeys, nowS: number): { outer: NostrEvent; inner: NostrEvent } {
	const inner = finalizeEvent({ kind: 1, created_at: nowS, tags: [], content: text }, ownSk) as NostrEvent
	const content = nip44Encrypt(JSON.stringify(inner), getConversationKey(keys.conv, keys.convPub))
	const outer = finalizeEvent({ kind: 14, created_at: nowS, tags: [['p', keys.convPub]], content }, keys.sign) as NostrEvent
	return { outer, inner }
}

// Valida y abre un mensaje del chat en el orden de la especificación (lo barato primero). allowed: las claves de la
// operación del comprador y del vendedor; las únicas que pueden firmar el mensaje de dentro
export function openChat(ev: NostrEvent, keys: ChatKeys, allowed: string[], nowS: number): NostrEvent | null {
	if (!ev || ev.kind !== 14 || ev.pubkey !== keys.signPub) return null
	const ps = (ev.tags ?? []).filter((t) => t[0] === 'p')
	if (ps.length !== 1 || ps[0][1] !== keys.convPub) return null
	if (typeof ev.created_at !== 'number' || ev.created_at > nowS + CHAT_SKEW_S) return null
	if (typeof ev.content !== 'string' || ev.content.length > CHAT_MAX_BYTES) return null
	if (!verifyEvent(ev)) return null
	let inner: NostrEvent
	try {
		inner = JSON.parse(nip44Decrypt(ev.content, getConversationKey(keys.conv, keys.convPub)))
	} catch {
		return null
	}
	if (!inner || typeof inner !== 'object' || !verifyEvent(inner)) return null
	if (!allowed.includes(inner.pubkey)) return null
	// Solo texto (las reacciones, kind 7, no se muestran)
	if (inner.kind !== 1 || typeof inner.content !== 'string') return null
	if (Math.abs(inner.created_at - ev.created_at) > CHAT_SKEW_S) return null
	return inner
}

// ---------------------------------------------------------------- lo que dice Mostro, para la persona

// Estado de la compra según el último aviso de Mostro (lado comprador)
export type Step = 'taking' | 'invoice' | 'waiting-seller' | 'active' | 'fiat-sent' | 'released' | 'done' | 'canceling' | 'canceled' | 'dispute' | 'failed'
export const STEP_OF: Record<string, Step> = {
	'add-invoice': 'invoice',
	'waiting-seller-to-pay': 'waiting-seller',
	'hold-invoice-payment-accepted': 'active',
	'buyer-invoice-accepted': 'waiting-seller',
	'fiat-sent-ok': 'fiat-sent',
	released: 'released',
	'hold-invoice-payment-settled': 'released',
	'purchase-completed': 'done',
	'admin-settled': 'done',
	canceled: 'canceled',
	'admin-canceled': 'canceled',
	'hold-invoice-payment-canceled': 'canceled',
	'cooperative-cancel-accepted': 'canceled',
	'cooperative-cancel-initiated-by-you': 'canceling',
	'dispute-initiated-by-you': 'dispute',
	'dispute-initiated-by-peer': 'dispute',
	'admin-took-dispute': 'dispute',
}
// Lo que sigue después de cerrar: no se vuelve atrás por un aviso viejo que llegue tarde
export const FINAL: Step[] = ['done', 'canceled', 'failed']

// Las razones de «cant-do» que se pueden dar a alguien que compra (el resto sale con su nombre técnico)
export const CANT_DO: Record<string, string> = {
	invalid_trade_index: 'el número de operación no vale',
	pending_order_exists: 'ya tienes una operación abierta con esta orden',
	invalid_order_status: 'la orden ya no está disponible',
	not_allowed_by_status: 'no se puede hacer en este paso',
	out_of_range_sats_amount: 'en sats queda fuera de lo mínimo o máximo que acepta el nodo',
	out_of_range_fiat_amount: 'el monto está fuera del rango de la orden',
	invalid_amount: 'el monto no vale',
	invalid_invoice: 'la dirección Lightning o la factura no vale',
	invalid_signature: 'firma inválida',
	invalid_peer: 'esa operación no es tuya',
	is_not_your_order: 'esa operación no es tuya',
	not_found: 'no encontrado',
	price_too_stale: 'el nodo no tiene un precio reciente: prueba en unos minutos',
	order_already_canceled: 'la orden ya estaba cancelada',
	cant_create_user: 'el nodo no pudo crear tu usuario',
	invalid_pubkey: 'clave inválida',
	too_many_requests: 'demasiadas peticiones: espera un poco',
	invalid_payment_request: 'la dirección Lightning o la factura no vale',
	maintenance_mode: 'el nodo está en mantenimiento y no acepta operaciones nuevas',
	payer_not_declared: 'este nodo pide declarar la cuenta desde la que pagas: sigue la operación en la app de Mostro con tus 12 palabras',
	invalid_fiat_currency: 'el nodo no acepta esa moneda',
	invalid_parameters: 'algún dato del mensaje no vale',
	invalid_payload: 'el mensaje llegó incompleto o mal formado',
	invalid_action: 'este nodo no admite esa acción',
	reputation_identity_required: 'hace falta tu identidad de Mostro para esto',
	is_not_your_dispute: 'esa disputa no es tuya',
	unknown: 'el nodo lo rechazó por un motivo que esta página aún no conoce',
}
export function cantDoReason(payload: unknown): string {
	const r = payload && typeof payload === 'object' ? (payload as { cant_do?: unknown }).cant_do : null
	return typeof r === 'string' && /^[a-z_]{1,60}$/.test(r) ? r : 'unknown'
}
export const cantDoText = (why: string) => CANT_DO[why] ?? CANT_DO.unknown

// Cuánto después de bloquear los sats actúa el nodo si el comprador no marcó «Ya pagué» (cancela) o sí lo marcó y el
// vendedor no liberó (abre él la disputa): los bloques de la factura retenida menos su margen, a unos 10 min por bloque.
// Con lo que publica casi todo nodo (144 y 24) son 20 h
export function deadlineS(cltv: number | null | undefined, margin: number | null | undefined) {
	const c = cltv && cltv > 0 ? cltv : 144
	const m = margin !== null && margin !== undefined && margin >= 0 && margin < c ? margin : 24
	return (c - m) * 600
}

// El informe de salud de un nodo (kind 38389), como pide la especificación: firma buena, de ese nodo, z = health,
// d = su clave, intervalo de 30 a 3600 s, caducidad = creado + 3 × intervalo, no del futuro (5 min de margen) y no
// caducado. Si falta o no cumple, «unknown», nunca «ok»
export interface Health {
	status: 'ok' | 'degraded' | 'down' | 'unknown'
	payouts: string | null
	maintenance: boolean
}
export function nodeHealth(ev: unknown, node: string, nowS: number): Health {
	const unknown: Health = { status: 'unknown', payouts: null, maintenance: false }
	if (!ev || typeof ev !== 'object') return unknown
	const e = ev as NostrEvent
	if (e.kind !== 38389 || e.pubkey !== node || !Array.isArray(e.tags)) return unknown
	const all = (n: string) => e.tags.filter((t) => Array.isArray(t) && t[0] === n)
	const one = (n: string) => {
		const ts = all(n)
		return ts.length === 1 && typeof ts[0][1] === 'string' ? ts[0][1] : null
	}
	// Una etiqueta repetida (o un chequeo repetido) invalida el informe
	const checks = all('check')
	if (new Set(checks.map((c) => c[1])).size !== checks.length) return unknown
	for (const n of ['d', 'y', 'z', 'status', 'maintenance_mode', 'interval', 'seq', 'expiration']) if (one(n) === null) return unknown
	const interval = Number(one('interval'))
	if (one('z') !== 'health' || one('d') !== node || !Number.isInteger(interval) || interval < 30 || interval > 3600) return unknown
	if (Number(one('expiration')) !== e.created_at + 3 * interval) return unknown
	if (e.created_at > nowS + 300 || nowS >= e.created_at + 3 * interval) return unknown
	const status = one('status')
	if (status !== 'ok' && status !== 'degraded' && status !== 'down') return unknown
	if (!verifyEvent(e as Parameters<typeof verifyEvent>[0])) return unknown
	const pay = checks.find((c) => c[1] === 'payouts')
	return { status, payouts: typeof pay?.[2] === 'string' ? pay[2] : null, maintenance: one('maintenance_mode') === 'true' }
}

// La moneda de la orden en Mostro va en entero (i64): CUP, USD… sin decimales
export const fiatAmountOk = (n: number, min: number, max: number) => Number.isInteger(n) && n >= Math.ceil(min) && n <= Math.floor(max)
// Una dirección Lightning (usuario@dominio): Mostro la resuelve él al pagar
export const lnAddressOk = (s: string) => LN_ADDRESS.test(s.trim()) && s.trim().length <= 120
// Solo el usuario (sin @): es el de QvaPay, que da a cada cuenta usuario@qvpay.me
export const lnAddressOf = (s: string) => {
	const v = s.trim().replace(/^@/, '').toLowerCase()
	return /^[a-z0-9._-]{2,40}$/.test(v) ? `${v}@${QVAPAY_LN_DOMAIN}` : v
}
// O una factura BOLT-11 de la red principal (cuando Mostro pide otra porque falló el pago)
export const invoiceOk = (s: string) => /^lnbc[0-9a-z]{20,2000}$/i.test(s.trim())
