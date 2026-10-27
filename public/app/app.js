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
	informal: null,
	ranking: null,
	rank: { crit: store.get('rankCrit', 'liquidity'), scope: store.get('rankScope', 'all'), side: store.get('rankSide', '') },
}

// Mercados en CUP por USD de QvaPay, comparables con el USD y el USDT del mercado informal
const INFORMAL_MARKETS = new Set(['BANK_CUP', 'CUPCASH', 'BOLSATM'])

// ── Formato ───────────────────────────────────────────────────────────
const decimals = (p) => (p >= 100 ? 2 : 4)
const fmtP = (p) => (p == null || !isFinite(p) ? '—' : p.toLocaleString('es', { minimumFractionDigits: decimals(p), maximumFractionDigits: decimals(p) }))
// Para el libro, gráficos y estadísticas: desde 1.000, sin decimales
const fmtU = (n) => (n >= 1000 ? Math.round(n).toLocaleString('es') : n.toLocaleString('es', { maximumFractionDigits: 2 }))
// El dinero de una operación (lo que publicas, pagas o recibes) siempre exacto, con sus céntimos: 22.999,82 CUP
// no puede salir como 23.000, porque eso es lo que se transfiere
const fmtM = (n) => n.toLocaleString('es', { minimumFractionDigits: Math.round(n * 100) % 100 ? 2 : 0, maximumFractionDigits: 2 })
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
		setStatus('Sin conexión con el servidor')
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
		const r = await fetch(`/data/rates?coin=${state.coin}&days=${state.range}`, { cache: 'no-cache' })
		if (!r.ok) throw new Error(String(r.status))
		state.history = await r.json()
		if (state.chart === 'history') drawHistory()
	} catch {}
}

