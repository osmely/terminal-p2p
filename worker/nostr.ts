// Libro P2P de bitcoin en Nostr (experimental, solo en staging): las órdenes públicas que publican Mostro, RoboSats,
// Hodl Hodl, lnp2pBot y otros con el formato común NIP-69 (eventos kind 38383). Se leen de varios relays públicos,
// sin claves y sin cuenta: solo lectura, como el libro que ve cualquiera en esas aplicaciones.
//
// Los lados se nombran desde quien mira, como en el libro del terminal: «ask» son las órdenes que VENDEN bitcoin (ahí
// compras; la mejor es la más barata) y «bid» las que COMPRAN bitcoin (ahí vendes; la mejor es la más cara).
//
// El precio de mercado es el de Yadio, el mismo que usa Mostro para las órdenes «a precio de mercado» (amt 0): el
// precio que sale aquí es el que se pagaría al tomarla (mercado × (1 + prima)).

export const NOSTR_RELAYS = ['wss://relay.mostro.network', 'wss://nos.lol', 'wss://relay.damus.io', 'wss://nostr.mom', 'wss://relay.primal.net']
const KIND = 38383
// Las órdenes caducan en horas o días (Mostro 24 h, Hodl Hodl una semana): más atrás no hay ninguna abierta
const WINDOW_S = 8 * 86400
// Lo más que se lee de un relay, para que uno que mande de todo no se coma la memoria
const MAX_EVENTS = 5000
const RELAY_TIMEOUT_MS = 6000
const PRICE_URL = 'https://api.yadio.io/exrates/BTC'

export interface NostrEvent {
	id?: string
	pubkey: string
	created_at: number
	kind: number
	tags: string[][]
	content?: string
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
	}
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
	return { at: nowMs, market: used, relays, orders }
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
	const ws = (res as Response & { webSocket?: WebSocket | null }).webSocket
	if (!ws) throw new Error(`HTTP ${res.status}`)
	ws.accept()
	return ws as unknown as SocketLike
}

// Las órdenes abiertas, y además todo lo reciente: así llega también la versión nueva (tomada, cancelada) de una orden
// que otro relay aún tiene como abierta
export const filtersFor = (nowS: number) => [
	{ kinds: [KIND], '#s': ['pending'], since: nowS - WINDOW_S, limit: 2000 },
	{ kinds: [KIND], since: nowS - WINDOW_S, limit: 3000 },
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
