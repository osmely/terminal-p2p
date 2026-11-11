// Mercados de bitcoin en Nostr (experimental, modo Pro): BTC / CUP, BTC / USD… salen en la lista de mercados como los
// de QvaPay y se ven igual: el par y sus cifras arriba, la profundidad, el libro de órdenes (ventas, diferencial,
// compras), la lectura del mercado y, en «Mis operaciones», tus compras en Mostro. Las órdenes son las públicas de
// Nostr (NIP-69, /data/nostr) en precio por bitcoin; las ventas de Mostro se compran desde aquí (nostr/mostro.js, que se
// carga al entrar) y las de otras plataformas se abren en la suya. La dirección Lightning es la de la cuenta de QvaPay
// conectada (usuario@qvpay.me). Solo existe donde el servidor lo enciende: si no, ni este archivo llega (data-cross).
// Lo que viene de fuera (nombres, métodos de pago, nodos) se pinta escapado
'use strict'
;(() => {
	if (!document.getElementById('btcPay')) return
	const REFRESH_MS = 60_000
	const SAVED = 'btc.fiat'
	const LIST_OPEN = 'btc.listOpen'
	// Hodl Hodl no admite usuarios de Cuba: en el terminal no sale
	const HIDE = new Set(['hodlhodl'])
	const PLATFORMS = { mostro: 'Mostro', robosats: 'RoboSats', hodlhodl: 'Hodl Hodl', telegram: 'Telegram', lnp2pbot: 'lnp2pBot', peach: 'Peach', pairbuy: 'Pairbuy', otra: 'Otra' }
	const platName = (p) => PLATFORMS[p] ?? p.charAt(0).toUpperCase() + p.slice(1)

	let data = null
	let timer = 0
	// El mercado de bitcoin a la vista (su moneda) o null si se está en uno de QvaPay
	let fiat = null
	let pay = ''
	// Lo pintado en el libro, para saber qué orden es cada fila
	let shown = { ask: [], bid: [] }
	// Cuenta de QvaPay con la que se cargó la compra (sus compras de Mostro van aparte de las de otra cuenta)
	let loadedFor = null
	let loading = null
	// Se pidió entrar sin cuenta o sin saber aún si es Pro: se entra (o se ofrece Pro) en cuanto se sepa
	let pending = null
	// Lo que se cambia del libro de QvaPay al entrar, para dejarlo como estaba al salir
	let saved = null

	const proOn = () => !!window.TPPro?.enabled
	const user = () => String(bk.acct?.username ?? '').toLowerCase()
	// La lista los enseña sin cuenta (al elegir uno, se pide conectarla) y, con cuenta, si Pro está encendido en el panel
	const listed = () => !!data && (!bk.acct.connected || proOn())

	// ── Números ───────────────────────────────────────────────────────
	// Un bitcoin cuesta de miles a cientos de millones según la moneda: sin decimales desde 10,000
	const px = (p) => (p > 0 ? p.toLocaleString('en-US', { maximumFractionDigits: p >= 10_000 ? 0 : 2, minimumFractionDigits: p >= 10_000 ? 0 : 2 }) : '—')
	// En la lista de mercados y en el eje del gráfico, corto: 79.87M
	const pxShort = (p) => (!(p > 0) ? '—' : p >= 1e7 ? `${(p / 1e6).toFixed(1)}M` : p >= 1e6 ? `${(p / 1e6).toFixed(2)}M` : px(p))
	const amt = (n) => n.toLocaleString('en-US', { maximumFractionDigits: n >= 100 ? 0 : 2 })
	const prem = (x) => (x == null ? 'sin prima' : Math.abs(x) < 0.05 ? '0 %' : `${x > 0 ? '+' : '−'}${Math.abs(x).toFixed(Math.abs(x) >= 10 ? 0 : 1)} %`)
	// Lo que sale por dólar: el precio en la moneda entre el del bitcoin en dólares (Yadio)
	const perUsd = (price, f) => {
		const usd = data?.market?.USD
		if (!price || !usd || f === 'USD' || f === 'USDT' || f === 'USDC') return null
		return price / usd
	}
	const perUsdText = (r, f) => (r == null ? null : `${r.toLocaleString('en-US', { maximumFractionDigits: r >= 100 ? 0 : r >= 1 ? 2 : 4, minimumFractionDigits: r >= 100 ? 0 : r >= 1 ? 2 : 4 })} ${f} por USD`)
	const clock = (t) => cubaFmt(t, { hour: '2-digit', minute: '2-digit' })

	// ── Datos ─────────────────────────────────────────────────────────
	// Cada moneda con órdenes es un mercado: el CUP primero y luego las que más tienen. Sin precio (la moneda no está
	// en Yadio) no entran en el libro
	function markets() {
		const by = new Map()
		for (const o of data?.orders ?? []) {
			if (HIDE.has(o.platform) || !(o.price > 0)) continue
			const m = by.get(o.fiat) ?? { fiat: o.fiat, ask: [], bid: [] }
			m[o.side].push(o)
			by.set(o.fiat, m)
		}
		for (const m of by.values()) {
			m.ask.sort((a, b) => a.price - b.price)
			m.bid.sort((a, b) => b.price - a.price)
		}
		return [...by.values()].sort((a, b) => (b.fiat === 'CUP') - (a.fiat === 'CUP') || b.ask.length + b.bid.length - (a.ask.length + a.bid.length) || a.fiat.localeCompare(b.fiat))
	}
	const fold = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
	function bookOf(f) {
		const m = markets().find((x) => x.fiat === f) ?? { fiat: f, ask: [], bid: [] }
		const q = fold(pay.trim())
		const keep = (o) => !q || o.pays.some((p) => fold(p).includes(q))
		return { asks: m.ask.filter(keep), bids: m.bid.filter(keep), all: m }
	}

	async function load() {
		clearTimeout(timer)
		try {
			const r = await fetch('/data/nostr', { headers: { Accept: 'application/json' } })
			if (!r.ok) throw new Error(String(r.status))
			data = await r.json()
			window.TPMostro?.setNodes(data.nodes)
			renderMarkets()
			if (fiat) draw()
		} catch {
			if (fiat) setStatus('Sin datos de Nostr: se reintenta en un minuto')
		}
		timer = setTimeout(load, REFRESH_MS)
	}
	document.addEventListener('visibilitychange', () => {
		if (document.visibilityState === 'visible' && data && Date.now() - data.at > REFRESH_MS) load()
	})

	// La compra (mostro.js) y sus estilos se cargan la primera vez que se entra: quien no lo usa no los descarga
	function script(src) {
		return new Promise((ok, fail) => {
			const s = document.createElement('script')
			s.src = src
			s.onload = ok
			s.onerror = () => {
				s.remove()
				fail(new Error(src))
			}
			document.head.append(s)
		})
	}
	function loadBuy() {
		if (loading) return loading
		loadedFor = user()
		window.TPMostroConfig = { user: loadedFor }
		const css = document.createElement('link')
		css.rel = 'stylesheet'
		css.href = '/nostr/nostr.css'
		document.head.append(css)
		loading = script('/nostr/mostro.js')
			.then(() => {
				if (data) window.TPMostro?.setNodes(data.nodes)
				if (fiat) draw()
			})
			.catch(() => (loading = null))
		return loading
	}

	// ── Entrar y salir ────────────────────────────────────────────────
	function enter(f) {
		pending = null
		const first = !fiat
		fiat = f
		store.setMine(SAVED, f)
		if (first) {
			document.body.classList.add('btc-on')
			saved = {
				cols: [...document.querySelectorAll('.book-cols span')].map((s) => s.textContent),
				legend: [...document.querySelectorAll('.book-foot .legend')].map((s) => s.innerHTML),
			}
			// Aquí solo hay profundidad y lectura
			showChart('depth', true)
			document.querySelector('[data-pane="insight"]')?.click()
		}
		closeMenus()
		closeMarketSheet()
		loadBuy()
		renderMarkets()
		draw()
	}

	function leave() {
		if (!fiat) return
		fiat = null
		store.setMine(SAVED, null)
		document.body.classList.remove('btc-on')
		document.getElementById('mxDialog')?.close()
		document.querySelectorAll('.book-cols span').forEach((s, i) => (s.textContent = saved?.cols[i] ?? s.textContent))
		document.querySelectorAll('.book-foot .legend').forEach((s, i) => (s.innerHTML = saved?.legend[i] ?? s.innerHTML))
		$('insight').dataset.html = ''
		showChart(store.get('chart', 'depth'), true)
	}

	// Elegir un mercado de bitcoin: sin cuenta, conectarla; sin Pro, la ventana de Pro; con Pro, adentro
	function open(f) {
		if (!bk.acct.connected) {
			pending = f
			closeMarketSheet()
			return showConnect('Conecta tu cuenta de QvaPay para comprar bitcoin en Mostro')
		}
		if (!proOn()) return
		if (!window.TPPro.active) {
			// Recién conectada, Pro aún no ha respondido: se decide al llegar (tp:pro)
			if (!window.TPPro.print) return void (pending = f)
			closeMarketSheet()
			return showPro()
		}
		enter(f)
	}

	document.addEventListener('tp:pro', (e) => {
		const p = e.detail
		// Otra cuenta en este navegador: sus compras de Mostro son otras (se recarga para no mezclarlas)
		if (loadedFor !== null && user() !== loadedFor) return location.reload()
		if (!p.active) {
			if (fiat) {
				leave()
				render()
			}
			if (pending && bk.acct.connected && p.enabled) {
				pending = null
				showPro()
			}
			return renderMarkets()
		}
		const want = pending ?? (!fiat ? store.getMine(SAVED, null) : null)
		if (want) enter(want)
		else renderMarkets()
	})

	// La web y los avisos traen aquí con #bitcoin (o #bitcoin/USD)
	function fromHash() {
		const m = /^#bitcoin(?:\/([A-Z]{3,5}))?$/.exec(location.hash)
		if (!m) return
		history.replaceState(null, '', `${location.pathname}${location.search}`)
		pending = m[1] ?? 'CUP'
		if (window.TPPro?.print || !bk.acct.connected) open(pending)
	}
	window.addEventListener('hashchange', fromHash)
	fromHash()

	// Tras tomar una orden, a «Mis operaciones» (en el móvil, su pestaña)
	document.addEventListener('tp:mostro', (e) => {
		if (!fiat || !e.detail?.taken) return
		showView('orders')
		document.querySelector('.area-orders')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
	})

	// ── Pintar ────────────────────────────────────────────────────────
	const ICON = (f) => `<span class="coin-ic btc-ic" aria-hidden="true">₿${f ? `<i>${esc(f)}</i>` : ''}</span>`

	// Ventas de Mostro que se compran aquí; las que se podrían pero el nodo ahora no deja; el resto se abre fuera
	const canBuy = (o) => o.side === 'ask' && !!window.TPMostro?.canTake(o)
	const blocked = (o) => (o.side === 'ask' ? (window.TPMostro?.blocked?.(o) ?? null) : null)

	function row(o, i, side, cum, max) {
		const color = side === 'ask' ? 'var(--ask-bg)' : 'var(--bid-bg)'
		const w = max ? Math.max(2, (cum / max) * 100) : 0
		const off = blocked(o)
		const flag = canBuy(o) ? '<span class="flag btc-take" title="Se compra desde aquí">₿</span>' : off ? '<span class="flag" title="El nodo ahora no deja operar">⛔</span>' : o.link ? '<span class="flag" title="Se abre en su plataforma">↗</span>' : ''
		const who = o.node ?? platName(o.platform)
		const rate = o.score > 0 ? ` ★${o.score.toFixed(o.score % 1 === 0 ? 0 : 1)}` : ''
		return `<div class="lvl ${off ? 'btc-off' : ''}" data-i="${i}" data-side="${side}"
			style="background-image:linear-gradient(to left, ${color} ${w}%, transparent ${w}%)">
			<span class="p">${px(o.price)}</span><span class="u">${amt(o.max)}</span><span class="c">${amt(cum)}</span>
			<span class="who"><em>${esc(who)}</em>${rate}${o.min !== o.max ? '<span class="flag" title="Por rango">↔</span>' : ''}${flag}</span></div>`
	}

	function bookSide(list, s, f) {
		if (!list.length) return `<div class="empty">${pay ? 'Sin órdenes con ese método de pago' : `Nadie ${s === 'ask' ? 'vende' : 'compra'} bitcoin en ${esc(f)} ahora`}</div>`
		let cum = 0
		const rows = list.map((o) => ({ o, cum: (cum += o.max) }))
		return rows.map(({ o, cum }, i) => row(o, i, s, cum, rows.at(-1).cum)).join('')
	}

	function draw() {
		if (!fiat) return
		const f = fiat
		const { asks, bids, all } = bookOf(f)
		shown = { ask: asks, bid: bids }
		const ref = data?.market?.[f === 'USDT' || f === 'USDC' ? 'USD' : f] ?? null

		// El par
		$('pairName').textContent = `BTC / ${f}`
		if ($('pairIcon').dataset.key !== `btc:${f}`) {
			$('pairIcon').dataset.key = `btc:${f}`
			$('pairIcon').innerHTML = ICON('')
		}
		$('pairSub').textContent = `Precio en ${f} por bitcoin · órdenes P2P de Nostr${loadedFor ? ` · tus sats van a ${loadedFor}@qvpay.me` : ''}`

		// Las cifras de arriba
		const ask = asks[0]?.price
		const bid = bids[0]?.price
		const askUsd = perUsd(ask, f)
		const stat = (k, v, cls = '', title = '') => `<div class="stat"${title ? ` title="${esc(title)}"` : ''}><label>${k}</label><b class="${cls}">${v}</b></div>`
		$('stats').innerHTML = [
			stat('Mejor venta', px(ask), 'ask'),
			stat('Mejor compra', px(bid), 'bid'),
			stat('Diferencial', ask && bid ? pct(ask / bid - 1) : '—'),
			stat('Mercado', px(ref), '', 'El precio del bitcoin según Yadio, el que usa Mostro para las órdenes a precio de mercado'),
			stat('Venta por USD', askUsd ? `${askUsd.toLocaleString('en-US', { maximumFractionDigits: askUsd >= 100 ? 0 : 2 })}<small class="unit"> ${esc(f)}</small>` : '—', '', 'Lo que te sale cada dólar comprando bitcoin a la mejor venta (con el precio del bitcoin en dólares de Yadio)'),
			stat('Órdenes', `${all.ask.length} / ${all.bid.length}`, '', 'Venden / compran'),
		].join('')

		// De cuándo son los datos
		const age = data ? Date.now() - data.at : null
		setStatus(data ? `Órdenes de Nostr de las ${clock(data.at)}` : 'Leyendo Nostr…')
		$('dot').className = `dot ${age != null && age < 3 * 60_000 ? 'live' : 'stale'}`

		// El libro
		const cols = document.querySelectorAll('.book-cols span')
		;['Precio', f, 'Acumulado', 'Plataforma'].forEach((t, i) => cols[i] && (cols[i].textContent = t))
		const legend = document.querySelectorAll('.book-foot .legend')
		if (legend[0]) legend[0].innerHTML = '<i class="sw ask"></i>Venden BTC'
		if (legend[1]) legend[1].innerHTML = '<i class="sw bid"></i>Compran BTC'
		document.querySelector('.area-book').classList.remove('offline')
		$('asks').innerHTML = bookSide(asks, 'ask', f)
		$('bids').innerHTML = bookSide(bids, 'bid', f)
		const hidden = all.ask.length + all.bid.length - asks.length - bids.length
		$('bookCount').textContent = `${all.ask.length} / ${all.bid.length} órdenes${hidden ? ` · ${hidden} ocultas` : ''}`
		$('bookCount').title = `${all.ask.length} ventas y ${all.bid.length} compras de bitcoin en ${f}`
		const sp = $('spread')
		sp.style.cssText = ''
		if (ask && bid) {
			sp.className = `spread ${bid > ask ? 'crossed' : ''}`
			sp.innerHTML = bid > ask ? `<span class="lbl">Libro cruzado</span><span>${px(bid)} &gt; ${px(ask)} · ${pct(bid / ask - 1)}</span>` : `<span class="lbl">Diferencial</span><span>${px(ask - bid)} · ${pct(ask / bid - 1)}</span>`
		} else {
			sp.className = 'spread'
			sp.textContent = 'Sin cotización en uno de los lados'
		}

		insight(f, asks, bids, ref)
		drawActive()
	}

	// La lectura del mercado
	function insight(f, asks, bids, ref) {
		const out = []
		const a = asks[0]
		const b = bids[0]
		const usdRef = perUsdText(perUsd(ref, f), f)
		if (ref) out.push(`<li>El mercado (Yadio, el que usa Mostro) pone el bitcoin a <b>${px(ref)} ${esc(f)}</b>${usdRef ? ` (${usdRef})` : ''}.</li>`)
		if (a) out.push(`<li>La mejor venta está a <b>${px(a.price)}</b> (${prem(a.premium)} sobre el mercado) en ${esc(a.node ?? platName(a.platform))}${perUsd(a.price, f) ? `: cada dólar te sale a <b>${perUsdText(perUsd(a.price, f), f)}</b>` : ''}.</li>`)
		if (b) out.push(`<li>La mejor compra está a <b>${px(b.price)}</b> (${prem(b.premium)}) en ${esc(b.node ?? platName(b.platform))}.</li>`)
		// En CUP, frente al dólar de QvaPay (CUP Transferencia)
		const qv = f === 'CUP' ? state.overview.find((c) => c.tick === 'BANK_CUP') : null
		const au = a ? perUsd(a.price, f) : null
		// Su mejor venta en vivo o, sin cuenta conectada, el promedio de 24 h de lo completado
		const qa = qv?.ask ?? qv?.avgSell
		if (qa && au) out.push(`<li>En QvaPay el dólar está a <b>${fmtP(qa)} CUP</b> (CUP Transferencia${qv.ask ? '' : ', promedio de 24 h'}): comprar bitcoin aquí te sale un <b>${pct(au / qa - 1)}</b> por dólar frente a eso.</li>`)
		// Los nodos de Mostro de este mercado y si están para operar
		const nodes = new Map()
		for (const o of [...asks, ...bids]) if (o.take && !nodes.has(o.take.node)) nodes.set(o.take.node, o.node ?? 'Mostro')
		for (const [key, name] of nodes) {
			const n = data?.nodes?.[key]
			const h = window.TPMostro?.health?.(key)
			const how = h === 'ok' ? 'funciona ✓' : h === 'degraded' ? 'con problemas' : h === 'down' ? 'caído' : h ? 'sin informe reciente' : null
			const fee = n?.fee != null ? `cobra ${(n.fee * 100).toLocaleString('en-US', { maximumFractionDigits: 2 })} % entre comprador y vendedor` : null
			const facts = [how, fee].filter(Boolean)
			out.push(`<li>Nodo de Mostro <b>${esc(name)}</b>${facts.length ? `: ${facts.join(', ')}` : ''}.</li>`)
		}
		const sell = asks.filter(canBuy).length
		out.push(
			`<li>${sell ? `<b>${sell}</b> ${sell === 1 ? 'venta se compra' : 'ventas se compran'} desde aquí (₿): los sats los retiene Mostro y llegan a tu cuenta de QvaPay.` : 'Ninguna venta de este mercado se compra desde aquí ahora.'} Las demás (↗) se abren en su plataforma. Terminal P2P no custodia ni intermedia.</li>`,
		)
		const ok = data?.relays?.filter((r) => r.ok).length ?? 0
		if (data) out.push(`<li class="muted">Órdenes públicas de Nostr (NIP-69), de ${ok} de ${data.relays.length} relays. Hodl Hodl no sale: no admite usuarios de Cuba.</li>`)
		const html = `<ul class="insight-list">${out.join('')}</ul>`
		if ($('insight').dataset.html !== html) {
			$('insight').dataset.html = html
			$('insight').innerHTML = html
		}
	}

	// Para el gráfico de profundidad (app.js): las órdenes con su monto como «usd», el rango que las abarca y cómo
	// escribir los precios
	function depth() {
		const { asks, bids } = bookOf(fiat)
		const lv = (o) => ({ price: o.price, usd: o.max })
		const a = asks.map(lv)
		const b = bids.map(lv)
		const mid = a[0] && b[0] ? (a[0].price + b[0].price) / 2 : (a[0] ?? b[0])?.price
		// Libros finos y separados: el rango abarca las primeras órdenes de cada lado (entre ±6 % y ±50 %)
		const far = mid ? Math.max(0, ...[...a.slice(0, 8), ...b.slice(0, 8)].map((l) => Math.abs(l.price / mid - 1))) : 0
		return { asks: a, bids: b, range: Math.min(0.5, Math.max(0.06, far * 1.15)), fmt: pxShort, unit: fiat }
	}

	function tip(o) {
		const off = blocked(o)
		const u = perUsdText(perUsd(o.price, o.fiat), o.fiat)
		return [
			`<div><b>${px(o.price)}</b> ${esc(o.fiat)}/BTC · ${prem(o.premium)} sobre el mercado</div>`,
			u ? `<div>≈ ${u}</div>` : '',
			`<div>${o.side === 'ask' ? 'Vende' : 'Compra'} ${o.min === o.max ? amt(o.max) : `de ${amt(o.min)} a ${amt(o.max)}`} ${esc(o.fiat)}${o.sats ? ` (${o.sats.toLocaleString('en-US')} sats)` : ''}</div>`,
			`<div>${esc(o.pays.join(', ') || 'Pago sin indicar')}</div>`,
			`<div>${esc(o.node ? `${platName(o.platform)} · ${o.node}` : platName(o.platform))}${o.name ? ` · ${esc(o.name)}` : ''}${o.score != null ? ` · ★${o.score.toFixed(2)}${o.reviews ? ` (${o.reviews.toLocaleString('en-US')})` : ''}` : ''}</div>`,
			o.layer ? `<div class="muted">${o.layer === 'lightning' ? '⚡ Lightning' : o.layer === 'onchain' ? '⛓ En cadena' : esc(o.layer)}</div>` : '',
			off ? `<div style="color:var(--warn)">⛔ ${esc(off)}</div>` : '',
			`<div class="muted">${canBuy(o) ? 'Clic para comprar desde aquí' : off ? 'Ahora no se puede comprar' : o.side === 'bid' && o.take ? 'Venderle bitcoin aún no se puede desde aquí' : o.link ? `Clic para abrirla en ${platName(o.platform)}` : 'Se toma desde su plataforma'}</div>`,
		].join('')
	}

	const orderOf = (row) => shown[row.dataset.side]?.[Number(row.dataset.i)] ?? null
	function hover(e, tipEl) {
		const row = e.target.closest('.lvl')
		const o = row && orderOf(row)
		if (!o) return void (tipEl.hidden = true)
		tipEl.innerHTML = tip(o)
		tipEl.hidden = false
		tipEl.style.left = `${Math.min(e.clientX + 14, window.innerWidth - tipEl.offsetWidth - 8)}px`
		tipEl.style.top = `${Math.min(e.clientY + 14, window.innerHeight - tipEl.offsetHeight - 8)}px`
	}
	function click(e) {
		const row = e.target.closest('.lvl')
		const o = row && orderOf(row)
		if (!o) return
		if (canBuy(o)) return window.TPMostro.take(o)
		if (blocked(o)) return
		if (o.link) window.open(o.link, '_blank', 'noopener,noreferrer')
	}

	// Desplegar o plegar las monedas de bitcoin en la lista de mercados
	for (const id of ['marketList'])
		$(id).addEventListener('click', (e) => {
			if (!e.target.closest('[data-btc-more]') || $('marketSearch').value.trim()) return
			store.set(LIST_OPEN, !store.get(LIST_OPEN, false))
			renderMarkets()
		})

	let typing = 0
	$('btcPay').addEventListener('input', (e) => {
		clearTimeout(typing)
		typing = setTimeout(() => {
			pay = e.target.value
			draw()
		}, 150)
	})

	window.TPBtc = {
		get on() {
			return !!fiat
		},
		open,
		leave,
		draw,
		depth,
		hover,
		click,
		// Sus filas en la lista de mercados, debajo de las de QvaPay
		rows(query) {
			if (!listed()) return ''
			const q = (query ?? '').trim().toLowerCase()
			const all = markets().filter((m) => !q || `bitcoin btc nostr mostro ${m.fiat}`.toLowerCase().includes(q))
			if (!all.length) return ''
			// Plegado (de entrada) solo el CUP y el que está a la vista: con todas, la lista alargaría el terminal entero.
			// Buscando, todas las que encajen
			const open = !!q || store.get(LIST_OPEN, false)
			const list = open ? all : all.filter((m) => m.fiat === 'CUP' || m.fiat === fiat)
			const more = q || all.length <= list.length && !open ? '' : `<span class="mrow-more">${open ? 'ver menos' : `ver las ${all.length} monedas`}</span>`
			return (
				`<button type="button" class="mrow-head" data-btc-more aria-expanded="${open}">Bitcoin P2P · Nostr <span class="btc-star" title="Modo Pro">★</span>${more}</button>` +
				list
					.map((m) => {
						const here = fiat === m.fiat
						const mostro = m.ask.some((o) => o.take) ? 'Mostro · ' : ''
						return `<button class="mrow ${here ? 'active' : ''}" data-btc="${esc(m.fiat)}" role="option" aria-selected="${here}" title="Bitcoin en ${esc(m.fiat)}: órdenes P2P de Nostr (modo Pro, experimental)">
						<span class="mmeta">${ICON(m.fiat)}<span class="mname"><b>BTC / ${esc(m.fiat)}</b><span>${mostro}${m.ask.length + m.bid.length} órdenes</span></span></span>
						<span class="num bid">${pxShort(m.bid[0]?.price)}</span><span class="num ask">${pxShort(m.ask[0]?.price)}</span></button>`
					})
					.join('')
			)
		},
		// En la columna estrecha, un solo icono: el mercado de bitcoin a la vista (o el CUP)
		rail() {
			if (!listed()) return ''
			const f = fiat ?? 'CUP'
			return `<button class="rail-btn ${fiat ? 'active' : ''}" data-btc="${esc(f)}" title="Bitcoin P2P en Nostr · BTC / ${esc(f)} (modo Pro)" aria-label="Bitcoin" aria-pressed="${!!fiat}">${ICON('')}</button>`
		},
	}
	if (typeof PRO_FEATURES !== 'undefined') PRO_FEATURES.push(['₿', 'Bitcoin P2P', 'compra bitcoin en Mostro y recíbelo en tu QvaPay'])
	load()
})()
