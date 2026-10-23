// Relé sin estado hacia la API de QvaPay.
//
// Existe solo porque QvaPay no permite CORS desde otros dominios: el navegador
// no puede leer api.qvapay.com directamente. Cada petición lleva el token de
// quien la hace, se reenvía tal cual y se devuelve la respuesta. No guarda ni
// registra nada: ningún usuario ve datos obtenidos con el token de otro.
//
// Única excepción: los datos PÚBLICOS (promedios, operaciones completadas y
// monedas, que QvaPay da sin cuenta) se cachean 60 s en el borde, y solo cuando la
// petición no lleva token. Así QvaPay recibe una consulta por minuto aunque
// haya muchos usuarios, y no se choca con su límite por IP.

export const RELAY_PREFIX = '/qp'
const UPSTREAM = 'https://api.qvapay.com'
const MAX_BODY = 64 * 1024
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const PUBLIC_TTL_S = 60
const PUBLIC_PATHS = new Set(['/p2p/averages', '/p2p/completed_pairs_average', '/coins'])

// Solo lo que usa la app; cualquier otra ruta se rechaza
const RULES: [method: string, path: RegExp][] = [
	['GET', /^\/user$/],
	['GET', /^\/coins$/],
	['GET', /^\/p2p$/],
	['GET', /^\/p2p\/averages$/],
	['GET', /^\/p2p\/completed_pairs_average$/],
	['GET', new RegExp(`^/p2p/${UUID}$`)],
	['GET', new RegExp(`^/p2p/${UUID}/chat$`)],
	['POST', /^\/p2p\/create$/],
	['POST', new RegExp(`^/p2p/${UUID}/(paid|received|cancel|chat|rate|edit|pause|apply)$`)],
	// Cambiar una calificación ya dada (QvaPay lo permite 72 h)
	['PATCH', new RegExp(`^/p2p/${UUID}/rate$`)],
]

export function allowed(method: string, path: string) {
	return RULES.some(([m, re]) => m === method && re.test(path))
}

// Tipos mínimos para que el relé compile también fuera de Workers (tests en Node)
type WaitUntil = { waitUntil(p: Promise<unknown>): void }
const edgeCache = () => (caches as unknown as { default: Cache }).default

// Solo lo público y sin token se puede compartir entre usuarios
export const cacheable = (req: Request, path: string) =>
	req.method === 'GET' && PUBLIC_PATHS.has(path) && !req.headers.get('authorization')

export async function relay(req: Request, url: URL, ctx?: WaitUntil): Promise<Response> {
	const path = url.pathname.slice(RELAY_PREFIX.length)
	if (!allowed(req.method, path)) return text(404, 'Ruta no permitida')

	// Las escrituras solo desde nuestra propia página
	if (req.method !== 'GET' && req.headers.get('origin') !== url.origin) return text(403, 'Origen no permitido')

	const headers = new Headers({ Accept: 'application/json' })
	for (const h of ['authorization', 'content-type']) {
		const v = req.headers.get(h)
		if (v) headers.set(h, v)
	}

	let body: string | undefined
	if (req.method !== 'GET') {
		body = await req.text()
		if (body.length > MAX_BODY) return text(413, 'Cuerpo demasiado grande')
	}

	const shared = cacheable(req, path) && typeof caches !== 'undefined'
	const cacheKey = new Request(UPSTREAM + path + url.search)
	if (shared) {
		const hit = await edgeCache().match(cacheKey)
		if (hit) return hit
	}

	const upstream = await fetch(UPSTREAM + path + url.search, { method: req.method, headers, body })
	// Solo el cuerpo y el estado: ni cookies ni otras cabeceras de QvaPay
	const out = new Headers({
		'Content-Type': upstream.headers.get('content-type') ?? 'application/json',
		'Cache-Control': shared && upstream.ok ? `public, max-age=${PUBLIC_TTL_S}` : 'no-store',
	})
	const retryAfter = upstream.headers.get('retry-after')
	if (retryAfter) out.set('Retry-After', retryAfter)
	const res = new Response(upstream.body, { status: upstream.status, headers: out })
	if (shared && upstream.ok) {
		const put = edgeCache().put(cacheKey, res.clone())
		if (ctx) ctx.waitUntil(put)
		else await put
	}
	return res
}

function text(status: number, msg: string) {
	return new Response(JSON.stringify({ error: msg }), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } })
}
