// Broker no custodio — interfaz. Usa los helpers de app.js ($, state, fmtP, fmtU, esc, store, pct).

const bk = {
	acct: { connected: false, dryRun: true },
	tab: 'active',
	trades: [],
	openOffers: [],
	detail: null, // { offer, order }
	alerts: store.get('alerts', false), // notificaciones y sonido activados
}
const BASE_TITLE = document.title

const STATUS = {
	open: 'Publicada',
	processing: 'Esperando pago',
	paid: 'Pagado',
	revision: 'En disputa',
	completed: 'Completada',
	cancelled: 'Cancelada',
}

// ── API ───────────────────────────────────────────────────────────────
async function api(path, body) {
	const opts = body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Broker': '1' }, body: JSON.stringify(body) }
	const r = await TPApi.fetch(`/api/broker${path}`, opts)
	const data = await r.json().catch(() => ({}))
	if (!r.ok) throw Object.assign(new Error(data.error || `Error ${r.status}`), { status: r.status })
	return data
}

function toast(text, bad = false) {
	const el = document.createElement('div')
	el.className = `toast ${bad ? 'bad' : ''}`
	el.textContent = text
	document.body.appendChild(el)
	setTimeout(() => el.remove(), 4200)
}

const unitOf = (tick) => state.overview.find((c) => c.tick === tick)?.unit ?? state.book?.coin?.unit ?? ''
const nameOf = (tick) => state.overview.find((c) => c.tick === tick)?.name ?? tick

// ── Modal ─────────────────────────────────────────────────────────────
let onModalClose = null
function openModal(html, onClose) {
	$('modalBody').innerHTML = html
	$('modal').hidden = false
	onModalClose = onClose ?? null
}
function closeModal() {
	$('modal').hidden = true
	$('modalBody').innerHTML = ''
	bk.detail = null
	onModalClose?.()
	onModalClose = null
}

function confirmDialog(title, html, okText, cls = 'primary') {
	return new Promise((resolve) => {
		openModal(
			`<div class="stack"><h3>${title}</h3><div>${html}</div>
			<div class="row-btns"><button class="btn" data-c="no">Volver</button><button class="btn ${cls}" data-c="ok">${okText}</button></div></div>`,
			() => resolve(false),
		)
		$('modalBody').querySelector('[data-c="ok"]').onclick = () => {
			onModalClose = null
			closeModal()
			resolve(true)
		}
		$('modalBody').querySelector('[data-c="no"]').onclick = () => closeModal()
	})
}

// ── Cuenta ────────────────────────────────────────────────────────────
async function loadAccount() {
	try {
		bk.acct = await api('/me')
	} catch {
		bk.acct = { connected: false, dryRun: true }
	}
	renderAccount()
	if (bk.acct.connected) loadTrades()
	else renderTrades()
}

function renderAccount() {
	const a = bk.acct
	$('account').innerHTML = a.connected
		? `${a.dryRun ? '<span class="badge warn" title="Modo simulación: no se envía nada a QvaPay">Simulación</span>' : ''}
			<div class="acct">
				<span class="avatar" aria-hidden="true">${esc((a.username ?? '?').slice(0, 2))}</span>
				<div><div class="acct-name">@${esc(a.username)}${a.gold ? ' <span class="badge warn">GOLD</span>' : ''}</div><div class="acct-bal">${fmtU(a.balance ?? 0)} USD</div></div>
				<button class="icon-btn small" id="disconnectBtn" title="Desconectar cuenta" aria-label="Desconectar cuenta">
					<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path d="M15 4h3a2 2 0 012 2v12a2 2 0 01-2 2h-3M10 17l5-5-5-5M15 12H4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
				</button>
			</div>`
		: `<button class="btn primary" id="connectBtn">Conectar<span class="hide-sm">&nbsp;QvaPay</span></button>`
	$('connectBtn')?.addEventListener('click', showConnect)
	$('disconnectBtn')?.addEventListener('click', async () => {
		if (!(await confirmDialog('Desconectar cuenta', '<p class="muted">Se borra el token de este navegador. Tus operaciones en QvaPay no se tocan.</p>', 'Desconectar', 'danger'))) return
		await api('/disconnect', {}).catch(() => {})
		loadAccount()
	})
}

