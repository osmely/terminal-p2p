// Plan Pro: si este dispositivo es Pro, comprar o renovar con QvaPay, añadir otro dispositivo y el código
// de respaldo. El token nunca sale del navegador: el servidor solo ve su huella, que calcula data.js.
// Quién pagó lo confirma QvaPay en el servidor. Las funciones Pro llegan en un módulo aparte (/pro/module.js)
'use strict'

const pro = { active: false, username: null, plan: null, expiresAt: null, license: null, print: null, loaded: false }
window.TPPro = pro

// El simulador del mismo entorno (sim.staging… desde app.staging…); en desarrollo, el de producción
const SIM_URL = /\.terminalp2p\.com$/.test(location.hostname) ? location.origin.replace('://app.', '://sim.') : 'https://sim.terminalp2p.com'

const PRO_PLANS = [
	['month', 'Mensual', '1,99 USD', 'al mes'],
	['year', 'Anual', '20 USD', 'al año · 2 meses gratis'],
]
const PRO_FEATURES = [
	['⚡', 'Orden inteligente', 'si tu precio ya cruza el libro, toma lo que hay a mejor precio y publica solo el resto, como en un exchange'],
	['📈', 'Todos los mercados del simulador', 'sin Pro, BTC y ETH; con Pro también SOL, XRP, BNB, DOGE, SUI, PEPE y TAO (sim.terminalp2p.com)'],
]
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
const proDate = (ms) => new Date(ms).toLocaleDateString('es', { day: 'numeric', month: 'long', year: 'numeric' })

function applyPro(s) {
	Object.assign(pro, { active: !!s.pro, username: s.username ?? null, plan: s.plan ?? null, expiresAt: s.expiresAt ?? null, license: s.license ?? null })
	// La huella con la que se es Pro se recuerda: si cambias de token, autoriza a la nueva
	if (pro.active) store.set('pro.print', pro.print)
	if (pro.active && !pro.loaded) {
		pro.loaded = true
		const s2 = document.createElement('script')
		s2.src = `/pro/module.js?l=${encodeURIComponent(pro.license)}`
		document.head.appendChild(s2)
	}
	renderProChip()
	document.dispatchEvent(new CustomEvent('tp:pro', { detail: pro }))
}

// Al conectar la cuenta (y cada pocas horas, para renovar la licencia firmada de un día)
async function refreshPro() {
	if (!bk.acct.connected) return applyPro({ pro: false })
	try {
		pro.print = (await api('/print')).print
		if (!pro.print) return applyPro({ pro: false })
		let s = await proFetch('/pro/status', { print: pro.print })
		const old = store.get('pro.print', null)
		if (!s.pro && old && old !== pro.print) s = await proFetch('/pro/rotate', { from: old, to: pro.print }).catch(() => ({ pro: false }))
		applyPro(s)
		if (pro.active && pro.expiresAt - Date.now() < RENEW_SOON_MS && store.get('pro.renewTold', '') !== new Date().toDateString()) {
			store.set('pro.renewTold', new Date().toDateString())
			toast(`Tu Pro vence el ${proDate(pro.expiresAt)}. Renuévalo desde el botón Pro.`)
		}
		resumeCheckout()
	} catch {
		// Sin conexión con el servidor no se pierde nada: se reintenta en la próxima revisión
	}
}

function renderProChip() {
	const b = $('proBtn')
	if (!b) return
	b.hidden = !bk.acct.connected
	b.classList.toggle('on', pro.active)
	b.innerHTML = `<span aria-hidden="true">★</span><span class="pro-label">${pro.active ? 'Pro' : 'Pro gratis'}</span>`
	b.title = pro.active ? `Pro hasta el ${proDate(pro.expiresAt)}` : 'Terminal P2P Pro'
}

// ── Ventana Pro ──────────────────────────────────────────────────────
// Siendo Pro solo se paga en los últimos días del plan (el servidor también lo exige); en el mes gratis, siempre
const canRenew = () => !pro.active || pro.plan === 'trial' || pro.expiresAt - Date.now() <= RENEW_SOON_MS

