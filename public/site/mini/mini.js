// Mini app de QvaPay y de Telegram (con ?tg, la abre el bot): el libro del P2P en vivo, para mirar. Para operar,
// Terminal P2P en el navegador del móvil (con QvaPay.openLink o Telegram.WebApp.openLink). Sin cuenta ni token: el
// libro lo da nuestro servidor (/data/book)
'use strict'
;(() => {
	const APP = location.hostname.includes('staging') ? 'https://app.staging.terminalp2p.com' : 'https://app.terminalp2p.com'
	const q = new URLSearchParams(location.search)
	const TG = q.has('tg')
	// Las mejores de cada lado (sin las atípicas): el libro completo está en el terminal
	const ROWS = 10
	// Lo que dura el libro en la caché del servidor: leer más a menudo no traería nada nuevo
	const EVERY_MS = 5000
	const $ = (id) => document.getElementById(id)
	const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
	const fmtP = (p) => (p == null ? '—' : p.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: p < 10 ? 4 : 2 }))
	// Hora de Cuba: UTC-4 en verano (del segundo domingo de marzo al primer domingo de noviembre) y UTC-5 en invierno.
	// El verano de 2026 sigue hasta el 7 nov 2027 (Cuba no atrasó el reloj) y los móviles aún dicen UTC-5 para
	// America/Havana: igual que en el servidor (worker/rates.ts), app.js y site.js
	function cubaOffset(ms) {
		const sunday = (y, m, nth) => Date.UTC(y, m, 1 + ((7 - new Date(Date.UTC(y, m, 1)).getUTCDay()) % 7) + (nth - 1) * 7, 5)
		const summer = (y) => [sunday(y, 2, 2), y === 2026 ? sunday(2027, 10, 1) : sunday(y, 10, 1)]
		const y = new Date(ms).getUTCFullYear()
		return [summer(y), summer(y - 1)].some(([a, b]) => ms >= a && ms < b) ? -4 * 3_600_000 : -5 * 3_600_000
	}
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

	let Q = TG ? null : (window.QvaPay ?? null)
	// Telegram.WebApp, ya cargado
	let T = null
	// El mercado del enlace (?coin=, o el startapp de un enlace t.me/…?startapp=ETECSA), si no, el último que se miró
	const asked = q.get('coin') ?? q.get('tgWebAppStartParam')
	let coin = asked && /^[A-Z_]{2,20}$/.test(asked) ? asked : get('mini.coin', 'BANK_CUP')
	let tab = get('mini.tab', 'book') === 'chart' ? 'chart' : 'book'
	let days = Number(get('mini.days', 7)) || 7
	let markets = []
	let timer = null
	let seq = 0
	// Lo que se vio en la lectura anterior de cada lado (uuid → precio y USD), para iluminar lo que cambió
	let seen = { ask: null, bid: null }
	// Al abrir un mercado, el libro baja solo hasta el diferencial (donde están las mejores), como en el terminal
	let toSpread = true

	// Fuera de las apps de QvaPay y de Telegram (un navegador normal) se abre en otra pestaña
	const open = (url) => (T ? T.openLink(url) : Q ? Q.openLink(url) : window.open(url, '_blank', 'noopener'))
	const terminal = (hash = '') => open(`${APP}/?de=${TG ? 'bot-mini' : 'qvapay'}&coin=${encodeURIComponent(coin)}${hash}`)

	function rows(levels, side) {
		const list = levels.filter((l) => !l.outlier).slice(0, ROWS)
		const before = seen[side]
		seen[side] = new Map(list.map((l) => [l.uuid, `${l.price}/${l.usd}`]))
		if (!list.length) return '<p class="empty">Sin ofertas ahora mismo.</p>'
		// Nueva o con otro precio o monto desde la lectura anterior (en la primera de un mercado, nada)
		const moved = (l) => before && before.get(l.uuid) !== `${l.price}/${l.usd}`
		// Lo acumulado desde la mejor hasta cada fila, y la barra de profundidad en proporción al total de las que se ven
		let sum = 0
		const cum = list.map((l) => (sum += l.usd))
		const html = list.map(
				(l, i) =>
					`<button class="row${moved(l) ? ' new' : ''}" data-offer="${esc(l.uuid)}"><i class="bar" style="width:${((cum[i] / sum) * 100).toFixed(1)}%"></i><span class="p">${fmtP(l.price)}</span><span class="u">${fmtU(l.usd)}</span><span class="c">${fmtU(cum[i])}</span><span class="w">${l.vipOnly ? '★ ' : ''}${l.user && l.user !== '—' ? `@${esc(l.user)}` : '—'}</span></button>`,
		)
		// Como en el libro del terminal: las ventas de la más cara a la más barata, así la mejor queda junto al diferencial
		return (side === 'ask' ? html.reverse() : html).join('')
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
		$('spread').textContent = ask && bid ? `${fmtP(ask.price - bid.price)} · ${ask.price >= bid.price ? '+' : '−'}${Math.abs((ask.price / bid.price - 1) * 100).toFixed(2)}%` : '—'
		$('rate').title = unit ? `${unit} por USD` : ''
		$('asks').innerHTML = d.ask.ready ? rows(d.ask.levels, 'ask') : '<p class="empty">Cargando…</p>'
		$('bids').innerHTML = d.bid.ready ? rows(d.bid.levels, 'bid') : '<p class="empty">Cargando…</p>'
		$('askN').textContent = `las ${ROWS} mejores de cada lado`
		if (toSpread && d.ask.ready && d.bid.ready && tab === 'book') {
			toSpread = false
			$('spread').scrollIntoView({ block: 'center' })
		}
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
		seen = { ask: null, bid: null }
		toSpread = true
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
		if (t === 'book') {
			toSpread = !$('asks').querySelector('.row')
			if (!toSpread) $('spread').scrollIntoView({ block: 'center' })
		}
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
				$('chart').textContent = ''
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
			// En hora de Cuba (la librería dibuja en UTC): no con la zona del móvil, que puede ser otra o creer que Cuba
			// está en UTC-5
			const line = (k) => (r.points ?? []).filter((p) => p[k] != null).map((p) => ({ time: Math.floor((p.t + cubaOffset(p.t)) / 1000), value: p[k] }))
			sell.setData(line('sell'))
			buy.setData(line('buy'))
			chart.timeScale().fitContent()
		} catch {
			if (my !== chartSeq) return
			// El aviso sustituye al gráfico: la próxima vez se crea de nuevo (si no, se quedaba el aviso hasta recargar)
			try {
				chart?.remove()
			} catch {}
			chart = sell = buy = null
			$('chart').innerHTML = '<p class="empty">El gráfico no está disponible ahora mismo.</p>'
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
	// Dentro de Telegram: sus colores, su botón principal y a pantalla completa. Su script se carga solo aquí
	function withTelegram() {
		const s = document.createElement('script')
		s.src = 'https://telegram.org/js/telegram-web-app.js'
		s.onload = () => {
			// Fuera de Telegram el script carga igual, pero sin datos de inicio: se queda como una página normal
			T = window.Telegram?.WebApp?.initData ? window.Telegram.WebApp : null
			if (!T) return
			const theme = () => {
				const p = T.themeParams ?? {}
				document.documentElement.dataset.theme = T.colorScheme === 'light' ? 'light' : 'dark'
				const css = document.documentElement.style
				// Como las pantallas de Telegram: el fondo gris y los recuadros del color de sus secciones
				const map = { '--bg': p.secondary_bg_color, '--surface': p.section_bg_color ?? p.bg_color, '--text': p.text_color, '--muted': p.hint_color, '--accent': p.button_color }
				for (const [k, v] of Object.entries(map)) if (v) css.setProperty(k, v)
				try {
					T.setHeaderColor('secondary_bg_color')
					T.setBackgroundColor('secondary_bg_color')
				} catch {}
				paintChart()
			}
			theme()
			T.onEvent('themeChanged', theme)
			T.MainButton.setParams({ text: 'Operar en Terminal P2P', is_visible: true })
			T.MainButton.onClick(() => terminal())
			$('go').hidden = true
			T.ready()
			T.expand()
		}
		document.head.append(s)
	}
	if (TG) withTelegram()
	else if (Q) withQvaPay()
	else window.addEventListener('qvapay:ready', withQvaPay, { once: true })

	showTab(tab)
	load()
})()
