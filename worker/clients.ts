// «Mis clientes»: un comerciante con Pro invita a sus clientes de siempre (terminalp2p.com/c/<usuario>) y les manda
// ofertas privadas de QvaPay, que no salen en el libro ni en el feed: ni los bots ni la competencia las ven. Al mandarla,
// el servidor lee la oferta en QvaPay con el token del comerciante (como el relé: de paso, sin guardarlo) para saber que
// existe, que es suya y que es privada, y avisa a sus clientes por Telegram. Los clientes la ven en el terminal y la toma
// el primero que llegue. Se guarda lo público de la oferta, nunca los datos de pago

import { COINS } from '../src/terminal/market.ts'
import type { P2POffer } from '../src/qvapay/types.ts'
import { tgEsc } from './alerts.ts'
import type { D1 } from './rates.ts'
import { appUrl, tellUser, type BotEnv } from './userbot.ts'

export const MAX_CLIENTS = 300
export const MAX_MERCHANTS = 20
// Una oferta mandada se enseña a los clientes hasta que el comerciante dice que ya no está, o como mucho esto
export const OPEN_MS = 2 * 86_400_000
const KEEP_MS = 90 * 86_400_000
const UPSTREAM = 'https://api.qvapay.com'
const USERNAME = /^[A-Za-z0-9._-]{1,40}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const COIN = new Map(COINS.map((c) => [c.tick as string, c]))

export interface Me {
	uuid: string
	username: string
}

export interface ClientOffer {
	uuid: string
	merchant: string
	coin: string
	type: 'sell' | 'buy'
	price: number
	usd: number
	kind: 'fixed' | 'flexible'
	orderMin: number | null
	orderMax: number | null
	vipOnly: boolean
	requirements: Record<string, number> | null
	status: 'open' | 'closed'
	sent: number
	createdAt: number
	closedAt: number | null
}

interface OfferRow {
	uuid: string
	merchant_name: string
	coin: string
	type: string
	price: number
	usd: number
	kind: string
	order_min: number | null
	order_max: number | null
	vip_only: number
	requirements: string | null
	status: string
	sent: number
	created_at: number
	closed_at: number | null
}

export const cleanUsername = (v: unknown) => {
	const s = String(v ?? '').trim().replace(/^@/, '')
	return USERNAME.test(s) ? s : null
}

const toOffer = (r: OfferRow): ClientOffer => ({
	uuid: r.uuid,
	merchant: r.merchant_name,
	coin: r.coin,
	type: r.type === 'buy' ? 'buy' : 'sell',
	price: r.price,
	usd: r.usd,
	kind: r.kind === 'flexible' ? 'flexible' : 'fixed',
	orderMin: r.order_min,
	orderMax: r.order_max,
	vipOnly: !!r.vip_only,
	requirements: r.requirements ? (JSON.parse(r.requirements) as Record<string, number>) : null,
	status: r.status === 'open' ? 'open' : 'closed',
	sent: r.sent,
	createdAt: r.created_at,
	closedAt: r.closed_at,
})

const OFFER_COLS = 'uuid, merchant_name, coin, type, price, usd, kind, order_min, order_max, vip_only, requirements, status, sent, created_at, closed_at'

// Lo de esta cuenta en los dos papeles: de quién es cliente (y lo que le mandaron que sigue abierto) y, como comerciante,
// sus clientes y lo que les mandó
export async function clientsView(db: D1, me: Me, now: number) {
	const u = me.username.toLowerCase()
	const merchants = (await db.prepare('SELECT merchant_name AS username, joined_at FROM client_members WHERE client = ? ORDER BY joined_at').bind(u).all<{ username: string; joined_at: number }>()).results
	const offers = (
		await db
			.prepare(`SELECT ${OFFER_COLS} FROM client_offers WHERE status = 'open' AND created_at > ? AND merchant IN (SELECT merchant FROM client_members WHERE client = ?) ORDER BY created_at DESC LIMIT 50`)
			.bind(now - OPEN_MS, u)
			.all<OfferRow>()
	).results
	const clients = (await db.prepare('SELECT client_name AS username, joined_at FROM client_members WHERE merchant = ? ORDER BY joined_at DESC').bind(u).all<{ username: string; joined_at: number }>()).results
	const mine = (await db.prepare(`SELECT ${OFFER_COLS} FROM client_offers WHERE merchant = ? ORDER BY created_at DESC LIMIT 20`).bind(u).all<OfferRow>()).results
	return {
		merchants: merchants.map((m) => ({ username: m.username, joinedAt: m.joined_at })),
		offers: offers.map(toOffer),
		clients: clients.map((c) => ({ username: c.username, joinedAt: c.joined_at })),
		mine: mine.map((o) => ({ ...toOffer(o), status: o.status === 'open' && o.created_at > now - OPEN_MS ? 'open' : 'closed' })),
		maxClients: MAX_CLIENTS,
	}
}

