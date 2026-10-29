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
	})
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

	load()
})()
