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
	grouped: store.get('grouped', false),
	marketsClosed: store.get('marketsClosed', false),
	filters: { vip: true, outlier: true, take: false, ops: 0, usd: 0, ageH: 0, ...store.get('filters', {}) },
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

// Con el lado, también «Solo las que puedo tomar» (canTake, en broker.js); sin él (referencias de precio, puesto de una
// oferta tuya), ese filtro no aplica
function filtered(levels, side) {
	const f = state.filters
	const take = f.take && side && typeof canTake === 'function'
	// Antigüedad medida contra el reloj del servidor, no el del navegador
	const now = state.book?.serverTime ?? Date.now()
	const maxAge = f.ageH ? f.ageH * 3600_000 : Infinity
	return levels.filter(
		(l) =>
			!(f.vip && l.vipOnly) &&
			!(f.outlier && l.outlier) &&
			l.ops >= f.ops &&
			l.usd >= f.usd &&
			(l.updatedAt == null || now - l.updatedAt <= maxAge) &&
			(!take || canTake(l, side)),
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
		state.overview = await getJSON('/api/overview')
		renderMarkets()
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
	closeMarketSheet()
	renderMarkets()
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
function renderMarkets() {
	$('marketList').innerHTML = marketRows($('marketSearch').value)
}

// Sin la columna de mercados (móvil y pantallas medianas), la misma lista se abre como una hoja desde abajo
const wideLayout = () => matchMedia('(min-width: 1281px)').matches
function openMarketSheet() {
	document.body.classList.add('mk-sheet')
	$('marketsBackdrop').hidden = false
	$('marketList').querySelector('.mrow.active')?.scrollIntoView({ block: 'center' })
}
function closeMarketSheet() {
	if (!document.body.classList.contains('mk-sheet')) return
	document.body.classList.remove('mk-sheet')
	$('marketsBackdrop').hidden = true
	if ($('marketSearch').value) {
		$('marketSearch').value = ''
		renderMarkets()
	}
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
	const asks = filtered(b.ask.levels, 'ask')
	const bids = filtered(b.bid.levels, 'bid')
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
	// Con el libro del servidor, la intención la calcula él (con el libro completo, igual para todos). Si no, aquí; y sin
	// las completadas aún, la aguja espera (con media cuenta saldría otro valor y luego saltaría)
	const si = b.stats?.intent
	if (b.stats) si ? renderIntent(si.bidUsd, si.askUsd, si.mid, si.doneMedian, si) : renderIntent(0, 0, null, null)
	else if (b.completedReady === false) renderIntent(0, 0, null, null)
	else renderIntent(mid ? within(bids, 'bid') : 0, mid ? within(asks, 'ask') : 0, mid, doneMedian)
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
	// Lo que salió o se tomó en la última hora (del feed, también lo tomado en parte)
	const gone = b.activity.filter((a) => (a.kind === 'gone' || a.kind === 'taken' || a.kind === 'partial' || a.kind === 'cancelled') && now - a.t < hour).length
	const last = Math.max(0, ...levels.map((l) => l.updatedAt ?? 0), ...b.activity.map((a) => a.t))
	const done = b.completed
	// Las barras miden lo mismo que el número (operaciones por minuto) frente al ritmo normal de ese mercado: las
	// operaciones completadas por minuto en la ventana de QvaPay. Sin ese ritmo, por umbrales fijos
	const pace = b.stats?.pace ?? (done?.count && done.window_hours ? done.count / done.window_hours / 60 : null)
	const ops = opsPerMin(b)
	const ratio = pace ? ops / pace : null
	const level = !ops ? 0 : ratio != null ? (ratio >= 2 ? 4 : ratio >= 1 ? 3 : ratio >= 0.4 ? 2 : 1) : ops >= 3 ? 4 : ops >= 1 ? 3 : ops >= 0.3 ? 2 : 1
	return { level, fresh, gone, last: last ? now - last : null, pace, ratio, ops }
}
// Operaciones por minuto: lo que se tomó (entero o en parte) en los últimos minutos, pesando más lo reciente (cada toma
// pesa e^(-edad/OPS_TAU_MS)). Así el número es el real y se mueve de verdad: baja poco a poco entre tomas y sube en
// cuanto alguien toma. Con la actividad del feed se sabe qué se tomó; sin ella, se cuenta lo que salió del libro
// (tomado o retirado: QvaPay no lo dice)
const OPS_TAU_MS = 5 * 60_000
const OPS_HORIZON_MS = 30 * 60_000
function opsPerMin(b) {
	const now = Date.now()
	const taken = (a) => (b.activitySource === 'feed' ? a.kind === 'taken' || a.kind === 'partial' : a.kind === 'gone')
	// Con el libro del servidor, sus tomas (todas las de la última media hora); si no, la actividad que hay aquí
	const times = b.stats ? b.stats.takes : b.activity.filter(taken).map((a) => a.t)
	const weight = times.filter((t) => now - t <= OPS_HORIZON_MS).reduce((sum, t) => sum + Math.exp(-Math.max(0, now - t) / OPS_TAU_MS), 0)
	const r = weight / (OPS_TAU_MS / 60_000)
	return r < 0.01 ? 0 : r
}
// o/m: operaciones por minuto
const opsText = (r) => `${r >= 10 ? Math.round(r) : r.toLocaleString('es', { minimumFractionDigits: r ? 2 : 0, maximumFractionDigits: 2 })} o/m`

function renderPulse(b) {
	const el = $('pulse')
	const r = pulseScore(b)
	el.classList.toggle('off', !r)
	el.dataset.level = r ? String(r.level) : ''
	const label = r ? opsText(r.ops) : '—'
	el.setAttribute('aria-label', r ? `Actividad del mercado: ${label} (${PULSE[r.level].toLowerCase()})` : 'Actividad del mercado: sin libro en vivo')
	// Se arma una vez; luego solo cambian las barras encendidas y el número
	if (!el.querySelector('.pulse-body'))
		el.innerHTML = `<label>Actividad</label><div class="pulse-body" aria-hidden="true">${[1, 2, 3, 4].map((i) => `<i style="height:${6 + i * 4}px"></i>`).join('')}<span></span></div>`
	el.querySelectorAll('.pulse-body i').forEach((bar, i) => bar.classList.toggle('on', !!r && r.level >= i + 1))
	el.querySelector('.pulse-body span').textContent = label
	el.removeAttribute('title')
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
// Semicírculo de 180°: la aguja apunta hacia arriba y gira de -90° (0, a la izquierda) a 90° (100, a la derecha)
const needleDeg = (score) => `rotate(${((score - 50) * 1.8).toFixed(1)}deg)`
// Como una aguja de verdad, oscila un poco (±INTENT_WOBBLE de 100) alrededor del valor real; el valor exacto está en
// la explicación. Sin oscilación con «reducir movimiento» o la pestaña oculta
const INTENT_WOBBLE = 2
const calm = window.matchMedia?.('(prefers-reduced-motion: reduce)')
setInterval(() => {
	const el = $('intent')
	const line = el?.querySelector('.g-needle')
	if (!line || document.hidden || calm?.matches || el.dataset.score === '') return
	const real = Number(el.dataset.score)
	line.style.transform = needleDeg(Math.max(0, Math.min(100, real + (Math.random() * 2 - 1) * INTENT_WOBBLE)))
}, 700)

// given: la intención ya calculada (la del servidor); si no, se calcula aquí
function renderIntent(bidUsd, askUsd, mid, doneMedian, given) {
	const el = $('intent')
	const r = given ?? intentScore(bidUsd, askUsd, mid, doneMedian)
	const s = r?.score ?? 50
	const [label, cls] = !r ? ['—', ''] : s >= 60 ? ['Más compran', 'bid'] : s <= 40 ? ['Más venden', 'ask'] : ['Equilibrio', '']
	const arc = (from, to) => {
		const p = (t) => [(23 + 19 * Math.cos(Math.PI * (1 - t))).toFixed(1), (23 - 19 * Math.sin(Math.PI * (1 - t))).toFixed(1)]
		const [x1, y1] = p(from)
		const [x2, y2] = p(to)
		return `M${x1} ${y1} A19 19 0 0 1 ${x2} ${y2}`
	}
	el.classList.toggle('off', !r)
	el.dataset.side = cls
	el.dataset.score = r ? String(s) : ''
	el.setAttribute('aria-label', r ? `Intención del mercado: ${label}, ${s} de 100` : 'Intención del mercado: sin libro en vivo')
	el.innerHTML = `<label>Intención</label><div class="intent-body">
		<svg class="gauge" viewBox="0 0 46 27" width="46" height="27" aria-hidden="true">
			<path class="g-ask" d="${arc(0, 0.39)}"/><path class="g-mid" d="${arc(0.41, 0.59)}"/><path class="g-bid" d="${arc(0.61, 1)}"/>
			<line class="g-needle" x1="23" y1="23" x2="23" y2="8" style="transform:${needleDeg(s)}"/><circle class="g-hub" cx="23" cy="23" r="2.6"/>
		</svg></div>`
	el.title = r
		? `Intención del mercado: ${s} de 100 (0 = más venden, 100 = más compran).\n` +
			`· Profundidad a ±2% del medio: ${fmtU(bidUsd)} USD a la compra frente a ${fmtU(askUsd)} a la venta (${Math.round(r.depth * 100)}% compra). Pesa un 70%.\n` +
			(r.drift != null ? `· El medio está a ${pct(r.drift)} de la mediana de lo completado. Pesa un 30%.` : '· Sin mediana de lo completado para comparar el precio.')
		: 'La intención del mercado se calcula con el libro en vivo: conecta tu cuenta de QvaPay.'
}

// Lo que cambió desde el último libro pintado destella: verde si la oferta es nueva o sube su monto, rojo si baja,
// azul si cambió el precio; la que se toma entera o se retira se queda un momento tachada y se apaga en su sitio. Cada
// marca dura FLASH_MS aunque el libro se repinte entretanto (la animación sigue por donde iba)
const FLASH_MS = 1200
const seen = { coin: null, rows: new Map(), best: null }
const marks = new Map()

function diffBook(b) {
	const now = Date.now()
	for (const [k, m] of marks) if (now - m.t > FLASH_MS) marks.delete(k)
	const rows = new Map()
	for (const s of ['ask', 'bid']) for (const l of b[s].levels) rows.set(l.uuid, { l, side: s })
	// Un lado que aún no se había leído llega entero de golpe: eso no es un cambio del mercado
	const had = new Set([...seen.rows.values()].map((r) => r.side))
	if (seen.coin !== state.coin) {
		marks.clear()
	} else {
		for (const [uuid, { l, side }] of rows) {
			if (!had.has(side)) continue
			const was = seen.rows.get(uuid)?.l
			const kind = !was ? 'up' : l.price !== was.price ? 'edit' : l.usd > was.usd ? 'up' : l.usd < was.usd ? 'down' : null
			if (kind) marks.set(uuid, { kind, t: now })
		}
		const has = new Set([...rows.values()].map((r) => r.side))
		for (const [uuid, was] of seen.rows) if (!rows.has(uuid) && has.has(was.side)) marks.set(uuid, { kind: 'gone', t: now, ...was })
	}
	seen.coin = state.coin
	seen.rows = rows
}

const markOf = (uuid) => {
	const m = marks.get(uuid)
	const age = m ? Date.now() - m.t : FLASH_MS
	return age < FLASH_MS ? { cls: m.kind === 'gone' ? 'gone' : `flash-${m.kind}`, style: `--fd:-${age}ms;` } : null
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
	const mark = markOf(l.uuid)
	return `<div class="lvl ${l.outlier || l.vipOnly ? 'dim' : ''} ${mine ? 'mine' : ''} ${mark?.cls ?? ''}" data-uuid="${l.uuid}" data-side="${side}"
		style="${mark?.style ?? ''}background-image:linear-gradient(to left, ${color} ${w}%, transparent ${w}%)">
		<span class="p">${fmtP(l.price)}</span><span class="u">${fmtU(l.usd)}</span><span class="c">${fmtU(cum)}</span>
		<span class="who">${mine ? '<b class="you">tú</b>' : ''}${medal}<em title="Ver la ficha de ${esc(l.user)}">${esc(l.user)}</em> ${l.ops} · ${rep}${flags ? `<span class="flag">${flags}</span>` : ''}</span></div>`
}

// ── Libro agrupado por rangos de precio ───────────────────────────────
// El rango sale del precio: un 0,5 % redondeado a 1, 2 o 5 (5 CUP en CUP Transferencia, 0,005 en MLC). Las ventas se
// agrupan hacia arriba y las compras hacia abajo, como en los exchanges: el rango «1.075» de las ventas va de 1.070 a 1.075
function stepOf(price) {
	const raw = price * 0.005
	const pow = 10 ** Math.floor(Math.log10(raw))
	return [1, 2, 5, 10].map((m) => m * pow).find((x) => x >= raw * 0.75) ?? 10 * pow
}
const fmtStep = (x) => x.toLocaleString('es', { maximumFractionDigits: 4 })

const groups = { ask: new Map(), bid: new Map() }

function groupOf(levels, side, step) {
	const bucket = (p) => (side === 'ask' ? Math.ceil(p / step - 1e-9) : Math.floor(p / step + 1e-9))
	const out = new Map()
	for (const l of levels) {
		const k = bucket(l.price)
		const g = out.get(k) ?? { key: k, price: k * step, step, usd: 0, members: [], gone: [] }
		g.usd += l.usd
		g.members.push(l)
		out.set(k, g)
	}
	// Las que se acaban de ir también hacen destellar su rango (en rojo)
	for (const m of marks.values()) if (m.kind === 'gone' && m.side === side) out.get(bucket(m.l.price))?.gone.push(m)
	return out
}

function groupMark(g) {
	const ms = [...g.members.map((l) => marks.get(l.uuid)).filter((m) => m && m.kind !== 'gone'), ...g.gone]
	const m = ms.sort((a, b) => b.t - a.t)[0]
	const age = m ? Date.now() - m.t : FLASH_MS
	return age < FLASH_MS ? { cls: `flash-${m.kind === 'gone' ? 'down' : m.kind}`, style: `--fd:-${age}ms;` } : null
}

function groupRow(g, side, cum, maxCum) {
	const color = side === 'ask' ? 'var(--ask-bg)' : 'var(--bid-bg)'
	const w = maxCum ? Math.max(2, (cum / maxCum) * 100) : 0
	const best = g.members[0]
	const dim = g.members.every((l) => l.outlier || l.vipOnly)
	const mine = typeof myUsername === 'function' && g.members.some((l) => myUsername() === l.user)
	const mark = groupMark(g)
	const n = g.members.length
	return `<div class="lvl grp ${dim ? 'dim' : ''} ${mine ? 'mine' : ''} ${mark?.cls ?? ''}" data-uuid="${best.uuid}" data-side="${side}" data-group="${g.key}"
		style="${mark?.style ?? ''}background-image:linear-gradient(to left, ${color} ${w}%, transparent ${w}%)">
		<span class="p">${fmtP(g.price)}</span><span class="u">${fmtU(g.usd)}</span><span class="c">${fmtU(cum)}</span>
		<span class="who">${n} ${n === 1 ? 'oferta' : 'ofertas'}${mine ? ' · <b class="you">tú</b>' : ''} · <em title="Ver la ficha de ${esc(best.user)}">${esc(best.user)}</em></span></div>`
}

function groupTip(g, side) {
	const unit = state.book.coin.unit
	const prices = g.members.map((l) => l.price)
	const lo = side === 'ask' ? g.price - g.step : g.price
	const hi = side === 'ask' ? g.price : g.price + g.step
	const best = g.members[0]
	return [
		`<div><b>${fmtP(lo)} – ${fmtP(hi)}</b> ${unit}/USD</div>`,
		`<div>${g.members.length} ${g.members.length === 1 ? 'oferta' : 'ofertas'} que ${side === 'ask' ? 'venden' : 'compran'} ${fmtU(g.usd)} USD en total</div>`,
		g.members.length > 1 ? `<div>Precios de ${fmtP(Math.min(...prices))} a ${fmtP(Math.max(...prices))}</div>` : '',
		`<div>La mejor: @${esc(best.user)} a ${fmtP(best.price)} · ${fmtU(best.usd)} USD</div>`,
		'<div class="muted">Clic para ver y tomar la mejor oferta del rango</div>',
	].join('')
}

function renderGroupBtn(price) {
	$('groupBtn').setAttribute('aria-pressed', String(state.grouped))
	// Solo el icono: el tamaño del rango va en la descripción del botón
	const step = price ? ` de ${fmtStep(stepOf(price))} ${state.book?.coin.unit ?? ''}`.trimEnd() : ''
	$('groupBtn').title = state.grouped ? `Libro agrupado en rangos${step}: clic para ver cada oferta` : 'Agrupar el libro por rangos de precio'
	$('bookWho').textContent = state.grouped ? 'Ofertas · mejor' : 'Contraparte'
}

function renderBook(b, asks, bids) {
	const N = 30
	diffBook(b)
	// Mismo rango para los dos lados, según el primer precio del libro
	const step = stepOf(asks[0]?.price ?? bids[0]?.price ?? 1)
	// Las que se fueron hace nada (y pasarían los filtros) se intercalan en su precio, sin contar en el acumulado
	const goneOf = (s) => filtered([...marks.values()].filter((m) => m.kind === 'gone' && m.side === s && Date.now() - m.t < FLASH_MS).map((m) => m.l), s)
	const side = (levels, s) => {
		if (!levels.length)
			return `<div class="empty">${b[s].error ? `QvaPay no deja leer el libro con tu cuenta:<br><b>${esc(b[s].error)}</b>` : 'Sin ofertas con estos filtros'}</div>`
		let cum = 0
		if (state.grouped) {
			groups[s] = groupOf(levels, s, step)
			const rows = [...groups[s].values()].slice(0, N).map((g) => ({ g, cum: (cum += g.usd) }))
			return rows.map(({ g, cum }) => groupRow(g, s, cum, rows.at(-1).cum)).join('')
		}
		const rows = levels.slice(0, N).map((l) => ({ l, cum: (cum += l.usd) }))
		const max = rows.at(-1).cum
		const worse = (x, y) => (s === 'ask' ? x > y : x < y)
		for (const l of goneOf(s)) {
			if (worse(l.price, rows.at(-1).l.price)) continue
			const i = rows.findIndex((r) => worse(r.l.price, l.price))
			const at = i < 0 ? rows.length : i
			rows.splice(at, 0, { l, cum: at ? rows[at - 1].cum : 0 })
		}
		return rows.map(({ l, cum }) => levelRow(l, s, cum, max)).join('')
	}
	$('asks').innerHTML = side(asks, 'ask')
	$('bids').innerHTML = side(bids, 'bid')
	renderGroupBtn(asks[0]?.price ?? bids[0]?.price)
	const hidden = b.ask.levels.length + b.bid.levels.length - asks.length - bids.length
	$('bookCount').textContent = `${b.ask.total} / ${b.bid.total} ofertas${hidden ? ` · ${hidden} ocultas` : ''}`
	$('bookCount').title = `${b.ask.total} ventas y ${b.bid.total} compras en QvaPay`

	const ask = asks[0]?.price
	const bid = bids[0]?.price
	const el = $('spread')
	// El diferencial destella cuando se mueve la mejor venta o la mejor compra
	const best = `${state.coin}:${ask}:${bid}`
	if (seen.best && seen.best !== best && seen.best.startsWith(`${state.coin}:`)) marks.set('spread', { kind: 'edit', t: Date.now() })
	seen.best = best
	const flash = markOf('spread')
	el.style.cssText = flash?.style ?? ''
	if (ask && bid) {
		const crossed = bid > ask
		el.className = `spread ${crossed ? 'crossed' : ''} ${flash?.cls ?? ''}`
		el.innerHTML = crossed
			? `<span class="lbl">Libro cruzado</span><span>${fmtP(bid)} &gt; ${fmtP(ask)} · ${pct(bid / ask - 1)}</span>`
			: `<span class="lbl">Diferencial</span><span>${fmtP(ask - bid)} · ${pct(ask / bid - 1)}</span>`
	} else {
		el.className = `spread ${flash?.cls ?? ''}`
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

// Lo que pasa en el libro. Si el mercado llega desde el servidor, del feed de QvaPay: ofertas nuevas, tomadas (enteras o
// en parte), retiradas, editadas y operaciones completadas. Si no, comparando lecturas: solo se ve qué entra y qué sale
// (y de una que sale no se sabe si la tomaron o la retiró su dueño)
const ACT_PATH = {
	plus: 'M12 6v12M6 12h12',
	out: 'M14 5h4a1 1 0 011 1v12a1 1 0 01-1 1h-4M9 16l-4-4 4-4M5 12h10',
	hand: 'M5 12h10M11 8l4 4-4 4M19 5v14',
	part: 'M4 12h7M15 12h5M11 8l4 4-4 4',
	back: 'M19 12H9M13 8l-4 4 4 4',
	edit: 'M4 20h4L19 9l-4-4L4 16v4z',
	done: 'M5 12.5l4.5 4.5L19 7',
}
const actIcon = (d) => `<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="${d}" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`
// [icono, texto («una venta» o «una compra» va en {s}), explicación al pasar el ratón]
const ACT = {
	new: ['plus', 'Entra {s}', 'Oferta nueva'],
	reopened: ['plus', 'Vuelve {s}', 'La contraparte se retiró o se le venció el plazo de pago: la oferta vuelve al libro'],
	taken: ['hand', 'Toman {s}', 'Alguien la tomó entera'],
	partial: ['part', 'Toman parte de {s}', 'Alguien tomó una parte de esta oferta por rango'],
	returned: ['back', 'Vuelve parte a {s}', 'Una parte tomada volvió (se canceló o se venció el plazo)'],
	cancelled: ['out', 'Retiran {s}', 'Su dueño la retiró del libro'],
	edited: ['edit', 'Cambia {s}', 'Su dueño cambió el precio o el monto'],
	done: ['done', 'Se completa {s}', 'Operación terminada a este precio'],
	gone: ['out', 'Sale {s}', 'La tomó alguien o la retiró su dueño; QvaPay no indica cuál'],
}
const ACT_OUT = new Set(['gone', 'taken', 'partial', 'cancelled'])
function renderActivity(b) {
	const items = b.activity.slice(0, 40)
	// Solo se repinta si cambió algo: repintar con cada lectura del libro haría perder el clic en un nombre
	const key = `${b.activitySource}|${items.map((a) => `${a.t}:${a.kind}:${a.user}:${a.price}:${a.usd}`).join('|')}`
	if ($('activity').dataset.key === key) return
	$('activity').dataset.key = key
	const note =
		b.activitySource === 'feed'
			? '<li class="act-note">Lo que pasa en el libro según QvaPay: ofertas nuevas, tomadas (enteras o en parte), retiradas y operaciones completadas.</li>'
			: '<li class="act-note">Ofertas que entran y salen del libro. Las que salen las tomó alguien o las retiró su dueño: QvaPay no indica cuál.</li>'
	$('activity').innerHTML = items.length
		? note +
			items
				.map((a) => {
					const [icon, text, tip] = ACT[a.kind] ?? ACT.gone
					const t = new Date(a.t).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' })
					const what = text.replace('{s}', a.side === 'ask' ? 'una venta' : 'una compra')
					const who = a.user && a.user !== '—' ? ` · <button type="button" class="link peer-link" data-peer="${esc(a.user)}" title="Ver su ficha">@${esc(a.user)}</button>` : ''
					return `<li title="${tip}"><time>${t}</time><span class="act"><i class="act-ic ${ACT_OUT.has(a.kind) ? 'gone' : ''} ${a.side}">${actIcon(ACT_PATH[icon])}</i><span>${what} · ${fmtU(a.usd)} USD${who}</span></span><span class="px ${a.side}">${fmtP(a.price)}</span></li>`
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
	const asks = filtered(b.ask.levels, 'ask')
	const bids = filtered(b.bid.levels, 'bid')
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
	const asks = filtered(state.book.ask.levels, 'ask')
	const bids = filtered(state.book.bid.levels, 'bid')
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
		// Referencia del mercado informal (elTOQUE): una mediana por día, en líneas discontinuas. No mueven la escala si
		// hay tasa de QvaPay (suele estar lejos y aplastaría las líneas de compra y venta); se ven si caen dentro
		const ownScale = (original) => (bidSeries.data().length || askSeries.data().length ? null : original())
		usdSeries = historyChart.addLineSeries({ lineWidth: 2, lineStyle: 2, priceLineVisible: false, title: 'USD informal', autoscaleInfoProvider: ownScale })
		usdtSeries = historyChart.addLineSeries({ lineWidth: 2, lineStyle: 2, priceLineVisible: false, title: 'USDT', autoscaleInfoProvider: ownScale })
		// Las barras, bajas (el 15 % de abajo), y las tasas en el resto del alto
		historyChart.priceScale('ops').applyOptions({ scaleMargins: { top: 0.85, bottom: 0 } })
		historyChart.priceScale('right').applyOptions({ scaleMargins: { top: 0.08, bottom: 0.19 } })
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

// Se encuadra al abrir un mercado o un rango (todo el periodo a lo ancho y la escala de precios automática otra vez,
// aunque se hubiera arrastrado); con datos nuevos del mismo, se respeta el zoom.
// Con el gráfico oculto (en el móvil, otra sección a la vista) no tiene ancho: se encuadra al mostrarse
function fitHistory() {
	const key = `${state.coin}:${state.range}`
	if (!state.history || key === historyKey || !historyChart.timeScale().width()) return
	historyChart.priceScale('right').applyOptions({ autoScale: true })
	historyChart.priceScale('ops').applyOptions({ autoScale: true })
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
// «Solo las que puedo tomar» necesita la cuenta conectada
function renderTakeHint() {
	const on = typeof myUsername === 'function' && !!myUsername()
	$('fTake').disabled = !on
	$('fTakeHint').hidden = on
}

function renderFilterCount() {
	const f = state.filters
	const n = [!f.vip, !f.outlier, f.take, f.ops > 0, f.usd > 0, f.ageH > 0].filter(Boolean).length
	$('filterCount').hidden = !n
	$('filterCount').textContent = String(n)
}

// ── Eventos ───────────────────────────────────────────────────────────
// La lista de mercados se colapsa en escritorio en una franja estrecha (el gráfico y el libro ganan ancho)
function renderMarketsPanel() {
	const closed = state.marketsClosed
	$('layout').classList.toggle('mk-closed', closed)
	const panel = document.querySelector('.area-markets')
	if (closed) panel.dataset.collapsed = ''
	else delete panel.dataset.collapsed
	const label = closed ? 'Mostrar la lista de mercados' : 'Ocultar la lista de mercados'
	$('marketsToggle').setAttribute('aria-expanded', String(!closed))
	$('marketsToggle').setAttribute('aria-label', label)
	$('marketsToggle').title = label
	// Las asas de redimensionar se recolocan con el ancho nuevo
	window.dispatchEvent(new Event('resize'))
}

function bind() {
	$('marketsHead').addEventListener('click', (e) => {
		if (!state.marketsClosed && !e.target.closest('#marketsToggle')) return
		state.marketsClosed = !state.marketsClosed
		store.set('marketsClosed', state.marketsClosed)
		renderMarketsPanel()
	})
	$('marketList').addEventListener('click', (e) => {
		const row = e.target.closest('[data-tick]')
		if (row) selectCoin(row.dataset.tick)
	})
	// El par: en escritorio abre la columna si estaba colapsada y va al buscador; sin columna, abre la hoja
	$('pairBtn').addEventListener('click', () => {
		if (!wideLayout()) return openMarketSheet()
		if (state.marketsClosed) {
			state.marketsClosed = false
			store.set('marketsClosed', false)
			renderMarketsPanel()
		}
		$('marketSearch').focus()
	})
	$('marketsClose').addEventListener('click', closeMarketSheet)
	$('marketsBackdrop').addEventListener('click', closeMarketSheet)
	// Al pasar a escritorio con la hoja abierta, se cierra (la columna ya está a la vista)
	matchMedia('(min-width: 1281px)').addEventListener('change', (e) => e.matches && closeMarketSheet())
	$('marketSearch').addEventListener('input', renderMarkets)
	$('filterBtn').addEventListener('click', (e) => {
		e.stopPropagation()
		toggleMenu('filterMenu', 'filterBtn', renderTakeHint)
	})
	$('filterMenu').addEventListener('click', (e) => e.stopPropagation())
	for (const t of document.querySelectorAll('[data-view]')) t.addEventListener('click', () => showView(t.dataset.view))
	document.addEventListener('click', closeMenus)
	document.addEventListener('keydown', (e) => {
		if (e.key !== 'Escape') return
		closeMenus()
		closeMarketSheet()
	})

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
	$('fTake').checked = f.take
	$('fOps').value = String(f.ops)
	$('fUsd').value = String(f.usd)
	$('fAge').value = String(f.ageH)
	const onFilter = () => {
		state.filters = {
			vip: $('fVip').checked,
			outlier: $('fOutlier').checked,
			take: $('fTake').checked,
			ops: Number($('fOps').value),
			usd: Number($('fUsd').value),
			ageH: Number($('fAge').value),
		}
		store.set('filters', state.filters)
		renderFilterCount()
		render()
	}
	for (const id of ['fVip', 'fOutlier', 'fTake', 'fOps', 'fUsd', 'fAge']) $(id).addEventListener('change', onFilter)
	$('filterReset').addEventListener('click', () => {
		$('fVip').checked = true
		$('fOutlier').checked = true
		$('fTake').checked = false
		$('fOps').value = $('fUsd').value = $('fAge').value = '0'
		onFilter()
	})
	renderFilterCount()

	$('groupBtn').addEventListener('click', () => {
		state.grouped = !state.grouped
		store.set('grouped', state.grouped)
		render()
	})

	const tip = $('tip')
	for (const id of ['asks', 'bids']) {
		const el = $(id)
		el.addEventListener('mousemove', (e) => {
			const row = e.target.closest('.lvl')
			const g = row?.dataset.group != null && groups[row.dataset.side].get(Number(row.dataset.group))
			const l = row && findLevel(row.dataset.uuid, row.dataset.side)
			if (!l) return (tip.hidden = true)
			tip.innerHTML = g ? groupTip(g, row.dataset.side) : tooltip(l, row.dataset.side)
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
renderMarketsPanel()
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
// Las operaciones por minuto cambian con el tiempo (lo reciente pesa más): se recalculan cada segundo
every(1000, () => state.book && renderPulse(state.book))
// Lo que empuja el servidor (al instante con Pro, cada 10 s sin Pro) se pinta en cuanto llega. Las dos mitades del
// libro llegan seguidas: se espera un momento para pintarlas juntas
let liveDraw = null
window.addEventListener('tp:live', (e) => {
	if (e.detail !== state.coin || document.hidden || liveDraw) return
	liveDraw = setTimeout(() => {
		liveDraw = null
		loadBook()
	}, 120)
})
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
