// El bot del dólar: cualquiera mete a @terminalp2p_bot en su grupo (o le escribe por privado) y con /dolar, /mlc,
// /zelle… responde la tasa de ahora a partir de las operaciones cerradas en el P2P de QvaPay, con su movimiento en
// 24 h y un botón al terminal. Solo datos públicos y agregados, los mismos del histórico de la web y de la «Tasa
// QvaPay del día». En los grupos el bot solo ve los comandos (modo privado de Telegram): no lee las conversaciones.
//
// De los grupos se guarda su id, su nombre y cuántas consultas hizo (tabla bot_groups), para saber en cuántos está.
// De los chats privados, nada: solo se suma 1 al contador del día (hits, site 'bot')

import { panel } from './admin.ts'
import { cubaOffset, type D1 } from './rates.ts'
import { cubaDate, latestInformal } from './informal.ts'

export interface Market {
	tick: string
	title: string
	short: string
	unit: string
	digits: number
}

// Lo que se pregunta con cada comando. CUP Transferencia es «el dólar»; los demás, por cada USD de saldo
const MARKETS: Record<string, Market> = {
	BANK_CUP: { tick: 'BANK_CUP', title: '💵 Dólar (saldo QvaPay) a CUP por transferencia', short: '💵 Dólar en CUP', unit: 'CUP', digits: 0 },
	ETECSA: { tick: 'ETECSA', title: '📱 Saldo ETECSA por cada USD de saldo', short: '📱 Saldo ETECSA', unit: 'CUP', digits: 0 },
	CLASICA: { tick: 'CLASICA', title: '💳 Tarjeta Clásica por cada USD de saldo', short: '💳 Clásica', unit: 'USD', digits: 2 },
	BANK_MLC: { tick: 'BANK_MLC', title: '🏦 MLC por cada USD de saldo', short: '🏦 MLC', unit: 'MLC', digits: 2 },
	ZELLE: { tick: 'ZELLE', title: '🇺🇸 Zelle por cada USD de saldo', short: '🇺🇸 Zelle', unit: 'USD', digits: 2 },
	BANDECPREPAGO: { tick: 'BANDECPREPAGO', title: '💳 Bandec Prepago (USD Tropical) por cada USD de saldo', short: '💳 Bandec Prepago', unit: 'USD', digits: 2 },
	TROPIPAY: { tick: 'TROPIPAY', title: '💶 TropiPay por cada USD de saldo', short: '💶 TropiPay', unit: 'EUR', digits: 2 },
}

// Comando → mercado. Varios nombres para lo mismo: cada uno lo pide como le sale
export const COMMANDS: Record<string, string> = {
	dolar: 'BANK_CUP',
	usd: 'BANK_CUP',
	tasa: 'BANK_CUP',
	cup: 'BANK_CUP',
	mlc: 'BANK_MLC',
	zelle: 'ZELLE',
	clasica: 'CLASICA',
	etecsa: 'ETECSA',
	saldo: 'ETECSA',
	tropical: 'BANDECPREPAGO',
	bandec: 'BANDECPREPAGO',
	tropipay: 'TROPIPAY',
}

// El menú de «/» en Telegram (connectBot lo pone al conectar el bot)
export const BOT_MENU = [
	{ command: 'dolar', description: 'El dólar de QvaPay en CUP, ahora' },
	{ command: 'tasas', description: 'Todos los mercados de un vistazo' },
	{ command: 'mlc', description: 'MLC por cada USD de saldo' },
	{ command: 'zelle', description: 'Zelle por cada USD de saldo' },
	{ command: 'clasica', description: 'Tarjeta Clásica por cada USD de saldo' },
	{ command: 'etecsa', description: 'Saldo ETECSA por cada USD' },
	{ command: 'tropical', description: 'Bandec Prepago (USD Tropical)' },
	{ command: 'ayuda', description: 'Qué puedo contestar' },
]

const DAY_MS = 86_400_000
// Una tasa de más de 3 horas no se da como «de ahora»
const FRESH_MS = 3 * 3600_000
// En un grupo, el mismo comando como mucho una vez cada 30 s: si cinco personas piden /dolar a la vez, sale una
const GROUP_GAP_MS = 30_000
// La respuesta de cada mercado se reutiliza 60 s (la tasa cambia cada 10 min)
const CACHE_MS = 60_000

const fmt = (n: number, d = 0) => n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })
const pct = (x: number) => `${x >= 0 ? '▲ +' : '▼ '}${fmt(x * 100, 1)} %`
const clock = (t: number) => new Date(t + cubaOffset(t)).toLocaleTimeString('es', { timeZone: 'UTC', hour: '2-digit', minute: '2-digit' })
const appUrl = (staging: boolean) => (staging ? 'https://app.staging.terminalp2p.com' : 'https://app.terminalp2p.com')

