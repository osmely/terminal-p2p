// Entrada del Worker de Terminal P2P:
//   · landing en terminalp2p.com (public/site) y terminal en app.terminalp2p.com (public/app)
//   · relé sin estado hacia QvaPay (/qp/*)
//   · histórico público de la tasa (/data/rates), alimentado por un cron, con la
//     referencia del mercado informal de elTOQUE (/data/informal)
//   · métricas anónimas de las acciones del P2P y su panel privado (/admin/metrics)
//   · simulador de trading con dinero ficticio en sim.terminalp2p.com (public/sim y worker/sim.ts)
// Todo lo que depende de la cuenta del usuario corre en su navegador.

import { cubaDate, informalSince, latestInformal, syncInformal } from './informal.ts'
import { authorized, clientEvent, loadPublicStats, loadSummary, panelHtml, relayEvent, saveEvent } from './metrics.ts'
import { collect, isCoin, query, RANGES, withoutPro, type RatesData } from './rates.ts'
import { RELAY_PREFIX, relay } from './relay.ts'
import { readWho, whoCookie } from './session.ts'
import { accessOf, profileAccess, relayAccess } from './blocks.ts'
import { relayIncident } from './incidents.ts'
import { sha256, verify } from './crypto.ts'
import { adminPage, askKey } from './admin.ts'
import { backupPro, cleanupPro, dailyDigest, proAdmin, proApi, reconcile, recordIssues, settlePending, type ProEnv } from './pro.ts'
import { simAdmin, simApi, simCron, type SimEnv } from './sim.ts'
import { expiryReminders } from './userbot.ts'
import { dailyPost } from './community.ts'
import { cleanHit, hitsHtml, loadHits, saveHit } from './hits.ts'
import { ORDERS_PAUSED_MSG, ordersPaused, proEnabled } from './flags.ts'
import { feedWebhook, liveSocket, type LiveEnv } from './livebook.ts'
import { LiveBook } from './livebook-do.ts'
import { licenseOfPrint, PLANS, type Plan } from './pro.ts'

// El libro en tiempo real de Pro (un Durable Object)
export { LiveBook }

interface Env extends Omit<SimEnv, 'DB'>, Omit<ProEnv, 'DB' | 'METRICS_KEY'>, Omit<LiveEnv, 'DB'> {
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
	STATUS_LIMIT?: RateLimiter
	RELAY_LIMIT?: RateLimiter
	// «1» en el entorno de staging (wrangler deploy --env staging)
	STAGING?: string
	// Avisos al grupo privado de Telegram (ver alerts.ts): el token es secreto, el chat una variable
	TELEGRAM_BOT_TOKEN?: string
	ALERT_CHAT?: string
	// El grupo de la comunidad, donde sale la «Tasa QvaPay del día» (ver community.ts)
	COMMUNITY_CHAT?: string
}

interface RateLimiter {
	limit(opts: { key: string }): Promise<{ success: boolean }>
}

// true si la petición pasa el tope; sin limitador configurado no se limita
async function underLimit(limiter: RateLimiter | undefined, req: Request, key = req.headers.get('cf-connecting-ip') ?? 'sin-ip') {
	if (!limiter) return true
	const { success } = await limiter.limit({ key })
	return success
}

// El relé se limita por cuenta (huella del token), no por IP: en Cuba muchos usuarios comparten IP. Sin token
// (lo público, que además va en caché), por IP
const relayKey = async (req: Request) => {
	const auth = req.headers.get('authorization')
	return auth ? `tok:${(await sha256(auth)).slice(0, 24)}` : `ip:${req.headers.get('cf-connecting-ip') ?? 'sin-ip'}`
}

