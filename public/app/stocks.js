// Acciones de QvaPay (experimental, solo para mirar): con «Acciones» en el selector de la columna de mercados, la lista
// enseña las que vende QvaPay y, al elegir una, el centro del terminal enseña su ficha y su gráfico (cotización pública
// cada 5 minutos, histórico de los intervalos que QvaPay tenga y si la bolsa de Nueva York está abierta) en vez del
// libro del P2P. Comprar y vender se hace en QvaPay: aquí no se compra ni se vende nada. Con Pro, los avisos de precio
// por Telegram (los mismos de la tasa, worker/ratealerts.ts)
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
	// Si QvaPay no tiene el intervalo elegido para una acción, el que se enseña en su lugar
	const FALLBACK = ['24H', '1W', '1M', '1Y', '1H']
	// Las de 1 mes y 1 año son de un punto por día: van con su fecha, sin pasarlas a la hora de Cuba
	const DAILY = new Set(['1M', '1Y'])
	// Lo de hoy se mueve: se vuelve a pedir en cada vuelta (la caché del servidor decide si hay algo nuevo)
	const LIVE = new Set(['1H', '24H'])
	let on = false
	let list = []
	let market = null
	let listAt = 0
	let listTry = 0
	let listErr = ''
	let listing = null
	let sel = store.get('stk.sel', 'SPY')
	// El intervalo elegido y el que se ve (otro si QvaPay no tiene el elegido para esta acción)
	let want = store.get('stk.tf', '24H')
	if (!FRAMES.some(([f]) => f === want)) want = '24H'
	let tf = want
	// El histórico de cada acción e intervalo (solo los que trajeron puntos) y los que QvaPay no dio la última vez: su
	// 404 «sin histórico» sale también cuando corta por muchas peticiones, así que no se toma como que no lo tiene
	const hist = new Map()
	const failed = new Map()
	const loading = new Map()
	// Las acciones con sus intervalos pidiéndose o reintentándose (mientras, se ve «Cargando…» en vez del error)
	const retrying = new Set()
	// La ficha de cada una (apertura, máximo, 52 semanas…): se pide solo de la que se mira
	const details = new Map()
	let chart = null
	let series = null
	let drawnKey = ''
	let framesHtml = ''
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
	// El icono que usa QvaPay (lo trae su lista; el servidor solo deja los de su carpeta) o la inicial. En la columna
	// colapsada, sin icono, el símbolo (las iniciales se repiten)
	const icon = (s, sym = false) => {
		const img = quote(s)?.image
		const cls = `coin-ic stk-ic${sym && !img ? ' stk-sym' : ''}`
		return `<span class="${cls}" data-i="${esc(s.charAt(0))}" aria-hidden="true">${img ? `<img src="${esc(img)}" alt="" loading="lazy" />` : sym ? esc(s) : ''}</span>`
	}
	// Si de la que se mira ya se tiene el histórico de un intervalo
	const has = (f, s = sel) => hist.has(`${s}|${f}`)

	// ── Datos ────────────────────────────────────────────────────────────
	function loadList() {
		listing ??= (async () => {
			listTry = Date.now()
			try {
				const r = await fetch('/data/stocks')
				if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? 'No se pudieron leer las acciones')
				const d = await r.json()
				list = d.stocks ?? []
				market = d.market ?? null
				listAt = d.at ?? Date.now()
				listErr = ''
				if (!quote(sel) && list.length) sel = list[0].symbol
			} catch (e) {
				listErr = e.message
			}
			listing = null
			renderMarkets()
			renderAt()
			if (on) {
				renderHead()
				window.render?.()
			}
		})()
		return listing
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

	// Un intervalo de una acción, que se vuelve a pedir pasado un minuto. Si QvaPay no lo da, queda el que se tenía
	function loadHistory(s, f, force = false) {
		const key = `${s}|${f}`
		const had = hist.get(key)
		if (had && !force && Date.now() - had.got < 60_000) return
		if (loading.has(key)) return loading.get(key)
		const run = (async () => {
			try {
				const r = await fetch(`/data/stocks/history?s=${encodeURIComponent(s)}&tf=${f}`)
				if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? 'No se pudo leer el histórico')
				const d = await r.json()
				if ((d.points?.length ?? 0) < 2) throw new Error('QvaPay no da este intervalo ahora mismo')
				hist.set(key, { points: d.points, got: Date.now() })
				failed.delete(key)
			} catch (e) {
				failed.set(key, e.message)
			}
			loading.delete(key)
		})()
		loading.set(key, run)
		return run
	}

	// Los intervalos de una acción, de uno en uno (QvaPay corta a las pocas peticiones seguidas), primero el que se mira.
	// Solo salen los que traen histórico. Los que no se pudieron leer (QvaPay pidió esperar) se reintentan tres veces más,
	// a los 4, 10 y 25 segundos
	const RETRIES = [0, 4000, 10_000, 25_000]
	async function loadFrames(s, refresh = false) {
		const order = [tf, ...FRAMES.map(([f]) => f).filter((f) => f !== tf)]
		retrying.add(s)
		try {
			for (const wait of RETRIES) {
				if (wait) {
					if (!order.some((f) => failed.has(`${s}|${f}`))) return
					await new Promise((r) => setTimeout(r, wait))
				}
				for (const f of order) {
					if (s !== sel || !on) return
					if (wait && !failed.has(`${s}|${f}`)) continue
					await loadHistory(s, f, !wait && refresh && f === tf && LIVE.has(f))
					if (s === sel && on) {
						settle()
						draw()
					}
				}
			}
		} finally {
			retrying.delete(s)
			if (s === sel && on) draw()
		}
	}

	// El intervalo que se ve: el elegido si ya está (o aún se está pidiendo); si no, el primero que esté. Sin ninguno,
	// el elegido (con su aviso)
	function settle() {
		const order = [want, ...FALLBACK.filter((f) => f !== want)]
		const pending = (f) => !has(f) && !failed.has(`${sel}|${f}`)
		tf = order.find((f) => has(f) || (f === want && pending(f))) ?? order.find(pending) ?? want
	}

	// ── Pintar ───────────────────────────────────────────────────────────
	// Las filas de la columna de mercados (app.js) con «Acciones» en el selector
	function rows(query) {
		if (!list.length) {
			if (!listing && Date.now() - listTry > 30_000) loadList()
			return `<div class="empty">${esc(listErr || 'Cargando…')}</div>`
		}
		if (!on && Date.now() - listAt > 60_000 && Date.now() - listTry > 30_000) loadList()
		const q = (query ?? '').trim().toLowerCase()
		const shown = list.filter((x) => !q || x.symbol.toLowerCase().includes(q) || x.name.toLowerCase().includes(q) || (x.fullName ?? '').toLowerCase().includes(q))
		if (!shown.length) return '<div class="empty">Sin resultados</div>'
		return shown
			.map((x) => {
				const here = on && x.symbol === sel
				return `<button class="mrow ${here ? 'active' : ''}" data-stk="${esc(x.symbol)}" role="option" aria-selected="${here}">
				<span class="mmeta">${icon(x.symbol)}<span class="mname"><b>${esc(x.symbol)}</b><span>${esc(x.name)}</span></span></span>
				<span class="num">${money(x.price)}</span><span class="num ${tone(x.change)}">${signed(x.change)} %</span></button>`
			})
			.join('')
	}

	function renderAt() {
		if (!list.length) {
			$s('stkAt').textContent = listErr || 'Cargando…'
			return
		}
		const status = market ? (market.open ? `Bolsa de Nueva York abierta · cierra a las ${cubaTime(market.until)}` : `Bolsa cerrada · abre ${cubaFmt(market.until, { weekday: 'short', day: 'numeric', month: 'short' })}, ${cubaTime(market.until)}`) : ''
		$s('stkAt').textContent = `${status}${status ? ' · ' : ''}precios de las ${cubaTime(listAt)} (hora de Cuba)`
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
		const key = `${sel}|${tf}`
		const h = hist.get(key)
		renderFrames(h)
		const msg = $s('stkChartMsg')
		msg.hidden = !!h
		if (!h) {
			// Sin datos de este intervalo no se deja a la vista el gráfico de otra acción
			if (series && !drawnKey.startsWith(`${key}|`)) {
				series.setData([])
				drawnKey = ''
			}
			msg.textContent = retrying.has(sel) ? 'Cargando…' : (failed.get(key) ?? 'Cargando…')
			return
		}
		if (!window.LightweightCharts) return
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
		const drawKey = `${key}|${h.got}`
		if (drawKey === drawnKey) return
		drawnKey = drawKey
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

	// Las pestañas de los intervalos que QvaPay tiene para esta acción (y la que se está cargando), con cuánto cambió
	function renderFrames(h) {
		const shown = FRAMES.filter(([f]) => has(f) || f === tf)
		const html = shown.map(([f, label]) => `<button class="seg-tab ${f === tf ? 'active' : ''}" data-tf="${f}" role="tab" aria-selected="${f === tf}">${label}</button>`).join('')
		if (html !== framesHtml) {
			framesHtml = html
			$s('stkFrames').innerHTML = html
			$s('stkFrames').hidden = !shown.length
		}
		const p = h?.points ?? []
		const change = p.length > 1 ? (p.at(-1)[1] - p[0][1]) / p[0][1] : null
		const label = FRAMES.find(([f]) => f === tf)?.[1] ?? ''
		$s('stkRange').innerHTML = change == null ? '' : `En ${label}: <b class="num ${tone(change)}">${signed(change * 100)} %</b>`
	}

	// ── Entrar y salir ───────────────────────────────────────────────────
	function tick() {
		if (!on || document.hidden) return
		if (Date.now() - listAt > 60_000) loadList()
		loadDetail(sel)
		loadFrames(sel, true)
	}

	// Elegir una acción (de la lista o de un enlace): el centro del terminal pasa a enseñarla
	function enter(s, keepSheet = false) {
		if (s && s !== sel) {
			sel = s
			store.set('stk.sel', s)
			tf = want
		}
		if (!on) {
			on = true
			store.set(SAVED, true)
			document.body.classList.add('stk-on')
			closeMenus()
			window.scrollTo({ top: 0 })
			timer = setInterval(tick, 60_000)
			setMarketKind('stocks')
		}
		if (!keepSheet) closeMarketSheet()
		settle()
		renderMarkets()
		renderAt()
		renderHead()
		draw()
		window.render?.()
		if (!list.length || Date.now() - listAt > 60_000) loadList()
		loadDetail(sel)
		loadFrames(sel)
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

	$s('stkFrames').addEventListener('click', (e) => {
		const f = e.target.closest('[data-tf]')?.dataset.tf
		if (!f || f === tf) return
		want = tf = f
		store.set('stk.tf', f)
		draw()
		loadHistory(sel, f)?.then(() => on && f === tf && draw())
	})
	$s('stkAlert').addEventListener('click', askAlert)
	document.addEventListener('visibilitychange', tick)
	document.addEventListener('tp:pro', () => on && renderHead())
	window.addEventListener('hashchange', fromHash)

	const MARKET_IC = '<span class="coin-ic stk-mic" aria-hidden="true"><svg viewBox="0 0 24 24" width="14" height="14"><path d="M4 17l5-5 4 3 7-8" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg></span>'
	window.TPStocks = {
		get on() {
			return on
		},
		open: (s, keepSheet) => enter(s, keepSheet),
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
		rows,
		// La columna colapsada: una por acción, con su símbolo
		rail() {
			return list
				.map((x) => {
					const here = on && x.symbol === sel
					return `<button class="rail-btn ${here ? 'active' : ''}" data-stk="${esc(x.symbol)}" title="${esc(`${x.symbol} · ${x.name} · ${money(x.price)} USD`)}" aria-label="${esc(x.name)}" aria-pressed="${here}">${icon(x.symbol, true)}</button>`
				})
				.join('')
		},
		// En la columna colapsada con los mercados del P2P, el botón que pasa a las acciones
		railSwitch: () => `<button class="rail-btn rail-kind" data-kind="stocks" title="Acciones de QvaPay" aria-label="Acciones de QvaPay">${MARKET_IC}</button>`,
		// El par de arriba mientras se mira una acción
		pair() {
			const q = quote(sel)
			$s('pairName').textContent = q ? `${q.symbol} · ${q.name}` : 'Acciones de QvaPay'
			const ic = $s('pairIcon')
			if (ic.dataset.key !== `stk:${sel}:${q?.image ?? ''}`) {
				ic.dataset.key = `stk:${sel}:${q?.image ?? ''}`
				ic.innerHTML = icon(sel)
			}
			$s('pairSub').textContent = q ? `${money(q.price)} USD · ${signed(q.change)} % hoy · acciones de QvaPay` : 'Las acciones que vende QvaPay'
		},
		// El tema claro u oscuro
		theme() {
			if (!chart) return
			chart.applyOptions(chartColors())
			drawnKey = ''
			draw()
		},
	}

	renderMarkets()
	if (/^#acciones/.test(location.hash)) fromHash()
	else if (store.get(SAVED, false)) enter()
})()
