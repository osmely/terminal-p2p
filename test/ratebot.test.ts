import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { allText, botHtml, commandOf, loadBot, marketText, sparkline } from '../worker/ratebot.ts'
import { botWebhook, connectBot, webhookSecret } from '../worker/userbot.ts'

function memD1() {
	const db = new DatabaseSync(':memory:', { limits: { compoundSelect: 5 } })
	for (const f of readdirSync('migrations').sort()) db.exec(readFileSync(`migrations/${f}`, 'utf8'))
	const stmt = (sql: string, args: unknown[] = []) => ({
		bind: (...a: unknown[]) => stmt(sql, a),
		all: async () => ({ results: db.prepare(sql).all(...(args as never[])) as never[] }),
		first: async () => (db.prepare(sql).get(...(args as never[])) ?? null) as never,
		run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...(args as never[])).changes) } }),
	})
	return { db, d1: { prepare: (sql: string) => stmt(sql), batch: async (ss: { run: () => Promise<unknown> }[]) => Promise.all(ss.map((s) => s.run())) } }
}

// 2 de noviembre de 2026, 21:35 en Cuba (UTC-4: este invierno Cuba no atrasó la hora)
const NOW = Date.parse('2026-11-03T01:35:00Z')
const H = 3600_000

function setup() {
	const { db, d1 } = memD1()
	const rate = (coin: string, t: number, median: number, extra: Partial<{ buy: number; sell: number; count: number }> = {}) =>
		db.prepare('INSERT INTO rates (coin, t, median, median_buy, median_sell, count, window_h) VALUES (?, ?, ?, ?, ?, ?, 24)').run(coin, t, median, extra.buy ?? null, extra.sell ?? null, extra.count ?? 0)
	const last = NOW - 5 * 60_000
	// 24 h subiendo de 1,100 a 1,122 (un punto cada 2 h) y la última, con compra/venta y operaciones
	for (let i = 12; i >= 1; i--) rate('BANK_CUP', last - i * 2 * H, 1100 + (12 - i) * 2)
	rate('BANK_CUP', last, 1122, { buy: 1118, sell: 1126, count: 335 })
	rate('BANK_CUP', last - 7 * 24 * H, 1090)
	rate('ZELLE', last, 1.04)
	// MLC sin datos recientes
	rate('BANK_MLC', last - 5 * H, 1.4)
	db.prepare('INSERT INTO informal (day, cur, rate, final, t) VALUES (?, ?, ?, 0, ?)').run('2026-11-02', 'USD', 1050, NOW)
	const env = { DB: d1, PRO_KEY: 'clave', TELEGRAM_BOT_TOKEN: 'bot' }
	// Telegram: cuántos miembros tiene cada grupo (se apunta cada pregunta)
	const asked: string[] = []
	const fetcher = (async (url: string) => {
		asked.push(String(url).replace(/^.*\/getChatMemberCount\?chat_id=/, ''))
		return Response.json({ ok: true, result: 1234 })
	}) as typeof fetch
	let at = NOW
	const send = async (update: unknown) => {
		const res = await botWebhook(
			new Request('https://app.terminalp2p.com/pro/telegram/webhook', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': await webhookSecret(env) },
				body: JSON.stringify(update),
			}),
			env,
			at,
			fetcher,
		)
		return (await res.json()) as Record<string, unknown>
	}
	return { db, d1, env, send, asked, tick: (ms: number) => (at += ms) }
}

const group = (id: number, title = 'Cambio Habana') => ({ id, type: 'supergroup', title })

test('comandos: con o sin @bot, con tilde o mayúsculas; lo que no empieza por / no lo es', () => {
	assert.equal(commandOf('/dolar', null), 'dolar')
	assert.equal(commandOf('/Dólar@terminalp2p_bot', 'terminalp2p_bot'), 'dolar')
	assert.equal(commandOf('/mlc 500', null), 'mlc')
	assert.equal(commandOf('/dolar@otro_bot', 'terminalp2p_bot'), null)
	assert.equal(commandOf('a cómo está el dolar', null), null)
})

test('la línea de 24 h: de ▁ a █ cuando sube; plana si casi no se mueve; sin datos, nada', () => {
	const pts = Array.from({ length: 12 }, (_, i) => ({ t: NOW - 23 * H + i * 2 * H, v: 1100 + i * 2 }))
	assert.equal(sparkline(pts, NOW), '▁▂▂▃▄▄▅▅▆▇▇█')
	assert.equal(sparkline(pts.map((p) => ({ ...p, v: 1100 })), NOW), '▄▄▄▄▄▄▄▄▄▄▄▄')
	assert.equal(sparkline([], NOW), null)
})

