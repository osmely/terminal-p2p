// La «Tasa QvaPay del día»: cada mañana (9:00 en Cuba) el bot publica en el grupo de la comunidad la tasa del
// dólar digital a partir de las operaciones cerradas en el P2P de QvaPay, con el mercado informal de elTOQUE al lado.
// Solo datos públicos y agregados (los mismos del histórico de la web). Se enciende y se prueba desde el panel:
// la prueba va a tu grupo privado de avisos, nunca al de la comunidad

import { cubaOffset, type D1 } from './rates.ts'
import { cubaDate, latestInformal } from './informal.ts'

export interface CommunityEnv {
	DB: D1
	TELEGRAM_BOT_TOKEN?: string
	// El grupo de la comunidad (@terminalp2p). Sin él no se publica nada
	COMMUNITY_CHAT?: string
	// Tu grupo privado de avisos: ahí va la prueba
	ALERT_CHAT?: string
	STAGING?: string
}

// Hora de Cuba a la que sale: el cron de cada minuto lo intenta durante esa hora hasta que sale una vez ese día
export const POST_HOUR = 9
const DAY_MS = 86_400_000
const FRESH_MS = 3 * 3600_000

const FLAG = 'daily_post'
export async function dailyPostOn(db: D1) {
	return (await db.prepare('SELECT value FROM app_flags WHERE key = ?').bind(FLAG).first<{ value: string }>())?.value === '1'
}
export async function setDailyPost(db: D1, on: boolean, now: number) {
	await db
		.prepare('INSERT INTO app_flags (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
		.bind(FLAG, on ? '1' : '0', now)
		.run()
}

interface Row {
	coin: string
	t: number
	median: number | null
	median_buy: number | null
	median_sell: number | null
	count: number | null
	window_h: number | null
}

const fmt = (n: number, d = 0) => n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })
const pct = (x: number) => `${x >= 0 ? '▲ +' : '▼ '}${fmt(x * 100, 1)} %`
const dayName = (t: number) => new Date(t + cubaOffset(t)).toLocaleDateString('es', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long' })

// La mediana de CUP Transferencia que había hace `ago` (el punto guardado más cercano por debajo)
async function medianAt(db: D1, t: number) {
	return (await db.prepare("SELECT median FROM rates WHERE coin = 'BANK_CUP' AND t <= ? AND median IS NOT NULL ORDER BY t DESC LIMIT 1").bind(t).first<{ median: number }>())?.median ?? null
}

// El texto del día, o null si no hay datos recientes (mejor no publicar que publicar una tasa vieja)
export async function buildDailyPost(env: CommunityEnv, now: number) {
	const db = env.DB
	const last = await db.prepare("SELECT MAX(t) AS t FROM rates WHERE coin = 'BANK_CUP'").first<{ t: number | null }>()
	if (!last?.t || now - last.t > FRESH_MS) return null
	const { results } = await db.prepare('SELECT coin, t, median, median_buy, median_sell, count, window_h FROM rates WHERE t = ?').bind(last.t).all<Row>()
	const by = new Map(results.map((r) => [r.coin, r]))
	const cup = by.get('BANK_CUP')
	if (!cup?.median) return null
	const [d1, d7] = await Promise.all([medianAt(db, last.t - DAY_MS), medianAt(db, last.t - 7 * DAY_MS)])
	const inf = (await latestInformal(db, now)).last
	const app = env.STAGING === '1' ? 'https://app.staging.terminalp2p.com' : 'https://app.terminalp2p.com'

	const lines = [`📊 <b>Tasa QvaPay hoy</b> · ${dayName(now)}`, '', 'Dólar digital (saldo QvaPay) a CUP por transferencia, a partir de operaciones cerradas en el P2P en las últimas 24 h:', '']
	const moves = [d1 ? `${pct(cup.median / d1 - 1)} en 24 h` : '', d7 ? `${pct(cup.median / d7 - 1)} en 7 días` : ''].filter(Boolean)
	lines.push(`💵 <b>${fmt(cup.median)} CUP</b>${moves.length ? ` · ${moves.join(' · ')}` : ''}`)
	if (cup.median_buy && cup.median_sell) lines.push(`🟢 Compra ${fmt(cup.median_buy)} · 🔴 Venta ${fmt(cup.median_sell)}`)
	if (cup.count && (cup.window_h ?? 24) === 24) lines.push(`🔁 ${fmt(cup.count)} operaciones en 24 h`)

	// Otros mercados con movimiento: por cada USD de saldo
	const other = [
		['ETECSA', '📱 Saldo ETECSA', (v: number) => `${fmt(v)} CUP`],
		['CLASICA', '💳 Clásica', (v: number) => `${fmt(v, 2)} USD`],
		['BANK_MLC', '🏦 MLC', (v: number) => `${fmt(v, 2)} MLC`],
	] as const
	const others = other.map(([tick, label, f]) => (by.get(tick)?.median ? `${label}: ${f(by.get(tick)!.median!)}` : '')).filter(Boolean)
	if (others.length) lines.push('', 'Por cada USD de saldo:', ...others)

	if (inf?.usd) {
		lines.push('', `Mercado informal (elTOQUE): USD ${fmt(inf.usd)}${inf.usdt ? ` · USDT ${fmt(inf.usdt)}` : ''}${inf.mlc ? ` · MLC ${fmt(inf.mlc)}` : ''} CUP`)
		const gap = cup.median / inf.usd - 1
		lines.push(`➡️ El saldo QvaPay se paga un ${fmt(Math.abs(gap) * 100, 0)} % ${gap >= 0 ? 'por encima' : 'por debajo'} del dólar en efectivo.`)
	}
	lines.push('', `Libro en vivo, histórico y avisos: ${app}/?de=tasa`)
	return lines.join('\n')
}

async function send(env: CommunityEnv, chat: string, text: string, fetcher: typeof fetch) {
	const res = await fetcher(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ chat_id: chat, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true } }),
		signal: AbortSignal.timeout(8000),
	})
	const j = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: { message_id?: number }; description?: string }
	return { ok: !!j.ok, id: j.result?.message_id ?? null, description: j.description ?? `Telegram respondió ${res.status}` }
}

