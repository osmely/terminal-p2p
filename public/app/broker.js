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

// Un formulario con archivo (la imagen del chat): sin Content-Type, lo pone el navegador
async function apiForm(path, form) {
	const r = await TPApi.fetch(`/api/broker${path}`, { method: 'POST', headers: { 'X-Broker': '1' }, body: form })
	const data = await r.json().catch(() => ({}))
	if (!r.ok) throw Object.assign(new Error(data.error || `Error ${r.status}`), { status: r.status })
	return data
}

// Las imágenes del chat llegan como ruta de QvaPay (chat/123/456.jpg) y se sirven desde su dominio de archivos
const chatImageUrl = (img) => {
	const v = String(img ?? '')
	if (/^https:\/\/media\.qvapay\.com\//.test(v)) return v
	return /^[\w./-]+$/.test(v) && !v.includes('..') ? `https://media.qvapay.com/${v.replace(/^\//, '')}` : null
}

// Antes de enviarla, la imagen se reduce a 1280 px como mucho y a JPG (QvaPay la deja en 1000 × 1000 igualmente):
// una foto del móvil pasa de varios MB a unos cientos de KB. Un GIF pequeño va tal cual para no perder la animación
const CHAT_IMAGE_PX = 1280
async function shrinkImage(file) {
	if (file.type === 'image/gif' && file.size <= 2 * 1024 * 1024) return file
	const bmp = await createImageBitmap(file)
	const k = Math.min(1, CHAT_IMAGE_PX / Math.max(bmp.width, bmp.height))
	const canvas = document.createElement('canvas')
	canvas.width = Math.round(bmp.width * k)
	canvas.height = Math.round(bmp.height * k)
	const ctx = canvas.getContext('2d')
	// Fondo blanco: un PNG con transparencia no queda negro al pasar a JPG
	ctx.fillStyle = '#fff'
	ctx.fillRect(0, 0, canvas.width, canvas.height)
	ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height)
	bmp.close?.()
	return new Promise((ok, fail) => canvas.toBlob((b) => (b ? ok(b) : fail(new Error('No se pudo preparar la imagen'))), 'image/jpeg', 0.85))
}

function toast(text, bad = false) {
	const el = document.createElement('div')
	el.className = `toast ${bad ? 'bad' : ''}`
	el.textContent = text
	document.body.appendChild(el)
	setTimeout(() => el.remove(), 4200)
}

// Botón de copiar con icono de portapapeles (y una marca de hecho al copiar)
const ICON_COPY = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><rect x="8" y="8" width="12" height="13" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M16 8V5a2 2 0 00-2-2H6a2 2 0 00-2 2v11a2 2 0 002 2h2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>'
const ICON_DONE = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>'
const copyBtn = (value, label) => `<button class="copy" data-copy="${esc(value)}" title="Copiar ${esc(label)}" aria-label="Copiar ${esc(label)}">${ICON_COPY}</button>`

const unitOf = (tick) => state.overview.find((c) => c.tick === tick)?.unit ?? state.book?.coin?.unit ?? ''
const nameOf = (tick) => state.overview.find((c) => c.tick === tick)?.name ?? tick

// ── Modal ─────────────────────────────────────────────────────────────
let onModalClose = null
// Mientras se ejecuta una orden inteligente la ventana no se cierra ni se sustituye: lo que pase debe verse
let modalLocked = false
function openModal(html, onClose) {
	if (modalLocked) return toast('Espera a que termine la orden inteligente', true)
	$('modalBody').innerHTML = html
	$('modal').hidden = false
	onModalClose = onClose ?? null
}
function closeModal() {
	if (modalLocked) return toast('Espera a que termine la orden inteligente', true)
	document.querySelector('.confirm-layer')?.remove()
	$('modal').hidden = true
	$('modalBody').innerHTML = ''
	bk.detail = null
	onModalClose?.()
	onModalClose = null
}

// Confirmación encima del detalle abierto: no lo sustituye, así que al volver sigue igual.
// Va sobre la tarjeta y no dentro de #modalBody, para que el refresco periódico no la borre
function askConfirm(title, html, okText, cls = 'primary') {
	return new Promise((resolve) => {
		document.querySelector('.confirm-layer')?.remove()
		const layer = document.createElement('div')
		layer.className = 'confirm-layer'
		layer.setAttribute('role', 'alertdialog')
		layer.innerHTML = `<div class="confirm-box stack"><h3>${title}</h3><div>${html}</div>
			<div class="row-btns"><button class="btn" data-c="no">Volver</button><button class="btn ${cls}" data-c="ok">${okText}</button></div></div>`
		const done = (ok) => {
			layer.remove()
			resolve(ok)
		}
		layer.querySelector('[data-c="ok"]').onclick = () => done(true)
		layer.querySelector('[data-c="no"]').onclick = () => done(false)
		layer.addEventListener('click', (e) => e.target === layer && done(false))
		document.querySelector('.modal-card').appendChild(layer)
		layer.querySelector('[data-c="ok"]').focus()
	})
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
		balanceAt = Date.now()
	} catch {
		bk.acct = { connected: false, dryRun: true }
	}
	renderAccount()
	if (bk.acct.connected) {
		loadTrades()
		// Contador anónimo de cuentas conectadas por día (hit.js): sin usuario ni nada que lo identifique
		window.TPHit?.connected()
	} else renderTrades()
	if (typeof refreshPro === 'function') refreshPro()
}

// El saldo cambia fuera de esta pestaña: otra pestaña o la web de QvaPay publica una venta (los USD quedan
// reservados), alguien libera o te pagan. Se vuelve a pedir al volver a la pestaña, cada minuto con ella a la vista,
// al abrir «Publicar» o «Vender» y cuando cambian tus ofertas u operaciones
const BALANCE_MS = 60_000
let balanceAt = 0
let balanceBusy = false
async function refreshBalance(force = false) {
	if (!bk.acct.connected || balanceBusy || (!force && Date.now() - balanceAt < BALANCE_MS)) return
	balanceBusy = true
	try {
		const r = await api('/me')
		balanceAt = Date.now()
		// Otra cuenta o sin cuenta (token revocado o desconectado en otra pestaña): se recarga todo
		if (!r.connected || r.username !== bk.acct.username) return loadAccount()
		if (r.balance === bk.acct.balance) return
		bk.acct.balance = r.balance
		const el = document.querySelector('#account .acct-bal')
		if (el) el.textContent = `${fmtM(r.balance ?? 0)} USD`
		document.dispatchEvent(new Event('tp:balance'))
	} catch {
	} finally {
		balanceBusy = false
	}
}
document.addEventListener('visibilitychange', () => !document.hidden && refreshBalance(Date.now() - balanceAt > 5_000))

