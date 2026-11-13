// Lo que QvaPay publica del P2P en Nostr (https://www.qvapay.com/docs/p2p/nostr): sus ofertas públicas y cada
// operación completada, firmadas con su clave (kind 35353), cada minuto. Se leen sin cuenta ni token, como cualquiera.
//
// De aquí sale:
//  - quién es la tesorería de QvaPay: sus ofertas llevan ["maker", "platform"] (precio por debajo del mercado para su
//    bolsa de retiros). El libro del terminal las marca por el usuario que las publica (hoy, una sola cuenta)
//  - las operaciones completadas (tabla qp_nostr_trades), para comparar con el volumen que suma el feed (tabla volume)
//
// Vale solo lo que firma la clave de QvaPay: un relay puede mandar cualquier cosa, y la etiqueta «y» la pone quien quiera

import { verifyEvent } from 'nostr-tools/pure'
import type { D1 } from './rates.ts'

// La de qvapay@qvapay.com (https://qvapay.com/.well-known/nostr.json?name=qvapay)
export const QVAPAY_PUBKEY = '3444e923ee5bf41e9ba8607be3608c96bddc5242b32a05bcd73739343851ccb6'
// Dos de los cinco donde publica (QvaPay reintenta en el que falló, así que con uno suele bastar)
export const QP_RELAYS = ['wss://relay.mostro.network', 'wss://relay.primal.net']
const KIND = 35353
const RELAY_TIMEOUT_MS = 8000
// Lo más que da un relay por consulta: con menos, ya no hay más
const PAGE = 500
const MAX_PAGES = 10
// La primera vez, las operaciones de los últimos días (QvaPay empezó a publicarlas el 2026-11-12)
const FIRST_WINDOW_S = 3 * 86400
// Cada lectura vuelve un poco atrás, por si un evento llegó tarde al relay
const OVERLAP_S = 15 * 60
// Un usuario de tesorería se sigue marcando un tiempo después de su última oferta vista
export const PLATFORM_KEEP_MS = 7 * 86400_000

export const SINCE_KEY = 'qpnostr:since'
export const PLATFORM_KEY = 'qpnostr:platform'

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

// El mercado del terminal de cada moneda y método de pago de QvaPay. Lo que no está (EUR banco, RUB, Cash App…) queda
// sin mercado, pero se guarda igual
const COIN_OF: Record<string, string> = {
	'CUP bank transfer': 'BANK_CUP',
	'CUP etecsa mobile balance': 'ETECSA',
	'CUP cash': 'CUPCASH',
	'CUP bolsa tm': 'BOLSATM',
	'USD clasica card': 'CLASICA',
	'USD zelle': 'ZELLE',
	'USD tropical card': 'BANDECPREPAGO',
	'USD cash': 'USDCASH',
	'USD paypal': 'PAYPAL',
	'MLC bank transfer': 'BANK_MLC',
	'EUR tropipay': 'TROPIPAY',
	'EUR cash': 'EURCASH',
	'BRL pix': 'PIX',
}
export const coinOf = (f: string, pm: string) => COIN_OF[`${f} ${pm.toLowerCase()}`] ?? null

// Firmado por QvaPay y con su forma
export function isQvaPay(e: unknown): e is NostrEvent {
	const x = e as NostrEvent
	if (!x || typeof x !== 'object' || x.pubkey !== QVAPAY_PUBKEY || x.kind !== KIND || !Array.isArray(x.tags)) return false
	try {
		return verifyEvent(x as Parameters<typeof verifyEvent>[0])
	} catch {
		return false
	}
}

export interface QpTrade {
	id: string
	coin: string | null
	f: string
	pm: string
	side: 'buy' | 'sell'
	at: number
	usd: number
	fiat: number
	plat: boolean
}

