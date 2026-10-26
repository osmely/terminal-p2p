// Interruptores del panel: Pro, y pausar la publicación de ofertas desde el terminal. Se guardan en D1 y cada
// instancia los recuerda unos segundos: al cambiarlos, en medio minuto los ve todo el mundo

import type { D1 } from './rates.ts'

const TTL_MS = 30_000
const cache = new WeakMap<object, Map<string, { at: number; on: boolean }>>()

async function flag(db: D1, key: string, now: number) {
	const mine = cache.get(db) ?? new Map()
	cache.set(db, mine)
	const hit = mine.get(key)
	if (hit && now - hit.at < TTL_MS) return hit.on
	const row = await db.prepare('SELECT value FROM app_flags WHERE key = ?').bind(key).first<{ value: string }>()
	const on = row?.value === '1'
	mine.set(key, { at: now, on })
	return on
}

async function setFlag(db: D1, key: string, on: boolean, now: number) {
	await db
		.prepare('INSERT INTO app_flags (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
		.bind(key, on ? '1' : '0', now)
		.run()
	const mine = cache.get(db) ?? new Map()
	cache.set(db, mine)
	mine.set(key, { at: now, on })
}

// ¿Está Pro encendido? Apagado: ni la web lo anuncia, ni el terminal lo ofrece, ni el simulador pasa de BTC y ETH
export const proEnabled = (db: D1, now = Date.now()) => flag(db, 'pro', now)
export const setProEnabled = (db: D1, on: boolean, now = Date.now()) => setFlag(db, 'pro', on, now)

// Publicar ofertas desde el terminal, en pausa (p. ej. mientras se arregla un fallo). Tomar ofertas y cerrar
// las órdenes en curso siguen funcionando
export const ORDERS_PAUSED_MSG = 'Estamos haciendo ajustes en la plataforma: por ahora no se pueden publicar ofertas desde el terminal. Pronto se va a restablecer.'
export const ordersPaused = (db: D1, now = Date.now()) => flag(db, 'orders_paused', now)
export const setOrdersPaused = (db: D1, on: boolean, now = Date.now()) => setFlag(db, 'orders_paused', on, now)
