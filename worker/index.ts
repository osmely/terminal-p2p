// Entrada del Worker de Terminal P2P:
//   · landing en terminalp2p.com (public/site) y terminal en app.terminalp2p.com (public/app)
//   · relé sin estado hacia QvaPay (/qp/*)
//   · histórico público de la tasa (/data/rates), alimentado por un cron, con la
//     referencia del mercado informal de elTOQUE (/data/informal)
// Todo lo que depende de la cuenta del usuario corre en su navegador.

import { cubaDate, informalSince, latestInformal, syncInformal } from './informal.ts'
import { collect, isCoin, query, RANGES } from './rates.ts'
import { RELAY_PREFIX, relay } from './relay.ts'

interface Env {
	ASSETS: Fetcher
	DB: D1Database
	// Clave de la API de tasas de elTOQUE (secreto del Worker). Sin ella no hay referencia informal
	ELTOQUE_TOKEN?: string
}

const SECURITY_HEADERS: Record<string, string> = {
	'X-Content-Type-Options': 'nosniff',
	'Referrer-Policy': 'strict-origin-when-cross-origin',
	'X-Frame-Options': 'DENY',
}
// Los datos cambian cada 10 minutos: 5 de caché en el borde bastan y ahorran lecturas de D1
const RATES_TTL_S = 300
const INFORMAL_TTL_S = 600
// La landing reutiliza estos archivos del terminal en vez de duplicarlos
const SHARED = ['/vendor/', '/favicon.svg', '/theme.js']

// app.terminalp2p.com (app.localhost en desarrollo) → terminal; el resto → landing
const folderFor = (host: string) => (host.startsWith('app.') ? 'app' : 'site')

export default {
	async fetch(req, env, ctx) {
		const url = new URL(req.url)

		// www.terminalp2p.com → terminalp2p.com
		if (url.hostname.startsWith('www.')) {
			url.hostname = url.hostname.slice(4)
			return Response.redirect(url.toString(), 301)
		}

		if (url.pathname === RELAY_PREFIX || url.pathname.startsWith(`${RELAY_PREFIX}/`)) return secure(await relay(req, url, ctx))
		if (url.pathname === '/data/rates' && req.method === 'GET') return secure(await rates(req, url, env, ctx))
		if (url.pathname === '/data/informal' && req.method === 'GET') return secure(await informal(url, env, ctx))
		return assets(req, url, env)
	},

	// Cada 10 minutos: guarda los agregados públicos de QvaPay y la tasa informal de elTOQUE
	async scheduled(_event, env) {
		try {
			await collect(env.DB)
		} catch (err) {
			console.error(`histórico: ${(err as Error).message}`)
		}
		if (!env.ELTOQUE_TOKEN) return
		try {
			await syncInformal(env.DB, env.ELTOQUE_TOKEN)
		} catch (err) {
			console.error(`elTOQUE: ${(err as Error).message}`)
		}
	},
} satisfies ExportedHandler<Env>

// Datos públicos y agregados: se cachean 2 minutos en el borde (si hay datos)
async function rates(req: Request, url: URL, env: Env, ctx: ExecutionContext) {
	const coin = url.searchParams.get('coin')
	const days = Number(url.searchParams.get('days') ?? 7)
	if (!isCoin(coin) || !RANGES.includes(days as (typeof RANGES)[number])) return jsonError(400, 'coin o days inválidos')

	const key = new Request(`${url.origin}/data/rates?coin=${coin}&days=${days}`)
	const hit = await caches.default.match(key)
	if (hit) return new Response(hit.body, hit)

	let data
	try {
		data = { ...(await query(env.DB, coin, days)), informal: await informalSince(env.DB, cubaDate(Date.now() - days * 86_400_000)) }
	} catch (err) {
		console.error(`/data/rates: ${(err as Error).message}`)
		return jsonError(503, 'El histórico no está disponible ahora mismo')
	}
	const empty = data.points.length === 0 && data.informal.length === 0
	const res = new Response(JSON.stringify(data), {
		headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': empty ? 'no-store' : `public, max-age=${RATES_TTL_S}` },
	})
	// Una respuesta vacía no se guarda: el primer punto debe verse en cuanto exista
	if (!empty) ctx.waitUntil(caches.default.put(key, res.clone()))
	return res
}

// La tasa informal más reciente (para la landing y la lectura del mercado), cacheada 10 minutos
async function informal(url: URL, env: Env, ctx: ExecutionContext) {
	const key = new Request(`${url.origin}/data/informal`)
	const hit = await caches.default.match(key)
	if (hit) return new Response(hit.body, hit)
	let data
	try {
		data = await latestInformal(env.DB)
	} catch (err) {
		console.error(`/data/informal: ${(err as Error).message}`)
		return jsonError(503, 'La tasa informal no está disponible ahora mismo')
	}
	const res = new Response(JSON.stringify(data), {
		headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': data.last ? `public, max-age=${INFORMAL_TTL_S}` : 'no-store' },
	})
	if (data.last) ctx.waitUntil(caches.default.put(key, res.clone()))
	return res
}

// Sirve el archivo de la carpeta que toca según el dominio
async function assets(req: Request, url: URL, env: Env) {
	let folder = folderFor(url.hostname)
	if (folder === 'site' && SHARED.some((p) => (p.endsWith('/') ? url.pathname.startsWith(p) : url.pathname === p))) folder = 'app'
	const target = new URL(url)
	target.pathname = `/${folder}${url.pathname}`
	const res = await env.ASSETS.fetch(new Request(target, req))
	// Las redirecciones de los assets (p. ej. /index.html → /) no deben mostrar la carpeta
	const loc = res.headers.get('Location')
	if (!loc) return res
	const to = new URL(loc, target)
	if (to.origin === url.origin && to.pathname.startsWith(`/${folder}/`)) to.pathname = to.pathname.slice(folder.length + 1)
	const out = new Response(res.body, res)
	out.headers.set('Location', to.pathname + to.search)
	return out
}

function secure(res: Response) {
	const out = new Response(res.body, res)
	for (const [k, v] of Object.entries(SECURITY_HEADERS)) out.headers.set(k, v)
	return out
}

function jsonError(status: number, error: string) {
	return new Response(JSON.stringify({ error }), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } })
}