// Lo lanza el cron cada minuto: sale una sola vez por día de Cuba, durante la hora POST_HOUR, si está encendido
export async function dailyPost(env: CommunityEnv, now: number, fetcher: typeof fetch = fetch) {
	if (!env.TELEGRAM_BOT_TOKEN || !env.COMMUNITY_CHAT) return false
	if (new Date(now + cubaOffset(now)).getUTCHours() !== POST_HOUR) return false
	const day = cubaDate(now)
	const db = env.DB
	if (await db.prepare('SELECT 1 FROM daily_posts WHERE day = ?').bind(day).first()) return false
	if (!(await dailyPostOn(db))) return false
	const text = await buildDailyPost(env, now)
	if (!text) return false
	// Se aparta el día antes de mandar: dos minutos seguidos no lo publican dos veces
	const claim = await db.prepare('INSERT OR IGNORE INTO daily_posts (day, chat, message_id, at) VALUES (?, ?, NULL, ?)').bind(day, env.COMMUNITY_CHAT, now).run()
	if (!claim.meta?.changes) return false
	try {
		const r = await send(env, env.COMMUNITY_CHAT, text, fetcher)
		if (!r.ok) throw new Error(r.description)
		await db.prepare('UPDATE daily_posts SET message_id = ? WHERE day = ?').bind(r.id, day).run()
		return true
	} catch (err) {
		// No salió: se suelta el día y el próximo minuto lo vuelve a intentar
		await db.prepare('DELETE FROM daily_posts WHERE day = ? AND message_id IS NULL').bind(day).run()
		console.error(`tasa del día: ${(err as Error).message}`)
		return false
	}
}

// Desde el panel: el texto de hoy a tu grupo privado de avisos, para verlo antes de encenderlo
export async function testDailyPost(env: CommunityEnv, now: number, fetcher: typeof fetch = fetch) {
	if (!env.TELEGRAM_BOT_TOKEN || !env.ALERT_CHAT) return { ok: false, description: 'Falta el token del bot o el chat de avisos' }
	const text = await buildDailyPost(env, now)
	if (!text) return { ok: false, description: 'No hay tasas recientes (de menos de 3 horas) para armar el mensaje' }
	return send(env, env.ALERT_CHAT, `🧪 <b>Prueba: así saldría hoy en el grupo</b>\n\n${text}`, fetcher)
}

export const lastPosts = (db: D1) => db.prepare('SELECT day, message_id, at FROM daily_posts ORDER BY day DESC LIMIT 3').all<{ day: string; message_id: number | null; at: number }>()
