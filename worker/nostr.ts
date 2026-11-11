// Libro P2P de bitcoin en Nostr (experimental, solo en staging): las órdenes públicas que publican Mostro, RoboSats,
// Hodl Hodl, lnp2pBot y otros con el formato común NIP-69 (eventos kind 38383). Se leen de varios relays públicos,
// sin claves y sin cuenta: solo lectura, como el libro que ve cualquiera en esas aplicaciones.
//
// Los lados se nombran desde quien mira, como en el libro del terminal: «ask» son las órdenes que VENDEN bitcoin (ahí
// compras; la mejor es la más barata) y «bid» las que COMPRAN bitcoin (ahí vendes; la mejor es la más cara).
//
// El precio de mercado es el de Yadio, el mismo que usa Mostro para las órdenes «a precio de mercado» (amt 0): el
// precio que sale aquí es el que se pagaría al tomarla (mercado × (1 + prima)).

import { LN_ADDRESS, QVAPAY_LN_DOMAIN } from '../src/nostr-relays.ts'

export const NOSTR_RELAYS = ['wss://relay.mostro.network', 'wss://nos.lol', 'wss://relay.damus.io', 'wss://nostr.mom', 'wss://relay.primal.net']
const KIND = 38383
// Las órdenes caducan en horas o días (Mostro 24 h, Hodl Hodl una semana): más atrás no hay ninguna abierta
const WINDOW_S = 8 * 86400
// Lo más que se lee de un relay, para que uno que mande de todo no se coma la memoria
const MAX_EVENTS = 5400
const RELAY_TIMEOUT_MS = 6000
const PRICE_URL = 'https://api.yadio.io/exrates/BTC'

export interface NostrEvent {
	id?: string
	pubkey: string
	created_at: number
	kind: number
	tags: string[][]
	content?: string
	sig?: string
}

export interface NostrOrder {
	side: 'ask' | 'bid'
	fiat: string
	// Lo que se puede operar, en la moneda (si es un monto fijo, min = max)
	min: number
	max: number
	// Satoshis fijos de la orden; null = a precio de mercado
	sats: number | null
	// % sobre el precio de mercado (el que pone la orden, o el que resulta de su monto fijo)
	premium: number | null
	// Moneda por bitcoin; null si no hay precio de mercado para esa moneda
	price: number | null
	pays: string[]
	// Quién la publica: mostro, robosats, hodlhodl, telegram… («otra» si no lo dice)
	platform: string
	// El nodo o bot dentro de la plataforma (en Mostro, «Kmbalache 🇨🇺», «Mostro Brasil»…)
	node: string | null
	name: string | null
	score: number | null
	reviews: number | null
	days: number | null
	layer: string | null
	// Solo enlaces https (los de Mostro son «mostro:…» y los de RoboSats van por Tor)
	link: string | null
	// Milisegundos
	at: number
	exp: number | null
	// Solo en las de Mostro: lo que hace falta para tomarla desde el navegador (el id, la clave del nodo y sus relays)
	take: { id: string; node: string; relays: string[] } | null
}

// Lo que anuncia cada nodo de Mostro de sí mismo (kind 38385): el navegador solo ofrece comprar en los que hablan el
// protocolo 2 y no piden fianza ni más prueba de trabajo de la que puede minar
export interface MostroNode {
	version: string | null
	protocol: number
	pow: number
	powFirst: number | null
	fee: number | null
	minSats: number | null
	maxSats: number | null
	bonds: boolean
	// Segundos que tiene cada parte para dar su paso (pagar la factura retenida, mandar la suya)
	stepS: number | null
	// Bloques de la factura retenida y el margen con que el nodo actúa antes de que caduque (144 − 24 ≈ 20 h)
	cltv: number | null
	marginBlocks: number | null
	maintenance: boolean
	// Su último informe de salud (kind 38389) tal cual, firmado: lo comprueba el navegador (web/mostro.ts nodeHealth)
	health: NostrEvent | null
	at: number
}

export interface RelayState {
	url: string
	ok: boolean
	events: number
	why?: string
}

export interface NostrBook {
	at: number
	// Moneda por bitcoin según Yadio, de las monedas que tienen órdenes
	market: Record<string, number>
	relays: RelayState[]
	orders: NostrOrder[]
	// Los nodos de Mostro con órdenes en el libro, por su clave
	nodes: Record<string, MostroNode>
}

