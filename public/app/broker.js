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
			? `<table class="otable">${head([...common, ['Estado'], ['Publicada'], ['', 'r']])}<tbody>${bk.openOffers
					.map(
						(o) => `<tr data-offer="${o.offerUuid}">
							<td>${side(o)}</td><td>${esc(nameOf(o.coin))}</td>
							<td class="r num">${fmtU(o.kind === 'flexible' ? (o.available ?? o.usd) : o.usd)}</td><td class="r num">${fmtP(o.price)}</td><td class="r num">${fmtU((o.kind === 'flexible' ? (o.available ?? o.usd) : o.usd) * o.price)} ${esc(unitOf(o.coin))}</td>
							<td>${o.pause ? '<span class="chip revision">Pausada</span>' : '<span class="chip open">En el mercado</span>'}${o.kind === 'flexible' ? ' <span class="chip">Por partes</span>' : ''}${o.isPrivate ? ' <span class="chip">Privada</span>' : ''}</td>
							<td class="muted">${o.updatedAt ? new Date(o.updatedAt).toLocaleString('es', { dateStyle: 'short', timeStyle: 'short' }) : '—'}</td>
							<td class="r"><button class="btn danger sm" data-cancel-btn="${o.offerUuid}">Cancelar</button></td></tr>`,
					)
					.join('')}</tbody></table>`
			: '<div class="empty">No tienes ofertas publicadas. Usa «Publicar oferta» para crear una.</div>'
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

// ── Publicar una oferta ───────────────────────────────────────────────
let coinFields = null
async function loadCoinFields() {
	if (!coinFields) coinFields = await api('/coins').then((r) => r.fields).catch(() => null)
	return coinFields ?? {}
}

const REQ_OPTIONS = {
	min_completed: ['Operaciones completadas', [5, 10, 25, 50, 100], (v) => `${v} o más`],
	min_rating: ['Valoración', [4, 4.5], (v) => `${String(v).replace('.', ',')} ★ o más`],
	min_account_days: ['Antigüedad de la cuenta', [7, 30, 90, 180], (v) => `${v} días o más`],
}
const reqText = (r) =>
	r
		? Object.entries(r)
				.filter(([k, v]) => v && REQ_OPTIONS[k])
				.map(([k, v]) => `${REQ_OPTIONS[k][0]}: ${REQ_OPTIONS[k][2](v)}`)
				.join(' · ')
		: ''
const num2 = (v) => Math.round(Number(v) * 100) / 100

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
		return { refs: [['Mejor venta', asks[0]?.price], ['Mejor compra', bids[0]?.price], ['Mediana completadas', m]].filter(([, p]) => p), mid: m }
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
	const levels = filtered(type === 'sell' ? b.ask.levels : b.bid.levels).filter((l) => l.user !== myUsername())
	return levels.filter((l) => (type === 'sell' ? l.price < price : l.price > price)).length + 1
}

function priceWarning(type, price, mid) {
	if (!mid || !(price > 0)) return ''
	const dev = price / mid - 1
	if (Math.abs(dev) > 0.3) return `Tu precio está un ${pct(Math.abs(dev)).slice(1)} ${dev > 0 ? 'por encima' : 'por debajo'} de la referencia. ¿Es un error de tipeo?`
	if (type === 'sell' && dev < -0.03) return `Vendes un ${pct(-dev).slice(1)} por debajo de la referencia (${fmtP(mid)}).`
	if (type === 'buy' && dev > 0.03) return `Compras un ${pct(dev).slice(1)} por encima de la referencia (${fmtP(mid)}).`
	return ''
}

