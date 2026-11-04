// Avisos push de tus operaciones, con el terminal cerrado (y el navegador también, en Android y escritorio). El feed
// del mercado trae el uuid del dueño de cada oferta: el libro en vivo (livebook-do.ts) pasa aquí cada evento y, si su
// dueño activó los avisos en algún navegador, se le manda. Quien toma una oferta fija desde el terminal la apunta
// (push_watch) para enterarse de lo que haga su dueño: le pagó, le liberó, se canceló. Solo ofertas públicas (las
// privadas no salen en el feed); en las de rango QvaPay no avisa del pago de cada parte, solo de lo que te toman y de lo
// que vuelve. Ningún evento se guarda: solo la suscripción del navegador y de qué cuenta es

import { COINS } from '../src/terminal/market.ts'
import { num } from '../src/qvapay/types.ts'
import { accessOf } from './blocks.ts'
import type { FeedEvent, LiveNamespace, Trade } from './livebook.ts'
import type { D1 } from './rates.ts'
import { readWho, type Who } from './session.ts'
import { sendPush, vapidPublic, type PushSub, type Vapid } from './webpush.ts'

export interface PushEnv {
	DB: D1
	PRO_KEY?: string
	// La clave privada VAPID como JWK (npx wrangler secret put VAPID_PRIVATE_JWK). Sin ella no hay avisos push
	VAPID_PRIVATE_JWK?: string
	LIVE?: LiveNamespace
	STAGING?: string
}

const COIN = new Map(COINS.map((c) => [c.tick as string, c]))
// Un evento más viejo que esto no avisa (tras un corte del feed llegarían de golpe cosas ya pasadas)
export const PUSH_MAX_AGE_MS = 15 * 60_000
// Quién los tiene activados se relee de la base cada tanto, y al momento cuando alguien los activa o toma una oferta
export const TARGETS_TTL_MS = 5 * 60_000
// Una oferta tomada se vigila como mucho esto (más que cualquier plazo de pago y una disputa corta)
export const WATCH_MS = 3 * 86_400_000
// Navegadores por cuenta y ofertas vigiladas por navegador
const SUBS_PER_OWNER = 10
const WATCH_PER_SUB = 50
// Tope por navegador y hora (un error o una oferta que se edita sin parar no inunda el móvil)
export const PUSH_PER_HOUR = 30
// Tras tantos fallos seguidos (sin que el servicio diga que ya no existe) se borra
const MAX_FAILS = 20

export const vapidOf = (env: PushEnv): Vapid | null => {
	if (!env.VAPID_PRIVATE_JWK) return null
	try {
		return { jwk: JSON.parse(env.VAPID_PRIVATE_JWK), subject: 'https://terminalp2p.com' }
	} catch {
		return null
	}
}

// Lo que le llega al navegador (public/app/sw.js lo enseña). tag: el mismo que usa el terminal para ese suceso, así
// el aviso del terminal abierto y el push no salen dos veces
export interface PushMsg {
	title: string
	body: string
	tag: string
	url: string
	urgent: boolean
	// Con el terminal abierto, tocar el aviso abre esa operación
	offer?: string
	kind?: string
}

export interface PushNotice {
	// A quién: al dueño de la oferta (su uuid) o a quien la tomó (la oferta vigilada)
	owner?: string
	offer?: string
	// Para no mandar dos veces lo mismo (el mismo evento llega por el webhook y por el stream)
	key: string
	// null: no hay nada que avisar, solo dejar de vigilarla
	msg: PushMsg | null
	// La operación terminó: ya no hace falta vigilarla
	end?: boolean
}

const usdOf = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const priceOf = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: n < 10 ? 4 : 2 })
const URL_OPS = '/#ops'

function basics(e: FeedEvent, now: number) {
	const d = e?.data
	if (!d?.uuid || (d.type !== 'buy' && d.type !== 'sell')) return null
	const c = COIN.get(d.coin)
	if (!c) return null
	const at = Date.parse(d.updated_at ?? e.sent_at ?? '') || now
	if (now - at > PUSH_MAX_AGE_MS) return null
	const amount = num(d.amount)
	const price = amount > 0 ? num(d.receive) / amount : 0
	if (!(price > 0)) return null
	return { d, c, amount, price, sell: d.type === 'sell', stamp: d.updated_at ?? e.sent_at ?? '', rate: `${priceOf(price)} ${c.unit}` }
}