// La línea de las últimas 24 h en 12 tramos de 2 h: ▁ el más bajo, █ el más alto
const BARS = '▁▂▃▄▅▆▇█'
export function sparkline(points: { t: number; v: number }[], now: number) {
	const slots: (number | null)[] = Array(12).fill(null)
	for (const p of points) {
		const i = Math.floor((p.t - (now - DAY_MS)) / (2 * 3600_000))
		if (i >= 0 && i < 12) slots[i] = p.v
	}
	// Un tramo sin dato toma el anterior
	for (let i = 1; i < 12; i++) slots[i] ??= slots[i - 1]
	const vals = slots.filter((v): v is number => v != null)
	if (vals.length < 2) return null
	const lo = Math.min(...vals)
	const hi = Math.max(...vals)
	// Casi plana (menos de un 0.1 %): todo a media altura, para no exagerar un movimiento de nada
	if (hi - lo < hi * 0.001) return slots.map((v) => (v == null ? ' ' : '▄')).join('')
	return slots.map((v) => (v == null ? ' ' : BARS[Math.round(((v - lo) / (hi - lo)) * (BARS.length - 1))])).join('')
}

const medianAt = async (db: D1, coin: string, t: number) =>
	(await db.prepare('SELECT median FROM rates WHERE coin = ? AND t <= ? AND median IS NOT NULL ORDER BY t DESC LIMIT 1').bind(coin, t).first<{ median: number }>())?.median ?? null

// El texto de un mercado, o el aviso de que no hay datos recientes
export async function marketText(db: D1, tick: string, now: number) {
	const m = MARKETS[tick]
	const last = await db
		.prepare('SELECT t, median, median_buy, median_sell, count, window_h FROM rates WHERE coin = ? AND median IS NOT NULL ORDER BY t DESC LIMIT 1')
		.bind(tick)
		.first<{ t: number; median: number; median_buy: number | null; median_sell: number | null; count: number | null; window_h: number | null }>()
	if (!last || now - last.t > FRESH_MS) return `${m.title}\n\nAhora mismo no hay operaciones recientes en este mercado para dar una tasa de fiar.`
	const [d1, d7, series] = await Promise.all([
		medianAt(db, tick, last.t - DAY_MS),
		medianAt(db, tick, last.t - 7 * DAY_MS),
		db.prepare('SELECT t, median AS v FROM rates WHERE coin = ? AND t > ? AND median IS NOT NULL ORDER BY t').bind(tick, now - DAY_MS).all<{ t: number; v: number }>(),
	])
	const lines = [`${m.title}`, '', `<b>${fmt(last.median, m.digits)} ${m.unit}</b>`]
	const moves = [d1 ? `${pct(last.median / d1 - 1)} en 24 h` : '', d7 ? `${pct(last.median / d7 - 1)} en 7 días` : ''].filter(Boolean)
	if (moves.length) lines.push(moves.join(' · '))
	if (last.median_buy && last.median_sell) lines.push(`🟢 Compra ${fmt(last.median_buy, m.digits)} · 🔴 Venta ${fmt(last.median_sell, m.digits)}`)
	const spark = sparkline(series.results, now)
	if (spark) lines.push(`📈 24 h: <code>${spark}</code>`)
	if (last.count && (last.window_h ?? 24) === 24) lines.push(`🔁 ${fmt(last.count)} operaciones en 24 h`)
	if (tick === 'BANK_CUP') {
		const inf = (await latestInformal(db, now)).last
		if (inf?.usd) {
			const gap = last.median / inf.usd - 1
			lines.push(`💵 Efectivo (elTOQUE): ${fmt(inf.usd)} CUP · QvaPay ${fmt(Math.abs(gap) * 100, 0)} % ${gap >= 0 ? 'por encima' : 'por debajo'}`)
		}
	}
	lines.push('', `<i>Mediana de las operaciones cerradas en el P2P de QvaPay · ${clock(last.t)}, hora de Cuba</i>`)
	return lines.join('\n')
}

// Todos los mercados con datos recientes, una línea cada uno
export async function allText(db: D1, now: number) {
	const out = ['📊 <b>Tasas QvaPay ahora</b>', '']
	for (const m of Object.values(MARKETS)) {
		const r = await db.prepare('SELECT t, median FROM rates WHERE coin = ? AND median IS NOT NULL ORDER BY t DESC LIMIT 1').bind(m.tick).first<{ t: number; median: number }>()
		if (r && now - r.t <= FRESH_MS) out.push(`${m.short}: <b>${fmt(r.median, m.digits)} ${m.unit}</b>`)
	}
	if (out.length === 2) out.push('Ahora mismo no hay tasas recientes.')
	out.push('', '<i>Por cada USD de saldo QvaPay, a partir de las operaciones cerradas en el P2P</i>')
	return out.join('\n')
}

