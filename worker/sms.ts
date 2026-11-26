// Avisos por SMS (OTP Cuba, otp.noxcreation.dev): el teléfono de cada cuenta Pro, verificado con un código por SMS, para
// los avisos urgentes del radar (tomó una oferta: hay que pagar a tiempo). Cada SMS cuesta: con tope por cuenta y día
import { cubaDate } from './livehistory.ts'
import type { D1 } from './rates.ts'

export interface SmsEnv {
	DB: D1
	OTP_API_KEY?: string
	OTP_TOKEN_SECRET?: string
}

const OTP = 'https://otp.noxcreation.dev/api/v2'
// SMS por cuenta y día (códigos y avisos juntos)
export const SMS_DAILY = 10
// Entre un código y el siguiente
const CODE_GAP_MS = 60_000

export const smsOn = (env: Partial<SmsEnv>) => !!(env.OTP_API_KEY && env.OTP_TOKEN_SECRET)

// Un móvil cubano: +53 y 8 dígitos que empiezan por 5 o 6 (con o sin +53, espacios o guiones)
export function cleanPhone(v: unknown): string | null {
	const d = String(v ?? '').replace(/[\s\-().]/g, '')
	const m = /^(?:\+?53)?([56]\d{7})$/.exec(d)
	return m ? `+53${m[1]}` : null
}
// Para enseñarlo sin el número entero: +53 5•••• 567
export const maskPhone = (p: string) => `+53 ${p[3]}•••• ${p.slice(-3)}`

// El SMS va sin tildes (con ellas el teléfono lo manda en otra codificación y caben menos letras) y en 160 caracteres
export const smsPlain = (s: string) =>
	s
		.normalize('NFD')
		.replace(/([nN])\u0303/g, (_, c: string) => (c === 'n' ? 'ñ' : 'Ñ'))
		.replace(/[\u0300-\u036f]/g, '')
		.replace(/[¡¿]/g, '')
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, 160)

interface Row {
	phone: string | null
	verified_at: number | null
	pending: string | null
	hash: string | null
	sent_at: number | null
	day: string | null
	sent: number
}
const rowOf = (db: D1, license: string) => db.prepare('SELECT phone, verified_at, pending, hash, sent_at, day, sent FROM pro_sms WHERE license = ?').bind(license).first<Row>()

// Lo que ve «Mi cuenta»: el número verificado (tapado) y si hay uno esperando su código
export async function smsState(db: D1, license: string) {
	const r = await rowOf(db, license)
	return { phone: r?.phone ? maskPhone(r.phone) : null, pending: r?.pending ? maskPhone(r.pending) : null }
}

// Cuenta un SMS de hoy si queda tope (true) o dice que no (false)
async function spend(db: D1, license: string, now: number) {
	const day = cubaDate(now)
	const r = await db
		.prepare(
			`INSERT INTO pro_sms (license, day, sent) VALUES (?1, ?2, 1)
			 ON CONFLICT (license) DO UPDATE SET day = ?2, sent = CASE WHEN day = ?2 THEN sent + 1 ELSE 1 END
			 WHERE pro_sms.day IS NOT ?2 OR pro_sms.sent < ?3`,
		)
		.bind(license, day, SMS_DAILY)
		.run()
	return !!r.meta?.changes
}

const otp = (env: SmsEnv, path: string, body: unknown, fetcher: typeof fetch, app = true) =>
	fetcher(`${OTP}${path}`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', 'x-token-secret': env.OTP_TOKEN_SECRET!, ...(app ? { 'x-api-key': env.OTP_API_KEY! } : {}) },
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(10_000),
	})
const errOf = async (res: Response) => {
	const j = (await res.json().catch(() => ({}))) as { error?: unknown; attemptsLeft?: unknown }
	return { error: typeof j.error === 'string' ? j.error.slice(0, 160) : '', left: typeof j.attemptsLeft === 'number' ? j.attemptsLeft : null }
}