// Lo que se le avisa al dueño de la oferta. «sell»: vende USD (le pagan y libera); «buy»: compra USD (paga y le
// liberan). trade: lo que tomaron o volvió de una oferta de rango
export function ownerPush(e: FeedEvent, trade: Trade | null, now = Date.now()): PushNotice | null {
	const b = basics(e, now)
	if (!b || !b.d.owner_uuid) return null
	const { d, c, amount, sell, rate } = b
	const what = sell ? 'venta' : 'compra'
	const next = sell ? 'Espera el pago y libera solo cuando veas el dinero en tu cuenta.' : 'Te toca pagar dentro del plazo.'
	const say = (kind: string, title: string, body: string, urgent = false): PushNotice => ({
		owner: d.owner_uuid!.toLowerCase(),
		key: `o:${d.uuid}:${kind}:${b.stamp}`,
		msg: { title, body, tag: `tp:${d.uuid}:${kind}`, url: URL_OPS, urgent, offer: d.uuid, kind },
	})
	if (e.event.startsWith('p2p.range_')) {
		if (!trade) return null
		if (trade.ops > 0) {
			const left = num(d.available_amount ?? 0)
			const rest = e.event === 'p2p.range_closed' ? 'Era lo que quedaba.' : `Quedan ${usdOf(left)} USD publicados.`
			return say('taken', `Te tomaron ${usdOf(trade.usd)} USD de tu ${what}`, `${c.name} a ${rate}. ${rest} ${next}`, !sell)
		}
		return say('left', `Volvieron ${usdOf(trade.usd)} USD a tu ${what}`, `${c.name}: quien los tomó no completó la operación. Siguen publicados a ${rate}.`)
	}
	const usd = usdOf(amount)
	if (e.event === 'p2p.applied') return say('taken', `Tomaron tu ${what} de ${usd} USD`, `${c.name} a ${rate}. ${next}`, !sell)
	// Quien marca pagado en tu compra eres tú: solo se avisa en tus ventas
	if (e.event === 'p2p.paid' && sell) return say('paid', 'Te pagaron: comprueba y libera', `${usd} USD · ${c.name} a ${rate}. Mira tu cuenta antes de liberar.`, true)
	// Al completarse una venta, liberaste tú: solo se avisa en tus compras
	if (e.event === 'p2p.completed' && !sell && d.status === 'completed') return say('released', `Te liberaron ${usd} USD`, `Se completó tu compra · ${c.name} a ${rate}.`)
	if (e.event === 'p2p.reopened') return say('left', `Tu ${what} volvió al libro`, `${c.name}: quien la tomó la canceló o se le acabó el plazo. Sigue publicada: ${usd} USD a ${rate}.`)
	return null
}

// Lo que se le avisa a quien tomó la oferta (fija) desde el terminal. En una venta del dueño, quien la toma compra USD
// (paga y le liberan); en una compra del dueño, vende (le pagan y libera)
export function takerPush(e: FeedEvent, now = Date.now()): PushNotice | null {
	const b = basics(e, now)
	if (!b || e.event.startsWith('p2p.range_')) return null
	const { d, c, amount, sell, rate } = b
	const usd = usdOf(amount)
	const say = (kind: string, title: string, body: string, urgent = false, end = false): PushNotice => ({
		offer: d.uuid,
		key: `t:${d.uuid}:${kind}:${b.stamp}`,
		msg: { title, body, tag: `tp:${d.uuid}:${kind}`, url: URL_OPS, urgent, offer: d.uuid, kind },
		end,
	})
	if (e.event === 'p2p.paid' && !sell) return say('paid', 'Te pagaron: comprueba y libera', `${usd} USD · ${c.name} a ${rate}. Mira tu cuenta antes de liberar.`, true)
	// En una venta tuya liberaste tú: no hay nada que avisar
	if (e.event === 'p2p.completed')
		return sell && d.status === 'completed' ? say('released', `Te liberaron ${usd} USD`, `Se completó tu compra · ${c.name} a ${rate}.`, false, true) : { offer: d.uuid, key: `t:${d.uuid}:end:${b.stamp}`, msg: null, end: true }
	if (e.event === 'p2p.reopened' || e.event === 'p2p.cancelled')
		return say('left', `Se canceló tu ${sell ? 'compra' : 'venta'} de ${usd} USD`, `${c.name}: la operación se canceló o venció el plazo de pago.`, false, true)
	return null
}

