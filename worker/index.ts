// Entrada del Worker de Terminal P2P:
//   · landing en terminalp2p.com (public/site) y terminal en app.terminalp2p.com (public/app)
//   · relé sin estado hacia QvaPay (/qp/*)
//   · histórico público de la tasa (/data/rates), alimentado por un cron, con la
//     referencia del mercado informal de elTOQUE (/data/informal)
//   · métricas anónimas de las acciones del P2P y su panel privado (/admin/metrics)
//   · simulador de trading con dinero ficticio en sim.terminalp2p.com (public/sim y worker/sim.ts)
// Todo lo que depende de la cuenta del usuario corre en su navegador.

import { cubaDate, informalSince, latestInformal, syncInformal } from './informal.ts'
import { authorized, clientEvent, loadSummary, panelHtml, relayEvent, saveEvent } from './metrics.ts'
import { collect, isCoin, query, RANGES } from './rates.ts'
import { RELAY_PREFIX, relay } from './relay.ts'
import { adminPage, askKey } from './admin.ts'
import { backupPro, proAdmin, proApi, reconcile, settlePending, type ProEnv } from './pro.ts'
import { simAdmin, simApi, simCron, type SimEnv } from './sim.ts'
import { proEnabled } from './flags.ts'

interface Env extends Omit<SimEnv, 'DB'>, Omit<ProEnv, 'DB' | 'METRICS_KEY'> {
	ASSETS: Fetcher
	DB: D1Database
	// Clave de la API de tasas de elTOQUE (secreto del Worker). Sin ella no hay referencia informal
	ELTOQUE_TOKEN?: string
	// Clave del panel de métricas (secreto). Sin ella el panel no existe
	METRICS_KEY?: string
	// Clave de las huellas de las métricas (secreto). Sin ella no se registra ningún evento
	METRICS_SALT?: string
	// Topes por IP del limitador de Cloudflare (la IP es solo la llave del contador; no se guarda)
	EVENT_LIMIT?: RateLimiter
	PANEL_LIMIT?: RateLimiter
	SIM_LIMIT?: RateLimiter
	PRO_LIMIT?: RateLimiter
	// «1» en el entorno de staging (wrangler deploy --env staging)
	STAGING?: string
}

interface RateLimiter {
	limit(opts: { key: string }): Promise<{ success: boolean }>
}

// true si la petición pasa el tope; sin limitador configurado no se limita
async function underLimit(limiter: RateLimiter | undefined, req: Request) {
	if (!limiter) return true
	const { success } = await limiter.limit({ key: req.headers.get('cf-connecting-ip') ?? 'sin-ip' })
	return success
}

const SECURITY_HEADERS: Record<string, string> = {
	'X-Content-Type-Options': 'nosniff',
	'Referrer-Policy': 'strict-origin-when-cross-origin',
	'X-Frame-Options': 'DENY',
}
// Los datos cambian cada 10 minutos: 5 de caché en el borde bastan y ahorran lecturas de D1
const RATES_TTL_S = 300
const INFORMAL_TTL_S = 600
// La landing y el simulador reutilizan estos archivos del terminal en vez de duplicarlos
const SHARED = ['/vendor/', '/favicon.svg', '/theme.js', '/resize.js']

// app.terminalp2p.com (app.localhost en desarrollo) → terminal; sim.* → simulador; el resto → landing
const folderFor = (host: string) => (host.startsWith('app.') ? 'app' : host.startsWith('sim.') ? 'sim' : 'site')
// El simulador usa el botón de Telegram; los precios los pide a este mismo dominio
const SIM_CSP =
	"default-src 'self'; script-src 'self' https://telegram.org; frame-src https://oauth.telegram.org; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data: https://t.me https://*.telegram.org; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"

