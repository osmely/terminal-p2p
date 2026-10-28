// Plan Pro: si eres Pro y comprar o añadir días con QvaPay. Pro va con tu cuenta de QvaPay: cualquier
// dispositivo donde la conectes ya es Pro. El token no se guarda en el servidor: solo ve su huella (data.js).
// Quién pagó lo confirma QvaPay en el servidor. Las funciones Pro llegan en un módulo aparte (/pro/module.js)
'use strict'

// enabled: Pro encendido en el panel. Apagado, no se ofrece nada (ni botón ★, ni compras, ni orden inteligente)
const pro = { enabled: false, active: false, username: null, plan: null, expiresAt: null, license: null, print: null, loaded: false }
window.TPPro = pro

// El simulador del mismo entorno (sim.staging… desde app.staging…; en desarrollo, el de sim.localhost)
const SIM_URL = /\.terminalp2p\.com$/.test(location.hostname)
	? location.origin.replace('://app.', '://sim.')
	: location.hostname.endsWith('localhost')
		? `${location.protocol}//sim.localhost:5180`
		: 'https://sim.terminalp2p.com'

// Lo que se compra son días de Pro: se suman a los que te queden
const PRO_PLANS = [
	['week', '7 días', '1.99 USD', '0.28 USD al día'],
	['month', '30 días', '4.99 USD', '0.17 USD al día'],
	['quarter', '90 días', '12.99 USD', '0.14 USD al día'],
	['year', '365 días', '39.99 USD', '0.11 USD al día'],
]
const PRO_FEATURES = [
	['⚡', 'Orden inteligente', 'si tu precio ya cruza el libro, toma lo que hay a mejor precio y publica solo el resto, como en un exchange'],
	['⚡', 'Libro en tiempo real', 'cada oferta nueva te llega al instante'],
	['📡', 'Radar', 'vigila hasta 3 mercados mientras el terminal está abierto, aunque sea en otra pestaña, y te avisa con sonido, notificación y por Telegram cuando aparece una oferta con tus reglas. Si quieres, la toma sola, con tu tope del día'],
	['🔀', 'Libro cruzado', 'cuando alguien vende más barato de lo que otro compra: si lo puedes aprovechar, cuántos USD encajan y cuánto te quedaría'],
	['📊', 'Compras y ventas en el gráfico', 'cada barra de operaciones por día partida en compras (verde) y ventas (rojo), para ver hacia dónde se mueve el mercado'],
	['📈', 'Todos los mercados del simulador', 'sin Pro, BTC y ETH; con Pro también SOL, XRP, BNB, DOGE, SUI, PEPE y TAO (sim.terminalp2p.com)'],
]
// El simulador manda aquí para entrar (?connect=sim): se abre la ventana del token y, en cuanto la sesión
// compartida está lista, se vuelve al simulador. Se recuerda unos minutos en esta pestaña por si tardas
const SIM_BACK_MS = 10 * 60_000
if (new URLSearchParams(location.search).get('connect') === 'sim') {
	const q = new URLSearchParams(location.search)
	q.delete('connect')
	history.replaceState(null, '', `${location.pathname}${q.size ? `?${q}` : ''}${location.hash}`)
	try {
		sessionStorage.setItem('tp.backToSim', String(Date.now()))
	} catch {}
}
const wantsSim = () => {
	try {
		return Date.now() - Number(sessionStorage.getItem('tp.backToSim') ?? 0) < SIM_BACK_MS
	} catch {
		return false
	}
}
let simConnectShown = false
const CHECKOUT_POLL_MS = 4000
const CHECKOUT_MAX_MS = 60 * 60_000
const RENEW_SOON_MS = 5 * 86_400_000
let proPolling = null

