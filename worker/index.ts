// Entrada del Worker de Terminal P2P:
//   · landing en terminalp2p.com (public/site) y terminal en app.terminalp2p.com (public/app)
//   · relé sin estado hacia QvaPay (/qp/*)
//   · histórico público de la tasa (/data/rates), alimentado por un cron, con la
//     referencia del mercado informal de elTOQUE (/data/informal)
//   · métricas anónimas de las acciones del P2P y su panel privado (/admin/metrics)
//   · simulador de trading con dinero ficticio en sim.terminalp2p.com (public/sim y worker/sim.ts)
// Todo lo que depende de la cuenta del usuario corre en su navegador.

import { cubaDate, informalSince, latestInformal, syncInformal } from './informal.ts'
import { authorized, clientEvent, loadPublicStats, loadSummary, panelHtml, relayEvent, saveEvent, stagingGate, startedHere } from './metrics.ts'
import { collect, inCuba, isCoin, query, RANGES, withoutPro, type RatesData } from './rates.ts'
import { RELAY_PREFIX, relay } from './relay.ts'
import { clientIp, readWho, tokenPrint, whoCookie } from './session.ts'
import { cleanupLog, hourKey, logUser } from './userlog.ts'
import { accessOf, profileAccess, relayAccess } from './blocks.ts'
import { cleanupIncidents, relayIncident } from './incidents.ts'
import { sha256, verify } from './crypto.ts'
import { adminPage, askKey, panel } from './admin.ts'
import { backupPro, cleanupPro, dailyDigest, proAdmin, proApi, reconcile, recordIssues, settlePending, type ProEnv } from './pro.ts'
import { simAdmin, simApi, simCron, type SimEnv } from './sim.ts'
import { expiryReminders } from './userbot.ts'
import { dailyPost } from './community.ts'
import { cleanHit, hitsHtml, loadHits, saveHit } from './hits.ts'
import { loadOther, otherHtml } from './othermarkets.ts'
import { ORDERS_PAUSED_MSG, ordersPaused, proEnabled } from './flags.ts'
import { feedWebhook, liveBookOf, liveClients, liveOfferOf, liveOnline, liveSocket, type LiveEnv } from './livebook.ts'
import { peerStats, type PeerStatsEnv } from '../pro/peerstats.ts'
import { COINS, isOutlier } from '../src/terminal/market.ts'
import { botHtml, loadBot } from './ratebot.ts'
import { cleanupLive, recordLive } from './livehistory.ts'
import { cleanupInbox } from './inbox.ts'
import { recordBook } from './bookstats.ts'
import { FRAMES, frameStart, isFrame, loadCandles } from './candles.ts'
import { ANALYSIS_KEY, isAnalysisTime, refreshAnalysis, refreshBook } from './analysis.ts'
import { checkAlerts } from './ratealerts.ts'
import { historySource, isStock, isTimeframe, loadHistory, loadQuote, loadQuotes, marketStatus, QUOTES_TTL_S, TIMEFRAMES, trimHistory, withIcon, type Quote } from './stocks.ts'
import { LiveBook } from './livebook-do.ts'
import { cleanupPush, pushApi, refreshLive, relayTaken, type PushEnv } from './push.ts'
import { licenseOfPrint, ownedBy, PLANS, type Plan, TRIAL_DAYS } from './pro.ts'
import { TASA_KEY, TASA_PATH, tasaData, tasaPage, type TasaData } from './tasa.ts'
import { PLATFORM_KEEP_MS, readPlatform, syncQvaPayNostr } from './qpnostr.ts'

// El libro en tiempo real de Pro (un Durable Object)
export { LiveBook }