// ── La base ───────────────────────────────────────────────────────────

interface SubRow {
	endpoint: string
	p256dh: string
	auth: string
}

const ENDPOINT = /^https:\/\/[^\s]{10,1000}$/
const KEY = /^[A-Za-z0-9_-]{16,200}$/

export function parseSub(v: unknown): PushSub | null {
	const s = v as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } } | null
	const endpoint = typeof s?.endpoint === 'string' ? s.endpoint : ''
	const p256dh = typeof s?.keys?.p256dh === 'string' ? s.keys.p256dh : ''
	const auth = typeof s?.keys?.auth === 'string' ? s.keys.auth : ''
	return ENDPOINT.test(endpoint) && KEY.test(p256dh) && KEY.test(auth) ? { endpoint, p256dh, auth } : null
}

export async function saveSub(db: D1, sub: PushSub, who: Who, now: number) {
	const owner = who.uuid.toLowerCase()
	await db
		.prepare(
			`INSERT INTO push_subs (endpoint, p256dh, auth, owner, username, created_at) VALUES (?, ?, ?, ?, ?, ?)
			 ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth, owner = excluded.owner, username = excluded.username, fails = 0`,
		)
		.bind(sub.endpoint, sub.p256dh, sub.auth, owner, who.username, now)
		.run()
	// Los más viejos de esa cuenta, fuera
	await db
		.prepare(`DELETE FROM push_subs WHERE owner = ? AND endpoint NOT IN (SELECT endpoint FROM push_subs WHERE owner = ? ORDER BY created_at DESC LIMIT ${SUBS_PER_OWNER})`)
		.bind(owner, owner)
		.run()
}

export async function dropSub(db: D1, endpoint: string) {
	await db.batch([db.prepare('DELETE FROM push_watch WHERE endpoint = ?').bind(endpoint), db.prepare('DELETE FROM push_subs WHERE endpoint = ?').bind(endpoint)])
}

const subOf = (db: D1, endpoint: string, owner: string) =>
	db.prepare('SELECT endpoint, p256dh, auth FROM push_subs WHERE endpoint = ? AND owner = ?').bind(endpoint, owner.toLowerCase()).first<SubRow>()

export async function addWatch(db: D1, endpoint: string, offer: string, now: number) {
	await db.prepare('INSERT INTO push_watch (offer, endpoint, created_at) VALUES (?, ?, ?) ON CONFLICT(offer, endpoint) DO UPDATE SET created_at = excluded.created_at').bind(offer, endpoint, now).run()
	await db
		.prepare(`DELETE FROM push_watch WHERE endpoint = ? AND offer NOT IN (SELECT offer FROM push_watch WHERE endpoint = ? ORDER BY created_at DESC LIMIT ${WATCH_PER_SUB})`)
		.bind(endpoint, endpoint)
		.run()
}

// Quién puede recibir algo: las cuentas con avisos activados y las ofertas vigiladas
export async function pushTargets(db: D1, now: number) {
	const [owners, offers] = await Promise.all([
		db.prepare('SELECT DISTINCT owner FROM push_subs').all<{ owner: string }>(),
		db.prepare('SELECT DISTINCT offer FROM push_watch WHERE created_at > ?').bind(now - WATCH_MS).all<{ offer: string }>(),
	])
	return { owners: new Set(owners.results.map((r) => r.owner)), offers: new Set(offers.results.map((r) => r.offer)) }
}

export async function cleanupPush(db: D1, now: number) {
	await db.prepare('DELETE FROM push_watch WHERE created_at <= ?').bind(now - WATCH_MS).run()
}

