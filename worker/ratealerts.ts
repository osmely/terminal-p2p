// Avisos de tasa por Telegram (Pro): «avísame cuando la Tasa QvaPay de CUP Transferencia suba de 1,150». La tasa es la
// que publica QvaPay (la mediana de lo completado en sus últimas 24 h, la misma del mensaje diario), que el cron guarda
// cada 10 minutos: justo después se miran los avisos. Avisa una vez al cruzar y se vuelve a armar cuando la tasa regresa
// al otro lado con un margen (así no escribe cada 10 minutos si se queda rozando el límite)

import { COINS } from '../src/terminal/market.ts'
import { tgEsc } from './alerts.ts'
import type { D1 } from './rates.ts'
import { appUrl, tellUser, type BotEnv } from './userbot.ts'

export const MAX_ALERTS = 5
export const REARM_PCT = 0.005
const COIN = new Map(COINS.map((c) => [c.tick as string, c]))

export interface RateAlert {
	id: number
	coin: string
	dir: 'up' | 'down'
	price: number
	armed: number
	fired_at: number | null
	fired_rate: number | null
}

const num = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: n < 10 ? 4 : 2 })

// Una tasa de más de esto no avisa de nada (si QvaPay deja de publicar, mejor callar que avisar con un dato viejo)
const FRESH_MS = 30 * 60_000

// La tasa de ahora de esos mercados: el último punto de cada uno (por la clave de la tabla: una fila por mercado)
export async function latestRates(db: D1, coins: string[], now: number) {
	const out: Record<string, number> = {}
	for (const coin of coins) {
		const r = await db.prepare('SELECT t, median FROM rates WHERE coin = ? ORDER BY t DESC LIMIT 1').bind(coin).first<{ t: number; median: number | null }>()
		if (r?.median && now - r.t <= FRESH_MS) out[coin] = r.median
	}
	return out
}

export const listAlerts = async (db: D1, license: string) =>
	(await db.prepare('SELECT id, coin, dir, price, armed, fired_at, fired_rate FROM pro_rate_alerts WHERE license = ? ORDER BY id').bind(license).all<RateAlert>()).results

export async function addAlert(db: D1, license: string, b: Record<string, unknown>, now: number) {
	const coin = String(b.coin ?? '')
	const dir = b.dir === 'down' ? 'down' : b.dir === 'up' ? 'up' : null
	const price = Number(b.price)
	if (!COIN.has(coin)) return 'Elige un mercado'
	if (!dir) return 'Elige si avisar cuando suba o cuando baje'
	if (!(price > 0 && price < 1e7)) return 'Pon la tasa a la que quieres el aviso'
	const n = await db.prepare('SELECT COUNT(*) AS n FROM pro_rate_alerts WHERE license = ?').bind(license).first<{ n: number }>()
	if ((n?.n ?? 0) >= MAX_ALERTS) return `Puedes tener hasta ${MAX_ALERTS} avisos: quita alguno antes`
	// Uno que ya se cumple ahora avisaría en el próximo repaso: se pone armado igual (es lo que el usuario pidió)
	await db.prepare('INSERT INTO pro_rate_alerts (license, coin, dir, price, created_at) VALUES (?, ?, ?, ?, ?)').bind(license, coin, dir, price, now).run()
	return null
}

export const deleteAlert = (db: D1, license: string, id: number) => db.prepare('DELETE FROM pro_rate_alerts WHERE license = ? AND id = ?').bind(license, id).run()

export function alertText(a: { coin: string; dir: string; price: number }, rate: number) {
	const c = COIN.get(a.coin)
	const up = a.dir === 'up'
	return `${up ? '📈' : '📉'} <b>Tasa QvaPay · ${tgEsc(c?.name ?? a.coin)}</b>\n\nLa tasa ${up ? 'subió' : 'bajó'} a <b>${num(rate)} ${tgEsc(c?.unit ?? '')}</b> por USD.\nTu aviso: cuando ${up ? 'suba de' : 'baje de'} ${num(a.price)}.\n\nTe aviso de nuevo si vuelve a cruzarlo.`
}

// Tras guardar la tasa nueva: los avisos armados que se cumplen salen (solo a quien tiene Pro ahora), y los que ya
// avisaron se rearman si la tasa regresó al otro lado. Devuelve cuántos avisos salieron
export async function checkAlerts(env: BotEnv & { DB: D1 }, now: number, fetcher: typeof fetch = fetch) {
	const db = env.DB
	const { results } = await db
		.prepare(
			`SELECT a.id, a.license, a.coin, a.dir, a.price, a.armed FROM pro_rate_alerts a
			   JOIN pro_licenses l ON l.uuid = a.license
			  WHERE l.merged_into IS NULL AND l.revoked = 0 AND l.expires_at > ?`,
		)
		.bind(now)
		.all<{ id: number; license: string; coin: string; dir: string; price: number; armed: number }>()
	if (!results.length) return 0
	const rates = await latestRates(db, [...new Set(results.map((a) => a.coin))], now)
	let sent = 0
	for (const a of results) {
		const rate = rates[a.coin]
		if (!(rate > 0)) continue
		const up = a.dir === 'up'
		if (a.armed) {
			if (up ? rate < a.price : rate > a.price) continue
			// Se da por avisado solo si Telegram lo aceptó (sin el bot conectado, sigue esperando)
			if (await tellUser(env, a.license, alertText(a, rate), { inline_keyboard: [[{ text: 'Abrir el terminal', url: appUrl(env) }]] }, fetcher)) {
				await db.prepare('UPDATE pro_rate_alerts SET armed = 0, fired_at = ?, fired_rate = ? WHERE id = ?').bind(now, rate, a.id).run()
				sent++
			}
		} else if (up ? rate < a.price * (1 - REARM_PCT) : rate > a.price * (1 + REARM_PCT)) {
			await db.prepare('UPDATE pro_rate_alerts SET armed = 1 WHERE id = ?').bind(a.id).run()
		}
	}
	return sent
}