interface Env extends Omit<SimEnv, 'DB'>, Omit<ProEnv, 'DB' | 'METRICS_KEY'>, Omit<LiveEnv, 'DB'>, PeerStatsEnv {
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
	PEER_LIMIT?: RateLimiter
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
async function underLimit(limiter: RateLimiter | undefined, req: Request, key = clientIp(req)) {
	if (!limiter) return missingLimiter()
	const { success } = await limiter.limit({ key })
	return success
}

// El relé se limita por cuenta (huella del token), no por IP: en Cuba muchos usuarios comparten IP. Sin token
// (lo público, que además va en caché), por IP
const relayKey = async (req: Request) => {
	const auth = req.headers.get('authorization')
	return auth ? `tok:${(await sha256(auth)).slice(0, 24)}` : `ip:${clientIp(req)}`
}

const SECURITY_HEADERS: Record<string, string> = {
	'X-Content-Type-Options': 'nosniff',
	'Referrer-Policy': 'strict-origin-when-cross-origin',
	'X-Frame-Options': 'DENY',
	// Solo https, también en los subdominios, durante un año (todo terminalp2p.com va por Cloudflare con https)
	'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
}
// Los datos cambian cada 10 minutos: 5 de caché en el borde bastan y ahorran lecturas de D1
const RATES_TTL_S = 300
const INFORMAL_TTL_S = 600
const STATS_TTL_S = 600
// La landing y el simulador reutilizan estos archivos del terminal en vez de duplicarlos
const SHARED = ['/vendor/', '/favicon.svg', '/theme.js', '/resize.js', '/hit.js', '/numfield.js', '/i18n.js']

// app.terminalp2p.com (app.localhost en desarrollo) → terminal; sim.* → simulador; el resto → landing
const folderFor = (host: string) => (host.startsWith('app.') ? 'app' : host.startsWith('sim.') ? 'sim' : 'site')
// La mini app de QvaPay y la de Telegram (terminalp2p.com/mini/, la de Telegram con ?tg): el simulador del panel de
// QvaPay la abre dentro de su web y le pone su puente (sdk-sim.js); Telegram, el suyo (telegram-web-app.js), y en
// Telegram Web va dentro de un marco. Va en la web, no en el terminal: ahí no hay ningún token que esos scripts
// pudieran ver
const MINI_CSP =
	"default-src 'self'; script-src 'self' https://www.qvapay.com https://telegram.org; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'self' https://www.qvapay.com https://web.telegram.org; base-uri 'none'; form-action 'self'"
function miniApp(url: URL, res: Response) {
	if (folderFor(url.hostname) !== 'site' || !url.pathname.startsWith('/mini')) return res
	const out = new Response(res.body, res)
	out.headers.set('Content-Security-Policy', MINI_CSP)
	out.headers.delete('X-Frame-Options')
	return out
}
// El simulador está desconectado: sim.* solo enseña el aviso de mantenimiento (public/sim/mantenimiento.html), su API
// no responde y su cron no corre. Su código y sus datos siguen ahí: para volver a abrirlo, false
const SIM_OFF = true
async function simPaused(req: Request, url: URL, env: Env) {
	if (url.pathname.startsWith('/api/')) return jsonError(503, 'El simulador está en mantenimiento')
	// Los archivos compartidos (fuentes, icono) para la propia página del aviso
	if (SHARED.some((p) => (p.endsWith('/') ? url.pathname.startsWith(p) : url.pathname === p))) return assets(req, url, env)
	const page = await env.ASSETS.fetch(new Request(new URL('/sim/mantenimiento', url), { headers: req.headers }))
	const out = new Response(req.method === 'HEAD' ? null : page.body, { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Retry-After': '86400' } })
	out.headers.set('Content-Security-Policy', SIM_CSP)
	return out
}
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
	if (SIM_OFF && folderFor(url.hostname) === 'sim') return secure(await simPaused(req, url, env))

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
			if (set) {
				res.headers.append('Set-Cookie', set)
				// Al traceo de su cuenta: conectó (QvaPay dijo de quién es el token), una vez por hora y dispositivo
				const token = req.headers.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim()
				const name = (me as { username?: string }).username
				if (token && name) {
					const print = await tokenPrint(token)
					const now = Date.now()
					ctx.waitUntil(logUser(env.DB, { account: name, print, kind: 'login', detail: 'Conectó su cuenta: QvaPay confirmó de quién es el token', dk: hourKey('login', print, now) }, now))
				}
			}
		}
		// Tomó una oferta: sus navegadores con avisos la vigilan (antes de responder: el terminal pide vigilarla al momento)
		if (req.method === 'POST' && res.ok && (await relayTaken(env as unknown as PushEnv, req, url.pathname.slice(RELAY_PREFIX.length), res.ok).catch(() => 0))) ctx.waitUntil(refreshLive(env as unknown as PushEnv).then(() => {}))
		return secure(res)
	}
	// Feed del mercado de QvaPay (webhook firmado) y el libro en vivo para los terminales Pro (WebSocket)
	if (url.pathname === '/api/p2p/feed' && req.method === 'POST') return secure(await feedWebhook(req, env as unknown as LiveEnv, ctx))
	if (url.pathname === '/live' && folderFor(url.hostname) === 'app')
		return liveSocket(req, url, env as unknown as LiveEnv, async (print) => {
			// Una cuenta de QvaPay conectada de verdad en este navegador (la cookie que firma el relé con el perfil de QvaPay)
			const who = env.PRO_KEY ? await readWho(req.headers.get('cookie'), print, env.PRO_KEY, Date.now()) : null
			const ok = !!who && (await accessOf(env.DB, { username: who.username, print }))?.level !== 'blocked'
			return { ok, pro: ok && (await proEnabled(env.DB)) && !!(await ownedBy(env.DB, await licenseOfPrint(env.DB, print, Date.now()), who)), username: who?.username }
		})
	if (url.pathname === '/data/event' && req.method === 'POST') return secure(await event(req, url, env))
	if (url.pathname === '/data/hit' && req.method === 'POST') return secure(await hit(req, url, env))
	// Panel único en el dominio del terminal: desde la web o el simulador, allí
	if (folderFor(url.hostname) !== 'app' && (url.pathname === '/admin' || url.pathname.startsWith('/admin/')))
		return Response.redirect(`${url.protocol}//app.${url.host.replace(/^(?:www|sim)\./, '')}/admin`, 301)
	if (url.pathname === '/admin' || url.pathname.startsWith('/admin/')) {
		if (!(await underLimit(env.PANEL_LIMIT, req))) return secure(jsonError(429, 'Demasiados intentos: espera un minuto'))
		if (url.pathname === '/admin') return Response.redirect(`${url.origin}/admin/metrics`, 302)
		if (url.pathname === '/admin/metrics' && req.method === 'GET') return adminSecure(await metrics(req, url, env))
		if (url.pathname === '/admin/pro') return adminSecure(await proAdmin(req, env as unknown as ProEnv))
		if (url.pathname === '/admin/sim' && req.method === 'GET') return adminSecure(await simAdmin(req, env as unknown as SimEnv))
		
		return secure(jsonError(404, 'no encontrado'))
	}
	if (url.pathname === '/data/rates' && req.method === 'GET') return secure(await rates(req, url, env, ctx))
	if (url.pathname === '/data/analysis' && req.method === 'GET') return secure(await marketAnalysis(url, env))
	if (url.pathname === '/data/book' && req.method === 'GET') return secure(await book(url, env, ctx))
	if (url.pathname === '/data/informal' && req.method === 'GET') return secure(await informal(url, env, ctx))
	if (url.pathname === '/data/candles' && req.method === 'GET') return secure(await candles(url, env, ctx))
	if (url.pathname === '/data/stocks' && req.method === 'GET') return secure(await stocks(url, ctx))
	if (url.pathname === '/data/stocks/history' && req.method === 'GET') return secure(await stockHistory(url, ctx))
	if (url.pathname === '/data/stocks/quote' && req.method === 'GET') return secure(await stockQuote(url, ctx))
	// La hora del servidor, para que el terminal corrija un reloj desviado (public/app/clock.js)
	if (url.pathname === '/data/now' && req.method === 'GET') return secure(Response.json({ now: await serverNow(url) }, { headers: { 'Cache-Control': 'no-store' } }))
	if (url.pathname === '/data/stats' && req.method === 'GET') return secure(await stats(url, env, ctx))
	if (url.pathname === '/data/platform' && req.method === 'GET') return secure(await platform(url, env, ctx))
	if (url.pathname === '/data/offer' && req.method === 'GET') return secure(await offer(req, url, env, ctx))
	if (url.pathname === '/data/online' && req.method === 'POST') return secure(await online(req, env))
	if (url.pathname === '/data/peer-stats' && req.method === 'GET') return secure(await peerStatsRoute(req, url, env, ctx))
	// El enlace corto de una oferta compartida (terminalp2p.com/o/<uuid>): abre el terminal con ella delante
	const shared = SHARED_OFFER.exec(url.pathname)
	if (shared && folderFor(url.hostname) !== 'sim') {
		const app = url.hostname.startsWith('app.') ? url.origin : `${url.protocol}//app.${url.host}`
		return Response.redirect(`${app}/?de=oferta#p2p/${shared[1].toLowerCase()}`, 302)
	}
	// Plan Pro, en el dominio del terminal. Pedir facturas tiene tope
	if (folderFor(url.hostname) === 'app' && (url.pathname.startsWith('/pro/') || url.pathname === '/api/pro/webhook')) {
		const guarded = url.pathname === '/pro/checkout' || url.pathname === '/pro/refund' || url.pathname === '/pro/telegram/link' || url.pathname === '/pro/trial' || url.pathname === '/pro/alerts/add'
			if (req.method === 'POST' && guarded && !(await underLimit(env.PRO_LIMIT, req))) return secure(jsonError(429, 'Demasiados intentos: espera un minuto'))
			// La consulta de estado da los días gratis y la sesión del simulador: con tope por IP (amplio)
			if ((url.pathname === '/pro/status' || url.pathname === '/pro/module.js') && !(await underLimit(env.STATUS_LIMIT, req))) return secure(jsonError(429, 'Demasiadas consultas seguidas: espera un minuto'))
		const r = await proApi(req, url, env as unknown as ProEnv)
		if (r) return secure(r)
	}
	// Avisos push de tus operaciones (push.ts), con tope por IP como la consulta de estado de Pro
	if (folderFor(url.hostname) === 'app' && url.pathname.startsWith('/push/')) {
		if (req.method === 'POST' && !(await underLimit(env.STATUS_LIMIT, req))) return secure(jsonError(429, 'Demasiados intentos seguidos: espera un minuto'))
		return secure(await pushApi(req, url, env as unknown as PushEnv, ctx))
	}
	if (folderFor(url.hostname) === 'sim' && url.pathname.startsWith('/api/')) {
		if (req.method !== 'GET' && !(await underLimit(env.SIM_LIMIT, req))) return secure(jsonError(429, 'Demasiadas órdenes seguidas: espera unos segundos'))
		return secure(await simApi(req, url, env as unknown as SimEnv))
	}
	// Las páginas enseñan u ocultan lo de Pro según el interruptor del panel
	const res = folderFor(url.hostname) === 'site' && url.pathname === TASA_PATH && req.method === 'GET' ? await tasa(req, url, env, ctx) : miniApp(url, await assets(req, url, env))
	return res.headers.get('Content-Type')?.includes('text/html') ? proMarkup(res, await proEnabled(env.DB)) : res
}