const num = (x: unknown): number | null => {
	const n = typeof x === 'number' ? x : typeof x === 'string' && x.trim() !== '' ? Number(x) : NaN
	return Number.isFinite(n) ? n : null
}
// Lo que escriben otros va recortado y sin caracteres de control; el navegador lo pinta como texto, nunca como HTML
const text = (x: unknown, max = 40) =>
	String(typeof x === 'string' ? x : '')
		.replace(/[\u0000-\u001f\u007f]/g, ' ')
		.trim()
		.slice(0, max)
const tagOf = (e: NostrEvent, name: string) => e.tags.find((t) => Array.isArray(t) && t[0] === name)
const one = (e: NostrEvent, name: string) => {
	const t = tagOf(e, name)
	return typeof t?.[1] === 'string' ? t[1] : null
}

// La valoración viene distinta según quién publica: Mostro manda '["rating",{total_rating,total_reviews,days}]',
// Hodl Hodl '{"rating":…,"trades_count":…}' y el bot de Telegram tres valores sueltos (nota, reseñas, días)
export function ratingOf(tag: string[] | undefined): { score: number | null; reviews: number | null; days: number | null } {
	const none = { score: null, reviews: null, days: null }
	if (!tag || typeof tag[1] !== 'string') return none
	const raw = tag[1].trim()
	if (raw.startsWith('[') || raw.startsWith('{')) {
		let v: unknown
		try {
			v = JSON.parse(raw)
		} catch {
			return none
		}
		const o = (Array.isArray(v) ? v[1] : v) as Record<string, unknown> | undefined
		if (!o || typeof o !== 'object') return none
		// Hodl Hodl da la nota de 0 a 1 (la parte de valoraciones buenas): se pasa a estrellas, de 0 a 5
		const given = num(o.total_rating ?? o.rating)
		const score = given !== null && o.total_rating === undefined && given <= 1 ? given * 5 : given
		const reviews = num(o.total_reviews ?? o.trades_count)
		return { score: score !== null && score >= 0 && score <= 5 ? Math.round(score * 100) / 100 : null, reviews: reviews !== null && reviews >= 0 ? Math.round(reviews) : null, days: num(o.days) }
	}
	const score = num(tag[1])
	const reviews = num(tag[2])
	return { score: score !== null && score >= 0 && score <= 5 ? score : null, reviews: reviews !== null && reviews >= 0 ? Math.round(reviews) : null, days: num(tag[3]) }
}

// Las monedas estables se comparan con el dólar (Yadio no da su precio)
const marketFiat = (fiat: string) => (fiat === 'USDT' || fiat === 'USDC' ? 'USD' : fiat)

