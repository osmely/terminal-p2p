// Comparador P2P (experimental): los anuncios de USDT de cada exchange para una moneda, desde /data/cross.
// Todo lo que viene de fuera (nombres, métodos de pago) se pinta como texto, nunca como HTML
;(() => {
	const FIATS = [
		['VES', 'Venezuela'],
		['ARS', 'Argentina'],
		['COP', 'Colombia'],
		['MXN', 'México'],
		['BRL', 'Brasil'],
		['PEN', 'Perú'],
		['CLP', 'Chile'],
		['BOB', 'Bolivia'],
	]
	const REFRESH_MS = 60_000
	const SHOWN = 8
	const $ = (id) => document.getElementById(id)
	const el = (tag, cls, text) => {
		const e = document.createElement(tag)
		if (cls) e.className = cls
		if (text !== undefined) e.textContent = text
		return e
	}
	const dec = (p) => (p >= 1000 ? 2 : p >= 10 ? 3 : 4)
	const px = (p) => (p > 0 ? p.toLocaleString('en-US', { minimumFractionDigits: dec(p), maximumFractionDigits: dec(p) }) : '—')
	const usdt = (n) => (n > 0 ? n.toLocaleString('en-US', { maximumFractionDigits: n >= 100 ? 0 : 2 }) : '—')
	const pct = (x) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(2)} %`
	const clock = (t) => new Date(t).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit', second: '2-digit' })

	const params = new URLSearchParams(location.search)
	let fiat = FIATS.some(([f]) => f === params.get('m')) ? params.get('m') : 'VES'
	let timer = 0
	let seq = 0

	function chips() {
		const box = $('cxFiats')
		box.replaceChildren(
			...FIATS.map(([f, country]) => {
				const b = el('button', 'cx-fiat', f)
				b.type = 'button'
				b.title = country
				b.setAttribute('role', 'tab')
				b.setAttribute('aria-selected', String(f === fiat))
				b.addEventListener('click', () => {
					if (f === fiat) return
					fiat = f
					const q = new URLSearchParams(location.search)
					q.set('m', f)
					history.replaceState(null, '', `${location.pathname}?${q.toString()}`)
					chips()
					load()
				})
				return b
			}),
		)
		document.querySelectorAll('[data-cx="fiat"]').forEach((n) => (n.textContent = fiat))
	}

	// El mejor de cada lado de un exchange: el primero (el servidor ya los manda ordenados por precio)
	const best = (side) => side.ads[0]?.price ?? 0

	function summary(data) {
		const live = data.exchanges.filter((e) => e.ok)
		const asks = live.filter((e) => best(e.ask) > 0)
		const bids = live.filter((e) => best(e.bid) > 0)
		const minAsk = asks.length ? Math.min(...asks.map((e) => best(e.ask))) : 0
		const maxBid = bids.length ? Math.max(...bids.map((e) => best(e.bid))) : 0

		const rows = data.exchanges.map((e) => {
			const tr = el('tr')
			tr.append(el('td', 'cx-name', e.name))
			if (!e.ok) {
				const td = el('td', 'cx-off', e.why ? `No respondió (${e.why})` : 'No respondió')
				td.colSpan = 4
				tr.append(td)
				return tr
			}
			const a = best(e.ask)
			const b = best(e.bid)
			const ta = el('td', `ask${a > 0 && a === minAsk && asks.length > 1 ? ' cx-best' : ''}`, px(a))
			const tb = el('td', `bid${b > 0 && b === maxBid && bids.length > 1 ? ' cx-best' : ''}`, px(b))
			// Lo que pierde quien compra y vende en el mismo exchange al momento (negativo casi siempre)
			const own = a > 0 && b > 0 ? (b - a) / a : null
			const tg = el('td', own === null ? '' : own >= 0 ? 'bid' : 'cx-muted', own === null ? '—' : pct(own))
			const tn = el('td', 'cx-muted', `${e.ask.total.toLocaleString('en-US')} / ${e.bid.total.toLocaleString('en-US')}`)
			tn.title = 'Anuncios que venden / que compran USDT'
			tr.append(ta, tb, tg, tn)
			return tr
		})
		$('cxRows').replaceChildren(...rows)

		// La mejor pareja entre exchanges distintos: comprar donde más barato lo venden y vender donde más caro lo compran
		let pair = null
		for (const x of asks)
			for (const y of bids) {
				if (x.id === y.id) continue
				const g = (best(y.bid) - best(x.ask)) / best(x.ask)
				if (!pair || g > pair.g) pair = { buy: x, sell: y, g }
			}
		$('cxGap').hidden = !pair
		if (pair) {
			const a = pair.buy.ask.ads[0]
			const b = pair.sell.bid.ads[0]
			$('cxBuyAt').textContent = pair.buy.name
			$('cxBuyPx').textContent = `${px(a.price)} ${data.fiat} · ${usdt(a.usdt)} USDT`
			$('cxSellAt').textContent = pair.sell.name
			$('cxSellPx').textContent = `${px(b.price)} ${data.fiat} · ${usdt(b.usdt)} USDT`
			const g = $('cxGapPct')
			g.textContent = pct(pair.g)
			g.className = pair.g > 0 ? 'bid' : 'ask'
			$('cxGapNote').textContent = pair.g > 0 ? 'antes de comisiones y transferencias' : 'hoy no hay diferencia a favor'
		}
	}

	function adRow(ad, cls) {
		const li = el('li', 'cx-ad')
		li.append(el('b', cls, px(ad.price)), el('span', 'cx-amt', usdt(ad.usdt)))
		const who = el('span', 'cx-who', ad.user || '—')
		const meta = []
		if (ad.orders !== null) meta.push(`${ad.orders.toLocaleString('en-US')} op.`)
		if (ad.rate !== null) meta.push(`${Math.round(ad.rate * 100)} %`)
		if (ad.min || ad.max) meta.push(`límites ${ad.min ? ad.min.toLocaleString('en-US') : '?'}–${ad.max ? ad.max.toLocaleString('en-US') : '?'}`)
		if (ad.pays.length) meta.push(ad.pays.join(', '))
		who.title = meta.join(' · ')
		li.append(who)
		return li
	}

	function sideList(title, side, cls) {
		const box = el('div', 'cx-side')
		box.append(el('h4', null, title))
		if (!side.ads.length) {
			box.append(el('p', 'cx-muted cx-empty', 'Sin anuncios'))
			return box
		}
		const head = el('div', 'cx-ad cx-ad-head')
		head.append(el('span', null, 'Precio'), el('span', null, 'USDT'), el('span', null, 'Usuario'))
		const ul = el('ul')
		ul.append(...side.ads.slice(0, SHOWN).map((a) => adRow(a, cls)))
		box.append(head, ul)
		return box
	}

	function books(data) {
		$('cxBooks').replaceChildren(
			...data.exchanges.map((e) => {
				const card = el('article', 'cx-book')
				const h = el('h3', null, e.name)
				if (!e.ok) h.append(el('small', 'cx-off', e.why ? ` · no respondió (${e.why})` : ' · no respondió'))
				card.append(h)
				if (e.ok) card.append(sideList('Venden USDT (compras aquí)', e.ask, 'ask'), sideList('Compran USDT (vendes aquí)', e.bid, 'bid'))
				return card
			}),
		)
	}

	async function load() {
		clearTimeout(timer)
		const mine = ++seq
		$('cxAt').textContent = 'Actualizando…'
		try {
			const r = await fetch(`/data/cross?fiat=${fiat}`, { headers: { Accept: 'application/json' } })
			if (!r.ok) throw new Error(String(r.status))
			const data = await r.json()
			if (mine !== seq) return // ya se pidió otra moneda
			summary(data)
			books(data)
			const n = data.exchanges.filter((e) => e.ok).length
			$('cxAt').textContent = `${n} de ${data.exchanges.length} exchanges · datos de las ${clock(data.at)}`
		} catch {
			if (mine !== seq) return
			$('cxAt').textContent = 'No se pudo cargar: se reintenta en un minuto'
		}
		timer = setTimeout(load, REFRESH_MS)
	}

	document.addEventListener('visibilitychange', () => {
		if (document.visibilityState === 'visible') load()
		else clearTimeout(timer)
	})
	chips()
	load()
})()
