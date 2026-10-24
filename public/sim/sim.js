// Simulador de trading de Terminal P2P. Los precios en vivo y el gráfico llegan directamente de
// Binance; la cuenta, las órdenes y el ranking los lleva el servidor (/api/*, worker/sim.ts).

const $ = (id) => document.getElementById(id)
const $$ = (sel) => [...document.querySelectorAll(sel)]
const store = {
	get(k, d) {
		try {
			const v = localStorage.getItem(k)
			return v === null ? d : JSON.parse(v)
		} catch {
			return d
		}
	},
	set(k, v) {
		try {
			localStorage.setItem(k, JSON.stringify(v))
		} catch {}
	},
}
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim()

const POLL_MS = 15_000
// Precios cada 3 s y velas completas cada minuto, de este mismo dominio (que los trae de MEXC)
const TICK_MS = 3000
const CANDLES_MS = 60_000
const IV_MS = { '1m': 60_000, '5m': 300_000, '15m': 900_000, '1h': 3_600_000, '4h': 14_400_000, '1d': 86_400_000 }

const S = {
	config: null,
	markets: {}, // símbolo → { base, name, qtyStep, tick }
	live: {}, // símbolo → { last, open }
	user: null,
	view: null, // cuenta, órdenes y operaciones del servidor
	ranking: null,
	symbol: store.get('sim.symbol', 'BTCUSDT'),
	interval: store.get('sim.interval', '15m'),
	side: 'BUY',
	type: store.get('sim.type', 'LIMIT'),
	// Unidad de la cantidad: 'base' (monedas) o 'quote' (USDT)
	unit: store.get('sim.unit', 'quote'),
	book: null, // { bids, asks } del mercado que se mira
	trades: null,
	bookTab: store.get('sim.bookTab', 'book'),
	tab: store.get('sim.tab', 'positions'),
	tradesSeen: null,
	busy: false,
}

// ── Formato ───────────────────────────────────────────────────────────
const decimalsOf = (step) => Math.max(0, Math.min(8, Math.round(-Math.log10(step))))
const fmtPrice = (p, sym = S.symbol) => (p == null || !isFinite(p) ? '—' : p.toLocaleString('es', { minimumFractionDigits: decimalsOf(S.markets[sym]?.tick ?? 0.01), maximumFractionDigits: decimalsOf(S.markets[sym]?.tick ?? 0.01) }))
const fmtQty = (q, sym = S.symbol) => (q == null ? '—' : q.toLocaleString('es', { maximumFractionDigits: decimalsOf(S.markets[sym]?.qtyStep ?? 0.0001) }))
const fmtUsd = (n) => (n == null || !isFinite(n) ? '—' : n.toLocaleString('es', { minimumFractionDigits: 2, maximumFractionDigits: 2 }))
// 45.373 → 45,4K; 1.250.000 → 1,25M
const fmtCompact = (n) => (n >= 1e6 ? `${(n / 1e6).toLocaleString('es', { maximumFractionDigits: 2 })}M` : n >= 1e4 ? `${(n / 1e3).toLocaleString('es', { maximumFractionDigits: 1 })}K` : fmtUsd(n))
const fmtPct = (x) => (x == null || !isFinite(x) ? '—' : `${x >= 0 ? '+' : ''}${x.toFixed(2).replace('.', ',')}%`)
const cls = (x) => (x > 0 ? 'up' : x < 0 ? 'down' : '')
const base = (sym) => S.markets[sym]?.base ?? sym.replace('USDT', '')
const when = (t) => new Date(t).toLocaleString('es', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })

function toast(text, kind = '') {
	const el = document.createElement('div')
	el.className = `toast ${kind}`
	el.textContent = text
	$('toasts').appendChild(el)
	setTimeout(() => el.remove(), 5000)
}

// ── Servidor ──────────────────────────────────────────────────────────
async function api(path, opts = {}) {
	const r = await fetch(`/api${path}`, { ...opts, headers: { 'Content-Type': 'application/json', ...(opts.headers ?? {}) } })
	const data = await r.json().catch(() => ({}))
	if (!r.ok) throw Object.assign(new Error(data.error || `Error ${r.status}`), { status: r.status })
	return data
}

async function loadState() {
	if (!S.user) return
	try {
		applyView(await api('/state'))
	} catch (e) {
		if (e.status === 401) return logout(true)
	}
}

// Aviso de las órdenes que se ejecutaron solas (stop, límite, objetivo) desde la última lectura
function applyView(v) {
	const prev = S.tradesSeen
	S.view = v
	const count = v.account.trades
	if (prev != null && count > prev) {
		for (const t of v.trades.filter((t) => t.id > prev).reverse()) {
			const verb = t.side === 'BUY' ? 'Compra' : t.side === 'SELL' ? 'Venta' : t.side === 'SHORT' ? 'Corto' : 'Recompra'
			toast(`${verb} ejecutada: ${fmtQty(t.qty, t.symbol)} ${base(t.symbol)} a ${fmtPrice(t.price, t.symbol)}${t.trigger ? ` (${t.trigger})` : ''}`, 'ok')
		}
	}
	S.tradesSeen = count
	render()
}

// ── Precios en vivo ───────────────────────────────────────────────────
// Los pide a este dominio: el navegador no habla con ningún exchange, así funciona desde Cuba sin VPN
let tickFails = 0
async function loadTickers() {
	try {
		const r = await fetch('/api/tickers')
		if (!r.ok) throw new Error(String(r.status))
		const { tickers } = await r.json()
		for (const [sym, t] of Object.entries(tickers)) S.live[sym] = { last: t.last, open: t.open }
		tickFails = 0
		feed(true)
		prefillPrices()
		updateLiveCandle()
		scheduleRender()
	} catch {
		if (++tickFails >= 3) feed(false)
	}
}
function feed(ok) {
	$('feed').classList.toggle('live', ok)
	$('feed').querySelector('span').textContent = ok ? 'Precios en vivo' : 'Reconectando…'
}
// Repinta como mucho 4 veces por segundo aunque lleguen muchos precios
let renderQueued = false
function scheduleRender() {
	if (renderQueued) return
	renderQueued = true
	setTimeout(() => {
		renderQueued = false
		renderLive()
	}, 250)
}