const SECURITY_HEADERS: Record<string, string> = {
	'X-Content-Type-Options': 'nosniff',
	'Referrer-Policy': 'strict-origin-when-cross-origin',
	'X-Frame-Options': 'DENY',
}
// Los datos cambian cada 10 minutos: 5 de caché en el borde bastan y ahorran lecturas de D1
const RATES_TTL_S = 300
const INFORMAL_TTL_S = 600
const STATS_TTL_S = 600
// La landing y el simulador reutilizan estos archivos del terminal en vez de duplicarlos
const SHARED = ['/vendor/', '/favicon.svg', '/theme.js', '/resize.js', '/hit.js']

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

	if (url.pathname === RELAY_PREFIX || url.pathname.startsWith(`${RELAY_PREFIX}/`)) {
		if (!(await underLimit(env.RELAY_LIMIT, req, await relayKey(req)))) return secure(jsonError(429, 'Demasiadas peticiones seguidas: espera unos segundos'))
		// Publicar ofertas en pausa desde el panel: se corta aquí, también para quien tenga abierta una versión vieja
		// del terminal. 423 y no 5xx: el terminal no lo reintenta y enseña el aviso tal cual
		if (req.method === 'POST' && url.pathname === `${RELAY_PREFIX}/p2p/create` && (await ordersPaused(env.DB)))
			return secure(new Response(JSON.stringify({ error: ORDERS_PAUSED_MSG, code: 'TP_ORDERS_PAUSED' }), { status: 423, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } }))
		// Cuentas restringidas o bloqueadas desde el panel: se cortan aquí, antes de llegar a QvaPay
		const limited = await relayAccess(env.DB, env.PRO_KEY, req, url.pathname.slice(RELAY_PREFIX.length))
		if (limited) return secure(limited)
		// Una copia del módulo Pro en uso (la marca que manda el terminal): ¿es de esta cuenta y con días? En segundo plano
		if (req.headers.has('x-tp-pro')) ctx.waitUntil(relayIncident(env as unknown as ProEnv, env.PRO_KEY, req).catch((e) => console.error(`incidencias: ${(e as Error).message}`)))
		const res = await relay(req, url, ctx, async (w) => {
			if (!env.METRICS_SALT) return
			const e = await relayEvent(w, env.METRICS_SALT)
			if (e) await saveEvent(env.DB, e)
		})
		// El perfil que devuelve QvaPay dice de verdad quién es el dueño de ese token: queda firmado con su huella
		if (req.method === 'GET' && url.pathname === `${RELAY_PREFIX}/user` && res.ok && env.PRO_KEY) {
			const me = await res.clone().json().catch(() => null)
			const blocked = await profileAccess(env.DB, req, me)
			if (blocked) return secure(blocked)
			const set = await whoCookie(url, req.headers.get('authorization'), me, env.PRO_KEY)
			if (set) res.headers.append('Set-Cookie', set)
		}
		return secure(res)
	}
	// Feed del mercado de QvaPay (webhook firmado) y el libro en vivo para los terminales Pro (WebSocket)
	if (url.pathname === '/api/p2p/feed' && req.method === 'POST') return secure(await feedWebhook(req, env as unknown as LiveEnv, ctx))
	if (url.pathname === '/live' && folderFor(url.hostname) === 'app')
		return liveSocket(req, url, env as unknown as LiveEnv, async (print) => {
			// Una cuenta de QvaPay conectada de verdad en este navegador (la cookie que firma el relé con el perfil de QvaPay)
			const who = env.PRO_KEY ? await readWho(req.headers.get('cookie'), print, env.PRO_KEY, Date.now()) : null
			const ok = !!who && (await accessOf(env.DB, { username: who.username, print }))?.level !== 'blocked'
			return { ok, pro: ok && (await proEnabled(env.DB)) && !!(await licenseOfPrint(env.DB, print, Date.now())) }
		})
	if (url.pathname === '/data/event' && req.method === 'POST') return secure(await event(req, url, env))
	if (url.pathname === '/data/hit' && req.method === 'POST') return secure(await hit(req, url, env))
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
	if (url.pathname === '/data/stats' && req.method === 'GET') return secure(await stats(url, env, ctx))
	// Plan Pro, en el dominio del terminal. Pedir facturas tiene tope
	if (folderFor(url.hostname) === 'app' && (url.pathname.startsWith('/pro/') || url.pathname === '/api/pro/webhook')) {
		const guarded = url.pathname === '/pro/checkout' || url.pathname === '/pro/refund' || url.pathname === '/pro/telegram/link' || url.pathname === '/pro/trial'
			if (req.method === 'POST' && guarded && !(await underLimit(env.PRO_LIMIT, req))) return secure(jsonError(429, 'Demasiados intentos: espera un minuto'))
			// La consulta de estado da los días gratis y la sesión del simulador: con tope por IP (amplio)
			if (url.pathname === '/pro/status' && !(await underLimit(env.STATUS_LIMIT, req))) return secure(jsonError(429, 'Demasiadas consultas seguidas: espera un minuto'))
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

// En las páginas, lo marcado data-pro solo se ve con Pro encendido (en el panel) y lo marcado data-nopro solo con Pro apagado.
// Los precios (data-price="month"…) salen de PLANS: el HTML lleva uno de reserva, pero el que vale es el del servidor
function proMarkup(res: Response, on: boolean) {
	return new HTMLRewriter()
		.on(on ? '[data-nopro]' : '[data-pro]', { element: (el) => void el.remove() })
		.on('[data-price]', {
			element: (el) => {
				const p = PLANS[el.getAttribute('data-price') as Plan]
				if (p) el.setInnerContent(`${p.usd.toLocaleString('en-US', { minimumFractionDigits: 2 })} USD`)
			},
		})
		.transform(res)
}

const STAGING_OPEN = new Set(['/api/pro/webhook', '/pro/webhook', '/pro/telegram/webhook', '/api/p2p/feed'])
// El relé a QvaPay lleva el token del usuario en Authorization, la misma cabecera que la contraseña de
// staging: pidiéndola ahí, el navegador volvía a sacar el diálogo al conectar la cuenta. No expone nada de
// staging (solo reenvía a QvaPay con el token del usuario, como en producción)
const stagingOpen = (path: string) => STAGING_OPEN.has(path) || path === RELAY_PREFIX || path.startsWith(`${RELAY_PREFIX}/`)

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
		const path = new URL(req.url).pathname
		if (path === '/robots.txt') return new Response('User-agent: *\nDisallow: /\n', { headers: { 'Content-Type': 'text/plain' } })
		// Staging pide la contraseña del panel en todo (la misma de /admin, así basta con escribirla una vez);
		// solo queda abierto el aviso de pago de QvaPay. Sin contraseña configurada, no entra nadie
		if (!stagingOpen(path) && !(await authorized(req, env.METRICS_KEY))) return askKey()
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
		// A las 14:00 UTC (las 10:00 en Cuba, no de madrugada): el aviso por Telegram a quien se le acaban los días
		if (at % 86_400_000 === 14 * 3600_000 && env.PRO_KEY)
			try {
				if (await proEnabled(env.DB, at)) await expiryReminders(env as unknown as ProEnv, at)
			} catch (err) {
				console.error(`pro, recordatorios: ${(err as Error).message}`)
			}
		// A las 9:00 de Cuba, la «Tasa QvaPay del día» en el grupo de la comunidad (si está encendida en el panel)
		try {
			await dailyPost(env, at)
		} catch (err) {
			console.error(`tasa del día: ${(err as Error).message}`)
		}
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
	let r = null
	if (env.PRO_KEY && env.QVAPAY_APP_SECRET)
		try {
			r = await reconcile(env, at)
			await recordIssues(env.DB, r, at)
			// Van como errores para que se vean en los registros de Cloudflare (los de cada petición están apagados)
			if (r.activated.length) console.error(`pro: activados al repasar con QvaPay: ${r.activated.join(', ')}`)
			if (r.unknown.length) console.error(`pro: pagados en QvaPay que no constan aquí: ${r.unknown.map((u) => `${u.invoice} (@${u.payer}, ${u.amount} USD)`).join('; ')}`)
		} catch (err) {
			console.error(`pro, repaso con QvaPay: ${(err as Error).message}`)
		}
	try {
		await backupPro(env, at)
		await cleanupPro(env.DB, at)
	} catch (err) {
		console.error(`pro, copia: ${(err as Error).message}`)
	}
	// El repaso, a tu grupo de avisos (solo con Pro encendido: apagado no hay nada que vigilar)
	try {
		if (await proEnabled(env.DB, at)) await dailyDigest(env, r, at)
	} catch (err) {
		console.error(`pro, repaso diario: ${(err as Error).message}`)
	}
}