// Manda el código de verificación al número que puso. null si salió; si no, el porqué para enseñarlo
export async function sendCode(env: SmsEnv, license: string, raw: unknown, now: number, fetcher: typeof fetch = fetch): Promise<string | null> {
	if (!smsOn(env)) return 'Los avisos por SMS no están disponibles ahora mismo'
	const phone = cleanPhone(raw)
	if (!phone) return 'Pon un móvil cubano: +53 y 8 dígitos (por ejemplo +53 5123 4567)'
	const r = await rowOf(env.DB, license)
	if (r?.phone === phone) return 'Ese número ya está verificado'
	if (r?.sent_at && now - r.sent_at < CODE_GAP_MS) return 'Espera un minuto antes de pedir otro código'
	if (!(await spend(env.DB, license, now))) return 'Hoy ya se mandaron muchos SMS a tu cuenta: prueba mañana'
	try {
		const res = await otp(env, '/send', { phoneNumber: phone, expiresInSeconds: 600, digits: 6 }, fetcher)
		if (!res.ok) {
			const e = await errOf(res)
			if (res.status === 429) return 'Ya te mandamos un código hace poco: úsalo o espera unos minutos'
			if (res.status === 400) return 'Ese número no parece válido'
			console.error(`sms: OTP Cuba respondió ${res.status} al mandar el código${e.error ? `: ${e.error}` : ''}`)
			return 'No pudimos mandar el SMS ahora mismo. Prueba más tarde'
		}
		const j = (await res.json().catch(() => ({}))) as { hash?: unknown }
		if (typeof j.hash !== 'string' || !j.hash) return 'No pudimos mandar el SMS ahora mismo. Prueba más tarde'
		await env.DB.prepare('UPDATE pro_sms SET pending = ?, hash = ?, sent_at = ? WHERE license = ?').bind(phone, j.hash, now, license).run()
		return null
	} catch (err) {
		console.error(`sms: ${(err as Error).message}`)
		return 'No pudimos mandar el SMS ahora mismo. Prueba más tarde'
	}
}

// Comprueba el código que escribió: si vale, ese número queda verificado (y es al que van los avisos)
export async function verifyCode(env: SmsEnv, license: string, raw: unknown, now: number, fetcher: typeof fetch = fetch): Promise<string | null> {
	if (!smsOn(env)) return 'Los avisos por SMS no están disponibles ahora mismo'
	const code = String(raw ?? '').replace(/\D/g, '')
	if (code.length < 4 || code.length > 8) return 'Escribe el código que te llegó por SMS'
	const r = await rowOf(env.DB, license)
	if (!r?.pending || !r.hash) return 'Primero pide el código'
	try {
		const res = await otp(env, '/verify', { hash: r.hash, code }, fetcher)
		if (!res.ok) {
			const e = await errOf(res)
			if (res.status === 404) return 'Ese código ya no vale: pide otro'
			if (e.left !== null) return `Código incorrecto. Te quedan ${e.left} ${e.left === 1 ? 'intento' : 'intentos'}`
			if (res.status === 400 && e.error) return e.error
			console.error(`sms: OTP Cuba respondió ${res.status} al verificar${e.error ? `: ${e.error}` : ''}`)
			return 'No pudimos comprobar el código ahora mismo. Prueba más tarde'
		}
		await env.DB.prepare('UPDATE pro_sms SET phone = pending, verified_at = ?, pending = NULL, hash = NULL WHERE license = ?').bind(now, license).run()
		return null
	} catch (err) {
		console.error(`sms: ${(err as Error).message}`)
		return 'No pudimos comprobar el código ahora mismo. Prueba más tarde'
	}
}

export const removeSms = (db: D1, license: string) => db.prepare('DELETE FROM pro_sms WHERE license = ?').bind(license).run()

// Un aviso al número verificado de la cuenta (si tiene y queda tope hoy). OTP Cuba cobra el intento aunque falle
export async function smsUser(env: Partial<SmsEnv> & { DB: D1 }, license: string, text: string, now: number, fetcher: typeof fetch = fetch): Promise<boolean> {
	if (!smsOn(env)) return false
	try {
		const r = await rowOf(env.DB, license)
		if (!r?.phone) return false
		if (!(await spend(env.DB, license, now))) return false
		const res = await otp(env as SmsEnv, '/sms/send', { phoneNumber: r.phone, message: smsPlain(text) }, fetcher, false)
		if (!res.ok) {
			const e = await errOf(res)
			console.error(`sms: OTP Cuba respondió ${res.status} al mandar un aviso${e.error ? `: ${e.error}` : ''}`)
		}
		return res.ok
	} catch (err) {
		console.error(`sms: ${(err as Error).message}`)
		return false
	}
}