// Entrar en la lista de un comerciante (el que tiene Pro lo comprueba la ruta). Devuelve el error para el usuario, o null
export async function join(db: D1, merchant: string, me: Me, now: number) {
	const m = merchant.toLowerCase()
	const c = me.username.toLowerCase()
	if (m === c) return 'Ese enlace es el tuyo: pásaselo a tus clientes'
	if (await db.prepare('SELECT 1 FROM client_members WHERE merchant = ? AND client = ?').bind(m, c).first()) return null
	const mine = await db.prepare('SELECT COUNT(*) AS n FROM client_members WHERE client = ?').bind(c).first<{ n: number }>()
	if ((mine?.n ?? 0) >= MAX_MERCHANTS) return `Ya recibes ofertas de ${MAX_MERCHANTS} comerciantes: sal de alguno antes`
	const theirs = await db.prepare('SELECT COUNT(*) AS n FROM client_members WHERE merchant = ?').bind(m).first<{ n: number }>()
	if ((theirs?.n ?? 0) >= MAX_CLIENTS) return `@${merchant} ya tiene el máximo de ${MAX_CLIENTS} clientes`
	await db.prepare('INSERT INTO client_members (merchant, merchant_name, client, client_name, joined_at) VALUES (?, ?, ?, ?, ?)').bind(m, merchant, c, me.username, now).run()
	return null
}

// Salir de la lista (el cliente) o sacar a alguien de ella (el comerciante)
export const leave = (db: D1, merchant: string, client: string) => db.prepare('DELETE FROM client_members WHERE merchant = ? AND client = ?').bind(merchant.toLowerCase(), client.toLowerCase()).run()

// La oferta tal como la ve en QvaPay el token de quien la manda (lo que hace el relé: de paso, sin guardarlo)
export async function readOffer(token: string, uuid: string, fetcher: typeof fetch = fetch): Promise<P2POffer | null> {
	const res = await fetcher(`${UPSTREAM}/p2p/${uuid}`, { headers: { Accept: 'application/json', Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) })
	if (!res.ok) return null
	const j = (await res.json().catch(() => null)) as { p2p?: P2POffer } | null
	return j?.p2p ?? null
}

const n = (v: unknown) => {
	const x = Number(v)
	return Number.isFinite(x) ? x : 0
}

// ¿Se puede mandar esta oferta a los clientes? Devuelve el error para el usuario, o null
export function checkOffer(o: P2POffer | null, me: Me, uuid: string) {
	if (!o || o.uuid?.toLowerCase() !== uuid) return 'No se pudo leer la oferta en QvaPay. Inténtalo de nuevo.'
	if (o.User?.uuid?.toLowerCase() !== me.uuid.toLowerCase()) return 'Esa oferta no es tuya'
	if (!o.private) return 'Solo se mandan ofertas privadas: las públicas ya salen en el libro'
	if (o.status !== 'open' || o.pause) return 'Esa oferta ya no está abierta'
	if (!COIN.has(o.coin)) return 'Ese mercado no está en el terminal'
	return null
}

