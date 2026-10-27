// Terminal P2P en el navegador. Expone window.TPApi.fetch(), que atiende las
// mismas rutas /api/* que antes servía el backend, pero aquí mismo:
//   · el libro se lee con el token del propio usuario (nunca con el de otro)
//   · "Mis operaciones" opera con ese mismo token
//   · el histórico de precios es público y lo sirve el servidor (/data/rates)
// Hacia QvaPay se sale por el relé sin estado del dominio (/qp), solo por CORS.

import { Broker, json } from '../src/broker/routes.ts'
import { QvaPayClient } from '../src/qvapay/client.ts'
import { COINS, Market, type Tick, type Watch, type WatchedSide } from '../src/terminal/market.ts'
import { bestCross } from '../src/terminal/arbitrage.ts'
import { CRITERIA, positions, rank, userStats } from '../src/terminal/ranking.ts'
import { BrowserAccounts, TOKEN_KEY } from './accounts.ts'

const RELAY = `${location.origin}/qp`
// Si la próxima lectura está lejos (nadie miraba), se adelanta al abrir un mercado
const WAKE_IF_FURTHER_THAN_MS = 5_000

const accounts = new BrowserAccounts({ storage: { session: sessionStorage, local: localStorage }, baseUrl: RELAY })
const market = new Market({
	// Promedios y operaciones completadas son públicos: sin token
	publicClient: new QvaPayClient({ dryRun: true, baseUrl: RELAY }),
	readers: { get: () => accounts.reader(), invalid: () => accounts.disconnect() },
	// El histórico es público y lo guarda el servidor (/data/rates): aquí no se guarda nada
	historyStore: { load: async () => [], append: async () => {} },
})
const broker = new Broker({ accounts, market, dryRun: false })
try {
	localStorage.removeItem('tp.history') // restos de la versión que guardaba precios en el navegador
} catch {}
const ready = market.init()

// ── Bucle del libro: un paso cada nextDelayMs, en pausa con la pestaña oculta ──
// Con el radar de Pro encendido sigue también con la pestaña oculta. Los navegadores frenan los temporizadores
// de una pestaña oculta (Chrome, hasta uno por minuto); los de un worker no, así que entonces se cuenta allí
let ticker: Worker | null = null
let noTicker = false
let gen = 0
let nextAt = 0
function schedule(ms: number) {
	const id = ++gen
	nextAt = Date.now() + ms
	if (market.watching() && !noTicker) {
		try {
			if (!ticker) {
				ticker = new Worker('/tick.js')
				ticker.onmessage = (e) => e.data === gen && void loop()
				// Si no arranca (bloqueado, sin red), el bucle sigue con el temporizador normal: nunca se queda parado
				ticker.onerror = () => {
					ticker?.terminate()
					ticker = null
					noTicker = true
					schedule(50)
				}
			}
			ticker.postMessage({ id, ms })
			return
		} catch {
			ticker = null
			noTicker = true
		}
	}
	setTimeout(() => id === gen && void loop(), ms)
}
async function loop() {
	await ready
	if (!document.hidden || market.watching()) await market.tick().catch((e: Error) => console.warn('tick:', e.message))
	syncLive()
	schedule(market.nextDelayMs())
}