// ── Gráfico ───────────────────────────────────────────────────────────
let chart = null
let candleSeries = null
let priceLines = []
const tzOffset = () => -new Date().getTimezoneOffset() * 60

function makeChart() {
	if (chart || !window.LightweightCharts) return
	chart = LightweightCharts.createChart($('chart'), {
		autoSize: true,
		layout: { background: { color: 'transparent' }, textColor: css('--muted'), fontFamily: 'JetBrains Mono' },
		grid: { vertLines: { color: css('--line') }, horzLines: { color: css('--line') } },
		rightPriceScale: { borderColor: css('--line') },
		timeScale: { borderColor: css('--line'), timeVisible: true, secondsVisible: false },
		localization: { locale: 'es' },
	})
	candleSeries = chart.addCandlestickSeries({ upColor: css('--bid'), downColor: css('--ask'), borderVisible: false, wickUpColor: css('--bid'), wickDownColor: css('--ask') })
}

function themeChart() {
	if (!chart) return
	chart.applyOptions({ layout: { textColor: css('--muted') }, grid: { vertLines: { color: css('--line') }, horzLines: { color: css('--line') } }, rightPriceScale: { borderColor: css('--line') }, timeScale: { borderColor: css('--line') } })
	candleSeries.applyOptions({ upColor: css('--bid'), downColor: css('--ask'), wickUpColor: css('--bid'), wickDownColor: css('--ask') })
}

// La última vela, que se va completando con cada precio nuevo
let liveCandle = null
let candlesKey = ''

async function loadCandles(refresh = false) {
	makeChart()
	if (!chart) return
	const sym = S.symbol
	const iv = S.interval
	try {
		const r = await fetch(`/api/klines?symbol=${sym}&interval=${iv}`)
		if (!r.ok) throw new Error(String(r.status))
		const rows = await r.json()
		if (sym !== S.symbol || iv !== S.interval) return
		const tz = tzOffset()
		candleSeries.setData(rows.map(([t, o, h, l, c]) => ({ time: Math.floor(t / 1000) + tz, open: o, high: h, low: l, close: c })))
		const last = rows.at(-1)
		liveCandle = last ? { t: last[0], o: last[1], h: last[2], l: last[3], c: last[4] } : null
		const tick = S.markets[sym].tick
		candleSeries.applyOptions({ priceFormat: { type: 'price', precision: decimalsOf(tick), minMove: tick } })
		// Se encuadra al cambiar de mercado o de intervalo; al refrescar se respeta el zoom
		if (!refresh || candlesKey !== `${sym}:${iv}`) chart.timeScale().fitContent()
		candlesKey = `${sym}:${iv}`
		drawOrderLines()
	} catch {
		if (!refresh) toast('No se pudo cargar el gráfico; inténtalo en unos segundos', 'bad')
	}
}

function updateLiveCandle() {
	const price = S.live[S.symbol]?.last
	if (!candleSeries || !liveCandle || !price) return
	const span = IV_MS[S.interval]
	const bucket = Math.floor(Date.now() / span) * span
	if (bucket > liveCandle.t) liveCandle = { t: bucket, o: price, h: price, l: price, c: price }
	else liveCandle = { ...liveCandle, h: Math.max(liveCandle.h, price), l: Math.min(liveCandle.l, price), c: price }
	candleSeries.update({ time: Math.floor(liveCandle.t / 1000) + tzOffset(), open: liveCandle.o, high: liveCandle.h, low: liveCandle.l, close: liveCandle.c })
}

// Las órdenes abiertas y el precio medio de tu posición, como líneas en el gráfico
function drawOrderLines() {
	if (!candleSeries) return
	for (const l of priceLines) candleSeries.removePriceLine(l)
	priceLines = []
	if (!S.view) return
	for (const o of S.view.openOrders.filter((o) => o.symbol === S.symbol)) {
		const buy = o.side === 'BUY' || o.side === 'COVER'
		const color = buy ? css('--bid') : css('--ask')
		if (o.price) priceLines.push(candleSeries.createPriceLine({ price: o.price, color, lineStyle: 2, lineWidth: 1, axisLabelVisible: true, title: o.type === 'OCO' ? 'objetivo' : o.type === 'LIMIT' ? 'límite' : '' }))
		if (o.stopPrice) priceLines.push(candleSeries.createPriceLine({ price: o.stopPrice, color: css('--warn'), lineStyle: 2, lineWidth: 1, axisLabelVisible: true, title: 'stop' }))
	}
	const pos = S.view.account.positions.find((p) => p.symbol === S.symbol && p.side === 'LONG')
	if (pos?.avgCost) priceLines.push(candleSeries.createPriceLine({ price: pos.avgCost, color: css('--accent'), lineStyle: 0, lineWidth: 1, axisLabelVisible: true, title: 'tu precio medio' }))
}

// ── Pintado ───────────────────────────────────────────────────────────
function renderLive() {
	$('markets').innerHTML = Object.entries(S.markets)
		.map(([sym, m]) => {
			const l = S.live[sym]
			const ch = l ? (l.last / l.open - 1) * 100 : null
			return `<button class="mk ${sym === S.symbol ? 'active' : ''}" data-sym="${sym}"><span><b>${esc(m.base)}</b><small>${esc(m.name)}</small></span><span class="mono">${l ? fmtPrice(l.last, sym) : '—'}</span><span class="mono ${cls(ch)}">${fmtPct(ch)}</span></button>`
		})
		.join('')
	const l = S.live[S.symbol]
	$('pairName').textContent = `${base(S.symbol)} / USDT`
	$('pairPrice').textContent = l ? fmtPrice(l.last) : '—'
	const ch = l ? (l.last / l.open - 1) * 100 : null
	$('pairChange').textContent = ch == null ? '' : `${fmtPct(ch)} en 24 h`
	$('pairChange').className = `chg ${cls(ch)}`
	renderHint()
	if (S.view) renderSummary()
	if (S.tab === 'positions' && S.view) renderTab()
}