// Manda un aviso a sus navegadores. sentTimes: los envíos de la última hora de cada navegador (los guarda quien llama)
export async function deliverPush(env: PushEnv, n: PushNotice, now: number, sentTimes = new Map<string, number[]>(), fetcher: typeof fetch = fetch) {
	const v = vapidOf(env)
	if (!v) return 0
	const db = env.DB
	const subs = n.owner
		? (await db.prepare('SELECT endpoint, p256dh, auth FROM push_subs WHERE owner = ?').bind(n.owner).all<SubRow>()).results
		: (await db.prepare('SELECT s.endpoint, s.p256dh, s.auth FROM push_watch w JOIN push_subs s ON s.endpoint = w.endpoint WHERE w.offer = ?').bind(n.offer!).all<SubRow>()).results
	if (n.end && n.offer) await db.prepare('DELETE FROM push_watch WHERE offer = ?').bind(n.offer).run()
	if (!n.msg) return 0
	let ok = 0
	for (const s of subs) {
		const times = (sentTimes.get(s.endpoint) ?? []).filter((t) => now - t < 3_600_000)
		if (times.length >= PUSH_PER_HOUR) continue
		times.push(now)
		sentTimes.set(s.endpoint, times)
		const r = await sendPush(s, n.msg, v, { urgency: n.msg.urgent ? 'high' : 'normal', topic: n.msg.tag.replace(/^tp:/, ''), ttlS: 6 * 3600, fetcher }).catch(() => ({ ok: false, status: 0, gone: false }))
		if (r.ok) {
			ok++
			await db.prepare('UPDATE push_subs SET sent_at = ?, fails = 0 WHERE endpoint = ?').bind(now, s.endpoint).run()
		} else if (r.gone) await dropSub(db, s.endpoint)
		else
			await db.batch([
				db.prepare('UPDATE push_subs SET fails = fails + 1 WHERE endpoint = ?').bind(s.endpoint),
				db.prepare(`DELETE FROM push_subs WHERE endpoint = ? AND fails >= ${MAX_FAILS}`).bind(s.endpoint),
			])
	}
	return ok
}

// ── Las rutas del terminal (app.terminalp2p.com/push/…) ───────────────

const json = (status: number, body: unknown) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } })
const UUID = /^[0-9a-f-]{36}$/i
const PRINT = /^[0-9a-f]{64}$/

// El libro en vivo relee quién tiene avisos (o hace llegar un evento inventado, en las pruebas)
const live = (env: PushEnv, path: string, body?: unknown) =>
	env.LIVE ? env.LIVE.get(env.LIVE.idFromName('book') as never).fetch(`https://live${path}`, { method: 'POST', body: JSON.stringify(body ?? {}) }).catch(() => null) : Promise.resolve(null)

// Un evento inventado del feed con tu cuenta de dueño, para probar el camino entero (solo en staging y en local)
export function simEvent(owner: string, kind: string, side: 'sell' | 'buy', now: number, offer = `sim-${now}`): FeedEvent | null {
	const event = { taken: 'p2p.applied', paid: 'p2p.paid', released: 'p2p.completed', left: 'p2p.reopened' }[kind]
	if (!event) return null
	return {
		event,
		sent_at: new Date(now).toISOString(),
		data: { uuid: offer, type: side, coin: 'BANK_CUP', amount: '10', receive: '11100', status: kind === 'released' ? 'completed' : kind === 'left' ? 'open' : 'processing', updated_at: new Date(now).toISOString(), offer_kind: 'fixed', owner_uuid: owner },
	}
}