function showPro() {
	if (!bk.acct.connected) return toast('Conecta tu cuenta de QvaPay (arriba a la derecha) para hacerte Pro', true)
	const feats = PRO_FEATURES.map(([i, t, d]) => `<li><span class="pro-ic">${i}</span><div><b>${t}</b><p class="muted">${d}</p></div></li>`).join('')
	const plans = PRO_PLANS.map(([id, name, price, per]) => `<button class="pro-plan" data-plan="${id}"><b>${name}</b><span class="mono">${price}</span><small>${per}</small></button>`).join('')
	openModal(
		pro.active
			? `<div class="stack pro-box"><h3>★ ${pro.plan === 'trial' ? 'Tu mes gratis de Pro' : 'Eres Pro'}</h3>
				<p class="muted">@${esc(pro.username)} · ${{ trial: 'prueba gratis', year: 'plan anual', gift: 'plan regalado' }[pro.plan] ?? 'plan mensual'} · hasta el <b>${proDate(pro.expiresAt)}</b>${pro.plan === 'trial' ? '. Si te haces Pro antes, los días que te queden se suman.' : ''}</p>
				<ul class="pro-feats">${feats}</ul>
				<div class="row-btns"><button class="btn" id="proPair">Añadir dispositivo</button><button class="btn" id="proSim">Vincular simulador</button><button class="btn" id="proBackup">Código de respaldo</button></div>
				${
					canRenew()
						? `<p class="hint">Hasta 2 dispositivos a la vez. No se renueva solo: renovar suma el periodo a lo que te queda:</p><div class="pro-plans">${plans}</div>`
						: `<p class="hint">Hasta 2 dispositivos a la vez. No se renueva solo: podrás renovar desde el <b>${proDate(pro.expiresAt - RENEW_SOON_MS)}</b>.</p>`
				}</div>`
			: `<div class="stack pro-box"><h3>★ Terminal P2P Pro</h3>
				<ul class="pro-feats">${feats}</ul>
				<button class="btn primary block" id="proTrial">Probar 1 mes gratis</button>
				<div class="pro-plans">${plans}</div>
				<p class="hint">Pagas con tu saldo en QvaPay. Tu token no sale de este navegador. Sin renovación automática: cada pago lo haces tú. Si no te convence, te devolvemos el dinero en los 7 días siguientes al primer pago: escríbenos a <a class="link" href="https://t.me/terminalp2p" target="_blank" rel="noopener">@terminalp2p</a>.</p>
				<button class="link small" id="proClaim">Ya soy Pro en otro dispositivo</button></div>`,
	)
	for (const b of $('modalBody').querySelectorAll('[data-plan]')) b.onclick = () => startCheckout(b.dataset.plan)
	$('proPair')?.addEventListener('click', () => showPair())
	$('proSim')?.addEventListener('click', () => showPair(true))
	$('proBackup')?.addEventListener('click', showBackup)
	$('proClaim')?.addEventListener('click', showClaim)
	$('proTrial')?.addEventListener('click', startTrial)
}

// Primer mes gratis: una vez por usuario de QvaPay (el servidor lo comprueba)
async function startTrial() {
	try {
		applyPro(await proFetch('/pro/trial', { print: pro.print, username: bk.acct.username }))
		openModal(`<div class="stack pro-box"><h3>★ Tienes un mes de Pro gratis</h3>
			<p class="muted">Hasta el <b>${proDate(pro.expiresAt)}</b>. La orden inteligente ya está activa en este dispositivo. Para el simulador completo, usa <b>Pro › Vincular simulador</b>.</p>
			<button class="btn primary block" id="proOk">Listo</button></div>`)
		$('proOk').onclick = closeModal
	} catch (e) {
		toast(e.message, true)
	}
}