// Patrimonio con los precios en vivo (el servidor lo calcula al leer la cuenta; aquí se mantiene al día)
function liveAccount() {
	const a = S.view.account
	let equity = a.cash.free + a.cash.locked
	const positions = a.positions.map((p) => {
		const px = S.live[p.symbol]?.last ?? p.price
		const value = p.side === 'LONG' ? p.qty * px : p.value + (p.price - px) * p.qty
		equity += value
		const pnl = p.side === 'LONG' ? (p.avgCost ? (px - p.avgCost) * p.qty : null) : p.unrealizedPnl + (p.price - px) * p.qty
		return { ...p, price: px, value, pnl, pnlPct: p.side === 'LONG' ? (p.avgCost ? (px / p.avgCost - 1) * 100 : null) : null }
	})
	return { ...a, equity, pnl: equity - a.startBalance, pnlPct: (equity / a.startBalance - 1) * 100, positions }
}

function renderSummary() {
	const a = liveAccount()
	$('sEquity').textContent = `${fmtUsd(a.equity)} USDT`
	$('sPnl').innerHTML = `<span class="${cls(a.pnl)}">${a.pnl >= 0 ? '+' : ''}${fmtUsd(a.pnl)} (${fmtPct(a.pnlPct)})</span>`
	$('sCash').textContent = fmtUsd(a.cash.free)
	$('sLocked').textContent = fmtUsd(a.cash.locked)
	$('sTrades').textContent = String(a.trades)
}

function render() {
	const logged = !!S.user
	$('hero').hidden = logged
	$('summary').hidden = !logged
	$('resetBtn').hidden = !logged
	renderUser()
	renderForm()
	renderLive()
	renderTab()
	drawOrderLines()
	const open = S.view?.openOrders.length ?? 0
	$('cntOpen').hidden = !open
	$('cntOpen').textContent = open
}

function renderUser() {
	if (!S.user) {
		$('user').innerHTML = ''
		return
	}
	const u = S.user
	const name = u.username ? `@${u.username}` : u.first_name
	const avatar = u.photo_url && /^https:\/\/(t\.me|[a-z0-9.-]*telegram\.org)\//.test(u.photo_url) ? `<img src="${esc(u.photo_url)}" alt="" referrerpolicy="no-referrer" />` : esc((u.first_name || '?').slice(0, 2))
	$('user').innerHTML = `<span class="user-chip"><span class="avatar">${avatar}</span><span class="uname">${esc(name)}</span>
		<button class="icon-btn small" id="logoutBtn" title="Salir" aria-label="Salir"><svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path d="M15 4h3a2 2 0 012 2v12a2 2 0 01-2 2h-3M10 17l5-5-5-5M15 12H4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></button></span>`
	$('logoutBtn').onclick = () => logout()
}

// ── Formulario de órdenes ─────────────────────────────────────────────
function holding(sym = S.symbol) {
	return S.view?.account.positions.find((p) => p.symbol === sym && p.side === 'LONG')?.qty ?? 0
}
const mk = () => S.markets[S.symbol]
const tickOf = () => mk()?.tick ?? 0.01
const roundTick = (p) => Number((Math.round(p / tickOf()) * tickOf()).toFixed(decimalsOf(tickOf())))
const floorStep = (q) => Number((Math.floor(q / mk().qtyStep + 1e-9) * mk().qtyStep).toFixed(decimalsOf(mk().qtyStep)))
// Mejor precio para ejecutar ya: el ask al comprar, el bid al vender (del libro si está, si no el último)
function bestPrice(side = S.side) {
	const b = S.book
	const top = side === 'BUY' ? b?.asks?.[0]?.[0] : b?.bids?.[0]?.[0]
	return top ?? S.live[S.symbol]?.last ?? null
}
// Precio de referencia de la orden según su tipo
function refPrice() {
	if (S.type === 'LIMIT') return Number($('fPrice').value) || null
	if (S.type === 'STOP') return Number($('fStop').value) || null
	return bestPrice()
}
// Cantidad en monedas que representa lo que hay escrito
function formQty() {
	const v = Number($('fAmount').value)
	const px = refPrice()
	if (!(v > 0)) return 0
	if (S.unit === 'base') return v
	return px ? v / px / (S.side === 'BUY' ? 1.001 : 1) : 0
}
function available() {
	if (!S.view) return 0
	return S.side === 'BUY' ? S.view.account.cash.free : holding()
}

function renderForm() {
	for (const b of document.querySelectorAll('[data-side]')) b.classList.toggle('active', b.dataset.side === S.side)
	for (const b of document.querySelectorAll('[data-type]')) b.classList.toggle('active', b.dataset.type === S.type)
	const buy = S.side === 'BUY'
	$('fPriceBox').hidden = S.type !== 'LIMIT'
	$('fStopBox').hidden = S.type !== 'STOP'
	$('fMarketBox').hidden = S.type !== 'MARKET'
	$('fQuick').hidden = S.type === 'MARKET'
	$('fUnit').textContent = S.unit === 'base' ? base(S.symbol) : 'USDT'
	$('fTpslBox').hidden = !buy
	$('exits').hidden = !buy || !$('fTpsl').checked
	const go = $('fGo')
	go.className = `btn block go ${buy ? 'buy' : 'sell'}`
	go.disabled = !S.user || S.busy
	go.textContent = !S.user ? 'Entra con Telegram para operar' : S.busy ? 'Enviando…' : `${buy ? 'Comprar' : 'Vender'} ${base(S.symbol)}`
	renderHint()
}

