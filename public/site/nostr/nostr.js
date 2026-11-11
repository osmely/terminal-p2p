// Bitcoin P2P en Nostr (experimental): las órdenes abiertas de Mostro, RoboSats, Hodl Hodl y otros desde /data/nostr,
// en un libro por moneda. Todo lo que viene de fuera (nombres, métodos de pago, nodos) se pinta como texto, nunca como HTML
;(() => {
	const REFRESH_MS = 60_000
	const SHOWN = 25
	const PLATFORMS = { mostro: 'Mostro', robosats: 'RoboSats', hodlhodl: 'Hodl Hodl', telegram: 'Telegram', lnp2pbot: 'lnp2pBot', peach: 'Peach', pairbuy: 'Pairbuy', otra: 'Otras' }
	const $ = (id) => document.getElementById(id)
	const el = (tag, cls, text) => {
		const e = document.createElement(tag)
		if (cls) e.className = cls
		if (text !== undefined) e.textContent = text
		return e
	}
	const platName = (p) => PLATFORMS[p] ?? p.charAt(0).toUpperCase() + p.slice(1)
	// Un bitcoin cuesta de miles a cientos de millones según la moneda: sin decimales desde 100,000
	const px = (p) => (p > 0 ? p.toLocaleString('en-US', { maximumFractionDigits: p >= 100_000 ? 0 : 2, minimumFractionDigits: p >= 100_000 ? 0 : 2 }) : '—')
	const amt = (n) => n.toLocaleString('en-US', { maximumFractionDigits: n >= 100 ? 0 : 2 })
	// Lo que redondea a cero sale «0 %» (no «−0.0 %»)
	const pct = (x) => (x === null ? '—' : Math.abs(x) < 0.05 ? '0 %' : `${x > 0 ? '+' : x < 0 ? '−' : ''}${Math.abs(x).toFixed(x % 1 === 0 ? 0 : Math.abs(x) >= 10 ? 0 : 1)} %`)
	const clock = (t) => new Date(t).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
	const left = (t) => {
		const m = Math.round((t - Date.now()) / 60_000)
		if (m < 60) return `${Math.max(m, 1)} min`
		if (m < 48 * 60) return `${Math.round(m / 60)} h`
		return `${Math.round(m / 1440)} días`
	}
	// Las mayúsculas y los acentos no cuentan al buscar un método de pago (Transfermóvil = transfermovil)
	const fold = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()

	const params = new URLSearchParams(location.search)
	let fiat = params.get('m')?.toUpperCase() || null
	let data = null
	// Hodl Hodl va oculto de entrada: llena el libro con ofertas de pocos usuarios y no admite usuarios de Cuba.
	// Se ve con su botón
	let hidden = new Set(['hodlhodl'])
	let pay = ''
	let timer = 0
	// Lo que sale por dólar: el precio en la moneda entre el del bitcoin en dólares (en CUP, la tasa que se ve en QvaPay)
	const perUsd = (o) => {
		const usd = data?.market?.USD
		if (!o?.price || !usd || o.fiat === 'USD' || o.fiat === 'USDT' || o.fiat === 'USDC') return null
		const r = o.price / usd
		return `${r.toLocaleString('en-US', { maximumFractionDigits: r >= 100 ? 0 : r >= 1 ? 2 : 4, minimumFractionDigits: r >= 100 ? 0 : r >= 1 ? 2 : 4 })} ${o.fiat} por USD`
	}

	function setFiat(f) {
		fiat = f
		const q = new URLSearchParams(location.search)
		q.set('m', f)
		history.replaceState(null, '', `${location.pathname}?${q.toString()}`)
		render()
	}

	// Las monedas con órdenes, de más a menos; el CUP primero si hay
	function fiats() {
		const n = new Map()
		for (const o of data.orders) n.set(o.fiat, (n.get(o.fiat) ?? 0) + 1)
		return [...n.entries()].sort((a, b) => (b[0] === 'CUP') - (a[0] === 'CUP') || b[1] - a[1] || a[0].localeCompare(b[0]))
	}

	function chips(list) {
		$('nxFiats').replaceChildren(
			...list.map(([f, count]) => {
				const b = el('button', 'nx-fiat')
				b.type = 'button'
				b.setAttribute('role', 'tab')
				b.setAttribute('aria-selected', String(f === fiat))
				b.append(document.createTextNode(f), el('small', null, String(count)))
				b.addEventListener('click', () => f !== fiat && setFiat(f))
				return b
			}),
		)
	}

	function platChips(orders) {
		const n = new Map()
		for (const o of orders) n.set(o.platform, (n.get(o.platform) ?? 0) + 1)
		$('nxPlats').replaceChildren(
			...[...n.entries()]
				.sort((a, b) => b[1] - a[1])
				.map(([p, count]) => {
					const b = el('button', 'nx-plat')
					b.type = 'button'
					b.setAttribute('aria-pressed', String(!hidden.has(p)))
					b.title = hidden.has(p) ? 'Mostrar sus órdenes' : 'Ocultar sus órdenes'
					b.append(document.createTextNode(platName(p)), el('small', null, String(count)))
					b.addEventListener('click', () => {
						if (hidden.has(p)) hidden.delete(p)
						else hidden.add(p)
						render()
					})
					return b
				}),
		)
	}

	function row(o) {
		const li = el('li', 'nx-row')
		const price = el('b', `nx-px ${o.side}`, px(o.price))
		const prem = el('span', `nx-prem${o.premium > 0 ? ' up' : o.premium < 0 ? ' down' : ''}`, pct(o.premium))
		const size = el('span', 'nx-amt', o.min === o.max ? `${amt(o.min)}` : `${amt(o.min)}–${amt(o.max)}`)
		if (o.sats) size.title = `Monto fijo: ${o.sats.toLocaleString('en-US')} sats`
		const who = el('span', 'nx-who')
		const payTxt = el('span', 'nx-pay', o.pays.join(', ') || '—')
		const meta = el('span', 'nx-meta')
		meta.append(el('span', 'nx-layer', o.layer === 'lightning' ? '⚡' : o.layer === 'onchain' ? '⛓' : ''))
		meta.append(document.createTextNode(o.node ? `${platName(o.platform)} · ${o.node}` : platName(o.platform)))
		if (o.score !== null) meta.append(el('span', 'nx-rate', ` ★${o.score.toFixed(o.score % 1 === 0 ? 0 : 2)}${o.reviews !== null ? ` (${o.reviews.toLocaleString('en-US')})` : ''}`))
		else if (o.reviews) meta.append(el('span', 'nx-rate', ` ${o.reviews.toLocaleString('en-US')} op.`))
		who.append(payTxt, meta)
		const tip = [o.pays.join(', '), perUsd(o) && `≈ ${perUsd(o)}`]
		if (o.name) tip.push(`Usuario: ${o.name}`)
		if (o.exp) tip.push(`Caduca en ${left(o.exp)}`)
		if (o.sats) tip.push(`Monto fijo: ${o.sats.toLocaleString('en-US')} sats`)
		else tip.push('A precio de mercado: los sats se calculan al tomarla')
		who.title = tip.filter(Boolean).join(' · ')
		li.append(price, prem, size, who)
		// Las ventas de Mostro en un nodo que lo permite se compran desde aquí (mostro.js)
		if (window.TPMostro?.canTake(o)) {
			const b = el('button', 'nx-buy', 'Comprar')
			b.type = 'button'
			b.title = `Comprar en ${o.node ?? 'Mostro'} desde aquí`
			b.addEventListener('click', () => window.TPMostro.take(o))
			li.append(b)
		} else if (o.link) {
			const a = el('a', 'nx-open', '↗')
			a.href = o.link
			a.target = '_blank'
			a.rel = 'noopener noreferrer nofollow'
			a.title = `Abrir en ${platName(o.platform)}`
			a.setAttribute('aria-label', a.title)
			li.append(a)
		} else li.append(el('span', 'nx-open'))
		return li
	}

	function list(id, orders) {
		const box = $(id)
		if (!orders.length) {
			box.replaceChildren(el('li', 'nx-empty', 'Sin órdenes con estos filtros'))
			return
		}
		// Con algún «Comprar», la última columna es más ancha en ese lado
		box.closest('.nx-side')?.classList.toggle('nx-takeable', orders.slice(0, SHOWN).some((o) => window.TPMostro?.canTake(o)))
		const rows = orders.slice(0, SHOWN).map(row)
		if (orders.length > SHOWN) rows.push(el('li', 'nx-more', `y ${orders.length - SHOWN} más`))
		box.replaceChildren(...rows)
	}

	function render() {
		if (!data) return
		const list0 = fiats()
		if (!list0.length) {
			$('nxFiats').replaceChildren()
			list('nxAsks', [])
			list('nxBids', [])
			return
		}
		if (!fiat || !list0.some(([f]) => f === fiat)) fiat = list0.find(([f]) => f === 'USD')?.[0] ?? list0[0][0]
		chips(list0)
		document.querySelectorAll('[data-nx="fiat"]').forEach((n) => (n.textContent = fiat))

		const mine = data.orders.filter((o) => o.fiat === fiat)
		platChips(mine)
		const q = fold(pay.trim())
		const shown = mine.filter((o) => !hidden.has(o.platform) && (!q || o.pays.some((p) => fold(p).includes(q))))
		const asks = shown.filter((o) => o.side === 'ask')
		const bids = shown.filter((o) => o.side === 'bid')
		list('nxAsks', asks)
		list('nxBids', bids)

		const ref = data.market[fiat === 'USDT' || fiat === 'USDC' ? 'USD' : fiat]
		$('nxMarket').textContent = ref ? px(ref) : '—'
		$('nxMarketNote').textContent = ref ? ['Yadio', perUsd({ fiat, price: ref })].filter(Boolean).join(' · ') : 'Yadio no da esta moneda'
		const a = asks.find((o) => o.price)
		const b = bids.find((o) => o.price)
		$('nxBestAsk').textContent = a ? px(a.price) : '—'
		$('nxBestAskNote').textContent = a ? [pct(a.premium), perUsd(a) ?? platName(a.platform)].join(' · ') : 'sin órdenes'
		$('nxBestBid').textContent = b ? px(b.price) : '—'
		$('nxBestBidNote').textContent = b ? [pct(b.premium), perUsd(b) ?? platName(b.platform)].join(' · ') : 'sin órdenes'
		$('nxCount').textContent = `${asks.length} / ${bids.length}`
	}

	async function load() {
		clearTimeout(timer)
		try {
			const r = await fetch('/data/nostr', { headers: { Accept: 'application/json' } })
			if (!r.ok) throw new Error(String(r.status))
			data = await r.json()
			window.TPMostro?.setNodes(data.nodes)
			render()
			const ok = data.relays.filter((x) => x.ok).length
			const at = $('nxAt')
			at.textContent = `${data.orders.length.toLocaleString('en-US')} órdenes · ${ok} de ${data.relays.length} relays · datos de las ${clock(data.at)}`
			at.title = data.relays.map((x) => `${x.url.replace('wss://', '')}: ${x.ok ? `${x.events} eventos` : `no respondió${x.why ? ` (${x.why})` : ''}`}`).join('\n')
		} catch {
			$('nxAt').textContent = 'No se pudo cargar: se reintenta en un minuto'
		}
		timer = setTimeout(load, REFRESH_MS)
	}

	let typing = 0
	$('nxPay').addEventListener('input', (e) => {
		clearTimeout(typing)
		typing = setTimeout(() => {
			pay = e.target.value
			render()
		}, 150)
	})
	document.addEventListener('visibilitychange', () => {
		if (document.visibilityState === 'visible') load()
		else clearTimeout(timer)
	})
	load()
})()