async function proFetch(path, body) {
	const r = await fetch(path, body === undefined ? { cache: 'no-store' } : { method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
	const d = await r.json().catch(() => ({}))
	if (!r.ok) throw new Error(d.error || 'Algo falló. Inténtalo de nuevo.')
	return d
}
const daysLeft = () => Math.max(0, Math.ceil((pro.expiresAt - Date.now()) / 86_400_000))
const daysText = (n) => (n === 1 ? '1 día' : `${n} días`)
const proDate = (ms) => new Date(ms).toLocaleDateString('es', { day: 'numeric', month: 'long', year: 'numeric' })

function applyPro(s) {
	Object.assign(pro, { enabled: s.enabled === true, active: !!s.pro, canTrial: !s.pro && s.canTrial === true, username: s.username ?? null, plan: s.plan ?? null, expiresAt: s.expiresAt ?? null, license: s.license ?? null })
	
	if (pro.active && !pro.loaded) {
		pro.loaded = true
		const s2 = document.createElement('script')
		s2.src = `/pro/module.js?l=${encodeURIComponent(pro.license)}`
		// Si no llega (sin red, licencia recién renovada), se vuelve a pedir en la próxima revisión de Pro
		s2.onerror = () => {
			s2.remove()
			pro.loaded = false
		}
		document.head.appendChild(s2)
	}
	// El libro llega del servidor con tu cuenta conectada: con Pro, al instante; sin Pro, cada 10 s
	if (bk.acct.connected && pro.print) TPApi.live?.start(pro.print, pro.active)
	else TPApi.live?.stop()
	renderProChip()
	document.dispatchEvent(new CustomEvent('tp:pro', { detail: pro }))
}

// Al conectar la cuenta y luego cada pocos minutos (ver abajo)
async function refreshPro() {
	// Sin cuenta conectada, el simulador tampoco tiene sesión
	if (!bk.acct.connected) {
		fetch('/pro/leave', { method: 'POST', cache: 'no-store' }).catch(() => {})
		if (wantsSim() && !simConnectShown && typeof showConnect === 'function') {
			simConnectShown = true
			showConnect()
		}
		return applyPro({ pro: false })
	}
	try {
		pro.print = (await api('/print')).print
		if (!pro.print) return applyPro({ pro: false })
		// Además de decir si eres Pro, deja la sesión compartida con el simulador y dice si aún puedes activar
		// tus 14 días gratis (no empiezan solos: los activas tú desde ★)
		let s = await proFetch('/pro/status', { print: pro.print })
		// Si cambiaste de token en este navegador, la huella vieja pasa su Pro y su cuenta del simulador a la nueva
		const old = store.get('pro.print', null)
		if (old && old !== pro.print) {
			const moved = await proFetch('/pro/rotate', { from: old, to: pro.print }).catch(() => null)
			if (moved && !s.pro) s = moved
		}
		store.set('pro.print', pro.print)
		applyPro(s)
		// Venías del simulador: la sesión ya está, de vuelta allí
		if (wantsSim()) {
			try {
				sessionStorage.removeItem('tp.backToSim')
			} catch {}
			return location.assign(SIM_URL)
		}
		if (pro.active && pro.expiresAt - Date.now() < RENEW_SOON_MS && store.get('pro.renewTold', '') !== new Date().toDateString()) {
			store.set('pro.renewTold', new Date().toDateString())
			toast(`Te quedan ${daysText(daysLeft())} de Pro. Añade más desde el botón ★.`)
		}
		resumeCheckout()
	} catch {
		// Sin conexión con el servidor no se pierde nada: se reintenta en la próxima revisión
	}
}

function renderProChip() {
	const b = $('proBtn')
	if (!b) return
	b.hidden = !bk.acct.connected || !pro.enabled
	b.classList.toggle('on', pro.active)
	b.innerHTML = `<span aria-hidden="true">★</span><span class="pro-label">${pro.active ? daysText(daysLeft()) : pro.canTrial ? 'Probar Pro' : 'Pro'}</span>`
	// El radar es del módulo Pro (TPProRadar); sin Pro, su botón abre la ventana de Pro
	const r = $('radarBtn')
	if (r) r.hidden = b.hidden
	b.title = pro.active ? `Te quedan ${daysText(daysLeft())} de Pro (hasta el ${proDate(pro.expiresAt)})` : pro.canTrial ? 'Prueba Pro 14 días gratis' : 'Terminal P2P Pro'
}

// ── Ventana Pro ──────────────────────────────────────────────────────
// Con días de Pro solo se compran más cuando quedan pocos (el servidor también lo exige); con los gratis, siempre
const canRenew = () => !pro.active || pro.plan === 'trial' || pro.expiresAt - Date.now() <= RENEW_SOON_MS

function showPro() {
	if (!bk.acct.connected) return toast('Conecta tu cuenta de QvaPay (arriba a la derecha) para usar Pro', true)
	const feats = PRO_FEATURES.map(([i, t, d]) => `<li><span class="pro-ic">${i}</span><div><b>${t}</b><p class="muted">${d}</p></div></li>`).join('')
	const plans = PRO_PLANS.map(([id, name, price, per]) => `<button class="pro-plan" data-plan="${id}"><b>${name}</b><span class="mono">${price}</span><small>${per}</small></button>`).join('')
	const refund = `Si no te convence, te devolvemos el dinero en los 7 días siguientes a tu primera compra: escríbenos a <a class="link" href="https://t.me/terminalp2p" target="_blank" rel="noopener">@terminalp2p</a>.`
	openModal(
		pro.active
			? `<div class="stack pro-box"><h3>★ Te quedan ${daysText(daysLeft())} de Pro</h3>
				<p class="muted">@${esc(pro.username)} · ${{ trial: 'días gratis', gift: 'días regalados' }[pro.plan] ?? 'días comprados'} · hasta el <b>${proDate(pro.expiresAt)}</b></p>
				<ul class="pro-feats">${feats}</ul>
				${
					canRenew()
						? `<p class="hint">Funciona en todos los dispositivos donde conectes tu cuenta. Compra más días cuando quieras: se suman a los que te quedan.</p><div class="pro-plans">${plans}</div><p class="hint">Pagas con tu saldo en QvaPay. Nada se cobra solo. ${refund}</p>`
						: `<p class="hint">Funciona en todos los dispositivos donde conectes tu cuenta. Podrás comprar más días cuando te queden 5 o menos, desde el <b>${proDate(pro.expiresAt - RENEW_SOON_MS)}</b>. Nada se cobra solo.</p>`
				}</div>`
			: pro.canTrial
				? `<div class="stack pro-box"><h3>★ Prueba Terminal P2P Pro 14 días gratis</h3>
				<ul class="pro-feats">${feats}</ul>
				<button class="btn primary block" id="proTrial">Activar mis 14 días gratis</button>
				<p class="hint">Sin pagar nada. Cuando terminen, decides si compras días: nada se cobra solo. Funciona en todos los dispositivos donde conectes tu cuenta.</p>
				<details class="pro-more"><summary>¿Prefieres comprar días ya?</summary><div class="pro-plans">${plans}</div><p class="hint">Pagas con tu saldo en QvaPay. ${refund}</p></details></div>`
				: `<div class="stack pro-box"><h3>★ Terminal P2P Pro</h3>
				<ul class="pro-feats">${feats}</ul>
				<p class="muted">Ya usaste tus 14 días gratis. Compra días de Pro:</p>
				<div class="pro-plans">${plans}</div>
				<p class="hint">Pagas con tu saldo en QvaPay. Tu token no sale de este navegador. Nada se cobra solo: cada compra la haces tú. ${refund}</p></div>`,
	)
	for (const b of $('modalBody').querySelectorAll('[data-plan]')) b.onclick = () => startCheckout(b.dataset.plan)
	$('proTrial')?.addEventListener('click', startTrial)
}

// Los 14 días gratis empiezan cuando el usuario los activa
async function startTrial() {
	$('proTrial').disabled = true
	try {
		applyPro(await proFetch('/pro/trial', { print: pro.print }))
		showFreeDays()
	} catch (e) {
		$('proTrial').disabled = false
		toast(e.message, true)
	}
}

// Recién activados los 14 días gratis
function showFreeDays() {
	openModal(`<div class="stack pro-box"><h3>★ Activaste tus 14 días de Pro gratis</h3>
		<p class="muted">Hasta el <b>${proDate(pro.expiresAt)}</b>. La orden inteligente ya está activa, y en el <a class="link" href="${SIM_URL}" target="_blank" rel="noopener">simulador</a> operas todos los mercados. Cuando se acaben, puedes comprar más días desde el botón ★.</p>
		<button class="btn primary block" id="proOk">Listo</button></div>`)
	$('proOk').onclick = closeModal
}

async function startCheckout(plan) {
	try {
		const c = await proFetch('/pro/checkout', { print: pro.print, plan })
		store.set('pro.checkout', { id: c.id, url: c.url, at: Date.now() })
		window.open(c.url, '_blank', 'noopener')
		showWaiting()
	} catch (e) {
		toast(e.message, true)
	}
}

function showWaiting() {
	const c = store.get('pro.checkout', null)
	if (!c) return
	openModal(`<div class="stack pro-box"><h3>Esperando tu pago</h3>
		<p class="muted">Paga la factura en QvaPay. Cuando QvaPay lo confirme, esto se actualiza solo.</p>
		<a class="btn primary block" href="${esc(c.url)}" target="_blank" rel="noopener">Abrir el pago en QvaPay</a>
		<p class="hint" id="proWait">Comprobando…</p></div>`)
	pollCheckout()
}

// Comprueba la factura hasta que QvaPay la confirme (también si vuelves más tarde a la página)
function pollCheckout() {
	if (proPolling) return
	const tick = async () => {
		const c = store.get('pro.checkout', null)
		if (!c || Date.now() - c.at > CHECKOUT_MAX_MS) {
			proPolling = null
			store.set('pro.checkout', null)
			return
		}
		try {
			const r = await proFetch('/pro/checkout/status', { id: c.id, print: pro.print })
			if (r.status === 'paid') {
				proPolling = null
				store.set('pro.checkout', null)
				applyPro(r)
				return showWelcome()
			}
			if (r.status === 'expired') {
				proPolling = null
				store.set('pro.checkout', null)
				if ($('proWait')) $('proWait').textContent = 'La factura caducó sin pagarse. Puedes pedir otra.'
				return
			}
		} catch {}
		proPolling = setTimeout(tick, CHECKOUT_POLL_MS)
	}
	proPolling = setTimeout(tick, 0)
}

function resumeCheckout() {
	const q = new URLSearchParams(location.search)
	const back = q.get('pro')
	if (back) {
		q.delete('pro')
		history.replaceState(null, '', `${location.pathname}${q.size ? `?${q}` : ''}${location.hash}`)
	}
	if (!pro.enabled) return
	// El simulador manda aquí para hacerse Pro
	if (back === 'open') return showPro()
	if (back === 'cancel') {
		store.set('pro.checkout', null)
		return toast('Pago cancelado: no se cobró nada')
	}
	if (store.get('pro.checkout', null)) back === 'ok' && $('modal').hidden ? showWaiting() : pollCheckout()
}

function showWelcome() {
	openModal(`<div class="stack pro-box"><h3>★ Días añadidos</h3>
		<p class="muted">Ahora te quedan <b>${daysText(daysLeft())}</b> de Pro, hasta el <b>${proDate(pro.expiresAt)}</b>. Funcionan en cualquier dispositivo donde conectes tu cuenta.</p>
		<button class="btn primary block" id="proOk">Listo</button></div>`)
	$('proOk').onclick = closeModal
}

document.addEventListener('click', (e) => e.target.closest('#proBtn') && showPro())
document.addEventListener('click', (e) => e.target.closest('#radarBtn') && (pro.active && window.TPProRadar ? window.TPProRadar.open() : showPro()))
// Cada 5 minutos y al volver a la pestaña: si se apaga o enciende Pro en el panel, o se te acaban los días, se
// nota sin recargar (y la licencia firmada de un día se renueva sola)
setInterval(() => !document.hidden && bk.acct.connected && refreshPro(), 5 * 60_000)
document.addEventListener('visibilitychange', () => !document.hidden && bk.acct.connected && refreshPro())
