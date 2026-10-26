// Interruptores del panel (por ahora, Pro). Se guardan en D1 y cada instancia los recuerda unos segundos:
// al cambiarlos, en medio minuto los ve todo el mundo

import type { D1 } from './rates.ts'

const TTL_MS = 30_000
const cache = new WeakMap<object, { at: number; pro: boolean }>()

// ¿Está Pro encendido? Apagado: ni la web lo anuncia, ni el terminal lo ofrece, ni el simulador pasa de BTC y ETH
export async function proEnabled(db: D1, now = Date.now()) {
	const hit = cache.get(db)
	if (hit && now - hit.at < TTL_MS) return hit.pro
	const row = await db.prepare("SELECT value FROM app_flags WHERE key = 'pro'").first<{ value: string }>()
	const pro = row?.value === '1'
	cache.set(db, { at: now, pro })
	return pro
}

export async function setProEnabled(db: D1, on: boolean, now = Date.now()) {
	await db
		.prepare("INSERT INTO app_flags (key, value, updated_at) VALUES ('pro', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
		.bind(on ? '1' : '0', now)
		.run()
	cache.set(db, { at: now, pro: on })
}
