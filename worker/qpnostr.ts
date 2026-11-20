// Lo que QvaPay publica del P2P en Nostr (https://www.qvapay.com/docs/p2p/nostr): sus ofertas públicas y cada
// operación completada, firmadas con su clave (kind 35353), cada minuto. Se leen sin cuenta ni token, como cualquiera.
//
// De aquí sale quién es la tesorería de QvaPay: sus ofertas llevan ["maker", "platform"] (precio por debajo del mercado
// para su bolsa de retiros). El libro del terminal las marca por el usuario que las publica (hoy, una sola cuenta).
// Las operaciones ya no se leen: sirvieron para comprobar que el volumen del feed cuadra con lo que firma QvaPay
// (12–20 nov 2026: +0,2 % en operaciones sin USDT BSC, que QvaPay no publica ahí)
//
// Vale solo lo que firma la clave de QvaPay: un relay puede mandar cualquier cosa, y la etiqueta «y» la pone quien quiera

import { getEventHash, verifyEvent } from 'nostr-tools/pure'

// La de qvapay@qvapay.com (https://qvapay.com/.well-known/nostr.json?name=qvapay)
export const QVAPAY_PUBKEY = '3444e923ee5bf41e9ba8607be3608c96bddc5242b32a05bcd73739343851ccb6'
// Dos de los cinco donde publica (QvaPay reintenta en el que falló, así que con uno suele bastar)
export const QP_RELAYS = ['wss://relay.mostro.network', 'wss://relay.primal.net']
const KIND = 35353
const RELAY_TIMEOUT_MS = 8000
// Las ofertas abiertas que se piden a cada relay
const ORDERS_LIMIT = 1000
// Un usuario de tesorería se sigue marcando un tiempo después de su última oferta vista
export const PLATFORM_KEEP_MS = 7 * 86400_000

export const PLATFORM_KEY = 'qpnostr:platform'
// Las ids cuya firma se verificó en la última vuelta (ver qvapayChecker)
export const VERIFIED_KEY = 'qpnostr:verified'

export interface NostrEvent {
	id: string
	pubkey: string
	created_at: number
	kind: number
	tags: string[][]
	content: string
	sig: string
}

export interface KVLike {
	get(key: string): Promise<string | null>
	put(key: string, value: string): Promise<void>
}

// Los usuarios de tesorería y cuándo se vio por última vez una oferta suya
export interface PlatformUsers {
	at: number
	users: Record<string, number>
}

const tag = (e: NostrEvent, k: string) => e.tags.find((t) => Array.isArray(t) && t[0] === k)

type Verify = (e: Parameters<typeof verifyEvent>[0]) => boolean

// Firmado por QvaPay y con su forma. Verificar una firma cuesta ~1,5 ms de CPU y cada vuelta trae ~700 eventos (los dos relays
// mandan los mismos y las ofertas pendientes casi no cambian de una vuelta a otra), así que la firma se verifica una vez por id:
// la id es el resumen (sha256) del contenido, y con el resumen comprobado, una id ya verificada (en esta vuelta o en la anterior,
// «known») no necesita repetirla. «seen» junta las ids buenas de esta vuelta, para la siguiente
export function qvapayChecker(known: ReadonlySet<string> = new Set(), verify: Verify = verifyEvent) {
	const seen = new Set<string>()
	const check = (e: unknown): e is NostrEvent => {
		const x = e as NostrEvent
		if (!x || typeof x !== 'object' || x.pubkey !== QVAPAY_PUBKEY || x.kind !== KIND || !Array.isArray(x.tags) || typeof x.id !== 'string') return false
		try {
			if (getEventHash(x as Parameters<typeof getEventHash>[0]) !== x.id) return false
			if (!seen.has(x.id) && !known.has(x.id) && !verify(x as Parameters<typeof verifyEvent>[0])) return false
		} catch {
			return false
		}
		seen.add(x.id)
		return true
	}
	return { check, seen }
}

export const isQvaPay = (e: unknown): e is NostrEvent => qvapayChecker().check(e)

// Producción ya lee los mismos relays; en staging la vuelta solo gastaría CPU
export const nostrSyncOn = (env: { PRO?: unknown; STAGING?: string }) => Boolean(env.PRO) && env.STAGING !== '1'

// Los usuarios que publican ofertas de tesorería, de la versión más reciente de cada oferta
export function platformNames(events: NostrEvent[]): string[] {
	const last = new Map<string, NostrEvent>()
	for (const e of events) {
		if (tag(e, 'z')?.[1] !== 'order') continue
		const d = tag(e, 'd')?.[1]
		if (!d) continue
		const prev = last.get(d)
		if (!prev || prev.created_at < e.created_at) last.set(d, e)
	}
	const names = new Set<string>()
	for (const e of last.values()) {
		const name = tag(e, 'name')?.[1]
		if (tag(e, 'maker')?.[1] === 'platform' && name) names.add(name.toLowerCase())
	}
	return [...names]
}