async function handle(req: Request, env: Env, ctx: ExecutionContext) {
	const url = new URL(req.url)

	// www.terminalp2p.com → terminalp2p.com
	if (url.hostname.startsWith('www.')) {
		url.hostname = url.hostname.slice(4)
		return Response.redirect(url.toString(), 301)
	}

	if (url.pathname === RELAY_PREFIX || url.pathname.startsWith(`${RELAY_PREFIX}/`))
		return secure(
			await relay(req, url, ctx, async (w) => {
				if (!env.METRICS_SALT) return
				const e = await relayEvent(w, env.METRICS_SALT)
				if (e) await saveEvent(env.DB, e)
			}),
		)
	if (url.pathname === '/data/event' && req.method === 'POST') return secure(await event(req, url, env))
	// Panel único en el dominio del terminal
	if (folderFor(url.hostname) === 'sim' && (url.pathname === '/admin' || url.pathname.startsWith('/admin/')))
		return Response.redirect(`${url.origin.replace('://sim.', '://app.')}/admin`, 301)
	if (url.pathname === '/admin' || url.pathname.startsWith('/admin/')) {
		if (!(await underLimit(env.PANEL_LIMIT, req))) return secure(jsonError(429, 'Demasiados intentos: espera un minuto'))
		if (url.pathname === '/admin') return Response.redirect(`${url.origin}/admin/metrics`, 302)
		if (url.pathname === '/admin/metrics' && req.method === 'GET') return secure(await metrics(req, url, env))
		if (url.pathname === '/admin/pro') return secure(await proAdmin(req, env as unknown as ProEnv))
			if (url.pathname === '/admin/sim' && req.method === 'GET') return secure(await simAdmin(req, env as unknown as SimEnv))
		
		return secure(jsonError(404, 'no encontrado'))
	}
	if (url.pathname === '/data/rates' && req.method === 'GET') return secure(await rates(req, url, env, ctx))
	if (url.pathname === '/data/informal' && req.method === 'GET') return secure(await informal(url, env, ctx))
	// Plan Pro, en el dominio del terminal. Canjear códigos tiene tope (que nadie los pruebe a ciegas)
	if (folderFor(url.hostname) === 'app' && (url.pathname.startsWith('/pro/') || url.pathname === '/api/pro/webhook')) {
		const guarded = ['/pro/claim', '/pro/pair', '/pro/checkout', '/pro/trial'].includes(url.pathname)
		if (req.method === 'POST' && guarded && !(await underLimit(env.PRO_LIMIT, req))) return secure(jsonError(429, 'Demasiados intentos: espera un minuto'))
		const r = await proApi(req, url, env as unknown as ProEnv)
		if (r) return secure(r)
	}
	if (folderFor(url.hostname) === 'sim' && url.pathname.startsWith('/api/')) {
		if (req.method !== 'GET' && !(await underLimit(env.SIM_LIMIT, req))) return secure(jsonError(429, 'Demasiadas órdenes seguidas: espera unos segundos'))
		return secure(await simApi(req, url, env as unknown as SimEnv))
	}
	// Las páginas enseñan u ocultan lo de Pro según el interruptor del panel
	const res = await assets(req, url, env)
	return res.headers.get('Content-Type')?.includes('text/html') ? proMarkup(res, await proEnabled(env.DB)) : res
}

// En las páginas, lo marcado data-pro solo se ve con Pro encendido (en el panel) y lo marcado data-nopro solo con Pro apagado
function proMarkup(res: Response, on: boolean) {
	return new HTMLRewriter().on(on ? '[data-nopro]' : '[data-pro]', { element: (el) => void el.remove() }).transform(res)
}

// Staging: que ningún buscador lo indexe y que se vea a simple vista que no es producción
const STAGING_BADGE =
	'<div style="position:fixed;left:8px;bottom:8px;z-index:99999;padding:3px 8px;border-radius:6px;background:#f0b93a;color:#000;font:700 11px/1.4 system-ui,sans-serif;letter-spacing:.06em;pointer-events:none">STAGING</div>'

