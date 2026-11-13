import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { coinOf, isQvaPay, mergePlatform, parseTrade, platformNames, PLATFORM_KEEP_MS, PLATFORM_KEY, readPlatform, SINCE_KEY, syncQvaPayNostr, type Connect, type NostrEvent, type SocketLike } from '../worker/qpnostr.ts'

// Eventos reales, firmados por QvaPay (2026-11-12): una operación de CUP Transferencia, una de la tesorería y una oferta
// de la tesorería
const FX = JSON.parse(readFileSync('test/fixtures/qvapay-nostr.json', 'utf8')) as Record<'tradeCup' | 'tradePlat' | 'orderPlat', NostrEvent>
const clone = (e: NostrEvent): NostrEvent => JSON.parse(JSON.stringify(e))

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

function memKV() {
	const m = new Map<string, string>()
	return { m, get: async (k: string) => m.get(k) ?? null, put: async (k: string, v: string) => void m.set(k, v) }
}

// Un relay falso: contesta a cada REQ con los eventos que casan con «#z» (y «until», si lo hay) y su EOSE
function fakeRelay(events: NostrEvent[], seen: unknown[] = []): Connect {
	return async () => {
		const fns: Record<string, ((ev: { data: unknown }) => void)[]> = {}
		const ws: SocketLike = {
			send(data: string) {
				const m = JSON.parse(data)
				if (m[0] !== 'REQ') return
				const [, sub, f] = m
				seen.push(f)
				const z = f['#z']?.[0]
				const got = events.filter((e) => e.tags.some((t) => t[0] === 'z' && t[1] === z) && (!f.until || e.created_at <= f.until))
				queueMicrotask(() => {
					for (const e of got) for (const fn of fns.message ?? []) fn({ data: JSON.stringify(['EVENT', sub, e]) })
					for (const fn of fns.message ?? []) fn({ data: JSON.stringify(['EOSE', sub]) })
				})
			},
			close() {},
			addEventListener(type: string, fn: (ev: { data: unknown }) => void) {
				;(fns[type] ??= []).push(fn)
			},
		}
		return ws
	}
}

test('QvaPay en Nostr: solo vale lo firmado por su clave', () => {
	assert.equal(isQvaPay(FX.tradeCup), true)
	assert.equal(isQvaPay(FX.orderPlat), true)
	// Cambiar una etiqueta rompe la firma
	const forged = clone(FX.tradeCup)
	forged.tags = forged.tags.map((t) => (t[0] === 'amt' ? ['amt', '9999'] : t))
	assert.equal(isQvaPay(forged), false)
	// Otra clave, aunque diga «y = qvapay»
	assert.equal(isQvaPay({ ...clone(FX.tradeCup), pubkey: 'ab'.repeat(32) }), false)
	assert.equal(isQvaPay(null), false)
})

test('QvaPay en Nostr: cada moneda y método a su mercado del terminal', () => {
	assert.equal(coinOf('CUP', 'bank transfer'), 'BANK_CUP')
	assert.equal(coinOf('CUP', 'etecsa mobile balance'), 'ETECSA')
	assert.equal(coinOf('USD', 'tropical card'), 'BANDECPREPAGO')
	assert.equal(coinOf('BRL', 'pix'), 'PIX')
	assert.equal(coinOf('MLC', 'bank transfer'), 'BANK_MLC')
	assert.equal(coinOf('RUB', 'sberbank'), null)
})

test('QvaPay en Nostr: la operación con su mercado, cantidad, precio y si es de la tesorería', () => {
	const t = parseTrade(FX.tradeCup)
	assert.deepEqual(t, { id: 'ccdfe68c-66be-4055-aa99-8c37a937c8ff', coin: 'BANK_CUP', f: 'CUP', pm: 'bank transfer', side: 'buy', at: 1794537943000, usd: 18.51, fiat: 20361, plat: false })
	assert.equal(parseTrade(FX.tradePlat)?.plat, true)
	assert.equal(parseTrade(FX.tradePlat)?.coin, 'CLASICA')
	// Una oferta no es una operación
	assert.equal(parseTrade(FX.orderPlat), null)
})