// ¿Trae una licencia Pro en vigor? (la firmada que da /pro/status; vale un día y el terminal la renueva)
async function hasPro(env: Env, license: string | null, now = Date.now()) {
	if (!license || !env.PRO_KEY) return false
	const l = await verify<{ e?: number; x?: number }>(license, env.PRO_KEY)
	return !!l && (l.e ?? 0) > now && (l.x ?? 0) > now
}

// Datos públicos y agregados: se cachean 2 minutos en el borde (si hay datos). Con Pro (?l=licencia), también el
// reparto en compras y ventas y los USD de cada barra
async function rates(req: Request, url: URL, env: Env, ctx: ExecutionContext) {
	const coin = url.searchParams.get('coin')
	const days = Number(url.searchParams.get('days') ?? 7)
	if (!isCoin(coin) || !RANGES.includes(days as (typeof RANGES)[number])) return jsonError(400, 'coin o days inválidos')
	const pro = await hasPro(env, url.searchParams.get('l'))
	const out = async (full: Response) => {
		if (pro) return new Response(full.body, { headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store' } })
		const cacheControl = full.headers.get('Cache-Control') ?? 'no-store'
		return new Response(JSON.stringify(withoutPro((await full.json()) as RatesData)), { headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': cacheControl } })
	}

	// En la caché del borde, lo completo; a cada uno se le da su parte
	const key = new Request(`${url.origin}/data/rates?coin=${coin}&days=${days}&v=full`)
	const hit = await caches.default.match(key)
	if (hit) return out(await fromCache(hit, `public, max-age=${RATES_TTL_S}`))

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
	return out(res)
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

// Visita anónima (public/app/hit.js): solo suma 1 a un contador del día, sin cookies, IP ni identificadores
async function hit(req: Request, url: URL, env: Env) {
	if (req.headers.get('origin') !== url.origin) return jsonError(403, 'Origen no permitido')
	if (!(await underLimit(env.EVENT_LIMIT, req))) return jsonError(429, 'Demasiados avisos')
	const body = await req.text()
	if (body.length > 512) return jsonError(413, 'Cuerpo demasiado grande')
	let h
	try {
		h = cleanHit(JSON.parse(body))
	} catch {
		h = null
	}
	if (!h) return jsonError(400, 'Visita no válida')
	await saveHit(env.DB, h)
	return new Response(null, { status: 204 })
}

// Panel privado de métricas, con HTTP Basic (cualquier usuario y la clave METRICS_KEY)
async function metrics(req: Request, url: URL, env: Env) {
	if (!env.METRICS_KEY) return jsonError(404, 'no encontrado')
	if (!(await authorized(req, env.METRICS_KEY))) return askKey()
	const days = [7, 30, 90, 365].includes(Number(url.searchParams.get('days'))) ? Number(url.searchParams.get('days')) : 30
	return adminPage('metrics', 'Métricas', panelHtml(await loadSummary(env.DB, days), hitsHtml(await loadHits(env.DB, days))))
}

// Las cifras públicas del terminal (para la landing): lo publicado, tomado y completado desde aquí, cacheadas 10 minutos
async function stats(url: URL, env: Env, ctx: ExecutionContext) {
	const key = new Request(`${url.origin}/data/stats`)
	const hit = await caches.default.match(key)
	if (hit) return fromCache(hit, `public, max-age=${STATS_TTL_S}`)
	let data
	try {
		data = await loadPublicStats(env.DB)
	} catch (err) {
		console.error(`/data/stats: ${(err as Error).message}`)
		return jsonError(503, 'Las cifras no están disponibles ahora mismo')
	}
	const res = new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': `public, max-age=${STATS_TTL_S}` } })
	ctx.waitUntil(caches.default.put(key, res.clone()))
	return res
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
