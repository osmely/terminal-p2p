// Avisos de Pro por Telegram a cada usuario, con el mismo bot de los avisos del panel. Un bot solo puede escribir
// a quien le escribió antes: el usuario lo conecta desde «Mi cuenta» con un enlace de un solo uso
// (t.me/bot?start=código) y desde entonces recibe la confirmación de cada pago, el aviso de que se le acaban los
// días y cada paso de sus devoluciones. De él solo se guarda el chat; /stop lo borra

import { hex, hmac } from './crypto.ts'
import { tgEsc, type AlertEnv } from './alerts.ts'
import type { D1 } from './rates.ts'

export interface BotEnv extends AlertEnv {
	DB: D1
	PRO_KEY?: string
}

const DAY_MS = 86_400_000
const LINK_MS = 60 * 60_000
const API = (env: BotEnv, method: string) => `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`

export const appUrl = (env: AlertEnv) => (env.STAGING === '1' ? 'https://app.staging.terminalp2p.com' : 'https://app.terminalp2p.com')
const day = (ms: number) => new Date(ms).toLocaleDateString('es', { timeZone: 'America/Havana', day: 'numeric', month: 'short', year: 'numeric' })
const daysText = (n: number) => (n === 1 ? '1 día' : `${n} días`)
const button = (text: string, url: string) => ({ inline_keyboard: [[{ text, url }]] })

// La clave que Telegram manda en cada mensaje al Worker (cabecera X-Telegram-Bot-Api-Secret-Token): sale de
// PRO_KEY, así no hay otro secreto que guardar
export const webhookSecret = async (env: BotEnv) => hex(await hmac(env.PRO_KEY!, 'telegram-webhook')).slice(0, 48)

// El usuario del bot, para el enlace (se pregunta una vez por token y se recuerda mientras viva el Worker)
const botNames = new Map<string, string>()
async function botUsername(env: BotEnv, fetcher: typeof fetch) {
	const token = env.TELEGRAM_BOT_TOKEN!
	if (!botNames.has(token))
		try {
			const j = (await (await fetcher(API(env, 'getMe'), { signal: AbortSignal.timeout(8000) })).json()) as { result?: { username?: string } }
			if (j.result?.username) botNames.set(token, j.result.username)
		} catch {
			return null
		}
	return botNames.get(token) ?? null
}

// Enlace para conectar el chat con esta cuenta (vale una hora y una sola vez)
export async function linkUrl(env: BotEnv, license: string, now: number, fetcher: typeof fetch = fetch) {
	if (!env.TELEGRAM_BOT_TOKEN) return null
	const name = await botUsername(env, fetcher)
	if (!name) return null
	const code = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(18)))).replace(/\+/g, '-').replace(/\//g, '_')
	await env.DB.prepare('DELETE FROM pro_tg_links WHERE created_at < ?').bind(now - LINK_MS).run()
	await env.DB.prepare('INSERT INTO pro_tg_links (code, license, created_at) VALUES (?, ?, ?)').bind(code, license, now).run()
	return `https://t.me/${name}?start=${code}`
}

export const unlink = (db: D1, license: string) => db.prepare('DELETE FROM pro_telegram WHERE license = ?').bind(license).run()
export const linked = async (db: D1, license: string) => !!(await db.prepare('SELECT 1 FROM pro_telegram WHERE license = ?').bind(license).first())

// Un aviso al usuario de esa cuenta, si conectó su chat. Si bloqueó el bot, se olvida su chat. Nunca lanza error
export async function tellUser(env: BotEnv, license: string, text: string, reply_markup?: object, fetcher: typeof fetch = fetch): Promise<boolean> {
	if (!env.TELEGRAM_BOT_TOKEN) return false
	try {
		const row = await env.DB.prepare('SELECT chat_id FROM pro_telegram WHERE license = ?').bind(license).first<{ chat_id: number }>()
		if (!row) return false
		const res = await fetcher(API(env, 'sendMessage'), {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ chat_id: row.chat_id, text, parse_mode: 'HTML', disable_web_page_preview: true, ...(reply_markup ? { reply_markup } : {}) }),
			signal: AbortSignal.timeout(8000),
		})
		if (res.status === 403) await unlink(env.DB, license)
		else if (!res.ok) console.error(`avisos al usuario: Telegram respondió ${res.status}`)
		return res.ok
	} catch (err) {
		console.error(`avisos al usuario: ${(err as Error).message}`)
		return false
	}
}