// Totales, comisión, porcentaje del deslizador y resultado estimado del take profit y el stop loss
function renderHint() {
	const buy = S.side === 'BUY'
	const px = refPrice()
	const qty = formQty()
	const total = qty * (px ?? 0)
	const fee = total * 0.001
	$('fAvail').textContent = !S.view ? '—' : buy ? `${fmtUsd(available())} USDT` : `${fmtQty(available())} ${base(S.symbol)}`
	$('fTotalLabel').textContent = buy ? 'Total con comisión' : 'Recibes'
	$('fTotal').textContent = qty > 0 && px ? `${fmtUsd(buy ? total + fee : total - fee)} USDT` : '—'
	$('fFee').textContent = qty > 0 && px ? `${fmtUsd(fee)} USDT` : '—'
	$('fMarketPrice').textContent = bestPrice() ? `≈ ${fmtPrice(bestPrice())} (mejor ${buy ? 'venta' : 'compra'} del libro)` : 'Al mejor precio del mercado'
	// El deslizador refleja qué parte de lo disponible se usa
	const avail = available()
	if (document.activeElement !== $('fSlider')) {
		const used = buy ? total + fee : qty
		$('fSlider').value = String(avail > 0 ? Math.min(100, Math.round((used / avail) * 100)) : 0)
	}
	const est = (target, el) => {
		const t = Number($(target).value)
		if (!(t > 0 && px && qty > 0)) return ($(el).textContent = '')
		const pnl = (t - px) * qty - (px + t) * qty * 0.001
		$(el).textContent = `${pnl >= 0 ? '+' : ''}${fmtUsd(pnl)} USDT (${fmtPct((t / px - 1) * 100)})`
		$(el).className = `est ${cls(pnl)}`
	}
	est('fTp', 'fTpEst')
	est('fSl', 'fSlEst')
	$('fHint').textContent = S.type === 'MARKET' ? 'Se ejecuta al momento al mejor precio disponible.' : S.type === 'LIMIT' ? 'Se ejecuta cuando el mercado llegue a tu precio, aunque cierres la página.' : 'Al llegar a la activación se ejecuta a mercado.'
}

// Los precios de la orden se rellenan con el actual si están vacíos
function prefillPrices() {
	const l = S.live[S.symbol]
	if (!l || !mk()) return
	if (S.type === 'LIMIT' && !$('fPrice').value) $('fPrice').value = String(roundTick(bestPrice() ?? l.last))
	if (S.type === 'STOP' && !$('fStop').value) $('fStop').value = String(roundTick(l.last))
}

function setAmountFromPct(pct) {
	const avail = available()
	const px = refPrice()
	if (!(avail > 0)) return ($('fAmount').value = '')
	let v
	if (S.side === 'BUY') v = S.unit === 'quote' ? Math.floor(avail * pct) / 100 : px ? floorStep((avail * pct) / 100 / px / 1.001) : 0
	else v = S.unit === 'base' ? floorStep((avail * pct) / 100) : px ? Math.floor(((avail * pct) / 100) * px * 100) / 100 : 0
	$('fAmount').value = v > 0 ? String(v) : ''
	renderHint()
}

async function submitOrder() {
	if (!S.user || S.busy) return
	const qty = formQty()
	if (!(qty > 0)) return toast('Pon la cantidad', 'bad')
	const body = { symbol: S.symbol, side: S.side, type: S.type }
	if (S.side === 'BUY' && S.unit === 'quote') body.quoteAmount = Number($('fAmount').value)
	else body.quantity = floorStep(qty)
	if (S.type === 'LIMIT') body.price = $('fPrice').value
	if (S.type === 'STOP') body.stopPrice = $('fStop').value
	if (S.side === 'BUY' && $('fTpsl').checked) {
		body.stopLoss = $('fSl').value || undefined
		body.takeProfit = $('fTp').value || undefined
	}
	S.busy = true
	renderForm()
	try {
		const r = await api('/orders', { method: 'POST', body: JSON.stringify(body) })
		const o = r.order
		S.tradesSeen = r.account.trades // el aviso de esta orden lo da el mensaje de abajo
		applyView(r)
		toast(o.status === 'FILLED' ? `${o.side === 'BUY' ? 'Compraste' : 'Vendiste'} ${fmtQty(o.qty)} ${base(o.symbol)} a ${fmtPrice(o.avgPrice)}` : `Orden ${o.type === 'LIMIT' ? 'límite' : 'stop'} puesta: se ejecutará aunque cierres la página`, 'ok')
		$('fAmount').value = ''
		$('fSl').value = ''
		$('fTp').value = ''
	} catch (e) {
		toast(e.message, 'bad')
	} finally {
		S.busy = false
		renderForm()
	}
}

// ── Libro de órdenes y últimas operaciones ────────────────────────────
async function loadBook() {
	const sym = S.symbol
	const tab = S.bookTab
	try {
		const r = await fetch(`/api/${tab === 'book' ? 'depth' : 'trades'}?symbol=${sym}`)
		if (!r.ok) throw new Error(String(r.status))
		const data = await r.json()
		if (sym !== S.symbol) return
		if (tab === 'book') S.book = data
		else S.trades = data
		renderBook()
		if (tab === 'book') renderHint()
	} catch {}
}