export async function pushApi(req: Request, url: URL, env: PushEnv, ctx: { waitUntil(p: Promise<unknown>): void }, now = Date.now(), fetcher: typeof fetch = fetch): Promise<Response> {
	const v = vapidOf(env)
	if (url.pathname === '/push/key' && req.method === 'GET') return v ? json(200, { key: vapidPublic(v.jwk) }) : json(404, { error: 'Los avisos push no están configurados' })
	if (req.method !== 'POST') return json(405, { error: 'Método no permitido' })
	if (!v || !env.PRO_KEY) return json(503, { error: 'Los avisos push no están configurados' })
	const body = (await req.json().catch(() => null)) as { print?: unknown; sub?: unknown; endpoint?: unknown; offer?: unknown; kind?: unknown; side?: unknown; taker?: unknown } | null
	const endpoint = typeof body?.endpoint === 'string' ? body.endpoint : ''

	// Desactivar no necesita cuenta: quien tiene la suscripción la puede borrar
	if (url.pathname === '/push/unsubscribe') {
		if (!ENDPOINT.test(endpoint)) return json(400, { error: 'Suscripción no válida' })
		await dropSub(env.DB, endpoint)
		return json(200, { ok: true })
	}

	// Lo demás, solo con tu cuenta de QvaPay confirmada en este navegador (la cookie que firma el relé)
	const print = typeof body?.print === 'string' && PRINT.test(body.print) ? body.print : ''
	const who = print ? await readWho(req.headers.get('cookie'), print, env.PRO_KEY, now) : null
	if (!who) return json(401, { error: 'Conecta tu cuenta de QvaPay para activar los avisos' })
	if ((await accessOf(env.DB, { username: who.username, print }, now))?.level === 'blocked') return json(403, { error: 'Tu cuenta está bloqueada en Terminal P2P' })

	if (url.pathname === '/push/subscribe') {
		const sub = parseSub(body?.sub)
		if (!sub) return json(400, { error: 'Suscripción no válida' })
		await saveSub(env.DB, sub, who, now)
		ctx.waitUntil(live(env, '/push-refresh'))
		return json(200, { ok: true })
	}
	// Las rutas siguientes son de una suscripción tuya
	const mine = ENDPOINT.test(endpoint) ? await subOf(env.DB, endpoint, who.uuid) : null
	if (!mine) return json(404, { error: 'Este navegador no tiene los avisos activados' })

	if (url.pathname === '/push/watch') {
		const offer = typeof body?.offer === 'string' && UUID.test(body.offer) ? body.offer.toLowerCase() : ''
		if (!offer) return json(400, { error: 'Oferta no válida' })
		await addWatch(env.DB, endpoint, offer, now)
		ctx.waitUntil(live(env, '/push-refresh'))
		return json(200, { ok: true })
	}
	if (url.pathname === '/push/test') {
		const msg: PushMsg = { title: 'Avisos activados', body: 'Así te avisaremos cuando tomen tu oferta, te paguen o te liberen, aunque cierres el terminal.', tag: 'tp:test', url: URL_OPS, urgent: false }
		// Si falla no se borra: con una suscripción recién hecha, el servicio de push a veces dice que no existe durante
		// unos segundos (visto con FCM). Las que de verdad ya no existen las borra el primer aviso de verdad
		const r = await sendPush(mine, msg, v, { fetcher, ttlS: 600 }).catch(() => null)
		return r?.ok ? json(200, { ok: true }) : json(502, { error: r?.gone ? 'El navegador ya no tiene esta suscripción: vuelve a activar los avisos' : 'El servicio de avisos del navegador no respondió' })
	}
	// Prueba del camino entero: un evento inventado entra al libro en vivo como si lo mandara QvaPay
	if (url.pathname === '/push/sim' && (env.STAGING === '1' || url.hostname.endsWith('localhost'))) {
		// taker: una oferta de otro que tomaste (se vigila, como al tomarla desde el terminal)
		const offer = body?.taker ? crypto.randomUUID() : undefined
		const e = simEvent(offer ? '00000000-0000-4000-8000-000000000000' : who.uuid.toLowerCase(), String(body?.kind ?? ''), body?.side === 'buy' ? 'buy' : 'sell', now, offer)
		if (!e) return json(400, { error: 'kind: taken | paid | released | left' })
		if (offer) await addWatch(env.DB, endpoint, offer, now)
		const r = await live(env, '/push-sim', e)
		return r?.ok ? json(200, await r.json()) : json(503, { error: 'El libro en vivo no respondió' })
	}
	return json(404, { error: 'no encontrado' })
}