// ── Los avisos ───────────────────────────────────────────────────────

const openApp = (env: AlertEnv, text = 'Abrir el terminal') => button(text, appUrl(env))

export const paidText = (username: string, days: number, amount: number, until: number) =>
	`✅ <b>Pago confirmado</b>\n\nRecibimos tus ${amount.toLocaleString('en-US')} USD: <b>${daysText(days)} de Pro</b> para @${tgEsc(username)}.\nTienes Pro hasta el <b>${day(until)}</b>.\n\nGracias por confiar en Terminal P2P 🙌`

export const tellPaid = (env: BotEnv, license: string, username: string, days: number, amount: number, until: number, fetcher: typeof fetch = fetch) =>
	tellUser(env, license, paidText(username, days, amount, until), openApp(env), fetcher)

export const tellRefund = (env: BotEnv, r: { license: string; amount: number; payee: string; status: string; decision_note?: string | null; transfer_ref?: string | null }, fetcher: typeof fetch = fetch) => {
	const usd = `${r.amount.toLocaleString('en-US')} USD`
	const text =
		r.status === 'approved'
			? `↩️ <b>Devolución aprobada</b>\n\nVamos a transferirte <b>${usd}</b> a la cuenta de QvaPay @${tgEsc(r.payee)}. Ya se quitaron los días de esa compra.\n\nTe escribimos de nuevo en cuanto esté hecha.`
			: r.status === 'transferred'
				? `💸 <b>Devolución enviada</b>\n\nTe transferimos <b>${usd}</b> a @${tgEsc(r.payee)} en QvaPay.${r.transfer_ref ? `\nReferencia: <code>${tgEsc(r.transfer_ref)}</code>` : ''}\n\nGracias por haber probado Pro.`
				: `<b>Tu devolución no fue aprobada</b>\n\nMotivo: «${tgEsc(r.decision_note ?? '')}»\n\nSi quieres hablarlo, escríbenos en @terminalp2p.`
	return tellUser(env, r.license, text, undefined, fetcher)
}