function showConnect() {
	openModal(`<div class="stack">
		<h3>Conectar tu cuenta de QvaPay</h3>
		<p class="muted">Operas con tu propia cuenta: el dinero sigue en el escrow de QvaPay, nunca pasa por aquí.</p>
		<div class="notice">
			Crea un token en <b>qvapay.com/dev/tokens</b> con estos permisos:
			<ul><li><b>read</b> (para ver tu usuario y saldo)</li><li><b>p2p:buy</b> para comprar USD</li><li><b>p2p:sell</b> solo si también vas a vender</li></ul>
		</div>
		<div class="notice warn">No marques <b>transfer</b> ni <b>withdraw</b>, y nunca pegues el token de tu sesión de login.</div>
		<label class="field">Token de API<input class="input" id="tokenInput" type="password" autocomplete="off" placeholder="12345|abcdef…" /></label>
		<label class="check"><input type="checkbox" id="rememberToken" /> Recordar en este navegador</label>
		<p class="hint">Tu token se guarda <strong>solo en este navegador</strong>, nunca en un servidor, y solo se usa para tu cuenta. Sin "recordar" se borra al cerrar la pestaña. Puedes revocar el token en QvaPay cuando quieras.</p>
		<button class="btn primary block" id="doConnect">Conectar</button>
	</div>`)
	$('tokenInput').focus()
	$('doConnect').onclick = async () => {
		const btn = $('doConnect')
		btn.disabled = true
		btn.textContent = 'Comprobando…'
		try {
			const r = await api('/connect', { token: $('tokenInput').value, remember: $('rememberToken').checked })
			closeModal()
			toast(`Conectado como @${r.username}`)
			loadAccount()
			setTimeout(loadBook, 4500)
		} catch (e) {
			btn.disabled = false
			btn.textContent = 'Conectar'
			toast(e.message, true)
		}
	}
}

// ── Mis operaciones ───────────────────────────────────────────────────
async function loadTrades() {
	if (!bk.acct.connected) return
	try {
		const r = await api('/trades')
		bk.trades = r.trades
		bk.openOffers = r.openOffers
		document.title = r.pending ? `(${r.pending}) ${BASE_TITLE}` : BASE_TITLE
		deliver(r.alerts ?? [])
	} catch (e) {
		bk.trades = []
		bk.openOffers = []
		// La sesión ya no tiene cuenta (token revocado o desconectado en el servidor)
		if (e.status === 401) return loadAccount()
		$('myTrades').innerHTML = `<p class="empty">${esc(e.message)}</p>`
		return
	}
	renderTrades()
}

const NEXT = {
	pay: ['Te toca pagar', true],
	wait_payment: ['Esperando que te paguen', false],
	release: ['Te pagaron: comprueba y libera', true],
	wait_release: ['Esperando que liberen', false],
	wait_moderator: ['Un moderador revisa la disputa', false],
	rate: ['Califica a la contraparte', false],
}