export function parseTrade(e: NostrEvent): QpTrade | null {
	if (tag(e, 'z')?.[1] !== 'trade' || tag(e, 'c')?.[1] !== 'qusd') return null
	const id = tag(e, 'd')?.[1]
	const side = tag(e, 'k')?.[1]
	const f = tag(e, 'f')?.[1]
	const pm = tag(e, 'pm')?.[1]
	const usd = Number(tag(e, 'amt')?.[1])
	const fiat = Number(tag(e, 'fa')?.[1])
	const at = Number(tag(e, 'executed_at')?.[1] ?? e.created_at) * 1000
	if (!id || (side !== 'buy' && side !== 'sell') || !f || !pm || !(usd > 0) || !(fiat > 0) || !Number.isFinite(at)) return null
	return { id, coin: coinOf(f, pm), f, pm, side, at, usd, fiat, plat: tag(e, 'maker')?.[1] === 'platform' }
}

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

// Las operaciones desde «since», de página en página hacia atrás (cada relay da como mucho PAGE por consulta)
async function tradesFrom(url: string, since: number, connect: Connect): Promise<NostrEvent[]> {
	const out: NostrEvent[] = []
	let until: number | undefined
	for (let i = 0; i < MAX_PAGES; i++) {
		const got = (await query(url, { kinds: [KIND], authors: [QVAPAY_PUBKEY], '#z': ['trade'], since, ...(until ? { until } : {}), limit: PAGE }, connect)).filter(isQvaPay)
		out.push(...got)
		if (got.length < PAGE) break
		until = Math.min(...got.map((e) => e.created_at)) - 1
	}
	return out
}

export interface SyncResult {
	trades: number
	added: number
	platform: string[]
	relays: { url: string; ok: boolean; why?: string }[]
}

// Cada 10 minutos (el cron): lo nuevo de los relays de QvaPay
export async function syncQvaPayNostr(db: D1, kv: KVLike, now: number, connect: Connect = connectWorker): Promise<SyncResult> {
	const nowS = Math.floor(now / 1000)
	const saved = Number(await kv.get(SINCE_KEY))
	const since = saved > 0 ? saved - OVERLAP_S : nowS - FIRST_WINDOW_S
	const relays: SyncResult['relays'] = []
	const trades = new Map<string, QpTrade>()
	const orders: NostrEvent[] = []
	let newest = saved > 0 ? saved : 0
	await Promise.all(
		QP_RELAYS.map(async (url) => {
			try {
				const [t, o] = await Promise.all([
					tradesFrom(url, since, connect),
					query(url, { kinds: [KIND], authors: [QVAPAY_PUBKEY], '#z': ['order'], '#s': ['pending'], limit: PAGE * 2 }, connect),
				])
				for (const e of t) {
					const p = parseTrade(e)
					if (p) trades.set(p.id, p)
					newest = Math.max(newest, e.created_at)
				}
				orders.push(...o.filter(isQvaPay))
				relays.push({ url, ok: true })
			} catch (err) {
				relays.push({ url, ok: false, why: String((err as Error)?.message ?? err).slice(0, 60) })
			}
		}),
	)
	let added = 0
	const list = [...trades.values()]
	for (let i = 0; i < list.length; i += 50) {
		const res = (await db.batch(
			list
				.slice(i, i + 50)
				.map((t) =>
					db
						.prepare('INSERT OR IGNORE INTO qp_nostr_trades (id, coin, f, pm, side, at, usd, fiat, plat) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
						.bind(t.id, t.coin, t.f, t.pm, t.side, t.at, t.usd, t.fiat, t.plat ? 1 : 0),
				),
		)) as { meta?: { changes?: number } }[] | undefined
		for (const r of res ?? []) added += r?.meta?.changes ?? 0
	}
	if (newest > 0) await kv.put(SINCE_KEY, String(newest))
	const names = platformNames(orders)
	// Sin respuesta de ningún relay, los de antes se quedan como estaban
	if (relays.some((r) => r.ok)) {
		const prev = await readPlatform(kv)
		await kv.put(PLATFORM_KEY, JSON.stringify(mergePlatform(prev, names, now)))
	}
	return { trades: list.length, added, platform: names, relays }
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
