// Historial de «En vivo» (el panel): cada minuto el cron mira las conexiones del libro en vivo y lo suma al día en Cuba.
// Solo presencia (quién y cuánto, con Pro o no), nunca qué mercados mira cada uno. Se borra a los 90 días

import type { LiveClient } from './livebook.ts'
import { inCuba, type D1 } from './rates.ts'

export const SLOT_MS = 10 * 60_000
const KEEP_MS = 90 * 86_400_000

// AAAA-MM-DD en Cuba
export const cubaDate = (ms: number) => inCuba(ms).toLocaleDateString('en-CA', { timeZone: 'UTC' })

// Lo que hay conectado ahora, por cuenta (una cuenta con dos pestañas cuenta una vez)
export function presence(clients: LiveClient[]) {
	const by = new Map<string, { name: string; pro: boolean }>()
	for (const c of clients) {
		if (!c.u) continue
		const k = c.u.toLowerCase()
		by.set(k, { name: by.get(k)?.name ?? c.u, pro: !!by.get(k)?.pro || c.pro })
	}
	return by
}

// Un minuto del cron: el máximo de su franja y cada cuenta en su día
export async function recordLive(db: D1, clients: LiveClient[], at: number) {
	const by = presence(clients)
	const pro = [...by.values()].filter((x) => x.pro).length
	const slot = Math.floor(at / SLOT_MS) * SLOT_MS
	const day = cubaDate(at)
	await db.batch([
		db
			.prepare('INSERT INTO live_slots (slot, accounts, tabs, pro) VALUES (?, ?, ?, ?) ON CONFLICT(slot) DO UPDATE SET accounts = MAX(accounts, excluded.accounts), tabs = MAX(tabs, excluded.tabs), pro = MAX(pro, excluded.pro)')
			.bind(slot, by.size, clients.length, pro),
		...[...by].map(([account, x]) =>
			db
				.prepare('INSERT INTO live_seen (day, account, name, first_at, last_at, minutes, pro) VALUES (?, ?, ?, ?, ?, 1, ?) ON CONFLICT(day, account) DO UPDATE SET last_at = excluded.last_at, minutes = minutes + 1, pro = MAX(pro, excluded.pro), name = excluded.name')
				.bind(day, account, x.name, at, at, x.pro ? 1 : 0),
		),
	])
}

export async function cleanupLive(db: D1, now: number) {
	await db.prepare('DELETE FROM live_slots WHERE slot < ?').bind(now - KEEP_MS).run()
	await db.prepare('DELETE FROM live_seen WHERE day < ?').bind(cubaDate(now - KEEP_MS)).run()
}

export interface LiveDay {
	slots: { slot: number; accounts: number; tabs: number; pro: number }[]
	seen: { account: string; name: string; first_at: number; last_at: number; minutes: number; pro: number }[]
}

// Un día (en Cuba): sus franjas y quién estuvo. from/to: el día en epoch ms (lo calcula quien llama, con la hora de Cuba)
export async function liveDay(db: D1, day: string, from: number, to: number): Promise<LiveDay> {
	const [slots, seen] = await Promise.all([
		db.prepare('SELECT slot, accounts, tabs, pro FROM live_slots WHERE slot >= ? AND slot < ? ORDER BY slot').bind(from, to).all<LiveDay['slots'][number]>(),
		db.prepare('SELECT account, name, first_at, last_at, minutes, pro FROM live_seen WHERE day = ? ORDER BY first_at').bind(day).all<LiveDay['seen'][number]>(),
	])
	return { slots: slots.results, seen: seen.results }
}