async function showCreateOffer() {
	if (!bk.acct.connected) return toast('Conecta tu cuenta de QvaPay (arriba a la derecha) para publicar', true)
	const markets = state.overview.length ? state.overview : [{ tick: state.coin, name: nameOf(state.coin), unit: unitOf(state.coin) }]
	const key = `tp-${crypto.randomUUID()}` // misma clave si se reintenta: QvaPay no la duplica
	let type = 'sell'
	openModal(`<div class="stack offer-form">
		<div id="ofForm" class="stack">
			<h3>Publicar oferta</h3>
			<div class="seg-tabs choice" role="radiogroup" aria-label="Lado">
				<button type="button" class="seg-tab" data-type="sell" role="radio">Vendo USD</button>
				<button type="button" class="seg-tab" data-type="buy" role="radio">Compro USD</button>
			</div>
			<label class="field">Mercado<select class="input" id="ofCoin">${markets.map((c) => `<option value="${c.tick}">${esc(c.name)}</option>`).join('')}</select></label>
			<div class="grid2">
				<label class="field">Monto (USD)<input class="input" id="ofAmount" type="number" min="0.1" max="10000" step="0.01" inputmode="decimal" placeholder="100" /></label>
				<label class="field"><span>Precio por USD (<span id="ofUnit"></span>)</span><input class="input" id="ofPrice" type="number" min="0" step="any" inputmode="decimal" /></label>
			</div>
			<div class="ref-chips" id="ofRefs"></div>
			<p class="hint" id="ofTotal"></p>
			<label class="check"><input type="checkbox" id="ofFlex" /> Por rango: que la tomen por partes</label>
			<div class="grid2" id="ofFlexBox" hidden>
				<label class="field">Mínimo por orden (USD)<input class="input" id="ofMin" type="number" step="0.01" inputmode="decimal" /></label>
				<label class="field">Máximo por orden (USD)<input class="input" id="ofMax" type="number" step="0.01" inputmode="decimal" /></label>
			</div>
			<div class="stack tight"><p class="hint" id="ofDetailsTitle"></p><div class="stack tight" id="ofDetails"><p class="muted small">Cargando campos…</p></div>
				<label class="check small"><input type="checkbox" id="ofRemember" /> Recordar estos datos en este navegador</label></div>
			<details class="opts"><summary>Requisitos y visibilidad</summary><div class="stack tight">
				${Object.entries(REQ_OPTIONS)
					.map(([k, [label, vals, fmt]]) => `<label class="field">${label}<select class="input" data-req="${k}"><option value="0">Sin requisito</option>${vals.map((v) => `<option value="${v}">${fmt(v)}</option>`).join('')}</select></label>`)
					.join('')}
				<label class="check"><input type="checkbox" id="ofPrivate" checked /> Privada: no se anuncia en el canal de Telegram de QvaPay</label>
				<label class="check"><input type="checkbox" id="ofVip" /> Solo cuentas VIP</label>
			</div></details>
			<div id="ofWarn"></div>
			<button class="btn primary block" id="ofReview">Revisar</button>
		</div>
		<div id="ofConfirm" class="stack" hidden></div>
	</div>`)
	$('ofCoin').value = state.coin

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
	}
	const update = () => {
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
			? `${type === 'sell' ? 'Recibirás' : 'Pagarás'} <b>${fmtU(total)} ${unit}</b>${rank ? ` · serías la <b>${rank}ª</b> ${type === 'sell' ? 'venta' : 'compra'} del libro` : ''}`
			: ''
		const w = priceWarning(type, f.price, mid)
		$('ofWarn').innerHTML = w ? `<p class="notice warn">${w}</p>` : ''
	}
	renderDetails()
	update()

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
			!(f.amount >= 0.1 && f.amount <= 10000)
				? 'El monto debe estar entre 0,1 y 10.000 USD'
				: !(f.price > 0)
					? 'Pon el precio por cada USD'
					: f.kind === 'flexible' && !(f.orderMin > 0 && f.orderMax >= f.orderMin && f.orderMax <= f.amount)
						? 'Revisa el mínimo y el máximo por orden: mínimo ≤ máximo ≤ monto'
						: f.details.some((d) => !d.value)
							? 'Completa todos tus datos de pago'
							: ''
		if (err) return toast(err, true)
		const total = f.amount * f.price
		const req = reqText(f.requirements)
		$('ofForm').hidden = true
		$('ofConfirm').hidden = false
		$('ofConfirm').innerHTML = `<h3>Revisa tu oferta</h3>
			<div class="kv">
				<span>${type === 'sell' ? 'Vendes' : 'Compras'}</span><b>${fmtU(f.amount)} USD</b><span></span>
				<span>Precio</span><b>${fmtP(f.price)} ${unit}</b><span></span>
				<span>${type === 'sell' ? 'Recibes' : 'Pagas'}</span><b>${fmtU(total)} ${unit}</b><span></span>
				<span>Mercado</span><b>${esc(nameOf(f.coin))}</b><span></span>
				${f.kind === 'flexible' ? `<span>Por partes</span><b>${fmtU(f.orderMin)}–${fmtU(f.orderMax)} USD</b><span></span>` : ''}
				${req ? `<span>Requisitos</span><b>${esc(req)}</b><span></span>` : ''}
				<span>Visibilidad</span><b>${f.private ? 'Privada' : 'Pública en Telegram'}${f.onlyVip ? ' · solo VIP' : ''}</b><span></span>
			</div>
			<p class="notice">${
				type === 'sell'
					? `Se reservan <b>${fmtU(f.amount)} USD</b> de tu saldo mientras la oferta esté publicada. Cuando alguien la tome, te pagará a tus datos y liberarás los USD al ver el dinero.`
					: `No se reserva saldo. Cuando alguien la tome, tendrás que transferirle <b>${fmtU(total)} ${unit}</b> a sus datos y marcar el pago.`
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
		<div><h3>${o.type === 'sell' ? 'Vendes' : 'Compras'} ${fmtU(amount)} USD a ${fmtP(o.price)} ${unit}</h3>
			<p class="muted">${esc(nameOf(o.coin))} · <span class="chip ${o.status}">${STATUS[o.status] ?? o.status}</span>${o.isPrivate ? ' · Privada' : ''}${flex ? ` · Por partes de ${fmtU(o.orderMin)}–${fmtU(o.orderMax)} USD` : ''}</p></div>
		${o.pause ? `<p class="notice warn">${pauseText(o.pause)}</p>` : rank ? `<p class="hint">Ahora mismo es la <b>${rank}ª</b> ${o.type === 'sell' ? 'venta' : 'compra'} del libro.</p>` : ''}
		${o.status !== 'open' ? `<p class="notice">Alguien tomó esta oferta. <button class="link" data-open-trade>Ver la operación</button></p>` : ''}
		${
			editable
				? `<div class="stack tight"><p class="hint">Cambiar precio o monto</p>
				<div class="grid2">
					<label class="field">${flex ? 'Disponible' : 'Monto'} (USD)<input class="input" id="edAmount" type="number" step="0.01" inputmode="decimal" value="${amount}" /></label>
					<label class="field">Precio por USD (${unit})<input class="input" id="edPrice" type="number" step="any" inputmode="decimal" value="${Math.round(o.price * 10000) / 10000}" /></label>
					${flex ? `<label class="field">Mínimo por orden<input class="input" id="edMin" type="number" step="0.01" value="${o.orderMin ?? ''}" /></label><label class="field">Máximo por orden<input class="input" id="edMax" type="number" step="0.01" value="${o.orderMax ?? ''}" /></label>` : ''}
				</div>
				<p class="hint" id="edTotal"></p><div id="edWarn"></div>
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
								`<tr data-order-row="${x.order}"><td class="num">${fmtU(x.usd)} USD</td><td class="num">${fmtU(x.coinAmount)} ${unit}</td><td>@${esc(x.taker ?? '—')}</td><td><span class="chip ${x.status}">${STATUS[x.status] ?? x.status}</span></td></tr>`,
						)
						.join('')}</tbody></table></div>`
				: ''
		}
		<div class="row-btns">
			${o.status === 'open' ? `<button class="btn" id="mgPause">${o.pause ? 'Volver a publicar' : 'Pausar'}</button><button class="btn danger" id="mgCancel">Cancelar oferta</button>` : ''}
		</div>
		<p class="hint"><a class="link" href="https://www.qvapay.com/p2p/${o.offer}" target="_blank" rel="noopener">Abrir en QvaPay</a></p>
	</div>`

	const refresh = () => showManageOffer(o.offer)
	if (editable) {
		const upd = () => {
			const a = num2($('edAmount').value)
			const p = Number($('edPrice').value)
			$('edTotal').innerHTML = a > 0 && p > 0 ? `${o.type === 'sell' ? 'Recibirás' : 'Pagarás'} <b>${fmtU(a * p)} ${unit}</b>` : ''
			const w = priceWarning(o.type, p, marketRefs(o.coin).mid)
			$('edWarn').innerHTML = w ? `<p class="notice warn">${w}</p>` : ''
		}
		for (const id of ['edAmount', 'edPrice']) $(id).addEventListener('input', upd)
		upd()
		$('edSave').onclick = async () => {
			const btn = $('edSave')
			btn.disabled = true
			try {
				const r = await api('/offer/edit', {
					offer: o.offer,
					amount: num2($('edAmount').value),
					price: Number($('edPrice').value),
					orderMin: flex ? num2($('edMin').value) : undefined,
					orderMax: flex ? num2($('edMax').value) : undefined,
				})
				toast(r.message)
				loadTrades()
				loadBook()
				refresh()
			} catch (e) {
				btn.disabled = false
				toast(e.message, true)
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
		} catch (e) {
			toast(e.message, true)
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
	const unit = state.book.coin.unit
	// En una venta ajena compras USD (pagas tú); en una compra ajena vendes USD (te pagan)
	const youBuy = side === 'ask'
	const flex = l.kind === 'flexible'
	const max = flex ? Math.min(l.orderMax ?? l.usd, l.usd) : l.usd
	const min = flex ? (l.orderMin ?? 0) : l.usd
	const req = reqText(l.requirements)
	openModal(`<div class="stack">
		<div><h3>${youBuy ? 'Comprar' : 'Vender'} USD a ${fmtP(l.price)} ${unit}</h3>
			<p class="muted">${esc(nameOf(state.book.coin.tick))} · @${esc(l.user)} · ${l.ops} operaciones · ${l.rating ? `⭐ ${l.rating.toFixed(2)}` : 'sin valoraciones'}${l.kyc ? ' · KYC' : ''}</p></div>
		<div class="kv">
			<span>${youBuy ? 'Vende' : 'Compra'}</span><b>${fmtU(l.usd)} USD</b><span></span>
			${flex ? `<span>Por orden</span><b>${fmtU(min)}–${fmtU(max)} USD</b><span></span>` : ''}
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
		$('tkTotal').innerHTML = a > 0 ? `${youBuy ? 'Pagas' : 'Recibes'} <b>${fmtU(total)} ${unit}</b> por <b>${fmtU(a)} USD</b>` : ''
		if ($('tkGo')) $('tkGo').textContent = `Tomar: ${youBuy ? 'comprar' : 'vender'} ${fmtU(a)} USD`
	}
	$('tkAmount')?.addEventListener('input', upd)
	upd()
	$('tkGo')?.addEventListener('click', async () => {
		const a = amount()
		if (flex && !(a >= min && a <= max)) return toast(`El monto debe estar entre ${fmtU(min)} y ${fmtU(max)} USD`, true)
		const btn = $('tkGo')
		btn.disabled = true
		btn.textContent = 'Tomando…'
		try {
			const r = await api('/offer/apply', { offer: uuid, amount: flex ? a : undefined })
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
	for (const b of document.querySelectorAll('[data-new-offer]')) b.addEventListener('click', showCreateOffer)
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
