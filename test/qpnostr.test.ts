import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { verifyEvent } from 'nostr-tools/pure'
import { isQvaPay, mergePlatform, nostrSyncOn, platformNames, PLATFORM_KEEP_MS, PLATFORM_KEY, readPlatform, syncQvaPayNostr, type Connect, type NostrEvent, type SocketLike } from '../worker/qpnostr.ts'

// Eventos reales, firmados por QvaPay (2026-11-12): una operación de CUP Transferencia, una de la tesorería y una oferta
// de la tesorería
const FX = JSON.parse(readFileSync('test/fixtures/qvapay-nostr.json', 'utf8')) as Record<'tradeCup' | 'tradePlat' | 'orderPlat', NostrEvent>
const clone = (e: NostrEvent): NostrEvent => JSON.parse(JSON.stringify(e))

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

test('QvaPay en Nostr: el cron solo pide las ofertas abiertas y guarda la tesorería (las operaciones ya no)', async () => {
	const kv = memKV()
	const now = (FX.tradeCup.created_at + 600) * 1000
	const seen: unknown[] = []
	const forged = clone(FX.orderPlat)
	forged.tags = forged.tags.map((t) => (t[0] === 'name' ? ['name', 'intruso'] : t))
	const r = await syncQvaPayNostr(kv, now, fakeRelay([FX.tradeCup, FX.tradePlat, FX.orderPlat, forged], seen))
	// La falsificada no entra; de los dos relays sale lo mismo
	assert.deepEqual(r.platform, ['skymind'])
	assert.deepEqual(Object.keys((await readPlatform(kv))!.users), ['skymind'])
	assert.ok(seen.length > 0 && seen.every((f) => (f as { '#z': string[] })['#z'][0] === 'order'))
	assert.ok(kv.m.has(PLATFORM_KEY))
})

test('QvaPay en Nostr: sin ningún relay, la tesorería que se tenía se queda', async () => {
	const kv = memKV()
	const t0 = Date.parse('2026-11-12T20:00:00Z')
	await kv.put(PLATFORM_KEY, JSON.stringify({ at: t0, users: { skymind: t0 } }))
	const down: Connect = async () => {
		throw new Error('HTTP 502')
	}
	const r = await syncQvaPayNostr(kv, t0 + 600_000, down)
	assert.equal(r.relays.every((x) => !x.ok), true)
	assert.deepEqual((await readPlatform(kv))!.users, { skymind: t0 })
})

test('QvaPay en Nostr: cada firma se verifica una sola vez, aunque llegue de los dos relays o en la vuelta siguiente', async () => {
	const kv = memKV()
	const now = (FX.tradeCup.created_at + 600) * 1000
	let checks = 0
	const verify: typeof verifyEvent = (e) => (checks++, verifyEvent(e))
	// Misma id que una de verdad pero otro contenido: no pasa, y sin gastar una verificación de firma. Los dos relays
	// mandan la misma oferta: se verifica una vez
	const forged = clone(FX.orderPlat)
	forged.tags = forged.tags.map((t) => (t[0] === 'd' ? ['d', 'falsa'] : t))
	const first = await syncQvaPayNostr(kv, now, fakeRelay([FX.orderPlat, forged]), verify)
	assert.deepEqual(first.platform, ['skymind'])
	assert.equal(checks, 1)
	// La vuelta siguiente trae lo mismo: nada que verificar, el mismo resultado
	checks = 0
	const again = await syncQvaPayNostr(kv, now + 600_000, fakeRelay([FX.tradeCup, FX.tradePlat, FX.orderPlat]), verify)
	assert.equal(checks, 0)
	assert.deepEqual(again.platform, ['skymind'])
	// Una oferta ya vista con el nombre cambiado (misma id y firma) no cuela
	const tampered = clone(FX.orderPlat)
	tampered.tags = tampered.tags.map((t) => (t[0] === 'name' ? ['name', 'intruso'] : t))
	const third = await syncQvaPayNostr(kv, now + 1_200_000, fakeRelay([FX.tradeCup, FX.tradePlat, tampered]), verify)
	assert.deepEqual(third.platform, [])
	assert.equal(checks, 0)
	// Solo se recuerda lo de la última vuelta: lo que dejó de verse se vuelve a verificar si reaparece
	await syncQvaPayNostr(kv, now + 1_800_000, fakeRelay([FX.tradeCup, FX.tradePlat, FX.orderPlat]), verify)
	assert.equal(checks, 1)
})

test('QvaPay en Nostr: staging no lo sincroniza (los mismos relays ya los lee producción)', () => {
	assert.equal(nostrSyncOn({ PRO: {} }), true)
	assert.equal(nostrSyncOn({ PRO: {}, STAGING: '1' }), false)
	assert.equal(nostrSyncOn({}), false)
})
