// Sesión compartida del terminal y el simulador: al conectar tu cuenta en el terminal, el servidor deja una
// cookie del dominio principal (terminalp2p.com, o staging.terminalp2p.com en staging) con la huella del token,
// firmada con PRO_KEY. Así el simulador sabe quién eres sin otro login. HttpOnly: ninguna página la lee, y
// nunca lleva el token

import { hex, hmac, sign, verify } from './crypto.ts'

export const SESSION_COOKIE = 'tpid'
const SESSION_DAYS = 30
const PRINT = /^[0-9a-f]{64}$/

export const sessionToken = (print: string, key: string, now = Date.now()) => sign({ k: 'sess', p: print, e: now + SESSION_DAYS * 86_400_000 }, key)

// La huella de la sesión, o null. Producción y staging pueden mandar cada una su cookie con el mismo nombre
// (la de terminalp2p.com también llega a staging): vale la que esté firmada con la clave de este entorno
export async function readSession(cookieHeader: string | null, key: string, now = Date.now()): Promise<string | null> {
	for (const v of cookieValues(cookieHeader, SESSION_COOKIE)) {
		const s = await verify<{ k?: string; p?: string; e?: number }>(v, key)
		if (s?.k === 'sess' && typeof s.p === 'string' && PRINT.test(s.p) && (s.e ?? 0) > now) return s.p
	}
	return null
}

// app.terminalp2p.com → terminalp2p.com; app.staging.terminalp2p.com → staging.terminalp2p.com. En localhost
// la cookie se queda en su dominio (el simulador de desarrollo tiene su propio botón de entrar)
const parentDomain = (host: string) => (host === 'localhost' || host.endsWith('.localhost') ? null : host.replace(/^(app|sim|www)\./, ''))

const cookieValues = (header: string | null, name: string) =>
	(header ?? '')
		.split(';')
		.map((p) => p.trim())
		.filter((p) => p.startsWith(`${name}=`))
		.map((p) => p.slice(name.length + 1))

export const sessionCookie = (url: URL, value: string, maxAgeS = SESSION_DAYS * 86_400) => cookie(url, SESSION_COOKIE, value, maxAgeS)

function cookie(url: URL, name: string, value: string, maxAgeS: number) {
	const domain = parentDomain(url.hostname)
	return `${name}=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAgeS}${domain ? `; Domain=${domain}` : ''}${url.protocol === 'https:' ? '; Secure' : ''}`
}

// Quién es de verdad cada huella: cuando el terminal pide su perfil (/user) a través del relé, el Worker ve la
// respuesta de QvaPay con el uuid y el usuario de ese token, y lo deja firmado junto a la huella del mismo token.
// El token sigue sin guardarse: solo se usa para calcular la huella, igual que hace el navegador
export const WHO_COOKIE = 'tpw'
const USERNAME = /^[A-Za-z0-9._-]{1,40}$/
const UUID = /^[0-9a-f-]{36}$/i

export interface Who {
	print: string
	uuid: string
	username: string
}

// La misma huella que calcula el navegador (web/accounts.ts: tokenPrint)
export const tokenPrint = async (token: string) => hex(await hmac('terminalp2p-pro', token))

export async function whoCookie(url: URL, auth: string | null, body: unknown, key: string, now = Date.now()) {
	const token = auth?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim()
	const me = body as { uuid?: unknown; username?: unknown } | null
	if (!token || typeof me?.uuid !== 'string' || typeof me.username !== 'string' || !UUID.test(me.uuid) || !USERNAME.test(me.username)) return null
	return cookie(url, WHO_COOKIE, await whoToken(await tokenPrint(token), me.uuid.toLowerCase(), me.username, key, now), SESSION_DAYS * 86_400)
}

export const whoToken = (print: string, uuid: string, username: string, key: string, now = Date.now()) =>
	sign({ k: 'who', p: print, u: uuid, n: username, e: now + SESSION_DAYS * 86_400_000 }, key)

// La identidad verificada de esta huella, o null (sin cookie, caducada, de otro entorno o de otro token)
export async function readWho(cookieHeader: string | null, print: string, key: string, now = Date.now()): Promise<Who | null> {
	for (const v of cookieValues(cookieHeader, WHO_COOKIE)) {
		const s = await verify<{ k?: string; p?: string; u?: string; n?: string; e?: number }>(v, key)
		if (s?.k === 'who' && s.p === print && typeof s.u === 'string' && typeof s.n === 'string' && (s.e ?? 0) > now) return { print, uuid: s.u, username: s.n }
	}
	return null
}

export const clearWho = (url: URL) => cookie(url, WHO_COOKIE, '', 0)