function renderTrades() {
	const active = bk.trades.filter((t) => t.status !== 'completed')
	const done = bk.trades.filter((t) => t.status === 'completed')
	const badge = (id, n) => {
		$(id).hidden = !n
		$(id).textContent = String(n)
	}
	badge('cntActive', bk.acct.connected ? active.length : 0)
	badge('cntOffers', bk.acct.connected ? bk.openOffers.length : 0)
	badge('cntView', bk.acct.connected ? active.length : 0)
	for (const t of document.querySelectorAll('#ordersTabs [data-tab]')) t.classList.toggle('active', t.dataset.tab === bk.tab)

	if (!bk.acct.connected) {
		$('myTrades').innerHTML =
			'<div class="empty">Conecta tu cuenta de QvaPay para seguir aquí tus operaciones P2P.</div>'
		return
	}

	const side = (t) => `<span class="side-${t.side}">${t.side === 'buy' ? 'Compra' : 'Venta'}</span>`
	const who = (t) => (t.counterparty ? `@${esc(t.counterparty.username)} <span class="muted">· ${t.counterparty.ops} ops</span>` : '<span class="muted">—</span>')
	const head = (cols) => `<thead><tr>${cols.map(([c, cls]) => `<th class="${cls ?? ''}">${c}</th>`).join('')}</tr></thead>`
	const common = [['Lado'], ['Mercado'], ['USD', 'r'], ['Precio', 'r'], ['Total', 'r']]

	let html = ''
	if (bk.tab === 'active') {
		html = active.length
			? `<table class="otable">${head([...common, ['Contraparte'], ['Estado'], ['Siguiente paso']])}<tbody>${active
					.map((t) => {
						const next = t.actions.map((a) => NEXT[a]).find(Boolean)
						const clock = t.status === 'processing' && t.expiresAt ? `<span class="countdown" data-expires="${esc(t.expiresAt)}" title="Plazo de pago"></span>` : ''
						return `<tr data-offer="${t.offerUuid}" data-order="${t.order ?? ''}">
							<td>${side(t)}</td><td>${esc(nameOf(t.coin))}</td>
							<td class="r num">${fmtU(t.usd)}</td><td class="r num">${fmtP(t.price)}</td><td class="r num">${fmtU(t.coinAmount)} ${esc(unitOf(t.coin))}</td>
							<td>${who(t)}</td><td><span class="chip ${t.status}">${STATUS[t.status] ?? t.status}</span></td>
							<td class="next ${next?.[1] ? 'act' : ''}">${next ? next[0] : '—'}${clock}</td></tr>`
					})
					.join('')}</tbody></table>`
			: '<div class="empty">No tienes operaciones en curso.</div>'
	} else if (bk.tab === 'offers') {
		html = bk.openOffers.length
			? `<table class="otable">${head([...common, ['Publicada'], ['', 'r']])}<tbody>${bk.openOffers
					.map(
						(o) => `<tr data-offer="${o.offerUuid}">
							<td>${side(o)}</td><td>${esc(nameOf(o.coin))}</td>
							<td class="r num">${fmtU(o.usd)}</td><td class="r num">${fmtP(o.price)}</td><td class="r num">${fmtU(o.coinAmount)} ${esc(unitOf(o.coin))}</td>
							<td class="muted">${o.updatedAt ? new Date(o.updatedAt).toLocaleString('es', { dateStyle: 'short', timeStyle: 'short' }) : '—'}</td>
							<td class="r"><button class="btn danger sm" data-cancel-btn="${o.offerUuid}">Cancelar</button></td></tr>`,
					)
					.join('')}</tbody></table>`
			: '<div class="empty">No tienes ofertas publicadas.</div>'
	} else {
		html = done.length
			? `<table class="otable">${head([...common, ['Contraparte'], ['Fecha']])}<tbody>${done
					.map(
						(t) => `<tr data-offer="${t.offerUuid}" data-order="${t.order ?? ''}">
							<td>${side(t)}</td><td>${esc(nameOf(t.coin))}</td>
							<td class="r num">${fmtU(t.usd)}</td><td class="r num">${fmtP(t.price)}</td><td class="r num">${fmtU(t.coinAmount)} ${esc(unitOf(t.coin))}</td>
							<td>${who(t)}</td><td class="muted">${t.updatedAt ? new Date(t.updatedAt).toLocaleString('es', { dateStyle: 'short', timeStyle: 'short' }) : '—'}</td></tr>`,
					)
					.join('')}</tbody></table>`
			: '<div class="empty">Aún no hay operaciones completadas.</div>'
	}
	$('myTrades').innerHTML = html
	tickClocks()
}

// ── Detalle de una operación ──────────────────────────────────────────
async function openTrade(offer, order) {
	bk.detail = { offer, order }
	openModal('<p class="muted">Cargando operación…</p>')
	await refreshDetail()
}

async function refreshDetail() {
	const d = bk.detail
	if (!d) return
	let t
	try {
		t = await api(`/trade?offer=${d.offer}${d.order ? `&order=${d.order}` : ''}`)
	} catch (e) {
		$('modalBody').innerHTML = `<p class="empty">${esc(e.message)}</p>`
		return
	}
	if (!bk.detail || bk.detail.offer !== d.offer) return
	// El refresco periódico no debe borrar lo que el usuario está escribiendo
	const keep = { txRef: $('txRef')?.value, chatInput: $('chatInput')?.value, seenMoney: $('seenMoney')?.checked }
	renderDetail(t)
	if (keep.txRef && $('txRef')) $('txRef').value = keep.txRef
	if (keep.chatInput && $('chatInput')) $('chatInput').value = keep.chatInput
	if (keep.seenMoney && $('seenMoney')) {
		$('seenMoney').checked = true
		$('modalBody').querySelector('[data-act="release"]').disabled = false
	}
}