// Junta los nuevos con los que ya se tenían y suelta los que llevan PLATFORM_KEEP_MS sin verse
export function mergePlatform(prev: PlatformUsers | null, names: string[], now: number): PlatformUsers {
	const users: Record<string, number> = {}
	for (const [u, t] of Object.entries(prev?.users ?? {})) if (now - t < PLATFORM_KEEP_MS) users[u] = t
	for (const u of names) users[u] = now
	return { at: now, users }
}

// Lo mínimo de un WebSocket que hace falta (así las pruebas pueden pasar uno falso)
export interface SocketLike {
	send(data: string): void
	close(code?: number): void
	addEventListener(type: 'message', fn: (ev: { data: unknown }) => void): void
	addEventListener(type: 'close' | 'error', fn: () => void): void
}
export type Connect = (url: string) => Promise<SocketLike>

// En un Worker, el WebSocket de salida se abre con un fetch con «Upgrade: websocket»
const connectWorker: Connect = async (url) => {
	const res = await fetch(url.replace(/^wss:/, 'https:'), { headers: { Upgrade: 'websocket' }, signal: AbortSignal.timeout(RELAY_TIMEOUT_MS) })
	const ws = (res as Response & { webSocket?: (WebSocket & { accept(): void }) | null }).webSocket
	if (!ws) throw new Error(`HTTP ${res.status}`)
	ws.accept()
	return ws as unknown as SocketLike
}

// Una consulta a un relay hasta su EOSE (o hasta que se corte: lo que llegó, vale)
export async function query(url: string, filter: Record<string, unknown>, connect: Connect, timeoutMs = RELAY_TIMEOUT_MS): Promise<unknown[]> {
	const ws = await connect(url)
	const sub = 'tp'
	return new Promise((resolve) => {
		const events: unknown[] = []
		let done = false
		const finish = () => {
			if (done) return
			done = true
			clearTimeout(timer)
			try {
				ws.send(JSON.stringify(['CLOSE', sub]))
				ws.close(1000)
			} catch {
				// ya estaba cerrado
			}
			resolve(events)
		}
		const timer = setTimeout(finish, timeoutMs)
		ws.addEventListener('message', (ev) => {
			if (typeof ev.data !== 'string') return
			let m: unknown
			try {
				m = JSON.parse(ev.data)
			} catch {
				return
			}
			if (!Array.isArray(m) || m[1] !== sub) return
			if (m[0] === 'EVENT' && m[2] && typeof m[2] === 'object') events.push(m[2])
			else if (m[0] === 'EOSE' || m[0] === 'CLOSED') finish()
		})
		ws.addEventListener('close', finish)
		ws.addEventListener('error', finish)
		try {
			ws.send(JSON.stringify(['REQ', sub, filter]))
		} catch {
			finish()
		}
	})
}

export interface SyncResult {
	platform: string[]
	relays: { url: string; ok: boolean; why?: string }[]
}

// Cada 10 minutos (el cron): las ofertas abiertas de QvaPay, para saber quién es su tesorería
export async function syncQvaPayNostr(kv: KVLike, now: number, connect: Connect = connectWorker, verify: Verify = verifyEvent): Promise<SyncResult> {
	let known: string[] = []
	try {
		known = JSON.parse((await kv.get(VERIFIED_KEY)) ?? '[]')
	} catch {
		// sin la lista, se verifica todo
	}
	const { check, seen } = qvapayChecker(new Set(Array.isArray(known) ? known : []), verify)
	const relays: SyncResult['relays'] = []
	const orders: NostrEvent[] = []
	await Promise.all(
		QP_RELAYS.map(async (url) => {
			try {
				const o = await query(url, { kinds: [KIND], authors: [QVAPAY_PUBKEY], '#z': ['order'], '#s': ['pending'], limit: ORDERS_LIMIT }, connect)
				orders.push(...o.filter(check))
				relays.push({ url, ok: true })
			} catch (err) {
				relays.push({ url, ok: false, why: String((err as Error)?.message ?? err).slice(0, 60) })
			}
		}),
	)
	const names = platformNames(orders)
	// Sin respuesta de ningún relay, los de antes se quedan como estaban
	if (relays.some((r) => r.ok)) {
		await kv.put(VERIFIED_KEY, JSON.stringify([...seen]))
		const prev = await readPlatform(kv)
		await kv.put(PLATFORM_KEY, JSON.stringify(mergePlatform(prev, names, now)))
	}
	return { platform: names, relays }
}

export async function readPlatform(kv: KVLike | undefined): Promise<PlatformUsers | null> {
	try {
		const raw = await kv?.get(PLATFORM_KEY)
		const p = raw ? (JSON.parse(raw) as PlatformUsers) : null
		return p && typeof p.users === 'object' ? p : null
	} catch {
		return null
	}
}