test('el dólar: tasa, movimiento, compra/venta, la línea, operaciones y el efectivo de elTOQUE', async () => {
	const s = setup()
	const text = await marketText(s.d1, 'BANK_CUP', NOW)
	assert.match(text, /<b>1,122 CUP<\/b>/)
	assert.match(text, /▲ \+2\.0 % en 24 h · ▲ \+2\.9 % en 7 días/)
	assert.match(text, /🟢 Compra 1,118 · 🔴 Venta 1,126/)
	assert.match(text, /📈 24 h: <code>[▁-█]{12}<\/code>/)
	assert.match(text, /🔁 335 operaciones en 24 h/)
	assert.match(text, /Efectivo \(elTOQUE\): 1,050 CUP · QvaPay 7 % por encima/)
	assert.match(text, /21:30, hora de Cuba/)
	// Un mercado sin operaciones recientes no da una tasa vieja como de ahora
	assert.match(await marketText(s.d1, 'BANK_MLC', NOW), /no hay operaciones recientes/)
	// Todos: solo los que tienen datos recientes
	const all = await allText(s.d1, NOW)
	assert.match(all, /💵 Dólar en CUP: <b>1,122 CUP<\/b>/)
	assert.match(all, /🇺🇸 Zelle: <b>1\.04 USD<\/b>/)
	assert.doesNotMatch(all, /MLC/)
})

test('en un grupo: contesta citando el mensaje, con el botón al terminal; el mismo comando seguido, una sola vez', async () => {
	const s = setup()
	const r = await s.send({ message: { message_id: 7, text: '/dolar@terminalp2p_bot', chat: group(-1001) } })
	assert.equal(r.method, 'sendMessage')
	assert.equal(r.chat_id, -1001)
	assert.match(String(r.text), /1,122 CUP/)
	assert.deepEqual(r.reply_parameters, { message_id: 7, allow_sending_without_reply: true })
	assert.match(JSON.stringify(r.reply_markup), /app\.terminalp2p\.com\/\?de=bot-dolar/)
	// En los grupos Telegram no deja botones de mini app
	assert.doesNotMatch(JSON.stringify(r.reply_markup), /web_app/)
	// Otro pide /dolar a los 10 s: no se repite. /zelle sí sale
	assert.deepEqual(await s.send({ message: { message_id: 8, text: '/dolar', chat: group(-1001) } }), { ok: true })
	assert.match(String((await s.send({ message: { message_id: 9, text: '/zelle', chat: group(-1001) } })).text), /1\.04 USD/)
	// Lo que no es un comando suyo, ni se contesta
	assert.deepEqual(await s.send({ message: { message_id: 10, text: '/start', chat: group(-1001) } }), { ok: true })
	// Se cuenta: el grupo, sus consultas y el contador del día
	const g = s.db.prepare('SELECT title, cmds, left_at FROM bot_groups WHERE chat_id = -1001').get() as { title: string; cmds: number; left_at: number | null }
	assert.deepEqual({ ...g }, { title: 'Cambio Habana', cmds: 2, left_at: null })
	const b = await loadBot(s.d1, 7, NOW)
	assert.equal(b.active, 1)
	assert.deepEqual(b.byCmd.map((x) => [x.kind, x.ref, x.n]).sort(), [['group', 'dolar', 1], ['group', 'zelle', 1]])
	assert.match(botHtml(b), /Cambio Habana/)
})

test('lo meten en un grupo: saluda y queda apuntado; si lo sacan, también', async () => {
	const s = setup()
	const hi = await s.send({ my_chat_member: { chat: group(-2002, 'Cripto Cuba'), new_chat_member: { status: 'member' } } })
	assert.equal(hi.chat_id, -2002)
	assert.match(String(hi.text), /Escribid \/dolar/)
	assert.equal((await loadBot(s.d1, 7, NOW)).active, 1)
	await s.send({ my_chat_member: { chat: group(-2002, 'Cripto Cuba'), new_chat_member: { status: 'kicked' } } })
	const b = await loadBot(s.d1, 7, NOW)
	assert.deepEqual([b.groups, b.active], [1, 0])
})

