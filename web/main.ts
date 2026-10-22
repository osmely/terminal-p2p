// Terminal P2P en el navegador. Expone window.TPApi.fetch(), que atiende las
// mismas rutas /api/* que antes servía el backend, pero aquí mismo:
//   · el libro se lee con el token del propio usuario (nunca con el de otro)
//   · "Mis operaciones" opera con ese mismo token
//   · el histórico de precios es público y lo sirve el servidor (/data/rates)
// Hacia QvaPay se sale por el relé sin estado del dominio (/qp), solo por CORS.

import { Broker, json } from '../src/broker/routes.ts'
import { QvaPayClient } from '../src/qvapay/client.ts'
import { COINS, Market, type Tick } from '../src/terminal/market.ts'
import { BrowserAccounts } from './accounts.ts'

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
let timer: ReturnType<typeof setTimeout> | undefined
let nextAt = 0
async function loop() {
	await ready
	if (!document.hidden) await market.tick().catch((e: Error) => console.warn('tick:', e.message))
	const delay = market.nextDelayMs()
	nextAt = Date.now() + delay
	timer = setTimeout(loop, delay)
}
function wake() {
	if (nextAt - Date.now() <= WAKE_IF_FURTHER_THAN_MS) return
	clearTimeout(timer)
	nextAt = Date.now()
	timer = setTimeout(loop, 50)
}
document.addEventListener('visibilitychange', () => !document.hidden && wake())
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
		wake()
		return json(200, market.snapshot(coin))
	}
	return json(404, { error: 'no encontrado' })
}

;(window as unknown as { TPApi: { fetch: typeof api } }).TPApi = { fetch: api }