function renderDetail(t) {
	const d = bk.detail
	const summary = bk.trades.find((x) => x.offerUuid === d.offer && (x.order ?? '') === (d.order ?? ''))
	const buy = summary ? summary.side === 'buy' : t.isOwner === (t.type === 'buy')
	const payer = buy
	const unit = unitOf(t.coin)
	const status = t.status
	const clock = t.expiresAt ? `<span class="countdown" data-expires="${esc(t.expiresAt)}"></span>` : ''
	// Si compro tomando una venta ajena, pago a los datos del creador
	const payTo = payer && !t.isOwner ? t.ownerDetails : []
	const needSendDetails = !payer && !t.isOwner && status === 'processing'

	let action = ''
	if (status === 'processing' && payer)
		action = `<div class="stack">
			<p>Transfiere <b>${fmtU(t.coinAmount)} ${unit}</b> y marca el pago con la referencia.${clock ? ` Plazo para pagar: ${clock}` : ''}</p>
			<label class="field">Referencia de tu transferencia<input class="input" id="txRef" placeholder="Nº de transacción" /></label>
			<div class="row-btns"><button class="btn danger" data-act="cancel">Cancelar</button><button class="btn primary" data-act="paid">Ya pagué</button></div></div>`
	else if (status === 'processing')
		action = `<p>Esperando que @${esc(t.counterparty)} te pague <b>${fmtU(t.coinAmount)} ${unit}</b>.${clock ? ` Plazo para pagar: ${clock}` : ''}</p>
			${needSendDetails ? '<p class="notice">Envía tus datos de pago por el chat para que sepa a dónde transferir.</p>' : ''}`
	else if (status === 'paid' && !payer)
		action = `<div class="stack">
			<p>@${esc(t.counterparty)} marcó el pago${t.txId ? ` (ref. <b>${esc(t.txId)}</b>)` : ''}. <b>Comprueba en tu banco</b> que entraron <b>${fmtU(t.coinAmount)} ${unit}</b> antes de liberar.</p>
			<label class="check"><input type="checkbox" id="seenMoney" /> Vi el dinero en mi cuenta</label>
			<div class="row-btns"><button class="btn danger" data-act="dispute">No llegó: disputar</button><button class="btn buy" data-act="release" disabled>Liberar ${fmtU(t.usd)} USD</button></div></div>`
	else if (status === 'paid') action = `<p>Marcaste el pago. Esperando que @${esc(t.counterparty)} libere los USD.</p>`
	else if (status === 'revision') action = '<p>En disputa: un moderador revisa el chat. Sube aquí tus comprobantes.</p>'
	else if (status === 'completed')
		action = `<p>Operación completada. Califica a @${esc(t.counterparty)}:</p><div class="stars" role="group" aria-label="Calificación">${[1, 2, 3, 4, 5].map((n) => `<button data-rate="${n}" title="${n} de 5" aria-label="${n} de 5 estrellas">★</button>`).join('')}</div>`

	$('modalBody').innerHTML = `<div class="stack">
		<div><h3>${buy ? 'Compras' : 'Vendes'} ${fmtU(t.usd)} USD por ${fmtU(t.coinAmount)} ${unit}</h3>
			<p class="muted">${esc(nameOf(t.coin))} · @${esc(t.counterparty ?? '—')} · <span class="chip ${status}">${STATUS[status] ?? status}</span>${bk.acct.dryRun ? ' · <span class="badge warn">Simulación</span>' : ''}</p></div>
		${
			payTo.length
				? `<div><p class="hint">Datos de pago de @${esc(t.counterparty)}:</p><div class="kv">${payTo
						.map((x) => `<span>${esc(x.name)}</span><b>${esc(x.value)}</b><button class="copy" data-copy="${esc(x.value)}">Copiar</button>`)
						.join('')}<span>Monto</span><b>${fmtU(t.coinAmount)} ${unit}</b><button class="copy" data-copy="${t.coinAmount}">Copiar</button></div></div>`
				: ''
		}
		${action}
		<div><p class="hint">Chat</p><div class="chatbox" id="chatbox">${
			t.chat.length
				? t.chat
						.map(
							(m) =>
								`<div class="msg ${m.mine ? 'mine' : ''} ${m.moderator ? 'mod' : ''}">${esc(m.text ?? '')}${m.image ? ` <a href="${esc(m.image)}" target="_blank" rel="noopener">🖼</a>` : ''}<time>${new Date(m.at).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' })}</time></div>`,
						)
						.join('')
				: '<p class="muted small">Sin mensajes.</p>'
		}</div>
		<form class="chatform" id="chatform"><input class="input" id="chatInput" maxlength="599" placeholder="Escribe un mensaje…" /><button class="btn">Enviar</button></form></div>
		<p class="hint"><a class="link" href="https://www.qvapay.com/p2p/${t.offer}" target="_blank" rel="noopener">Abrir en QvaPay</a></p>
	</div>`
	const cb = $('chatbox')
	cb.scrollTop = cb.scrollHeight
	tickClocks()
	bindDetail(t)
}

function bindDetail(t) {
	const body = $('modalBody')
	const act = async (action, extra = {}) => {
		try {
			const r = await api('/trade/action', { offer: t.offer, order: t.order, action, ...extra })
			if (r.message) toast(r.message)
			await refreshDetail()
			loadTrades()
		} catch (e) {
			toast(e.message, true)
		}
	}
	for (const b of body.querySelectorAll('[data-copy]'))
		b.onclick = (e) => {
			e.preventDefault()
			navigator.clipboard?.writeText(b.dataset.copy)
			toast('Copiado')
		}
	const seen = $('seenMoney')
	if (seen) seen.onchange = () => (body.querySelector('[data-act="release"]').disabled = !seen.checked)
	for (const b of body.querySelectorAll('[data-act]'))
		b.onclick = async () => {
			const a = b.dataset.act
			if (a === 'paid') {
				const tx = $('txRef').value.trim()
				if (!tx) return toast('Pon la referencia de la transferencia', true)
				return act('paid', { txId: tx })
			}
			if (a === 'release') {
				if (!confirm(`¿Seguro? Liberar ${t.usd} USD es irreversible. Hazlo solo si viste el dinero en tu cuenta.`)) return
				return act('release')
			}
			if (a === 'dispute' && !confirm('Se abrirá una disputa y un moderador decidirá. ¿Continuar?')) return
			if (a === 'cancel' && !confirm('¿Cancelar la operación? Hazlo solo si todavía no pagaste.')) return
			return act(a)
		}
	for (const b of body.querySelectorAll('[data-rate]')) b.onclick = () => act('rate', { rating: Number(b.dataset.rate) })
	$('chatform').onsubmit = (e) => {
		e.preventDefault()
		const text = $('chatInput').value.trim()
		if (text) act('chat', { message: text })
	}
}

// ── Avisos ────────────────────────────────────────────────────────────
// Notificación del navegador (si la pestaña no está a la vista), sonido y aviso
// en la página. Los sucesos los detecta data.js comparando lecturas seguidas.
let audio = null

function renderAlertsBtn() {
	const b = $('alertsBtn')
	b.setAttribute('aria-pressed', String(bk.alerts))
	b.title = bk.alerts ? 'Avisos activados: pulsa para desactivarlos' : 'Activar avisos de tus operaciones'
}

async function toggleAlerts() {
	bk.alerts = !bk.alerts
	store.set('alerts', bk.alerts)
	renderAlertsBtn()
	if (!bk.alerts) return toast('Avisos desactivados')
	// El sonido necesita un gesto del usuario para poder sonar después
	try {
		audio ??= new AudioContext()
		await audio.resume()
	} catch {}
	let perm = 'Notification' in window ? Notification.permission : 'denied'
	if (perm === 'default') perm = await Notification.requestPermission().catch(() => 'denied')
	toast(
		perm === 'granted'
			? 'Avisos activados: te avisaremos aunque estés en otra pestaña'
			: 'Avisos activados con sonido. Para recibirlos en otra pestaña, permite las notificaciones del navegador',
	)
	beep(false)
}

function beep(urgent) {
	if (!audio) return
	try {
		const t = audio.currentTime
		const notes = urgent ? [880, 1175, 880] : [988, 1319]
		notes.forEach((f, i) => {
			const o = audio.createOscillator()
			const g = audio.createGain()
			o.frequency.value = f
			g.gain.setValueAtTime(0.0001, t + i * 0.16)
			g.gain.exponentialRampToValueAtTime(0.18, t + i * 0.16 + 0.02)
			g.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.16 + 0.14)
			o.connect(g).connect(audio.destination)
			o.start(t + i * 0.16)
			o.stop(t + i * 0.16 + 0.15)
		})
	} catch {}
}

function deliver(alerts) {
	if (!alerts.length) return
	for (const a of alerts) toast(`${a.title}. ${a.body}`)
	if (!bk.alerts) return
	beep(alerts.some((a) => a.urgent))
	const away = document.hidden || !document.hasFocus()
	if (!away || !('Notification' in window) || Notification.permission !== 'granted') return
	for (const a of alerts) {
		try {
			const n = new Notification(a.title, { body: a.body, tag: a.key, icon: '/favicon.svg', requireInteraction: a.urgent })
			n.onclick = () => {
				window.focus()
				n.close()
				openTrade(a.offer, a.order)
			}
		} catch {
			// Algunos navegadores móviles no permiten notificaciones sin service worker: quedan el sonido y el título
		}
	}
}

// ── Cuenta atrás del plazo de pago ────────────────────────────────────
function clockText(ms) {
	if (ms <= 0) return 'vencido'
	const s = Math.floor(ms / 1000)
	const h = Math.floor(s / 3600)
	const m = Math.floor((s % 3600) / 60)
	return h ? `${h} h ${String(m).padStart(2, '0')} min` : `${m}:${String(s % 60).padStart(2, '0')}`
}

function tickClocks() {
	const now = Date.now()
	for (const el of document.querySelectorAll('[data-expires]')) {
		const left = Date.parse(el.dataset.expires) - now
		el.textContent = clockText(left)
		el.classList.toggle('over', left <= 0)
		el.classList.toggle('low', left > 0 && left <= 5 * 60_000)
	}
}

// ── Eventos ───────────────────────────────────────────────────────────
function bindBroker() {
	$('modalX').onclick = closeModal
	$('modal').addEventListener('click', (e) => {
		if (e.target.id === 'modal') closeModal()
	})
	document.addEventListener('keydown', (e) => {
		if (e.key === 'Escape' && !$('modal').hidden) closeModal()
	})
	$('refreshTrades').onclick = loadTrades
	$('alertsBtn').onclick = toggleAlerts
	renderAlertsBtn()
	$('myTrades').addEventListener('click', async (e) => {
		const cancel = e.target.closest('[data-cancel-btn]')
		if (cancel) {
			e.stopPropagation()
			if (!(await confirmDialog('Cancelar oferta', '<p class="muted">Se retira del mercado y, si es de venta, tus USD vuelven a tu saldo.</p>', 'Cancelar oferta', 'danger'))) return
			try {
				const r = await api('/trade/action', { offer: cancel.dataset.cancelBtn, action: 'cancel_offer' })
				toast(r.message || 'Oferta cancelada')
				loadTrades()
			} catch (err) {
				toast(err.message, true)
			}
			return
		}
		const row = e.target.closest('tr[data-offer]')
		if (row && bk.tab !== 'offers') openTrade(row.dataset.offer, row.dataset.order || null)
	})
	for (const t of document.querySelectorAll('#ordersTabs [data-tab]'))
		t.addEventListener('click', () => {
			bk.tab = t.dataset.tab
			renderTrades()
		})
}

bindBroker()
loadAccount()
// Con la pestaña visible, cada 15 s. En segundo plano solo con los avisos activos
// y algo que vigilar (operaciones en curso u ofertas publicadas), cada 30 s
let tradeTicks = 0
setInterval(() => {
	tradeTicks++
	if (!bk.acct.connected) return
	if (!document.hidden) return loadTrades()
	const watching = bk.openOffers.length || bk.trades.some((t) => t.status !== 'completed')
	if (bk.alerts && watching && tradeTicks % 2 === 0) loadTrades()
}, 15_000)
setInterval(() => !document.hidden && tickClocks(), 1000)
setInterval(() => !document.hidden && bk.detail && refreshDetail(), 8_000)