// En las páginas, lo marcado data-pro solo se ve con Pro encendido (en el panel) y lo marcado data-nopro solo con Pro apagado.
// Los precios (data-price="month"…) salen de PLANS y los días gratis (data-trial) de TRIAL_DAYS: el HTML lleva unos de
// reserva, pero los que valen son los del servidor
function proMarkup(res: Response, on: boolean) {
	return new HTMLRewriter()
		.on(on ? '[data-nopro]' : '[data-pro]', { element: (el) => void el.remove() })
		.on('[data-trial]', { element: (el) => void el.setInnerContent(String(TRIAL_DAYS)) })
		.on('[data-price]', {
			element: (el) => {
				const p = PLANS[el.getAttribute('data-price') as Plan]
				if (p) el.setInnerContent(`${p.usd.toLocaleString('en-US', { minimumFractionDigits: 2 })} USD`)
			},
		})
		.transform(res)
}

const STAGING_OPEN = new Set(['/api/pro/webhook', '/pro/webhook', '/pro/telegram/webhook', '/api/p2p/feed'])
// La mini app de Telegram se abre en un visor del propio Telegram, que no sabe pedir la contraseña: en staging quedan
// abiertas su página y lo público que lee (el libro, el histórico y la librería del gráfico, lo mismo que en producción)
const MINI_OPEN = new Set(['/mini', '/mini/', '/mini/mini.js', '/data/book', '/data/rates', '/favicon.svg', '/vendor/lightweight-charts.js'])
// El relé a QvaPay lleva el token del usuario en Authorization, la misma cabecera que la contraseña de
// staging: pidiéndola ahí, el navegador volvía a sacar el diálogo al conectar la cuenta. No expone nada de
// staging (solo reenvía a QvaPay con el token del usuario, como en producción)
const stagingOpen = (path: string) => STAGING_OPEN.has(path) || MINI_OPEN.has(path) || path === RELAY_PREFIX || path.startsWith(`${RELAY_PREFIX}/`)

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

