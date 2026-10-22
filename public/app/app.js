// Terminal P2P — interfaz. Lee la API local (/api/*), nunca habla con QvaPay directamente.
const $ = (id) => document.getElementById(id)
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim()

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

const state = {
	coin: store.get('coin', 'BANK_CUP'),
	chart: store.get('chart', 'depth'),
	range: store.get('range', 7),
	view: store.get('view', 'book'),
	filters: { vip: true, outlier: true, ops: 0, usd: 0, ageH: 0, ...store.get('filters', {}) },
	book: null,
	history: [],
	overview: [],
}

// ── Formato ───────────────────────────────────────────────────────────
const decimals = (p) => (p >= 100 ? 2 : 4)
const fmtP = (p) => (p == null || !isFinite(p) ? '—' : p.toLocaleString('es', { minimumFractionDigits: decimals(p), maximumFractionDigits: decimals(p) }))
const fmtU = (n) => (n >= 1000 ? Math.round(n).toLocaleString('es') : n.toLocaleString('es', { maximumFractionDigits: 2 }))
const pct = (x) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(2)}%`
const ago = (ms) =>
	ms < 60_000
		? `${Math.round(ms / 1000)} s`
		: ms < 3600_000
			? `${Math.round(ms / 60_000)} min`
			: ms < 48 * 3600_000
				? `${Math.round(ms / 3600_000)} h`
				: `${Math.round(ms / 86_400_000)} d`
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])

function filtered(levels) {
	const f = state.filters
	// Antigüedad medida contra el reloj del servidor, no el del navegador
	const now = state.book?.serverTime ?? Date.now()
	const maxAge = f.ageH ? f.ageH * 3600_000 : Infinity
	return levels.filter(
		(l) =>
			!(f.vip && l.vipOnly) &&
			!(f.outlier && l.outlier) &&
			l.ops >= f.ops &&
			l.usd >= f.usd &&
			(l.updatedAt == null || now - l.updatedAt <= maxAge),
	)
}

const median = (xs) => {
	if (!xs.length) return null
	const s = [...xs].sort((a, b) => a - b)
	const m = Math.floor(s.length / 2)
	return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

// ── Carga de datos ────────────────────────────────────────────────────
// Las rutas /api/* las atiende data.js aquí mismo, en el navegador
async function getJSON(url) {
	const r = await TPApi.fetch(url)
	if (!r.ok) throw new Error(`${r.status}`)
	return r.json()
}

async function loadBook() {
	try {
		state.book = await getJSON(`/api/book?coin=${state.coin}`)
		render()
	} catch (e) {
		$('updated').textContent = 'Sin conexión con el servidor'
		$('dot').className = 'dot stale'
	}
}

async function loadOverview() {
	try {
		const first = !state.overview.length
		state.overview = await getJSON('/api/overview')
		renderMarkets()
		if (first) revealChip(false)
		if (!state.book) render()
	} catch {}
}

// Histórico público de la tasa: lo guarda el servidor (solo agregados de QvaPay)
async function loadHistory() {
	try {
		const r = await fetch(`/data/rates?coin=${state.coin}&days=${state.range}`)
		if (!r.ok) throw new Error(String(r.status))
		state.history = await r.json()
		if (state.chart === 'history') drawHistory()
	} catch {}
}

function selectCoin(tick) {
	state.coin = tick
	store.set('coin', tick)
	state.book = null
	state.history = null
	closeMenus()
	renderMarkets()
	revealChip()
	render()
	loadBook()
	loadHistory()
}

// ── Render ────────────────────────────────────────────────────────────
// Precio en vivo; si aún no hay, el promedio público de 24 h (atenuado)
function price(live, avg, cls) {
	if (live) return `<span class="num ${cls}">${fmtP(live)}</span>`
	if (avg) return `<span class="num avg" title="Promedio de 24 h de lo completado">${fmtP(avg)}</span>`
	return '<span class="num">—</span>'
}

function marketRows(query) {
	const q = (query ?? '').trim().toLowerCase()
	const rows = state.overview.filter((c) => !q || c.name.toLowerCase().includes(q) || c.tick.toLowerCase().includes(q) || c.unit.toLowerCase().includes(q))
	if (!rows.length) return '<div class="empty">Sin resultados</div>'
	return rows
		.map(
			(c) => `<button class="mrow ${c.tick === state.coin ? 'active' : ''}" data-tick="${c.tick}" role="option" aria-selected="${c.tick === state.coin}">
				<span class="mname"><b>${esc(c.name)}</b><span>QUSD/${esc(c.unit)}${c.count24h ? ` · ${c.count24h} ops 24 h` : ''}</span></span>
				${price(c.bid, c.avgBuy, 'bid')}${price(c.ask, c.avgSell, 'ask')}</button>`,
		)
		.join('')
}

// Tira horizontal de mercados (pantallas sin la columna de mercados)
function marketChips() {
	return state.overview
		.map((c) => {
			const mid = c.bid && c.ask ? (c.bid + c.ask) / 2 : (c.ask ?? c.bid)
			const px = mid ? `<span class="num">${fmtP(mid)}</span>` : c.avgSell || c.avgBuy ? `<span class="num avg">${fmtP(c.avgSell ?? c.avgBuy)}</span>` : ''
			return `<button class="mchip ${c.tick === state.coin ? 'active' : ''}" data-tick="${c.tick}" aria-pressed="${c.tick === state.coin}"><b>${esc(c.name)}</b>${px}</button>`
		})
		.join('')
}

function renderMarkets() {
	$('marketList').innerHTML = marketRows($('marketSearch').value)
	const strip = $('marketStrip')
	const left = strip.scrollLeft
	strip.innerHTML = marketChips()
	strip.scrollLeft = left
}

// Lleva a la vista el mercado elegido dentro de la tira
function revealChip(smooth = true) {
	const chip = $('marketStrip').querySelector('.mchip.active')
	if (!chip) return
	const strip = $('marketStrip')
	const off = chip.offsetLeft - (strip.clientWidth - chip.offsetWidth) / 2
	strip.scrollTo({ left: Math.max(0, off), behavior: smooth ? 'smooth' : 'auto' })
}

// En el móvil se ve una sección a la vez
function showView(name) {
	state.view = name
	store.set('view', name)
	$('layout').dataset.view = name
	for (const t of document.querySelectorAll('[data-view]')) {
		t.classList.toggle('active', t.dataset.view === name)
		t.setAttribute('aria-selected', String(t.dataset.view === name))
	}
	if (name === 'chart') requestAnimationFrame(drawActive)
}

function render() {
	const b = state.book
	const meta = b?.coin ?? state.overview.find((c) => c.tick === state.coin) ?? { name: state.coin, unit: '' }
	$('pairName').textContent = `QUSD / ${meta.name}`
	$('pairSub').textContent = `Precio en ${meta.unit} por cada USD de saldo QvaPay`
	if (!b) {
		$('asks').innerHTML = $('bids').innerHTML = '<div class="empty">Cargando…</div>'
		return
	}
	const asks = filtered(b.ask.levels)
	const bids = filtered(b.bid.levels)
	const offline = !b.live && !b.ask.levels.length && !b.bid.levels.length
	document.querySelector('.area-book').classList.toggle('offline', offline)
	if (offline) {
		const msg = '<div class="empty">Las ofertas del libro se ven con tu cuenta de QvaPay conectada.</div>'
		$('asks').innerHTML = msg
		$('bids').innerHTML = ''
		$('spread').className = 'spread'
		$('spread').textContent = 'Sin libro en vivo'
		$('updated').textContent = 'Conecta tu cuenta para ver el libro en vivo'
		$('dot').className = 'dot stale'
		renderStats(b, asks, bids)
		renderInsight(b, asks, bids)
		renderActivity(b)
		drawActive()
		return
	}
	renderStatus(b)
	renderStats(b, asks, bids)
	renderBook(b, asks, bids)
	renderInsight(b, asks, bids)
	renderActivity(b)
	drawActive()
}

function renderStatus(b) {
	// Si QvaPay rechaza la lectura de los dos lados, no es "actualizado": no hay libro
	if (b.ask.error && b.bid.error) {
		$('updated').textContent = 'Sin acceso al libro con esta cuenta'
		$('dot').className = 'dot stale'
		return
	}
	const times = [b.ask.updatedAt, b.bid.updatedAt].filter(Boolean)
	if (!times.length) {
		$('updated').textContent = 'Leyendo el libro…'
		$('dot').className = 'dot'
		return
	}
	const age = b.serverTime - Math.min(...times)
	$('updated').textContent = `Actualizado hace ${ago(age)}`
	$('dot').className = `dot ${age < 30_000 ? 'live' : 'stale'}`
}

function renderStats(b, asks, bids) {
	const ask = asks[0]?.price
	const bid = bids[0]?.price
	const mid = ask && bid ? (ask + bid) / 2 : (ask ?? bid)
	const done = b.completed
	const doneMedian = done ? median(done.offers) : null
	const within = (levels, side) =>
		mid ? levels.filter((l) => (side === 'ask' ? l.price <= mid * 1.02 : l.price >= mid * 0.98)).reduce((s, l) => s + l.usd, 0) : 0
	const crossed = ask && bid && bid > ask
	const items = [
		['Mejor venta', fmtP(ask), 'ask'],
		['Mejor compra', fmtP(bid), 'bid'],
		['Diferencial', ask && bid ? pct(ask / bid - 1) : '—', crossed ? 'warn' : ''],
		['Medio', fmtP(mid), ''],
		['Mediana completadas', fmtP(doneMedian), ''],
		[`Operaciones ${done?.window_hours ?? 48} h`, done ? done.count.toLocaleString('es') : '—', ''],
		['Profundidad ±2%', mid ? `${fmtU(within(bids, 'bid'))} / ${fmtU(within(asks, 'ask'))} USD` : '—', ''],
	]
	$('stats').innerHTML = items
		.map(([k, v, cls]) => `<div class="stat"><label>${k}</label><b class="${cls === 'warn' ? '' : cls}">${cls === 'warn' ? `<span class="badge warn">${v}</span>` : v}</b></div>`)
		.join('')
}

function levelRow(l, side, cum, maxCum) {
	const color = side === 'ask' ? 'var(--ask-bg)' : 'var(--bid-bg)'
	const w = maxCum ? Math.max(2, (cum / maxCum) * 100) : 0
	const flags = [l.promoted ? '★' : '', l.kind === 'flexible' ? '↔' : '', l.requirements ? '🔒' : '', l.vipOnly ? '👑' : '', l.outlier ? '⚠️' : '']
		.filter(Boolean)
		.join('')
	const rep = l.rating ? `⭐${l.rating.toFixed(1)}` : 'nuevo'
	// Tus propias ofertas se marcan en el libro (broker.js sabe quién eres)
	const mine = typeof myUsername === 'function' && myUsername() === l.user
	return `<div class="lvl ${l.outlier || l.vipOnly ? 'dim' : ''} ${mine ? 'mine' : ''}" data-uuid="${l.uuid}" data-side="${side}"
		style="background-image:linear-gradient(to left, ${color} ${w}%, transparent ${w}%)">
		<span class="p">${fmtP(l.price)}</span><span class="u">${fmtU(l.usd)}</span><span class="c">${fmtU(cum)}</span>
		<span class="who">${mine ? '<b class="you">tú</b>' : ''}<em>${esc(l.user)}</em> ${l.ops} · ${rep}${flags ? `<span class="flag">${flags}</span>` : ''}</span></div>`
}

function renderBook(b, asks, bids) {
	const N = 30
	const side = (levels, s) => {
		if (!levels.length)
			return `<div class="empty">${b[s].error ? `QvaPay no deja leer el libro con tu cuenta:<br><b>${esc(b[s].error)}</b>` : 'Sin ofertas con estos filtros'}</div>`
		let cum = 0
		const rows = levels.slice(0, N).map((l) => ({ l, cum: (cum += l.usd) }))
		const max = rows.at(-1).cum
		return rows.map(({ l, cum }) => levelRow(l, s, cum, max)).join('')
	}
	$('asks').innerHTML = side(asks, 'ask')
	$('bids').innerHTML = side(bids, 'bid')
	const hidden = b.ask.levels.length + b.bid.levels.length - asks.length - bids.length
	$('bookCount').textContent = `${b.ask.total} / ${b.bid.total} ofertas${hidden ? ` · ${hidden} ocultas` : ''}`
	$('bookCount').title = `${b.ask.total} ventas y ${b.bid.total} compras en QvaPay`

	const ask = asks[0]?.price
	const bid = bids[0]?.price
	const el = $('spread')
	if (ask && bid) {
		const crossed = bid > ask
		el.className = `spread ${crossed ? 'crossed' : ''}`
		el.innerHTML = crossed
			? `<span class="lbl">Libro cruzado</span><span>${fmtP(bid)} &gt; ${fmtP(ask)} · ${pct(bid / ask - 1)}</span>`
			: `<span class="lbl">Diferencial</span><span>${fmtP(ask - bid)} · ${pct(ask / bid - 1)}</span>`
	} else {
		el.className = 'spread'
		el.textContent = 'Sin cotización en uno de los lados'
	}
}

function renderInsight(b, asks, bids) {
	const out = []
	const ask = asks[0]
	const bid = bids[0]
	const unit = b.coin.unit
	if (ask && bid && bid.price > ask.price) {
		const net = bid.price / ask.price - 1 - 0.0025
		const legs = `comprar a <b>${fmtP(ask.price)}</b> (@${esc(ask.user)}, ${ask.ops} ops) y vender a <b>${fmtP(bid.price)}</b> (@${esc(bid.user)}, ${bid.ops} ops)`
		out.push(
			net > 0
				? `<li class="warn">Libro cruzado: ${legs} deja <b>${pct(net)}</b> tras la comisión de 0,25%.</li>`
				: `<li>Libro cruzado, pero no compensa: ${legs} da <b>${pct(net)}</b> tras la comisión de 0,25%.</li>`,
		)
	}
	const done = b.completed
	const m = done ? median(done.offers) : null
	if (m && ask) out.push(`<li>La mejor venta está a <b>${pct(ask.price / m - 1)}</b> de la mediana de lo que realmente se completó (${fmtP(m)} ${unit}).</li>`)
	if (m && bid) out.push(`<li>La mejor compra está a <b>${pct(bid.price / m - 1)}</b> de esa mediana.</li>`)
	const top = (levels) => {
		const total = levels.reduce((s, l) => s + l.usd, 0)
		if (!total) return null
		const by = new Map()
		for (const l of levels) by.set(l.user, (by.get(l.user) ?? 0) + l.usd)
		const [user, usd] = [...by].sort((a, b) => b[1] - a[1])[0]
		return { user, share: usd / total }
	}
	const ta = top(asks)
	if (ta && ta.share > 0.3) out.push(`<li>@${esc(ta.user)} concentra el <b>${Math.round(ta.share * 100)}%</b> de la liquidez vendedora visible.</li>`)
	const outliers = [...b.ask.levels, ...b.bid.levels].filter((l) => l.outlier).length
	if (outliers) out.push(`<li><b>${outliers}</b> oferta(s) con precio atípico (probable error de tipeo), ocultas por defecto.</li>`)
	$('insight').innerHTML = out.length ? `<ul class="insight-list">${out.join('')}</ul>` : '<div class="empty">Sin observaciones destacables por ahora.</div>'
}

function renderActivity(b) {
	const items = b.activity.slice(0, 40)
	$('activity').innerHTML = items.length
		? items
				.map((a) => {
					const t = new Date(a.t).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' })
					const what = a.kind === 'new' ? (a.side === 'ask' ? 'Nueva venta' : 'Nueva compra') : a.side === 'ask' ? 'Venta retirada' : 'Compra retirada'
					return `<li><time>${t}</time><span>${what} · ${fmtU(a.usd)} USD · @${esc(a.user)}</span><span class="px ${a.side}">${fmtP(a.price)}</span></li>`
				})
				.join('')
		: '<li><span></span><span class="muted">Esperando cambios en el libro…</span><span></span></li>'
}

// ── Gráficos ──────────────────────────────────────────────────────────
function setupCanvas(canvas) {
	const dpr = window.devicePixelRatio || 1
	const { width, height } = canvas.getBoundingClientRect()
	canvas.width = Math.round(width * dpr)
	canvas.height = Math.round(height * dpr)
	const ctx = canvas.getContext('2d')
	ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
	ctx.clearRect(0, 0, width, height)
	ctx.font = '11px JetBrains Mono, monospace'
	return { ctx, width, height }
}

function emptyChart(ctx, width, height, text) {
	ctx.fillStyle = css('--muted')
	ctx.textAlign = 'center'
	ctx.fillText(text, width / 2, height / 2)
}

function drawDepth() {
	const { ctx, width, height } = setupCanvas($('depth'))
	const b = state.book
	if (!b) return
	const asks = filtered(b.ask.levels)
	const bids = filtered(b.bid.levels)
	if (!asks.length && !bids.length) return emptyChart(ctx, width, height, 'Sin ofertas')
	const mid = asks[0] && bids[0] ? (asks[0].price + bids[0].price) / 2 : (asks[0] ?? bids[0]).price
	const range = 0.06
	const lo = mid * (1 - range)
	const hi = mid * (1 + range)
	const cum = (levels) => {
		let c = 0
		return levels.filter((l) => l.price >= lo && l.price <= hi).map((l) => ({ p: l.price, c: (c += l.usd) }))
	}
	const A = cum(asks)
	const B = cum(bids)
	const maxC = Math.max(A.at(-1)?.c ?? 0, B.at(-1)?.c ?? 0, 1)
	const pad = { l: 36, r: 64, t: 14, b: 26 }
	const x = (p) => pad.l + ((p - lo) / (hi - lo)) * (width - pad.l - pad.r)
	const y = (c) => height - pad.b - (c / maxC) * (height - pad.t - pad.b)

	// Rejilla y ejes
	ctx.strokeStyle = css('--line')
	ctx.fillStyle = css('--muted')
	ctx.lineWidth = 1
	ctx.textAlign = 'left'
	for (let i = 0; i <= 4; i++) {
		const c = (maxC / 4) * i
		ctx.beginPath()
		ctx.moveTo(pad.l, y(c))
		ctx.lineTo(width - pad.r, y(c))
		ctx.stroke()
		ctx.fillText(fmtU(c), width - pad.r + 6, y(c) + 4)
	}
	ctx.textAlign = 'center'
	// Tantas etiquetas como quepan sin pisarse (~90 px cada una)
	const ticks = Math.max(2, Math.min(6, Math.floor((width - pad.l - pad.r) / 90)))
	for (let i = 0; i <= ticks; i++) {
		const p = lo + ((hi - lo) / ticks) * i
		ctx.fillText(fmtP(p), x(p), height - 8)
	}

	const area = (pts, color, fill, dir) => {
		if (!pts.length) return
		ctx.beginPath()
		ctx.moveTo(x(pts[0].p), y(0))
		let prev = 0
		for (const pt of pts) {
			ctx.lineTo(x(pt.p), y(prev))
			ctx.lineTo(x(pt.p), y(pt.c))
			prev = pt.c
		}
		ctx.lineTo(x(dir > 0 ? hi : lo), y(prev))
		ctx.lineTo(x(dir > 0 ? hi : lo), y(0))
		ctx.closePath()
		ctx.fillStyle = fill
		ctx.fill()
		ctx.strokeStyle = color
		ctx.lineWidth = 1.6
		ctx.stroke()
	}
	area(B, css('--bid'), css('--bid-bg'), -1)
	area(A, css('--ask'), css('--ask-bg'), 1)

	ctx.setLineDash([4, 4])
	ctx.strokeStyle = css('--muted')
	ctx.beginPath()
	ctx.moveTo(x(mid), pad.t)
	ctx.lineTo(x(mid), height - pad.b)
	ctx.stroke()
	ctx.setLineDash([])
	ctx.fillStyle = css('--text')
	ctx.fillText(`medio ${fmtP(mid)}`, x(mid), pad.t - 2)
	$('chartNote').textContent = `USD acumulados a ±${range * 100}% del precio medio`
}

function drawCompleted() {
	const { ctx, width, height } = setupCanvas($('completed'))
	const done = state.book?.completed
	if (!done?.offers?.length) return emptyChart(ctx, width, height, 'Sin operaciones completadas recientes')
	const m = median(done.offers)
	const lo = m * 0.9
	const hi = m * 1.1
	const xs = done.offers.filter((v) => v >= lo && v <= hi)
	const BINS = 40
	const bins = new Array(BINS).fill(0)
	for (const v of xs) bins[Math.min(BINS - 1, Math.floor(((v - lo) / (hi - lo)) * BINS))]++
	const maxB = Math.max(...bins, 1)
	const pad = { l: 36, r: 40, t: 46, b: 26 }
	const bw = (width - pad.l - pad.r) / BINS
	const x = (v) => pad.l + ((v - lo) / (hi - lo)) * (width - pad.l - pad.r)
	const y = (n) => height - pad.b - (n / maxB) * (height - pad.t - pad.b)

	ctx.fillStyle = css('--muted')
	ctx.textAlign = 'center'
	for (let i = 0; i <= 4; i++) {
		const v = lo + ((hi - lo) / 4) * i
		ctx.fillText(fmtP(v), x(v), height - 8)
	}
	ctx.fillStyle = css('--accent')
	bins.forEach((n, i) => {
		if (!n) return
		ctx.globalAlpha = 0.85
		ctx.fillRect(pad.l + i * bw + 1, y(n), bw - 2, height - pad.b - y(n))
	})
	ctx.globalAlpha = 1

	// Cada etiqueta en su fila para que no se pisen cuando las líneas caen juntas
	const vline = (v, color, label, row) => {
		if (v == null || v < lo || v > hi) return
		const top = 10 + row * 13
		ctx.strokeStyle = color
		ctx.setLineDash([4, 4])
		ctx.beginPath()
		ctx.moveTo(x(v), top + 3)
		ctx.lineTo(x(v), height - pad.b)
		ctx.stroke()
		ctx.setLineDash([])
		ctx.fillStyle = color
		ctx.textAlign = x(v) > width / 2 ? 'right' : 'left'
		ctx.fillText(label, x(v) + (ctx.textAlign === 'right' ? -4 : 4), top)
	}
	const asks = filtered(state.book.ask.levels)
	const bids = filtered(state.book.bid.levels)
	vline(m, css('--text'), `mediana ${fmtP(m)}`, 0)
	vline(bids[0]?.price, css('--bid'), `mejor compra ${fmtP(bids[0]?.price)}`, 1)
	vline(asks[0]?.price, css('--ask'), `mejor venta ${fmtP(asks[0]?.price)}`, 2)
	$('chartNote').textContent = `${done.count.toLocaleString('es')} operaciones completadas en ${done.window_hours} h (±10% de la mediana)`
}

let historyChart = null
let bidSeries = null
let askSeries = null
let opsSeries = null
const DAY_MS = 86_400_000
const shortDay = (ms) => new Date(ms).toLocaleDateString('es', { day: 'numeric', month: 'short', timeZone: 'America/Havana' })

// Leyenda de las barras: el día bajo el cursor o, si no, el último día completo
function opsLegend(day) {
	const el = $('opsLegend')
	const daily = state.history?.daily ?? []
	const d = day ?? daily.filter((x) => !x.partial).at(-1) ?? daily.at(-1)
	el.hidden = !d || state.chart !== 'history'
	if (!d) return
	const split = d.buy != null && d.sell != null ? ` · ${d.buy.toLocaleString('es')} compras · ${d.sell.toLocaleString('es')} ventas` : ''
	el.innerHTML = `<b>${d.ops.toLocaleString('es')}</b> operaciones ${d.partial ? 'en las últimas 24 h' : `el ${shortDay(d.t)}`}${split}`
}
function drawHistory() {
	const el = $('history')
	if (!window.LightweightCharts) return
	if (!historyChart) {
		historyChart = LightweightCharts.createChart(el, {
			autoSize: true,
			layout: { background: { color: 'transparent' }, textColor: css('--muted'), fontFamily: 'JetBrains Mono' },
			grid: { vertLines: { color: css('--line') }, horzLines: { color: css('--line') } },
			rightPriceScale: { borderColor: css('--line') },
			timeScale: { borderColor: css('--line'), timeVisible: true, secondsVisible: false },
			localization: { locale: 'es', priceFormatter: fmtP },
		})
		bidSeries = historyChart.addLineSeries({ color: css('--bid'), lineWidth: 2, title: 'compra' })
		askSeries = historyChart.addLineSeries({ color: css('--ask'), lineWidth: 2, title: 'venta' })
		// Operaciones por día: barras en una escala propia, en la franja de abajo
		opsSeries = historyChart.addHistogramSeries({ priceScaleId: 'ops', lastValueVisible: false, priceLineVisible: false })
		historyChart.priceScale('ops').applyOptions({ scaleMargins: { top: 0.74, bottom: 0 } })
		historyChart.priceScale('right').applyOptions({ scaleMargins: { top: 0.08, bottom: 0.3 } })
		historyChart.subscribeCrosshairMove((p) => {
			if (!p.time) return opsLegend()
			const ms = (p.time - (-new Date().getTimezoneOffset() * 60)) * 1000
			opsLegend((state.history?.daily ?? []).find((d) => Math.abs(d.t - ms) < DAY_MS / 2))
		})
	}
	themeHistory()
	const tz = -new Date().getTimezoneOffset() * 60
	const points = state.history?.points ?? []
	const series = (key) => points.filter((p) => p[key] != null).map((p) => ({ time: Math.floor(p.t / 1000) + tz, value: p[key] }))
	bidSeries.setData(series('buy'))
	askSeries.setData(series('sell'))
	const accent = css('--accent')
	opsSeries.setData(
		(state.history?.daily ?? []).map((d) => ({ time: Math.floor(d.t / 1000) + tz, value: d.ops, color: `${accent}${d.partial ? '40' : '80'}` })),
	)
	opsLegend()
	historyChart.timeScale().fitContent()
	const first = state.history?.firstPoint
	const step = { 600000: 'cada 10 min', 3600000: 'por hora', 86400000: 'por día' }[state.history?.bucketMs] ?? ''
	$('chartNote').textContent = first
		? `Mediana de lo completado (24 h), ${step} · barras: operaciones por día · desde ${new Date(first).toLocaleDateString('es')}`
		: 'Se registra cada 10 minutos: vuelve en un rato'
	$('chartNote').title = 'Líneas: mediana de las operaciones completadas en QvaPay en las últimas 24 h, guardada cada 10 minutos. Barras: operaciones completadas por día (hora de Cuba); la más clara es el día en curso.'
}

// Los colores del gráfico histórico siguen al tema claro u oscuro
function themeHistory() {
	if (!historyChart) return
	historyChart.applyOptions({
		layout: { textColor: css('--muted') },
		grid: { vertLines: { color: css('--line') }, horzLines: { color: css('--line') } },
		rightPriceScale: { borderColor: css('--line') },
		timeScale: { borderColor: css('--line') },
	})
	bidSeries.applyOptions({ color: css('--bid') })
	askSeries.applyOptions({ color: css('--ask') })
}

function drawActive() {
	if (state.chart === 'depth') drawDepth()
	else if (state.chart === 'completed') drawCompleted()
	else drawHistory()
}

function showChart(name) {
	state.chart = name
	store.set('chart', name)
	for (const t of document.querySelectorAll('[data-chart]')) t.classList.toggle('active', t.dataset.chart === name)
	$('rangeTabs').hidden = name !== 'history'
	$('opsLegend').hidden = true
	$('depth').hidden = name !== 'depth'
	$('completed').hidden = name !== 'completed'
	$('history').hidden = name !== 'history'
	drawActive()
}

// ── Tooltip de cada oferta ────────────────────────────────────────────
function tooltip(l, side) {
	const unit = state.book.coin.unit
	const req = l.requirements
		? Object.entries(l.requirements)
				.map(([k, v]) => ({ min_completed: `${v}+ ops`, min_rating: `⭐${v}+`, min_account_days: `${v}+ días`, min_trustscore: `trust ${v}+` })[k] ?? `${k} ${v}`)
				.join(', ')
		: null
	return [
		`<div><b>${fmtP(l.price)}</b> ${unit}/USD · ${side === 'ask' ? 'vende' : 'compra'} ${fmtU(l.usd)} USD</div>`,
		l.kind === 'flexible' ? `<div>↔ Por rango: órdenes de ${fmtU(l.orderMin ?? 0)} a ${fmtU(l.orderMax ?? l.usd)} USD</div>` : '<div>Oferta fija: se toma entera</div>',
		`<div>@${esc(l.user)} · ${l.ops} operaciones · ${l.rating ? `⭐ ${l.rating.toFixed(2)}` : 'sin valoraciones'}</div>`,
		`<div>${[l.kyc ? 'KYC ✓' : 'sin KYC', l.vip ? 'VIP' : '', l.gold ? 'GOLD' : ''].filter(Boolean).join(' · ')}</div>`,
		l.createdAt != null
			? `<div class="muted">Publicada hace ${ago(state.book.serverTime - l.createdAt)}${l.updatedAt && l.updatedAt - l.createdAt > 60_000 ? ` · actualizada hace ${ago(state.book.serverTime - l.updatedAt)}` : ''}</div>`
			: '',
		req ? `<div>🔒 Requisitos: ${esc(req)}</div>` : '',
		l.vipOnly ? '<div>👑 Solo cuentas VIP</div>' : '',
		l.promoted ? '<div>★ Puesto promocionado</div>' : '',
		l.outlier ? '<div style="color:var(--warn)">⚠️ Precio atípico: probable error</div>' : '',
		'<div class="muted">Clic para ver y tomar la oferta</div>',
	].join('')
}

function findLevel(uuid, side) {
	return state.book?.[side].levels.find((l) => l.uuid === uuid)
}

// ── Menús desplegables ────────────────────────────────────────────────
function toggleMenu(menuId, btnId, onOpen) {
	const open = $(menuId).hidden
	closeMenus()
	if (!open) return
	$(menuId).hidden = false
	$(btnId).setAttribute('aria-expanded', 'true')
	onOpen?.()
}

function closeMenus() {
	$('filterMenu').hidden = true
	$('filterBtn').setAttribute('aria-expanded', 'false')
}

// Cuántos filtros se apartan de los valores por defecto
function renderFilterCount() {
	const f = state.filters
	const n = [!f.vip, !f.outlier, f.ops > 0, f.usd > 0, f.ageH > 0].filter(Boolean).length
	$('filterCount').hidden = !n
	$('filterCount').textContent = String(n)
}

// ── Eventos ───────────────────────────────────────────────────────────
function bind() {
	for (const id of ['marketList', 'marketStrip'])
		$(id).addEventListener('click', (e) => {
			const row = e.target.closest('[data-tick]')
			if (row) selectCoin(row.dataset.tick)
		})
	$('marketSearch').addEventListener('input', renderMarkets)
	$('filterBtn').addEventListener('click', (e) => {
		e.stopPropagation()
		toggleMenu('filterMenu', 'filterBtn')
	})
	$('filterMenu').addEventListener('click', (e) => e.stopPropagation())
	for (const t of document.querySelectorAll('[data-view]')) t.addEventListener('click', () => showView(t.dataset.view))
	document.addEventListener('click', closeMenus)
	document.addEventListener('keydown', (e) => e.key === 'Escape' && closeMenus())

	for (const t of document.querySelectorAll('[data-chart]')) t.addEventListener('click', () => showChart(t.dataset.chart))
	for (const t of document.querySelectorAll('[data-range]')) {
		t.classList.toggle('active', Number(t.dataset.range) === state.range)
		t.addEventListener('click', () => {
			state.range = Number(t.dataset.range)
			store.set('range', state.range)
			for (const o of document.querySelectorAll('[data-range]')) o.classList.toggle('active', o === t)
			loadHistory()
		})
	}
	for (const t of document.querySelectorAll('[data-pane]'))
		t.addEventListener('click', () => {
			for (const o of document.querySelectorAll('[data-pane]')) {
				o.classList.toggle('active', o === t)
				$(o.dataset.pane).hidden = o !== t
			}
		})

	$('themeBtn').addEventListener('click', () => {
		const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light'
		document.documentElement.dataset.theme = next
		store.set('theme', next)
		themeHistory()
		drawActive()
	})

	const f = state.filters
	$('fVip').checked = f.vip
	$('fOutlier').checked = f.outlier
	$('fOps').value = String(f.ops)
	$('fUsd').value = String(f.usd)
	$('fAge').value = String(f.ageH)
	const onFilter = () => {
		state.filters = {
			vip: $('fVip').checked,
			outlier: $('fOutlier').checked,
			ops: Number($('fOps').value),
			usd: Number($('fUsd').value),
			ageH: Number($('fAge').value),
		}
		store.set('filters', state.filters)
		renderFilterCount()
		render()
	}
	for (const id of ['fVip', 'fOutlier', 'fOps', 'fUsd', 'fAge']) $(id).addEventListener('change', onFilter)
	$('filterReset').addEventListener('click', () => {
		$('fVip').checked = true
		$('fOutlier').checked = true
		$('fOps').value = $('fUsd').value = $('fAge').value = '0'
		onFilter()
	})
	renderFilterCount()

	const tip = $('tip')
	for (const id of ['asks', 'bids']) {
		const el = $(id)
		el.addEventListener('mousemove', (e) => {
			const row = e.target.closest('.lvl')
			const l = row && findLevel(row.dataset.uuid, row.dataset.side)
			if (!l) return (tip.hidden = true)
			tip.innerHTML = tooltip(l, row.dataset.side)
			tip.hidden = false
			const x = Math.min(e.clientX + 14, window.innerWidth - tip.offsetWidth - 8)
			const y = Math.min(e.clientY + 14, window.innerHeight - tip.offsetHeight - 8)
			tip.style.left = `${x}px`
			tip.style.top = `${y}px`
		})
		el.addEventListener('mouseleave', () => (tip.hidden = true))
		el.addEventListener('click', (e) => {
			const row = e.target.closest('.lvl')
			if (!row) return
			tip.hidden = true
			// broker.js abre la oferta para tomarla; sin él, se abre en QvaPay
			if (typeof showTakeOffer === 'function') showTakeOffer(row.dataset.uuid, row.dataset.side)
			else window.open(`https://www.qvapay.com/p2p/${row.dataset.uuid}`, '_blank', 'noopener')
		})
	}
	window.addEventListener('resize', () => drawActive())
}

bind()
showView(state.view)
showChart(state.chart)
render()
loadOverview()
loadBook()
loadHistory()
// Sondeo solo con la pestaña visible: no gastar consultas sin nadie mirando
function every(ms, fn) {
	setInterval(() => !document.hidden && fn(), ms)
}
every(5000, loadBook)
every(15_000, loadOverview)
every(60_000, loadHistory)
document.addEventListener('visibilitychange', () => {
	if (document.hidden) return
	loadBook()
	loadOverview()
})
