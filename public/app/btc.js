// Mercado «Bitcoin · Mostro» (experimental, modo Pro): sale en la lista de mercados como uno más y, al elegirlo, el
// centro del terminal enseña el libro de bitcoin P2P en Nostr (nostr/nostr.js) y las compras en Mostro (nostr/mostro.js)
// en vez del libro de QvaPay. Con la cuenta de QvaPay conectada, la dirección Lightning es la suya (usuario@qvpay.me).
// Solo existe donde el servidor lo enciende: si no, ni esta vista ni este archivo llegan (data-cross)
'use strict'
;(() => {
	const view = document.getElementById('nxRoot')
	if (!view || !view.classList.contains('area-btc')) return
	const SAVED = 'btc.on'
	let on = false
	// Cuenta de QvaPay con la que se cargó la compra (sus compras de Mostro van aparte de las de otra cuenta)
	let loadedFor = null
	let loading = null
	// Pidió entrar sin cuenta o sin saber aún si es Pro: se entra (o se ofrece Pro) en cuanto se sepa
	let pending = false

	const proOn = () => !!window.TPPro?.enabled
	// La fila se ve sin cuenta (al elegirla, se pide conectar) y, con cuenta, si Pro está encendido en el panel
	const listed = () => !bk.acct.connected || proOn()
	const user = () => String(bk.acct?.username ?? '').toLowerCase()

	if (typeof PRO_FEATURES !== 'undefined') PRO_FEATURES.push(['₿', 'Bitcoin en Mostro', 'compra bitcoin P2P en Nostr y recíbelo en tu QvaPay'])

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
	// El libro y la compra se cargan la primera vez que se entra: quien no lo usa no los descarga
	function load() {
		if (loading) return loading
		loadedFor = user()
		window.TPMostroConfig = { user: loadedFor }
		const css = document.createElement('link')
		css.rel = 'stylesheet'
		css.href = '/nostr/nostr.css'
		document.head.append(css)
		loading = script('/nostr/mostro.js')
			.then(() => script('/nostr/nostr.js'))
			.catch(() => {
				loading = null
				document.getElementById('nxAt').textContent = 'No se pudo cargar: vuelve a intentarlo'
			})
		return loading
	}

	function enter() {
		pending = false
		if (!on) {
			on = true
			store.setMine(SAVED, true)
			document.body.classList.add('btc-on')
			closeMenus()
			closeMarketSheet()
			renderMarkets()
			render()
			window.scrollTo({ top: 0 })
		}
		if (loading) window.TPNostr?.resume()
		else load()
	}

	function leave() {
		if (!on) return
		on = false
		store.setMine(SAVED, false)
		document.body.classList.remove('btc-on')
		window.TPNostr?.pause()
		document.getElementById('mxDialog')?.close()
	}

	// Elegir el mercado: sin cuenta, conectarla; sin Pro, la ventana de Pro; con Pro, adentro
	function open() {
		if (!bk.acct.connected) {
			pending = true
			closeMarketSheet()
			return showConnect('Conecta tu cuenta de QvaPay para comprar bitcoin en Mostro')
		}
		if (!proOn()) return
		if (!window.TPPro.active) {
			// Recién conectada, Pro aún no ha respondido: se decide al llegar (tp:pro)
			if (!window.TPPro.print) {
				pending = true
				return
			}
			closeMarketSheet()
			return showPro()
		}
		enter()
	}

	document.addEventListener('tp:pro', (e) => {
		const p = e.detail
		// Otra cuenta en este navegador: sus compras de Mostro son otras (se recarga para no mezclarlas)
		if (loadedFor !== null && user() !== loadedFor) return location.reload()
		if (!p.active) {
			if (on) {
				leave()
				renderMarkets()
				render()
			}
			if (pending && bk.acct.connected && p.enabled) {
				pending = false
				showPro()
			}
			renderMarkets()
			return
		}
		if (pending || (!on && store.getMine(SAVED, false))) enter()
		else renderMarkets()
	})

	// Los avisos y la web traen aquí con #bitcoin
	function fromHash() {
		if (location.hash !== '#bitcoin') return
		history.replaceState(null, '', `${location.pathname}${location.search}`)
		pending = true
		if (window.TPPro?.print || !bk.acct.connected) open()
	}
	window.addEventListener('hashchange', fromHash)
	fromHash()

	const ICON = '<span class="coin-ic btc-ic" aria-hidden="true">₿</span>'
	window.TPBtc = {
		get on() {
			return on
		},
		open,
		leave,
		// Su fila en la lista de mercados (con Pro encendido en el panel; quien no es Pro la ve y al elegirla se le ofrece)
		row(query) {
			if (!listed()) return ''
			const q = (query ?? '').trim().toLowerCase()
			if (q && !'bitcoin btc mostro nostr lightning sats'.includes(q)) return ''
			return `<button class="mrow btc-row ${on ? 'active' : ''}" data-btc role="option" aria-selected="${on}" title="Comprar bitcoin P2P en Mostro (modo Pro, experimental)">
				<span class="mmeta">${ICON}<span class="mname"><b>Bitcoin · Mostro <span class="btc-star">★</span></b><span>BTC / CUP y más · P2P en Nostr</span></span></span>
				<span class="num">—</span><span class="num">—</span></button>`
		},
		rail() {
			if (!listed()) return ''
			return `<button class="rail-btn ${on ? 'active' : ''}" data-btc title="Bitcoin · Mostro (modo Pro)" aria-label="Bitcoin · Mostro" aria-pressed="${on}">${ICON}</button>`
		},
		// El par de arriba mientras se está en este mercado
		pair() {
			document.getElementById('pairName').textContent = 'BTC · Mostro'
			const icon = document.getElementById('pairIcon')
			if (icon.dataset.key !== 'btc') {
				icon.dataset.key = 'btc'
				icon.innerHTML = ICON
			}
			document.getElementById('pairSub').textContent = `Bitcoin P2P en Nostr${loadedFor ? ` · los sats van a ${loadedFor}@qvpay.me` : ''}`
		},
	}
	renderMarkets()
})()