// Tasa del mercado informal de hoy según elTOQUE (la guarda el servidor, es pública)
async function loadInformal() {
	try {
		const r = await fetch('/data/informal', { cache: 'no-cache' })
		if (!r.ok) throw new Error(String(r.status))
		state.informal = await r.json()
		if (state.book) render()
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
	if (state.rank.scope === 'coin') loadRanking()
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
		setStatus('Conecta tu cuenta para ver el libro en vivo')
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

// Solo se ve el punto; el texto queda al pasar el ratón y para lectores de pantalla
function setStatus(text) {
	$('updated').textContent = text
	$('statusPill').title = text
}

function renderStatus(b) {
	// Si QvaPay rechaza la lectura de los dos lados, no es "actualizado": no hay libro
	if (b.ask.error && b.bid.error) {
		setStatus('Sin acceso al libro con esta cuenta')
		$('dot').className = 'dot stale'
		return
	}
	const times = [b.ask.updatedAt, b.bid.updatedAt].filter(Boolean)
	if (!times.length) {
		setStatus('Leyendo el libro…')
		$('dot').className = 'dot'
		return
	}
	// El libro llega empujado por el servidor: con Pro, en cuanto cambia; sin Pro, cada 10 s
	if (b.realtime) {
		setStatus(TPApi.live?.state().pro ? 'En tiempo real' : 'Actualizado cada 10 s')
		$('dot').className = 'dot live'
		return
	}
	const age = b.serverTime - Math.min(...times)
	setStatus(`Actualizado hace ${ago(age)}`)
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
		['Mediana completadas', fmtP(doneMedian), '', 'Mediana cerradas'],
		[`Operaciones ${done?.window_hours ?? 48} h`, done ? done.count.toLocaleString('es') : '—', ''],
		['Profundidad ±2%', mid ? `${fmtU(within(bids, 'bid'))} / ${fmtU(within(asks, 'ask'))}<small class="unit"> USD</small>` : '—', '', 'Prof. ±2% (USD)'],
	]
	$('stats').innerHTML = items
		// En el móvil, una etiqueta más corta si la hay (con tres columnas no caben las largas)
		.map(([k, v, cls, short]) => `<div class="stat"><label>${short ? `<span class="lg">${k}</span><span class="sh">${short}</span>` : k}</label><b class="${cls === 'warn' ? '' : cls}">${cls === 'warn' ? `<span class="badge warn">${v}</span>` : v}</b></div>`)
		.join('')
	renderIntent(mid ? within(bids, 'bid') : 0, mid ? within(asks, 'ask') : 0, mid, doneMedian)
	renderPulse(b)
}

// Actividad del mercado en la última hora: ofertas del libro publicadas, editadas o reabiertas en ese
// tiempo (cada oferta trae su última actividad) más las que salieron del libro mientras lo miras.
// Se compara con el ritmo normal, las operaciones completadas por hora en la ventana de QvaPay.
// Si nada se movió en 30 minutos, el mercado está quieto
const PULSE = ['Quieto', 'Baja', 'Normal', 'Alta', 'Muy alta']
function pulseScore(b) {
	const levels = [...b.ask.levels, ...b.bid.levels].filter((l) => !l.outlier)
	if (!levels.length) return null
	const now = b.serverTime ?? Date.now()
	const hour = 3_600_000
	const fresh = levels.filter((l) => l.updatedAt && now - l.updatedAt < hour).length
	const gone = b.activity.filter((a) => a.kind === 'gone' && now - a.t < hour).length
	const last = Math.max(0, ...levels.map((l) => l.updatedAt ?? 0), ...b.activity.map((a) => a.t))
	const done = b.completed
	const pace = done?.count && done.window_hours ? done.count / done.window_hours : null
	const moves = fresh + gone
	const ratio = pace ? moves / pace : null
	const level = !last || now - last > 30 * 60_000 ? 0 : ratio != null ? (ratio >= 2 ? 4 : ratio >= 1 ? 3 : ratio >= 0.4 ? 2 : 1) : moves >= 20 ? 4 : moves >= 8 ? 3 : moves >= 3 ? 2 : 1
	return { level, fresh, gone, last: last ? now - last : null, pace }
}
function renderPulse(b) {
	const el = $('pulse')
	const r = pulseScore(b)
	el.classList.toggle('off', !r)
	el.dataset.level = r ? String(r.level) : ''
	const label = r ? PULSE[r.level] : '—'
	el.setAttribute('aria-label', r ? `Actividad del mercado: ${label}` : 'Actividad del mercado: sin libro en vivo')
	el.innerHTML = `<label>Actividad</label><div class="pulse-body" aria-hidden="true">${[1, 2, 3, 4].map((i) => `<i class="${r && r.level >= i ? 'on' : ''}" style="height:${6 + i * 4}px"></i>`).join('')}<span>${label}</span></div>`
	el.title = r
		? `Actividad del mercado: ${label.toLowerCase()}.\n` +
			`· Última novedad en el libro: hace ${ago(r.last ?? 0)}.\n` +
			`· En la última hora: ${r.fresh} ${r.fresh === 1 ? 'oferta publicada o editada' : 'ofertas publicadas o editadas'} y ${r.gone} que ${r.gone === 1 ? 'salió' : 'salieron'} del libro (estas, desde que lo tienes abierto).\n` +
			(r.pace != null ? `· Ritmo normal: unas ${Math.round(r.pace)} operaciones completadas por hora.` : '· Sin datos de operaciones completadas para comparar.')
		: 'La actividad del mercado se calcula con el libro en vivo: conecta tu cuenta de QvaPay.'
}

// Intención del mercado (0 = más venden, 100 = más compran): un 70% sale de la profundidad a ±2%
// del medio (USD que se quieren comprar frente a los que se quieren vender) y un 30% de dónde está
// el medio respecto a lo completado (±2% llena la escala). Sin libro en vivo no se calcula
function intentScore(bidUsd, askUsd, mid, doneMedian) {
	if (!(bidUsd + askUsd > 0)) return null
	const depth = bidUsd / (bidUsd + askUsd)
	const drift = mid && doneMedian ? Math.max(-1, Math.min(1, (mid / doneMedian - 1) / 0.02)) : 0
	return { score: Math.round((0.7 * depth + 0.3 * (drift + 1) / 2) * 100), depth, drift: mid && doneMedian ? mid / doneMedian - 1 : null }
}
function renderIntent(bidUsd, askUsd, mid, doneMedian) {
	const el = $('intent')
	const r = intentScore(bidUsd, askUsd, mid, doneMedian)
	const s = r?.score ?? 50
	const [label, cls] = !r ? ['—', ''] : s >= 60 ? ['Más compran', 'bid'] : s <= 40 ? ['Más venden', 'ask'] : ['Equilibrio', '']
	// Semicírculo de 180°: la aguja va de la izquierda (0) a la derecha (100)
	const a = Math.PI * (1 - s / 100)
	const nx = (23 + 15 * Math.cos(a)).toFixed(1)
	const ny = (23 - 15 * Math.sin(a)).toFixed(1)
	const arc = (from, to) => {
		const p = (t) => [(23 + 19 * Math.cos(Math.PI * (1 - t))).toFixed(1), (23 - 19 * Math.sin(Math.PI * (1 - t))).toFixed(1)]
		const [x1, y1] = p(from)
		const [x2, y2] = p(to)
		return `M${x1} ${y1} A19 19 0 0 1 ${x2} ${y2}`
	}
	el.classList.toggle('off', !r)
	el.dataset.side = cls
	el.setAttribute('aria-label', r ? `Intención del mercado: ${label}, ${s} de 100` : 'Intención del mercado: sin libro en vivo')
	el.innerHTML = `<label>Intención</label><div class="intent-body">
		<svg class="gauge" viewBox="0 0 46 27" width="46" height="27" aria-hidden="true">
			<path class="g-ask" d="${arc(0, 0.39)}"/><path class="g-mid" d="${arc(0.41, 0.59)}"/><path class="g-bid" d="${arc(0.61, 1)}"/>
			<line class="g-needle" x1="23" y1="23" x2="${nx}" y2="${ny}"/><circle class="g-hub" cx="23" cy="23" r="2.6"/>
		</svg></div>`
	el.title = r
		? `Intención del mercado: ${s} de 100 (0 = más venden, 100 = más compran).\n` +
			`· Profundidad a ±2% del medio: ${fmtU(bidUsd)} USD a la compra frente a ${fmtU(askUsd)} a la venta (${Math.round(r.depth * 100)}% compra). Pesa un 70%.\n` +
			(r.drift != null ? `· El medio está a ${pct(r.drift)} de la mediana de lo completado. Pesa un 30%.` : '· Sin mediana de lo completado para comparar el precio.')
		: 'La intención del mercado se calcula con el libro en vivo: conecta tu cuenta de QvaPay.'
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
	const medal = rankMedal(l.user)
	return `<div class="lvl ${l.outlier || l.vipOnly ? 'dim' : ''} ${mine ? 'mine' : ''}" data-uuid="${l.uuid}" data-side="${side}"
		style="background-image:linear-gradient(to left, ${color} ${w}%, transparent ${w}%)">
		<span class="p">${fmtP(l.price)}</span><span class="u">${fmtU(l.usd)}</span><span class="c">${fmtU(cum)}</span>
		<span class="who">${mine ? '<b class="you">tú</b>' : ''}${medal}<em title="Ver la ficha de ${esc(l.user)}">${esc(l.user)}</em> ${l.ops} · ${rep}${flags ? `<span class="flag">${flags}</span>` : ''}</span></div>`
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

// Con menos operaciones, la venta de un libro cruzado lleva aviso (a quien vende le pagas tú primero)
const CROSS_MIN_OPS = 50

function renderInsight(b, asks, bids) {
	const out = []
	const ask = asks[0]
	const bid = bids[0]
	const unit = b.coin.unit
	// Sin Pro, la primera venta y la primera compra del libro; con Pro, solo lo que puedes tomar, cuántos USD
	// encajan y cuánto te queda
	const pro = window.TPPro
	if (ask && bid && bid.price > ask.price && !pro?.active) {
		const net = bid.price / ask.price - 1 - 0.0025
		const legs = `comprar a <b>${fmtP(ask.price)}</b> (@${esc(ask.user)}, ${ask.ops} ops) y vender a <b>${fmtP(bid.price)}</b> (@${esc(bid.user)}, ${bid.ops} ops)`
		const more = pro?.enabled ? ' Con <b>Pro</b> ves si puedes aprovecharlo, cuántos USD encajan y cuánto te quedaría.' : ''
		out.push(
			net > 0
				? `<li class="warn">Libro cruzado: ${legs} deja <b>${pct(net)}</b> tras la comisión de 0,25%.${more}</li>`
				: `<li>Libro cruzado, pero no compensa: ${legs} da <b>${pct(net)}</b> tras la comisión de 0,25%.</li>`,
		)
	} else if (ask && bid && bid.price > ask.price) {
		// Con tu comisión real (las cuentas GOLD no la pagan) y solo con ofertas que puedes tomar
		const acct = typeof bk !== 'undefined' ? bk.acct : null
		const fee = acct?.connected ? (acct.gold ? 0 : (acct.p2pFee ?? 0.0025)) : 0.0025
		const feeText = fee ? `tras la comisión de ${(fee * 100).toLocaleString('es')} %` : 'sin comisión (cuenta GOLD)'
		const me = typeof myUsername === 'function' ? myUsername() : null
		const c = window.TPApi?.cross?.(asks, bids, fee, me)
		if (c) {
			const who = (l) => `@${esc(l.user)}, ${l.ops} ops`
			const fresh = c.ask.ops < CROSS_MIN_OPS ? ` Ojo: @${esc(c.ask.user)} tiene solo ${c.ask.ops} operaciones.` : ''
			const left = c.leftUsd ? ` Te sobran ${fmtU(c.leftUsd)} USD (la compra es fija y más pequeña).` : ''
			out.push(
				`<li class="warn">Libro cruzado: compra <b>${fmtU(c.buyUsd)} USD</b> a <b>${fmtP(c.ask.price)}</b> (${who(c.ask)}) y vende <b>${fmtU(c.sellUsd)}</b> a <b>${fmtP(c.bid.price)}</b> (${who(c.bid)}): te quedan unos <b>${fmtU(Math.round(c.profit))} ${unit}</b> (<b>${pct(c.pct)}</b>) ${feeText}. Son dos operaciones aparte: primero le pagas a @${esc(c.ask.user)} y esperas a que libere; mientras, la compra puede desaparecer.${left}${fresh}</li>`,
			)
		} else out.push(`<li>Libro cruzado, pero no lo puedes aprovechar: no compensa ${feeText}, los montos no encajan o son ofertas que no puedes tomar (solo VIP, requisitos, precio atípico).</li>`)
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
	const ref = m ?? (ask && bid ? (ask.price + bid.price) / 2 : (b.averages24h?.average ?? null))
	out.push(...informalInsight(b.coin.tick, ref))
	$('insight').innerHTML = out.length ? `<ul class="insight-list">${out.join('')}</ul>` : '<div class="empty">Sin observaciones destacables por ahora.</div>'
}

// Mercado informal según elTOQUE: cómo cotiza este mercado frente a él, la tendencia y la
// relación entre divisas. Las tasas son de elTOQUE; aquí solo se comparan
const INFORMAL_CURS = [
	['usd', 'USD'],
	['eur', 'EUR'],
	['mlc', 'MLC'],
	['usdt', 'USDT'],
]
function informalInsight(tick, ref) {
	const inf = state.informal
	const now = inf?.last
	if (!now?.usd) return []
	const out = [`<li class="head">Mercado informal · <a href="${esc(inf.url)}" target="_blank" rel="noopener">elTOQUE</a></li>`]
	const ratio = (a, b) => (a > 0 && b > 0 ? a / b : null)

	// Este mercado frente al informal
	if (ref && INFORMAL_MARKETS.has(tick) && now.usdt)
		out.push(`<li>Aquí se cotiza a <b>${pct(ref / now.usd - 1)}</b> del USD informal (<b>${fmtP(now.usd)}</b> CUP) y a <b>${pct(ref / now.usdt - 1)}</b> del USDT (<b>${fmtP(now.usdt)}</b> CUP).</li>`)
	const usdMlc = ratio(now.usd, now.mlc)
	if (ref && tick === 'BANK_MLC' && usdMlc)
		out.push(`<li>En el informal 1 USD equivale a <b>${fmtP(usdMlc)}</b> MLC: aquí se cotiza a <b>${pct(ref / usdMlc - 1)}</b> de esa relación.</li>`)
	const usdEur = ratio(now.usd, now.eur)
	if (ref && tick === 'TROPIPAY' && usdEur)
		out.push(`<li>En el informal 1 USD equivale a <b>${fmtP(usdEur)}</b> EUR: aquí se cotiza a <b>${pct(ref / usdEur - 1)}</b> de esa relación.</li>`)

	// Tasas de hoy y tendencia: 7 y 30 días o, mientras no estén guardados, desde ayer
	out.push(`<li>Hoy: ${INFORMAL_CURS.filter(([k]) => now[k] > 0).map(([k, l]) => `${l} <b>${fmtP(now[k])}</b>`).join(' · ')} CUP.</li>`)
	const trend = (past, label) => {
		const parts = INFORMAL_CURS.filter(([k]) => now[k] > 0 && past?.[k] > 0).map(([k, l]) => `${l} <b>${pct(now[k] / past[k] - 1)}</b>`)
		return parts.length ? `${label}: ${parts.join(' · ')}` : null
	}
	const lines = [trend(inf.d7, 'En 7 días'), trend(inf.d30, 'en 30 días')].filter(Boolean)
	if (!lines.length && inf.prev) lines.push(trend(inf.prev, 'Desde ayer'))
	const fast = inf.d7?.usd > 0 && Math.abs(now.usd / inf.d7.usd - 1) >= 0.03
	if (lines.length) out.push(`<li${fast ? ' class="warn"' : ''}>${lines.filter(Boolean).join('; ')}.${fast ? ` El USD se movió más de un 3% en una semana.` : ''}</li>`)

	// El dólar digital frente al efectivo y la relación entre divisas
	const digital = ratio(now.usdt, now.usd)
	if (digital)
		out.push(`<li>El USDT vale <b>${pct(digital - 1)}</b> ${digital >= 1 ? 'más' : 'menos'} que el USD en efectivo: el dólar digital cotiza ${digital >= 1 ? 'por encima' : 'por debajo'} del físico.</li>`)
	const eurUsd = ratio(now.eur, now.usd)
	if (eurUsd || usdMlc)
		out.push(
			`<li>${[eurUsd ? `1 EUR = <b>${fmtP(eurUsd)}</b> USD` : '', usdMlc ? `1 USD = <b>${fmtP(usdMlc)}</b> MLC (el MLC vale <b>${pct(1 / usdMlc - 1)}</b> frente al USD)` : ''].filter(Boolean).join(' y ')}.</li>`,
		)
	return out
}

// Ofertas que entran y salen del libro. De una que sale no se sabe si la tomaron o la retiró su dueño:
// QvaPay no lo dice
const ACT_ICON = {
	new: '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M12 6v12M6 12h12" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/></svg>',
	gone: '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M14 5h4a1 1 0 011 1v12a1 1 0 01-1 1h-4M9 16l-4-4 4-4M5 12h10" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
}
function renderActivity(b) {
	const items = b.activity.slice(0, 40)
	// Solo se repinta si cambió algo: repintar con cada lectura del libro haría perder el clic en un nombre
	const key = items.map((a) => `${a.t}:${a.kind}:${a.user}:${a.price}`).join('|')
	if ($('activity').dataset.key === key) return
	$('activity').dataset.key = key
	const note = '<li class="act-note">Ofertas que entran y salen del libro. Las que salen las tomó alguien o las retiró su dueño: QvaPay no indica cuál.</li>'
	$('activity').innerHTML = items.length
		? note +
			items
				.map((a) => {
					const t = new Date(a.t).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' })
					const sideName = a.side === 'ask' ? 'una venta' : 'una compra'
					const what = a.kind === 'new' ? `Entra ${sideName}` : `Sale ${sideName}`
					const tip = a.kind === 'new' ? 'Oferta nueva o que volvió al libro' : 'La tomó alguien o la retiró su dueño; QvaPay no indica cuál'
					return `<li title="${tip}"><time>${t}</time><span class="act"><i class="act-ic ${a.kind} ${a.side}">${ACT_ICON[a.kind]}</i><span>${what} · ${fmtU(a.usd)} USD · <button type="button" class="link peer-link" data-peer="${esc(a.user)}" title="Ver su ficha">@${esc(a.user)}</button></span></span><span class="px ${a.side}">${fmtP(a.price)}</span></li>`
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
	$('chartNote').title = $('chartNote').textContent
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
	$('chartNote').title = $('chartNote').textContent
}

let historyChart = null
let bidSeries = null
let askSeries = null
// Operaciones por día: una barra sólida por día, como el volumen de un exchange (con Pro, partida en compras y ventas)
let opsSeries = null
let usdSeries = null
let usdtSeries = null
// Los datos ya dibujados y el mercado y rango del último encuadre: el libro se refresca cada pocos
// segundos y redibujar o reencuadrar el histórico en cada refresco deshacía el zoom del usuario
let historyDrawn = null
let historyKey = ''
const DAY_MS = 86_400_000
const shortDay = (ms) => new Date(ms).toLocaleDateString('es', { day: 'numeric', month: 'short', timeZone: 'America/Havana' })

const showInformal = () => INFORMAL_MARKETS.has(state.coin) && (state.history?.informal?.length ?? 0) > 0

// Leyenda: operaciones y tasa informal del día bajo el cursor o, si no, del último día
function opsLegend(ms) {
	const el = $('opsLegend')
	const daily = state.history?.daily ?? []
	const informal = showInformal() ? state.history.informal : []
	const near = (xs) => (ms == null ? null : xs.find((x) => Math.abs(x.t - ms) < DAY_MS / 2))
	const d = ms == null ? (daily.filter((x) => !x.partial).at(-1) ?? daily.at(-1)) : near(daily)
	const i = ms == null ? informal.at(-1) : near(informal)
	const parts = []
	if (d) {
		const split = d.buy != null && d.sell != null ? ` · ${d.buy.toLocaleString('es')} compras · ${d.sell.toLocaleString('es')} ventas` : ''
		parts.push(`<b>${d.ops.toLocaleString('es')}</b> operaciones ${d.partial ? 'en las últimas 24 h' : `el ${shortDay(d.t)}`}${split}`)
	}
	if (i && (i.usd || i.usdt)) parts.push(`informal ${i.final ? `el ${shortDay(i.t)}` : 'hoy'}: USD <b>${fmtP(i.usd)}</b> · USDT <b>${fmtP(i.usdt)}</b>`)
	el.hidden = !parts.length || state.chart !== 'history'
	el.innerHTML = parts.join(' · ')
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
			// La franja de las barras amplía la escala hacia abajo: sin etiquetas de precios negativos
			localization: { locale: 'es', priceFormatter: (p) => (p < 0 ? '' : fmtP(p)) },
		})
		bidSeries = historyChart.addLineSeries({ color: css('--bid'), lineWidth: 2, title: 'compra' })
		askSeries = historyChart.addLineSeries({ color: css('--ask'), lineWidth: 2, title: 'venta' })
		// Operaciones por día: barras en una escala propia, en la franja de abajo
		opsSeries = historyChart.addCustomSeries(new DayBars(), { priceScaleId: 'ops', lastValueVisible: false, priceLineVisible: false })
		// Referencia del mercado informal (elTOQUE): una mediana por día, en líneas discontinuas
		usdSeries = historyChart.addLineSeries({ lineWidth: 2, lineStyle: 2, priceLineVisible: false, title: 'USD informal' })
		usdtSeries = historyChart.addLineSeries({ lineWidth: 2, lineStyle: 2, priceLineVisible: false, title: 'USDT' })
		historyChart.priceScale('ops').applyOptions({ scaleMargins: { top: 0.74, bottom: 0 } })
		historyChart.priceScale('right').applyOptions({ scaleMargins: { top: 0.08, bottom: 0.3 } })
		historyChart.timeScale().subscribeSizeChange(fitHistory)
		historyChart.subscribeCrosshairMove((p) => opsLegend(p.time ? (p.time - -new Date().getTimezoneOffset() * 60) * 1000 : null))
		themeHistory()
	}
	const informal = (showInformal() && state.history?.informal) || []
	if (state.history !== historyDrawn) {
		historyDrawn = state.history
		const tz = -new Date().getTimezoneOffset() * 60
		const points = state.history?.points ?? []
		const series = (key) => points.filter((p) => p[key] != null).map((p) => ({ time: Math.floor(p.t / 1000) + tz, value: p[key] }))
		bidSeries.setData(series('buy'))
		askSeries.setData(series('sell'))
		const daily = state.history?.daily ?? []
		// La barra de cada día ocupa los puntos de ese día (en 7 y 30 días hay muchos) y se dibuja como un solo bloque.
		// Con Pro se parte en compras y ventas; los días sin reparto (antes de que QvaPay lo diera) van enteros
		const byDay = new Map()
		for (const p of points) byDay.set(cubaDate(p.t), [...(byDay.get(cubaDate(p.t)) ?? []), p.t])
		opsSeries.setData(
			daily.flatMap((d) => {
				const split = proSplit() && d.buy != null && d.sell != null
				const bar = { day: d.day, total: split ? d.buy + d.sell : d.ops, buy: split ? d.buy : null, partial: d.partial }
				return (byDay.get(d.day) ?? [d.t]).map((t) => ({ time: Math.floor(t / 1000) + tz, ...bar }))
			}),
		)
		const ref = (key) => informal.filter((d) => d[key] != null).map((d) => ({ time: Math.floor(d.t / 1000) + tz, value: d[key] }))
		usdSeries.setData(ref('usd'))
		usdtSeries.setData(ref('usdt'))
		opsLegend()
	}
	fitHistory()
	const first = state.history?.firstPoint
	const step = { 600000: 'cada 10 min', 3600000: 'por hora', 86400000: 'por día' }[state.history?.bucketMs] ?? ''
	const src = informal.length ? ' · discontinuas: mercado informal (elTOQUE)' : ''
	$('chartNote').textContent = first
		? `Mediana de lo completado (24 h), ${step} · barras: operaciones por día${proSplit() ? ' (compras en verde, ventas en rojo)' : ''}${src} · QvaPay desde ${new Date(first).toLocaleDateString('es')}`
		: informal.length
			? `Mercado informal según elTOQUE, por día · QvaPay se registra cada 10 minutos`
			: 'Se registra cada 10 minutos: vuelve en un rato'
	$('chartNote').title =
		'Líneas continuas: mediana de las operaciones completadas en QvaPay en las últimas 24 h, guardada cada 10 minutos. Barras: operaciones completadas por día (hora de Cuba); la más clara es el día en curso.' +
		(proSplit() ? ' Con Pro, cada barra se parte en compras (verde) y ventas (rojo).' : '') +
		(informal.length ? ' Líneas discontinuas: tasa del USD y del USDT en el mercado informal cubano según elTOQUE (eltoque.com), una mediana por día.' : '')
}

// Fecha de Cuba (AAAA-MM-DD) de un instante: así agrupa el servidor las operaciones por día
const cubaDate = (ms) => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/Havana' })

// Serie propia del gráfico para las operaciones por día. Con barras de la librería, un día de 7 o 30 días eran
// decenas de rayas finas con huecos; aquí los puntos seguidos del mismo día se pintan como un solo bloque sólido,
// con un hueco entre días. Compras abajo en verde y ventas encima en rojo; sin reparto, una barra de un color
class DayBars {
	renderer() {
		return this
	}
	update(data) {
		this.data = data
	}
	priceValueBuilder(bar) {
		return [0, bar.total]
	}
	isWhitespace(bar) {
		return bar.total == null
	}
	defaultOptions() {
		return { color: css('--accent') }
	}
	draw(target, toY) {
		const { bars, visibleRange, barSpacing } = this.data ?? {}
		if (!visibleRange) return
		target.useBitmapCoordinateSpace(({ context: ctx, horizontalPixelRatio: hr, verticalPixelRatio: vr }) => {
			const zero = toY(0)
			for (let i = visibleRange.from; i < visibleRange.to; ) {
				const bar = bars[i].originalData
				let j = i
				while (j + 1 < visibleRange.to && bars[j + 1].originalData.day === bar.day) j++
				// Hueco entre días de 2 a 6 px, sin comerse las barras finas (un año entero en un móvil)
				const span = bars[j].x - bars[i].x + barSpacing
				const gap = Math.min(Math.max(barSpacing * 0.3, 2), 6, span * 0.3)
				const x0 = Math.round((bars[i].x - barSpacing / 2 + gap / 2) * hr)
				const width = Math.max(1, Math.round((bars[j].x + barSpacing / 2 - gap / 2) * hr) - x0)
				const fill = (from, to, color) => {
					const top = toY(to)
					const bottom = from ? toY(from) : zero
					if (top == null || bottom == null) return
					ctx.fillStyle = color
					ctx.fillRect(x0, Math.round(top * vr), width, Math.max(1, Math.round(bottom * vr) - Math.round(top * vr)))
				}
				if (bar.buy != null) {
					const alpha = bar.partial ? '55' : '99'
					fill(0, bar.buy, `${css('--bid')}${alpha}`)
					fill(bar.buy, bar.total, `${css('--ask')}${alpha}`)
				} else fill(0, bar.total, `${css('--accent')}${bar.partial ? '40' : '80'}`)
				i = j + 1
			}
		})
	}
}

// Las barras partidas en compras y ventas son de Pro (con Pro encendido en el panel y activo en este dispositivo)
const proSplit = () => !!(window.TPPro?.enabled && window.TPPro?.active)
// Al cambiar Pro (al conectar, comprar o apagarse), se vuelve a dibujar con o sin el reparto
document.addEventListener('tp:pro', () => {
	historyDrawn = null
	if (historyChart && state.chart === 'history') drawHistory()
})

// Se encuadra al abrir un mercado o un rango; con datos nuevos del mismo, se respeta el zoom.
// Con el gráfico oculto (en el móvil, otra sección a la vista) no tiene ancho: se encuadra al mostrarse
function fitHistory() {
	const key = `${state.coin}:${state.range}`
	if (!state.history || key === historyKey || !historyChart.timeScale().width()) return
	historyChart.timeScale().fitContent()
	historyKey = key
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
	usdSeries.applyOptions({ color: css('--warn') })
	usdtSeries.applyOptions({ color: css('--accent') })
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
	// Al volver al histórico, la leyenda vuelve a mostrar el último día
	if (name === 'history' && historyChart) opsLegend()
}

// ── Ranking de usuarios ───────────────────────────────────────────────
// Lo calcula el navegador con los libros que ha leído con tu cuenta (data.js, /api/ranking):
// no se guarda ni se comparte. Los puestos de las insignias son de todos los mercados
const RANK_NAMES = { liquidity: 'liquidez', experience: 'experiencia', reputation: 'reputación', best: 'mejor precio', maker: 'ambos lados', active: 'actividad' }
const ordinal = (n) => `${n}.º`

async function loadRanking() {
	try {
		const q = new URLSearchParams()
		if (state.rank.scope === 'coin') q.set('coin', state.coin)
		if (state.rank.side) q.set('side', state.rank.side)
		const r = await TPApi.fetch(`/api/ranking?${q}`)
		if (!r.ok) throw new Error(String(r.status))
		state.ranking = await r.json()
		renderRanking()
	} catch {}
}

// Puestos de un usuario entre los 10 primeros, del mejor al peor
function rankTop(user, max = 10) {
	const pos = state.ranking?.positions?.[user]
	if (!pos) return []
	return Object.entries(pos)
		.filter(([, r]) => r <= max)
		.sort((a, b) => a[1] - b[1])
}
function rankText(user, n = 3) {
	return rankTop(user)
		.slice(0, n)
		.map(([c, r]) => `${ordinal(r)} en ${RANK_NAMES[c]}`)
		.join(' · ')
}
// Medalla discreta en el libro para el top 3 de experiencia o reputación
function rankMedal(user) {
	const top = rankTop(user, 3).filter(([c]) => c === 'experience' || c === 'reputation')
	if (!top.length) return ''
	const title = top.map(([c, r]) => `${ordinal(r)} en ${RANK_NAMES[c]}`).join(' · ')
	return `<span class="medal" title="Top 3: ${title}" aria-label="Top 3: ${title}"><svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true"><circle cx="6" cy="7" r="4.2"/><path d="M3.6 1h1.8L6 2.6 6.6 1h1.8L7.2 3.6H4.8z"/></svg></span>`
}

function rankValue(c, u) {
	const plural = (n, one, many) => `${n.toLocaleString('es')} ${n === 1 ? one : many}`
	switch (c) {
		case 'liquidity':
			return [`${fmtU(u.usdAsk + u.usdBid)} USD`, `${plural(u.offers, 'oferta', 'ofertas')} · ${plural(u.markets.length, 'mercado', 'mercados')}`]
		case 'experience':
			return [plural(u.ops, 'operación', 'operaciones'), u.rating ? `⭐ ${u.rating.toFixed(2)}` : 'sin valoraciones']
		case 'reputation':
			return [`⭐ ${u.rating.toFixed(2)}`, `${plural(u.ops, 'operación', 'operaciones')} · ajustada ${u.score.toFixed(2)}`]
		case 'best':
			return [plural(u.best, 'lado', 'lados'), u.markets.map(nameOfTick).join(', ')]
		case 'maker':
			return [`${fmtU(u.usdBid)} / ${fmtU(u.usdAsk)} USD`, 'compra / venta']
		case 'active':
			return [`${plural(u.recent, 'oferta', 'ofertas')} en 24 h`, u.lastUpdate ? `la última hace ${ago(Date.now() - u.lastUpdate)}` : '']
	}
	return ['', '']
}
const nameOfTick = (t) => state.overview.find((c) => c.tick === t)?.name ?? t

function renderRanking() {
	for (const b of document.querySelectorAll('[data-crit]')) {
		b.classList.toggle('active', b.dataset.crit === state.rank.crit)
		b.setAttribute('aria-selected', String(b.dataset.crit === state.rank.crit))
	}
	$('rankScope').value = state.rank.scope
	$('rankSide').value = state.rank.side
	const data = state.ranking
	const list = $('rankList')
	if (!data || !data.markets.read) {
		list.innerHTML = data?.connected
			? '<li class="empty">Leyendo los libros: el ranking aparece en unos segundos.</li>'
			: '<li class="empty">El ranking se calcula con el libro en vivo: conecta tu cuenta de QvaPay para verlo.</li>'
		$('rankNote').textContent = ''
		return
	}
	const rows = data.rankings[state.rank.crit] ?? []
	const me = typeof myUsername === 'function' ? myUsername() : null
	list.innerHTML = rows.length
		? rows
				.map(({ rank, stats: u }) => {
					const [main, sub] = rankValue(state.rank.crit, u)
					// KYC no se muestra: QvaPay lo exige a todos para el P2P
					const badges = [u.gold ? 'GOLD' : '', u.vip ? 'VIP' : ''].filter(Boolean).map((b) => `<span class="chip">${b}</span>`).join('')
					return `<li class="${rank <= 3 ? `top top${rank}` : ''} ${u.user === me ? 'mine' : ''}" data-user="${esc(u.user)}" title="Ver la ficha de ${esc(u.user)}">
						<span class="rk">${rank}</span>
						<span class="ru"><b>${u.user === me ? '<em class="you">tú</em> ' : ''}${esc(u.user)}</b>${badges}</span>
						<span class="rv"><b>${main}</b><small>${esc(sub)}</small></span></li>`
				})
				.join('')
		: '<li class="empty">Nadie cumple este criterio con los libros leídos.</li>'
	const scope = state.rank.scope === 'coin' ? nameOfTick(state.coin) : `${data.markets.read} de ${data.markets.total} mercados leídos`
	$('rankNote').textContent = `Con las ofertas publicadas ahora en el libro (${scope}). Lo calcula tu navegador con tu cuenta; no se guarda ni se comparte.`
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
		rankText(l.user) ? `<div>🏆 Ranking: ${rankText(l.user)}</div>` : '',
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

function closeMenus(e) {
	$('filterMenu').hidden = true
	$('filterBtn').setAttribute('aria-expanded', 'false')
	// El menú de ayuda, salvo que el clic sea dentro de él
	for (const d of document.querySelectorAll('details.help[open]')) if (!d.contains(e?.target)) d.open = false
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
	for (const b of document.querySelectorAll('[data-crit]'))
		b.addEventListener('click', () => {
			state.rank.crit = b.dataset.crit
			store.set('rankCrit', state.rank.crit)
			renderRanking()
		})
	// Los nombres de la actividad abren la ficha de esa contraparte
	$('activity').addEventListener('click', (e) => {
		const who = e.target.closest('[data-peer]')
		if (who && typeof showPeer === 'function') showPeer(who.dataset.peer)
	})
	$('rankList').addEventListener('click', (e) => {
		const li = e.target.closest('li[data-user]')
		if (li && typeof showPeer === 'function') showPeer(li.dataset.user)
	})
	$('rankScope').addEventListener('change', (e) => {
		state.rank.scope = e.target.value
		store.set('rankScope', state.rank.scope)
		loadRanking()
	})
	$('rankSide').addEventListener('change', (e) => {
		state.rank.side = e.target.value
		store.set('rankSide', state.rank.side)
		loadRanking()
	})
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
			// El nombre abre su ficha; el resto de la fila, la oferta
			const who = e.target.closest('.who em')
			if (who && typeof showPeer === 'function') return showPeer(who.textContent)
			// broker.js abre la oferta para tomarla; sin él, se abre en QvaPay
			if (typeof showTakeOffer === 'function') showTakeOffer(row.dataset.uuid, row.dataset.side)
			else window.open(`https://www.qvapay.com/p2p/${row.dataset.uuid}`, '_blank', 'noopener')
		})
	}
	window.addEventListener('resize', () => drawActive())
}

bind()
// Paneles redimensionables en escritorio (cuando mercados, gráfico y libro están lado a lado)
window.TPResize?.({
	layout: '#layout',
	key: 'tp.layout',
	minWidth: 1281,
	handles: [
		{ panel: '.area-markets', edge: 'right', v: '--c-markets', min: 200, max: 460 },
		{ panel: '.area-book', edge: 'left', v: '--c-book', min: 300, max: 600 },
		{ panel: '.area-chart', edge: 'bottom', v: '--h-top', min: 280, max: 860 },
	],
})
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
loadRanking()
every(10_000, loadRanking)
every(15_000, loadOverview)
every(60_000, loadHistory)
loadInformal()
every(600_000, loadInformal)
document.addEventListener('visibilitychange', () => {
	if (document.hidden) return
	loadBook()
	loadOverview()
})
