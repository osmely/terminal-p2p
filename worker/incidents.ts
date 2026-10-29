// Incidencias de Pro: alguien usa (o intenta usar) Pro sin tenerlo. El código del terminal es público, así que lo que
// solo decide el navegador se puede burlar; lo que pasa por el servidor, no. Aquí se apunta lo que el servidor ve:
//   · el módulo Pro pedido con una licencia vencida, de una cuenta suspendida o falsa (pro.ts)
//   · avisos del radar pedidos sin Pro (pro.ts)
//   · una copia del módulo en uso: cada copia lleva marcada la licencia con que se descargó y el terminal la manda en
//     cada petición al relé (X-TP-Pro); si la usa otra cuenta, o la misma con los días vencidos, se apunta
// Salen en el panel («Incidencias») y te avisa por Telegram la primera vez. Nada se bloquea solo: decides tú. Quien
// modifique el código para no mandar la marca no aparece aquí

import { notify, tgEsc, type AlertEnv } from './alerts.ts'
import { verify } from './crypto.ts'
import type { D1 } from './rates.ts'
import { readWho, tokenPrint } from './session.ts'

export type IncidentKind = 'module_expired' | 'module_revoked' | 'module_forged' | 'module_shared' | 'module_after_expiry' | 'radar_no_pro'
export const INCIDENT_NAME: Record<IncidentKind, string> = {
	module_expired: 'Pidió el módulo Pro con una licencia vencida',
	module_revoked: 'Pidió el módulo Pro con la cuenta suspendida',
	module_forged: 'Pidió el módulo Pro con una licencia falsa',
	module_shared: 'Usa una copia del módulo Pro de otra cuenta',
	module_after_expiry: 'Sigue usando el módulo Pro con los días vencidos',
	radar_no_pro: 'Pidió avisos del radar sin Pro',
}

const DAY_MS = 86_400_000
// Margen tras vencer: quien tenía el terminal abierto cuando se le acabaron los días no es un infractor
export const GRACE_MS = DAY_MS

export interface IncidentEnv extends AlertEnv {
	DB: D1
}

export interface Incident {
	id: number
	kind: IncidentKind
	username: string | null
	license: string | null
	detail: string | null
	count: number
	first_at: number
	last_at: number
	resolved_at: number | null
}

// Apunta una incidencia: si ya hay una abierta igual, suma una vez más. La primera vez avisa por Telegram
export async function recordIncident(
	env: IncidentEnv,
	i: { kind: IncidentKind; username?: string | null; license?: string | null; detail?: string | null },
	now = Date.now(),
	fetcher: typeof fetch = fetch,
) {
	const username = i.username?.toLowerCase() ?? null
	const license = i.license ?? null
	const r = await env.DB.prepare(
		`INSERT INTO pro_incidents (key, kind, username, license, detail, count, first_at, last_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)
		ON CONFLICT (key) WHERE resolved_at IS NULL DO UPDATE SET count = count + 1, last_at = excluded.last_at, detail = COALESCE(excluded.detail, detail)
		RETURNING count`,
	)
		.bind(`${i.kind}:${username ?? ''}:${license ?? ''}`, i.kind, username, license, i.detail ?? null, now, now)
		.first<{ count: number }>()
	if (r?.count !== 1) return false
	const who = username ? `@${tgEsc(username)}` : 'Alguien sin identificar'
	await notify(env, `🚩 <b>Incidencia de Pro</b>\n${who}: ${INCIDENT_NAME[i.kind].toLowerCase()}.${i.detail ? `\n${tgEsc(i.detail)}` : ''}`, '/admin/pro?view=incidencias', fetcher)
	return true
}

// Cada instancia mira una misma copia del módulo (marca y token) como mucho cada INSPECT_MS: el relé no lee la base en
// cada petición
const INSPECT_MS = 10 * 60_000
const inspected = new Map<string, number>()

// En cada petición al relé que trae la marca del módulo: ¿es de esta cuenta y tiene los días en vigor?
export async function relayIncident(env: IncidentEnv, key: string | undefined, req: Request, now = Date.now(), fetcher: typeof fetch = fetch) {
	const mark = req.headers.get('x-tp-pro')
	const token = req.headers.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim()
	if (!mark || !token || !key) return
	const print = await tokenPrint(token)
	const seen = `${mark.slice(-24)}:${print}`
	if (now - (inspected.get(seen) ?? 0) < INSPECT_MS) return
	inspected.set(seen, now)
	if (inspected.size > 5000) for (const [k, t] of inspected) if (now - t > INSPECT_MS) inspected.delete(k)
	const lic = await verify<{ u: string; n: string; e: number }>(mark, key)
	if (!lic) return
	const who = await readWho(req.headers.get('cookie'), print, key, now)
	if (who && who.username.toLowerCase() !== lic.n.toLowerCase())
		return void (await recordIncident(env, { kind: 'module_shared', username: who.username, license: lic.u, detail: `La copia es de @${lic.n}` }, now, fetcher))
	if (lic.e > now - GRACE_MS) return
	// La marca es de cuando se descargó: si renovó después, sus días de ahora mandan
	const l = await env.DB.prepare('SELECT expires_at, revoked FROM pro_licenses WHERE uuid = ?').bind(lic.u).first<{ expires_at: number; revoked: number }>()
	if (l && !l.revoked && l.expires_at > now - GRACE_MS) return
	await recordIncident(env, { kind: 'module_after_expiry', username: who?.username ?? lic.n, license: lic.u, detail: `Su Pro venció el ${new Date(l?.expires_at ?? lic.e).toISOString().slice(0, 10)}` }, now, fetcher)
}

export const openIncidents = (db: D1, limit = 50, offset = 0) =>
	db
		.prepare('SELECT * FROM pro_incidents WHERE resolved_at IS NULL ORDER BY last_at DESC, id DESC LIMIT ? OFFSET ?')
		.bind(limit, offset)
		.all<Incident>()
		.then((r) => r.results)

export const resolveIncident = (db: D1, id: number, now = Date.now()) => db.prepare('UPDATE pro_incidents SET resolved_at = ? WHERE id = ? AND resolved_at IS NULL').bind(now, id).run()