// Cada día (a media mañana en Cuba): a quien le quedan 3 días o menos, y a quien se le acabaron ayer u hoy. Uno
// por vencimiento: si renueva, el siguiente vencimiento vuelve a avisar
export async function expiryReminders(env: BotEnv, now: number, fetcher: typeof fetch = fetch) {
	if (!env.TELEGRAM_BOT_TOKEN) return 0
	const db = env.DB
	await db.prepare('DELETE FROM pro_tg_links WHERE created_at < ?').bind(now - LINK_MS).run()
	const { results } = await db
		.prepare(
			`SELECT l.uuid, l.username, l.plan, l.expires_at FROM pro_licenses l JOIN pro_telegram t ON t.license = l.uuid
			WHERE l.merged_into IS NULL AND l.revoked = 0 AND l.expires_at > ? AND l.expires_at <= ?`,
		)
		.bind(now - 2 * DAY_MS, now + 3 * DAY_MS)
		.all<{ uuid: string; username: string; plan: string; expires_at: number }>()
	let sent = 0
	for (const l of results) {
		const ended = l.expires_at <= now
		const key = `${ended ? 'exp0' : 'exp3'}:${l.expires_at}`
		if (await db.prepare('SELECT 1 FROM pro_tg_sent WHERE license = ? AND key = ?').bind(l.uuid, key).first()) continue
		const u = `@${tgEsc(l.username)}`
		const trial = l.plan === 'trial'
		const left = Math.ceil((l.expires_at - now) / DAY_MS)
		const text = ended
			? `🔔 <b>${trial ? 'Terminaron tus días gratis de Pro' : 'Tu Pro terminó'}</b>\n\n${u}, se acabaron tus días de Pro. Tu cuenta y tu historial siguen guardados: cuando quieras, compras días desde el terminal y sigues donde lo dejaste.`
			: `⏳ <b>${trial ? `A tus días gratis de Pro ${left === 1 ? 'les queda' : 'les quedan'}` : `A tu Pro ${left === 1 ? 'le queda' : 'le quedan'}`} ${daysText(left)}</b>\n\n${u}, tus días terminan el <b>${day(l.expires_at)}</b>. Nada se cobra solo: si quieres seguir con la orden inteligente y el libro cruzado, ${trial ? 'compra días' : 'renueva'} desde el terminal en «Mi cuenta» → ★ Pro.`
		// Se apunta solo si salió: si Telegram falló, se reintenta en el próximo repaso (sigue dentro de la ventana)
		if (await tellUser(env, l.uuid, text, openApp(env, ended ? 'Comprar días' : trial ? 'Comprar días' : 'Renovar en el terminal'), fetcher)) {
			await db.prepare('INSERT OR IGNORE INTO pro_tg_sent (license, key, at) VALUES (?, ?, ?)').bind(l.uuid, key, now).run()
			sent++
		}
	}
	return sent
}

// ── Radar de Pro ─────────────────────────────────────────────────────
// El terminal encontró (o tomó) una oferta que cumple las reglas del usuario y le avisa al móvil. Llega del
// navegador solo lo que se ve en el libro (nunca el token) y se escribe aquí, escapado: el bot no repite texto libre

export const RADAR_MARKETS: Record<string, { name: string; unit: string }> = {
	BANK_CUP: { name: 'CUP Transferencia', unit: 'CUP' },
	ETECSA: { name: 'Saldo ETECSA', unit: 'CUP' },
	CLASICA: { name: 'Tarjeta Clásica', unit: 'USD' },
	BANK_MLC: { name: 'MLC', unit: 'MLC' },
	ZELLE: { name: 'Zelle', unit: 'USD' },
	BANDECPREPAGO: { name: 'Bandec Prepago', unit: 'USD' },
	TROPIPAY: { name: 'TropiPay', unit: 'EUR' },
	CUPCASH: { name: 'CUP Efectivo', unit: 'CUP' },
	USDCASH: { name: 'USD Efectivo', unit: 'USD' },
	BOLSATM: { name: 'Bolsa TM', unit: 'CUP' },
}

export interface RadarHit {
	kind: 'found' | 'taken'
	offer: string
	coin: string
	// Lo que hace el usuario: compra USD (toma una venta) o vende USD (toma una compra)
	side: 'buy' | 'sell'
	price: number
	// Lo que tomarías con tu regla y, en una oferta por rango, lo que tiene la oferta
	usd: number
	total?: number
	peer: string
	limit: number
	// Tomada comprando: lo que hay que pagar y hasta cuándo
	pay?: number
	payBy?: number
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const amount = (v: unknown, max: number) => {
	const n = Number(v)
	return Number.isFinite(n) && n > 0 && n <= max ? n : null
}

export function cleanRadarHit(b: Record<string, unknown>): RadarHit | null {
	const kind = b.kind === 'found' || b.kind === 'taken' ? b.kind : null
	const side = b.side === 'buy' || b.side === 'sell' ? b.side : null
	const offer = String(b.offer ?? '').toLowerCase()
	const coin = String(b.coin ?? '')
	const peer = String(b.peer ?? '')
	const price = amount(b.price, 1e7)
	const usd = amount(b.usd, 1e5)
	const limit = amount(b.limit, 1e7)
	if (!kind || !side || !UUID.test(offer) || !RADAR_MARKETS[coin] || !/^[\w.-]{1,40}$/.test(peer) || !price || !usd || !limit) return null
	const pay = amount(b.pay, 1e9)
	const payBy = amount(b.payBy, 4e12)
	const total = amount(b.total, 1e5)
	return { kind, offer, coin, side, price, usd, peer, limit, ...(total && total > usd ? { total } : {}), ...(kind === 'taken' && side === 'buy' && pay ? { pay, payBy: payBy ?? undefined } : {}) }
}

const money = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 2 })
const clock = (ms: number) => new Date(ms).toLocaleTimeString('es', { timeZone: 'America/Havana', hour: '2-digit', minute: '2-digit' })