// Los enlaces entre la web, el terminal y el simulador llevan los dominios de producción: en staging,
// a sus equivalentes (sim.terminalp2p.com → sim.staging.terminalp2p.com)
export const toStaging = (href: string) =>
	href.replace(/^https:\/\/(?:(app|sim|www)\.)?terminalp2p\.com(?=[/?#]|$)/, (_, sub?: string) => `https://${sub && sub !== 'www' ? `${sub}.` : ''}staging.terminalp2p.com`)

function staged(res: Response) {
	if (res.status === 101) return res
	const out = new Response(res.body, res)
	out.headers.set('X-Robots-Tag', 'noindex, nofollow')
	if (!out.headers.get('Content-Type')?.includes('text/html')) return out
	return new HTMLRewriter()
		.on('body', { element: (b) => void b.append(STAGING_BADGE, { html: true }) })
		.on('a[href]', {
			element: (a) => {
				const href = a.getAttribute('href')!
				const to = toStaging(href)
				if (to !== href) a.setAttribute('href', to)
			},
		})
		.transform(out)
}

export default {
	async fetch(req, env, ctx) {
		if (!env.STAGING) return handle(req, env, ctx)
		if (new URL(req.url).pathname === '/robots.txt') return new Response('User-agent: *\nDisallow: /\n', { headers: { 'Content-Type': 'text/plain' } })
		return staged(await handle(req, env, ctx))
	},

	// Cada minuto: las órdenes pendientes del simulador y las facturas Pro sin confirmar. Cada 10: los agregados públicos de QvaPay
	// y la tasa informal de elTOQUE
	async scheduled(event, env) {
		// Cloudflare lanza el cron unos segundos antes de su minuto: se redondea al minuto más cercano
		// (si no, a las 19:49:56 se tomaría por el minuto 49 y se guardaría en la franja de las 19:40)
		const at = Math.round(event.scheduledTime / 60_000) * 60_000
		const tenth = (at / 60_000) % 10 === 0
		if (env.PRO_KEY)
			try {
				await simCron(env.DB, Date.now())
			} catch (err) {
				console.error(`simulador: ${(err as Error).message}`)
			}
		if (env.PRO_KEY && env.QVAPAY_APP_SECRET)
			try {
				await settlePending(env as unknown as ProEnv, Date.now())
			} catch (err) {
				console.error(`pro: ${(err as Error).message}`)
			}
		// Una vez al día (09:00 UTC, las 5:00 en Cuba): los pagos se repasan con QvaPay y se guarda una copia de Pro
		if (at % 86_400_000 === 9 * 3600_000) await dailyPro(env as unknown as ProEnv, at)
		if (!tenth) return
		try {
			await collect(env.DB, at)
		} catch (err) {
			console.error(`histórico: ${(err as Error).message}`)
		}
		if (!env.ELTOQUE_TOKEN) return
		try {
			await syncInformal(env.DB, env.ELTOQUE_TOKEN, at)
		} catch (err) {
			console.error(`elTOQUE: ${(err as Error).message}`)
		}
	},
} satisfies ExportedHandler<Env>

async function dailyPro(env: ProEnv, at: number) {
	if (env.PRO_KEY && env.QVAPAY_APP_SECRET)
		try {
			const r = await reconcile(env, at)
			// Van como errores para que se vean en los registros de Cloudflare (los de cada petición están apagados)
			if (r.activated.length) console.error(`pro: activados al repasar con QvaPay: ${r.activated.join(', ')}`)
			if (r.unknown.length) console.error(`pro: pagados en QvaPay que no constan aquí: ${r.unknown.map((u) => `${u.invoice} (@${u.payer}, ${u.amount} USD)`).join('; ')}`)
		} catch (err) {
			console.error(`pro, repaso con QvaPay: ${(err as Error).message}`)
		}
	try {
		await backupPro(env, at)
	} catch (err) {
		console.error(`pro, copia: ${(err as Error).message}`)
	}
}

// Datos públicos y agregados: se cachean 2 minutos en el borde (si hay datos)
async function rates(req: Request, url: URL, env: Env, ctx: ExecutionContext) {
	const coin = url.searchParams.get('coin')
	const days = Number(url.searchParams.get('days') ?? 7)
	if (!isCoin(coin) || !RANGES.includes(days as (typeof RANGES)[number])) return jsonError(400, 'coin o days inválidos')

	const key = new Request(`${url.origin}/data/rates?coin=${coin}&days=${days}`)
	const hit = await caches.default.match(key)
	if (hit) return fromCache(hit, `public, max-age=${RATES_TTL_S}`)

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

// Aviso anónimo del navegador: una operación que empezó aquí se completó
async function event(req: Request, url: URL, env: Env) {
	if (req.headers.get('origin') !== url.origin) return jsonError(403, 'Origen no permitido')
	if (!(await underLimit(env.EVENT_LIMIT, req))) return jsonError(429, 'Demasiados avisos')
	if (!env.METRICS_SALT) return new Response(null, { status: 204 })
	const body = await req.text()
	if (body.length > 2048) return jsonError(413, 'Cuerpo demasiado grande')
	let e
	try {
		e = await clientEvent(JSON.parse(body), env.METRICS_SALT)
	} catch {
		e = null
	}
	if (!e) return jsonError(400, 'Evento no válido')
	await saveEvent(env.DB, e)
	return new Response(null, { status: 204 })
}

// Panel privado de métricas, con HTTP Basic (cualquier usuario y la clave METRICS_KEY)
async function metrics(req: Request, url: URL, env: Env) {
	if (!env.METRICS_KEY) return jsonError(404, 'no encontrado')
	if (!(await authorized(req, env.METRICS_KEY))) return askKey()
	const days = [7, 30, 90, 365].includes(Number(url.searchParams.get('days'))) ? Number(url.searchParams.get('days')) : 30
	return adminPage('metrics', 'Métricas', panelHtml(await loadSummary(env.DB, days)))
}

// La tasa informal más reciente (para la landing y la lectura del mercado), cacheada 10 minutos
async function informal(url: URL, env: Env, ctx: ExecutionContext) {
	const key = new Request(`${url.origin}/data/informal`)
	const hit = await caches.default.match(key)
	if (hit) return fromCache(hit, `public, max-age=${INFORMAL_TTL_S}`)
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
	if (folder !== 'app' && SHARED.some((p) => (p.endsWith('/') ? url.pathname.startsWith(p) : url.pathname === p))) folder = 'app'
	const target = new URL(url)
	target.pathname = `/${folder}${url.pathname}`
	const res = await env.ASSETS.fetch(new Request(target, req))
	// Las redirecciones de los assets (p. ej. /index.html → /) no deben mostrar la carpeta
	const loc = res.headers.get('Location')
	if (!loc) {
		if (folder !== 'sim') return res
		const out = new Response(res.body, res)
		out.headers.set('Content-Security-Policy', SIM_CSP)
		return out
	}
	const to = new URL(loc, target)
	if (to.origin === url.origin && to.pathname.startsWith(`/${folder}/`)) to.pathname = to.pathname.slice(folder.length + 1)
	const out = new Response(res.body, res)
	out.headers.set('Location', to.pathname + to.search)
	return out
}

// Lo que sale de la caché del borde llega con la caché del navegador de la zona (4 h) en vez de la nuestra:
// el navegador guardaría el histórico o la tasa durante horas. Se rehace la respuesta con nuestra cabecera
function fromCache(hit: Response, cacheControl: string) {
	return new Response(hit.body, { status: hit.status, headers: { 'Content-Type': hit.headers.get('Content-Type') ?? 'application/json; charset=utf-8', 'Cache-Control': cacheControl } })
}

function secure(res: Response) {
	const out = new Response(res.body, res)
	for (const [k, v] of Object.entries(SECURITY_HEADERS)) out.headers.set(k, v)
	return out
}

function jsonError(status: number, error: string) {
	return new Response(JSON.stringify({ error }), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } })
}