// Último recurso: un fallo que nadie esperaba (un corte de D1, un servicio que no responde) da un error claro y queda en
// los registros, en vez de la página de error de Cloudflare
async function safeHandle(req: Request, env: Env, ctx: ExecutionContext) {
	try {
		return await handle(req, env, ctx)
	} catch (e) {
		console.error(`${req.method} ${new URL(req.url).pathname}: ${(e as Error)?.stack ?? e}`)
		if (req.method === 'GET' && req.headers.get('accept')?.includes('text/html'))
			return secure(
				new Response(
					'<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Terminal P2P</title><body style="font:16px system-ui,sans-serif;background:#0b0f17;color:#e8ecf4;display:grid;place-items:center;min-height:90vh;margin:0;text-align:center"><div><h1 style="font-size:20px">Algo falló de nuestro lado</h1><p>Vuelve a cargar la página en unos segundos.</p></div>',
					{ status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Retry-After': '10' } },
				),
			)
		return secure(jsonError(503, 'Algo falló de nuestro lado: prueba otra vez en unos segundos'))
	}
}

export default {
	async fetch(req, env, ctx) {
		if (!env.STAGING) return safeHandle(req, env, ctx)
		const path = new URL(req.url).pathname
		if (path === '/robots.txt') return new Response('User-agent: *\nDisallow: /\n', { headers: { 'Content-Type': 'text/plain' } })
		// Staging pide la contraseña del panel en todo (la misma de /admin, así basta con escribirla una vez);
		// solo queda abierto el aviso de pago de QvaPay. Sin contraseña configurada, no entra nadie
		if (!stagingOpen(path)) {
			const denied = await stagingGate(req, env.METRICS_KEY, env.PANEL_LIMIT)
			if (denied) return denied
		}
		return staged(await safeHandle(req, env, ctx))
	},

	// Cada minuto: las órdenes pendientes del simulador y las facturas Pro sin confirmar. Cada 10: los agregados públicos de QvaPay
	// y la tasa informal de elTOQUE
	async scheduled(event, env) {
		// Cloudflare lanza el cron unos segundos antes de su minuto: se redondea al minuto más cercano
		// (si no, a las 19:49:56 se tomaría por el minuto 49 y se guardaría en la franja de las 19:40)
		const at = Math.round(event.scheduledTime / 60_000) * 60_000
		const tenth = (at / 60_000) % 10 === 0
		if (env.PRO_KEY && !SIM_OFF)
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
		// Quién tiene el terminal abierto (el historial del día de «En vivo», en el panel)
		try {
			const clients = await liveClients(env as unknown as LiveEnv)
			if (clients) await recordLive(env.DB, clients, at)
		} catch (err) {
			console.error(`en vivo: ${(err as Error).message}`)
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
		// Lo que QvaPay publica del P2P en Nostr: quién es su tesorería y las operaciones completadas (para comparar el volumen)
		if (env.PRO)
			try {
				await syncQvaPayNostr(env.DB, env.PRO as KVNamespace, at)
			} catch (err) {
				console.error(`QvaPay en Nostr: ${(err as Error).message}`)
			}
		// Los números de la página de la tasa de hoy, ya calculados para que sus visitas no lean la base
		try {
			const t = await tasaData(env.DB, at)
			if (t) await (env.PRO as KVNamespace | undefined)?.put(TASA_KEY, JSON.stringify(t))
		} catch (err) {
			console.error(`tasa de hoy: ${(err as Error).message}`)
		}
		// Con la tasa nueva como referencia de lo atípico, la foto del libro para el análisis de mercado
		try {
			await recordBook(env as unknown as LiveEnv, at)
		} catch (err) {
			console.error(`histórico del libro: ${(err as Error).message}`)
		}
		// El análisis de mercado de Pro: entero una vez al día a la hora de menos tráfico (y en seguida si aún no hay
		// ninguno); cada hora, solo su foto del libro. Las visitas solo leen el último, no tocan la base
		try {
			if (isAnalysisTime(at) || !(await env.PRO?.get(ANALYSIS_KEY))) await refreshAnalysis(env, at)
			else if (at % 3600_000 === 0) await refreshBook(env, at)
		} catch (err) {
			console.error(`análisis de mercado: ${(err as Error).message}`)
		}
		// Con la tasa nueva guardada, los avisos de tasa de Pro por Telegram
		if (env.TELEGRAM_BOT_TOKEN)
			try {
				if (await proEnabled(env.DB, at)) await checkAlerts(env as unknown as ProEnv, at)
			} catch (err) {
				console.error(`avisos de tasa: ${(err as Error).message}`)
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
	} catch (err) {
		console.error(`pro, copia: ${(err as Error).message}`)
	}
	// Cada limpieza aparte: si falla la copia o una de ellas, las demás siguen
	const cleanups: [string, () => Promise<unknown>][] = [
		['pro', () => cleanupPro(env.DB, at)],
		['actividad', () => cleanupLog(env.DB, at)],
		['libro en vivo', () => cleanupLive(env.DB, at)],
		['avisos al móvil', () => cleanupPush(env.DB, at)],
		['buzón', () => cleanupInbox(env.DB, at)],
		['incidencias', () => cleanupIncidents(env.DB, at)],
		['fichas', () => env.DB.prepare('DELETE FROM peer_stats_use WHERE day < ?').bind(inCuba(at - 7 * 86_400_000).toISOString().slice(0, 10)).run()],
	]
	for (const [name, run] of cleanups)
		try {
			await run()
		} catch (err) {
			console.error(`limpieza (${name}): ${(err as Error).message}`)
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
	return !!(await proLicense(env, license, now))
}

// La licencia de Pro vigente (u: el uuid de la licencia) o null
async function proLicense(env: Env, license: string | null, now = Date.now()) {
	if (!license || !env.PRO_KEY) return null
	const l = await verify<{ u?: string; e?: number; x?: number }>(license, env.PRO_KEY)
	return l && (l.e ?? 0) > now && (l.x ?? 0) > now ? l : null
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

// El análisis de mercado, solo con Pro (?l=licencia): el último que dejó hecho el cron (refreshAnalysis), tal cual.
// Ninguna visita lo calcula ni consulta la base
async function marketAnalysis(url: URL, env: Env) {
	if (!(await hasPro(env, url.searchParams.get('l')))) return jsonError(403, 'El análisis de mercado es del modo Pro')
	// Un minuto en la caché del KV en cada sitio: el cron lo rehace cada 10
	const body = await (env.PRO as KVNamespace | undefined)?.get(ANALYSIS_KEY, { cacheTtl: 60 })
	if (!body) return jsonError(503, 'En espera de datos')
	return new Response(body, { headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store' } })
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
	// Solo si la operación empezó aquí (ver startedHere); si no, se ignora sin decir nada
	const real = await startedHere(env.DB, e)
	if (real) await saveEvent(env.DB, real)
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
	return adminPage('metrics', 'Métricas', panelHtml(await loadSummary(env.DB, days), hitsHtml(await loadHits(env.DB, days)) + botHtml(await loadBot(env.DB, days)) + otherHtml(await loadOther(env.DB), panel)))
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

// Los usuarios de la tesorería de QvaPay (los que publican sus ofertas con ["maker", "platform"] en Nostr, ver
// worker/qpnostr.ts), para marcarlos en el libro. Lo deja el cron cada 10 minutos; se cachea lo mismo
async function platform(url: URL, env: Env, ctx: ExecutionContext) {
	const key = new Request(`${url.origin}/data/platform`)
	const hit = await caches.default.match(key)
	if (hit) return fromCache(hit, `public, max-age=${STATS_TTL_S}`)
	const p = await readPlatform(env.PRO as KVNamespace | undefined)
	const now = Date.now()
	const users = Object.entries(p?.users ?? {})
		.filter(([, t]) => now - t < PLATFORM_KEEP_MS)
		.map(([u]) => u)
		.sort()
	const res = new Response(JSON.stringify({ at: p?.at ?? null, users }), { headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': `public, max-age=${STATS_TTL_S}` } })
	ctx.waitUntil(caches.default.put(key, res.clone()))
	return res
}

// Las velas de lo completado de un mercado (worker/candles.ts), solo con Pro (?l=licencia). Sin ?since, todas las de
// su alcance (un minuto en la caché del borde); con ?since (el inicio de la última vela que tiene el terminal), solo
// desde ahí, para que la vela en curso se vea crecer (10 s). En la caché son las mismas para todos los Pro; a cada uno
// se le dan sin caché pública. `at`: la hora del servidor al leerlas
const CANDLES_TTL_S = 60
const CANDLES_LIVE_TTL_S = 10
async function candles(url: URL, env: Env, ctx: ExecutionContext) {
	const coin = url.searchParams.get('coin')
	const tf = url.searchParams.get('tf')
	if (!isCoin(coin) || !isFrame(tf)) return jsonError(400, 'coin o tf inválidos')
	if (!(await hasPro(env, url.searchParams.get('l')))) return jsonError(403, 'Las velas son del modo Pro')
	const now = Date.now()
	const asked = Number(url.searchParams.get('since'))
	// Siempre el inicio de una vela y dentro del alcance: así todos piden lo mismo y la caché sirve
	const since = url.searchParams.has('since') && Number.isFinite(asked) ? frameStart(Math.max(asked, now - FRAMES[tf].span), tf) : null
	const ttl = since === null ? CANDLES_TTL_S : CANDLES_LIVE_TTL_S
	const key = new Request(`${url.origin}/data/candles?coin=${coin}&tf=${tf}${since === null ? '' : `&since=${since}`}`)
	const hit = await caches.default.match(key)
	if (hit) return fromCache(hit, 'private, no-store')
	let list
	try {
		list = await loadCandles(env.DB, coin, tf, since, now)
	} catch (err) {
		console.error(`/data/candles: ${(err as Error).message}`)
		return jsonError(503, 'Las velas no están disponibles ahora mismo')
	}
	const body = JSON.stringify({ tf, candles: list, at: now })
	ctx.waitUntil(caches.default.put(key, new Response(body, { headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': `public, max-age=${ttl}` } })))
	return new Response(body, { headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store' } })
}

// Acciones de QvaPay (worker/stocks.ts), solo para mirar. QvaPay limita las peticiones seguidas: cada dato se guarda en
// la caché del borde con la hora en que se leyó; pasado su tiempo se vuelve a pedir y, si QvaPay no responde, sirve el
// último que se tuvo (hasta 12 veces su tiempo y al menos una hora: el de 1 año, un día). Si la bolsa de Nueva York
// está abierta se calcula en cada visita
const STOCKS_STALE_S = 3600
// Lo guardado: el dato, cuándo se leyó (at) y cuándo se le preguntó a QvaPay por última vez (asked)
type StockStored = { at: number; asked?: number; data: unknown }
async function stockCached(url: URL, path: string, ttlS: number, ctx: ExecutionContext, load: (prev: unknown) => Promise<unknown>) {
	const key = new Request(`${url.origin}${path}`)
	const hit = await caches.default.match(key)
	const raw = hit ? await hit.json<StockStored>().catch(() => null) : null
	const had = raw && typeof raw.at === 'number' && raw.data != null ? raw : null
	if (had && Date.now() - (had.asked ?? had.at) < ttlS * 1000) return had
	const data = await load(had?.data).catch(() => null)
	const now = Date.now()
	const keep = (v: StockStored) => ctx.waitUntil(caches.default.put(key, new Response(JSON.stringify(v), { headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': `public, max-age=${Math.max(ttlS * 12, STOCKS_STALE_S)}` } })))
	// QvaPay no lo dio (no responde, pide esperar o no lo tiene: con la bolsa cerrada no da lo intradía). Sigue lo
	// último que se tuvo (hasta un día) y no se le vuelve a preguntar hasta pasado su tiempo, para no gastar su cupo
	// con cada visita. Sin nada guardado: si dijo que no lo tiene, eso, guardado igual
	if (data === null || (Array.isArray(data) && !data.length)) {
		if (had && now - had.at < 86_400_000) {
			keep({ ...had, asked: now })
			return had
		}
		if (data === null) return null
		const none = { at: now, asked: now, data }
		keep(none)
		return none
	}
	const fresh = { at: now, data }
	keep(fresh)
	return fresh
}
const STOCK_HEADERS = { 'Cache-Control': 'public, max-age=60' }

// La lista: precio y cambio de todas
async function stocks(url: URL, ctx: ExecutionContext) {
	// Las que QvaPay no dé esta vez (corta a las pocas peticiones) siguen con su precio anterior
	const got = await stockCached(url, '/data/stocks', QUOTES_TTL_S, ctx, (prev) => loadQuotes(fetch, Array.isArray(prev) ? prev : []))
	if (!got || !(got.data as unknown[]).length) return jsonError(503, 'QvaPay no da las cotizaciones ahora mismo')
	return Response.json({ at: got.at, stocks: (got.data as Quote[]).map(withIcon), market: marketStatus(Date.now()) }, { headers: STOCK_HEADERS })
}

// La ficha de una (apertura, máximo, mínimo, 52 semanas…)
async function stockQuote(url: URL, ctx: ExecutionContext) {
	const s = url.searchParams.get('s')
	if (!isStock(s)) return jsonError(400, 's inválido')
	const got = await stockCached(url, `/data/stocks/quote?s=${s}`, QUOTES_TTL_S, ctx, () => loadQuote(s))
	if (!got) return jsonError(503, 'QvaPay no da la cotización ahora mismo')
	return Response.json({ at: got.at, quote: withIcon(got.data as Quote) }, { headers: STOCK_HEADERS })
}

// El histórico de una en un intervalo (1H, 24H, 1W, 1M o 1Y), guardado lo que dure ese intervalo. Sin puntos: QvaPay
// no tiene histórico de ese intervalo (el terminal no lo ofrece)
async function stockHistory(url: URL, ctx: ExecutionContext) {
	const s = url.searchParams.get('s')
	const tf = url.searchParams.get('tf')
	if (!isStock(s) || !isTimeframe(tf)) return jsonError(400, 's o tf inválidos')
	const from = historySource(tf)
	const got = await stockCached(url, `/data/stocks/history?s=${s}&tf=${from}`, TIMEFRAMES[from], ctx, () => loadHistory(s, from))
	if (!got) return jsonError(503, 'QvaPay no da el histórico ahora mismo')
	const points = from === tf ? got.data : trimHistory(got.data as [number, number][], tf)
	return Response.json({ at: got.at, s, tf, points }, { headers: STOCK_HEADERS })
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

// La página de la tasa de hoy, con los números del KV ya puestos (worker/tasa.ts). 5 min en la caché del borde, como el histórico
async function tasa(req: Request, url: URL, env: Env, ctx: ExecutionContext) {
	const key = new Request(`${url.origin}${TASA_PATH}`)
	const hit = await caches.default.match(key)
	if (hit) return fromCache(hit, 'public, max-age=60')
	const page = await assets(req, url, env)
	if (!page.ok) return page
	// Lo deja el cron; solo si aún no hay nada (recién desplegado) se calcula aquí una vez
	let data: TasaData | null = null
	try {
		const kv = env.PRO as KVNamespace | undefined
		const saved = await kv?.get(TASA_KEY, { cacheTtl: 60 })
		data = saved ? (JSON.parse(saved) as TasaData) : await tasaData(env.DB)
		if (!saved && data) ctx.waitUntil(kv?.put(TASA_KEY, JSON.stringify(data)) ?? Promise.resolve())
	} catch (err) {
		console.error(`${TASA_PATH}: ${(err as Error).message}`)
	}
	const html = await tasaPage(page, data).text()
	const res = new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=60' } })
	// Sin datos se sirve la página con sus textos de reserva, pero no se guarda
	if (data) ctx.waitUntil(caches.default.put(key, new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': `public, max-age=${RATES_TTL_S}` } })))
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

// El libro de un mercado para la mini app de QvaPay (solo mirar, sin cuenta): las 30 mejores de cada lado, como un
// terminal sin Pro, con la Tasa QvaPay y lo atípico marcado. 5 s en la caché del borde: todos ven lo mismo y el libro
// en vivo no recibe una consulta por cada móvil
const BOOK_TTL_S = 5
async function book(url: URL, env: Env, ctx: ExecutionContext) {
	const coin = url.searchParams.get('coin')
	if (!isCoin(coin)) return jsonError(400, 'Mercado desconocido')
	const key = new Request(`${url.origin}/data/book?coin=${coin}`)
	const hit = await caches.default.match(key)
	if (hit) return fromCache(hit, `public, max-age=${BOOK_TTL_S}`)
	const live = await liveBookOf(env as unknown as LiveEnv, coin).catch(() => null)
	if (!live) return jsonError(503, 'El libro no está disponible ahora mismo')
	const r = await env.DB.prepare('SELECT t, median, median_buy, median_sell FROM rates WHERE coin = ? ORDER BY t DESC LIMIT 1')
		.bind(coin)
		.first<{ t: number; median: number | null; median_buy: number | null; median_sell: number | null }>()
	const ref = { ask: r?.median_sell ?? r?.median ?? null, bid: r?.median_buy ?? r?.median ?? null }
	const side = (s: 'ask' | 'bid') => ({
		ready: live[s].ready,
		total: live[s].total,
		levels: live[s].levels.map((l) => ({ uuid: l.uuid, price: l.price, usd: l.usd, user: l.user, kind: l.kind, orderMin: l.orderMin, orderMax: l.orderMax, vipOnly: l.vipOnly, outlier: isOutlier(l.price, ref[s], s) })),
	})
	const data = { coin, at: live.at, version: live.version ?? null, rate: r?.median ?? null, rateAt: r?.t ?? null, ask: side('ask'), bid: side('bid'), markets: COINS.map((c) => ({ tick: c.tick, name: c.name, unit: c.unit })) }
	const ready = live.ask.ready && live.bid.ready
	const res = new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': ready ? `public, max-age=${BOOK_TTL_S}` : 'no-store' } })
	if (ready) ctx.waitUntil(caches.default.put(key, res.clone()))
	return res
}

// Quién está en línea, para usuarios que no tienen ofertas en el libro: el terminal manda hasta 20 { id, u } (uuid de
// QvaPay y usuario) y desde entonces entran en lo que mira el libro en vivo; responde los que ya se
// saben en línea: term, con el terminal abierto, y qp, solo con QvaPay. Lo de los dueños del libro llega por el WebSocket
async function online(req: Request, env: Env) {
	// Solo desde el propio terminal: otra web no puede usar el navegador de sus visitantes para llenar la lista
	const url = new URL(req.url)
	if ((req.headers.get('origin') ?? (req.headers.get('sec-fetch-site') === 'same-origin' ? url.origin : null)) !== url.origin) return jsonError(403, 'Origen no permitido')
	if (!(await underLimit(env.STATUS_LIMIT, req))) return jsonError(429, 'Demasiadas consultas seguidas: espera un minuto')
	const body = (await req.json().catch(() => null)) as { users?: unknown } | null
	const users = (Array.isArray(body?.users) ? body.users : []).slice(0, 20).map((x) => ({ id: String((x as { id?: unknown })?.id ?? '').toLowerCase(), u: String((x as { u?: unknown })?.u ?? '') }))
	const r = await liveOnline(env as unknown as LiveEnv, users, clientIp(req, '')).catch(() => null)
	if (!r) return jsonError(503, 'No se puede saber ahora mismo')
	return Response.json(r, { headers: { 'Cache-Control': 'no-store' } })
}

// ★ Pro: la actividad de un usuario en el P2P para su ficha (módulo privado), por su uuid de QvaPay (?l=licencia).
// Media hora en la caché del borde: cambia poco. Para que nadie la use para barrer QvaPay, cada licencia puede pedir
// 10 por minuto y 40 al día (hora de Cuba); las que ya están en la caché no cuentan
const PEER_STATS_TTL_S = 1800
const PEER_STATS_PER_DAY = 40
async function peerStatsRoute(req: Request, url: URL, env: Env, ctx: ExecutionContext) {
	const id = (url.searchParams.get('id') ?? '').toLowerCase()
	if (!UUID.test(id)) return jsonError(400, 'Usuario desconocido')
	const lic = await proLicense(env, url.searchParams.get('l'))
	if (!lic?.u) return jsonError(403, 'La actividad en QvaPay es del modo Pro')
	const key = new Request(`${url.origin}/data/peer-stats?id=${id}&v=3`)
	const hit = await caches.default.match(key)
	if (hit) return fromCache(hit, `private, max-age=${PEER_STATS_TTL_S}`)
	if (!(await underLimit(env.STATUS_LIMIT, req))) return jsonError(429, 'Demasiadas consultas seguidas: espera un minuto')
	if (!(await underLimit(env.PEER_LIMIT, req, lic.u))) return jsonError(429, 'Muchas fichas seguidas: espera un minuto')
	const day = inCuba(Date.now()).toISOString().slice(0, 10)
	const used = await env.DB.prepare('INSERT INTO peer_stats_use (license, day, n) VALUES (?, ?, 1) ON CONFLICT (license, day) DO UPDATE SET n = n + 1 RETURNING n')
		.bind(lic.u, day)
		.first<{ n: number }>()
	if ((used?.n ?? 0) > PEER_STATS_PER_DAY) return jsonError(429, `Por hoy ya viste la actividad de ${PEER_STATS_PER_DAY} usuarios: mañana se renueva`)
	const stats = await peerStats(env, id).catch(() => null)
	if (!stats) {
		// Si QvaPay no la dio, no cuenta (se apunta antes para que dos peticiones a la vez no pasen las dos del tope)
		await env.DB.prepare('UPDATE peer_stats_use SET n = n - 1 WHERE license = ? AND day = ? AND n > 0').bind(lic.u, day).run().catch(() => {})
		return jsonError(503, 'No se puede ver ahora mismo')
	}
	const res = new Response(JSON.stringify(stats), { headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': `public, max-age=${PEER_STATS_TTL_S}` } })
	ctx.waitUntil(caches.default.put(key, res.clone()))
	return new Response(res.body, { headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': `private, max-age=${PEER_STATS_TTL_S}` } })
}

// Una oferta del libro por su uuid, para quien abre el enlace que compartió su dueño sin tener la cuenta conectada:
// lo mismo que enseña de ella el libro. Si ya salió, su mercado y lado (para enseñar otras parecidas)
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SHARED_OFFER = /^\/o\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i
async function offer(req: Request, url: URL, env: Env, ctx: ExecutionContext) {
	const id = (url.searchParams.get('id') ?? '').toLowerCase()
	if (!UUID.test(id)) return jsonError(400, 'Oferta desconocida')
	const key = new Request(`${url.origin}/data/offer?id=${id}`)
	const hit = await caches.default.match(key)
	if (hit) return fromCache(hit, `public, max-age=${BOOK_TTL_S}`)
	if (!(await underLimit(env.STATUS_LIMIT, req))) return jsonError(429, 'Demasiadas consultas seguidas: espera un minuto')
	const found = await liveOfferOf(env as unknown as LiveEnv, id).catch(() => null)
	if (!found) return jsonError(503, 'La oferta no se puede ver ahora mismo')
	let data: Record<string, unknown> = found
	if (found.state === 'open') {
		const l = found.level
		data = { state: 'open', coin: found.coin, side: found.side, uuid: id, price: l.price, usd: l.usd, kind: l.kind, orderMin: l.orderMin, orderMax: l.orderMax, vipOnly: l.vipOnly, requirements: l.requirements, user: l.user, image: l.image ?? null, ops: l.ops, rating: l.rating, createdAt: l.createdAt, updatedAt: l.updatedAt }
	}
	const res = new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': `public, max-age=${BOOK_TTL_S}` } })
	ctx.waitUntil(caches.default.put(key, res.clone()))
	return res
}

// Lo que sale de la caché del borde llega con la caché del navegador de la zona (4 h) en vez de la nuestra:
// el navegador guardaría el histórico o la tasa durante horas. Se rehace la respuesta con nuestra cabecera
function fromCache(hit: Response, cacheControl: string) {
	return new Response(hit.body, { status: hit.status, headers: { 'Content-Type': hit.headers.get('Content-Type') ?? 'application/json; charset=utf-8', 'Cache-Control': cacheControl } })
}

// La hora de verdad para clock.js. En Cloudflare, la del servidor. En desarrollo el servidor corre en el mismo equipo
// y tendría su mismo reloj (si va adelantado, no corregiría nada): se toma la de la cabecera Date de QvaPay
async function serverNow(url: URL) {
	if (!/(^|\.)localhost$/.test(url.hostname)) return Date.now()
	const sent = Date.now()
	const res = await fetch('https://api.qvapay.com/p2p/averages', { method: 'HEAD' }).catch(() => null)
	const at = Date.parse(res?.headers.get('date') ?? '')
	// La cabecera va en segundos enteros: se suma medio segundo y lo que tardó en volver
	return Number.isFinite(at) ? at + 500 + (Date.now() - sent) / 2 : Date.now()
}

function secure(res: Response) {
	if (res.status === 101) return res
	const out = new Response(res.body, res)
	for (const [k, v] of Object.entries(SECURITY_HEADERS)) out.headers.set(k, v)
	return out
}

// El panel no carga scripts de fuera ni manda nada a otra web: sus botones usan onclick (de ahí 'unsafe-inline') y la
// letra viene de Google Fonts
const ADMIN_CSP =
	"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"
function adminSecure(res: Response) {
	const out = secure(res)
	if (out.headers.get('Content-Type')?.includes('text/html')) out.headers.set('Content-Security-Policy', ADMIN_CSP)
	return out
}

// Un tope sin su binding en wrangler.jsonc deja pasar todo: que se vea en los registros (una vez por instancia)
let limiterWarned = false
function missingLimiter() {
	if (!limiterWarned) {
		limiterWarned = true
		console.error('Falta un binding de ratelimits en wrangler.jsonc: ese tope no se aplica')
	}
	return true
}

function jsonError(status: number, error: string) {
	return new Response(JSON.stringify({ error }), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } })
}