export function radarText(h: RadarHit) {
	const m = RADAR_MARKETS[h.coin]
	const who = `@${tgEsc(h.peer)}`
	const at = `<b>${money(h.price)} ${m.unit}</b> por USD`
	if (h.kind === 'found')
		return `📡 <b>Radar: oferta para ti</b>\n\nPuedes ${h.side === 'buy' ? 'comprar' : 'vender'} <b>${money(h.usd)} USD</b> a ${at} en ${m.name}, ${h.side === 'buy' ? 'de' : 'a'} ${who}${h.total ? ` (oferta por rango de ${money(h.total)} USD)` : ''}.\nTu límite: ${money(h.limit)}.\n\nÁbrela en el terminal para tomarla.`
	const next =
		h.side === 'buy'
			? `Págale <b>${money(h.pay ?? h.usd * h.price)} ${m.unit}</b>${h.payBy ? ` antes de las <b>${clock(h.payBy)}</b> (hora de Cuba)` : ''} y marca el pago en «Mis operaciones».`
			: 'Le mandamos tus datos de pago por el chat. Libera los USD solo cuando veas el pago.'
	return `⚡ <b>Radar: tomé una oferta por ti</b>\n\n${h.side === 'buy' ? 'Compraste' : 'Vendiste'} <b>${money(h.usd)} USD</b> a ${at} ${h.side === 'buy' ? 'a' : 'con'} ${who} en ${m.name}.\n\n${next}`
}

export const radarButton = (env: AlertEnv, h: RadarHit) => (h.kind === 'found' ? button('Abrir la oferta', `${appUrl(env)}/#p2p/${h.offer}`) : openApp(env, 'Ver mis operaciones'))

// ── Lo que el usuario le escribe al bot ──────────────────────────────

interface Update {
	message?: { text?: string; chat?: { id: number; type: string } }
}

const reply = (chat_id: number, text: string, reply_markup?: object) =>
	Response.json({ method: 'sendMessage', chat_id, text, parse_mode: 'HTML', disable_web_page_preview: true, ...(reply_markup ? { reply_markup } : {}) })

export function welcomeText(username: string, expiresAt: number | null, now: number) {
	const status =
		expiresAt && expiresAt > now
			? `📅 Tienes Pro hasta el <b>${day(expiresAt)}</b>.`
			: '📅 Ahora mismo no tienes días de Pro: cuando quieras, los compras desde «Mi cuenta» → ★ Pro en el terminal.'
	return `👋 <b>¡Hola, @${tgEsc(username)}! Tu cuenta quedó conectada.</b>

Desde ahora te escribimos por aquí, y solo cuando hay algo de tu Pro que debes saber:

✅ <b>Pagos</b>: la confirmación en cuanto QvaPay lo acredita y empiezan tus días
⏳ <b>Renovación</b>: un aviso 3 días antes de que se acaben, para que no te quedes sin la orden inteligente
↩️ <b>Devoluciones</b>: cada paso, si alguna vez pides una

Sin publicidad ni mensajes de relleno. ¿Prefieres no recibirlos? Escribe /stop cuando quieras.

${status}`
}

