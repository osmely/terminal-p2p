// Firmas y utilidades compartidas por las sesiones del simulador y las licencias Pro

export const enc = new TextEncoder()
export const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('')
export const b64url = (s: string) => btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
export const unb64url = (s: string) => atob(s.replace(/-/g, '+').replace(/_/g, '/'))

export async function hmac(key: ArrayBuffer | string, data: string) {
	const raw = typeof key === 'string' ? new Uint8Array(enc.encode(key)) : key
	const k = await crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
	return crypto.subtle.sign('HMAC', k, new Uint8Array(enc.encode(data)))
}

export const sha256 = async (s: string) => hex(await crypto.subtle.digest('SHA-256', new Uint8Array(enc.encode(s))))

// Igualdad en tiempo constante entre dos cadenas de la misma longitud
export function same(a: string, b: string) {
	if (a.length !== b.length) return false
	let diff = 0
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
	return diff === 0
}

// Firma un objeto como «carga.firma» (base64url) y lo comprueba de vuelta
export async function sign(obj: unknown, key: string) {
	const payload = b64url(JSON.stringify(obj))
	return `${payload}.${b64url(String.fromCharCode(...new Uint8Array(await hmac(key, payload))))}`
}
export async function verify<T>(token: string, key: string): Promise<T | null> {
	const [payload, sig] = token.split('.')
	if (!payload || !sig) return null
	if (!same(b64url(String.fromCharCode(...new Uint8Array(await hmac(key, payload)))), sig)) return null
	try {
		return JSON.parse(unb64url(payload)) as T
	} catch {
		return null
	}
}
