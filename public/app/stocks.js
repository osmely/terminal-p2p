// Mercado «Acciones · QvaPay» (experimental, solo para mirar): sale al final de la lista de mercados y, al elegirlo, el
// centro del terminal enseña las acciones que vende QvaPay (su cotización pública cada 5 minutos, el histórico de 1 hora
// a 1 año y si la bolsa de Nueva York está abierta) en vez del libro del P2P. Comprar y vender se hace en QvaPay: aquí
// no se compra ni se vende nada. Con Pro, los avisos de precio por Telegram (los mismos de la tasa, worker/ratealerts.ts)
'use strict'
;(() => {
	const view = document.getElementById('stkRoot')
	if (!view) return
	const $s = (id) => document.getElementById(id)
	const SAVED = 'stk.on'
	const FRAMES = [
		['1H', '1 h'],
		['24H', '24 h'],
		['1W', '1 sem'],
		['1M', '1 mes'],
		['1Y', '1 año'],
	]
	// Las de 1 mes y 1 año son de un punto por día: van con su fecha, sin pasarlas a la hora de Cuba
	const DAILY = new Set(['1M', '1Y'])
	const QVAPAY_STOCKS = 'https://www.qvapay.com/dashboard/stocks'
	let on = false
	let list = []
	let market = null
	let listAt = 0
	let sel = store.get('stk.sel', 'SPY')
	let tf = store.get('stk.tf', '24H')
	if (!FRAMES.some(([f]) => f === tf)) tf = '24H'
	const hist = new Map()
	// La ficha de cada una (apertura, máximo, 52 semanas…): se pide solo de la que se mira
	const details = new Map()
	let chart = null
	let series = null
	let drawnKey = ''
	let timer = null
	// Quien pide un aviso desde aquí: la pestaña de avisos lo trae elegido
	let pick = null

	if (typeof PRO_FEATURES !== 'undefined') PRO_FEATURES.push(['🔔', 'Avisos de acciones', 'por Telegram, cuando una acción de QvaPay pasa tu precio'])

	const money = (n, d = 2) => (n == null || !isFinite(n) ? '—' : n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }))
	const signed = (n, d = 2) => (n == null || !isFinite(n) ? '—' : `${n > 0 ? '+' : n < 0 ? '−' : ''}${money(Math.abs(n), d)}`)
	const compact = (n) => {
		if (n == null || !isFinite(n)) return '—'
		if (n >= 1e9) return `${money(n / 1e9)} B`
		if (n >= 1e6) return `${money(n / 1e6)} M`
		if (n >= 1e3) return `${money(n / 1e3)} K`
		return money(n, 0)
	}
	const tone = (n) => (n > 0 ? 'bid' : n < 0 ? 'ask' : '')
	const quote = (s) => list.find((q) => q.symbol === s)
	// La de la lista con lo que trae su ficha (si ya llegó)
	const full = (s) => {
		const q = quote(s)
		const d = details.get(s)?.quote
		if (!d) return q
		const out = { ...(q ?? {}), ...Object.fromEntries(Object.entries(d).filter(([, v]) => v != null)) }
		// El precio, el más reciente de los dos
		if (q && (details.get(s).at ?? 0) < listAt) Object.assign(out, { price: q.price, change: q.change ?? out.change, changeDollar: q.changeDollar ?? out.changeDollar })
		return out
	}
	const icon = (s) => `<span class="coin-ic stk-ic" data-i="${esc(s.charAt(0))}" aria-hidden="true"></span>`

	// ── Datos ────────────────────────────────────────────────────────────
	async function loadList() {
		try {
			const r = await fetch('/data/stocks')
			if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? 'No se pudieron leer las acciones')
			const d = await r.json()
			list = d.stocks ?? []
			market = d.market ?? null
			listAt = d.at ?? Date.now()
			if (!quote(sel) && list.length) sel = list[0].symbol
		} catch (e) {
			if (!list.length) $s('stkAt').textContent = e.message
		}
		if (on) {
			renderList()
			renderHead()
			window.render?.()
		}
	}

	async function loadDetail(s) {
		const had = details.get(s)
		if (had && Date.now() - had.got < 120_000) return
		try {
			const r = await fetch(`/data/stocks/quote?s=${encodeURIComponent(s)}`)
			if (!r.ok) return
			const d = await r.json()
			details.set(s, { quote: d.quote, at: d.at, got: Date.now() })
		} catch {
			return
		}
		if (on && s === sel) renderHead()
	}

	async function loadHistory(s, f, force = false) {
		const key = `${s}|${f}`
		const had = hist.get(key)
		if (had && !force && Date.now() - had.got < 60_000) return draw()
		if (!had) {
			$s('stkChartMsg').textContent = 'Cargando…'
			$s('stkChartMsg').hidden = false
		}
		try {
			const r = await fetch(`/data/stocks/history?s=${encodeURIComponent(s)}&tf=${f}`)
			if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? 'No se pudo leer el histórico')
			const d = await r.json()
			hist.set(key, { points: d.points ?? [], got: Date.now() })
		} catch (e) {
			if (!hist.has(key) && s === sel && f === tf) {
				$s('stkChartMsg').textContent = e.message
				$s('stkChartMsg').hidden = false
			}
			return
		}
		if (s === sel && f === tf) draw()
	}

	// ── Pintar ───────────────────────────────────────────────────────────
	function renderList() {
		$s('stkList').innerHTML = list.length
			? list
					.map(
						(q) => `<button class="stk-row ${q.symbol === sel ? 'active' : ''}" data-stk="${esc(q.symbol)}" role="option" aria-selected="${q.symbol === sel}">
					${icon(q.symbol)}<span class="stk-name"><b>${esc(q.symbol)}</b><span>${esc(q.name)}</span></span>
					<span class="stk-px"><span class="num">${money(q.price)}</span><small class="num ${tone(q.change)}">${signed(q.change)} %</small></span></button>`,
					)
					.join('')
			: '<div class="empty">Cargando…</div>'
		const status = market ? (market.open ? `Bolsa de Nueva York abierta · cierra a las ${cubaTime(market.until)}` : `Bolsa cerrada · abre ${cubaFmt(market.until, { weekday: 'short', day: 'numeric', month: 'short' })}, ${cubaTime(market.until)}`) : ''
		$s('stkAt').textContent = list.length ? `${status}${status ? ' · ' : ''}precios de las ${cubaTime(listAt)} (hora de Cuba)` : $s('stkAt').textContent
	}

	function renderHead() {
		const q = full(sel)
		if (!q) {
			$s('stkHead').innerHTML = '<div class="empty">Cargando…</div>'
			return
		}
		const range = q.low52 && q.high52 ? `${money(q.low52)} – ${money(q.high52)}` : '—'
		$s('stkHead').innerHTML = `<div class="stk-title">${icon(q.symbol)}<div><h3>${esc(q.fullName)}</h3><p>${esc(q.symbol)} · en USD de saldo QvaPay</p></div></div>
			<div class="stk-price"><b class="num">${money(q.price)}</b><span class="num ${tone(q.change)}">${signed(q.changeDollar)} (${signed(q.change)} %)</span><small>hoy</small></div>
			<dl class="stk-stats">
				<div><dt>Apertura</dt><dd class="num">${money(q.open)}</dd></div>
				<div><dt>Máximo</dt><dd class="num">${money(q.high)}</dd></div>
				<div><dt>Mínimo</dt><dd class="num">${money(q.low)}</dd></div>
				<div><dt>Cierre anterior</dt><dd class="num">${money(q.previousClose)}</dd></div>
				<div><dt>52 semanas</dt><dd class="num">${range}</dd></div>
				<div><dt>Volumen</dt><dd class="num">${compact(q.volume)}</dd></div>
			</dl>`
		const alertBtn = $s('stkAlert')
		alertBtn.hidden = !window.TPPro?.enabled
		alertBtn.title = `Avísame por Telegram cuando ${q.symbol} suba o baje del precio que pongas (modo Pro)`
	}

	function chartColors() {
		return {
			layout: { textColor: css('--muted') },
			grid: { vertLines: { color: css('--line') }, horzLines: { color: css('--line') } },
			rightPriceScale: { borderColor: css('--line') },
			timeScale: { borderColor: css('--line') },
		}
	}

	function draw() {
		const h = hist.get(`${sel}|${tf}`)
		renderFrames(h)
		if (!h || !window.LightweightCharts) return
		const msg = $s('stkChartMsg')
		msg.hidden = h.points.length > 1
		if (h.points.length <= 1) msg.textContent = 'Sin histórico en este intervalo'
		if (!chart) {
			chart = LightweightCharts.createChart($s('stkChart'), {
				autoSize: true,
				layout: { background: { color: 'transparent' }, fontFamily: 'JetBrains Mono' },
				timeScale: { timeVisible: true, secondsVisible: false },
				localization: { locale: 'es', priceFormatter: (p) => money(p) },
				handleScroll: false,
				handleScale: false,
			})
			chart.applyOptions(chartColors())
			series = chart.addAreaSeries({ lineWidth: 2, priceLineVisible: true, lastValueVisible: true })
		}
		const key = `${sel}|${tf}|${h.got}`
		if (key === drawnKey) return
		drawnKey = key
		// Intradía en hora de Cuba (el eje no tiene zona: se le suma la diferencia); por días, la fecha tal cual
		const shift = DAILY.has(tf) ? 0 : cubaOffset(Date.now()) / 1000
		const data = h.points.map(([t, v]) => ({ time: t + shift, value: v }))
		const up = data.length < 2 || data.at(-1).value >= data[0].value
		const color = css(up ? '--bid' : '--ask')
		series.applyOptions({ lineColor: color, topColor: `${color}55`, bottomColor: `${color}05`, priceLineColor: color })
		series.setData(data)
		chart.applyOptions({ timeScale: { timeVisible: !DAILY.has(tf) } })
		chart.timeScale().fitContent()
	}

	// Las pestañas del intervalo, con cuánto cambió en él
	function renderFrames(h) {
		const p = h?.points ?? []
		const change = p.length > 1 ? (p.at(-1)[1] - p[0][1]) / p[0][1] : null
		for (const b of $s('stkFrames').querySelectorAll('[data-tf]')) {
			b.classList.toggle('active', b.dataset.tf === tf)
			b.setAttribute('aria-selected', String(b.dataset.tf === tf))
		}
		const label = FRAMES.find(([f]) => f === tf)?.[1] ?? ''
		$s('stkRange').innerHTML = change == null ? '' : `En ${label}: <b class="num ${tone(change)}">${signed(change * 100)} %</b>`
	}

	function select(s) {
		if (!s || s === sel) return
		sel = s
		store.set('stk.sel', s)
		renderList()
		renderHead()
		loadDetail(sel)
		loadHistory(sel, tf)
	}

	// ── Entrar y salir ───────────────────────────────────────────────────
	function tick() {
		if (!on || document.hidden) return
		if (Date.now() - listAt > 60_000) loadList()
		loadDetail(sel)
		// Lo intradía se mueve: se vuelve a pedir (la caché del servidor decide si hay algo nuevo). Y el que no se pudo leer
		if (tf === '1H' || tf === '24H' || !hist.has(`${sel}|${tf}`)) loadHistory(sel, tf, true)
	}

	function enter(s) {
		if (s) {
			sel = s
			store.set('stk.sel', s)
		}
		if (!on) {
			on = true
			store.set(SAVED, true)
			document.body.classList.add('stk-on')
			closeMenus()
			closeMarketSheet()
			renderMarkets()
			window.scrollTo({ top: 0 })
			timer = setInterval(tick, 60_000)
		}
		renderList()
		renderHead()
		window.render?.()
		loadList()
		loadDetail(sel)
		loadHistory(sel, tf)
	}

	function leave() {
		if (!on) return
		on = false
		store.set(SAVED, false)
		document.body.classList.remove('stk-on')
		clearInterval(timer)
		timer = null
	}

	// Los avisos de Telegram traen aquí con #acciones/NVDA (y la web, con #acciones)
	function fromHash() {
		const m = location.hash.match(/^#acciones(?:\/([A-Z]{1,5}))?$/)
		if (!m) return
		history.replaceState?.(null, '', `${location.pathname}${location.search}`)
		enter(m[1])
	}

	function askAlert() {
		const key = `stock:${sel}`
		if (!bk.acct.connected) return showConnect('Conecta tu cuenta de QvaPay para los avisos de precio')
		if (!window.TPPro?.active) return showPro()
		pick = key
		showAccount('alerts')
	}

	$s('stkList').addEventListener('click', (e) => select(e.target.closest('[data-stk]')?.dataset.stk))
	$s('stkFrames').addEventListener('click', (e) => {
		const f = e.target.closest('[data-tf]')?.dataset.tf
		if (!f || f === tf) return
		tf = f
		store.set('stk.tf', f)
		draw()
		loadHistory(sel, tf)
	})
	$s('stkAlert').addEventListener('click', askAlert)
	$s('stkQvapay').href = QVAPAY_STOCKS
	document.addEventListener('visibilitychange', tick)
	document.addEventListener('tp:pro', () => on && renderHead())
	window.addEventListener('hashchange', fromHash)

	const MARKET_IC = '<span class="coin-ic stk-mic" aria-hidden="true"><svg viewBox="0 0 24 24" width="14" height="14"><path d="M4 17l5-5 4 3 7-8" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg></span>'
	window.TPStocks = {
		get on() {
			return on
		},
		open: () => enter(),
		leave,
		// El precio de ahora de una acción (para la pestaña de avisos), si ya se leyó
		price: (s) => quote(s)?.price ?? null,
		current: () => sel,
		names: () => (list.length ? list.map((q) => [q.symbol, q.name]) : null),
		// El aviso que se pidió desde aquí (una vez)
		takePick() {
			const p = pick
			pick = null
			return p
		},
		row(query) {
			const q = (query ?? '').trim().toLowerCase()
			if (q && !'acciones stocks bolsa nasdaq s&p spy nvidia tesla apple microsoft meta google amazon circle strategy'.includes(q) && !list.some((x) => x.symbol.toLowerCase().includes(q) || x.name.toLowerCase().includes(q))) return ''
			return `<button class="mrow stk-mrow ${on ? 'active' : ''}" data-stocks role="option" aria-selected="${on}" title="Las acciones que vende QvaPay: precios e histórico (solo para mirar)">
				<span class="mmeta">${MARKET_IC}<span class="mname"><b>Acciones · QvaPay</b><span>S&amp;P 500, NVIDIA, Tesla… · solo mirar</span></span></span>
				<span class="num">—</span><span class="num">—</span></button>`
		},
		rail() {
			return `<button class="rail-btn ${on ? 'active' : ''}" data-stocks title="Acciones · QvaPay" aria-label="Acciones de QvaPay" aria-pressed="${on}">${MARKET_IC}</button>`
		},
		// El par de arriba mientras se está en este mercado
		pair() {
			$s('pairName').textContent = 'Acciones · QvaPay'
			const ic = $s('pairIcon')
			if (ic.dataset.key !== 'stocks') {
				ic.dataset.key = 'stocks'
				ic.innerHTML = MARKET_IC
			}
			const q = quote(sel)
			$s('pairSub').textContent = q ? `${q.symbol} ${money(q.price)} USD · ${signed(q.change)} % hoy` : 'Las acciones que vende QvaPay, solo para mirar'
		},
		// El tema claro u oscuro
		theme() {
			if (!chart) return
			chart.applyOptions(chartColors())
			drawnKey = ''
			draw()
		},
	}

	// Los intervalos
	$s('stkFrames').innerHTML = FRAMES.map(([f, label]) => `<button class="seg-tab" data-tf="${f}" role="tab">${label}</button>`).join('')
	renderMarkets()
	if (/^#acciones/.test(location.hash)) fromHash()
	else if (store.get(SAVED, false)) enter()
})()
