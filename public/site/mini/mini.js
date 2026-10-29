// Mini app de QvaPay: el libro del P2P en vivo, para mirar. Para operar, Terminal P2P en el navegador del móvil (en la
// app de QvaPay, con QvaPay.openLink). Sin cuenta ni token: el libro lo da nuestro servidor (/data/book)
'use strict'
;(() => {
	const APP = location.hostname.includes('staging') ? 'https://app.staging.terminalp2p.com' : 'https://app.terminalp2p.com'
	const ROWS = 15
	const EVERY_MS = 10_000
	const $ = (id) => document.getElementById(id)
	const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
	const fmtP = (p) => (p == null ? '—' : p.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: p < 10 ? 4 : 2 }))
	const fmtU = (n) => n.toLocaleString('en-US', { maximumFractionDigits: 2 })
	const get = (k, d) => {
		try {
			return localStorage.getItem(k) ?? d
		} catch {
			return d
		}
	}
	const set = (k, v) => {
		try {
			localStorage.setItem(k, v)
		} catch {}
	}

	let Q = window.QvaPay ?? null
	let coin = get('mini.coin', 'BANK_CUP')
	let tab = get('mini.tab', 'book') === 'chart' ? 'chart' : 'book'
	let days = Number(get('mini.days', 7)) || 7
	let markets = []
	let timer = null
	let seq = 0

	// Fuera de la app de QvaPay (un navegador normal) se abre en otra pestaña
	const open = (url) => (Q ? Q.openLink(url) : window.open(url, '_blank', 'noopener'))
	const terminal = (hash = '') => open(`${APP}/?de=qvapay&coin=${encodeURIComponent(coin)}${hash}`)

	function rows(levels, side) {
		const list = levels.filter((l) => !l.outlier).slice(0, ROWS)
		if (!list.length) return '<p class="empty">Sin ofertas ahora mismo.</p>'
		return list
			.map(
				(l) =>
					`<button class="row" data-offer="${esc(l.uuid)}"><span class="p">${fmtP(l.price)}</span><span class="u">${fmtU(l.usd)}</span><span class="w">${l.vipOnly ? '★ ' : ''}${l.user && l.user !== '—' ? `@${esc(l.user)}` : '—'}</span></button>`,
			)
			.join('')
	}

	function render(d) {
		if (d.markets?.length && !markets.length) {
			markets = d.markets
			$('coin').innerHTML = markets.map((m) => `<option value="${esc(m.tick)}" ${m.tick === coin ? 'selected' : ''}>${esc(m.name)}</option>`).join('')
		}
		const unit = markets.find((m) => m.tick === coin)?.unit ?? ''
		const ask = d.ask.levels.find((l) => !l.outlier)
		const bid = d.bid.levels.find((l) => !l.outlier)
		$('bestAsk').textContent = fmtP(ask?.price)
		$('bestBid').textContent = fmtP(bid?.price)
		$('rate').textContent = d.rate ? `${fmtP(d.rate)}` : '—'
		$('rate').title = unit ? `${unit} por USD` : ''
		$('asks').innerHTML = d.ask.ready ? rows(d.ask.levels, 'ask') : '<p class="empty">Cargando…</p>'
		$('bids').innerHTML = d.bid.ready ? rows(d.bid.levels, 'bid') : '<p class="empty">Cargando…</p>'
		$('askN').textContent = d.ask.ready ? `${d.ask.total} ofertas` : ''
		$('bidN').textContent = d.bid.ready ? `${d.bid.total} ofertas` : ''
	}

	async function load() {
		clearTimeout(timer)
		const my = ++seq
		let wait = EVERY_MS
		try {
			const r = await fetch(`/data/book?coin=${encodeURIComponent(coin)}`, { cache: 'no-store' })
			const d = await r.json()
			if (my !== seq) return
			if (!r.ok) throw new Error(d.error || 'El libro no está disponible ahora mismo')
			render(d)
			// Un mercado que nadie miraba se pide a QvaPay: en un par de segundos está
			if (!d.ask.ready || !d.bid.ready) wait = 2000
		} catch (e) {
			if (my !== seq) return
			if (!$('asks').querySelector('.row')) $('asks').innerHTML = $('bids').innerHTML = `<p class="empty">${esc(e.message)}</p>`
			wait = 5000
		}
		if (!document.hidden) timer = setTimeout(load, wait)
	}

	$('coin').addEventListener('change', () => {
		coin = $('coin').value
		set('mini.coin', coin)
		$('asks').innerHTML = $('bids').innerHTML = '<p class="empty">Cargando…</p>'
		load()
		if (tab === 'chart') loadChart()
	})

	// ── Libro o gráfico ─────────────────────────────────────────────────
	function showTab(t) {
		tab = t
		set('mini.tab', t)
		for (const b of document.querySelectorAll('[data-tab]')) b.classList.toggle('on', b.dataset.tab === t)
		$('bookView').hidden = t !== 'book'
		$('chartView').hidden = t !== 'chart'
		if (t === 'chart') loadChart()
	}
	for (const b of document.querySelectorAll('[data-tab]')) b.onclick = () => showTab(b.dataset.tab)
	for (const b of document.querySelectorAll('[data-days]'))
		b.onclick = () => {
			days = Number(b.dataset.days)
			set('mini.days', String(days))
			loadChart()
		}

	// El histórico de la tasa de lo completado (venta y compra), como el del terminal. La librería se carga al abrirlo
	let chart = null
	let sell = null
	let buy = null
	let chartSeq = 0
	const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim()
	const lib = () =>
		window.LightweightCharts
			? Promise.resolve()
			: new Promise((ok, fail) => {
					const s = document.createElement('script')
					s.src = '/vendor/lightweight-charts.js'
					s.onload = ok
					s.onerror = fail
					document.head.append(s)
				})
	function paintChart() {
		chart?.applyOptions({
			layout: { background: { color: 'transparent' }, textColor: css('--muted') },
			grid: { vertLines: { color: css('--line') }, horzLines: { color: css('--line') } },
			rightPriceScale: { borderColor: css('--line') },
			timeScale: { borderColor: css('--line') },
		})
		sell?.applyOptions({ color: css('--ask') })
		buy?.applyOptions({ color: css('--bid') })
	}
	async function loadChart() {
		for (const b of document.querySelectorAll('[data-days]')) b.classList.toggle('on', Number(b.dataset.days) === days)
		const my = ++chartSeq
		try {
			const [, r] = await Promise.all([lib(), fetch(`/data/rates?coin=${encodeURIComponent(coin)}&days=${days}`).then((x) => x.json())])
			if (my !== chartSeq) return
			if (!chart) {
				chart = LightweightCharts.createChart($('chart'), {
					autoSize: true,
					localization: { locale: 'es', priceFormatter: (p) => fmtP(p) },
					timeScale: { timeVisible: true, secondsVisible: false },
					handleScroll: false,
					handleScale: false,
				})
				sell = chart.addLineSeries({ lineWidth: 2, priceLineVisible: false })
				buy = chart.addLineSeries({ lineWidth: 2, priceLineVisible: false })
				paintChart()
			}
			// En la hora del móvil (la librería dibuja en UTC)
			const tz = -new Date().getTimezoneOffset() * 60
			const line = (k) => (r.points ?? []).filter((p) => p[k] != null).map((p) => ({ time: Math.floor(p.t / 1000) + tz, value: p[k] }))
			sell.setData(line('sell'))
			buy.setData(line('buy'))
			chart.timeScale().fitContent()
		} catch {
			if (my === chartSeq) $('chart').innerHTML = '<p class="empty">El gráfico no está disponible ahora mismo.</p>'
		}
	}
	document.addEventListener('click', (e) => {
		const row = e.target.closest('[data-offer]')
		if (row) terminal(`#p2p/${row.dataset.offer}`)
	})
	$('go').addEventListener('click', () => terminal())
	document.addEventListener('visibilitychange', () => !document.hidden && load())

	// Dentro de la app de QvaPay: su tema, su botón principal y quitar su pantalla de carga
	function withQvaPay() {
		Q = window.QvaPay
		if (!Q) return
		const theme = (t) => {
			if (!t) return
			document.documentElement.dataset.theme = t.mode === 'light' ? 'light' : 'dark'
			const c = t.colors ?? {}
			const css = document.documentElement.style
			if (c.bg) css.setProperty('--bg', c.bg)
			if (c.surface) css.setProperty('--surface', c.surface)
			if (c.text) css.setProperty('--text', c.text)
			if (c.primary) css.setProperty('--accent', c.primary)
			paintChart()
		}
		Q.getTheme?.().then(theme).catch(() => {})
		Q.on?.('themeChanged', theme)
		try {
			Q.ui.mainButton.set({ text: 'Operar en Terminal P2P', visible: true, enabled: true })
			Q.on('mainButton', () => terminal())
			$('go').hidden = true
		} catch {}
		Q.ready?.()
	}
	if (Q) withQvaPay()
	else window.addEventListener('qvapay:ready', withQvaPay, { once: true })

	showTab(tab)
	load()
})()