export const HELP = `🤖 <b>El bot de Terminal P2P</b>

Te digo a cómo se está pagando el saldo de QvaPay ahora mismo, a partir de las operaciones que de verdad se cerraron en su P2P:

/dolar · el USD en CUP por transferencia
/tasas · todos los mercados de un vistazo
/mlc · /zelle · /clasica · /etecsa · /tropical

👥 Añádeme a tu grupo y cualquiera podrá preguntarme.`

export const JOINED = `👋 ¡Hola! Soy el bot de <b>Terminal P2P</b>.

Escribid /dolar y os digo a cómo se está pagando el saldo de QvaPay ahora mismo, según las operaciones cerradas en su P2P. También /tasas, /mlc, /zelle, /clasica, /etecsa y /tropical.`

const button = (staging: boolean, cmd: string) => ({ inline_keyboard: [[{ text: '📈 Ver el libro en vivo', url: `${appUrl(staging)}/?de=bot-${cmd}` }]] })

// ── Lo que llega por el webhook ──────────────────────────────────────

export interface Chat {
	id: number
	type: string
	title?: string
	// El @ del grupo, solo si es público
	username?: string
}

// «/dolar», «/dolar@terminalp2p_bot» o «/Dólar 5060» → 'dolar'; null si no es un comando para este bot
export function commandOf(text: string, bot: string | null) {
	const m = /^\/([a-záéíóúñ]+)(?:@(\w+))?(?:\s|$)/iu.exec(text.trim())
	if (!m) return null
	if (m[2] && bot && m[2].toLowerCase() !== bot.toLowerCase()) return null
	return m[1].toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
}

const cache = new Map<string, { at: number; text: string }>()
const lastInGroup = new Map<string, number>()

// La respuesta a un comando del bot del dólar, o null si no es uno de los suyos (lo demás lo atiende userbot.ts)
export async function rateCommand(db: D1, chat: Chat, cmd: string, now: number, staging: boolean, replyTo?: number) {
	const tick = COMMANDS[cmd]
	if (!tick && cmd !== 'tasas' && cmd !== 'ayuda' && cmd !== 'help') return null
	const group = chat.type !== 'private'
	if (group) {
		const key = `${chat.id}:${cmd}`
		if (now - (lastInGroup.get(key) ?? 0) < GROUP_GAP_MS) return { skip: true as const }
		lastInGroup.set(key, now)
	}
	const name = tick ?? cmd
	let text: string
	if (cmd === 'ayuda' || cmd === 'help') text = HELP
	else {
		const hit = cache.get(name)
		text = hit && now - hit.at < CACHE_MS ? hit.text : tick ? await marketText(db, tick, now) : await allText(db, now)
		if (!hit || now - hit.at >= CACHE_MS) cache.set(name, { at: now, text })
	}
	await count(db, chat, cmd, now)
	return {
		method: 'sendMessage',
		chat_id: chat.id,
		text,
		parse_mode: 'HTML',
		link_preview_options: { is_disabled: true },
		reply_markup: button(staging, cmd),
		...(group && replyTo ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {}),
	}
}

// Una consulta más: al contador del día y, si es un grupo, a su fila
async function count(db: D1, chat: Chat, cmd: string, now: number) {
	const group = chat.type !== 'private'
	await db
		.prepare("INSERT INTO hits (day, site, kind, ref, n) VALUES (?, 'bot', ?, ?, 1) ON CONFLICT(day, site, kind, ref) DO UPDATE SET n = n + 1")
		.bind(cubaDate(now), group ? 'group' : 'private', cmd)
		.run()
	if (group) await seenGroup(db, chat, now, 1)
}

// El bot entró en un grupo, siguió en él o lo sacaron
export async function seenGroup(db: D1, chat: Chat, now: number, cmds = 0) {
	await db
		.prepare(
			`INSERT INTO bot_groups (chat_id, title, username, kind, added_at, last_at, cmds, left_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
			ON CONFLICT (chat_id) DO UPDATE SET title = COALESCE(excluded.title, title), username = excluded.username, kind = excluded.kind, last_at = excluded.last_at, cmds = cmds + excluded.cmds, left_at = NULL`,
		)
		.bind(chat.id, chat.title?.slice(0, 120) ?? null, chat.username && /^\w{4,32}$/.test(chat.username) ? chat.username : null, chat.type, now, now, cmds)
		.run()
}

