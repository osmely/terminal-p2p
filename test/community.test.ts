import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { buildDailyPost, dailyPost, setDailyPost, testDailyPost } from '../worker/community.ts'
import { cleanHit, loadHits, saveHit } from '../worker/hits.ts'

function memD1() {
	const db = new DatabaseSync(':memory:')
	for (const f of readdirSync('migrations').sort()) db.exec(readFileSync(`migrations/${f}`, 'utf8'))
	const stmt = (sql: string, args: unknown[] = []) => ({
		bind: (...a: unknown[]) => stmt(sql, a),
		all: async () => ({ results: db.prepare(sql).all(...(args as never[])) as never[] }),
		first: async () => (db.prepare(sql).get(...(args as never[])) ?? null) as never,
		run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...(args as never[])).changes) } }),
	})
	return { db, d1: { prepare: (sql: string) => stmt(sql), batch: async (ss: { run: () => Promise<unknown> }[]) => Promise.all(ss.map((s) => s.run())) } }
}

// 28 de octubre de 2026, 9:05 en Cuba (UTC-4 en verano)
const NINE = Date.parse('2026-10-28T13:05:00Z')
const H = 3600_000

function setup() {
	const { db, d1 } = memD1()
	const rate = (coin: string, t: number, median: number, extra: Partial<{ buy: number; sell: number; count: number }> = {}) =>
		db.prepare('INSERT INTO rates (coin, t, median, median_buy, median_sell, count, window_h) VALUES (?, ?, ?, ?, ?, ?, 24)').run(coin, t, median, extra.buy ?? null, extra.sell ?? null, extra.count ?? 0)
	const last = NINE - 5 * 60_000
	rate('BANK_CUP', last, 1051, { buy: 1045, sell: 1057, count: 432 })
	rate('ETECSA', last, 250)
	rate('CLASICA', last, 1.1)
	rate('BANK_MLC', last, 1.4)
	rate('BANK_CUP', last - 24 * H, 1040)
	rate('BANK_CUP', last - 7 * 24 * H, 1008)
	for (const [cur, r] of [['USD', 845], ['USDT_TRC20', 1075], ['MLC', 698.99], ['ECU', 930]] as const) db.prepare('INSERT INTO informal (day, cur, rate, final, t) VALUES (?, ?, ?, 0, ?)').run('2026-10-28', cur, r, NINE)
	const sent: { chat: string; text: string }[] = []
	let fail = false
	const fetcher = (async (_u: string, init?: RequestInit) => {
		const b = JSON.parse(String(init?.body))
		if (fail) return Response.json({ ok: false, description: 'Bad Gateway' }, { status: 502 })
		sent.push({ chat: String(b.chat_id), text: b.text })
		return Response.json({ ok: true, result: { message_id: sent.length } })
	}) as typeof fetch
	const env = { DB: d1, TELEGRAM_BOT_TOKEN: 'bot', COMMUNITY_CHAT: '-100comunidad', ALERT_CHAT: '-100avisos' }
	return { db, env, sent, fetcher, setFail: (v: boolean) => (fail = v) }
}

test('tasa del día: el mensaje con la mediana, su cambio, los otros mercados y el informal', async () => {
	const s = setup()
	const text = (await buildDailyPost(s.env, NINE))!
	assert.match(text, /Tasa QvaPay hoy<\/b> · miércoles, 28 de octubre/)
	assert.match(text, /<b>1,051 CUP<\/b> · ▲ \+1\.1 % en 24 h · ▲ \+4\.3 % en 7 días/)
	assert.match(text, /Compra 1,045 · 🔴 Venta 1,057/)
	assert.match(text, /432 operaciones en 24 h/)
	assert.match(text, /Saldo ETECSA: 250 CUP[\s\S]*Clásica: 1\.10 USD[\s\S]*MLC: 1\.40 MLC/)
	assert.match(text, /USD 845 · USDT 1,075 · MLC 699 CUP/)
	assert.match(text, /un 24 % por encima del dólar en efectivo/)
	assert.match(text, /app\.terminalp2p\.com\/\?de=tasa/)
	// Con tasas viejas no hay mensaje
	assert.equal(await buildDailyPost(s.env, NINE + 4 * H), null)
})

test('tasa del día: solo encendida, a las 9 de Cuba, una vez al día, y si Telegram falla se reintenta', async () => {
	const s = setup()
	assert.equal(await dailyPost(s.env, NINE, s.fetcher), false) // apagada
	await setDailyPost(s.env.DB, true, NINE)
	assert.equal(await dailyPost(s.env, NINE - H, s.fetcher), false) // a las 8 no
	s.setFail(true)
	assert.equal(await dailyPost(s.env, NINE, s.fetcher), false)
	s.setFail(false)
	assert.equal(await dailyPost(s.env, NINE + 60_000, s.fetcher), true)
	assert.equal(await dailyPost(s.env, NINE + 120_000, s.fetcher), false)
	assert.deepEqual(s.sent.map((m) => m.chat), ['-100comunidad'])
	// La prueba del panel va a tu grupo de avisos, nunca al de la comunidad
	assert.equal((await testDailyPost(s.env, NINE, s.fetcher)).ok, true)
	assert.equal(s.sent.at(-1)!.chat, '-100avisos')
	assert.match(s.sent.at(-1)!.text, /^🧪 <b>Prueba/)
	// Sin grupo de la comunidad configurado (staging) no se publica nunca
	const { COMMUNITY_CHAT: _, ...noGroup } = s.env
	assert.equal(await dailyPost(noGroup, NINE + 86_400_000, s.fetcher), false)
})

test('visitas: solo sumas por día, por parte de la web y por enlace; nada raro entra', async () => {
	const { d1 } = memD1()
	assert.equal(cleanHit({ site: 'app', kind: 'visit', ref: 'Tasa' })?.ref, 'tasa')
	assert.equal(cleanHit({ site: 'site', kind: 'visit', ref: '<script>' })?.ref, '')
	assert.equal(cleanHit({ site: 'site', kind: 'connect' }), null) // conectar solo en el terminal
	assert.equal(cleanHit({ site: 'otro', kind: 'visit' }), null)
	for (const h of [
		{ site: 'site', kind: 'visit', ref: 'grupo' },
		{ site: 'site', kind: 'visit', ref: 'grupo' },
		{ site: 'app', kind: 'visit', ref: 'grupo' },
		{ site: 'app', kind: 'connect', ref: 'grupo' },
		{ site: 'app', kind: 'first', ref: 'grupo' },
		{ site: 'sim', kind: 'visit', ref: '' },
	])
		await saveHit(d1, cleanHit(h)!, NINE)
	const h = await loadHits(d1, 7, NINE)
	assert.deepEqual(h.total, { site: 2, app: 1, connect: 1, first: 1, sim: 1 })
	assert.deepEqual(h.byRef[0], { ref: 'grupo', site: 2, app: 1, connect: 1, first: 1 })
	assert.equal(h.byDay[0].day, '2026-10-28')
})