function renderBook() {
	for (const b of document.querySelectorAll('[data-book]')) b.classList.toggle('active', b.dataset.book === S.bookTab)
	const body = $('bookBody')
	const u = esc(base(S.symbol))
	if (S.bookTab === 'trades') {
		const ts = S.trades ?? []
		body.innerHTML = `<div class="bk-cols"><span>Precio</span><span>Cantidad (${u})</span><span>Hora</span></div>${ts
			.map((t) => `<div class="bk trade ${t.sell ? 'ask' : 'bid'}"><span class="p">${fmtPrice(t.p)}</span><span>${fmtQty(t.q)}</span><span>${new Date(t.t).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span></div>`)
			.join('')}`
		return
	}
	const b = S.book
	if (!b) return (body.innerHTML = '<p class="empty">Cargando el libro…</p>')
	const N = 10
	const asks = b.asks.slice(0, N)
	const bids = b.bids.slice(0, N)
	const max = Math.max(...asks.map((x) => x[1] * x[0]), ...bids.map((x) => x[1] * x[0]), 1)
	const row = ([p, q], side) => {
		const w = Math.round(((p * q) / max) * 100)
		const color = side === 'ask' ? 'var(--ask-bg)' : 'var(--bid-bg)'
		return `<button class="bk ${side}" data-price="${p}" style="background-image:linear-gradient(to left, ${color} ${w}%, transparent ${w}%)" title="Usar este precio"><span class="p">${fmtPrice(p)}</span><span>${fmtQty(q)}</span><span>${fmtCompact(p * q)}</span></button>`
	}
	const last = S.live[S.symbol]
	const ch = last ? last.last - last.open : 0
	const spread = asks[0] && bids[0] ? ((asks[0][0] / bids[0][0] - 1) * 100).toFixed(3).replace('.', ',') : null
	body.innerHTML = `<div class="bk-cols"><span>Precio</span><span>Cantidad (${u})</span><span>Total</span></div>
		${[...asks].reverse().map((x) => row(x, 'ask')).join('')}
		<div class="bk-mid"><b class="${cls(ch)}">${last ? fmtPrice(last.last) : '—'}</b>${spread ? `<small>diferencial ${spread}%</small>` : ''}</div>
		${bids.map((x) => row(x, 'bid')).join('')}`
}

// ── Pestañas de abajo ─────────────────────────────────────────────────
function renderTab() {
	for (const b of document.querySelectorAll('[data-tab]')) b.classList.toggle('active', b.dataset.tab === S.tab)
	const body = $('tabBody')
	if (S.tab === 'ranking') return renderRanking()
	if (!S.view) return (body.innerHTML = '<p class="empty">Entra con Telegram para tener tu cuenta de 10.000 USDT ficticios.</p>')
	if (S.tab === 'positions') {
		const ps = liveAccount().positions
		body.innerHTML = ps.length
			? `<table><thead><tr><th>Mercado</th><th>Cantidad</th><th>Precio medio</th><th>Precio</th><th>Valor (USDT)</th><th>Resultado</th><th></th></tr></thead><tbody>${ps
					.map(
						(p) => `<tr><td class="txt"><b>${esc(base(p.symbol))}</b> ${p.side === 'SHORT' ? '<span class="tag sell">corto</span>' : ''}</td><td>${fmtQty(p.qty, p.symbol)}</td><td>${fmtPrice(p.avgCost, p.symbol)}</td><td>${fmtPrice(p.price, p.symbol)}</td><td>${fmtUsd(p.value)}</td>
						<td class="${cls(p.pnl)}">${p.pnl == null ? '—' : `${p.pnl >= 0 ? '+' : ''}${fmtUsd(p.pnl)}`}${p.pnlPct != null ? ` (${fmtPct(p.pnlPct)})` : ''}</td>
						<td class="txt">${p.side === 'LONG' ? `<button class="link small" data-close="${p.symbol}">Vender todo</button>` : ''}</td></tr>`,
					)
					.join('')}</tbody></table>`
			: '<p class="empty">No tienes posiciones. Elige un mercado y compra.</p>'
		return
	}
	if (S.tab === 'open') {
		// No se repinta mientras se edita un precio (la lectura periódica borraría lo escrito)
		if (S.editing && document.activeElement?.classList.contains('edit-price')) return
		const os = S.view.openOrders
		const cell = (o, key) =>
			S.editing === o.id && o[key] != null
				? `<input class="input mono edit-price" data-edit-key="${key}" value="${o[key]}" type="number" step="any" inputmode="decimal" />`
				: fmtPrice(o[key], o.symbol)
		body.innerHTML = os.length
			? `<table><thead><tr><th>Mercado</th><th>Lado</th><th>Tipo</th><th>Cantidad</th><th>Precio</th><th>Stop</th><th>Puesta</th><th class="txt"><button class="link small" data-cancel-all>Cancelar todas</button></th></tr></thead><tbody>${os
					.map(
						(o) => `<tr data-row="${o.id}"><td class="txt"><b>${esc(base(o.symbol))}</b></td><td class="txt"><span class="tag ${o.side === 'BUY' || o.side === 'COVER' ? 'buy' : 'sell'}">${o.side === 'BUY' ? 'Compra' : 'Venta'}</span></td>
						<td class="txt">${{ LIMIT: 'Límite', STOP: 'Stop', OCO: 'Objetivo + stop', MARKET: 'Mercado' }[o.type]}${o.note ? ' <span class="tag neutral">auto</span>' : ''}</td><td>${fmtQty(o.qty, o.symbol)}</td><td>${cell(o, 'price')}</td><td>${cell(o, 'stopPrice')}</td><td class="txt">${when(o.createdAt)}</td>
						<td class="txt">${
							S.editing === o.id
								? `<button class="link small" data-save="${o.id}">Guardar</button> · <button class="link small" data-edit-cancel>✕</button>`
								: `<button class="link small" data-edit="${o.id}">Editar</button> · <button class="link small" data-cancel="${o.id}">Cancelar</button>`
						}</td></tr>`,
					)
					.join('')}</tbody></table>`
			: '<p class="empty">No tienes órdenes abiertas.</p>'
		return
	}
	const ts = S.view.trades
	body.innerHTML = ts.length
		? `<table><thead><tr><th>Fecha</th><th>Mercado</th><th>Lado</th><th>Cantidad</th><th>Precio</th><th>Total (USDT)</th><th>Comisión</th><th>Resultado</th></tr></thead><tbody>${ts
				.map(
					(t) => `<tr><td class="txt">${when(t.time)}</td><td class="txt"><b>${esc(base(t.symbol))}</b></td><td class="txt"><span class="tag ${t.side === 'BUY' || t.side === 'COVER' ? 'buy' : 'sell'}">${t.side === 'BUY' ? 'Compra' : t.side === 'SELL' ? 'Venta' : t.side === 'SHORT' ? 'Corto' : 'Recompra'}</span>${t.trigger ? ` <span class="tag neutral">${esc(t.trigger)}</span>` : ''}</td>
					<td>${fmtQty(t.qty, t.symbol)}</td><td>${fmtPrice(t.price, t.symbol)}</td><td>${fmtUsd(t.quote)}</td><td>${fmtUsd(t.fee)}</td><td class="${cls(t.realizedPnl)}">${t.realizedPnl == null ? '—' : `${t.realizedPnl >= 0 ? '+' : ''}${fmtUsd(t.realizedPnl)}`}</td></tr>`,
				)
				.join('')}</tbody></table>`
		: '<p class="empty">Aún no has hecho ninguna operación.</p>'
}

async function loadRanking() {
	try {
		S.ranking = await api('/ranking')
		if (S.tab === 'ranking') renderRanking()
	} catch {}
}

const dayShort = (t) => new Date(t).toLocaleDateString('es', { day: 'numeric', month: 'short', timeZone: 'America/Havana' })
function leftText(ms) {
	if (ms <= 0) return 'terminando'
	const d = Math.floor(ms / 86_400_000)
	const h = Math.floor((ms % 86_400_000) / 3600_000)
	return d ? `${d} d ${h} h` : `${h} h ${Math.floor((ms % 3600_000) / 60_000)} min`
}

function renderRanking() {
	const r = S.ranking
	const body = $('tabBody')
	if (!r) return (body.innerHTML = '<p class="empty">Cargando el ranking…</p>')
	const view = S.rankView ?? 'week'
	const sub = [
		['week', 'Esta semana'],
		['last', 'Semana pasada'],
		['fame', 'Salón de la fama'],
	]
		.map(([k, label]) => `<button class="seg-tab ${k === view ? 'active' : ''}" data-rank-view="${k}">${label}</button>`)
		.join('')
	const head = `<div class="rank-head"><div class="seg-tabs">${sub}</div>
		<span class="fine">Temporada del ${dayShort(r.season.start)} al ${dayShort(r.season.end - 1)} · termina en ${leftText(r.season.end - Date.now())}</span></div>`
	const pctRow = (x) => `<tr class="${x.me ? 'me' : ''}"><td>${x.rank}</td><td class="txt">${esc(x.name)}${x.me ? ' <span class="tag neutral">tú</span>' : ''}</td><td class="${cls(x.pnlPct)}">${fmtPct(x.pnlPct)}</td>${x.equity != null ? `<td>${fmtUsd(x.equity)}</td>` : ''}<td>${x.trades}</td></tr>`
	let content = ''
	if (view === 'week') {
		const m = r.mine
		const status = !S.user
			? 'Entra con Telegram para jugar y, si quieres, competir.'
			: !m
				? ''
				: !m.compete
					? `Juegas en privado: nadie ve tu nombre. <button class="btn small join" data-compete="1">Participar en la temporada</button>`
					: m.benched
						? `Compites desde el lunes (ya habías operado o reiniciado esta semana). <button class="link small" data-compete="0">Dejar de competir</button>`
						: m.trades < r.minTrades
							? `Compites esta semana: llevas ${m.trades} de ${r.minTrades} operaciones, con ${r.minTrades - m.trades} más entras en la clasificación. <button class="link small" data-compete="0">Dejar de competir</button>`
							: `Vas ${m.rank}.º con ${fmtPct(m.pnlPct)}. <button class="link small" data-compete="0">Dejar de competir</button>`
		content = `${status ? `<p class="rank-status">${status}</p>` : ''}${
			r.rows.length
				? `<table><thead><tr><th>#</th><th>Jugador</th><th>Rentabilidad</th><th>Patrimonio (USDT)</th><th>Operaciones</th></tr></thead><tbody>${r.rows.map(pctRow).join('')}</tbody></table>`
				: `<p class="empty">Aún nadie lleva ${r.minTrades} operaciones esta semana. ¡Estrena el primer puesto!</p>`
		}`
	} else if (view === 'last') {
		content = r.last?.rows.length
			? `<p class="rank-status">Temporada que empezó el ${dayShort(Date.parse(`${r.last.season}T12:00:00Z`))}</p><table><thead><tr><th>#</th><th>Jugador</th><th>Rentabilidad</th><th>Operaciones</th></tr></thead><tbody>${r.last.rows.map(pctRow).join('')}</tbody></table>`
			: '<p class="empty">Todavía no ha terminado ninguna temporada.</p>'
	} else {
		content = r.fame.length
			? `<table><thead><tr><th>Jugador</th><th>Semanas ganadas</th><th>Podios</th></tr></thead><tbody>${r.fame
					.map((f) => `<tr class="${f.me ? 'me' : ''}"><td class="txt">${esc(f.name)}${f.me ? ' <span class="tag neutral">tú</span>' : ''}</td><td>${f.wins}</td><td>${f.podiums}</td></tr>`)
					.join('')}</tbody></table>`
			: '<p class="empty">El salón de la fama se estrena cuando termine la primera temporada.</p>'
	}
	body.innerHTML = `${head}${content}
		<p class="fine" style="padding: 8px 12px">Competir es opcional. Cada lunes a las 00:00 (hora de Cuba) empieza una temporada: todos vuelven a 10.000 USDT. Cuenta la rentabilidad a precio de mercado de quien compite y lleva al menos ${r.minTrades} operaciones. Si te apuntas o reinicias después de operar, compites desde el lunes. El top 10 de cada semana se anuncia en el grupo de Telegram @terminalp2p.</p>`
}