test('QvaPay en Nostr: los usuarios de tesorería salen de la versión más reciente de cada oferta', () => {
	assert.deepEqual(platformNames([FX.orderPlat, FX.tradePlat]), ['skymind'])
	// Una versión más nueva de la misma oferta sin la marca manda
	const newer = { ...clone(FX.orderPlat), created_at: FX.orderPlat.created_at + 60, tags: FX.orderPlat.tags.filter((t) => t[0] !== 'maker') }
	assert.deepEqual(platformNames([FX.orderPlat, newer]), [])
	assert.deepEqual(platformNames([newer, FX.orderPlat]), [])
})

test('QvaPay en Nostr: un usuario de tesorería se sigue marcando unos días después de su última oferta', () => {
	const t0 = Date.parse('2026-11-12T20:00:00Z')
	const a = mergePlatform(null, ['skymind'], t0)
	assert.deepEqual(a.users, { skymind: t0 })
	const b = mergePlatform(a, [], t0 + PLATFORM_KEEP_MS - 1)
	assert.deepEqual(Object.keys(b.users), ['skymind'])
	assert.deepEqual(mergePlatform(b, ['otra'], t0 + PLATFORM_KEEP_MS).users, { otra: t0 + PLATFORM_KEEP_MS })
})

test('QvaPay en Nostr: el cron guarda cada operación una vez, la tesorería y desde dónde seguir', async () => {
	const { db, d1 } = memD1()
	const kv = memKV()
	const now = (FX.tradeCup.created_at + 600) * 1000
	const seen: unknown[] = []
	const forged = clone(FX.tradeCup)
	forged.tags = forged.tags.map((t) => (t[0] === 'd' ? ['d', 'falsa'] : t))
	const r = await syncQvaPayNostr(d1, kv, now, fakeRelay([FX.tradeCup, FX.tradePlat, FX.orderPlat, forged], seen))
	// Los dos relays mandan lo mismo: cuenta una vez; la falsificada no entra
	assert.equal(r.trades, 2)
	assert.equal(r.added, 2)
	assert.deepEqual(r.platform, ['skymind'])
	const rows = db.prepare('SELECT id, coin, side, usd, plat FROM qp_nostr_trades ORDER BY usd').all()
	assert.deepEqual(rows.map((x) => ({ ...x })), [
		{ id: parseTrade(FX.tradePlat)!.id, coin: 'CLASICA', side: parseTrade(FX.tradePlat)!.side, usd: 0.99, plat: 1 },
		{ id: 'ccdfe68c-66be-4055-aa99-8c37a937c8ff', coin: 'BANK_CUP', side: 'buy', usd: 18.51, plat: 0 },
	])
	assert.equal(kv.m.get(SINCE_KEY), String(Math.max(FX.tradeCup.created_at, FX.tradePlat.created_at)))
	assert.deepEqual(Object.keys((await readPlatform(kv))!.users), ['skymind'])
	// La siguiente vuelta pide desde ahí (con un margen) y no repite nada
	seen.length = 0
	const again = await syncQvaPayNostr(d1, kv, now + 600_000, fakeRelay([FX.tradeCup, FX.tradePlat, FX.orderPlat], seen))
	assert.equal(again.added, 0)
	const since = (seen.find((f) => (f as { '#z': string[] })['#z'][0] === 'trade') as { since: number }).since
	assert.equal(since, Math.max(FX.tradeCup.created_at, FX.tradePlat.created_at) - 15 * 60)
	assert.ok(kv.m.has(PLATFORM_KEY))
})

test('QvaPay en Nostr: sin ningún relay, la tesorería que se tenía se queda', async () => {
	const { d1 } = memD1()
	const kv = memKV()
	const t0 = Date.parse('2026-11-12T20:00:00Z')
	await kv.put(PLATFORM_KEY, JSON.stringify({ at: t0, users: { skymind: t0 } }))
	const down: Connect = async () => {
		throw new Error('HTTP 502')
	}
	const r = await syncQvaPayNostr(d1, kv, t0 + 600_000, down)
	assert.equal(r.relays.every((x) => !x.ok), true)
	assert.deepEqual((await readPlatform(kv))!.users, { skymind: t0 })
})