// ── Libro desde el servidor ──────────────────────────────────────────────
// Con tu cuenta conectada, el servidor te empuja el libro por un WebSocket (lo alimenta el feed de QvaPay): con Pro,
// cada cambio al instante; sin Pro, cada 10 s. Los mercados que llegan así no se leen con tu token. Si la conexión
// se corta, se vuelve a leer como siempre hasta que vuelva
let ws: WebSocket | null = null
let livePrint: string | null = null
let livePro = false
let liveRetry = 0
let liveSubs = ''
let liveFeed = false
// Mercados pedidos de los que ya llegó el libro completo: esos dejan de leerse con el token
let liveReady = new Set<string>()
function liveConnect() {
	if (!livePrint || ws) return
	const s = new WebSocket(`${location.origin.replace(/^http/, 'ws')}/live?p=${encodeURIComponent(livePrint)}`)
	ws = s
	liveSubs = ''
	s.onopen = () => {
		liveRetry = 0
		syncLive()
	}
	s.onmessage = (e) => {
		let m: { t?: string; coin?: Tick; side?: 'ask' | 'bid'; ready?: boolean; levels?: []; total?: number; feed?: boolean; pro?: boolean }
		try {
			m = JSON.parse(String(e.data))
		} catch {
			return // el «pong» de la señal de vida
		}
		if (typeof m.feed === 'boolean') liveFeed = m.feed
		if (m.t === 'hello') livePro = !!m.pro
		// Un lado que el servidor aún no tiene completo no se usa: se sigue leyendo con el token
		if (m.t !== 'side' || !m.ready || !isTick(m.coin ?? null) || (m.side !== 'ask' && m.side !== 'bid') || !liveSubs.split(',').includes(m.coin!)) return
		market.setLive(m.coin!, m.side, m.levels ?? [], m.total ?? 0)
		liveReady.add(m.coin!)
		market.setLiveCoins([...liveReady])
		// El terminal lo pinta ya, sin esperar a su repaso de cada 5 s
		window.dispatchEvent(new CustomEvent('tp:live', { detail: m.coin }))
	}
	s.onclose = () => {
		if (ws !== s) return
		ws = null
		liveReady.clear()
		market.setLiveCoins([])
		if (livePrint) setTimeout(liveConnect, Math.min(30_000, 1000 * 2 ** liveRetry++))
	}
}
// Pide al servidor los mercados que interesan ahora (el que se mira y los del radar)
function syncLive() {
	if (ws?.readyState !== WebSocket.OPEN) return
	const subs = market.wanted()
	const key = subs.join()
	if (key === liveSubs) return
	liveSubs = key
	ws.send(JSON.stringify({ sub: subs }))
	liveReady = new Set([...liveReady].filter((c) => subs.includes(c)))
	market.setLiveCoins([...liveReady])
}
// Señal de vida para que ningún proxy dé la conexión por muerta
setInterval(() => ws?.readyState === WebSocket.OPEN && ws.send('ping'), 25_000)
let wantPro = false
const live = {
	// pro: si tienes Pro ahora. Al cambiar, se reconecta para recibirlo al instante (o cada 10 s)
	start(print: string, pro = false) {
		if (livePrint === print && wantPro === pro && ws) return
		if (livePrint !== null) live.stop()
		livePrint = print
		wantPro = pro
		liveConnect()
	},
	stop() {
		livePrint = null
		const s = ws
		ws = null
		s?.close()
		liveReady.clear()
		market.setLiveCoins([])
	},
	state: () => ({ connected: ws?.readyState === WebSocket.OPEN, feed: liveFeed, pro: livePro }),
}
function wake() {
	if (nextAt - Date.now() <= WAKE_IF_FURTHER_THAN_MS) return
	schedule(50)
}
document.addEventListener('visibilitychange', () => !document.hidden && wake())
// Otra pestaña conectó o desconectó una cuenta recordada: esta se recarga para no seguir con la anterior
window.addEventListener('storage', (e) => e.key === TOKEN_KEY && location.reload())
void loop()

const isTick = (v: string | null): v is Tick => COINS.some((c) => c.tick === v)

async function api(input: string, init?: RequestInit): Promise<Response> {
	await ready
	const url = new URL(input, location.origin)

	if (url.pathname.startsWith('/api/broker/')) {
		const res = (await broker.handle(new Request(url, init))) ?? json(404, { error: 'Ruta desconocida' })
		if (url.pathname === '/api/broker/connect' && res.ok) wake()
		return res
	}
	if (url.pathname === '/api/overview') return json(200, market.overview())
	if (url.pathname === '/api/book') {
		const coin = url.searchParams.get('coin')
		if (!isTick(coin)) return json(400, { error: 'coin inválida' })
		market.touch(coin)
		syncLive()
		wake()
		return json(200, market.snapshot(coin))
	}
	// Ranking de usuarios con los libros que ha leído este navegador (?coin=TICK para un mercado,
	// ?side=ask|bid para un lado). Los puestos de cada usuario son siempre de todos los mercados
	if (url.pathname === '/api/ranking') {
		const coin = url.searchParams.get('coin')
		const side = url.searchParams.get('side')
		const now = Date.now()
		const scoped = market.sides(isTick(coin) ? coin : undefined, side === 'ask' || side === 'bid' ? side : undefined)
		const all = market.sides()
		const stats = userStats(scoped, now)
		return json(200, {
			connected: (await accounts.reader()) != null,
			markets: { read: new Set(all.map((s) => s.tick)).size, total: COINS.length },
			rankings: Object.fromEntries(CRITERIA.map((c) => [c, rank(stats, c).rows])),
			positions: positions(userStats(all, now)),
		})
	}
	return json(404, { error: 'no encontrado' })
}

// Radar de Pro (lo usa el módulo Pro): qué lados vigilar, y la función a la que se le pasa cada lectura nueva
const radar = {
	watch(list: Watch[], onRead: ((w: WatchedSide) => void) | null) {
		market.watch(list, onRead)
		syncLive()
		wake()
	},
	read: (w: Watch) => market.watchedSide(w),
}

// cross: la mejor oportunidad del libro cruzado (app.js la enseña en la lectura del mercado)
// live: el libro en tiempo real de Pro (pro.js lo enciende con la huella de tu token)
;(window as unknown as { TPApi: { fetch: typeof api; cross: typeof bestCross; radar: typeof radar; live: typeof live } }).TPApi = { fetch: api, cross: bestCross, radar, live }