// Una orden abierta y en la red principal, o null si el evento no lo es (cerrada, caducada, de pruebas o rota)
export function parseOrder(e: NostrEvent, market: Record<string, number>, nowMs: number): NostrOrder | null {
	if (e.kind !== KIND || !Array.isArray(e.tags)) return null
	if (one(e, 's') !== 'pending') return null
	const k = one(e, 'k')
	if (k !== 'buy' && k !== 'sell') return null
	const fiat = (one(e, 'f') ?? '').toUpperCase()
	if (!/^[A-Z]{3,5}$/.test(fiat) || fiat === 'BTC' || fiat === 'SATS') return null
	const network = one(e, 'network')
	if (network && network !== 'mainnet') return null
	const expS = num(one(e, 'expiration') ?? one(e, 'expires_at'))
	if (expS !== null && expS * 1000 <= nowMs) return null

	const fa = tagOf(e, 'fa')
	const a = num(fa?.[1])
	const b = num(fa?.[2]) ?? a
	if (a === null || b === null || a <= 0 || b <= 0) return null
	const min = Math.min(a, b)
	const max = Math.max(a, b)
	const amt = num(one(e, 'amt'))
	const sats = amt !== null && amt > 0 ? Math.round(amt) : null
	const ref = market[marketFiat(fiat)] ?? null
	let premium = num(one(e, 'premium'))
	let price: number | null = null
	if (sats !== null) {
		// Monto fijo: el precio sale de lo que pide por esos satoshis. Con rango (Hodl Hodl), los satoshis son los del
		// tope: 20–1,000 USD con amt de 1,000 USD en sats
		price = max / (sats / 1e8)
		premium = ref ? Math.round((price / ref - 1) * 10000) / 100 : null
	} else if (ref) price = ref * (1 + (premium ?? 0) / 100)
	if (price !== null && !(price > 0 && Number.isFinite(price))) return null
	if (price !== null) price = Math.round(price * 100) / 100

	const y = tagOf(e, 'y')
	// Algunas publican una clave en hexadecimal en vez de un nombre: «otra»
	const rawPlatform = text(y?.[1], 80).toLowerCase()
	const platform = /^[a-z0-9][a-z0-9 ._-]{0,29}$/.test(rawPlatform) && !/^[0-9a-f]{24,}$/.test(rawPlatform) ? rawPlatform : 'otra'
	const node = text(y?.[2], 40) || null
	const name = text(one(e, 'name'), 30)
	const pm = tagOf(e, 'pm')
	const pays = [...new Set((pm?.slice(1) ?? []).map((p) => text(p, 60)).filter(Boolean))].slice(0, 6)
	const source = one(e, 'source') ?? ''
	const link = /^https:\/\/[^\s]{4,300}$/.test(source) ? source : null
	const layer = text(one(e, 'layer'), 12) || null
	const d = one(e, 'd') ?? ''
	const take = platform === 'mostro' && UUID.test(d) && HEX64.test(e.pubkey) ? { id: d, node: e.pubkey, relays: relaysOf(source) } : null
	return {
		side: k === 'sell' ? 'ask' : 'bid',
		fiat,
		min,
		max,
		sats,
		premium,
		price,
		pays,
		platform,
		node,
		// Un nombre que es una clave en hexadecimal no dice nada
		name: name && !/^[0-9a-f]{32,}$/.test(name) ? name : null,
		...ratingOf(tagOf(e, 'rating')),
		layer,
		link,
		at: e.created_at * 1000,
		exp: expS !== null ? expS * 1000 : null,
		take,
	}
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const HEX64 = /^[0-9a-f]{64}$/
// Los relays del enlace de Mostro («mostro:<id>?relays=wss://a,wss://b&mostro=<clave>»): solo wss:// sin ruta
export function relaysOf(source: string): string[] {
	const m = /[?&]relays=([^&]*)/.exec(source)
	if (!m) return []
	const out = decodeURIComponent(m[1])
		.split(',')
		.map((r) => r.trim().replace(/\/+$/, '').toLowerCase())
		.filter((r) => /^wss:\/\/[a-z0-9.-]{3,80}$/.test(r))
	return [...new Set(out)].slice(0, 8)
}

// El anuncio de un nodo de Mostro (kind 38385). Sin «protocol_version» es un nodo viejo, que habla el protocolo 1
export function parseNode(e: NostrEvent): MostroNode | null {
	if (e.kind !== 38385 || !HEX64.test(e.pubkey) || !Array.isArray(e.tags)) return null
	const n = (name: string) => num(one(e, name))
	return {
		version: text(one(e, 'mostro_version'), 20) || null,
		protocol: n('protocol_version') ?? 1,
		pow: n('pow') ?? 0,
		powFirst: n('pow_first_contact'),
		fee: n('fee'),
		minSats: n('min_order_amount'),
		maxSats: n('max_order_amount'),
		bonds: one(e, 'bond_enabled') === 'true',
		stepS: n('expiration_seconds'),
		cltv: n('hold_invoice_cltv_delta'),
		marginBlocks: n('escrow_deadline_margin_blocks'),
		maintenance: one(e, 'maintenance_mode') === 'true',
		health: null,
		at: e.created_at * 1000,
	}
}

// El informe de salud de un nodo (kind 38389, z = health, d = su clave) se pasa entero si es pequeño: lleva la firma
const HEALTH_MAX = 6000
export function healthOf(e: NostrEvent): NostrEvent | null {
	if (e.kind !== 38389 || !HEX64.test(e.pubkey) || !Array.isArray(e.tags) || one(e, 'z') !== 'health' || one(e, 'd') !== e.pubkey) return null
	if (typeof e.id !== 'string' || typeof e.sig !== 'string' || JSON.stringify(e).length > HEALTH_MAX) return null
	return { id: e.id, pubkey: e.pubkey, created_at: e.created_at, kind: e.kind, tags: e.tags, content: typeof e.content === 'string' ? e.content : '', sig: e.sig }
}

// Los eventos 38383 se reemplazan: de cada orden (autor + «d») vale el más reciente que mandó cualquier relay. Uno que
// se quedó con la versión «pending» de una orden ya tomada o cancelada no la deja abierta si otro tiene la nueva
export function latest(events: NostrEvent[]): NostrEvent[] {
	const by = new Map<string, NostrEvent>()
	for (const e of events) {
		if (!e || typeof e.pubkey !== 'string' || typeof e.created_at !== 'number' || !Array.isArray(e.tags)) continue
		const d = one(e, 'd')
		if (!d) continue
		const key = `${e.pubkey}:${d}`
		const prev = by.get(key)
		if (!prev || prev.created_at < e.created_at) by.set(key, e)
	}
	return [...by.values()]
}

export function bookOf(events: NostrEvent[], market: Record<string, number>, relays: RelayState[], nowMs: number): NostrBook {
	const orders = latest(events)
		.map((e) => parseOrder(e, market, nowMs))
		.filter((o): o is NostrOrder => o !== null)
		// Primero las que venden y luego las que compran, cada lado del mejor al peor; las que no tienen precio, al final
		.sort((x, y) => (x.side === y.side ? 0 : x.side === 'ask' ? -1 : 1) || (x.price === null ? 1 : 0) - (y.price === null ? 1 : 0) || (x.side === 'ask' ? (x.price ?? 0) - (y.price ?? 0) : (y.price ?? 0) - (x.price ?? 0)))
	const used: Record<string, number> = {}
	for (const o of orders) {
		const f = marketFiat(o.fiat)
		if (market[f]) used[f] = market[f]
	}
	// De cada nodo, su anuncio más reciente; solo los que tienen órdenes en el libro
	const wanted = new Set(orders.map((o) => o.take?.node).filter(Boolean))
	const nodes: Record<string, MostroNode> = {}
	for (const e of events) {
		if (e?.kind !== 38385 || !wanted.has(e.pubkey)) continue
		const n = parseNode(e)
		if (n && (!nodes[e.pubkey] || nodes[e.pubkey].at < n.at)) nodes[e.pubkey] = { ...n, health: nodes[e.pubkey]?.health ?? null }
	}
	for (const e of events) {
		if (e?.kind !== 38389 || !nodes[e.pubkey]) continue
		const h = healthOf(e)
		const had = nodes[e.pubkey].health
		if (h && (!had || had.created_at < h.created_at)) nodes[e.pubkey].health = h
	}
	return { at: nowMs, market: used, relays, orders, nodes }
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
	// accept() es de los Workers (la comprobación de las pruebas usa los tipos del navegador, que no lo tienen)
	const ws = (res as Response & { webSocket?: (WebSocket & { accept(): void }) | null }).webSocket
	if (!ws) throw new Error(`HTTP ${res.status}`)
	ws.accept()
	return ws as unknown as SocketLike
}

// Las órdenes abiertas, y además todo lo reciente: así llega también la versión nueva (tomada, cancelada) de una orden
// que otro relay aún tiene como abierta. Y los anuncios de los nodos de Mostro (se renuevan cada pocos minutos)
export const filtersFor = (nowS: number) => [
	{ kinds: [KIND], '#s': ['pending'], since: nowS - WINDOW_S, limit: 2000 },
	{ kinds: [KIND], since: nowS - WINDOW_S, limit: 3000 },
	{ kinds: [38385], since: nowS - WINDOW_S, limit: 300 },
	// La salud se publica cada minuto y caduca a los tres: con la última hora basta
	{ kinds: [38389], since: nowS - 3600, limit: 300 },
]

export async function readRelay(url: string, connect: Connect, nowS: number, timeoutMs = RELAY_TIMEOUT_MS): Promise<{ state: RelayState; events: NostrEvent[] }> {
	const events: NostrEvent[] = []
	let ws: SocketLike
	try {
		ws = await connect(url)
	} catch (e) {
		const msg = String((e as Error)?.message ?? e)
		return { state: { url, ok: false, events: 0, why: (e as Error)?.name === 'TimeoutError' ? 'tiempo agotado' : /^HTTP \d+/.test(msg) ? msg.slice(0, 12) : 'no conecta' }, events }
	}
	const sub = 'tp'
	return new Promise((resolve) => {
		let done = false
		const finish = (ok: boolean, why?: string) => {
			if (done) return
			done = true
			clearTimeout(timer)
			try {
				ws.send(JSON.stringify(['CLOSE', sub]))
				ws.close(1000)
			} catch {
				// ya estaba cerrado
			}
			// Si se cortó a medias pero mandó órdenes, cuentan
			resolve({ state: { url, ok: ok || events.length > 0, events: events.length, ...(why ? { why } : {}) }, events })
		}
		const timer = setTimeout(() => finish(false, 'tiempo agotado'), timeoutMs)
		ws.addEventListener('message', (ev) => {
			if (typeof ev.data !== 'string') return
			let m: unknown
			try {
				m = JSON.parse(ev.data)
			} catch {
				return
			}
			if (!Array.isArray(m) || m[1] !== sub) return
			if (m[0] === 'EVENT' && m[2] && typeof m[2] === 'object') {
				if (events.length < MAX_EVENTS) events.push(m[2] as NostrEvent)
				else finish(true)
			} else if (m[0] === 'EOSE') finish(true)
			else if (m[0] === 'CLOSED') finish(false, 'cerró la consulta')
		})
		ws.addEventListener('close', () => finish(false, 'se cerró'))
		ws.addEventListener('error', () => finish(false, 'error'))
		try {
			ws.send(JSON.stringify(['REQ', sub, ...filtersFor(nowS)]))
		} catch {
			finish(false, 'no conecta')
		}
	})
}

// El precio del bitcoin en cada moneda según Yadio ({"BTC": {"USD": 73661.91, "CUP": 67400648.68, …}})
export async function marketPrices(fetcher: typeof fetch = fetch): Promise<Record<string, number>> {
	try {
		const res = await fetcher(PRICE_URL, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(5000) })
		if (!res.ok) return {}
		const data = (await res.json()) as { BTC?: Record<string, unknown> }
		const out: Record<string, number> = {}
		for (const [k, v] of Object.entries(data?.BTC ?? {})) {
			const n = num(v)
			if (/^[A-Z]{3,5}$/.test(k) && n !== null && n > 0) out[k] = n
		}
		return out
	} catch {
		return {}
	}
}