// ── Sesión ────────────────────────────────────────────────────────────
function showLogin() {
	const box = $('tgLogin')
	if (box.childElementCount || !S.config) return
	$('devLogin').hidden = !S.config.dev
	// En desarrollo el botón de Telegram no funciona (solo vale en el dominio registrado en BotFather)
	if (S.config.dev) return
	// Botón oficial de Telegram: al entrar redirige a /api/auth/telegram con los datos firmados
	const s = document.createElement('script')
	s.async = true
	s.src = 'https://telegram.org/js/telegram-widget.js?22'
	s.dataset.telegramLogin = S.config.bot
	s.dataset.size = 'large'
	s.dataset.radius = '8'
	s.dataset.authUrl = `${location.origin}/api/auth/telegram`
	box.appendChild(s)
}

async function logout(silent = false) {
	await api('/logout', { method: 'POST' }).catch(() => {})
	S.user = null
	S.view = null
	S.tradesSeen = null
	if (!silent) toast('Has salido del simulador')
	showLogin()
	render()
}

// ── Eventos ───────────────────────────────────────────────────────────
function bind() {
	$('markets').addEventListener('click', (e) => {
		const b = e.target.closest('[data-sym]')
		if (!b || b.dataset.sym === S.symbol) return
		S.symbol = b.dataset.sym
		store.set('sim.symbol', S.symbol)
		$('fAmount').value = ''
		$('fPrice').value = ''
		$('fStop').value = ''
		liveCandle = null
		S.book = null
		S.trades = null
		loadCandles()
		loadBook()
		render()
	})
	for (const b of document.querySelectorAll('[data-iv]')) {
		b.classList.toggle('active', b.dataset.iv === S.interval)
		b.onclick = () => {
			S.interval = b.dataset.iv
			store.set('sim.interval', S.interval)
			for (const x of document.querySelectorAll('[data-iv]')) x.classList.toggle('active', x === b)
			liveCandle = null
			loadCandles()
		}
	}
	for (const b of document.querySelectorAll('[data-side]'))
		b.onclick = () => {
			S.side = b.dataset.side
			$('fAmount').value = ''
			renderForm()
		}
	for (const b of document.querySelectorAll('[data-type]'))
		b.onclick = () => {
			S.type = b.dataset.type
			store.set('sim.type', S.type)
			prefillPrices()
			renderForm()
		}
	for (const id of ['fAmount', 'fPrice', 'fStop', 'fTp', 'fSl']) $(id).addEventListener('input', renderHint)
	// Enter envía la orden desde cualquier campo del formulario
	$$('.order-panel input').forEach((i) => i.addEventListener('keydown', (e) => e.key === 'Enter' && !e.isComposing && submitOrder()))
	for (const b of document.querySelectorAll('.step'))
		b.onclick = () => {
			const input = $(b.dataset.for)
			const cur = Number(input.value) || S.live[S.symbol]?.last || 0
			input.value = String(roundTick(cur + Number(b.dataset.step) * tickOf()))
			renderHint()
		}
	$('fQuick').addEventListener('click', (e) => {
		const b = e.target.closest('[data-fill]')
		if (!b) return
		const p = b.dataset.fill === 'best' ? bestPrice() : S.live[S.symbol]?.last
		if (p) $(S.type === 'STOP' ? 'fStop' : 'fPrice').value = String(roundTick(p))
		renderHint()
	})
	$('fUnit').onclick = () => {
		// Se convierte lo escrito a la otra unidad para no perderlo
		const qty = formQty()
		const px = refPrice()
		S.unit = S.unit === 'base' ? 'quote' : 'base'
		store.set('sim.unit', S.unit)
		if (qty > 0 && px) $('fAmount').value = String(S.unit === 'base' ? floorStep(qty) : Math.floor(qty * px * (S.side === 'BUY' ? 1.001 : 1) * 100) / 100)
		renderForm()
	}
	$('fSlider').addEventListener('input', () => setAmountFromPct(Number($('fSlider').value)))
	$('fMarks').addEventListener('click', (e) => {
		const b = e.target.closest('[data-pct]')
		if (b) setAmountFromPct(Number(b.dataset.pct))
	})
	$('fTpsl').onchange = renderForm
	for (const c of document.querySelectorAll('.chips'))
		c.addEventListener('click', (e) => {
			const b = e.target.closest('[data-pct]')
			const px = refPrice()
			if (!b || !px) return
			$(c.dataset.exit).value = String(roundTick(px * (1 + Number(b.dataset.pct) / 100)))
			renderHint()
		})
	for (const b of document.querySelectorAll('[data-book]'))
		b.onclick = () => {
			S.bookTab = b.dataset.book
			store.set('sim.bookTab', S.bookTab)
			renderBook()
			loadBook()
		}
	// Tocar un precio del libro lo pone en la orden (y pasa a límite si estaba a mercado)
	$('bookBody').addEventListener('click', (e) => {
		const r = e.target.closest('[data-price]')
		if (!r) return
		if (S.type === 'MARKET') {
			S.type = 'LIMIT'
			store.set('sim.type', S.type)
		}
		$(S.type === 'STOP' ? 'fStop' : 'fPrice').value = String(roundTick(Number(r.dataset.price)))
		renderForm()
	})
	$('fGo').onclick = submitOrder
	for (const b of document.querySelectorAll('[data-tab]'))
		b.onclick = () => {
			S.tab = b.dataset.tab
			store.set('sim.tab', S.tab)
			if (S.tab === 'ranking') loadRanking()
			renderTab()
		}
	$('tabBody').addEventListener('click', async (e) => {
		const rv = e.target.closest('[data-rank-view]')
		if (rv) {
			S.rankView = rv.dataset.rankView
			return renderRanking()
		}
		const comp = e.target.closest('[data-compete]')
		if (comp) {
			const on = comp.dataset.compete === '1'
			const ask = on
				? 'Al competir, tu @usuario de Telegram aparece en el ranking y, si quedas entre los 10 primeros de la semana, en el grupo @terminalp2p. Puedes dejarlo cuando quieras. ¿Participar?'
				: 'Dejarás de aparecer en el ranking y en los anuncios. Puedes volver cuando quieras (si ya operaste esa semana, compites desde el lunes). ¿Dejar de competir?'
			if (!confirm(ask)) return
			try {
				const r = await api('/compete', { method: 'POST', body: JSON.stringify({ on }) })
				S.ranking = r.ranking
				if (S.user) S.user.compete = r.compete ? 1 : 0
				toast(!on ? 'Ya no compites: juegas en privado' : r.startsMonday ? 'Apuntado: compites desde el lunes' : '¡Apuntado! Ya compites en esta temporada', 'ok')
				renderRanking()
			} catch (err) {
				toast(err.message, 'bad')
			}
			return
		}
		const edit = e.target.closest('[data-edit]')
		if (edit) {
			S.editing = Number(edit.dataset.edit)
			renderTab()
			$('tabBody').querySelector('.edit-price')?.focus()
			return
		}
		if (e.target.closest('[data-edit-cancel]')) {
			S.editing = null
			return renderTab()
		}
		const save = e.target.closest('[data-save]')
		if (save) {
			const row = save.closest('tr')
			const change = Object.fromEntries([...row.querySelectorAll('[data-edit-key]')].map((i) => [i.dataset.editKey, i.value]))
			try {
				const r = await api(`/orders/${save.dataset.save}`, { method: 'PATCH', body: JSON.stringify(change) })
				S.editing = null
				S.tradesSeen = r.account.trades
				applyView(r)
				toast(r.order.status === 'FILLED' ? `Al nuevo precio se ejecutó al momento a ${fmtPrice(r.order.avgPrice, r.order.symbol)}` : 'Orden actualizada', 'ok')
			} catch (err) {
				toast(err.message, 'bad')
			}
			return
		}
		if (e.target.closest('[data-cancel-all]')) {
			if (!confirm('¿Cancelar todas tus órdenes abiertas, incluidas las salidas automáticas (stop loss y take profit)?')) return
			try {
				const r = await api('/orders', { method: 'DELETE' })
				applyView(r)
				toast(`${r.canceled} ${r.canceled === 1 ? 'orden cancelada' : 'órdenes canceladas'}`)
			} catch (err) {
				toast(err.message, 'bad')
			}
			return
		}
		const cancel = e.target.closest('[data-cancel]')
		const close = e.target.closest('[data-close]')
		try {
			if (cancel) {
				applyView(await api(`/orders/${cancel.dataset.cancel}`, { method: 'DELETE' }))
				toast('Orden cancelada')
			} else if (close) {
				const sym = close.dataset.close
				// Las salidas automáticas de esa posición tienen sus monedas reservadas: se cancelan antes
				for (const o of S.view.openOrders.filter((o) => o.symbol === sym && o.side === 'SELL')) applyView(await api(`/orders/${o.id}`, { method: 'DELETE' }))
				const r = await api('/orders', { method: 'POST', body: JSON.stringify({ symbol: sym, side: 'SELL', type: 'MARKET', quantity: holding(sym) }) })
				S.tradesSeen = r.account.trades
				applyView(r)
				toast(`Vendiste ${fmtQty(r.order.qty, sym)} ${base(sym)} a ${fmtPrice(r.order.avgPrice, sym)}`, 'ok')
			}
		} catch (err) {
			toast(err.message, 'bad')
		}
	})
	$('resetBtn').onclick = async () => {
		const competing = S.view?.account.trades > 0
		if (!confirm(`¿Reiniciar tu cuenta? Vuelves a 10.000 USDT y se borran tus posiciones y órdenes.${competing ? ' Como ya operaste esta semana, sales de la clasificación hasta el lunes.' : ''}`)) return
		try {
			S.tradesSeen = 0
			applyView(await api('/reset', { method: 'POST' }))
			toast('Cuenta reiniciada: 10.000 USDT')
			loadRanking()
		} catch (e) {
			toast(e.message, 'bad')
		}
	}
	$('devLogin').onclick = () => (location.href = '/api/auth/dev')
	$('themeBtn').onclick = () => {
		const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light'
		document.documentElement.dataset.theme = next
		store.set('theme', next)
		themeChart()
		drawOrderLines()
	}
}

async function start() {
	bind()
	try {
		S.config = await api('/config')
	} catch {
		S.config = { bot: 'terminalp2p_bot', dev: false, markets: [] }
	}
	S.markets = Object.fromEntries(S.config.markets.map((m) => [m.symbol, m]))
	if (!S.markets[S.symbol]) S.symbol = 'BTCUSDT'
	try {
		S.user = (await api('/me')).user
	} catch {
		S.user = null
	}
	if (!S.user) showLogin()
	render()
	loadTickers()
	loadCandles()
	setInterval(() => !document.hidden && loadTickers(), TICK_MS)
	loadBook()
	setInterval(() => !document.hidden && loadBook(), TICK_MS)
	setInterval(() => !document.hidden && loadCandles(true), CANDLES_MS)
	loadRanking()
	await loadState()
	setInterval(() => !document.hidden && loadState(), POLL_MS)
	setInterval(() => !document.hidden && S.tab === 'ranking' && loadRanking(), 60_000)
	document.addEventListener('visibilitychange', () => !document.hidden && loadState())
}

start()
