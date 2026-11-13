// Modo Pro: si eres Pro y comprar o añadir días con QvaPay. Pro va con tu cuenta de QvaPay: cualquier
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

// Lo que se compra son días de Pro: se suman a los que te queden. Los paquetes y sus precios los da el servidor
let proPlans = []
// Los días gratis: los dice el servidor con el estado de Pro
let proTrialDays = 7
const usdText = (n) => `${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USD`
// Lo que suma el modo Pro, en corto: el detalle está en la entrada del blog (PRO_INFO_URL)
const PRO_FEATURES = [
	['⚡', tl('pro.f.smartOrder'), tl('pro.f.smartOrderSub')],
	['⏱️', tl('pro.f.liveBook'), tl('pro.f.liveBookSub')],
	['📡', tl('pro.f.radar'), tl('pro.f.radarSub')],
	['📈', tl('pro.f.analysis'), tl('pro.f.analysisSub')],
	['🎯', tl('pro.f.autoPrice'), tl('pro.f.autoPriceSub')],
	['🔀', tl('pro.f.crossed'), tl('pro.f.crossedSub')],
	['💰', tl('pro.f.gains'), tl('pro.f.gainsSub')],
	['📲', tl('pro.f.offerAlerts'), tl('pro.f.offerAlertsSub')],
	['🔔', tl('pro.f.rateAlerts'), tl('pro.f.rateAlertsSub')],
	['📊', tl('pro.f.flow'), tl('pro.f.flowSub')],
	['🕯️', tl('pro.f.candles'), tl('pro.f.candlesSub')],
]
// La web del mismo entorno (staging.… desde app.staging.…)
const PRO_INFO_URL = `${/\.terminalp2p\.com$/.test(location.hostname) ? location.origin.replace('://app.', '://') : 'https://terminalp2p.com'}/blog/modo-pro/`
// El simulador manda aquí para entrar (?connect=sim): se abre la ventana del token y, en cuanto la sesión
// compartida está lista, se vuelve al simulador. Se recuerda unos minutos en esta pestaña por si tardas
const SIM_BACK_MS = 10 * 60_000
if (new URLSearchParams(location.search).get('connect') === 'sim') {
	const q = new URLSearchParams(location.search)
	q.delete('connect')
	history.replaceState(null, '', `${location.pathname}${q.toString() ? `?${q}` : ''}${location.hash}`)
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
// La web y el simulador mandan aquí para Pro (?pro=open): sin cuenta conectada se pide conectarla y, en cuanto lo
// está, se abre la ventana de Pro. Se recuerda un rato en esta pestaña por si tardas en crear el token
const PRO_WANT_MS = 30 * 60_000
if (new URLSearchParams(location.search).get('pro') === 'open') {
	const q = new URLSearchParams(location.search)
	q.delete('pro')
	history.replaceState(null, '', `${location.pathname}${q.toString() ? `?${q}` : ''}${location.hash}`)
	try {
		sessionStorage.setItem('tp.wantPro', String(Date.now()))
	} catch {}
}
const wantsPro = () => {
	try {
		return Date.now() - Number(sessionStorage.getItem('tp.wantPro') ?? 0) < PRO_WANT_MS
	} catch {
		return false
	}
}
let proConnectShown = false
const CHECKOUT_POLL_MS = 6000
const CHECKOUT_MAX_MS = 60 * 60_000
const RENEW_SOON_MS = 5 * 86_400_000
let proPolling = null

async function proFetch(path, body, again = true) {
	const r = await fetch(path, body === undefined ? { cache: 'no-store' } : { method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
	const d = await r.json().catch(() => ({}))
	// El servidor no sabe de quién es el token: la cookie que lo dice es una por navegador y, con otra cuenta en otra
	// pestaña, puede ser de aquella. Pedir el perfil a QvaPay la deja con esta cuenta; se reintenta una vez
	if (r.status === 403 && d.code === 'TP_WHO' && again && bk.acct.connected) return api('/me').then(() => proFetch(path, body, false))
	if (!r.ok) throw Object.assign(new Error(d.error || tl('pro.genericError')), { status: r.status })
	return d
}
const daysLeft = () => Math.max(0, Math.ceil((pro.expiresAt - Date.now()) / 86_400_000))
const daysText = (n) => tl('pro.days', { n })
// A 3 días o menos del fin (y hasta una semana después de acabarse), un aviso que se queda a la vista con el botón de
// comprar días. Muchos no conectan Telegram: sin esto, nadie les decía que se les acababa. Se cierra hasta mañana
// (antes del fin) o para siempre (ya acabado). Y a quien usa mucho el terminal sin haber probado Pro, la invitación a
// sus días gratis
const NUDGE_MS = 3 * 86_400_000
function renderProNudge() {
	document.getElementById('proNudge')?.remove()
	if (!pro.enabled) return
	const today = new Date().toDateString()
	let key, html
	let buy = tl('pro.buyDays')
	if (pro.active && pro.expiresAt - Date.now() <= NUDGE_MS) {
		key = `left:${pro.expiresAt}:${today}`
		const n = daysLeft()
		const what = tl(pro.plan === 'trial' ? 'pro.nudgeTrialLeft' : 'pro.nudgeLeft', { n, days: daysText(n) })
		html = `<b>⏳ ${what}</b><span>${tl('pro.nudgeUntil', { date: proDate(pro.expiresAt) })}</span>`
	} else if (!pro.active && pro.ended) {
		key = `ended:${pro.ended.at}`
		html = `<b>🔔 ${tl(pro.ended.plan === 'trial' ? 'pro.trialEnded' : 'pro.proEnded')}</b><span>${tl('pro.endedOn', { date: proDate(pro.ended.at) })}</span>`
	} else if (!pro.active && pro.canTrial && pro.usage) {
		// Lo usa mucho y nunca probó Pro: la invitación, una vez por semana si la cierra
		key = `try:${Math.floor(Date.now() / (7 * 86_400_000))}`
		buy = tl('pro.tryFreeDays', { n: proTrialDays })
		html = `<b>${tl('pro.usage', { hours: pro.usage.hours, days: daysText(pro.usage.days) })}</b><span>${tl('pro.usageSub', { n: proTrialDays })}</span>`
	} else return
	if (store.getMine('pro.nudgeClosed', '') === key) return
	const el = document.createElement('div')
	el.id = 'proNudge'
	el.className = 'pro-nudge'
	el.setAttribute('role', 'status')
	el.innerHTML = `<div class="pro-nudge-text">${html}</div><button class="btn primary sm" data-nudge="buy">${buy}</button><button class="icon-btn small" data-nudge="close" title="${tl('common.close')}" aria-label="${tl('common.close')}">✕</button>`
	el.addEventListener('click', (e) => {
		const b = e.target.closest('[data-nudge]')
		if (!b) return
		store.setMine('pro.nudgeClosed', key)
		el.remove()
		if (b.dataset.nudge === 'buy') showPro()
	})
	document.body.append(el)
}
const proDate = (ms) => cubaFmt(ms, { day: 'numeric', month: 'long', year: 'numeric' })

function applyPro(s) {
	// Tenía el módulo Pro cargado y ya no tiene Pro (se le acabaron los días, suspendida, bloqueada o desconectó):
	// se recarga para que la orden inteligente y el radar desaparezcan de la memoria
	if (pro.loaded && !s.pro) return location.reload()
	// Bloqueada desde el panel: Pro ni se ofrece
	Object.assign(pro, { enabled: s.enabled === true && !s.blocked, active: !!s.pro, canTrial: !s.pro && s.canTrial === true, trialUsed: !s.pro && s.trialUsed === true, username: s.username ?? null, plan: s.plan ?? null, expiresAt: s.expiresAt ?? null, license: s.license ?? null, ended: !s.pro && s.ended?.at ? s.ended : null, usage: !s.pro && s.canTrial && s.usage?.hours ? s.usage : null })
	if (Array.isArray(s.plans)) proPlans = s.plans
	if (s.trialDays > 0) proTrialDays = s.trialDays

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
		} else if (wantsPro() && !proConnectShown && typeof showConnect === 'function') {
			proConnectShown = true
			showConnect(tl('pro.connectToTry'))
		}
		return applyPro({ pro: false })
	}
	try {
		pro.print = (await api('/print')).print
		if (!pro.print) return applyPro({ pro: false })
		// Además de decir si eres Pro, deja la sesión compartida con el simulador y dice si aún puedes activar
		// tus días gratis (no empiezan solos: los activas tú desde ★)
		let s = await proFetch('/pro/status', { print: pro.print })
		// Sin Pro y sin saber de quién es el token (ver proFetch): con el perfil al día, otra vez
		if (!s.pro && !s.canTrial && !s.trialUsed && !s.blocked && s.enabled) {
			await api('/me').catch(() => {})
			s = await proFetch('/pro/status', { print: pro.print })
		}
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
		if (pro.active && pro.expiresAt - Date.now() < RENEW_SOON_MS && pro.expiresAt - Date.now() > NUDGE_MS && store.getMine('pro.renewTold', '') !== new Date().toDateString()) {
			store.setMine('pro.renewTold', new Date().toDateString())
			toast(tl('pro.renewToast', { days: daysText(daysLeft()) }))
		}
		renderProNudge()
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
	b.innerHTML = `<span aria-hidden="true">★</span><span class="pro-label">${pro.active ? daysText(daysLeft()) : pro.canTrial ? tl('pro.chipTry') : 'Pro'}</span>`
	// El radar es del módulo Pro (TPProRadar) y el análisis, de analysis.js; sin Pro, sus botones abren la ventana de Pro
	const r = $('radarBtn')
	if (r) r.hidden = b.hidden
	const an = document.querySelector('.an-open')
	if (an) an.hidden = b.hidden
	b.title = pro.active ? tl('pro.chipActive', { days: daysText(daysLeft()), date: proDate(pro.expiresAt) }) : pro.canTrial ? tl('pro.chipTrial', { n: proTrialDays }) : tl('pro.mode')
}

// ── Ventana Pro ──────────────────────────────────────────────────────
// Con días comprados solo se compran más cuando quedan pocos (el servidor también lo exige); con los gratis o regalados, siempre
const canRenew = () => !pro.active || pro.plan === 'trial' || pro.plan === 'gift' || pro.expiresAt - Date.now() <= RENEW_SOON_MS

function showPro() {
	if (!bk.acct.connected) return toast(tl('pro.connectFirst'), true)
	const feats = `${PRO_FEATURES.map(([i, t, d]) => `<li><span class="pro-ic">${i}</span><div><b>${t}</b><p class="muted">${d}</p></div></li>`).join('')}<li class="pro-more-link"><a class="link" href="${PRO_INFO_URL}" target="_blank" rel="noopener">${tl('pro.learnMore')}</a></li>`
	const plans = proPlans.map((p) => `<button class="pro-plan" data-plan="${esc(p.id)}"><b>${esc(p.name)}</b><span class="mono">${usdText(p.usd)}</span><small>${tl('pro.perDay', { usd: usdText(p.usd / p.days) })}</small></button>`).join('')
	const refund = NO_REFUNDS
	openModal(
		pro.active
			? `<div class="stack pro-box"><h3>${tl('pro.daysLeft', { days: daysText(daysLeft()) })}</h3>
				<p class="muted">@${esc(pro.username)} · ${{ trial: tl('pro.planTrial'), gift: tl('pro.planGift') }[pro.plan] ?? tl('pro.planBought')} · ${tl('pro.until', { date: proDate(pro.expiresAt) })}</p>
				<ul class="pro-feats">${feats}</ul>
				${
					canRenew()
						? `<p class="hint">${tl('pro.allDevices')}</p><div class="pro-plans">${plans}</div><p class="hint">${tl('pro.payWith', { refund })}</p>`
						: `<p class="hint">${tl('pro.renewFrom', { date: proDate(pro.expiresAt - RENEW_SOON_MS) })}</p>`
				}</div>`
			: pro.canTrial
				? `<div class="stack pro-box"><h3>${tl('pro.tryTitle', { n: proTrialDays })}</h3>
				<ul class="pro-feats">${feats}</ul>
				<button class="btn primary block" id="proTrial">${tl('pro.activateTrial', { n: proTrialDays })}</button>
				<p class="hint">${tl('pro.trialHint')}</p>
				<details class="pro-more"><summary>${tl('pro.preferBuy')}</summary><div class="pro-plans">${plans}</div><p class="hint">${tl('pro.payWithShort', { refund })}</p></details></div>`
				: `<div class="stack pro-box"><h3>★ ${tl('pro.mode')}</h3>
				<ul class="pro-feats">${feats}</ul>
				<p class="muted">${pro.trialUsed ? tl('pro.trialUsed', { n: proTrialDays }) : ''}${tl('pro.buyProDays')}</p>
				<div class="pro-plans">${plans}</div>
				<p class="hint">${tl('pro.payWithLong', { refund })}</p></div>`,
	)
	for (const b of $('modalBody').querySelectorAll('[data-plan]')) b.onclick = () => startCheckout(b.dataset.plan)
	$('proTrial')?.addEventListener('click', startTrial)
}

// Los días gratis empiezan cuando el usuario los activa
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

// Recién activados los días gratis
function showFreeDays() {
	openModal(`<div class="stack pro-box"><h3>${tl('pro.trialOn', { n: proTrialDays })}</h3>
		<p class="muted">${tl('pro.trialOnSub', { date: proDate(pro.expiresAt) })}</p>
		<button class="btn primary block" id="proOk">${tl('pro.done')}</button></div>`)
	$('proOk').onclick = closeModal
}

async function startCheckout(plan) {
	try {
		const c = await proFetch('/pro/checkout', { print: pro.print, plan })
		store.setMine('pro.checkout', { id: c.id, url: c.url, at: Date.now() })
		window.open(c.url, '_blank', 'noopener')
		showWaiting()
	} catch (e) {
		toast(e.message, true)
	}
}

function showWaiting() {
	const c = store.getMine('pro.checkout', null)
	if (!c) return
	openModal(`<div class="stack pro-box"><h3>${tl('pro.waiting')}</h3>
		<p class="muted">${tl('pro.waitingSub')}</p>
		<a class="btn primary block" href="${esc(c.url)}" target="_blank" rel="noopener">${tl('pro.openPay')}</a>
		<p class="hint" id="proWait">${tl('pro.checking')}</p>
		<p class="hint">${tl('pro.paidNotActive')}</p></div>`)
	pollCheckout()
}

// Comprueba la factura hasta que QvaPay la confirme (también si vuelves más tarde a la página)
function pollCheckout() {
	if (proPolling) return
	const tick = async () => {
		const c = store.getMine('pro.checkout', null)
		if (!c || Date.now() - c.at > CHECKOUT_MAX_MS) {
			proPolling = null
			store.setMine('pro.checkout', null)
			return
		}
		try {
			const r = await proFetch('/pro/checkout/status', { id: c.id, print: pro.print })
			if (r.status === 'paid') {
				proPolling = null
				store.setMine('pro.checkout', null)
				applyPro(r)
				return showWelcome()
			}
			if (r.status === 'expired') {
				proPolling = null
				store.setMine('pro.checkout', null)
				if ($('proWait')) $('proWait').textContent = tl('pro.invoiceExpired')
				return
			}
		} catch (e) {
			// Ese pago no existe o es de otro token (cambiaste de cuenta): se deja de preguntar. Si llegara a pagarse,
			// los días van igual a la cuenta que lo pagó
			if (e.status === 404) {
				proPolling = null
				store.setMine('pro.checkout', null)
				return
			}
		}
		proPolling = setTimeout(tick, CHECKOUT_POLL_MS)
	}
	proPolling = setTimeout(tick, 0)
}

function resumeCheckout() {
	const q = new URLSearchParams(location.search)
	const back = q.get('pro')
	if (back) {
		q.delete('pro')
		history.replaceState(null, '', `${location.pathname}${q.toString() ? `?${q}` : ''}${location.hash}`)
	}
	if (!pro.enabled) return
	// Venías de la web o del simulador para hacerte Pro
	if (wantsPro()) {
		try {
			sessionStorage.removeItem('tp.wantPro')
		} catch {}
		return showPro()
	}
	if (back === 'cancel') {
		store.setMine('pro.checkout', null)
		return toast(tl('pro.payCancelled'))
	}
	if (store.getMine('pro.checkout', null)) back === 'ok' && $('modal').hidden ? showWaiting() : pollCheckout()
}

function showWelcome() {
	openModal(`<div class="stack pro-box"><h3>${tl('pro.added')}</h3>
		<p class="muted">${tl('pro.addedSub', { days: daysText(daysLeft()), date: proDate(pro.expiresAt) })}</p>
		<button class="btn primary block" id="proOk">${tl('pro.done')}</button></div>`)
	$('proOk').onclick = closeModal
}

document.addEventListener('click', (e) => e.target.closest('#proBtn') && showPro())
document.addEventListener('click', (e) => e.target.closest('#radarBtn') && (pro.active && window.TPProRadar ? window.TPProRadar.open() : showPro()))
// Cada 5 minutos y al volver a la pestaña: si se apaga o enciende Pro en el panel, o se te acaban los días, se
// nota sin recargar (y la licencia firmada de un día se renueva sola)
// Con Pro activo también con la pestaña oculta: el radar y el precio automático siguen trabajando en segundo plano y
// tienen que parar si te quitan los días (devolución, suspensión)
setInterval(() => (!document.hidden || pro.active) && bk.acct.connected && refreshPro(), 5 * 60_000)
// Al acabarse los días se para al momento, sin esperar a esa consulta: el radar y el precio automático miran pro.active
setInterval(() => {
	if (pro.active && pro.expiresAt && Date.now() >= pro.expiresAt) {
		pro.active = false
		if (bk.acct.connected) refreshPro()
	}
}, 15_000)
document.addEventListener('visibilitychange', () => !document.hidden && bk.acct.connected && refreshPro())
// La cuenta ya se leyó antes de cargar este archivo (pasa sin token): lo que loadAccount no pudo llamar
if (bk.acctReady) refreshPro()