// Telegram manda aquí cada mensaje privado al bot (POST /pro/telegram/webhook). Se responde en la misma
// respuesta, sin otra llamada
export async function botWebhook(req: Request, env: BotEnv, now: number): Promise<Response> {
	if (!env.PRO_KEY || req.headers.get('x-telegram-bot-api-secret-token') !== (await webhookSecret(env))) return new Response('no', { status: 401 })
	const u = (await req.json().catch(() => ({}))) as Update
	const chat = u.message?.chat
	const text = (u.message?.text ?? '').trim()
	// En grupos no contesta (el bot está en tu grupo de avisos y en el de la comunidad)
	if (!chat || chat.type !== 'private') return Response.json({ ok: true })
	const db = env.DB
	const [cmd, arg] = text.split(/\s+/, 2)
	if (/^\/start(@\w+)?$/i.test(cmd ?? '')) {
		if (!arg)
			return reply(
				chat.id,
				'👋 Hola. Soy el bot de <b>Terminal P2P</b>, el terminal para operar en el P2P de QvaPay.\n\nPara recibir aquí los avisos de tu Pro, abre el terminal, entra en «Mi cuenta» → ★ Pro y pulsa «Recibir avisos en Telegram».',
				openApp(env),
			)
		const link = await db.prepare('SELECT license, created_at FROM pro_tg_links WHERE code = ?').bind(arg).first<{ license: string; created_at: number }>()
		await db.prepare('DELETE FROM pro_tg_links WHERE code = ?').bind(arg).run()
		if (!link || now - link.created_at > LINK_MS)
			return reply(chat.id, 'Este enlace ya caducó (dura una hora y sirve una sola vez). Vuelve a pulsar «Recibir avisos en Telegram» en «Mi cuenta» → ★ Pro del terminal.', openApp(env))
		await db
			.prepare('INSERT INTO pro_telegram (license, chat_id, linked_at) VALUES (?, ?, ?) ON CONFLICT (license) DO UPDATE SET chat_id = excluded.chat_id, linked_at = excluded.linked_at')
			.bind(link.license, chat.id, now)
			.run()
		const l = await db.prepare('SELECT username, expires_at, revoked FROM pro_licenses WHERE uuid = ?').bind(link.license).first<{ username: string; expires_at: number; revoked: number }>()
		return reply(chat.id, welcomeText(l?.username ?? link.license.slice(3), l && !l.revoked ? l.expires_at : null, now), openApp(env))
	}
	if (/^\/stop(@\w+)?$/i.test(cmd ?? '')) {
		const gone = await db.prepare('DELETE FROM pro_telegram WHERE chat_id = ?').bind(chat.id).run()
		return reply(
			chat.id,
			gone.meta?.changes
				? 'Listo: ya no te escribiremos más. Si cambias de idea, vuelve a pulsar «Recibir avisos en Telegram» en «Mi cuenta» del terminal.'
				: 'Este chat no tiene ninguna cuenta conectada, así que no te llegará nada.',
		)
	}
	return reply(chat.id, 'Por aquí solo enviamos los avisos de tu Pro y no leemos los mensajes. Si necesitas ayuda, escríbenos en @terminalp2p.')
}

// Desde el panel: que Telegram mande los mensajes del bot a este entorno (el bot es el mismo en staging y
// producción, así que apunta al último donde se pulsó)
export async function connectBot(env: BotEnv, origin: string, fetcher: typeof fetch = fetch) {
	if (!env.TELEGRAM_BOT_TOKEN || !env.PRO_KEY) return { ok: false, description: 'Falta el token del bot' }
	try {
		const res = await fetcher(API(env, 'setWebhook'), {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ url: `${origin}/pro/telegram/webhook`, secret_token: await webhookSecret(env), allowed_updates: ['message'], drop_pending_updates: true }),
			signal: AbortSignal.timeout(8000),
		})
		const j = (await res.json().catch(() => ({}))) as { ok?: boolean; description?: string }
		return { ok: !!j.ok, description: j.description ?? `Telegram respondió ${res.status}` }
	} catch (err) {
		return { ok: false, description: (err as Error).message }
	}
}
