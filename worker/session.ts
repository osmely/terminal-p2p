// Sesión compartida del terminal y el simulador: al conectar tu cuenta en el terminal, el servidor deja una
// cookie del dominio principal (terminalp2p.com, o staging.terminalp2p.com en staging) con la huella del token,
// firmada con PRO_KEY. Así el simulador sabe quién eres sin otro login. HttpOnly: ninguna página la lee, y
// nunca lleva el token

import { sign, verify } from './crypto.ts'

export const SESSION_COOKIE = 'tpid'
const SESSION_DAYS = 30
const PRINT = /^[0-9a-f]{64}$/

export const sessionToken = (print: string, key: string, now = Date.now()) => sign({ k: 'sess', p: print, e: now + SESSION_DAYS * 86_400_000 }, key)

// La huella de la sesión, o null. Producción y staging pueden mandar cada una su cookie con el mismo nombre
// (la de terminalp2p.com también llega a staging): vale la que esté firmada con la clave de este entorno
export async function readSession(cookieHeader: string | null, key: string, now = Date.now()): Promise<string | null> {
	const values = (cookieHeader ?? '')
		.split(';')
		.map((p) => p.trim())
		.filter((p) => p.startsWith(`${SESSION_COOKIE}=`))
		.map((p) => p.slice(SESSION_COOKIE.length + 1))
	for (const v of values) {
		const s = await verify<{ k?: string; p?: string; e?: number }>(v, key)
		if (s?.k === 'sess' && typeof s.p === 'string' && PRINT.test(s.p) && (s.e ?? 0) > now) return s.p
	}
	return null
}

// app.terminalp2p.com → terminalp2p.com; app.staging.terminalp2p.com → staging.terminalp2p.com. En localhost
// la cookie se queda en su dominio (el simulador de desarrollo tiene su propio botón de entrar)
const parentDomain = (host: string) => (host === 'localhost' || host.endsWith('.localhost') ? null : host.replace(/^(app|sim|www)\./, ''))

export function sessionCookie(url: URL, value: string, maxAgeS = SESSION_DAYS * 86_400) {
	const domain = parentDomain(url.hostname)
	return `${SESSION_COOKIE}=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAgeS}${domain ? `; Domain=${domain}` : ''}${url.protocol === 'https:' ? '; Secure' : ''}`
}
