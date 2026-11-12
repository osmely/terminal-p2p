// Avisos de tus ofertas por Telegram (Pro), aunque cierres el terminal. El feed del mercado trae el uuid del dueño de cada
// oferta: el libro en vivo (livebook-do.ts) le pasa aquí cada evento y, si su dueño lo activó, le escribe. Solo ofertas
// públicas (las privadas no salen en el feed). En las de rango QvaPay no avisa del pago de cada parte: solo de lo que te
// toman y de lo que vuelve. Nada se guarda: el servidor solo mira el evento y lo reenvía

import { COINS } from '../src/terminal/market.ts'
import { num } from '../src/qvapay/types.ts'
import { tgEsc } from './alerts.ts'
import { autoPauseNote, type FeedEvent, type Trade } from './livebook.ts'
import type { D1 } from './rates.ts'
import { appUrl, tellUser, type BotEnv } from './userbot.ts'

const COIN = new Map(COINS.map((c) => [c.tick as string, c]))
// Un evento más viejo que esto no avisa (tras un corte del feed llegarían de golpe cosas ya pasadas)
export const NOTICE_MAX_AGE_MS = 15 * 60_000
// Quién lo tiene activado se relee de la base cada tanto (al activarlo, el primer aviso puede tardar esto)
export const WATCH_TTL_MS = 60_000
// Tope por cuenta y hora (un error o una oferta que se edita sin parar no inunda el chat)
export const NOTICES_PER_HOUR = 30

const usdOf = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const priceOf = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: n < 10 ? 4 : 2 })

export interface Notice {
	owner: string
	// Para no avisar dos veces lo mismo (el mismo evento llega por el webhook y por el stream)
	key: string
	text: string
}

// El aviso de un evento para el dueño de la oferta, o null si no hay nada que contarle. «sell»: el dueño vende USD (le
// pagan y libera); «buy»: compra USD (paga y le liberan). trade: lo que tomaron o volvió de una oferta de rango
export function offerNotice(e: FeedEvent, trade: Trade | null, now = Date.now()): Notice | null {
	const d = e?.data
	if (!d?.uuid || !d.owner_uuid || (d.type !== 'buy' && d.type !== 'sell')) return null
	const c = COIN.get(d.coin)
	if (!c) return null
	const at = Date.parse(d.updated_at ?? e.sent_at ?? '') || now
	if (now - at > NOTICE_MAX_AGE_MS) return null
	const sell = d.type === 'sell'
	const amount = num(d.amount)
	const price = amount > 0 ? num(d.receive) / amount : 0
	if (!(price > 0)) return null
	const market = `${tgEsc(c.name)}`
	const at_ = `a <b>${priceOf(price)} ${tgEsc(c.unit)}</b> por USD`
	const next = sell ? 'Espera el pago y libera solo cuando veas el dinero en tu cuenta.' : 'Te toca pagar dentro del plazo: los datos de pago están en el terminal.'
	const say = (kind: string, text: string): Notice => ({ owner: d.owner_uuid!, key: `${d.uuid}:${kind}:${d.updated_at ?? e.sent_at ?? ''}`, text })

	if (e.event.startsWith('p2p.range_')) {
		if (!trade) return null
		const left = num(d.available_amount ?? 0)
		const what = sell ? 'venta' : 'compra'
		if (trade.ops > 0)
			return say(
				'taken',
				`🤝 <b>Te tomaron ${usdOf(trade.usd)} USD</b> de tu ${what} por rango · ${market}\n${at_}. ${
					e.event === 'p2p.range_closed' ? 'Era lo que quedaba: la oferta salió del libro.' : `Quedan ${usdOf(left)} USD publicados.`
				}\n\n${next}`,
			)
		return say('returned', `↩️ <b>Volvieron ${usdOf(trade.usd)} USD a tu ${what} por rango</b> · ${market}\nQuien los tomó no completó la operación. ${tgEsc(autoPauseNote(d.pause))} Precio: ${at_}.`)
	}
	const usd = usdOf(amount)
	if (e.event === 'p2p.applied')
		return say('applied', `🤝 <b>Tomaron tu ${sell ? 'venta' : 'compra'}</b> · ${market}\n${usd} USD ${at_}.\n\n${next}`)
	// Quien marca pagado en tu compra eres tú: solo se avisa en tus ventas
	if (e.event === 'p2p.paid' && sell)
		return say('paid', `💸 <b>Te marcaron pagada tu venta</b> · ${market}\n${usd} USD ${at_}.\n\nComprueba que te llegó el dinero y libera desde el terminal.`)
	// Al completarse una venta, liberaste tú: solo se avisa en tus compras
	if (e.event === 'p2p.completed' && !sell && d.status === 'completed')
		return say('completed', `✅ <b>Te liberaron ${usd} USD</b> · ${market}\nSe completó tu compra ${at_}.`)
	if (e.event === 'p2p.reopened')
		return say('reopened', `↩️ <b>Tu ${sell ? 'venta' : 'compra'} quedó libre otra vez</b> · ${market}\nQuien la tomó la canceló o se le acabó el plazo. ${tgEsc(autoPauseNote(d.pause))} Sigue publicada: ${usd} USD ${at_}.`)
	return null
}

// Quién lo tiene activado ahora: con Pro vigente y el bot de Telegram conectado. uuid de QvaPay → licencia
export async function offerWatchers(db: D1, now: number) {
	const { results } = await db
		.prepare(
			`SELECT a.owner, a.license FROM pro_offer_alerts a
			   JOIN pro_licenses l ON l.uuid = a.license
			   JOIN pro_telegram t ON t.license = a.license
			  WHERE l.merged_into IS NULL AND l.revoked = 0 AND l.expires_at > ?`,
		)
		.bind(now)
		.all<{ owner: string; license: string }>()
	return new Map(results.map((r) => [r.owner.toLowerCase(), r.license]))
}

export const sendNotice = (env: BotEnv, license: string, text: string, fetcher: typeof fetch = fetch) =>
	tellUser(env, license, text, { inline_keyboard: [[{ text: 'Abrir mis operaciones', url: `${appUrl(env)}/#ops` }]] }, fetcher)

export const offerAlertsOn = async (db: D1, license: string) => !!(await db.prepare('SELECT 1 AS x FROM pro_offer_alerts WHERE license = ?').bind(license).first())

export async function setOfferAlerts(db: D1, license: string, owner: string, on: boolean, now: number) {
	if (!on) return void (await db.prepare('DELETE FROM pro_offer_alerts WHERE license = ?').bind(license).run())
	// Un mismo dueño con otra licencia (cambió de usuario) o una licencia con otro uuid: se queda lo de ahora
	await db.batch([
		db.prepare('DELETE FROM pro_offer_alerts WHERE owner = ? OR license = ?').bind(owner.toLowerCase(), license),
		db.prepare('INSERT INTO pro_offer_alerts (owner, license, created_at) VALUES (?, ?, ?)').bind(owner.toLowerCase(), license, now),
	])
}