test('por privado: /dolar contesta sin citar ni apuntar el chat; /start sin código explica los comandos', async () => {
	const s = setup()
	const r = await s.send({ message: { message_id: 3, text: '/tasas', chat: { id: 55, type: 'private' } } })
	assert.match(String(r.text), /Tasas QvaPay ahora/)
	assert.equal(r.reply_parameters, undefined)
	// Por privado: el libro en la mini app y, debajo, el terminal
	const z = (await s.send({ message: { message_id: 6, text: '/zelle', chat: { id: 55, type: 'private' } } })).reply_markup as { inline_keyboard: { text: string; url?: string; web_app?: { url: string } }[][] }
	assert.equal(z.inline_keyboard[0][0].web_app?.url, 'https://terminalp2p.com/mini/?tg&coin=ZELLE')
	assert.equal(z.inline_keyboard[1][0].url, 'https://app.terminalp2p.com/?de=bot-zelle')
	assert.equal((r.reply_markup as typeof z).inline_keyboard[0][0].web_app?.url, 'https://terminalp2p.com/mini/?tg')
	assert.equal((s.db.prepare('SELECT COUNT(*) AS n FROM bot_groups').get() as { n: number }).n, 0)
	const start = await s.send({ message: { message_id: 4, text: '/start', chat: { id: 55, type: 'private' } } })
	assert.match(String(start.text), /\/dolar · el USD en CUP/)
	assert.match(JSON.stringify(start.reply_markup), /"web_app":\{"url":"https:\/\/terminalp2p\.com\/mini\/\?tg"\}/)
	assert.match(String((await s.send({ message: { message_id: 5, text: 'hola', chat: { id: 55, type: 'private' } } })).text), /solo contesto comandos/)
})

test('la lista de grupos del panel: todos, los públicos con su enlace y cuántos miembros tienen (preguntado como mucho una vez al día)', async () => {
	const s = setup()
	// Lo meten en un grupo público: se pregunta cuántos miembros tiene
	await s.send({ my_chat_member: { chat: { id: -3003, type: 'supergroup', title: 'Cambio <MLC>', username: 'cambiomlc' }, new_chat_member: { status: 'member' } } })
	assert.deepEqual(s.asked, ['-3003'])
	// Las consultas del mismo día no vuelven a preguntar; al día siguiente, sí
	await s.send({ message: { message_id: 1, text: '/tasas', chat: { id: -3003, type: 'supergroup', title: 'Cambio <MLC>', username: 'cambiomlc' } } })
	assert.equal(s.asked.length, 1)
	s.tick(25 * H)
	await s.send({ message: { message_id: 2, text: '/tasas', chat: { id: -3003, type: 'supergroup', title: 'Cambio <MLC>', username: 'cambiomlc' } } })
	assert.equal(s.asked.length, 2)
	// Uno privado (sin @) y otro que lo sacó: salen todos, los que siguen primero
	await s.send({ my_chat_member: { chat: group(-4004, 'Familia'), new_chat_member: { status: 'member' } } })
	await s.send({ my_chat_member: { chat: group(-5005, 'Viejo'), new_chat_member: { status: 'member' } } })
	await s.send({ my_chat_member: { chat: group(-5005, 'Viejo'), new_chat_member: { status: 'left' } } })
	const b = await loadBot(s.d1, 7, NOW + 26 * H)
	assert.deepEqual(b.top.map((g) => [g.title, g.username, g.members]), [['Familia', null, 1234], ['Cambio <MLC>', 'cambiomlc', 1234], ['Viejo', null, 1234]])
	const html = botHtml(b)
	assert.match(html, /<a href="https:\/\/t\.me\/cambiomlc"[^>]*>Cambio &#60;MLC&#62;<\/a> <span class="note">@cambiomlc<\/span>/)
	assert.match(html, /Familia <span class="note">privado<\/span>/)
	assert.match(html, /Viejo <span class="note">privado<\/span> <span class="note">\(lo sacaron\)<\/span>/)
	assert.match(html, /Bot de Terminal P2P: grupos/)
})

test('conectar el bot: el webhook, el menú de comandos y el botón «Libro» de la mini app (la de staging, en staging)', async () => {
	const calls: { method: string; body: Record<string, unknown> }[] = []
	const fetcher = (async (url: string, init: RequestInit) => {
		calls.push({ method: String(url).split('/').pop()!, body: JSON.parse(String(init.body)) })
		return Response.json({ ok: true })
	}) as typeof fetch
	const env = { DB: memD1().d1, PRO_KEY: 'clave', TELEGRAM_BOT_TOKEN: 'bot', STAGING: '1' }
	assert.equal((await connectBot(env, 'https://app.staging.terminalp2p.com', fetcher)).ok, true)
	assert.deepEqual(calls.map((c) => c.method).sort(), ['setChatMenuButton', 'setMyCommands', 'setWebhook'])
	assert.deepEqual(calls.find((c) => c.method === 'setChatMenuButton')!.body, { menu_button: { type: 'web_app', text: 'Libro', web_app: { url: 'https://staging.terminalp2p.com/mini/?tg' } } })
})