// ¿Existe esa dirección Lightning? Lo que contesta su dominio en /.well-known/lnurlp/<usuario> (LUD-16), antes de
// tomar una orden: si no existe, Mostro no podría pagar. Solo https al dominio de la dirección, 5 s y 16 KB como mucho
export interface LnAddressInfo {
	ok: boolean
	reason?: string
	min?: number // sats
	max?: number
	text?: string
	qvapay?: boolean
}
export async function lnAddress(addr: string, fetcher: typeof fetch = fetch): Promise<LnAddressInfo> {
	const a = addr.trim().toLowerCase()
	if (a.length > 120 || !LN_ADDRESS.test(a)) return { ok: false, reason: 'No tiene la forma usuario@dominio' }
	const [user, domain] = a.split('@')
	let res: Response
	try {
		res = await fetcher(`https://${domain}/.well-known/lnurlp/${encodeURIComponent(user)}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(5000) })
	} catch {
		return { ok: false, reason: `${domain} no responde` }
	}
	const raw = await res.text().catch(() => '')
	let data: Record<string, unknown> | null = null
	try {
		data = raw.length <= 16_384 ? (JSON.parse(raw) as Record<string, unknown>) : null
	} catch {}
	if (res.status === 404 || (data && data.status === 'ERROR')) return { ok: false, reason: 'Esa dirección no existe' }
	const min = num(data?.minSendable)
	const max = num(data?.maxSendable)
	if (!res.ok || !data || data.tag !== 'payRequest' || typeof data.callback !== 'string' || !data.callback.startsWith('https://') || min === null || max === null)
		return { ok: false, reason: `${domain} no da una dirección Lightning válida` }
	let text = ''
	try {
		const meta = JSON.parse(String(data.metadata ?? '[]')) as unknown[]
		const plain = meta.find((m) => Array.isArray(m) && m[0] === 'text/plain') as [string, unknown] | undefined
		text = typeof plain?.[1] === 'string' ? plain[1].slice(0, 80) : ''
	} catch {}
	return { ok: true, min: Math.ceil(min / 1000), max: Math.floor(max / 1000), text, qvapay: domain === QVAPAY_LN_DOMAIN }
}

export async function nostrBook(connect: Connect = connectWorker, fetcher: typeof fetch = fetch, now = Date.now()): Promise<NostrBook> {
	const nowS = Math.floor(now / 1000)
	const [market, ...reads] = await Promise.all([marketPrices(fetcher), ...NOSTR_RELAYS.map((u) => readRelay(u, connect, nowS))])
	return bookOf(
		reads.flatMap((r) => r.events),
		market,
		reads.map((r) => r.state),
		now,
	)
}