function renderAccount() {
	const a = bk.acct
	$('account').innerHTML = a.connected
		? `${a.dryRun ? '<span class="badge warn" title="Modo simulación: no se envía nada a QvaPay">Simulación</span>' : ''}
			<button class="pro-chip" id="proBtn" hidden></button>
			<div class="acct">
				<button type="button" class="acct-open" id="acctOpen" title="Mi cuenta">
					<span class="avatar" aria-hidden="true">${esc((a.username ?? '?').slice(0, 2))}</span>
					<div><div class="acct-name">@${esc(a.username)}${a.gold ? ' <span class="badge warn">GOLD</span>' : ''}</div><div class="acct-bal">${fmtM(a.balance ?? 0)} USD</div></div>
				</button>
				<button class="icon-btn small" id="disconnectBtn" title="Desconectar cuenta" aria-label="Desconectar cuenta">
					<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path d="M15 4h3a2 2 0 012 2v12a2 2 0 01-2 2h-3M10 17l5-5-5-5M15 12H4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
				</button>
			</div>`
		: `<button class="btn primary" id="connectBtn">Conectar<span class="hide-sm">QvaPay</span></button>`
	if (typeof renderProChip === 'function') renderProChip()
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
		<p class="ref-note">¿Aún no tienes cuenta? <a href="https://www.qvapay.com/register/osmelyf" target="_blank" rel="sponsored noopener">Crea una en QvaPay</a> <small>(usuario referido)</small></p>
		<div class="notice">
			Crea un token en <b>qvapay.com/dev/tokens</b> con estos permisos:
			<ul><li><b>read</b> (para ver tu usuario y saldo)</li><li><b>p2p:buy</b> para comprar USD</li><li><b>p2p:sell</b> solo si también vas a vender</li></ul>
			<a class="guide-link" href="https://terminalp2p.com/blog/conectar-qvapay-token/" target="_blank" rel="noopener">Guía paso a paso con capturas →</a>
		</div>
		<div class="notice warn">No marques <b>store</b>, <b>transfer</b> ni <b>withdraw</b>, y nunca pegues el token de tu sesión de login.</div>
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
// Una sola lectura a la vez: si QvaPay va lento, las siguientes no se acumulan en cola
let tradesBusy = false
async function loadTrades() {
	if (!bk.acct.connected || tradesBusy) return
	tradesBusy = true
	try {
		const r = await api('/trades')
		// Una oferta nueva o cancelada, o una operación que cambió de estado, mueve el saldo
		const sign = (trades, offers) => JSON.stringify([trades.map((t) => [t.id, t.status]), offers.map((o) => [o.offerUuid, o.usd, o.available])])
		const moved = bk.tradesSeen && sign(r.trades, r.openOffers) !== sign(bk.trades, bk.openOffers)
		bk.tradesSeen = true
		bk.trades = r.trades
		bk.openOffers = r.openOffers
		if (moved) refreshBalance(true)
		document.title = r.pending ? `(${r.pending}) ${BASE_TITLE}` : BASE_TITLE
		deliver(r.alerts ?? [])
	} catch (e) {
		// La sesión ya no tiene cuenta (token revocado o desconectado en el servidor)
		if (e.status === 401) {
			bk.trades = []
			bk.openOffers = []
			return loadAccount()
		}
		// Un fallo puntual (QvaPay lento, límite de peticiones) no borra lo que ya se veía: la próxima lectura lo pone al día
		if (!bk.tradesSeen) $('myTrades').innerHTML = `<p class="empty">${esc(e.message)}</p>`
		return
	} finally {
		tradesBusy = false
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
							<td class="c-side">${side(t)}</td><td class="c-mkt">${esc(nameOf(t.coin))}</td>
							<td class="r num c-usd" data-l="USD">${fmtM(t.usd)}</td><td class="r num c-price" data-l="Precio">${fmtP(t.price)}</td><td class="r num c-total" data-l="Total">${fmtM(t.coinAmount)} ${esc(unitOf(t.coin))}</td>
							<td class="c-who">${who(t)}</td><td class="c-status"><span class="chip ${t.status}">${STATUS[t.status] ?? t.status}</span></td>
							<td class="next c-next ${next?.[1] ? 'act' : ''}">${next ? next[0] : '—'}${clock}</td></tr>`
					})
					.join('')}</tbody></table>`
			: '<div class="empty">No tienes operaciones en curso.</div>'
	} else if (bk.tab === 'offers') {
		html = bk.openOffers.length
			? `<table class="otable">${head([...common, ['Estado'], ['Publicada'], ['', 'r']])}<tbody>${bk.openOffers
					.map(
						(o) => `<tr data-offer="${o.offerUuid}">
							<td class="c-side">${side(o)}</td><td class="c-mkt">${esc(nameOf(o.coin))}</td>
							<td class="r num c-usd" data-l="USD">${fmtM(o.kind === 'flexible' ? (o.available ?? o.usd) : o.usd)}</td><td class="r num c-price" data-l="Precio">${fmtP(o.price)}</td><td class="r num c-total" data-l="Total">${fmtM((o.kind === 'flexible' ? (o.available ?? o.usd) : o.usd) * o.price)} ${esc(unitOf(o.coin))}</td>
							<td class="c-status">${o.pause ? `<span class="chip revision" title="${esc(pauseText(o.pause))}">${o.pause.reason === 'taker_left' && o.pause.until ? `Pausada hasta ${new Date(o.pause.until).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' })}` : 'Pausada'}</span>` : '<span class="chip open">En el mercado</span>'}${o.kind === 'flexible' ? ' <span class="chip">Por partes</span>' : ''}${o.isPrivate ? ' <span class="chip">Privada</span>' : ''}</td>
							<td class="muted c-date">${o.updatedAt ? new Date(o.updatedAt).toLocaleString('es', { dateStyle: 'short', timeStyle: 'short' }) : '—'}</td>
							<td class="r c-act"><button class="btn danger sm" data-cancel-btn="${o.offerUuid}">Cancelar</button></td></tr>`,
					)
					.join('')}</tbody></table>`
			: '<div class="empty">No tienes ofertas publicadas. Usa «Publicar oferta» para crear una.</div>'
	} else {
		html = done.length
			? `<table class="otable">${head([...common, ['Contraparte'], ['Fecha']])}<tbody>${done
					.map(
						(t) => `<tr data-offer="${t.offerUuid}" data-order="${t.order ?? ''}">
							<td class="c-side">${side(t)}</td><td class="c-mkt">${esc(nameOf(t.coin))}</td>
							<td class="r num c-usd" data-l="USD">${fmtM(t.usd)}</td><td class="r num c-price" data-l="Precio">${fmtP(t.price)}</td><td class="r num c-total" data-l="Total">${fmtM(t.coinAmount)} ${esc(unitOf(t.coin))}</td>
							<td class="c-who">${who(t)}</td><td class="muted c-date">${t.updatedAt ? new Date(t.updatedAt).toLocaleString('es', { dateStyle: 'short', timeStyle: 'short' }) : '—'}</td></tr>`,
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

// La operación que se está cargando: abrir otra no espera a la anterior,
// pero el refresco periódico de la misma no se solapa
let detailLoading = null
async function refreshDetail() {
	const d = bk.detail
	if (!d || detailLoading === d) return
	detailLoading = d
	let t
	try {
		t = await api(`/trade?offer=${d.offer}${d.order ? `&order=${d.order}` : ''}`)
	} catch (e) {
		if (bk.detail === d) $('modalBody').innerHTML = `<p class="empty">${esc(e.message)}</p>`
		return
	} finally {
		if (detailLoading === d) detailLoading = null
	}
	// Mientras cargaba se abrió otra operación (u otra orden de la misma oferta)
	if (bk.detail !== d) return
	// El refresco periódico no debe borrar lo que el usuario está escribiendo ni moverle el scroll:
	// el chat sigue al final solo si ya estaba al final (si subió a leer, se queda donde estaba)
	const cb0 = $('chatbox')
	const chatAtEnd = !cb0 || bk.chatToEnd || cb0.scrollHeight - cb0.scrollTop - cb0.clientHeight < 40
	bk.chatToEnd = false
	const chatTop = cb0?.scrollTop ?? 0
	const modalTop = $('modal').scrollTop
	const keep = { txRef: $('txRef')?.value, chatInput: $('chatInput')?.value, seenMoney: $('seenMoney')?.checked }
	renderDetail(t)
	const cb = $('chatbox')
	if (cb) cb.scrollTop = chatAtEnd ? cb.scrollHeight : chatTop
	$('modal').scrollTop = modalTop
	if (keep.txRef && $('txRef')) {
		$('txRef').value = keep.txRef
		$('txRef').dispatchEvent(new Event('input')) // vuelve a activar "Ya pagué" si ya había referencia
	}
	if (keep.chatInput && $('chatInput')) $('chatInput').value = keep.chatInput
	const release = $('modalBody').querySelector('[data-act="release"]')
	if (keep.seenMoney && $('seenMoney') && release) {
		$('seenMoney').checked = true
		release.disabled = false
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
	// La oferta volvió a estar publicada y no es tuya: ya no participas en ella
	if (status === 'open' && !t.isOwner) {
		$('modalBody').innerHTML = `<div class="stack"><h3>Ya no participas en esta operación</h3>
			<p class="muted">Se canceló y la oferta de @${esc(t.counterparty ?? '—')} volvió al mercado.</p>
			<div class="row-btns"><button class="btn" id="gotIt">Cerrar</button></div></div>`
		$('gotIt').onclick = closeModal
		return
	}
	if (status === 'processing' && payer)
		action = `<div class="stack">
			<p>Transfiere <b>${fmtM(t.coinAmount)} ${unit}</b> y marca el pago con la referencia.</p>${clock ? `<p class="hint">Plazo para pagar ${clock}</p>` : ''}
			${t.isOwner ? `<p class="notice">@${esc(t.counterparty)} te pasará sus datos de pago por el chat.</p>` : ''}
			<label class="field">Referencia de tu transferencia<input class="input" id="txRef" placeholder="Nº de transacción" /></label>
			<div class="row-btns"><button class="btn danger" data-act="cancel">Cancelar</button><button class="btn primary" data-act="paid" disabled title="Escribe antes la referencia de tu transferencia">Ya pagué</button></div></div>`
	else if (status === 'processing')
		action = `<p>Esperando que @${esc(t.counterparty)} te pague <b>${fmtM(t.coinAmount)} ${unit}</b>.</p>${clock ? `<p class="hint">Plazo para pagar ${clock}</p>` : ''}
			${needSendDetails ? '<p class="notice">Envía tus datos de pago por el chat para que sepa a dónde transferir.</p>' : ''}`
	else if (status === 'paid' && !payer)
		action = `<div class="stack">
			<p>@${esc(t.counterparty)} marcó el pago${t.txId ? ` (ref. <b>${esc(t.txId)}</b>)` : ''}. <b>Comprueba en tu banco</b> que entraron <b>${fmtM(t.coinAmount)} ${unit}</b> antes de liberar.</p>
			<label class="check"><input type="checkbox" id="seenMoney" /> Vi el dinero en mi cuenta</label>
			<div class="row-btns"><button class="btn danger" data-act="dispute">No llegó: disputar</button><button class="btn buy" data-act="release" disabled>Liberar ${fmtM(t.usd)} USD</button></div></div>`
	else if (status === 'paid') action = `<p>Marcaste el pago. Esperando que @${esc(t.counterparty)} libere los USD.</p>`
	else if (status === 'revision') action = '<p>En disputa: un moderador revisa el chat. Sube aquí tus comprobantes.</p>'
	else if (status === 'completed') {
		const mine = t.myRating?.rating ?? 0
		const until = t.myRating?.editableUntil ? Date.parse(t.myRating.editableUntil) : null
		const locked = mine > 0 && until != null && until < Date.now()
		const when = until ? new Date(until).toLocaleString('es', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : ''
		const stars = [1, 2, 3, 4, 5]
			.map((n) => `<button data-rate="${n}" class="${n <= mine ? 'on' : ''}" title="${n} de 5" aria-label="${n} de 5 estrellas" aria-pressed="${n === mine}" ${locked ? 'disabled' : ''}>★</button>`)
			.join('')
		action = `<div class="stack tight"><p>${mine ? `Calificaste a @${esc(t.counterparty)}:` : `Operación completada. Califica a @${esc(t.counterparty)}:`}</p>
			<div class="stars ${locked ? 'locked' : ''}" role="group" aria-label="Calificación">${stars}</div>
			${mine ? `<p class="hint">${locked ? 'Ya no se puede cambiar.' : `Puedes cambiarla hasta el ${when}.`}</p>` : ''}
</div>`
	}

	$('modalBody').innerHTML = `<div class="stack">
		<div><h3>${buy ? 'Compras' : 'Vendes'} ${fmtM(t.usd)} USD por ${fmtM(t.coinAmount)} ${unit}</h3>
			<p class="muted">${esc(nameOf(t.coin))} · ${t.counterparty ? `<button type="button" class="link peer-link" data-peer="${esc(t.counterparty)}">@${esc(t.counterparty)}</button>` : '@—'} · <span class="chip ${status}">${STATUS[status] ?? status}</span>${bk.acct.dryRun ? ' · <span class="badge warn">Simulación</span>' : ''}</p></div>
		${
			payTo.length
				? `<div><p class="hint">Datos de pago de @${esc(t.counterparty)}:</p><div class="kv">${payTo
						.map((x) => `<span>${esc(x.name)}</span><b>${esc(x.value)}</b>${copyBtn(x.value, x.name)}`)
						.join('')}<span>Monto</span><b>${fmtM(t.coinAmount)} ${unit}</b>${copyBtn(t.coinAmount, 'el monto')}</div></div>`
				: ''
		}
		${action}
		<div><p class="hint">Chat</p><div class="chatbox" id="chatbox">${
			t.chat.length
				? t.chat
						.map(
							(m) =>
								`<div class="msg ${m.mine ? 'mine' : ''} ${m.moderator ? 'mod' : ''}">${chatImageUrl(m.image) ? `<a class="msg-img" href="${esc(chatImageUrl(m.image))}" target="_blank" rel="noopener" title="Ver la imagen completa"><img src="${esc(chatImageUrl(m.image))}" alt="Imagen" loading="lazy" /></a>` : ''}${esc(m.text ?? '')}<time>${new Date(m.at).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' })}</time></div>`,
						)
						.join('')
				: '<p class="muted small">Sin mensajes.</p>'
		}</div>
		<form class="chatform" id="chatform"><label class="btn icon-only chat-attach" title="Enviar una imagen (comprobante, captura)" aria-label="Enviar una imagen"><input type="file" id="chatFile" accept="image/*" hidden /><svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M21 12.5l-8.6 8.6a5 5 0 01-7.1-7.1l8.6-8.6a3.5 3.5 0 015 5l-8.6 8.6a2 2 0 01-2.8-2.8l7.9-7.9" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></label><input class="input" id="chatInput" maxlength="599" placeholder="Escribe un mensaje…" /><button class="btn">Enviar</button></form></div>
		<p class="hint"><a class="link" href="https://www.qvapay.com/p2p/${t.offer}" target="_blank" rel="noopener">Abrir en QvaPay</a></p>
	</div>`
	tickClocks()
	bindDetail(t)
}

// Botones de copiar (datos de pago, referencias) dentro de un bloque
function bindCopy(body) {
	for (const b of body.querySelectorAll('[data-copy]'))
		b.onclick = (e) => {
			e.preventDefault()
			navigator.clipboard?.writeText(b.dataset.copy)
			b.innerHTML = ICON_DONE
			b.classList.add('done')
			setTimeout(() => {
				b.innerHTML = ICON_COPY
				b.classList.remove('done')
			}, 1400)
		}
}

function bindDetail(t) {
	const body = $('modalBody')
	body.querySelector('[data-peer]')?.addEventListener('click', (e) => showPeer(e.currentTarget.dataset.peer))
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
	bindCopy(body)
	const seen = $('seenMoney')
	if (seen) seen.onchange = () => (body.querySelector('[data-act="release"]').disabled = !seen.checked)
	// "Ya pagué" solo con la referencia de la transferencia escrita
	const tx = $('txRef')
	const paidBtn = body.querySelector('[data-act="paid"]')
	if (tx && paidBtn) {
		const upd = () => (paidBtn.disabled = tx.value.trim().length < 4)
		tx.addEventListener('input', upd)
		upd()
	}
	for (const b of body.querySelectorAll('[data-act]'))
		b.onclick = async () => {
			const a = b.dataset.act
			const unit = unitOf(t.coin)
			const who = `@${esc(t.counterparty ?? '—')}`
			if (a === 'paid') {
				const tx = $('txRef').value.trim()
				if (tx.length < 4) return toast('Escribe la referencia de tu transferencia', true)
				const ok = await askConfirm(
					`¿Ya transferiste ${fmtM(t.coinAmount)} ${unit}?`,
					`<p class="muted">Se avisará a ${who} de que le pagaste, con la referencia <b class="mono">${esc(tx)}</b>. Márcalo solo después de transferir: comprobará el dinero en su banco antes de liberar los USD.</p>`,
					'Sí, ya pagué',
				)
				return ok && act('paid', { txId: tx })
			}
			if (a === 'release') {
				const ok = await askConfirm(
					`¿Liberar ${fmtM(t.usd)} USD?`,
					`<p class="muted">Es irreversible: los USD pasan a ${who}. Hazlo solo si viste los <b>${fmtM(t.coinAmount)} ${unit}</b> en tu cuenta; un comprobante o una captura no bastan.</p>`,
					'Liberar',
					'buy',
				)
				return ok && act('release')
			}
			if (a === 'dispute') {
				const ok = await askConfirm(
					'¿Abrir una disputa?',
					`<p class="muted">Un moderador de QvaPay revisará el chat con ${who} y decidirá. Úsalo si no recibiste el pago; mientras dure, ninguno de los dos puede liberar ni cancelar.</p>`,
					'Abrir disputa',
					'danger',
				)
				return ok && act('dispute')
			}
			if (a === 'cancel') {
				const ok = await askConfirm(
					'¿Cancelar la operación?',
					`<p class="muted">Hazlo solo si todavía no pagaste. Si ya transferiste a ${who}, no canceles: escríbele por el chat.</p>`,
					'Cancelar operación',
					'danger',
				)
				return ok && act('cancel')
			}
			return act(a)
		}
	for (const b of body.querySelectorAll('[data-rate]')) b.onclick = () => !b.disabled && act('rate', { rating: Number(b.dataset.rate) })
	$('chatform').onsubmit = (e) => {
		e.preventDefault()
		const text = $('chatInput').value.trim()
		if (!text) return
		// Tras enviar, el chat baja para enseñar el mensaje aunque se estuviera leyendo más arriba
		bk.chatToEnd = true
		$('chatInput').value = ''
		act('chat', { message: text })
	}
	// Una imagen se envía al elegirla, con lo que haya escrito como texto. El chat se redibuja cada pocos segundos y
	// elegir la foto puede tardar más: se lee del campo que la recibió, que ya puede no ser el de la pantalla
	$('chatFile').onchange = async (ev) => {
		const input = ev.currentTarget
		const file = input.files?.[0]
		const d = bk.detail
		input.value = ''
		if (!file || !d) return
		const label = $('chatFile')?.closest('label')
		label?.classList.add('busy')
		toast('Enviando imagen…')
		try {
			const form = new FormData()
			form.append('offer', d.offer)
			if (d.order) form.append('order', d.order)
			form.append('message', $('chatInput').value.trim())
			form.append('file', await shrinkImage(file))
			await apiForm('/trade/image', form)
			$('chatInput').value = ''
			bk.chatToEnd = true
			toast('Imagen enviada')
			refreshDetail()
		} catch (e) {
			toast(e.message || 'No se pudo enviar la imagen', true)
		} finally {
			$('chatFile')?.closest('label').classList.remove('busy')
		}
	}
}

// ── Publicar una oferta ───────────────────────────────────────────────
let coinFields = null
async function loadCoinFields() {
	if (!coinFields) coinFields = await api('/coins').then((r) => r.fields).catch(() => null)
	return coinFields ?? {}
}

const REQ_OPTIONS = {
	min_completed: ['Operaciones completadas', [5, 10, 25, 50, 100], (v) => `${v} o más`],
	min_rating: ['Valoración', [4, 4.5], (v) => `${String(v).replace('.', ',')} ★ o más`],
	min_account_days: ['Antigüedad de la cuenta', [7, 30, 90, 180, 365], (v) => `${v} días o más`],
}
const reqText = (r) =>
	r
		? Object.entries(r)
				.filter(([k, v]) => v && REQ_OPTIONS[k])
				.map(([k, v]) => `${REQ_OPTIONS[k][0]}: ${REQ_OPTIONS[k][2](v)}`)
				.join(' · ')
		: ''
const num2 = (v) => Math.round(Number(v) * 100) / 100

// Métodos de pago guardados en tu cuenta de QvaPay (tarjetas, cuentas): se piden una vez y sirven a «Publicar» y «Vender»
let paymentMethods = null
function loadPaymentMethods() {
	paymentMethods ??= api('/payment-methods')
		.then((r) => r.methods ?? [])
		.catch(() => {
			paymentMethods = null
			return []
		})
	return paymentMethods
}

// Botones con los métodos guardados de ese mercado: un toque rellena los campos del formulario. Cada método trae sus
// campos con los nombres del formulario y se rellena cada uno con lo suyo
function savedMethodChips(box, methods, coin, inputs, nameOf) {
	if (!box) return
	const list = (methods ?? []).filter((m) => m.coin === coin)
	box.hidden = !list.length
	const tail = (m) => {
		const v = Object.values(m.fields).find((x) => /\d{4}/.test(x)) ?? ''
		return v ? ` · <span class="mono">…${esc(v.replace(/\D/g, '').slice(-4))}</span>` : ''
	}
	box.innerHTML = list.length
		? `<span class="muted small">Guardado en QvaPay:</span>${list.map((m, i) => `<button type="button" class="chip-btn" data-saved="${i}">${esc(m.name)}${tail(m)}</button>`).join('')}`
		: ''
	const norm = (x) => String(x ?? '').trim().toLowerCase()
	for (const b of box.querySelectorAll('[data-saved]'))
		b.onclick = () => {
			const m = list[Number(b.dataset.saved)]
			const els = inputs()
			let filled = 0
			for (const el of els) {
				const [, v] = Object.entries(m.fields).find(([k]) => k && norm(k) === norm(nameOf(el))) ?? []
				if (v == null) continue
				el.value = v
				el.dispatchEvent(new Event('input', { bubbles: true }))
				filled++
			}
			// Si los nombres no coinciden (o es un método de un solo texto), al primer campo
			if (!filled && els[0]) {
				els[0].value = Object.values(m.fields)[0]
				els[0].dispatchEvent(new Event('input', { bubbles: true }))
			}
		}
}

function myUsername() {
	return bk.acct.connected ? bk.acct.username : null
}

// Referencias de precio: del libro si es el mercado que se ve, si no los promedios públicos
function marketRefs(coin) {
	const b = state.book?.coin?.tick === coin ? state.book : null
	if (b) {
		const asks = filtered(b.ask.levels)
		const bids = filtered(b.bid.levels)
		const m = b.completed ? median(b.completed.offers) : null
		// Recién cargado el libro aún no hay operaciones completadas: la referencia es el promedio público
		const o = state.overview.find((c) => c.tick === coin)
		const avg = o?.avgSell && o?.avgBuy ? (o.avgSell + o.avgBuy) / 2 : (o?.avgSell ?? o?.avgBuy ?? null)
		return { refs: [['Mejor venta', asks[0]?.price], ['Mejor compra', bids[0]?.price], ['Mediana completadas', m]].filter(([, p]) => p), mid: m ?? avg }
	}
	const o = state.overview.find((c) => c.tick === coin)
	const refs = [['Venta media 24 h', o?.avgSell], ['Compra media 24 h', o?.avgBuy]].filter(([, p]) => p)
	return { refs, mid: o?.avgSell && o?.avgBuy ? (o.avgSell + o.avgBuy) / 2 : (o?.avgSell ?? o?.avgBuy ?? null) }
}

// Puesto que tendría un precio en el libro que se ve (1 = la mejor de su lado)
function bookRank(coin, type, price) {
	const b = state.book?.coin?.tick === coin ? state.book : null
	if (!b || !(price > 0)) return null
	// Una venta compite con las ventas (gana la más barata); una compra con las compras (gana la más cara)
	const side = type === 'sell' ? b.ask : b.bid
	const levels = filtered(side.levels).filter((l) => l.user !== myUsername())
	// Sin libro cargado todavía, o con un precio más allá de las ofertas que se leyeron, el puesto no se sabe
	if (!levels.length) return null
	const rank = levels.filter((l) => (type === 'sell' ? l.price < price : l.price > price)).length + 1
	if (rank > levels.length && side.total > side.levels.length) return null
	return rank
}

// ── Orden inteligente (Pro) ───────────────────────────────────────────
// La orden inteligente llega en el módulo Pro (/pro/module.js, de un repositorio privado), que rellena el
// hueco #ofSmart del formulario. Sin Pro, si tu precio ya cruza el libro se avisa de lo que haría.
// Las rutas que mueven dinero (/smart…) son públicas y se pueden auditar
// La comisión de QvaPay al liberar la paga quien compra USD (las cuentas GOLD no): la fija llega con tu cuenta
// (src/qvapay/fees.ts). Al comprar se muestra lo que te llega de verdad
const feeOf = (usd) => (bk.acct?.gold || !(bk.acct?.p2pFee > 0) ? 0 : Math.round(usd * bk.acct.p2pFee * 100) / 100)
const netNote = (usd) => {
	const fee = feeOf(usd)
	return fee ? ` · te llegan <b>${fmtM(usd - fee)} USD</b> <span class="muted" title="QvaPay cobra un ${(bk.acct.p2pFee * 100).toLocaleString('es')} % al liberar; las cuentas GOLD no lo pagan">(comisión de QvaPay ${fmtM(fee)})</span>` : ''
}

function smartTeaser(f) {
	if (!window.TPPro?.enabled) return ''
	const b = state.book?.coin?.tick === f.coin ? state.book : null
	if (!b || !(f.amount > 0 && f.price > 0)) return ''
	const buy = f.type === 'buy'
	const n = (buy ? b.ask.levels : b.bid.levels).filter((l) => !l.outlier && l.user !== myUsername() && (buy ? l.price <= f.price : l.price >= f.price)).length
	if (!n) return ''
	return `<p class="smart-head"><b>⚡ Orden inteligente</b> <span class="pro-tag">PRO</span></p>
		<p class="hint">Ya hay ${n === 1 ? 'una oferta' : `${n} ofertas`} a tu precio o mejor. Con Pro las tomarías al mejor precio y solo publicarías el resto, como en un exchange.</p>
		<button type="button" class="btn small" id="smartPro">★ Comprar días de Pro</button>`
}

function priceWarning(type, price, mid) {
	if (!mid || !(price > 0)) return ''
	const dev = price / mid - 1
	if (Math.abs(dev) > 0.3) return `Tu precio está un ${pct(Math.abs(dev)).slice(1)} ${dev > 0 ? 'por encima' : 'por debajo'} de la referencia. ¿Es un error de tipeo?`
	if (type === 'sell' && dev < -0.03) return `Vendes un ${pct(-dev).slice(1)} por debajo de la referencia (${fmtP(mid)}).`
	if (type === 'buy' && dev > 0.03) return `Compras un ${pct(dev).slice(1)} por encima de la referencia (${fmtP(mid)}).`
	return ''
}

async function showCreateOffer(preset = null) {
	if (!bk.acct.connected) return toast('Conecta tu cuenta de QvaPay (arriba a la derecha) para publicar', true)
	const markets = state.overview.length ? state.overview : [{ tick: state.coin, name: nameOf(state.coin), unit: unitOf(state.coin) }]
	const key = `tp-${crypto.randomUUID()}` // misma clave si se reintenta: QvaPay no la duplica
	let type = preset?.type === 'buy' ? 'buy' : 'sell'
	openModal(`<div class="stack offer-form">
		<div id="ofForm" class="stack">
			<h3>Publicar oferta</h3>
			<div class="seg-tabs choice" role="radiogroup" aria-label="Lado">
				<button type="button" class="seg-tab" data-type="sell" role="radio">Vendo USD</button>
				<button type="button" class="seg-tab" data-type="buy" role="radio">Compro USD</button>
			</div>
			<label class="field">Mercado<select class="input" id="ofCoin">${markets.map((c) => `<option value="${c.tick}">${esc(c.name)}</option>`).join('')}</select></label>
			<div class="grid2">
				<label class="field"><span class="field-row">Monto (USD)<button type="button" class="link small" id="ofBal" hidden></button></span><input class="input" id="ofAmount" type="number" min="0.1" max="10000" step="0.01" inputmode="decimal" placeholder="100" /></label>
				<label class="field"><span>Precio por USD (<span id="ofUnit"></span>)</span><input class="input" id="ofPrice" type="number" min="0" step="any" inputmode="decimal" /></label>
			</div>
			<div class="ref-chips" id="ofRefs"></div>
			<p class="hint" id="ofTotal"></p>
			<div class="smart" id="ofSmart" hidden></div>
			<label class="check"><input type="checkbox" id="ofFlex" /> Por rango: que la tomen por partes</label>
			<p class="hint" id="ofFlexNote" hidden>Con la orden inteligente el resto se publica entero. Desmárcala si lo quieres por partes.</p>
			<div class="grid2" id="ofFlexBox" hidden>
				<label class="field">Mínimo por orden (USD)<input class="input" id="ofMin" type="number" step="0.01" inputmode="decimal" /></label>
				<label class="field">Máximo por orden (USD)<input class="input" id="ofMax" type="number" step="0.01" inputmode="decimal" /></label>
			</div>
			<div class="stack tight"><p class="hint" id="ofDetailsTitle"></p><div class="saved-methods" id="ofSaved" hidden></div><div class="stack tight" id="ofDetails"><p class="muted small">Cargando campos…</p></div>
				<label class="check small"><input type="checkbox" id="ofRemember" /> Recordar estos datos en este navegador</label></div>
			<details class="opts"><summary>Requisitos y visibilidad</summary><div class="stack tight">
				${Object.entries(REQ_OPTIONS)
					.map(([k, [label, vals, fmt]]) => `<label class="field">${label}<select class="input" data-req="${k}"><option value="0">Sin requisito</option>${vals.map((v) => `<option value="${v}">${fmt(v)}</option>`).join('')}</select></label>`)
					.join('')}
				<label class="check"><input type="checkbox" id="ofPrivate" /> Privada: no se anuncia en el canal de Telegram de QvaPay</label>
				<label class="check"><input type="checkbox" id="ofVip" /> Solo cuentas VIP</label>
			</div></details>
			<div id="ofWarn"></div>
			<button class="btn primary block" id="ofReview">Revisar</button>
		</div>
		<div id="ofConfirm" class="stack" hidden></div>
	</div>`)
	$('ofCoin').value = preset?.coin ?? state.coin
	if (preset) {
		$('ofAmount').value = String(preset.amount)
		$('ofPrice').value = String(preset.price)
	}

	const fields = await loadCoinFields()
	const read = () => {
		const coin = $('ofCoin').value
		const flex = $('ofFlex').checked
		const requirements = {}
		for (const s of document.querySelectorAll('[data-req]')) if (Number(s.value)) requirements[s.dataset.req] = Number(s.value)
		return {
			type,
			coin,
			amount: num2($('ofAmount').value),
			price: Number($('ofPrice').value),
			kind: flex ? 'flexible' : 'fixed',
			orderMin: flex ? num2($('ofMin').value) : undefined,
			orderMax: flex ? num2($('ofMax').value) : undefined,
			details: [...document.querySelectorAll('[data-detail]')].map((i) => ({ name: i.dataset.detail, value: i.value.trim() })),
			requirements,
			private: $('ofPrivate').checked,
			onlyVip: $('ofVip').checked,
			idempotencyKey: key,
		}
	}
	const renderDetails = () => {
		const coin = $('ofCoin').value
		const saved = store.get(`details.${coin}`, {})
		const list = fields[coin] ?? []
		$('ofRemember').checked = Object.keys(saved).length > 0
		$('ofDetails').innerHTML = list.length
			? list
					.map((f) => {
						const label = esc(f.label || f.name)
						const val = esc(saved[f.name] ?? '')
						return f.type === 'select' && f.options?.length
							? `<label class="field">${label}<select class="input" data-detail="${esc(f.name)}">${f.options.map((o) => `<option ${o.value === saved[f.name] ? 'selected' : ''}>${esc(o.value)}</option>`).join('')}</select></label>`
							: `<label class="field">${label}<input class="input" data-detail="${esc(f.name)}" value="${val}" placeholder="${esc(f.placeholder ?? '')}" autocomplete="off" /></label>`
					})
					.join('')
			: '<p class="notice warn">No se pudieron cargar los campos de pago de este mercado. Inténtalo de nuevo.</p>'
		renderSaved()
	}
	// Lo que guardaste en QvaPay para este mercado (tarjetas, cuentas): un toque y se rellena el campo
	let savedMethods = null
	const renderSaved = () => savedMethodChips($('ofSaved'), savedMethods, $('ofCoin').value, () => [...$('ofDetails').querySelectorAll('[data-detail]')], (el) => el.dataset.detail)
	loadPaymentMethods().then((list) => {
		savedMethods = list
		if ($('ofSaved')) renderSaved()
	})
	// Vendiendo, nunca más que tu saldo: el monto se recorta a lo que tienes. Se pide el saldo al abrir y, si
	// cambia mientras está abierto, se aplica
	const balance = () => Math.floor((bk.acct.balance ?? 0) * 100) / 100
	const onBalance = () => ($('ofAmount') ? update() : document.removeEventListener('tp:balance', onBalance))
	document.addEventListener('tp:balance', onBalance)
	refreshBalance(true)
	const update = () => {
		if (type === 'sell' && num2($('ofAmount').value) > balance()) $('ofAmount').value = String(balance())
		$('ofBal').hidden = type !== 'sell'
		$('ofBal').innerHTML = `Saldo: <b class="mono">${fmtM(balance())}</b> USD`
		$('ofAmount').max = String(type === 'sell' ? Math.min(10_000, balance()) : 10_000)
		for (const b of document.querySelectorAll('[data-type]')) {
			b.classList.toggle('active', b.dataset.type === type)
			b.setAttribute('aria-checked', String(b.dataset.type === type))
		}
		const f = read()
		const unit = unitOf(f.coin)
		$('ofUnit').textContent = unit
		$('ofFlexBox').hidden = f.kind !== 'flexible'
		$('ofDetailsTitle').textContent = type === 'sell' ? 'Dónde quieres recibir el pago' : 'Tus datos de pago (los verá quien tome la oferta)'
		const { refs, mid } = marketRefs(f.coin)
		$('ofRefs').innerHTML = refs.map(([label, p]) => `<button type="button" class="chip-btn" data-ref="${p}">${label} <b class="mono">${fmtP(p)}</b></button>`).join('')
		const total = f.amount > 0 && f.price > 0 ? f.amount * f.price : 0
		const rank = bookRank(f.coin, type, f.price)
		$('ofTotal').innerHTML = total
			? `${type === 'sell' ? 'Recibirás' : 'Pagarás'} <b>${fmtM(total)} ${unit}</b>${type === 'buy' ? netNote(f.amount) : ''}${rank ? ` · serías la <b>${rank}ª</b> ${type === 'sell' ? 'venta' : 'compra'} del libro` : ''}`
			: ''
		const w = priceWarning(type, f.price, mid)
		// La orden inteligente (módulo Pro) rellena su hueco y dice si está activa; sin Pro, el aviso de lo que haría
		const sm = smart ? smart.render({ f, unit, warn: w }) : null
		if (!smart) {
			const t = smartTeaser(f)
			$('ofSmart').hidden = !t
			$('ofSmart').innerHTML = t
		}
		smartActive = !!sm?.active
		// Con la orden inteligente el aviso va dentro del plan, sobre el resto que se publica
		$('ofWarn').innerHTML = w && !smartActive ? `<p class="notice warn">${w}</p>` : ''
		// Con la orden inteligente el resto se publica entero: sin «por rango»
		if (smartActive && $('ofFlex').checked) $('ofFlex').checked = false
		$('ofFlex').disabled = smartActive
		$('ofFlexNote').hidden = !smartActive
		if (smartActive) $('ofFlexBox').hidden = true
		// Con la orden inteligente el total es lo que tomas más lo que publicas
		if (smartActive && total && sm.total) $('ofTotal').innerHTML = `${type === 'sell' ? 'Recibirás' : 'Pagarás'} <b>${fmtM(sm.total)} ${unit}</b> en total`
		$('ofReview').textContent = smartActive ? 'Revisar orden inteligente' : 'Revisar'
	}
	// El módulo Pro (si estás en Pro) maneja la orden inteligente de este formulario; si llega después
	// (por ejemplo, al volver de pagar), se engancha al momento. Si Pro se apagó o venció, aunque el módulo
	// siga cargado, no se usa
	let smart = null
	let smartActive = false
	const ctx = { update: () => update(), read, fields, getType: () => type }
	smart = window.TPPro?.active ? (window.TPProSmart?.open(ctx) ?? null) : null
	renderDetails()
	update()
	const onSmartReady = () => {
		if (!$('ofForm')) return document.removeEventListener('tp:smart-ready', onSmartReady)
		if (window.TPPro?.active) smart ??= window.TPProSmart.open(ctx)
		if (!$('ofForm').hidden) update()
	}
	document.addEventListener('tp:smart-ready', onSmartReady)

	const body = $('modalBody')
	for (const b of body.querySelectorAll('[data-type]'))
		b.onclick = () => {
			type = b.dataset.type
			update()
		}
	$('ofCoin').onchange = () => {
		renderDetails()
		update()
	}
	for (const id of ['ofAmount', 'ofPrice', 'ofMin', 'ofMax', 'ofFlex']) $(id).addEventListener('input', update)
	$('ofBal').onclick = () => {
		$('ofAmount').value = String(balance())
		update()
	}
	$('ofSmart').addEventListener('click', (e) => e.target.closest('#smartPro') && typeof showPro === 'function' && showPro())
	$('ofRefs').onclick = (e) => {
		const b = e.target.closest('[data-ref]')
		if (!b) return
		$('ofPrice').value = String(Math.round(Number(b.dataset.ref) * 10000) / 10000)
		update()
	}

	$('ofReview').onclick = () => {
		const f = read()
		const unit = unitOf(f.coin)
		const err =
			type === 'sell' && f.amount > balance()
				? `No tienes saldo suficiente: tienes ${fmtM(balance())} USD`
				: !(f.amount >= 0.1 && f.amount <= 10000)
				? 'El monto debe estar entre 0,1 y 10.000 USD'
				: !(f.price > 0)
					? 'Pon el precio por cada USD'
					: f.kind === 'flexible' && !(f.orderMin > 0 && f.orderMax >= f.orderMin && f.orderMax <= f.amount)
						? 'Revisa el mínimo y el máximo por orden: mínimo ≤ máximo ≤ monto'
						: f.details.some((d) => !d.value)
							? 'Completa todos tus datos de pago'
							: ''
		if (err) return toast(err, true)
		if (smartActive) return smart.review(f)
		const total = f.amount * f.price
		const req = reqText(f.requirements)
		$('ofForm').hidden = true
		$('ofConfirm').hidden = false
		$('ofConfirm').innerHTML = `<h3>Revisa tu oferta</h3>
			<div class="kv">
				<span>${type === 'sell' ? 'Vendes' : 'Compras'}</span><b>${fmtM(f.amount)} USD</b><span></span>
				<span>Precio</span><b>${fmtP(f.price)} ${unit}</b><span></span>
				<span>${type === 'sell' ? 'Recibes' : 'Pagas'}</span><b>${fmtM(total)} ${unit}</b><span></span>
				${type === 'buy' && feeOf(f.amount) ? `<span>Te llegan</span><b>${fmtM(f.amount - feeOf(f.amount))} USD</b><span class="muted">tras la comisión de QvaPay</span>` : ''}
				<span>Mercado</span><b>${esc(nameOf(f.coin))}</b><span></span>
				${f.kind === 'flexible' ? `<span>Por partes</span><b>${fmtM(f.orderMin)}–${fmtM(f.orderMax)} USD</b><span></span>` : ''}
				${req ? `<span>Requisitos</span><b>${esc(req)}</b><span></span>` : ''}
				<span>Visibilidad</span><b>${f.private ? 'Privada' : 'Pública en Telegram'}${f.onlyVip ? ' · solo VIP' : ''}</b><span></span>
			</div>
			<p class="notice">${
				type === 'sell'
					? `Se reservan <b>${fmtM(f.amount)} USD</b> de tu saldo mientras la oferta esté publicada. Cuando alguien la tome, te pagará a tus datos y liberarás los USD al ver el dinero.`
					: f.kind === 'flexible'
						? `No se reserva saldo. Cada vez que alguien tome una parte, tendrás que transferirle lo de esa parte a sus datos y marcar el pago (en total, hasta <b>${fmtM(total)} ${unit}</b>).`
						: `No se reserva saldo. Cuando alguien la tome, tendrás que transferirle <b>${fmtM(total)} ${unit}</b> a sus datos y marcar el pago.`
			}</p>
			${$('ofWarn').innerHTML}
			<div class="row-btns"><button class="btn" id="ofBack">Volver</button><button class="btn primary" id="ofPublish">Publicar</button></div>`
		$('ofBack').onclick = () => {
			$('ofConfirm').hidden = true
			$('ofForm').hidden = false
		}
		$('ofPublish').onclick = async () => {
			const btn = $('ofPublish')
			btn.disabled = true
			btn.textContent = 'Publicando…'
			try {
				const r = await api('/offer/create', f)
				markOrigin(r.offer)
				if ($('ofRemember').checked) store.set(`details.${f.coin}`, Object.fromEntries(f.details.map((d) => [d.name, d.value])))
				else store.set(`details.${f.coin}`, {})
				toast(r.message || 'Oferta publicada')
				bk.tab = 'offers'
				await loadTrades()
				showManageOffer(r.offer)
				loadBook()
			} catch (e) {
				btn.disabled = false
				btn.textContent = 'Publicar'
				toast(e.message, true)
			}
		}
	}

}

// ── Gestionar una oferta tuya ─────────────────────────────────────────
async function showManageOffer(uuid) {
	bk.detail = null
	openModal('<p class="muted">Cargando oferta…</p>')
	let o
	try {
		o = await api(`/offer?offer=${uuid}`)
	} catch (e) {
		$('modalBody').innerHTML = `<p class="empty">${esc(e.message)}</p>`
		return
	}
	renderManage(o)
}

function pauseText(p) {
	if (!p) return ''
	if (p.reason === 'owner') return 'Pausada por ti: no aparece en el mercado'
	const until = p.until ? new Date(p.until).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' }) : null
	return `Pausada porque se fue la contraparte${until ? `: vuelve al mercado a las ${until}` : ''}`
}

function renderManage(o) {
	const unit = unitOf(o.coin)
	const flex = o.kind === 'flexible'
	const amount = flex ? (o.available ?? o.usd) : o.usd
	const editable = o.status === 'open' && !o.peer
	const rank = o.status === 'open' && !o.pause ? bookRank(o.coin, o.type, o.price) : null
	const req = reqText(o.requirements)
	const orders = o.orders.filter((x) => x.status !== 'cancelled')
	$('modalBody').innerHTML = `<div class="stack">
		<div><h3>${o.type === 'sell' ? 'Vendes' : 'Compras'} ${fmtM(amount)} USD a ${fmtP(o.price)} ${unit}</h3>
			<p class="muted">${esc(nameOf(o.coin))} · <span class="chip ${o.status}">${STATUS[o.status] ?? o.status}</span>${o.isPrivate ? ' · Privada' : ''}${flex ? ` · Por partes de ${fmtM(o.orderMin)}–${fmtM(o.orderMax)} USD` : ''}</p></div>
		${o.pause ? `<p class="notice warn">${pauseText(o.pause)}</p>` : rank ? `<p class="hint">Ahora mismo es la <b>${rank}ª</b> ${o.type === 'sell' ? 'venta' : 'compra'} del libro.</p>` : ''}
		${o.status !== 'open' ? `<p class="notice">Alguien tomó esta oferta. <button class="link" data-open-trade>Ver la operación</button></p>` : ''}
		${
			editable
				? `<div class="stack tight"><p class="hint">Cambiar precio o monto</p>
				<div class="grid2">
					<label class="field">${flex ? 'Disponible' : 'Monto'} (USD)<input class="input" id="edAmount" type="number" step="0.01" inputmode="decimal" value="${amount}" /></label>
					<label class="field">Precio por USD (${unit})<input class="input" id="edPrice" type="number" step="any" inputmode="decimal" value="${Math.round(o.price * 10000) / 10000}" /></label>
				</div>
				<p class="hint" id="edTotal"></p><div id="edWarn"></div>
				${flex ? '' : '<label class="check"><input type="checkbox" id="edFlex" /> Pasarla a por partes: que la tomen por partes</label>'}
				<div class="grid2" id="edFlexBox" ${flex ? '' : 'hidden'}>
					<label class="field">Mínimo por orden (USD)<input class="input" id="edMin" type="number" step="0.01" inputmode="decimal" value="${o.orderMin ?? ''}" /></label>
					<label class="field">Máximo por orden (USD)<input class="input" id="edMax" type="number" step="0.01" inputmode="decimal" value="${o.orderMax ?? ''}" /></label>
				</div>
				${flex ? '' : '<p class="notice warn" id="edFlexNote" hidden>No tiene vuelta atrás: QvaPay no deja volver a convertir una oferta por partes en una que se toma entera.</p>'}
				<details class="opts"><summary>Requisitos y visibilidad</summary><div class="stack tight">
					${Object.entries(REQ_OPTIONS)
						.map(([k, [label, vals, fmt]]) => {
							const cur = Number(o.requirements?.[k] ?? 0)
							// Un valor puesto desde la web de QvaPay que aquí no está en la lista se conserva
							const opts = cur && !vals.includes(cur) ? [...vals, cur].sort((a, b) => a - b) : vals
							return `<label class="field">${label}<select class="input" data-ed-req="${k}"><option value="0">Sin requisito</option>${opts.map((v) => `<option value="${v}" ${v === cur ? 'selected' : ''}>${fmt(v)}</option>`).join('')}</select></label>`
						})
						.join('')}
					<label class="check"><input type="checkbox" id="edVip" ${o.onlyVip ? 'checked' : ''} /> Solo cuentas VIP</label>
					${o.isPrivate ? '<label class="check"><input type="checkbox" id="edPublic" /> Hacerla pública: que se anuncie en el canal de Telegram de QvaPay (no se puede volver a privada)</label>' : ''}
					${
						bk.acct.gold
							? `<label class="field">Mensaje público (GOLD)<input class="input" id="edMsg" maxlength="79" placeholder="Ej.: pago rápido, respondo al momento" value="${esc(o.message ?? '')}" /></label><p class="hint">Hasta 79 caracteres. QvaPay quita los enlaces.</p>`
							: o.message
								? `<p class="hint">Mensaje público: «${esc(o.message)}». Solo una cuenta GOLD puede cambiarlo.</p>`
								: ''
					}
				</div></details>
				<p class="hint">Los datos de pago, el mercado y si compras o vendes no se pueden cambiar en QvaPay: para eso, cancela la oferta y publica otra.</p>
				<button class="btn" id="edSave">Guardar cambios</button></div>`
				: ''
		}
		${req ? `<p class="hint">Requisitos: ${esc(req)}</p>` : ''}
		${
			o.details.length
				? `<div><p class="hint">Tus datos de pago en esta oferta</p><div class="kv">${o.details.map((d) => `<span>${esc(d.name)}</span><b>${esc(d.value)}</b><span></span>`).join('')}</div></div>`
				: ''
		}
		${
			flex && orders.length
				? `<div><p class="hint">Órdenes</p><table class="otable"><tbody>${orders
						.map(
							(x) =>
								`<tr data-order-row="${x.order}"><td class="num">${fmtM(x.usd)} USD</td><td class="num">${fmtM(x.coinAmount)} ${unit}</td><td>@${esc(x.taker ?? '—')}</td><td><span class="chip ${x.status}">${STATUS[x.status] ?? x.status}</span></td></tr>`,
						)
						.join('')}</tbody></table></div>`
				: ''
		}
		<div class="row-btns">
			${o.status === 'open' ? `<button class="btn" id="mgPause">${o.pause ? 'Volver a publicar' : 'Pausar'}</button><button class="btn danger" id="mgCancel">Cancelar oferta</button>` : ''}
		</div>
		${o.status === 'open' ? `<div class="share"><p class="hint">Enlace para que alguien la tome desde el terminal${o.isPrivate ? ' (útil en ofertas privadas)' : ''}</p><div class="row-btns"><input class="input" id="mgLink" readonly value="${location.origin}/#p2p/${o.offer}" /><button class="btn icon-only" id="mgCopy" title="Copiar enlace" aria-label="Copiar enlace">${ICON_COPY}</button></div></div>` : ''}
		<p class="hint"><a class="link" href="https://www.qvapay.com/p2p/${o.offer}" target="_blank" rel="noopener">Abrir en QvaPay</a></p>
	</div>`

	$('mgCopy')?.addEventListener('click', () => {
		navigator.clipboard?.writeText($('mgLink').value)
		$('mgCopy').innerHTML = ICON_DONE
		setTimeout(() => $('mgCopy') && ($('mgCopy').innerHTML = ICON_COPY), 1400)
		toast('Enlace copiado')
	})
	const refresh = () => showManageOffer(o.offer)
	if (editable) {
		const upd = () => {
			const a = num2($('edAmount').value)
			const p = Number($('edPrice').value)
			$('edTotal').innerHTML = a > 0 && p > 0 ? `${o.type === 'sell' ? 'Recibirás' : 'Pagarás'} <b>${fmtM(a * p)} ${unit}</b>${o.type === 'buy' ? netNote(a) : ''}` : ''
			const w = priceWarning(o.type, p, marketRefs(o.coin).mid)
			$('edWarn').innerHTML = w ? `<p class="notice warn">${w}</p>` : ''
		}
		for (const id of ['edAmount', 'edPrice']) $(id).addEventListener('input', upd)
		upd()
		$('edFlex')?.addEventListener('change', () => {
			const on = $('edFlex').checked
			$('edFlexBox').hidden = !on
			$('edFlexNote').hidden = !on
		})
		$('edSave').onclick = async () => {
			const btn = $('edSave')
			const toFlexible = !flex && !!$('edFlex')?.checked
			const makePublic = !!$('edPublic')?.checked
			// Los requisitos que la web de QvaPay deja poner y aquí no salen se mantienen
			const requirements = { ...(o.requirements ?? {}) }
			for (const sel of document.querySelectorAll('[data-ed-req]')) requirements[sel.dataset.edReq] = Number(sel.value)
			// Todo se lee antes de confirmar: la confirmación ocupa la ventana y el formulario deja de estar
			const edit = {
				offer: o.offer,
				amount: num2($('edAmount').value),
				price: Number($('edPrice').value),
				orderMin: flex || toFlexible ? num2($('edMin').value) : undefined,
				orderMax: flex || toFlexible ? num2($('edMax').value) : undefined,
				toFlexible,
				requirements,
				onlyVip: $('edVip').checked,
				makePublic,
				message: $('edMsg') ? $('edMsg').value : undefined,
			}
			// Lo que no tiene vuelta atrás se confirma antes
			const oneWay = [toFlexible && 'pasará a tomarse por partes y no podrá volver a tomarse entera', makePublic && 'será pública y no podrá volver a ser privada'].filter(Boolean)
			if (oneWay.length && !(await confirmDialog('Guardar cambios', `<p class="muted">La oferta ${oneWay.join(', y ')}.</p>`, 'Guardar cambios'))) return showManageOffer(o.offer)
			btn.disabled = true
			try {
				const r = await api('/offer/edit', edit)
				toast(r.message)
				loadTrades()
				loadBook()
				refresh()
			} catch (e) {
				btn.disabled = false
				toast(e.message, true)
				if (oneWay.length) refresh()
			}
		}
	}
	$('mgPause')?.addEventListener('click', async () => {
		try {
			const r = await api('/offer/pause', { offer: o.offer, paused: !o.pause })
			toast(r.message)
			loadTrades()
			loadBook()
			refresh()
		} catch (e) {
			toast(e.message, true)
		}
	})
	$('mgCancel')?.addEventListener('click', async () => {
		const msg = o.type === 'sell' ? 'Se retira del mercado y los USD reservados vuelven a tu saldo.' : 'Se retira del mercado.'
		if (!(await confirmDialog('Cancelar oferta', `<p class="muted">${msg}</p>`, 'Cancelar oferta', 'danger'))) return showManageOffer(o.offer)
		try {
			const r = await api('/trade/action', { offer: o.offer, action: 'cancel_offer' })
			toast(r.message || 'Oferta cancelada')
			loadTrades()
			loadBook()
			// La ventana pasa a enseñarla cancelada (sin botones que ya no sirven)
			refresh()
		} catch (e) {
			toast(e.message, true)
			// Si alguien la acaba de tomar, la oferta se recarga y enseña la operación
			if (e.status === 409) {
				loadTrades()
				showManageOffer(o.offer)
			}
		}
	})
	$('modalBody').querySelector('[data-open-trade]')?.addEventListener('click', () => openTrade(o.offer, null))
	for (const r of $('modalBody').querySelectorAll('[data-order-row]')) r.onclick = () => openTrade(o.offer, r.dataset.orderRow)
}

// ── Tomar una oferta del libro ────────────────────────────────────────
function showTakeOffer(uuid, side) {
	const l = findLevel(uuid, side)
	if (!l) return
	if (myUsername() && l.user === myUsername()) return showManageOffer(uuid)
	renderTake(uuid, side, l, state.book.coin.tick)
}

// Una oferta por su enlace (#p2p/<uuid>): la carga aunque no esté entre las que muestra el libro
async function showTakeOfferById(uuid) {
	if (!bk.acct.connected) return toast('Conecta tu cuenta de QvaPay (arriba a la derecha) para abrir la oferta', true)
	openModal('<p class="muted">Cargando oferta…</p>')
	let o
	try {
		o = await api(`/offer?offer=${encodeURIComponent(uuid)}`)
	} catch (e) {
		$('modalBody').innerHTML = `<p class="empty">${esc(e.message)}</p>`
		return
	}
	if (o.isOwner) return renderManage(o)
	if (o.status !== 'open' || o.pause) {
		$('modalBody').innerHTML = `<div class="stack"><h3>Esta oferta ya no está disponible</h3><p class="muted">Está ${esc((STATUS[o.status] ?? o.status).toLowerCase())}${o.pause ? ' y pausada' : ''}.</p></div>`
		return
	}
	const flex = o.kind === 'flexible'
	const level = {
		price: o.price,
		usd: flex ? (o.available ?? o.usd) : o.usd,
		kind: o.kind,
		orderMin: o.orderMin,
		orderMax: o.orderMax,
		requirements: o.requirements,
		requirementsMet: o.requirementsMet,
		requirementsMissing: o.requirementsMissing,
		vipOnly: o.onlyVip,
		user: o.owner?.username ?? '—',
		ops: o.owner?.ops ?? null,
		rating: o.owner?.rating ?? null,
		kyc: false,
	}
	renderTake(o.offer, o.type === 'sell' ? 'ask' : 'bid', level, o.coin)
}

const REQ_NAMES = { min_completed: ['operaciones completadas', ''], min_rating: ['valoración', '★'], min_account_days: ['días de cuenta', ''], min_trustscore: ['trustscore', ''] }
async function checkRequirements(uuid, l) {
	let o = l.requirementsMet === false ? l : null
	if (!o)
		try {
			o = await api(`/offer?offer=${encodeURIComponent(uuid)}`)
		} catch {
			return
		}
	if (o.requirementsMet !== false || !$('tkGo')) return
	const why = (o.requirementsMissing ?? [])
		.map((m) => {
			const [name, unit] = REQ_NAMES[m.key] ?? [m.key, '']
			return `${name}: pide ${m.required}${unit}, tienes ${m.actual}${unit}`
		})
		.join(' · ')
	$('tkGo').insertAdjacentHTML('beforebegin', `<p class="notice warn">No cumples los requisitos de esta oferta${why ? ` (${esc(why)})` : ''}. QvaPay la rechazaría.</p>`)
	$('tkGo').disabled = true
}

function renderTake(uuid, side, l, coin) {
	const unit = unitOf(coin)
	// En una venta ajena compras USD (pagas tú); en una compra ajena vendes USD (te pagan)
	const youBuy = side === 'ask'
	const flex = l.kind === 'flexible'
	const max = flex ? Math.min(l.orderMax ?? l.usd, l.usd) : l.usd
	const min = flex ? (l.orderMin ?? 0) : l.usd
	const req = reqText(l.requirements)
	openModal(`<div class="stack">
		<div><h3>${youBuy ? 'Comprar' : 'Vender'} USD a ${fmtP(l.price)} ${unit}</h3>
			<p class="muted">${esc(nameOf(coin))} · <button type="button" class="link peer-link" data-peer="${esc(l.user)}">@${esc(l.user)}</button>${l.ops != null ? ` · ${l.ops} operaciones` : ''}${l.rating ? ` · ⭐ ${l.rating.toFixed(2)}` : l.ops != null ? ' · sin valoraciones' : ''}${l.kyc ? ' · KYC' : ''}</p>
			${typeof rankText === 'function' && rankText(l.user) ? `<p class="rank-line">🏆 Ranking: ${esc(rankText(l.user))}</p>` : ''}</div>
		<div class="kv">
			<span>${youBuy ? 'Vende' : 'Compra'}</span><b>${fmtM(l.usd)} USD</b><span></span>
			${flex ? `<span>Por orden</span><b>${min ? `${fmtM(min)}–${fmtM(max)}` : `hasta ${fmtM(max)}`} USD</b><span></span>` : ''}
			${req ? `<span>Requisitos</span><b>${esc(req)}</b><span></span>` : ''}
			${l.vipOnly ? '<span>Solo</span><b>cuentas VIP</b><span></span>' : ''}
		</div>
		${flex ? `<label class="field">¿Cuántos USD ${youBuy ? 'compras' : 'vendes'}?<input class="input" id="tkAmount" type="number" min="${min}" max="${max}" step="0.01" inputmode="decimal" value="${max}" /></label>` : ''}
		<p class="hint" id="tkTotal"></p>
		<p class="notice">${
			youBuy
				? 'Al tomarla tendrás que transferir el total a los datos de pago del vendedor y marcar el pago antes de que venza el plazo.'
				: 'Al tomarla se reservan esos USD de tu saldo como garantía. Los liberas solo cuando veas el pago en tu cuenta.'
		}</p>
		${
			bk.acct.connected
				? '<button class="btn primary block" id="tkGo"></button>'
				: '<p class="notice warn">Conecta tu cuenta de QvaPay (arriba a la derecha) para tomarla.</p>'
		}
		<p class="hint"><a class="link" href="https://www.qvapay.com/p2p/${uuid}" target="_blank" rel="noopener">Ver en QvaPay</a></p>
	</div>`)
	const amount = () => (flex ? num2($('tkAmount').value) : l.usd)
	const upd = () => {
		const a = amount()
		const total = a * l.price
		$('tkTotal').innerHTML = a > 0 ? `${youBuy ? 'Pagas' : 'Recibes'} <b>${fmtM(total)} ${unit}</b> por <b>${fmtM(a)} USD</b>${youBuy ? netNote(a) : ''}` : ''
		if ($('tkGo')) $('tkGo').textContent = `Tomar: ${youBuy ? 'comprar' : 'vender'} ${fmtM(a)} USD`
	}
	$('tkAmount')?.addEventListener('input', upd)
	$('modalBody').querySelector('[data-peer]')?.addEventListener('click', (e) => showPeer(e.currentTarget.dataset.peer))
	upd()
	// Con requisitos, QvaPay dice si los cumples: si no, se avisa antes de gastar un intento de los 2 por minuto
	if (req && bk.acct.connected) checkRequirements(uuid, l)
	$('tkGo')?.addEventListener('click', async () => {
		const a = amount()
		if (flex && !(a >= min && a <= max)) return toast(`El monto debe estar entre ${fmtM(min)} y ${fmtM(max)} USD`, true)
		const btn = $('tkGo')
		btn.disabled = true
		btn.textContent = 'Tomando…'
		try {
			const r = await api('/offer/apply', { offer: uuid, amount: flex ? a : undefined })
			markOrigin(r.offer)
			toast(r.message || 'Tomaste la oferta')
			bk.tab = 'active'
			await loadTrades()
			loadBook()
			openTrade(r.offer, r.order)
		} catch (e) {
			btn.disabled = false
			upd()
			toast(e.message, true)
		}
	})
}

// ── Ficha de un usuario ───────────────────────────────────────────────
// Perfil, señales de confianza, sus ofertas abiertas y lo que has hecho con él. QvaPay no da el
// historial de otro usuario: solo lo que tiene publicado ahora y lo que ha pasado entre los dos
const PEER_OUTLIER_PCT = 0.35

// Lo que ya se sabe de un usuario por el libro o por tus operaciones (si no tiene ofertas abiertas)
function knownPeer(user) {
	const u = user.toLowerCase()
	const b = state.book
	const l = b && [...b.ask.levels, ...b.bid.levels].find((x) => x.user.toLowerCase() === u)
	if (l) return { ops: l.ops, rating: l.rating, kyc: l.kyc, vip: l.vip, gold: l.gold }
	const t = bk.trades.find((x) => x.counterparty?.username?.toLowerCase() === u)
	return t ? { ops: t.counterparty.ops, rating: t.counterparty.rating } : null
}

function peerSignals(p, known, offers) {
	const out = []
	const ops = p ? p.opsOwner + p.opsTaker : (known?.ops ?? null)
	const rating = p ? p.rating : (known?.rating ?? null)
	if (p) {
		const missing = [!p.kyc && 'identidad (KYC)', p.phone === false && 'teléfono', p.telegram === false && 'Telegram'].filter(Boolean)
		out.push(missing.length ? ['warn', `Sin verificar: ${missing.join(', ')}`] : ['ok', 'Identidad, teléfono y Telegram verificados'])
	}
	if ((p?.vip ?? known?.vip) === true) out.push(['ok', 'Cuenta VIP de QvaPay'])
	if (ops != null) {
		if (ops >= 200) out.push(['ok', `Mucha experiencia: ${ops.toLocaleString('es')} operaciones completadas`])
		else if (ops < 10) out.push(['warn', `Pocas operaciones (${ops}): cuenta nueva o poco usada`])
		else out.push(['info', `${ops.toLocaleString('es')} operaciones completadas`])
	}
	if (rating == null) out.push(['warn', 'Sin valoraciones todavía'])
	else if (rating < 4.5) out.push(['warn', `Valoración baja: ${rating.toFixed(2).replace('.', ',')} de 5`])
	else if (rating >= 4.8 && (p?.ratings ?? 10) >= 10) out.push(['ok', `Muy bien valorado: ${rating.toFixed(2).replace('.', ',')} de 5${p ? ` (${p.ratings.toLocaleString('es')} valoraciones)` : ''}`])
	if (p && p.opsOwner + p.opsTaker >= 20) {
		const taker = p.opsTaker / (p.opsOwner + p.opsTaker)
		if (taker >= 0.75) out.push(['info', `Suele tomar ofertas de otros (${Math.round(taker * 100)}% de sus operaciones)`])
		else if (taker <= 0.25) out.push(['info', `Suele publicar sus propias ofertas (${Math.round((1 - taker) * 100)}% de sus operaciones)`])
	}
	// Precio muy lejos del mercado: casi siempre un error de tipeo, a veces un intento de engaño
	const far = offers.filter((o) => {
		const m = state.overview.find((c) => c.tick === o.coin)
		const mid = m?.ask && m?.bid ? (m.ask + m.bid) / 2 : (m?.ask ?? m?.bid)
		return mid && Math.abs(o.price / mid - 1) > PEER_OUTLIER_PCT
	})
	if (far.length) out.push(['warn', `${far.length === 1 ? 'Una oferta' : `${far.length} ofertas`} con el precio muy lejos del mercado`])
	return out
}

async function showPeer(user) {
	user = String(user ?? '').replace(/^@/, '')
	if (!user) return
	if (!bk.acct.connected) return toast('Conecta tu cuenta de QvaPay (arriba a la derecha) para ver la ficha', true)
	openModal(`<div class="stack"><h3>@${esc(user)}</h3><p class="muted">Cargando ficha…</p></div>`)
	let d
	try {
		d = await api(`/peer?user=${encodeURIComponent(user)}`)
	} catch (e) {
		$('modalBody').innerHTML = `<div class="stack"><h3>@${esc(user)}</h3><p class="empty">${esc(e.message)}</p></div>`
		return
	}
	if (!$('modalBody').textContent.includes('Cargando ficha')) return // la cerraron mientras cargaba
	const p = d.profile
	const known = p ? null : knownPeer(user)
	const name = p?.username ?? user
	const me = myUsername()
	const isMe = me && name.toLowerCase() === me.toLowerCase()
	const badges = [
		(p?.kyc ?? known?.kyc) && '<span class="badge ok">KYC</span>',
		(p?.vip ?? known?.vip) && '<span class="badge ok">VIP</span>',
		(p?.gold ?? known?.gold) && '<span class="badge warn">GOLD</span>',
		p?.phone && '<span class="badge neutral">Teléfono</span>',
		p?.telegram && '<span class="badge neutral">Telegram</span>',
	]
		.filter(Boolean)
		.join(' ')
	const ops = p ? p.opsOwner + p.opsTaker : known?.ops
	const rating = p ? p.rating : known?.rating
	const stat = (label, value, sub = '') => `<div class="peer-stat"><span>${label}</span><b>${value}</b>${sub ? `<small>${sub}</small>` : ''}</div>`
	const signals = peerSignals(p, known, d.offers)
	const rank = typeof rankText === 'function' ? rankText(name) : ''
	const now = Date.now()
	const offers = d.offers
		.map((o) => {
			const unit = unitOf(o.coin)
			const range = o.kind === 'flexible' ? `${o.orderMin ? fmtM(o.orderMin) : '0'}–${fmtM(o.orderMax ?? o.usd)}` : fmtM(o.usd)
			const t = Date.parse(o.updatedAt ?? o.createdAt ?? '')
			return `<button type="button" class="peer-offer" data-peer-offer="${esc(o.offer)}">
				<span class="po-side ${o.type === 'sell' ? 'ask' : 'bid'}">${o.type === 'sell' ? 'Vende' : 'Compra'}</span>
				<span class="po-mkt">${esc(nameOf(o.coin))}${o.vipOnly ? ' · solo VIP' : ''}${o.paused ? ' · pausada' : ''}</span>
				<span class="po-price mono">${fmtP(o.price)} <small>${esc(unit)}</small></span>
				<span class="po-usd mono">${range} USD</span>
				<span class="po-age">${t ? `hace ${ago(now - t)}` : ''}</span>
			</button>`
		})
		.join('')
	// Lo que habéis hecho juntos, de tus últimas operaciones
	const together = bk.trades.filter((t) => t.counterparty?.username?.toLowerCase() === name.toLowerCase())
	const done = together.filter((t) => t.status === 'completed')
	const vol = done.reduce((s, t) => s + t.usd, 0)
	const history = together
		.slice(0, 6)
		.map(
			(t) => `<button type="button" class="peer-trade" data-peer-trade="${esc(t.offerUuid)}" data-order="${esc(t.order ?? '')}">
				<span>${t.side === 'buy' ? 'Le compraste' : 'Le vendiste'} <b class="mono">${fmtM(t.usd)} USD</b> · ${esc(nameOf(t.coin))}${t.updatedAt ? ` <small class="muted">· ${new Date(t.updatedAt).toLocaleDateString('es', { day: 'numeric', month: 'short' })}</small>` : ''}</span>
				<span class="chip ${t.status}">${STATUS[t.status] ?? t.status}</span></button>`,
		)
		.join('')

	$('modalBody').innerHTML = `<div class="stack peer">
		<div class="peer-head">
			<span class="avatar lg" aria-hidden="true">${esc(name.slice(0, 2))}</span>
			<div><h3>@${esc(name)}${isMe ? ' <span class="badge info">tú</span>' : ''}</h3><div class="peer-badges">${badges || '<span class="muted small">Sin datos de verificación</span>'}</div></div>
		</div>
		<div class="peer-stats">
			${stat('Operaciones', ops != null ? ops.toLocaleString('es') : '—', p ? `${p.opsOwner.toLocaleString('es')} publicando · ${p.opsTaker.toLocaleString('es')} tomando` : '')}
			${stat('Valoración', rating != null ? `⭐ ${rating.toFixed(2).replace('.', ',')}` : '—', p ? `${p.ratings.toLocaleString('es')} valoraciones` : '')}
			${stat('Ofertas abiertas', String(d.offers.length), d.offers.length ? `${fmtM(d.offers.reduce((s, o) => s + o.usd, 0))} USD en total` : '')}
		</div>
		${rank ? `<p class="rank-line">🏆 Ranking: ${esc(rank)}</p>` : ''}
		${signals.length ? `<ul class="peer-signals">${signals.map(([k, t]) => `<li class="${k}">${esc(t)}</li>`).join('')}</ul>` : ''}
		<div><p class="hint">Ofertas abiertas ahora</p>${offers ? `<div class="peer-offers">${offers}</div>` : '<p class="muted small">No tiene ofertas publicadas ahora.</p>'}</div>
		${
			isMe
				? ''
				: `<div><p class="hint">Tu historial con @${esc(name)}</p>${
						together.length
							? `<p class="small">${together.length} ${together.length === 1 ? 'operación' : 'operaciones'} entre tus últimas · ${done.length} completadas${vol ? ` · ${fmtM(vol)} USD` : ''}</p><div class="peer-trades">${history}</div>`
							: '<p class="muted small">No has operado con este usuario (en tus últimas operaciones).</p>'
					}</div>`
		}
	</div>`
	for (const b of $('modalBody').querySelectorAll('[data-peer-offer]')) b.onclick = () => showTakeOfferById(b.dataset.peerOffer)
	for (const b of $('modalBody').querySelectorAll('[data-peer-trade]')) b.onclick = () => openTrade(b.dataset.peerTrade, b.dataset.order || null)
}

// ── Vender ya: vender saldo a la mejor oferta de compra de una cuenta VIP ──
// Se ve como un swap: pones cuántos USD vendes y dónde quieres el dinero, y el terminal elige la
// oferta VIP que más paga en la que cabe ese monto. Por dentro es una operación P2P normal:
// tus USD quedan en el escrow de QvaPay y el VIP te transfiere a los datos que le pasas por el chat
const SWAP_REFRESH_MS = 15_000

async function showSwap() {
	const markets = state.overview.length ? state.overview : [{ tick: state.coin, name: nameOf(state.coin) }]
	const sw = { coin: store.get('swap.coin', 'BANK_CUP'), amount: store.get('swap.amount', 100), quote: null, loading: false, error: '', timer: null, seq: 0, tried: 0 }
	if (!markets.some((m) => m.tick === sw.coin)) sw.coin = markets[0].tick
	openModal(
		`<div class="stack swap">
		<div class="swap-head"><h3>Vender</h3></div>
		<p class="muted swap-sub">Vende tu saldo de QvaPay y recibe el dinero en tu cuenta.</p>
		<div class="swap-box">
			<div class="swap-row"><span>Vendes</span>${bk.acct.connected ? `<button type="button" class="link small" id="swMax">Saldo: <b class="mono">${fmtM(bk.acct.balance ?? 0)}</b> USD</button>` : ''}</div>
			<div class="swap-main">
				<input class="swap-input mono" id="swAmount" type="number" min="0" step="0.01" inputmode="decimal" value="${sw.amount}" aria-label="USD que vendes" />
				<span class="swap-asset"><span class="swap-coin usd">$</span>USD QvaPay</span>
			</div>
		</div>
		<div class="swap-arrow" aria-hidden="true"><svg viewBox="0 0 24 24" width="18" height="18"><path d="M12 5v14M6 13l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg></div>
		<div class="swap-box">
			<div class="swap-row"><span>Recibes</span><span class="swap-age" id="swAge"></span></div>
			<div class="swap-main">
				<b class="swap-out mono" id="swOut">—</b>
				<select class="swap-select" id="swCoin" aria-label="Dónde recibes el dinero">${markets.map((m) => `<option value="${m.tick}" ${m.tick === sw.coin ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</select>
			</div>
		</div>
		<div id="swQuote" class="swap-quote"></div>
		<div id="swDetailsBox" class="stack tight">
			<div class="swap-saved" id="swSaved" hidden></div>
			<div id="swEdit" class="stack tight">
				<p class="hint">Dónde quieres recibir el pago (se lo enviamos al VIP por el chat de la operación)</p>
				<div class="saved-methods" id="swMethods" hidden></div>
				<div id="swDetails" class="stack tight"></div>
				<label class="check"><input type="checkbox" id="swRemember" /> Recordar en este navegador</label>
			</div>
		</div>
		${bk.acct.connected ? '<button class="btn buy block swap-go" id="swGo" disabled>Vender</button>' : '<button class="btn primary block" id="swConnect">Conectar QvaPay para vender</button>'}
		<p class="hint swap-foot">Tus USD quedan en el escrow de QvaPay hasta que el VIP te paga. En las ventas a cuentas VIP no tienes que liberar tú. Sigues la venta en «Mis operaciones».</p>
	</div>`,
		() => clearInterval(sw.timer),
	)
	$('swConnect')?.addEventListener('click', showConnect)

	const fields = bk.acct.connected ? await loadCoinFields() : {}
	const amount = () => num2($('swAmount')?.value)
	// No se puede vender más saldo del que tienes
	const maxUsd = () => (bk.acct.connected ? Math.floor((bk.acct.balance ?? 0) * 100) / 100 : Infinity)
	const clamp = () => {
		if (amount() > maxUsd()) $('swAmount').value = String(maxUsd())
	}
	// El saldo se pide al abrir y, si cambia mientras está abierto, se aplica
	const onBalance = () => {
		if (!$('swAmount')) return document.removeEventListener('tp:balance', onBalance)
		if ($('swMax')) $('swMax').innerHTML = `Saldo: <b class="mono">${fmtM(bk.acct.balance ?? 0)}</b> USD`
		clamp()
		render()
	}
	document.addEventListener('tp:balance', onBalance)
	refreshBalance(true)
	const unit = () => unitOf(sw.coin)

	const renderDetails = () => {
		const box = $('swDetailsBox')
		if (!box) return
		box.hidden = !bk.acct.connected
		const saved = store.get(`details.${sw.coin}`, {})
		const list = fields[sw.coin] ?? []
		$('swRemember').checked = Object.keys(saved).length > 0
		$('swDetails').innerHTML = list.length
			? list
					.map((f) => {
						const label = esc(f.label || f.name)
						return f.type === 'select' && f.options?.length
							? `<label class="field">${label}<select class="input" data-sw-detail="${esc(f.name)}" data-label="${label}">${f.options.map((o) => `<option ${o.value === saved[f.name] ? 'selected' : ''}>${esc(o.value)}</option>`).join('')}</select></label>`
							: `<label class="field">${label}<input class="input" data-sw-detail="${esc(f.name)}" data-label="${label}" value="${esc(saved[f.name] ?? '')}" placeholder="${esc(f.placeholder ?? '')}" autocomplete="off" /></label>`
					})
					.join('')
			: '<p class="notice warn">No se pudieron cargar los campos de pago de este mercado. Cierra y vuelve a abrir.</p>'
		for (const i of $('swDetails').querySelectorAll('[data-sw-detail]')) i.addEventListener('input', render)
		savedMethodChips($('swMethods'), sw.methods, sw.coin, () => [...$('swDetails').querySelectorAll('[data-sw-detail]')], (el) => el.dataset.swDetail)
		// Con los datos ya guardados basta un resumen; se editan con «Cambiar»
		const complete = list.length > 0 && list.every((f) => saved[f.name])
		$('swSaved').hidden = !complete
		$('swEdit').hidden = complete
		if (complete) {
			const card = list.find((f) => /tarjeta|cuenta|card/i.test(f.name))
			const shown = card ? `${esc(card.label || card.name)} <b>···· ${esc(String(saved[card.name]).replace(/\s/g, '').slice(-4))}</b>` : `<b>${esc(saved[list[0].name])}</b>`
			$('swSaved').innerHTML = `<span>Cobras en ${shown}</span><button type="button" class="link small" id="swChange">Cambiar</button>`
			$('swChange').onclick = () => {
				$('swSaved').hidden = true
				$('swEdit').hidden = false
			}
		}
	}
	const details = () => [...document.querySelectorAll('[data-sw-detail]')].map((i) => ({ name: i.dataset.swDetail, label: i.dataset.label, value: i.value.trim() }))

	// Montos que sí caben, para cuando ninguna oferta acepta el que pusiste
	// Solo las que tu saldo alcanza
	const reachable = (offers) => offers.filter((o) => (o.kind === 'flexible' ? (o.orderMin ?? 0) : o.usd) <= maxUsd())
	const options = (offers) =>
		reachable(offers)
			.slice(0, 4)
			.map((o) => {
				const target = o.kind === 'flexible' ? Math.min(Math.max(amount() || 0, o.orderMin ?? 0), o.orderMax ?? o.usd, maxUsd()) : o.usd
				const range = o.kind === 'flexible' ? `${o.orderMin ? fmtM(o.orderMin) : '0'}–${fmtM(o.orderMax ?? o.usd)} USD` : `${fmtM(o.usd)} USD exactos`
				return `<button type="button" class="chip-btn" data-sw-pick="${target}">${range} a <b class="mono">${fmtP(o.price)}</b></button>`
			})
			.join('')

	function render() {
		if (!$('swOut')) return
		const q = sw.quote
		const best = q?.best
		const a = amount()
		$('swOut').textContent = best && a > 0 ? fmtM(a * best.price) : '—'
		$('swOut').classList.toggle('dim', !best)
		renderAge()
		let html = ''
		if (!bk.acct.connected) html = '<p class="notice">Para ver los precios de los VIP y vender, conecta tu cuenta de QvaPay con tu token.</p>'
		else if (sw.error) html = `<p class="notice warn">${esc(sw.error)}</p>`
		else if (!q) html = '<p class="hint">Buscando ofertas VIP…</p>'
		else if (!q.offers.length) html = `<p class="notice warn">Ahora mismo ningún VIP compra USD en ${esc(nameOf(sw.coin))}. Prueba otro mercado o vuelve en un rato.</p>`
		else if (!best && !reachable(q.offers).length)
			html = `<p class="notice warn">${maxUsd() > 0 ? `Con tu saldo (${fmtM(maxUsd())} USD) no llegas al mínimo de ningún VIP en este mercado.` : 'No tienes saldo en QvaPay para vender.'}</p>`
		else if (!best)
			html = `<p class="notice warn">${a > 0 ? `Ningún VIP compra ${fmtM(a)} USD de una vez en este mercado.` : 'Pon cuántos USD vendes.'} Montos posibles:</p><div class="swap-picks">${options(q.offers)}</div>`
		else {
			html = `<div class="kv swap-kv">
				<span>Precio</span><b>1 USD = ${fmtP(best.price)} ${esc(unit())}</b><span></span>
				<span>Compra</span><b>@${esc(best.user)} <span class="badge ok">VIP</span>${best.gold ? ' <span class="badge warn">GOLD</span>' : ''}</b><span></span>
				<span>Reputación</span><b>${best.rating ? `⭐ ${best.rating.toFixed(2).replace('.', ',')}` : 'sin valoraciones'}${best.ops != null ? ` · ${best.ops.toLocaleString('es')} operaciones` : ''}</b><span></span>
			</div>`
		}
		$('swQuote').innerHTML = html
		const go = $('swGo')
		if (go) {
			const missing = details().some((d) => !d.value)
			const over = a > maxUsd()
			go.disabled = !best || !(a > 0) || missing || over || sw.loading
			go.textContent = maxUsd() <= 0 ? 'No tienes saldo en QvaPay' : !best ? 'Vender' : over ? 'No tienes saldo suficiente' : missing ? 'Completa dónde recibes el pago' : `Vender ${fmtM(a)} USD por ${fmtM(a * best.price)} ${unit()}`
		}
	}

	function renderAge() {
		const q = sw.quote
		if ($('swAge')) $('swAge').textContent = sw.loading ? 'Actualizando…' : q ? `Precio de hace ${Math.max(0, Math.round((Date.now() - q.at) / 1000))} s` : ''
	}

	async function quote(fresh = false) {
		if (!bk.acct.connected) return render()
		const seq = ++sw.seq
		sw.tried = Date.now()
		sw.loading = true
		render()
		try {
			const q = await api(`/swap/quote?coin=${sw.coin}&amount=${amount() || 0}${fresh ? '&fresh=1' : ''}`)
			if (seq !== sw.seq) return
			sw.quote = q
			sw.error = ''
		} catch (e) {
			if (seq !== sw.seq) return
			sw.error = e.message
		}
		sw.loading = false
		render()
	}

	let typing = null
	$('swAmount').addEventListener('input', () => {
		clamp()
		store.set('swap.amount', amount())
		render()
		clearTimeout(typing)
		typing = setTimeout(() => quote(), 250)
	})
	$('swCoin').addEventListener('change', () => {
		sw.coin = $('swCoin').value
		store.set('swap.coin', sw.coin)
		sw.quote = null
		renderDetails()
		quote()
	})
	$('swMax')?.addEventListener('click', () => {
		$('swAmount').value = String(Math.floor((bk.acct.balance ?? 0) * 100) / 100)
		$('swAmount').dispatchEvent(new Event('input'))
	})
	$('swQuote').addEventListener('click', (e) => {
		const b = e.target.closest('[data-sw-pick]')
		if (!b) return
		$('swAmount').value = b.dataset.swPick
		$('swAmount').dispatchEvent(new Event('input'))
	})
	$('swGo')?.addEventListener('click', async () => {
		const best = sw.quote?.best
		const a = amount()
		if (!best) return
		const d = details()
		const total = a * best.price
		const ok = await askConfirm(
			'Confirmar venta',
			`<div class="kv">
				<span>Vendes</span><b>${fmtM(a)} USD</b><span></span>
				<span>Recibes</span><b>${fmtM(total)} ${esc(unit())}</b><span></span>
				<span>En</span><b>${esc(nameOf(sw.coin))}</b><span></span>
				<span>Compra</span><b>@${esc(best.user)} (VIP)</b><span></span>
				${d.map((x) => `<span>${x.label}</span><b>${esc(x.value)}</b><span></span>`).join('')}
			</div>
			<p class="notice">Se reservan ${fmtM(a)} USD de tu saldo en el escrow de QvaPay y se le envían tus datos al VIP por el chat para que te pague.</p>`,
			'Vender',
			'buy',
		)
		if (!ok) return
		const btn = $('swGo')
		btn.disabled = true
		btn.textContent = 'Vendiendo…'
		try {
			const r = await api('/swap', { offer: best.offer, amount: a, minPrice: best.price, details: d })
			markOrigin(r.offer)
			if ($('swRemember').checked) store.set(`details.${sw.coin}`, Object.fromEntries(d.map((x) => [x.name, x.value])))
			else store.set(`details.${sw.coin}`, {})
			toast(r.chatSent ? `Venta en marcha: @${best.user} ya tiene tus datos para pagarte` : 'Venta en marcha. No se pudo enviar el chat: manda tus datos de pago a mano', !r.chatSent)
			bk.tab = 'active'
			await loadTrades()
			loadBook()
			openTrade(r.offer, r.order)
		} catch (e) {
			toast(e.message, true)
			// Si la oferta cambió o se agotó, se busca de nuevo la mejor
			if (e.status === 409) quote(true)
			else render()
		}
	})

	clamp()
	renderDetails()
	// Tus métodos guardados en QvaPay: llegan después y solo añaden los botones (lo que ya escribiste se queda)
	if (bk.acct.connected)
		loadPaymentMethods().then((list) => {
			sw.methods = list
			savedMethodChips($('swMethods'), sw.methods, sw.coin, () => [...$('swDetails').querySelectorAll('[data-sw-detail]')], (el) => el.dataset.swDetail)
		})
	// Cada segundo la edad del precio; cada SWAP_REFRESH_MS, precio nuevo
	sw.timer = setInterval(() => {
		if (document.hidden || sw.loading) return
		if (bk.acct.connected && Date.now() - Math.max(sw.quote?.at ?? 0, sw.tried) >= SWAP_REFRESH_MS) quote(true)
		else renderAge()
	}, 1000)
	await quote(true)
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

// ── Métricas anónimas ─────────────────────────────────────────────────
// Se recuerdan (solo en este navegador) las ofertas publicadas o tomadas desde aquí. Cuando una
// se completa porque la liberó la contraparte, se avisa al servidor sin usuario ni token: así se
// cuentan también las operaciones que terminan en la web de QvaPay (ver worker/metrics.ts)
const ORIGIN_KEY = 'tp.origin'
function origin() {
	const o = store.get(ORIGIN_KEY, null)
	return o && typeof o === 'object' && o.offers ? o : { offers: {}, reported: {} }
}
function markOrigin(uuid) {
	if (!uuid) return
	const o = origin()
	o.offers[uuid] = Date.now()
	// Las últimas 300 bastan
	const keep = Object.entries(o.offers).sort((a, b) => b[1] - a[1]).slice(0, 300)
	o.offers = Object.fromEntries(keep)
	store.set(ORIGIN_KEY, o)
}
function reportCompleted(a) {
	const o = origin()
	const key = `${a.offer}:${a.order ?? ''}`
	if (!o.offers[a.offer] || o.reported[key]) return
	o.reported[key] = Date.now()
	o.reported = Object.fromEntries(Object.entries(o.reported).sort((x, y) => y[1] - x[1]).slice(0, 300))
	store.set(ORIGIN_KEY, o)
	const t = bk.trades.find((x) => x.offerUuid === a.offer && (x.order ?? '') === (a.order ?? ''))
	fetch('/data/event', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ event: 'completed', offer: a.offer, order: a.order ?? undefined, coin: t?.coin, side: t?.offerType, usd: t?.usd }),
		keepalive: true,
	}).catch(() => {})
}

function deliver(alerts) {
	if (!alerts.length) return
	for (const a of alerts) if (a.kind === 'released') reportCompleted(a)
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
				// Si la contraparte se fue, la oferta vuelve a ser tuya y se gestiona; si no, se abre la operación
				if (a.kind === 'left') showManageOffer(a.offer)
				else openTrade(a.offer, a.order)
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
		if (e.key !== 'Escape' || $('modal').hidden) return
		// Escape cierra primero la confirmación abierta, y solo después la ventana
		const layer = document.querySelector('.confirm-layer [data-c="no"]')
		if (layer) layer.click()
		else closeModal()
	})
	$('refreshTrades').onclick = loadTrades
	$('alertsBtn').onclick = toggleAlerts
	for (const b of document.querySelectorAll('[data-new-offer]')) b.addEventListener('click', () => showCreateOffer())
	for (const b of document.querySelectorAll('[data-swap]')) b.addEventListener('click', showSwap)
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
				loadBook()
			} catch (err) {
				toast(err.message, true)
				// Si alguien la acaba de tomar, pasa a «En curso» y se abre la operación
				if (err.status === 409) {
					bk.tab = 'active'
					await loadTrades()
					showManageOffer(cancel.dataset.cancelBtn)
				}
			}
			return
		}
		const row = e.target.closest('tr[data-offer]')
		if (!row) return
		if (bk.tab === 'offers') showManageOffer(row.dataset.offer)
		else openTrade(row.dataset.offer, row.dataset.order || null)
	})
	for (const t of document.querySelectorAll('#ordersTabs [data-tab]'))
		t.addEventListener('click', () => {
			bk.tab = t.dataset.tab
			renderTrades()
		})
}

// Enlace directo a una oferta: app.terminalp2p.com/#p2p/<uuid>
const OFFER_LINK = /^#p2p\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i
function openOfferLink() {
	const m = OFFER_LINK.exec(location.hash)
	if (!m) return
	history.replaceState(null, '', location.pathname + location.search) // que recargar no la vuelva a abrir
	showTakeOfferById(m[1].toLowerCase())
}
window.addEventListener('hashchange', openOfferLink)

bindBroker()
loadAccount().then(openOfferLink)
// Con la pestaña visible, cada 15 s. En segundo plano solo con los avisos activos
// y algo que vigilar (operaciones en curso u ofertas publicadas), cada 30 s
let tradeTicks = 0
setInterval(() => {
	tradeTicks++
	if (!bk.acct.connected) return
	if (!document.hidden) {
		refreshBalance()
		return loadTrades()
	}
	const watching = bk.openOffers.length || bk.trades.some((t) => t.status !== 'completed')
	if (bk.alerts && watching && tradeTicks % 2 === 0) loadTrades()
}, 15_000)
setInterval(() => !document.hidden && tickClocks(), 1000)
setInterval(() => !document.hidden && bk.detail && refreshDetail(), 8_000)