async function startCheckout(plan) {
	try {
		const c = await proFetch('/pro/checkout', { print: pro.print, plan, username: bk.acct.username })
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
				return showWelcome(r.backupCode)
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
	if (back === 'cancel') {
		store.set('pro.checkout', null)
		return toast('Pago cancelado: no se cobró nada')
	}
	if (store.get('pro.checkout', null)) back === 'ok' && $('modal').hidden ? showWaiting() : pollCheckout()
}

function backupHtml(code, title) {
	return `<div class="pro-code-box"><p class="muted">${title}</p><div class="pro-code mono">${esc(code)}</div>${copyBtn(code, 'código de respaldo')}</div>`
}

function showWelcome(backupCode) {
	openModal(`<div class="stack pro-box"><h3>★ ¡Ya eres Pro!</h3>
		<p class="muted">Hasta el <b>${proDate(pro.expiresAt)}</b>. Las funciones Pro ya están activas en este dispositivo.</p>
		${backupCode ? `${backupHtml(backupCode, 'Tu código de respaldo. Guárdalo: sirve para recuperar Pro si pierdes este dispositivo y cambias de token.')}` : ''}
		<button class="btn primary block" id="proOk">Listo</button></div>`)
	bindCopy($('modalBody'))
	$('proOk').onclick = closeModal
}

// El mismo código de 6 cifras sirve para otro dispositivo del terminal o para la cuenta del simulador
async function showPair(sim = false) {
	try {
		const { code, expiresAt } = await proFetch('/pro/pair', { print: pro.print })
		openModal(`<div class="stack pro-box"><h3>${sim ? 'Vincular simulador' : 'Añadir dispositivo'}</h3>
			<p class="muted">${
				sim
					? `En <a class="link" href="${SIM_URL}" target="_blank" rel="noopener">${new URL(SIM_URL).host}</a>, entra con Telegram, pulsa <b>★ Hazte Pro</b> y escribe este código en «¿Ya eres Pro?»:`
					: 'En el otro móvil u ordenador, conecta tu cuenta, pulsa <b>Hazte Pro</b> y luego <b>Ya soy Pro en otro dispositivo</b>. Escribe este código:'
			}</p>
			<div class="pro-code mono big">${code.slice(0, 3)} ${code.slice(3)}</div>
			<p class="hint">Caduca en <span class="countdown" data-expires="${new Date(expiresAt).toISOString()}"></span> y sirve una sola vez.</p></div>`)
		tickClocks()
	} catch (e) {
		toast(e.message, true)
	}
}

async function showBackup() {
	if (!(await confirmDialog('Código de respaldo', '<p class="muted">Se crea un código nuevo y el anterior deja de valer. Guárdalo en un sitio seguro.</p>', 'Crear código'))) return
	try {
		const { backupCode } = await proFetch('/pro/backup', { print: pro.print })
		openModal(`<div class="stack pro-box"><h3>Código de respaldo</h3>${backupHtml(backupCode, 'Sirve para activar Pro en un dispositivo nuevo si no tienes otro a mano. Cada vez que se usa, cambia.')}<button class="btn primary block" id="proOk">Listo</button></div>`)
		bindCopy($('modalBody'))
		$('proOk').onclick = closeModal
	} catch (e) {
		toast(e.message, true)
	}
}

function showClaim() {
	openModal(`<div class="stack pro-box"><h3>Ya soy Pro</h3>
		<p class="muted">Escribe el código de 6 cifras que te muestra tu otro dispositivo Pro (en <b>Pro › Añadir dispositivo</b>) o tu código de respaldo.</p>
		<label class="field">Código<input class="input mono" id="proCode" placeholder="482 913 o TP-XXXX-XXXX-XXXX" autocomplete="off" /></label>
		<button class="btn primary block" id="proGo">Activar Pro aquí</button></div>`)
	$('proGo').onclick = async () => {
		try {
			const r = await proFetch('/pro/claim', { print: pro.print, code: $('proCode').value })
			applyPro(r)
			if (r.backupCode)
				openModal(`<div class="stack pro-box"><h3>★ Pro activado</h3>${backupHtml(r.backupCode, 'Usaste tu código de respaldo, así que ahora tienes uno nuevo (el anterior ya no vale). Guárdalo:')}<button class="btn primary block" id="proOk">Listo</button></div>`)
			else openModal('<div class="stack pro-box"><h3>★ Pro activado</h3><p class="muted">Las funciones Pro ya están activas en este dispositivo.</p><button class="btn primary block" id="proOk">Listo</button></div>')
			bindCopy($('modalBody'))
			$('proOk').onclick = closeModal
		} catch (e) {
			toast(e.message, true)
		}
	}
}

document.addEventListener('click', (e) => e.target.closest('#proBtn') && showPro())
setInterval(() => !document.hidden && bk.acct.connected && refreshPro(), 6 * 3_600_000)