// Los miembros de un grupo se le preguntan a Telegram al entrar el bot y, luego, como mucho una vez al día
export async function membersDue(db: D1, chat: Chat, now: number) {
	if (chat.type === 'private') return false
	const r = await db.prepare('SELECT members_at FROM bot_groups WHERE chat_id = ?').bind(chat.id).first<{ members_at: number | null }>()
	return !!r && (!r.members_at || now - r.members_at > DAY_MS)
}
export const saveMembers = (db: D1, chat: Chat, members: number, now: number) =>
	db.prepare('UPDATE bot_groups SET members = ?, members_at = ? WHERE chat_id = ?').bind(members, now, chat.id).run()
export const leftGroup = (db: D1, chat: Chat, now: number) => db.prepare('UPDATE bot_groups SET left_at = ? WHERE chat_id = ?').bind(now, chat.id).run()

// Para el panel de métricas: en cuántos grupos está y cuántas consultas
export async function loadBot(db: D1, days: number, now = Date.now()) {
	const since = cubaDate(now - (days - 1) * DAY_MS)
	const [groups, byCmd, top] = await Promise.all([
		db.prepare('SELECT COUNT(*) AS n, SUM(left_at IS NULL) AS active FROM bot_groups').first<{ n: number; active: number | null }>(),
		db.prepare("SELECT kind, ref, SUM(n) AS n FROM hits WHERE site = 'bot' AND day >= ? GROUP BY kind, ref ORDER BY n DESC").bind(since).all<{ kind: string; ref: string; n: number }>(),
		// Todos: primero donde sigue, por la última consulta
		db
			.prepare('SELECT title, username, members, cmds, added_at, last_at, left_at FROM bot_groups ORDER BY left_at IS NOT NULL, last_at DESC LIMIT 500')
			.all<{ title: string | null; username: string | null; members: number | null; cmds: number; added_at: number; last_at: number; left_at: number | null }>(),
	])
	return { groups: groups?.n ?? 0, active: groups?.active ?? 0, byCmd: byCmd.results, top: top.results }
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
const when = (t: number) => new Date(t + cubaOffset(t)).toLocaleDateString('es', { timeZone: 'UTC', day: 'numeric', month: 'short' })

export function botHtml(b: Awaited<ReturnType<typeof loadBot>>) {
	const total = (kind: string) => b.byCmd.filter((r) => r.kind === kind).reduce((a, r) => a + r.n, 0)
	const cmds = new Map<string, number>()
	for (const r of b.byCmd) cmds.set(r.ref, (cmds.get(r.ref) ?? 0) + r.n)
	const rows = b.top
		.map((g) => {
			const name = g.title ? esc(g.title) : '<span class="note">sin nombre</span>'
			const link = g.username ? `<a href="https://t.me/${esc(g.username)}" target="_blank" rel="noopener">${name}</a> <span class="note">@${esc(g.username)}</span>` : `${name} <span class="note">privado</span>`
			return `<tr><td>${link}${g.left_at ? ' <span class="note">(lo sacaron)</span>' : ''}</td><td class="num">${g.members != null ? g.members.toLocaleString('en-US') : '—'}</td><td class="num">${g.cmds.toLocaleString('en-US')}</td><td>${when(g.added_at)}</td><td>${when(g.last_at)}</td></tr>`
		})
		.join('')
	return `<div class="cards">
<div class="card"><span>Grupos con el bot</span><b>${b.active.toLocaleString('en-US')}</b><small>${b.groups > b.active ? `${b.groups - b.active} lo sacaron` : 'donde sigue'}</small></div>
<div class="card"><span>Consultas en grupos</span><b>${total('group').toLocaleString('en-US')}</b><small>en este periodo</small></div>
<div class="card"><span>Consultas por privado</span><b>${total('private').toLocaleString('en-US')}</b><small>en este periodo</small></div>
<div class="card"><span>Lo más pedido</span><b>${[...cmds].sort((a, c) => c[1] - a[1]).slice(0, 3).map(([c]) => `/${esc(c)}`).join(' ') || '—'}</b></div>
</div>
${panel('Bot de Terminal P2P: grupos', rows ? `<div class="wrap"><table><thead><tr><th>Grupo</th><th>Miembros</th><th>Consultas</th><th>Entró</th><th>Última</th></tr></thead><tbody>${rows}</tbody></table></div>` : '<p class="empty">Aún no está en ningún grupo.</p>', { sub: 'Todos los grupos donde lo metieron, por la última consulta · los públicos se abren tocando su nombre · de los chats privados no se guarda nada', flush: true })}`
}