// Guarda lo público de la oferta. false si ya se había mandado (no se avisa dos veces)
export async function saveOffer(db: D1, o: P2POffer, me: Me, now: number) {
	const flexible = o.offer_kind === 'flexible'
	const usd = flexible ? n(o.available_amount) || n(o.amount) : n(o.amount)
	const price = usd > 0 ? n(o.receive) / n(o.amount) : 0
	const r = await db
		.prepare(
			`INSERT OR IGNORE INTO client_offers (uuid, merchant, merchant_name, coin, type, price, usd, kind, order_min, order_max, vip_only, requirements, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			o.uuid.toLowerCase(),
			me.username.toLowerCase(),
			me.username,
			o.coin,
			o.type === 'buy' ? 'buy' : 'sell',
			Math.round(price * 10_000) / 10_000,
			Math.round(usd * 100) / 100,
			flexible ? 'flexible' : 'fixed',
			flexible ? n(o.order_min) || null : null,
			flexible ? n(o.order_max) || null : null,
			o.only_vip ? 1 : 0,
			o.requirements && Object.keys(o.requirements).length ? JSON.stringify(o.requirements) : null,
			now,
		)
		.run()
	return !!r.meta?.changes
}

// El comerciante dice cuáles de las suyas ya no están abiertas (las ve en su terminal con su token)
export async function closeOffers(db: D1, merchant: string, uuids: string[], now: number) {
	const list = uuids.map((u) => u.toLowerCase()).filter((u) => UUID.test(u)).slice(0, 50)
	for (const u of list) await db.prepare("UPDATE client_offers SET status = 'closed', closed_at = ? WHERE uuid = ? AND merchant = ? AND status = 'open'").bind(now, u, merchant.toLowerCase()).run()
	return list.length
}

const num = (x: number, d = 2) => x.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: x < 10 && d === 2 ? 4 : d })

export function offerText(o: Pick<ClientOffer, 'merchant' | 'coin' | 'type' | 'price' | 'usd' | 'kind' | 'orderMin' | 'orderMax' | 'vipOnly'>) {
	const c = COIN.get(o.coin)
	const sell = o.type === 'sell'
	const range = o.kind === 'flexible' && o.orderMin && o.orderMax ? `\nPor partes: de ${num(o.orderMin)} a ${num(o.orderMax)} USD` : ''
	return `🤝 <b>@${tgEsc(o.merchant)} publicó una oferta para sus clientes</b>

${sell ? 'Vende' : 'Compra'} <b>${num(o.usd)} USD</b> a <b>${num(o.price)} ${tgEsc(c?.unit ?? '')}</b> por USD
${tgEsc(c?.name ?? o.coin)}${range}${o.vipOnly ? '\nSolo cuentas VIP' : ''}

Es privada: no sale en el libro. Se la lleva el primero que la tome.`
}

// Avisa por Telegram a los clientes que conectaron el bot. Devuelve cuántos avisos salieron
export async function notifyClients(env: BotEnv & { DB: D1 }, o: ClientOffer, fetcher: typeof fetch = fetch) {
	const { results } = await env.DB.prepare('SELECT client FROM client_members WHERE merchant = ?').bind(o.merchant.toLowerCase()).all<{ client: string }>()
	const text = offerText(o)
	const markup = { inline_keyboard: [[{ text: sell(o) ? 'Comprarle' : 'Venderle', url: `${appUrl(env)}/#p2p/${o.uuid}` }]] }
	let sent = 0
	// De 10 en 10: Telegram deja unos 30 mensajes por segundo
	for (let i = 0; i < results.length; i += 10) {
		const ok = await Promise.all(results.slice(i, i + 10).map((r) => tellUser(env, `qp:${r.client}`, text, markup, fetcher)))
		sent += ok.filter(Boolean).length
	}
	await env.DB.prepare('UPDATE client_offers SET sent = ? WHERE uuid = ?').bind(sent, o.uuid).run()
	return sent
}
const sell = (o: Pick<ClientOffer, 'type'>) => o.type === 'sell'

export async function offerOf(db: D1, uuid: string) {
	const r = await db.prepare(`SELECT ${OFFER_COLS} FROM client_offers WHERE uuid = ?`).bind(uuid.toLowerCase()).first<OfferRow>()
	return r ? toOffer(r) : null
}

export async function cleanupClients(db: D1, now: number) {
	await db.prepare("UPDATE client_offers SET status = 'closed', closed_at = ? WHERE status = 'open' AND created_at < ?").bind(now, now - OPEN_MS).run()
	await db.prepare('DELETE FROM client_offers WHERE created_at < ?').bind(now - KEEP_MS).run()
}
