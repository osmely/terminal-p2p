// Broker no custodio — interfaz. Usa los helpers de app.js ($, state, fmtP, fmtU, esc, store, pct).

const bk = {
	acct: { connected: false, dryRun: true },
	tab: 'active',
	trades: [],
	openOffers: [],
	detail: null, // { offer, order }
	alerts: store.get('alerts', false), // notificaciones y sonido activados
	cancelling: new Set(), // ofertas que se están cancelando ahora (su botón dice «Cancelando…»)
	released: new Map(), // «oferta:orden» que liberaste y cuándo: QvaPay sigue diciendo «pagado» unos segundos
}
const BASE_TITLE = document.title

const STATUS = {
	open: tl('broker.stOpen'),
	processing: tl('broker.stProcessing'),
	paid: tl('broker.stPaid'),
	revision: tl('broker.stRevision'),
	completed: tl('broker.stCompleted'),
	cancelled: tl('broker.stCancelled'),
}

// ── API ───────────────────────────────────────────────────────────────
async function api(path, body) {
	const opts = body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Broker': '1' }, body: JSON.stringify(body) }
	const r = await TPApi.fetch(`/api/broker${path}`, opts)
	const data = await r.json().catch(() => ({}))
	if (!r.ok) {
		// Bloqueada en Terminal P2P con el terminal abierto: se relee la cuenta, que lo dice y la desconecta
		if (data.code === 'TP_ACCOUNT_BLOCKED' && path !== '/me') loadAccount()
		throw Object.assign(new Error(data.error || `Error ${r.status}`), { status: r.status, code: data.code, fresh: data.fresh })
	}
	return data
}

// Un formulario con archivo (la imagen del chat): sin Content-Type, lo pone el navegador
async function apiForm(path, form) {
	const r = await TPApi.fetch(`/api/broker${path}`, { method: 'POST', headers: { 'X-Broker': '1' }, body: form })
	const data = await r.json().catch(() => ({}))
	if (!r.ok) throw Object.assign(new Error(data.error || `Error ${r.status}`), { status: r.status })
	return data
}

// Las imágenes del chat y las fotos de perfil llegan como ruta de QvaPay (chat/123/456.jpg, profiles/…) y se sirven
// desde su dominio de archivos
const mediaUrl = (img) => {
	const v = String(img ?? '')
	if (/^https:\/\/media\.qvapay\.com\//.test(v)) return v
	return /^[\w./-]+$/.test(v) && !v.includes('..') ? `https://media.qvapay.com/${v.replace(/^\//, '')}` : null
}

// Foto de perfil con las iniciales debajo (si no hay foto o no carga, quedan ellas). Las fotos se recuerdan por
// usuario para ponerlas donde solo se sabe el nombre (al tomar una oferta abierta desde el libro). En el libro no van
const faces = new Map()
function rememberFace(user, img) {
	if (user && img) faces.set(String(user).toLowerCase(), img)
}
function avatar(user, img, cls = '') {
	const url = mediaUrl(img ?? faces.get(String(user ?? '').toLowerCase()))
	// Tu propia foto no lleva el punto de en línea
	const self = !!user && String(user).toLowerCase() === String(myUsername() ?? '').toLowerCase()
	const on = self ? '' : onlineCls(user)
	const attrs = self ? '' : `${onlineAttr(user)}${on ? ` title="${ONLINE_TITLE[onlineOf(user)] ?? tl('broker.notOnline')}"` : ''}`
	return `<span class="avatar ${cls}${on}"${attrs} aria-hidden="true">${esc(String(user ?? '?').slice(0, 2))}${url ? `<img src="${esc(url)}" alt="" loading="lazy" referrerpolicy="no-referrer" />` : ''}</span>`
}
document.addEventListener('error', (e) => e.target instanceof HTMLImageElement && e.target.parentElement?.classList.contains('avatar') && e.target.remove(), true)
// Los dueños de las ofertas del libro ya se consultan solos. Para los demás (con quien operas, una ficha abierta) se
// le pide al servidor que los siga: [{ id: uuid de QvaPay, u: usuario }]. Cada uno, como mucho cada 5 min
const onlineAsked = new Map()
function watchOnline(list) {
	const now = Date.now()
	const users = list.filter((x) => x?.id && x.u && now - (onlineAsked.get(x.id) ?? 0) > 5 * 60_000).slice(0, 20)
	if (!users.length) return
	for (const x of users) onlineAsked.set(x.id, now)
	fetch('/data/online', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ users: users.map((x) => ({ id: x.id, u: x.u })) }) })
		.then((r) => (r.ok ? r.json() : null))
		.then((r) => {
			if (!r?.term?.length && !r?.qp?.length) return
			window.TPOnline ??= new Map()
			for (const u of r.qp ?? []) if (!window.TPOnline.has(u)) window.TPOnline.set(u, 'qp')
			for (const u of r.term ?? []) window.TPOnline.set(u, 'term')
			paintOnline()
		})
		.catch(() => {})
}

// Antes de enviarla, la imagen se reduce a 1000 px como mucho y a JPG, lo mismo que deja QvaPay: se ve igual en el
// chat y sube antes con la conexión lenta. Un GIF pequeño va tal cual para no perder la animación
const CHAT_IMAGE_PX = 1000
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
	return new Promise((ok, fail) => canvas.toBlob((b) => (b ? ok(b) : fail(new Error(tl('broker.imagePrepFail')))), 'image/jpeg', 0.85))
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
const copyBtn = (value, label) => `<button class="copy" data-copy="${esc(value)}" title="${tl('broker.copyLabel', { label: esc(label) })}" aria-label="${tl('broker.copyLabel', { label: esc(label) })}">${ICON_COPY}</button>`

// Un mercado que el terminal no sigue (USDTBSC, BTC…) no está en el resumen: su unidad sale del nombre (USDTBSC → USDT),
// nunca la del mercado que tienes abierto (una operación en USDT salía «por 90 CUP»)
// Los demás salen con su código (PAYPAL, XRP…), salvo los que tienen una moneda clara
const CRYPTO_UNIT = /^(USDT|USDC|BUSD|BTC|ETH|LTC|BNB|TRX|DOGE|SOL|BCH|DASH|XMR|ADA)/
const OTHER_UNIT = { BANK: 'USD', BANK_INTL: 'USD', BANK_EUR: 'EUR', EURCASH: 'EUR', SBERBANK: 'RUB', PIX: 'BRL', MATICMAINNET: 'MATIC' }
const unitOf = (tick) =>
	state.overview.find((c) => c.tick === tick)?.unit ??
	(state.book?.coin?.tick === tick ? state.book.coin.unit : (OTHER_UNIT[tick] ?? String(tick ?? '').match(CRYPTO_UNIT)?.[1] ?? String(tick ?? '')))
const nameOf = (tick) => TPI18N.coin(tick, state.overview.find((c) => c.tick === tick)?.name ?? tick)

// ── Modal ─────────────────────────────────────────────────────────────
let onModalClose = null
// Mientras se ejecuta una orden inteligente la ventana no se cierra ni se sustituye: lo que pase debe verse
let modalLocked = false
function openModal(html, onClose) {
	if (modalLocked) return toast(tl('broker.waitSmart'), true)
	$('modalBody').innerHTML = html
	$('modal').hidden = false
	onModalClose = onClose ?? null
}
function closeModal() {
	if (modalLocked) return toast(tl('broker.waitSmart'), true)
	document.querySelector('.confirm-layer')?.remove()
	$('modal').hidden = true
	$('modalBody').innerHTML = ''
	bk.detail = null
	stopChatLive()
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
			<div class="row-btns"><button class="btn" data-c="no">${tl('broker.back')}</button><button class="btn ${cls}" data-c="ok">${okText}</button></div></div>`
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
			<div class="row-btns"><button class="btn" data-c="no">${tl('broker.back')}</button><button class="btn ${cls}" data-c="ok">${okText}</button></div></div>`,
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
	if (bk.acct.blocked) showBlocked(bk.acct.blocked)
	if (bk.acct.connected) {
		loadTrades()
		// Avisos push: la suscripción de este navegador, con esta cuenta (renovada al cargar o al cambiar de cuenta)
		if (bk.alerts && window.TPPush?.ok && Notification.permission === 'granted') TPPush.subscribe().catch(() => {})
		// Contador anónimo de cuentas conectadas por día (hit.js): sin usuario ni nada que lo identifique
		window.TPHit?.connected()
	} else renderTrades()
	// Sin token esto acaba antes de que cargue pro.js: entonces es pro.js quien llama a refreshPro al cargar
	bk.acctReady = true
	if (typeof refreshPro === 'function') refreshPro()
	// Lo que depende de la cuenta fuera de aquí (tus acciones en stocks.js)
	document.dispatchEvent(new Event('tp:account'))
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
		? `${a.dryRun ? `<span class="badge warn" title="${tl('broker.dryRunTitle')}">${tl('broker.dryRun')}</span>` : ''}
			<button class="pro-chip" id="proBtn" hidden></button>
			<div class="acct">
				<button type="button" class="acct-open" id="acctOpen" title="${tl('broker.myAccount')}">
					${avatar(a.username, a.image)}
					<div><div class="acct-name">@${esc(a.username)}${a.gold ? ' <span class="badge warn">GOLD</span>' : ''}</div><div class="acct-bal">${fmtM(a.balance ?? 0)} USD</div></div>
				</button>
				<button class="icon-btn small" id="disconnectBtn" title="${tl('broker.disconnectTitle')}" aria-label="${tl('broker.disconnectTitle')}">
					<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path d="M15 4h3a2 2 0 012 2v12a2 2 0 01-2 2h-3M10 17l5-5-5-5M15 12H4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
				</button>
			</div>`
		: `<button class="btn primary" id="connectBtn">${tl('broker.connect')}<span class="hide-sm">QvaPay</span></button>`
	if (typeof renderProChip === 'function') renderProChip()
	$('connectBtn')?.addEventListener('click', showConnect)
	$('disconnectBtn')?.addEventListener('click', async () => {
		if (!(await confirmDialog(tl('broker.disconnectTitle'), `<p class="muted">${tl('broker.disconnectBody')}</p>`, tl('broker.disconnect'), 'danger'))) return
		// Sin cuenta, este navegador deja de recibir los avisos push de ella
		await window.TPPush?.unsubscribe()
		await api('/disconnect', {}).catch(() => {})
		loadAccount()
	})
}

// Bloqueada desde el panel de Terminal P2P: se dice una vez por pestaña (el token sigue guardado; al levantarlo, entra sola)
let blockedShown = false
function showBlocked(msg) {
	if (blockedShown) return
	// Con el módulo Pro cargado, se recarga primero (al volver, el aviso sale sin él)
	if (window.TPPro?.loaded) return location.reload()
	blockedShown = true
	openModal(`<div class="stack"><h3>${tl('broker.blockedTitle')}</h3>
		<p class="muted">${esc(msg)}</p>
		<button class="btn primary block" id="blockedOk">${tl('broker.gotIt')}</button></div>`)
	$('blockedOk').onclick = closeModal
}

// title: por qué se pide (p. ej. al venir de la web a probar Pro)
// after: lo que se hace al conectar (p. ej. volver a la oferta que se iba a tomar)
function showConnect(title = tl('broker.connectTitle'), after = null) {
	openModal(`<div class="stack">
		<h3>${esc(title)}</h3>
		<p class="muted">${tl('broker.connectIntro')}</p>
		<p class="ref-note">${tl('broker.connectNoAccount')} <a href="https://www.qvapay.com/register/osmelyf" target="_blank" rel="sponsored noopener">${tl('broker.connectCreate')}</a> <small>${tl('broker.connectReferral')}</small></p>
		<div class="notice">
			${tl('broker.connectToken')}
			<ul><li>${tl('broker.connectRead')}</li><li>${tl('broker.connectBuy')}</li><li>${tl('broker.connectSell')}</li></ul>
			<a class="guide-link" href="https://terminalp2p.com/blog/conectar-qvapay-token/" target="_blank" rel="noopener">${tl('broker.connectGuide')}</a>
		</div>
		<div class="notice warn">${tl('broker.connectWarn')}</div>
		<label class="field">${tl('broker.connectTokenLabel')}<input class="input" id="tokenInput" type="password" autocomplete="off" placeholder="12345|abcdef…" /></label>
		<label class="check"><input type="checkbox" id="rememberToken" /> ${tl('broker.connectRemember')}</label>
		<p class="hint">${tl('broker.connectHint')}</p>
		<button class="btn primary block" id="doConnect">${tl('broker.connect')}</button>
	</div>`)
	$('tokenInput').focus()
	$('doConnect').onclick = async () => {
		const btn = $('doConnect')
		btn.disabled = true
		btn.textContent = tl('broker.checking')
		try {
			const r = await api('/connect', { token: $('tokenInput').value, remember: $('rememberToken').checked })
			closeModal()
			toast(tl('broker.connectedAs', { user: r.username }))
			loadAccount().then(() => after?.())
			setTimeout(loadBook, 4500)
		} catch (e) {
			btn.disabled = false
			btn.textContent = tl('broker.connect')
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
		for (const t of r.trades) rememberFace(t.counterparty?.username, t.counterparty?.image)
		watchOnline(r.trades.filter((t) => t.status === 'processing' || t.status === 'paid').map((t) => ({ id: t.counterparty?.uuid, u: t.counterparty?.username })))
		if (moved) refreshBalance(true)
		document.title = r.pending ? `(${r.pending}) ${BASE_TITLE}` : BASE_TITLE
		deliver(r.alerts ?? [])
		reportFinished(r.trades)
		// El módulo Pro sigue tus ofertas publicadas (mantenerlas las primeras del libro)
		document.dispatchEvent(new CustomEvent('tp:offers'))
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
	pay: [tl('broker.nextPay'), true],
	wait_payment: [tl('broker.nextWaitPayment'), false],
	release: [tl('broker.nextRelease'), true],
	wait_release: [tl('broker.nextWaitRelease'), false],
	wait_moderator: [tl('broker.nextModerator'), false],
	rate: [tl('broker.nextRate'), false],
}

// Cancelar una oferta publicada, desde la lista o desde su ventana. Mientras QvaPay responde, su botón dice
// «Cancelando…» y no se puede pedir otra vez: QvaPay deja cancelar una oferta cada 20 s y la siguiente espera su turno
// sin que se viera nada, así que se pulsaba de nuevo y la repetida fallaba («no está disponible para cancelar»).
// null si ya se estaba cancelando
async function cancelOffer(uuid) {
	if (bk.cancelling.has(uuid)) return null
	bk.cancelling.add(uuid)
	renderTrades()
	toast(tl('broker.cancellingOffer'))
	const slow = setTimeout(() => toast(tl('broker.cancelQueued')), 4000)
	try {
		const r = await api('/trade/action', { offer: uuid, action: 'cancel_offer' })
		// Fuera de la lista ya, sin esperar a la próxima lectura (que no vuelva a enseñarse «Cancelar» entretanto)
		bk.openOffers = bk.openOffers.filter((o) => o.offerUuid !== uuid)
		return r
	} finally {
		clearTimeout(slow)
		bk.cancelling.delete(uuid)
		renderTrades()
	}
}

// Tus ofertas publicadas en la gráfica de la tasa, a su precio (una venta tuya va del lado de las ventas). Solo si cambian
let mineLinesKey = ''
function mineLines() {
	const lines = bk.acct.connected
		? bk.openOffers.filter((o) => o.price > 0 && !o.pause).map((o) => ({ coin: o.coin, price: o.price, tone: o.offerType === 'sell' ? 'ask' : 'bid', title: tl('broker.yourOfferLine') }))
		: []
	const key = JSON.stringify(lines)
	if (key === mineLinesKey || !window.TPChartLines) return
	mineLinesKey = key
	TPChartLines.set('mine', lines)
}

function renderTrades() {
	mineLines()
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
			`<div class="empty">${tl('broker.tradesNoAccount')}</div>`
		return
	}

	const side = (t) => `<span class="side-${t.side}">${t.side === 'buy' ? tl('broker.sideBuy') : tl('broker.sideSell')}</span>`
	const who = (t) =>
		t.counterparty ? `<span class="who-ava">${avatar(t.counterparty.username, t.counterparty.image, 'sm')}<span>@${esc(t.counterparty.username)} <span class="muted">· ${tl('broker.opsShort', { n: String(t.counterparty.ops) })}</span></span></span>` : '<span class="muted">—</span>'
	const head = (cols) => `<thead><tr>${cols.map(([c, cls]) => `<th class="${cls ?? ''}">${c}</th>`).join('')}</tr></thead>`
	const common = [[tl('broker.colSide')], [tl('broker.colMarket')], ['USD', 'r'], [tl('broker.colPrice'), 'r'], [tl('broker.colTotal'), 'r']]

	let html = ''
	if (bk.tab === 'active') {
		html = active.length
			? `<table class="otable">${head([...common, [tl('broker.colWho')], [tl('broker.colStatus')], [tl('broker.colNext')]])}<tbody>${active
					.map((t) => {
						const next = t.actions.map((a) => NEXT[a]).find(Boolean)
						const clock = t.status === 'processing' && t.expiresAt ? `<span class="countdown" data-expires="${esc(t.expiresAt)}" title="${tl('broker.payDeadline')}"></span>` : ''
						return `<tr data-offer="${t.offerUuid}" data-order="${t.order ?? ''}">
							<td class="c-side">${side(t)}</td><td class="c-mkt">${esc(nameOf(t.coin))}</td>
							<td class="r num c-usd" data-l="USD">${fmtM(t.usd)}</td><td class="r num c-price" data-l="${tl('broker.colPrice')}">${fmtP(t.price)}</td><td class="r num c-total" data-l="${tl('broker.colTotal')}">${fmtM(t.coinAmount)} ${esc(unitOf(t.coin))}</td>
							<td class="c-who">${who(t)}</td><td class="c-status"><span class="chip ${t.status}">${STATUS[t.status] ?? t.status}</span></td>
							<td class="next c-next ${next?.[1] ? 'act' : ''}">${next ? next[0] : '—'}${clock}</td></tr>`
					})
					.join('')}</tbody></table>`
			: `<div class="empty">${tl('broker.noActive')}</div>`
	} else if (bk.tab === 'offers') {
		html = bk.openOffers.length
			? `<table class="otable">${head([...common, [tl('broker.colStatus')], [tl('broker.colPosted')], ['', 'r']])}<tbody>${bk.openOffers
					.map(
						(o) => `<tr data-offer="${o.offerUuid}">
							<td class="c-side">${side(o)}</td><td class="c-mkt">${esc(nameOf(o.coin))}</td>
							<td class="r num c-usd" data-l="USD">${fmtM(o.kind === 'flexible' ? (o.available ?? o.usd) : o.usd)}</td><td class="r num c-price" data-l="${tl('broker.colPrice')}">${fmtP(o.price)}</td><td class="r num c-total" data-l="${tl('broker.colTotal')}">${fmtM((o.kind === 'flexible' ? (o.available ?? o.usd) : o.usd) * o.price)} ${esc(unitOf(o.coin))}</td>
							<td class="c-status">${o.pause ? `<span class="chip revision" title="${esc(pauseText(o.pause))}">${o.pause.reason === 'taker_left' && o.pause.until ? tl('broker.pausedUntil', { time: cubaFmt(o.pause.until, { hour: '2-digit', minute: '2-digit' }) }) : tl('broker.paused')}</span>` : `<span class="chip open">${tl('broker.onMarket')}</span>`}${o.kind === 'flexible' ? ` <span class="chip">${tl('broker.byParts')}</span>` : ''}${o.isPrivate ? ` <span class="chip">${tl('broker.private')}</span>` : ''}${window.TPProKeep?.chip(o) ?? ''}</td>
							<td class="muted c-date">${o.updatedAt ? cubaFmt(o.updatedAt, { dateStyle: 'short', timeStyle: 'short' }) : '—'}</td>
							<td class="r c-act"><button class="btn danger sm" data-cancel-btn="${o.offerUuid}" ${bk.cancelling.has(o.offerUuid) ? `disabled>${tl('broker.cancelling')}` : `>${tl('common.cancel')}`}</button></td></tr>`,
					)
					.join('')}</tbody></table>`
			: `<div class="empty">${tl('broker.noOffers')}</div>`
	} else {
		html = done.length
			? `<table class="otable">${head([...common, [tl('broker.colWho')], [tl('broker.colDate')]])}<tbody>${done
					.map(
						(t) => `<tr data-offer="${t.offerUuid}" data-order="${t.order ?? ''}">
							<td class="c-side">${side(t)}</td><td class="c-mkt">${esc(nameOf(t.coin))}</td>
							<td class="r num c-usd" data-l="USD">${fmtM(t.usd)}</td><td class="r num c-price" data-l="${tl('broker.colPrice')}">${fmtP(t.price)}</td><td class="r num c-total" data-l="${tl('broker.colTotal')}">${fmtM(t.coinAmount)} ${esc(unitOf(t.coin))}</td>
							<td class="c-who">${who(t)}</td><td class="muted c-date">${t.updatedAt ? cubaFmt(t.updatedAt, { dateStyle: 'short', timeStyle: 'short' }) : '—'}</td></tr>`,
					)
					.join('')}</tbody></table>`
			: `<div class="empty">${tl('broker.noDone')}</div>`
	}
	$('myTrades').innerHTML = html
	tickClocks()
}

// ── Detalle de una operación ──────────────────────────────────────────
async function openTrade(offer, order, parent = false) {
	bk.detail = { offer, order, parent }
	bk.detailSig = null
	chatReadAt = 0
	openModal(`<p class="muted">${tl('broker.loadingTrade')}</p>`)
	await refreshDetail()
}

// La operación que se está cargando: abrir otra no espera a la anterior,
// pero el refresco periódico de la misma no se solapa
let detailLoading = null
// El chat entero se lee siempre que el usuario hace algo (abrir, enviar, pagar…). El refresco periódico ({ periodic: true }) se lo
// salta mientras el flujo al instante está abierto, porque los mensajes ya llegan por ahí: solo pide el estado. Lo lee igual
// si el flujo está caído o cada CHAT_SAFETY_MS, por si se coló algo
const CHAT_SAFETY_MS = 60_000
let chatReadAt = 0
async function refreshDetail({ periodic = false } = {}) {
	const d = bk.detail
	if (!d || detailLoading === d) return
	detailLoading = d
	const skipChat = periodic && chatLive?.live && bk.chat && Date.now() - chatReadAt < CHAT_SAFETY_MS
	let t
	try {
		t = await api(`/trade?offer=${d.offer}${d.order ? `&order=${d.order}` : ''}${skipChat ? '&chat=0' : ''}`)
	} catch (e) {
		if (bk.detail === d) $('modalBody').innerHTML = `<p class="empty">${esc(e.message)}</p>`
		return
	} finally {
		if (detailLoading === d) detailLoading = null
	}
	// Mientras cargaba se abrió otra operación (u otra orden de la misma oferta)
	if (bk.detail !== d) return
	// Sin chat en la respuesta: vale el que ya se tiene (con lo que llegó por el flujo). Con chat, se conservan los mensajes
	// del flujo más nuevos que esa lectura (llegaron mientras QvaPay respondía y ya no se vuelve a leer enseguida)
	if (t.chat) {
		chatReadAt = Date.now()
		const last = t.chat.at(-1)?.at ?? ''
		const ids = new Set(t.chat.map((m) => m.id))
		const late = bk.detailKey === `${d.offer}:${d.order ?? ''}` ? (bk.chat ?? []).filter((m) => !ids.has(m.id) && m.at >= last) : []
		if (late.length) t.chat = [...t.chat, ...late].slice(-30)
	} else t.chat = bk.chat ?? []
	bk.detailKey = `${d.offer}:${d.order ?? ''}`
	syncChatLive(t)
	// El refresco periódico no debe borrar lo que el usuario está escribiendo ni moverle el scroll:
	// el chat sigue al final solo si ya estaba al final (si subió a leer, se queda donde estaba)
	const cb0 = $('chatbox')
	const chatAtEnd = !cb0 || bk.chatToEnd || cb0.scrollHeight - cb0.scrollTop - cb0.clientHeight < 40
	bk.chatToEnd = false
	const chatTop = cb0?.scrollTop ?? 0
	// Si la operación no cambió (lo normal mientras se chatea), solo se redibujan los mensajes: así la caja de texto
	// no se reemplaza y quien escribe no pierde el foco (en el móvil, ni el teclado)
	const sig = JSON.stringify({ ...t, chat: null, dryRun: bk.acct.dryRun })
	bk.chat = t.chat
	if (cb0 && sig === bk.detailSig) {
		const html = chatHtml(t.chat)
		if (html !== bk.chatHtml) {
			bk.chatHtml = cb0.innerHTML = html
			cb0.scrollTop = chatAtEnd ? cb0.scrollHeight : chatTop
		}
		return
	}
	const modalTop = $('modal').scrollTop
	const keep = { txRef: $('txRef')?.value, chatInput: $('chatInput')?.value, seenMoney: $('seenMoney')?.checked }
	// Si cambió (pagó, liberó…), se redibuja todo y el cursor vuelve a donde estaba
	const focus = document.activeElement
	const caret = focus?.id === 'chatInput' || focus?.id === 'txRef' ? { id: focus.id, at: focus.selectionStart } : null
	renderDetail(t)
	bk.detailSig = $('chatbox') ? sig : null
	bk.chatHtml = chatHtml(t.chat)
	const cb = $('chatbox')
	if (cb) cb.scrollTop = chatAtEnd ? cb.scrollHeight : chatTop
	$('modal').scrollTop = modalTop
	if (keep.txRef && $('txRef')) {
		$('txRef').value = keep.txRef
		$('txRef').dispatchEvent(new Event('input')) // vuelve a activar "Ya pagué" si ya había referencia
	}
	if (keep.chatInput && $('chatInput')) $('chatInput').value = keep.chatInput
	if (caret && $(caret.id)) {
		$(caret.id).focus({ preventScroll: true })
		$(caret.id).setSelectionRange(caret.at, caret.at)
	}
	const release = $('modalBody').querySelector('[data-act="release"]')
	if (keep.seenMoney && $('seenMoney') && release) {
		$('seenMoney').checked = true
		release.disabled = false
	}
}

// El chat al instante: con la operación en curso, cada mensaje nuevo la redibuja sin esperar al refresco periódico
// (que sigue, para los cambios de estado). QvaPay manda el mensaje por un flujo abierto mientras dura la operación
let chatLive = null
const LIVE_CHAT = new Set(['processing', 'paid', 'revision'])
function syncChatLive(t) {
	const d = bk.detail
	const key = d && LIVE_CHAT.has(t?.status) ? `${d.offer}:${d.order ?? ''}` : null
	if (chatLive?.key === key) return
	stopChatLive()
	if (!key || !window.TPApi?.chat) return
	const me = { key, live: false, stop: null }
	chatLive = me
	me.stop = TPApi.chat(d.offer, d.order ?? null, chatArrived, (live) => {
		if (chatLive !== me) return
		me.live = live
		// Al (re)conectar se lee el chat entero una vez: lo que llegó mientras el flujo estaba cortado no lo trae él
		if (live && Date.now() - chatReadAt > 3_000) refreshSoon({ full: true })
	})
}
// El mensaje se pinta en cuanto llega, sin esperar a releer la operación (eso va detrás, por si cambió algo más)
function chatArrived(m) {
	const cb = $('chatbox')
	if (cb && m?.id && !bk.chat?.some((x) => x.id === m.id)) {
		const atEnd = cb.scrollHeight - cb.scrollTop - cb.clientHeight < 40
		bk.chat = [...(bk.chat ?? []), m].slice(-30)
		bk.chatHtml = cb.innerHTML = chatHtml(bk.chat)
		if (atEnd) cb.scrollTop = cb.scrollHeight
	}
	refreshSoon()
}
function stopChatLive() {
	chatLive?.stop()
	chatLive = null
}
// Si ya se está cargando, se repite al terminar: el mensaje que llegó puede no estar en esa lectura
// Tras un mensaje del flujo basta el estado (el mensaje ya está pintado); { full: true } lee también el chat
const refreshSoon = ({ full = false } = {}) => (detailLoading ? setTimeout(() => refreshSoon({ full }), 300) : refreshDetail({ periodic: !full }))

const chatHtml = (chat) =>
	chat.length
		? chat
				.map(
					(m) =>
						`<div class="msg ${m.mine ? 'mine' : ''} ${m.moderator ? 'mod' : ''}">${mediaUrl(m.image) ? `<a class="msg-img" href="${esc(mediaUrl(m.image))}" target="_blank" rel="noopener" title="${tl('broker.imgFull')}"><img src="${esc(mediaUrl(m.image))}" alt="${tl('broker.imgAlt')}" loading="lazy" /></a>` : ''}${esc(m.text ?? '')}<time>${cubaFmt(m.at, { hour: '2-digit', minute: '2-digit' })}</time></div>`,
				)
				.join('')
		: `<p class="muted small">${tl('broker.noMessages')}</p>`

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
		$('modalBody').innerHTML = `<div class="stack"><h3>${tl('broker.notInTrade')}</h3>
			<p class="muted">${tl('broker.notInTradeBody', { user: esc(t.counterparty ?? '—') })}</p>
			<div class="row-btns"><button class="btn" id="gotIt">${tl('common.close')}</button></div></div>`
		$('gotIt').onclick = closeModal
		return
	}
	if (status === 'processing' && payer)
		action = `<div class="stack">
			<p>${tl('broker.payTransfer', { amount: `${fmtM(t.coinAmount)} ${unit}` })}</p>${clock ? `<p class="hint">${tl('broker.payDeadlineIn')} ${clock}</p>` : ''}
			${t.isOwner ? `<p class="notice">${tl('broker.payDetailsByChat', { user: esc(t.counterparty) })}</p>` : ''}
			<label class="field">${tl('broker.txRefLabel')}<input class="input" id="txRef" placeholder="${tl('broker.txRefPh')}" /></label>
			<div class="row-btns"><button class="btn danger" data-act="cancel">${tl('common.cancel')}</button><button class="btn primary" data-act="paid" disabled title="${tl('broker.txRefFirst')}">${tl('broker.iPaid')}</button></div></div>`
	else if (status === 'processing')
		action = `<p>${tl('broker.waitingPay', { user: esc(t.counterparty), amount: `${fmtM(t.coinAmount)} ${unit}` })}</p>${clock ? `<p class="hint">${tl('broker.payDeadlineIn')} ${clock}</p>` : ''}
			${needSendDetails ? `<p class="notice">${tl('broker.sendDetails')}</p>` : ''}`
	else if (status === 'paid' && !payer && Date.now() - (bk.released.get(`${d.offer}:${d.order ?? ''}`) ?? 0) < 5 * 60_000)
		action = `<p>${tl('broker.releasedWait')}</p>`
	else if (status === 'paid' && !payer)
		action = `<div class="stack">
			<p>${tl('broker.markedPaid', { user: esc(t.counterparty), ref: t.txId ? tl('broker.markedPaidRef', { ref: esc(t.txId) }) : '', amount: `${fmtM(t.coinAmount)} ${unit}` })}</p>
			<label class="check"><input type="checkbox" id="seenMoney" /> ${tl('broker.seenMoney')}</label>
			<div class="row-btns"><button class="btn danger" data-act="dispute">${tl('broker.notArrived')}</button><button class="btn buy" data-act="release" disabled>${tl('broker.releaseUsd', { usd: fmtM(t.usd) })}</button></div></div>`
	else if (status === 'paid') action = `<p>${tl('broker.youMarkedPaid', { user: esc(t.counterparty) })}</p>`
	else if (status === 'revision') action = `<p>${tl('broker.inDispute')}</p>`
	else if (status === 'completed' && t.parts) {
		// Una oferta por rango tuya: se califica cada parte por separado (QvaPay no deja calificar la oferta entera)
		const rows = t.parts
			.map(
				(p) =>
					`<button type="button" class="part-row" data-part="${esc(p.order)}"><span class="who-ava">${p.counterparty ? `${avatar(p.counterparty, p.image, 'sm')}<span class="link peer-link" role="link" tabindex="0" data-part-peer="${esc(p.counterparty)}" data-peer-id="${esc(p.counterpartyUuid ?? '')}">@${esc(p.counterparty)}</span>` : '@—'}</span><span>${fmtM(p.usd)} USD</span>${
						p.status !== 'completed' ? `<span class="chip ${p.status}">${STATUS[p.status] ?? p.status}</span>` : p.rated ? `<span class="muted">${'★'.repeat(p.rated)}</span>` : `<b>${tl('broker.rate')}</b>`
					}</button>`,
			)
			.join('')
		action = t.parts.length
			? `<div class="stack tight"><p>${tl('broker.partsDone', { n: t.parts.length })}</p><div class="part-list">${rows}</div></div>`
			: `<p class="muted">${tl('broker.tradeDone')}</p>`
	} else if (status === 'completed') {
		const mine = t.myRating?.rating ?? 0
		const until = t.myRating?.editableUntil ? Date.parse(t.myRating.editableUntil) : null
		const locked = mine > 0 && until != null && until < nowMs()
		const when = until ? cubaFmt(until, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : ''
		const stars = [1, 2, 3, 4, 5]
			.map((n) => `<button data-rate="${n}" class="${n <= mine ? 'on' : ''}" title="${tl('broker.starsOf', { n })}" aria-label="${tl('broker.starsAria', { n })}" aria-pressed="${n === mine}" ${locked ? 'disabled' : ''}>★</button>`)
			.join('')
		action = `<div class="stack tight"><p>${mine ? tl('broker.youRated', { user: esc(t.counterparty) }) : tl('broker.rateNow', { user: esc(t.counterparty) })}</p>
			<div class="stars ${locked ? 'locked' : ''}" role="group" aria-label="${tl('broker.ratingAria')}">${stars}</div>
			<p class="hint" id="rateHint" ${mine ? '' : 'hidden'}>${locked ? tl('broker.rateLocked') : when ? tl('broker.rateUntil', { when }) : tl('broker.rateCanChange')}</p>
</div>`
	}

	if (t.counterpartyUuid) watchOnline([{ id: t.counterpartyUuid, u: t.counterparty }])
	$('modalBody').innerHTML = `<div class="stack">
		${d.parent ? `<button type="button" class="link" id="backParts">${tl('broker.backParts')}</button>` : ''}
		<div><h3>${tl(buy ? 'broker.youBuy' : 'broker.youSell', { usd: fmtM(t.usd), amount: `${fmtM(t.coinAmount)} ${unit}` })}</h3>
			<p class="muted who-ava">${t.counterparty ? `${avatar(t.counterparty, t.counterpartyImage, 'sm')}` : ''}${esc(nameOf(t.coin))} · ${t.counterparty ? `<button type="button" class="link peer-link" data-peer="${esc(t.counterparty)}" data-peer-id="${esc(t.counterpartyUuid ?? '')}">@${esc(t.counterparty)}</button>` : t.parts ? tl('broker.inParts') : '@—'} · <span class="chip ${status}">${STATUS[status] ?? status}</span>${bk.acct.dryRun ? ` · <span class="badge warn">${tl('broker.dryRun')}</span>` : ''}</p></div>
		${
			payTo.length
				? `<div><p class="hint">${tl('broker.payDataOf', { user: esc(t.counterparty) })}</p><div class="kv">${payTo
						.map((x) => `<span>${esc(x.name)}</span><b>${esc(x.value)}</b>${copyBtn(x.value, x.name)}`)
						.join('')}<span>${tl('broker.amount')}</span><b>${fmtM(t.coinAmount)} ${unit}</b>${copyBtn(t.coinAmount, tl('broker.theAmount'))}</div></div>`
				: ''
		}
		${action}
		${t.parts ? '' : `<div><p class="hint">${tl('broker.chat')}</p><div class="chatbox" id="chatbox">${chatHtml(t.chat)}</div>
		<form class="chatform" id="chatform"><label class="btn icon-only chat-attach" title="${tl('broker.attachTitle')}" aria-label="${tl('broker.attachAria')}"><input type="file" id="chatFile" accept="image/*" hidden /><svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M21 12.5l-8.6 8.6a5 5 0 01-7.1-7.1l8.6-8.6a3.5 3.5 0 015 5l-8.6 8.6a2 2 0 01-2.8-2.8l7.9-7.9" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></label><input class="input" id="chatInput" maxlength="599" placeholder="${tl('broker.chatPh')}" /><button class="btn">${tl('broker.send')}</button></form></div>`}
		<p class="hint"><a class="link" href="https://www.qvapay.com/p2p/${t.offer}" target="_blank" rel="noopener">${tl('broker.openInQvaPay')}</a></p>
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
	// Con el uuid de la contraparte de esta operación: el de quien tomó una orden de tu oferta por rango no está en
	// tus operaciones recientes si la oferta ya no está abierta, y sin él la ficha no trae su actividad en QvaPay
	body.querySelector('[data-peer]')?.addEventListener('click', (e) => showPeer(e.currentTarget.dataset.peer, e.currentTarget.dataset.peerId))
	// Las partes de una oferta por rango: cada una abre su detalle, desde donde se vuelve a la lista
	for (const b of body.querySelectorAll('[data-part]'))
		b.onclick = (e) => {
			// El nombre abre su ficha; el resto de la fila, esa parte para calificarla
			const who = e.target.closest('[data-part-peer]')
			if (who) return showPeer(who.dataset.partPeer, who.dataset.peerId)
			openTrade(t.offer, b.dataset.part, true)
		}
	const back = $('backParts')
	if (back) back.onclick = () => openTrade(t.offer, null)
	const act = async (action, extra = {}) => {
		// Mientras QvaPay responde no se puede tocar otro botón (ni el mismo dos veces). Un mensaje del chat no bloquea
		// nada: tras enviarlo la operación sigue igual y los botones tienen que seguir a mano («Ya pagué», «Liberar»)
		const chat = action === 'chat'
		if (!chat) for (const b of body.querySelectorAll('[data-act]')) b.disabled = true
		try {
			const r = await api('/trade/action', { offer: t.offer, order: t.order, action, ...extra })
			if (action === 'release') bk.released.set(`${t.offer}:${t.order ?? ''}`, Date.now())
			if (r.message) toast(r.message)
			// Entera otra vez: si la operación aún no cambió de estado, los botones vuelven a poder tocarse
			if (!chat) bk.detailSig = null
			await refreshDetail()
			loadTrades()
		} catch (e) {
			toast(e.message, true)
			// Se vuelve a dibujar entera para que los botones se puedan tocar otra vez
			bk.detailSig = null
			refreshDetail()
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
				if (tx.length < 4) return toast(tl('broker.txRefNeeded'), true)
				const ok = await askConfirm(
					tl('broker.paidAsk', { amount: `${fmtM(t.coinAmount)} ${unit}` }),
					`<p class="muted">${tl('broker.paidAskBody', { who, ref: esc(tx) })}</p>`,
					tl('broker.paidYes'),
				)
				return ok && act('paid', { txId: tx })
			}
			if (a === 'release') {
				const ok = await askConfirm(
					tl('broker.releaseAsk', { usd: fmtM(t.usd) }),
					`<p class="muted">${tl('broker.releaseAskBody', { who, amount: `${fmtM(t.coinAmount)} ${unit}` })}</p>`,
					tl('broker.release'),
					'buy',
				)
				return ok && act('release')
			}
			if (a === 'dispute') {
				const ok = await askConfirm(
					tl('broker.disputeAsk'),
					`<p class="muted">${tl('broker.disputeAskBody', { who })}</p>`,
					tl('broker.disputeOpen'),
					'danger',
				)
				return ok && act('dispute')
			}
			if (a === 'cancel') {
				const ok = await askConfirm(
					tl('broker.cancelAsk'),
					`<p class="muted">${tl('broker.cancelAskBody', { who })}</p>`,
					tl('broker.cancelTrade'),
					'danger',
				)
				return ok && act('cancel')
			}
			return act(a)
		}
	// Calificar: mientras QvaPay guarda, las estrellas quedan en gris (las elegidas, latiendo) y no se puede tocar otra
	// (las llamadas van en fila y una nota que se cambia varias veces seguidas tardaba en asentarse). Se encienden solo
	// cuando QvaPay la guardó; si falla, vuelve la que había. Con nota ya puesta, se cambia
	const stars = body.querySelector('.stars')
	for (const b of body.querySelectorAll('[data-rate]'))
		b.onclick = async () => {
			if (b.disabled || stars.classList.contains('busy')) return
			const n = Number(b.dataset.rate)
			stars.classList.add('busy')
			for (const s of stars.querySelectorAll('[data-rate]')) {
				s.classList.remove('on')
				s.classList.toggle('pending', Number(s.dataset.rate) <= n)
				s.disabled = true
			}
			const hint = $('rateHint')
			hint.textContent = tl('broker.saving')
			hint.hidden = false
			try {
				await api('/trade/action', { offer: t.offer, order: t.order, action: 'rate', rating: n, edit: (t.myRating?.rating ?? 0) > 0 })
				stars.classList.remove('busy')
				for (const s of stars.querySelectorAll('[data-rate]')) {
					s.classList.remove('pending')
					s.classList.toggle('on', Number(s.dataset.rate) <= n)
					s.disabled = false
				}
				hint.textContent = tl('broker.ratingSaved')
			} catch (e) {
				toast(e.message, true)
				hint.textContent = tl('broker.notSaved')
				for (const s of stars.querySelectorAll('[data-rate]')) s.classList.remove('pending')
			}
			// Se vuelve a leer la operación aunque no haya cambiado (nota igual que antes o error): así queda la nota que
			// de verdad guardó QvaPay y su plazo
			bk.detailSig = null
			refreshDetail()
			loadTrades()
		}
	// La oferta por rango vista entera no tiene chat: cada parte tiene el suyo
	if (!$('chatform')) return
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
		toast(tl('broker.sendingImage'))
		try {
			const form = new FormData()
			form.append('offer', d.offer)
			if (d.order) form.append('order', d.order)
			form.append('message', $('chatInput').value.trim())
			form.append('file', await shrinkImage(file))
			await apiForm('/trade/image', form)
			$('chatInput').value = ''
			bk.chatToEnd = true
			toast(tl('broker.imageSent'))
			refreshDetail()
		} catch (e) {
			toast(e.message || tl('broker.imageFail'), true)
			// Si se cortó sin respuesta puede que llegara: el chat se recarga para que se vea
			if (e.status === 504) refreshDetail()
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
	min_completed: [tl('broker.reqCompleted'), [5, 10, 25, 50, 100], (v) => tl('broker.reqOrMore', { v })],
	min_rating: [tl('broker.reqRating'), [4, 4.5], (v) => tl('broker.reqStarsOrMore', { v })],
	min_account_days: [tl('broker.reqAge'), [7, 30, 90, 180, 365], (v) => tl('broker.reqDaysOrMore', { v })],
	min_trustscore: ['TrustScore', [50, 85], (v) => tl('broker.reqOrMore', { v })],
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
		? `<span class="muted small">${tl('broker.savedInQvaPay')}</span>${list.map((m, i) => `<button type="button" class="chip-btn" data-saved="${i}">${esc(m.name)}${tail(m)}</button>`).join('')}`
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
		return { refs: [[tl('broker.refBestAsk'), asks[0]?.price], [tl('broker.refBestBid'), bids[0]?.price], [tl('broker.refMedian'), m]].filter(([, p]) => p), mid: m ?? avg }
	}
	const o = state.overview.find((c) => c.tick === coin)
	const refs = [[tl('broker.refAvgAsk'), o?.avgSell], [tl('broker.refAvgBid'), o?.avgBuy]].filter(([, p]) => p)
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
	return fee ? ` · ${tl('broker.netNote', { net: fmtM(usd - fee), pct: (bk.acct.p2pFee * 100).toLocaleString('en-US'), fee: fmtM(fee) })}` : ''
}

function smartTeaser(f) {
	if (!window.TPPro?.enabled) return ''
	const b = state.book?.coin?.tick === f.coin ? state.book : null
	if (!b || !(f.amount > 0 && f.price > 0)) return ''
	const buy = f.type === 'buy'
	const n = (buy ? b.ask.levels : b.bid.levels).filter((l) => !l.outlier && l.user !== myUsername() && (buy ? l.price <= f.price : l.price >= f.price)).length
	if (!n) return ''
	return `<p class="smart-head"><b>${tl('broker.smartTitle')}</b> <span class="pro-tag">PRO</span></p>
		<p class="hint">${tl('broker.smartTeaser', { n })}</p>
		<button type="button" class="btn small" id="smartPro">${tl('broker.buyProDays')}</button>`
}

// Sin Pro, en su sección de «Publicar oferta»: lo que haría mantenerla la primera
function keepTeaser() {
	if (!window.TPPro?.enabled) return ''
	return `<p class="smart-head"><b>${tl('broker.keepTitle')}</b> <span class="pro-tag">PRO</span></p>
		<p class="hint">${tl('broker.keepTeaser')}</p>
		<button type="button" class="btn small" id="keepPro">${tl('broker.buyProDays')}</button>`
}

function priceWarning(type, price, mid) {
	if (!mid || !(price > 0)) return ''
	const dev = price / mid - 1
	if (Math.abs(dev) > 0.3) return tl(dev > 0 ? 'broker.warnTypoAbove' : 'broker.warnTypoBelow', { pct: pct(Math.abs(dev)).slice(1) })
	if (type === 'sell' && dev < -0.03) return tl('broker.warnSellBelow', { pct: pct(-dev).slice(1), ref: fmtP(mid) })
	if (type === 'buy' && dev > 0.03) return tl('broker.warnBuyAbove', { pct: pct(dev).slice(1), ref: fmtP(mid) })
	return ''
}

async function showCreateOffer(preset = null) {
	if (!bk.acct.connected) return toast(tl('broker.connectToPost'), true)
	const markets = state.overview.length ? state.overview : [{ tick: state.coin, name: nameOf(state.coin), unit: unitOf(state.coin) }]
	const key = `tp-${crypto.randomUUID()}` // misma clave si se reintenta: QvaPay no la duplica
	let type = preset?.type === 'buy' ? 'buy' : 'sell'
	openModal(`<div class="stack offer-form">
		<div id="ofForm" class="stack">
			<h3>${tl('broker.postOffer')}</h3>
			<div class="seg-tabs choice" role="radiogroup" aria-label="${tl('broker.colSide')}">
				<button type="button" class="seg-tab" data-type="sell" role="radio">${tl('broker.iSellUsd')}</button>
				<button type="button" class="seg-tab" data-type="buy" role="radio">${tl('broker.iBuyUsd')}</button>
			</div>
			<section class="sec-box">
				<p class="sec-box-t">${tl('broker.offer')}</p>
				<label class="field">${tl('broker.colMarket')}<select class="input" id="ofCoin">${markets.map((c) => `<option value="${c.tick}">${esc(TPI18N.coin(c.tick, c.name))}</option>`).join('')}</select></label>
				<div class="grid2">
					<label class="field"><span class="field-row">${tl('broker.amountUsd')}<button type="button" class="link small" id="ofBal" hidden></button></span><input class="input" id="ofAmount" inputmode="decimal" data-num data-dec="2" autocomplete="off" placeholder="100" /></label>
					<label class="field"><span>${tl('broker.pricePerUsd')} (<span id="ofUnit"></span>)</span><input class="input" id="ofPrice" inputmode="decimal" data-num autocomplete="off" /></label>
				</div>
				<div class="ref-chips" id="ofRefs"></div>
				<p class="hint" id="ofTotal"></p>
				<div class="smart" id="ofSmart" hidden></div>
			</section>
			<section class="sec-box">
				<label class="check sec-box-h"><input type="checkbox" id="ofFlex" /> ${tl('broker.flexLabel')}</label>
				<p class="hint" id="ofFlexNote" hidden>${tl('broker.flexNote')}</p>
				<div class="grid2" id="ofFlexBox" hidden>
					<label class="field">${tl('broker.minPerOrder')}<input class="input" id="ofMin" inputmode="decimal" data-num data-dec="2" autocomplete="off" /></label>
					<label class="field">${tl('broker.maxPerOrder')}<input class="input" id="ofMax" inputmode="decimal" data-num data-dec="2" autocomplete="off" /></label>
				</div>
			</section>
			<section class="sec-box" id="ofKeep" hidden></section>
			<section class="sec-box">
				<p class="sec-box-t" id="ofDetailsTitle"></p>
				<div class="saved-methods" id="ofSaved" hidden></div><div class="stack tight" id="ofDetails"><p class="muted small">${tl('broker.loadingFields')}</p></div>
				<label class="check small"><input type="checkbox" id="ofRemember" /> ${tl('broker.rememberData')}</label>
			</section>
			<details class="sec-box opts"><summary>${tl('broker.reqVis')}</summary><div class="stack tight">
				<label class="check"><input type="checkbox" id="ofVip" /> ${tl('broker.vipOnly')}</label>
				<label class="check"><input type="checkbox" id="ofPrivate" /> ${tl('broker.privateLabel')}</label>
				${
					bk.acct.gold
						? `<label class="field">${tl('broker.publicMsg')}<input class="input" id="ofMsg" maxlength="79" placeholder="${tl('broker.publicMsgPh')}" /></label><p class="hint">${tl('broker.publicMsgHint')}</p>`
						: `<p class="hint">${tl('broker.publicMsgGold')}</p>`
				}
				<p class="hint">${tl('broker.reqHint')}</p>
				${Object.entries(REQ_OPTIONS)
					.map(([k, [label, vals, fmt]]) => `<label class="field">${label}<select class="input" data-req="${k}"><option value="0">${tl('broker.noReq')}</option>${vals.map((v) => `<option value="${v}">${fmt(v)}</option>`).join('')}</select></label>`)
					.join('')}
			</div></details>
			<div id="ofWarn"></div>
			<button class="btn primary block" id="ofReview">${tl('broker.review')}</button>
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
			details: [...document.querySelectorAll('[data-detail]')].map((i) => ({ name: i.dataset.detail, value: window.TPNum?.val(i) ?? i.value.trim() })),
			requirements,
			private: $('ofPrivate').checked,
			onlyVip: $('ofVip').checked,
			message: $('ofMsg')?.value.trim() || undefined,
			idempotencyKey: key,
		}
	}
	const renderDetails = () => {
		const coin = $('ofCoin').value
		const saved = store.getMine(`details.${coin}`, {})
		const list = fields[coin] ?? []
		$('ofRemember').checked = Object.keys(saved).length > 0
		$('ofDetails').innerHTML = list.length
			? list
					.map((f) => {
						const label = esc(f.label || f.name)
						const val = esc(window.TPNum?.show(f.name, saved[f.name]) ?? saved[f.name] ?? '')
						return f.type === 'select' && f.options?.length
							? `<label class="field">${label}<select class="input" data-detail="${esc(f.name)}">${f.options.map((o) => `<option ${o.value === saved[f.name] ? 'selected' : ''}>${esc(o.value)}</option>`).join('')}</select></label>`
							: `<label class="field">${label}<input class="input" data-detail="${esc(f.name)}"${window.TPNum?.detail(f.name) ?? ''} value="${val}" placeholder="${esc(f.placeholder ?? '')}" autocomplete="off" /></label>`
					})
					.join('')
			: `<p class="notice warn">${tl('broker.fieldsFail')}</p>`
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
		$('ofBal').innerHTML = tl('broker.balanceLink', { bal: fmtM(balance()) })
		$('ofAmount').max = String(type === 'sell' ? Math.min(10_000, balance()) : 10_000)
		for (const b of document.querySelectorAll('[data-type]')) {
			b.classList.toggle('active', b.dataset.type === type)
			b.setAttribute('aria-checked', String(b.dataset.type === type))
		}
		const f = read()
		const unit = unitOf(f.coin)
		$('ofUnit').textContent = unit
		$('ofFlexBox').hidden = f.kind !== 'flexible'
		$('ofDetailsTitle').textContent = type === 'sell' ? tl('broker.detailsSell') : tl('broker.detailsBuy')
		const { refs, mid } = marketRefs(f.coin)
		$('ofRefs').innerHTML = refs.map(([label, p]) => `<button type="button" class="chip-btn" data-ref="${p}">${label} <b class="mono">${fmtP(p)}</b></button>`).join('')
		const total = f.amount > 0 && f.price > 0 ? f.amount * f.price : 0
		const rank = bookRank(f.coin, type, f.price)
		$('ofTotal').innerHTML = total
			? `${tl(type === 'sell' ? 'broker.youWillGet' : 'broker.youWillPay', { amount: `${fmtM(total)} ${unit}` })}${type === 'buy' ? netNote(f.amount) : ''}${rank ? ` · ${tl(type === 'sell' ? 'broker.rankAsk' : 'broker.rankBid', { rank })}` : ''}`
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
		if (smartActive && total && sm.total) $('ofTotal').innerHTML = tl(type === 'sell' ? 'broker.youWillGetTotal' : 'broker.youWillPayTotal', { amount: `${fmtM(sm.total)} ${unit}` })
		$('ofReview').textContent = smartActive ? tl('broker.reviewSmart') : tl('broker.review')
		// Mantenerla la primera (módulo Pro) tiene su sección; sin Pro, lo que haría
		if (keep) keep.update()
		else $('ofKeep').innerHTML = keepTeaser()
		$('ofKeep').hidden = !keep && !window.TPPro?.enabled
	}
	// El módulo Pro (si estás en Pro) maneja la orden inteligente de este formulario; si llega después
	// (por ejemplo, al volver de pagar), se engancha al momento. Si Pro se apagó o venció, aunque el módulo
	// siga cargado, no se usa
	let smart = null
	let smartActive = false
	let keep = null
	const ctx = { update: () => update(), read, fields, getType: () => type }
	const keepCtx = { box: $('ofKeep'), getType: () => type, getCoin: () => $('ofCoin').value, getPrice: () => Number($('ofPrice').value), isPrivate: () => $('ofPrivate').checked }
	smart = window.TPPro?.active ? (window.TPProSmart?.open(ctx) ?? null) : null
	keep = window.TPPro?.active ? (window.TPProKeep?.form?.(keepCtx) ?? null) : null
	renderDetails()
	update()
	const onSmartReady = () => {
		if (!$('ofForm')) return document.removeEventListener('tp:smart-ready', onSmartReady)
		if (window.TPPro?.active) smart ??= window.TPProSmart.open(ctx)
		if (window.TPPro?.active) keep ??= window.TPProKeep?.form?.(keepCtx) ?? null
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
	for (const id of ['ofAmount', 'ofPrice', 'ofMin', 'ofMax', 'ofFlex', 'ofPrivate']) $(id).addEventListener('input', update)
	$('ofBal').onclick = () => {
		$('ofAmount').value = String(balance())
		update()
	}
	$('ofSmart').addEventListener('click', (e) => e.target.closest('#smartPro') && typeof showPro === 'function' && showPro())
	$('ofKeep').addEventListener('click', (e) => e.target.closest('#keepPro') && typeof showPro === 'function' && showPro())
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
				? tl('broker.errNoBalance', { bal: fmtM(balance()) })
				: !(f.amount >= 0.1 && f.amount <= 10000)
				? tl('broker.errAmountRange')
				: !(f.price > 0)
					? tl('broker.errPrice')
					: f.kind === 'flexible' && !(f.orderMin > 0 && f.orderMax >= f.orderMin && f.orderMax <= f.amount)
						? tl('broker.errMinMax')
						: smartActive && type === 'sell' && !f.details.some((d) => d.value)
							? tl('broker.errSmartDetails')
							: (window.TPNum?.cardError(document.querySelectorAll('[data-detail]')) ?? '')
		if (err) return toast(err, true)
		// Los límites de «mantenerla la primera»: se guardan para la oferta al publicarla
		const kp = keep?.read() ?? null
		if (kp?.error) return toast(kp.error, true)
		f.keep = kp
		if (smartActive) return smart.review(f)
		const total = f.amount * f.price
		const req = reqText(f.requirements)
		$('ofForm').hidden = true
		$('ofConfirm').hidden = false
		$('ofConfirm').innerHTML = `<h3>${tl('broker.reviewTitle')}</h3>
			<div class="kv">
				<span>${type === 'sell' ? tl('broker.kvSell') : tl('broker.kvBuy')}</span><b>${fmtM(f.amount)} USD</b><span></span>
				<span>${tl('broker.colPrice')}</span><b>${fmtP(f.price)} ${unit}</b><span></span>
				<span>${type === 'sell' ? tl('broker.kvReceive') : tl('broker.kvPay')}</span><b>${fmtM(total)} ${unit}</b><span></span>
				${type === 'buy' && feeOf(f.amount) ? `<span>${tl('broker.kvNet')}</span><b>${fmtM(f.amount - feeOf(f.amount))} USD</b><span class="muted">${tl('broker.kvAfterFee')}</span>` : ''}
				<span>${tl('broker.colMarket')}</span><b>${esc(nameOf(f.coin))}</b><span></span>
				${f.kind === 'flexible' ? `<span>${tl('broker.kvParts')}</span><b>${fmtM(f.orderMin)}–${fmtM(f.orderMax)} USD</b><span></span>` : ''}
				${f.keep ? `<span>${tl('broker.keepTitle')}</span><b>${fmtP(f.keep.min)}–${fmtP(f.keep.max)} ${unit}</b><span class="muted">${tl('broker.kvKeepLimits')}</span>` : ''}
				${req ? `<span>${tl('broker.kvReq')}</span><b>${esc(req)}</b><span></span>` : ''}
				<span>${tl('broker.kvVis')}</span><b>${f.private ? tl('broker.private') : tl('broker.kvPublicTg')}${f.onlyVip ? tl('broker.kvVipOnly') : ''}</b><span></span>
				${f.message ? `<span>${tl('broker.kvMsg')}</span><b>${esc(f.message)}</b><span></span>` : ''}
			</div>
			<p class="notice">${
				type === 'sell'
					? tl('broker.noteSell', { usd: fmtM(f.amount), to: f.details.some((d) => d.value) ? tl('broker.noteSellToYours') : tl('broker.noteSellToChat') })
					: f.kind === 'flexible'
						? tl('broker.noteBuyFlex', { amount: `${fmtM(total)} ${unit}` })
						: tl('broker.noteBuy', { amount: `${fmtM(total)} ${unit}` })
			}</p>
			${$('ofWarn').innerHTML}
			<div class="row-btns"><button class="btn" id="ofBack">${tl('broker.back')}</button><button class="btn primary" id="ofPublish">${tl('broker.publish')}</button></div>`
		$('ofBack').onclick = () => {
			$('ofConfirm').hidden = true
			$('ofForm').hidden = false
		}
		$('ofPublish').onclick = async () => {
			const btn = $('ofPublish')
			btn.disabled = true
			btn.textContent = tl('broker.publishing')
			try {
				const r = await api('/offer/create', { ...f, keep: undefined })
				markOrigin(r.offer)
				if (f.keep) window.TPProKeep?.save(r.offer, f.keep)
				if ($('ofRemember').checked) store.setMine(`details.${f.coin}`, Object.fromEntries(f.details.map((d) => [d.name, d.value])))
				else store.setMine(`details.${f.coin}`, {})
				toast(r.message || tl('broker.offerPosted'))
				bk.tab = 'offers'
				await loadTrades()
				showManageOffer(r.offer)
				loadBook()
			} catch (e) {
				btn.disabled = false
				btn.textContent = tl('broker.publish')
				toast(e.message, true)
			}
		}
	}

}

// ── Gestionar una oferta tuya ─────────────────────────────────────────
async function showManageOffer(uuid) {
	bk.detail = null
	stopChatLive()
	openModal(`<p class="muted">${tl('broker.loadingOffer')}</p>`)
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
	if (p.reason === 'owner') return tl('broker.pausedByYou')
	const until = p.until ? cubaFmt(p.until, { hour: '2-digit', minute: '2-digit' }) : null
	return until ? tl('broker.pausedLeftUntil', { until }) : tl('broker.pausedLeft')
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
		<div><h3>${tl(o.type === 'sell' ? 'broker.mgSell' : 'broker.mgBuy', { usd: fmtM(amount), price: `${fmtP(o.price)} ${unit}` })}</h3>
			<p class="muted">${esc(nameOf(o.coin))} · <span class="chip ${o.status}">${STATUS[o.status] ?? o.status}</span>${o.isPrivate ? ` · ${tl('broker.private')}` : ''}${flex ? ` · ${tl('broker.mgParts', { min: fmtM(o.orderMin), max: fmtM(o.orderMax) })}` : ''}</p></div>
		${o.pause ? `<p class="notice warn">${pauseText(o.pause)}</p>` : rank ? `<p class="hint">${tl(o.type === 'sell' ? 'broker.mgRankAsk' : 'broker.mgRankBid', { rank })}</p>` : ''}
		${
			o.status === 'cancelled'
				? `<p class="notice">${tl('broker.mgCancelled')}</p>`
				: o.status !== 'open'
					? `<p class="notice">${tl('broker.mgTaken')} <button class="link" data-open-trade>${tl('broker.mgSeeTrade')}</button></p>`
					: ''
		}
		${
			editable
				? `<div class="stack tight"><p class="hint">${tl('broker.edTitle')}</p>
				<div class="grid2">
					<label class="field">${flex ? tl('broker.edAvailable') : tl('broker.amount')} (USD)<input class="input" id="edAmount" inputmode="decimal" data-num data-dec="2" autocomplete="off" value="${amount}" /></label>
					<label class="field">${tl('broker.pricePerUsd')} (${unit})<input class="input" id="edPrice" inputmode="decimal" data-num autocomplete="off" value="${Math.round(o.price * 10000) / 10000}" /></label>
				</div>
				<p class="hint" id="edTotal"></p><div id="edWarn"></div>
				${flex ? '' : `<label class="check"><input type="checkbox" id="edFlex" /> ${tl('broker.edFlex')}</label>`}
				<div class="grid2" id="edFlexBox" ${flex ? '' : 'hidden'}>
					<label class="field">${tl('broker.minPerOrder')}<input class="input" id="edMin" inputmode="decimal" data-num data-dec="2" autocomplete="off" value="${o.orderMin ?? ''}" /></label>
					<label class="field">${tl('broker.maxPerOrder')}<input class="input" id="edMax" inputmode="decimal" data-num data-dec="2" autocomplete="off" value="${o.orderMax ?? ''}" /></label>
				</div>
				${flex ? '' : `<p class="notice warn" id="edFlexNote" hidden>${tl('broker.edFlexNote')}</p>`}
				<details class="opts"><summary>${tl('broker.reqVis')}</summary><div class="stack tight">
					${Object.entries(REQ_OPTIONS)
						.map(([k, [label, vals, fmt]]) => {
							const cur = Number(o.requirements?.[k] ?? 0)
							// Un valor puesto desde la web de QvaPay que aquí no está en la lista se conserva
							const opts = cur && !vals.includes(cur) ? [...vals, cur].sort((a, b) => a - b) : vals
							return `<label class="field">${label}<select class="input" data-ed-req="${k}"><option value="0">${tl('broker.noReq')}</option>${opts.map((v) => `<option value="${v}" ${v === cur ? 'selected' : ''}>${fmt(v)}</option>`).join('')}</select></label>`
						})
						.join('')}
					<label class="check"><input type="checkbox" id="edVip" ${o.onlyVip ? 'checked' : ''} /> ${tl('broker.vipOnly')}</label>
					${o.isPrivate ? `<label class="check"><input type="checkbox" id="edPublic" /> ${tl('broker.edPublic')}</label>` : ''}
					${
						bk.acct.gold
							? `<label class="field">${tl('broker.publicMsg')}<input class="input" id="edMsg" maxlength="79" placeholder="${tl('broker.edMsgPh')}" value="${esc(o.message ?? '')}" /></label><p class="hint">${tl('broker.edMsgHint')}</p>`
							: o.message
								? `<p class="hint">${tl('broker.edMsgGold', { msg: esc(o.message) })}</p>`
								: ''
					}
				</div></details>
				<p class="hint">${tl('broker.edFixed')}</p>
				<button class="btn" id="edSave">${tl('broker.edSave')}</button></div>`
				: ''
		}
		${keepSlot(o, editable)}
		${req ? `<p class="hint">${tl('broker.reqLine', { req: esc(req) })}</p>` : ''}
		${
			// QvaPay devuelve todos los campos del mercado, también los que dejaste vacíos al publicar: solo van los rellenos
			o.details.some((d) => d.value)
				? `<div><p class="hint">${tl('broker.myDetails')}</p><div class="kv">${o.details
						.filter((d) => d.value)
						.map((d) => `<span>${esc(d.name)}</span><b>${esc(d.value)}</b><span></span>`)
						.join('')}</div></div>`
				: o.type === 'sell' && o.status === 'open'
					? `<p class="hint">${tl('broker.noDetails')}</p>`
					: ''
		}
		${
			flex && orders.length
				? `<div><p class="hint">${tl('broker.orders')}</p><table class="otable"><tbody>${orders
						.map(
							(x) =>
								`<tr data-order-row="${x.order}"><td class="num">${fmtM(x.usd)} USD</td><td class="num">${fmtM(x.coinAmount)} ${unit}</td><td>@${esc(x.taker ?? '—')}</td><td><span class="chip ${x.status}">${STATUS[x.status] ?? x.status}</span></td></tr>`,
						)
						.join('')}</tbody></table></div>`
				: ''
		}
		<div class="row-btns">
			${o.status === 'open' ? `<button class="btn" id="mgPause">${o.pause ? tl('broker.resume') : tl('broker.pause')}</button><button class="btn danger" id="mgCancel" ${bk.cancelling.has(o.offer) ? `disabled>${tl('broker.cancelling')}` : `>${tl('broker.cancelOffer')}`}</button>` : ''}
		</div>
		${o.status === 'open' ? `<div class="share"><p class="hint">${tl('broker.shareHint')}${o.isPrivate ? tl('broker.shareHintPrivate') : ''}</p><div class="row-btns"><button class="btn primary" id="mgShare">${ICON_SHARE} ${tl('broker.share')}</button><input class="input" id="mgLink" readonly value="${shareLink(o.offer)}" /><button class="btn icon-only" id="mgCopy" title="${tl('broker.copyLink')}" aria-label="${tl('broker.copyLink')}">${ICON_COPY}</button></div></div>` : ''}
		<p class="hint"><a class="link" href="https://www.qvapay.com/p2p/${o.offer}" target="_blank" rel="noopener">${tl('broker.openInQvaPay')}</a></p>
	</div>`

	$('mgShare')?.addEventListener('click', () => showShareOffer(o))
	$('mgCopy')?.addEventListener('click', () => {
		navigator.clipboard?.writeText($('mgLink').value)
		$('mgCopy').innerHTML = ICON_DONE
		setTimeout(() => $('mgCopy') && ($('mgCopy').innerHTML = ICON_COPY), 1400)
		toast(tl('broker.linkCopied'))
	})
	const refresh = () => showManageOffer(o.offer)
	if (editable) {
		const upd = () => {
			const a = num2($('edAmount').value)
			const p = Number($('edPrice').value)
			$('edTotal').innerHTML = a > 0 && p > 0 ? `${tl(o.type === 'sell' ? 'broker.youWillGet' : 'broker.youWillPay', { amount: `${fmtM(a * p)} ${unit}` })}${o.type === 'buy' ? netNote(a) : ''}` : ''
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
			const oneWay = [toFlexible && tl('broker.oneWayFlex'), makePublic && tl('broker.oneWayPublic')].filter(Boolean)
			if (oneWay.length && !(await confirmDialog(tl('broker.edSave'), `<p class="muted">${tl('broker.oneWay', { what: oneWay.join(tl('broker.oneWayAnd')) })}</p>`, tl('broker.edSave')))) return showManageOffer(o.offer)
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
		if (bk.cancelling.has(o.offer)) return
		const msg = o.type === 'sell' ? tl('broker.cancelSellBody') : tl('broker.cancelBuyBody')
		if (!(await confirmDialog(tl('broker.cancelOffer'), `<p class="muted">${msg}</p>`, tl('broker.cancelOffer'), 'danger'))) return showManageOffer(o.offer)
		try {
			const r = await cancelOffer(o.offer)
			if (!r) return
			toast(r.message || tl('broker.offerCancelled'))
			loadTrades()
			loadBook()
			// Cancelada: la ventana ya no tiene nada que hacer (el aviso de abajo dice que se canceló)
			closeModal()
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
	if ($('mgKeep')) window.TPPro?.active ? window.TPProKeep?.manage(o) : $('mgKeepPro')?.addEventListener('click', showPro)
}

// Mantener tu oferta la primera del libro (Pro): el módulo Pro rellena el hueco #mgKeep; sin Pro, se dice que existe.
// Solo en ofertas que se pueden editar y que están en el libro (las privadas no salen en él)
function keepSlot(o, editable) {
	if (!editable || o.isPrivate || !window.TPPro?.enabled) return ''
	if (window.TPPro.active) return '<div id="mgKeep"></div>'
	return `<p class="hint" id="mgKeep">${tl('broker.keepSlot')} <button class="link" id="mgKeepPro">${tl('broker.seePro')}</button></p>`
}

// ── Tomar una oferta del libro ────────────────────────────────────────
function showTakeOffer(uuid, side) {
	const l = findLevel(uuid, side)
	if (!l) return
	if (myUsername() && l.user === myUsername()) return showManageOffer(uuid)
	renderTake(uuid, side, l, state.book.coin.tick)
}

// Una oferta por su enlace (#p2p/<uuid>): la carga aunque no esté entre las que muestra el libro. amount: el monto
// con el que abrir una por rango (el que calculó el radar); sin él, el máximo que deja tomar
async function showTakeOfferById(uuid, amount) {
	// Sin cuenta conectada, lo que el libro en vivo sabe de ella (el enlace que comparte su dueño)
	if (!bk.acct.connected) return showPublicOffer(uuid, amount)
	openModal(`<p class="muted">${tl('broker.loadingOffer')}</p>`)
	let o
	try {
		o = await api(`/offer?offer=${encodeURIComponent(uuid)}`)
	} catch (e) {
		$('modalBody').innerHTML = `<p class="empty">${esc(e.message)}</p>`
		return
	}
	if (o.isOwner) return renderManage(o)
	if (o.status === 'open' && o.pause && window.showPaused) return showPaused(o.coin, o.type === 'sell' ? 'ask' : 'bid', o.offer, o.pause)
	if (o.status !== 'open' || o.pause) return showGone(o.coin, o.type === 'sell' ? 'ask' : 'bid', o.offer, tl(o.pause ? 'broker.goneStatusPaused' : 'broker.goneStatus', { status: (STATUS[o.status] ?? o.status).toLowerCase() }))
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
		image: o.owner?.image ?? null,
		ops: o.owner?.ops ?? null,
		rating: o.owner?.rating ?? null,
		kyc: false,
	}
	renderTake(o.offer, o.type === 'sell' ? 'ask' : 'bid', level, o.coin, amount)
}

const REQ_NAMES = { min_completed: [tl('broker.rnCompleted'), ''], min_rating: [tl('broker.rnRating'), '★'], min_account_days: [tl('broker.rnDays'), ''], min_trustscore: ['trustscore', ''] }
// ── Ofertas que puedes tomar ──────────────────────────────────────────
// Para el filtro «Solo las que puedo tomar»: ni tuyas ni solo VIP, con saldo para lo mínimo si les vendes y con
// requisitos que cumples. Las operaciones y la valoración salen de tu perfil de P2P (/me); la antigüedad de la cuenta y
// el TrustScore solo los dice el detalle de una oferta que los pide. Esos detalles se piden de uno en uno (REQ_GAP_MS,
// para no comerse las consultas de tu cuenta) y lo que enseñan sirve para las demás ofertas
const REQ_GAP_MS = 6000
const req = { user: null, seen: new Map(), least: {}, exact: {}, queue: new Set(), busy: false }

function reqReset() {
	if (req.user === bk.acct.username) return
	Object.assign(req, { user: bk.acct.username, seen: new Map(), least: {}, exact: {}, queue: new Set() })
}

// Lo que dice el detalle de una oferta sobre tus números: lo que falta trae tu valor exacto; lo que cumples, un mínimo
function learnReq(o) {
	reqReset()
	const missing = new Map((o.requirementsMissing ?? []).map((m) => [m.key, m]))
	for (const [key, need] of Object.entries(o.requirements ?? {})) {
		const m = missing.get(key)
		if (m) req.exact[key] = Number(m.actual)
		else if (o.requirementsMet != null) req.least[key] = Math.max(req.least[key] ?? 0, Number(need))
	}
	req.seen.set(o.offer, o.requirementsMet !== false)
}

function reqOk(key, need) {
	const a = bk.acct
	if (key === 'min_completed' && a.p2pCompleted != null) return a.p2pCompleted >= need
	if (key === 'min_rating' && a.p2pCompleted != null) return (a.p2pRating ?? 0) >= need
	if (req.exact[key] != null) return req.exact[key] >= need
	if (req.least[key] != null && need <= req.least[key]) return true
	return null
}

async function pumpReq() {
	// Las que ya no están en el libro (el que miras o un lado que vigila el radar) no se preguntan
	const radar = window.TPProRadar
	for (const u of req.queue) if (!findLevel(u, 'ask') && !findLevel(u, 'bid') && !radar?.has?.(u)) req.queue.delete(u)
	// Con la pestaña oculta solo sigue si el radar está vigilando
	if (req.busy || !req.queue.size || (document.hidden && !radar?.active?.())) return
	req.busy = true
	// Primero las del radar: de esa respuesta depende que la avise o la tome
	const uuid = [...req.queue].find((u) => radar?.has?.(u)) ?? req.queue.values().next().value
	req.queue.delete(uuid)
	try {
		learnReq(await api(`/offer?offer=${encodeURIComponent(uuid)}`))
		render()
	} catch {
		req.seen.set(uuid, false)
	}
	// El radar vuelve a pasar por sus reglas el lado que la tiene
	document.dispatchEvent(new CustomEvent('tp:req', { detail: uuid }))
	setTimeout(() => {
		req.busy = false
		pumpReq()
	}, REQ_GAP_MS)
}

// Sin cuenta conectada el filtro no aplica (no se puede tomar nada y el libro quedaría vacío)
function canTake(l, side) {
	const a = bk.acct
	if (!a.connected) return true
	if (a.p2pEnabled === false || l.user === a.username || l.vipOnly) return false
	// En una compra ajena vendes tú: hace falta saldo para lo mínimo que se puede tomar
	if (side === 'bid' && !((a.balance ?? 0) >= (l.kind === 'flexible' ? l.orderMin || 0.01 : l.usd))) return false
	reqReset()
	const met = l.requirementsMet ?? req.seen.get(l.uuid)
	if (met != null || !l.requirements) return met ?? true
	const r = Object.entries(l.requirements).map(([k, v]) => reqOk(k, Number(v)))
	if (r.includes(false)) return false
	if (!r.includes(null)) return true
	// Hasta saberlo no se enseña: se pregunta a QvaPay
	if (req.queue.size < 30) req.queue.add(l.uuid)
	pumpReq()
	return false
}

async function checkRequirements(uuid, l) {
	let o = l.requirementsMet === false ? l : null
	if (!o)
		try {
			o = await api(`/offer?offer=${encodeURIComponent(uuid)}`)
			learnReq(o)
		} catch {
			return
		}
	if (o.requirementsMet !== false || !$('tkGo')) return
	const why = (o.requirementsMissing ?? [])
		.map((m) => {
			const [name, unit] = REQ_NAMES[m.key] ?? [m.key, '']
			return tl('broker.reqMissing', { name, need: `${m.required}${unit}`, have: `${m.actual}${unit}` })
		})
		.join(' · ')
	$('tkGo').insertAdjacentHTML('beforebegin', `<p class="notice warn">${tl('broker.reqNotMet', { why: why ? ` (${esc(why)})` : '' })}</p>`)
	$('tkGo').disabled = true
}

function renderTake(uuid, side, l, coin, preset) {
	const unit = unitOf(coin)
	// En una venta ajena compras USD (pagas tú); en una compra ajena vendes USD (te pagan)
	const youBuy = side === 'ask'
	const flex = l.kind === 'flexible'
	const max = flex ? Math.min(l.orderMax ?? l.usd, l.usd) : l.usd
	const min = flex ? (l.orderMin ?? 0) : l.usd
	// Lo que se propone tomar: el monto pedido (dentro de lo que deja la oferta) o, si no, el máximo
	const start = flex && preset > 0 ? Math.min(max, Math.max(min, preset)) : max
	const req = reqText(l.requirements)
	openModal(`<div class="stack">
		<div><h3>${tl(youBuy ? 'broker.tkBuyTitle' : 'broker.tkSellTitle', { price: `${fmtP(l.price)} ${unit}` })}</h3>
			<p class="muted who-ava">${avatar(l.user, l.image, 'sm')}${esc(nameOf(coin))} · <button type="button" class="link peer-link" data-peer="${esc(l.user)}">@${esc(l.user)}</button>${l.ops != null ? ` · ${tl('broker.nOps', { n: String(l.ops) })}` : ''}${l.rating ? ` · ⭐ ${l.rating.toFixed(2)}` : l.ops != null ? ` · ${tl('broker.noRatings')}` : ''}${l.kyc ? ' · KYC' : ''}</p>
			${typeof rankText === 'function' && rankText(l.user) ? `<p class="rank-line">🏆 ${tl('broker.rankingLine', { rank: esc(rankText(l.user)) })}</p>` : ''}</div>
		<div class="kv">
			<span>${youBuy ? tl('broker.tkSells') : tl('broker.tkBuys')}</span><b>${fmtM(l.usd)} USD</b><span></span>
			${flex ? `<span>${tl('broker.tkPerOrder')}</span><b>${min ? `${fmtM(min)}–${fmtM(max)}` : tl('broker.tkUpTo', { max: fmtM(max) })} USD</b><span></span>` : ''}
			${req ? `<span>${tl('broker.kvReq')}</span><b>${esc(req)}</b><span></span>` : ''}
			${l.vipOnly ? `<span>${tl('broker.tkOnly')}</span><b>${tl('broker.tkVipAccounts')}</b><span></span>` : ''}
		</div>
		${flex ? `<label class="field">${tl(youBuy ? 'broker.tkHowManyBuy' : 'broker.tkHowManySell')}<input class="input" id="tkAmount" inputmode="decimal" data-num data-dec="2" autocomplete="off" value="${start}" /></label>` : ''}
		<p class="hint" id="tkTotal"></p>
		<p class="notice">${youBuy ? tl('broker.tkNoteBuy') : tl('broker.tkNoteSell')}</p>
		${
			bk.acct.connected
				? '<button class="btn primary block" id="tkGo"></button>'
				: `<button class="btn primary block" id="tkConnect">${tl(youBuy ? 'broker.tkConnectBuy' : 'broker.tkConnectSell')}</button>`
		}
		<p class="hint"><a class="link" href="https://www.qvapay.com/p2p/${uuid}" target="_blank" rel="noopener">${tl('broker.seeInQvaPay')}</a></p>
	</div>`)
	const amount = () => (flex ? num2($('tkAmount').value) : l.usd)
	const upd = () => {
		const a = amount()
		const total = a * l.price
		$('tkTotal').innerHTML = a > 0 ? `${tl(youBuy ? 'broker.tkPay' : 'broker.tkGet', { total: `${fmtM(total)} ${unit}`, usd: fmtM(a) })}${youBuy ? netNote(a) : ''}` : ''
		if ($('tkGo')) $('tkGo').textContent = tl(youBuy ? 'broker.tkGoBuy' : 'broker.tkGoSell', { usd: fmtM(a) })
	}
	$('tkAmount')?.addEventListener('input', upd)
	$('tkConnect')?.addEventListener('click', () => {
		const a = amount()
		showConnect(tl('broker.connectToTake'), () => showTakeOfferById(uuid, a))
	})
	$('modalBody').querySelector('[data-peer]')?.addEventListener('click', (e) => showPeer(e.currentTarget.dataset.peer))
	upd()
	// Con requisitos, QvaPay dice si los cumples: si no, se avisa antes de gastar un intento de los 2 por minuto
	if (req && bk.acct.connected) checkRequirements(uuid, l)
	$('tkGo')?.addEventListener('click', async () => {
		const a = amount()
		if (flex && !(a >= min && a <= max)) return toast(tl('broker.errBetween', { min: fmtM(min), max: fmtM(max) }), true)
		const btn = $('tkGo')
		btn.disabled = true
		btn.textContent = tl('broker.taking')
		try {
			// Con el precio y el monto que ves: si cambiaron, el servidor no la toma
			const r = await api('/offer/apply', { offer: uuid, amount: flex ? a : undefined, price: l.price, usd: flex ? undefined : l.usd })
			markOrigin(r.offer)
			// Una fija: el servidor te avisa de lo que haga su dueño (en las de rango QvaPay no avisa de cada parte)
			if (!flex) window.TPPush?.watch(r.offer)
			toast(r.message || tl('broker.taken'))
			bk.tab = 'active'
			await loadTrades()
			loadBook()
			openTrade(r.offer, r.order)
		} catch (e) {
			toast(e.message, true)
			// Cambió mientras decidías: se vuelve a enseñar con el precio y el monto de ahora, para que decidas otra vez
			if (e.fresh?.price > 0) return renderTake(uuid, side, { ...l, price: e.fresh.price, usd: flex ? l.usd : e.fresh.usd }, coin, a)
			btn.disabled = false
			upd()
		}
	})
}

// ── Ficha de un usuario ───────────────────────────────────────────────
// Perfil, señales de confianza, sus ofertas abiertas y lo que has hecho con él. QvaPay no da el
// historial de otro usuario: solo lo que tiene publicado ahora y lo que ha pasado entre los dos
const PEER_OUTLIER_PCT = 0.35

// Su ficha entera, de una operación tuya con él (QvaPay la manda con cada operación): para quien te toma una
// oferta sin tener ninguna publicada
function tradeProfile(user) {
	const u = user.toLowerCase()
	return bk.trades.find((x) => x.counterparty?.username?.toLowerCase() === u && x.counterparty.profile)?.counterparty.profile ?? null
}

// Lo que ya se sabe de un usuario por el libro o por tus operaciones (si no tiene ofertas abiertas)
function knownPeer(user) {
	const u = user.toLowerCase()
	const b = state.book
	const l = b && [...b.ask.levels, ...b.bid.levels].find((x) => x.user.toLowerCase() === u)
	if (l) return { ops: l.ops, rating: l.rating, kyc: l.kyc, vip: l.vip, gold: l.gold }
	const t = bk.trades.find((x) => x.counterparty?.username?.toLowerCase() === u)
	return t ? { ops: t.counterparty.ops, rating: t.counterparty.rating, image: t.counterparty.image } : null
}

function peerSignals(p, known, offers) {
	const out = []
	const ops = p ? p.opsOwner + p.opsTaker : (known?.ops ?? null)
	const rating = p ? p.rating : (known?.rating ?? null)
	if (p) {
		const missing = [!p.kyc && tl('broker.sigKyc'), p.phone === false && tl('broker.sigPhone'), p.telegram === false && 'Telegram'].filter(Boolean)
		out.push(missing.length ? ['warn', tl('broker.sigUnverified', { what: missing.join(', ') })] : ['ok', tl('broker.sigVerified')])
	}
	if ((p?.vip ?? known?.vip) === true) out.push(['ok', tl('broker.sigVip')])
	if (ops != null) {
		if (ops >= 200) out.push(['ok', tl('broker.sigManyOps', { n: ops })])
		else if (ops < 10) out.push(['warn', tl('broker.sigFewOps', { n: ops })])
		else out.push(['info', tl('broker.sigOps', { n: ops })])
	}
	if (rating == null) out.push(['warn', tl('broker.sigNoRatings')])
	else if (rating < 4.5) out.push(['warn', tl('broker.sigLowRating', { r: rating.toFixed(2) })])
	else if (rating >= 4.8 && (p?.ratings ?? 10) >= 10) out.push(['ok', `${tl('broker.sigHighRating', { r: rating.toFixed(2) })}${p ? ` (${tl('broker.nRatings', { n: p.ratings })})` : ''}`])
	if (p && p.opsOwner + p.opsTaker >= 20) {
		const taker = p.opsTaker / (p.opsOwner + p.opsTaker)
		if (taker >= 0.75) out.push(['info', tl('broker.sigTaker', { pct: Math.round(taker * 100) })])
		else if (taker <= 0.25) out.push(['info', tl('broker.sigMaker', { pct: Math.round((1 - taker) * 100) })])
	}
	// Precio muy lejos del mercado: casi siempre un error de tipeo, a veces un intento de engaño
	const far = offers.filter((o) => {
		const m = state.overview.find((c) => c.tick === o.coin)
		const mid = m?.ask && m?.bid ? (m.ask + m.bid) / 2 : (m?.ask ?? m?.bid)
		return mid && Math.abs(o.price / mid - 1) > PEER_OUTLIER_PCT
	})
	if (far.length) out.push(['warn', tl('broker.sigFar', { n: far.length })])
	return out
}

async function showPeer(user, peerId = null) {
	user = String(user ?? '').trim().replace(/^@/, '')
	// «—» u otro hueco: aún no se sabe de quién es (no se abre una ficha vacía que solo dice «Usuario no válido»)
	if (!/^[A-Za-z0-9._-]{1,40}$/.test(user)) return toast(tl('broker.peerUnknown'), true)
	if (!bk.acct.connected) return toast(tl('broker.connectToPeer'), true)
	// Abierta desde una operación: esa deja de refrescarse (cada 8 s), si no volvía a pintarse encima de la ficha
	bk.detail = null
	stopChatLive()
	openModal(`<div class="stack"><h3>@${esc(user)}</h3><p class="muted">${tl('broker.loadingPeer')}</p></div>`)
	let d
	try {
		d = await api(`/peer?user=${encodeURIComponent(user)}`)
	} catch (e) {
		$('modalBody').innerHTML = `<div class="stack"><h3>@${esc(user)}</h3><p class="empty">${esc(e.message)}</p></div>`
		return
	}
	if (!$('modalBody').textContent.includes(tl('broker.loadingPeer'))) return // la cerraron mientras cargaba
	const p = d.profile ?? tradeProfile(user)
	const known = p ? null : knownPeer(user)
	if (p?.uuid) watchOnline([{ id: p.uuid, u: p.username }])
	const qpId = p?.uuid ?? (/^[0-9a-f-]{36}$/i.test(peerId ?? '') ? peerId : null) ?? tradePeerId(user)
	const name = p?.username ?? user
	rememberFace(name, p?.image)
	const me = myUsername()
	const isMe = me && name.toLowerCase() === me.toLowerCase()
	const badges = [
		(p?.kyc ?? known?.kyc) && '<span class="badge ok">KYC</span>',
		(p?.vip ?? known?.vip) && '<span class="badge ok">VIP</span>',
		(p?.gold ?? known?.gold) && '<span class="badge warn">GOLD</span>',
		p?.phone && `<span class="badge neutral">${tl('broker.badgePhone')}</span>`,
		p?.telegram && '<span class="badge neutral">Telegram</span>',
	]
		.filter(Boolean)
		.join(' ')
	const ops = p ? p.opsOwner + p.opsTaker : known?.ops
	const rating = p ? p.rating : known?.rating
	const stat = (label, value, sub = '') => `<div class="peer-stat"><span>${label}</span><b>${value}</b>${sub ? `<small>${sub}</small>` : ''}</div>`
	const signals = peerSignals(p, known, d.offers)
	const rank = typeof rankText === 'function' ? rankText(name) : ''
	const now = nowMs()
	const offers = d.offers
		.map((o) => {
			const unit = unitOf(o.coin)
			const range = o.kind === 'flexible' ? `${o.orderMin ? fmtM(o.orderMin) : '0'}–${fmtM(o.orderMax ?? o.usd)}` : fmtM(o.usd)
			const t = Date.parse(o.updatedAt ?? o.createdAt ?? '')
			return `<button type="button" class="peer-offer" data-peer-offer="${esc(o.offer)}">
				<span class="po-side ${o.type === 'sell' ? 'ask' : 'bid'}">${o.type === 'sell' ? tl('broker.tkSells') : tl('broker.tkBuys')}</span>
				<span class="po-mkt">${esc(nameOf(o.coin))}${o.vipOnly ? tl('broker.kvVipOnly') : ''}${o.paused ? tl('broker.poPaused') : ''}</span>
				<span class="po-price mono">${fmtP(o.price)} <small>${esc(unit)}</small></span>
				<span class="po-usd mono">${range} USD</span>
				<span class="po-age">${t ? tl('broker.ago', { t: ago(now - t) }) : ''}</span>
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
				<span>${tl(t.side === 'buy' ? 'broker.youBoughtFrom' : 'broker.youSoldTo', { usd: fmtM(t.usd) })} · ${esc(nameOf(t.coin))}${t.updatedAt ? ` <small class="muted">· ${cubaFmt(t.updatedAt, { day: 'numeric', month: 'short' })}</small>` : ''}</span>
				<span class="chip ${t.status}">${STATUS[t.status] ?? t.status}</span></button>`,
		)
		.join('')

	$('modalBody').innerHTML = `<div class="stack peer">
		<div class="peer-head">
			${avatar(name, p?.image ?? known?.image, 'lg')}
			<div><h3>@${esc(name)}${isMe ? ` <span class="badge info">${tl('broker.you')}</span>` : ''}</h3><div class="peer-badges">${badges || `<span class="muted small">${tl('broker.noVerif')}</span>`}</div></div>
		</div>
		<div class="peer-stats">
			${stat(tl('broker.statOps'), ops != null ? ops.toLocaleString('en-US') : '—', p ? tl('broker.statOpsSub', { owner: p.opsOwner, taker: p.opsTaker }) : '')}
			${stat(tl('broker.statRating'), rating != null ? `⭐ ${rating.toFixed(2)}` : '—', p ? tl('broker.nRatings', { n: p.ratings }) : '')}
			${stat(tl('broker.statOffers'), String(d.offers.length), d.offers.length ? tl('broker.statOffersSub', { usd: fmtM(d.offers.reduce((s, o) => s + o.usd, 0)) }) : '')}
		</div>
		${qpId ? (window.TPPro?.active ? '<div id="peerQp" class="peer-qp"></div>' : `<button type="button" class="peer-qp-up" data-peer-pro><b>★ Pro</b> ${tl('broker.qpUpsell')}</button>`) : ''}
		${rank ? `<p class="rank-line">🏆 ${tl('broker.rankingLine', { rank: esc(rank) })}</p>` : ''}
		${signals.length ? `<ul class="peer-signals">${signals.map(([k, t]) => `<li class="${k}">${esc(t)}</li>`).join('')}</ul>` : ''}
		<div><p class="hint">${tl('broker.openNow')}</p>${offers ? `<div class="peer-offers">${offers}</div>` : `<p class="muted small">${tl('broker.noOpenNow')}</p>`}</div>
		${
			isMe
				? ''
				: `<div><p class="hint">${tl('broker.historyWith', { user: esc(name) })}</p>${
						together.length
							? `<p class="small">${tl('broker.historyCount', { n: together.length })} · ${tl('broker.historyDone', { n: done.length })}${vol ? ` · ${fmtM(vol)} USD` : ''}</p><div class="peer-trades">${history}</div>`
							: `<p class="muted small">${tl('broker.historyNone')}</p>`
					}</div>`
		}
	</div>`
	for (const b of $('modalBody').querySelectorAll('[data-peer-offer]')) b.onclick = () => showTakeOfferById(b.dataset.peerOffer)
	for (const b of $('modalBody').querySelectorAll('[data-peer-trade]')) b.onclick = () => openTrade(b.dataset.peerTrade, b.dataset.order || null)
	const up = $('modalBody').querySelector('[data-peer-pro]')
	if (up) up.onclick = () => (closeModal(), typeof showPro === 'function' && showPro())
	if (qpId && window.TPPro?.active) showPeerStats(qpId)
}

// El uuid de QvaPay de un usuario por tus operaciones con él: quien aplica a tu oferta sin tener nada publicado no
// trae el perfil entero, pero sí su uuid
function tradePeerId(user) {
	const u = user.toLowerCase()
	return bk.trades.find((x) => x.counterparty?.username?.toLowerCase() === u && x.counterparty.uuid)?.counterparty.uuid ?? null
}

// ★ Pro: su actividad en el P2P de QvaPay (de todo QvaPay, no solo del terminal). Llega aparte y, si no se puede, el
// bloque no sale. Sin volumen ni mercados: en QvaPay eso solo lo ven las cuentas GOLD
async function showPeerStats(uuid) {
	let s
	try {
		const r = await fetch(`/data/peer-stats?id=${encodeURIComponent(uuid)}&l=${encodeURIComponent(window.TPPro.license ?? '')}`)
		// El tope de fichas por minuto o por día: se dice en el bloque en vez de quitarlo
		if (r.status === 429) {
			const msg = (await r.json().catch(() => null))?.error
			if ($('peerQp')) $('peerQp').innerHTML = `<p class="hint">★ ${tl('broker.qpTitle')}</p><p class="muted small">${esc(msg || tl('broker.qpWait'))}</p>`
			return
		}
		if (!r.ok) throw new Error()
		s = await r.json()
	} catch {
		$('peerQp')?.remove()
		return
	}
	const box = $('peerQp')
	if (!box) return // la cerraron o abrieron otra ficha
	const stat = (label, value, sub = '') => `<div class="peer-stat"><span>${label}</span><b>${value}</b>${sub ? `<small>${sub}</small>` : ''}</div>`
	const since = s.since ? cubaFmt(Date.parse(s.since), { month: 'short', year: 'numeric' }) : null
	const most = Math.max(1, ...Object.values(s.stars))
	const stars = ['5', '4', '3', '2', '1'].map((k) => `<div class="qp-star"><span>${k}★</span><i style="--w:${(s.stars[k] / most) * 100}%"></i><b>${s.stars[k].toLocaleString('en-US')}</b></div>`).join('')
	box.innerHTML = `<p class="hint">★ ${tl('broker.qpTitle')}${since ? ` · ${tl('broker.qpSince', { since: esc(since) })}` : ''}</p>
		<div class="peer-stats">
			${stat(tl('broker.qp30d'), tl('broker.opsShort', { n: s.ops30d }))}
			${stat(tl('broker.qpDone'), s.completed.toLocaleString('en-US'), s.peers != null ? tl('broker.qpPeers', { n: s.peers }) : '')}
			${stat(tl('broker.qpCancelled'), s.cancelled.toLocaleString('en-US'), tl('broker.qpEitherSide'))}
		</div>
		${s.raters ? `<div class="qp-stars" title="${tl('broker.qpRaters', { n: s.raters })}">${stars}</div>` : ''}`
	fillFromQp(s)
}

// Sin su perfil (quien tomó tu oferta y no tiene nada publicado) arriba faltan operaciones y valoración, y las señales
// decían «Pocas operaciones (0)» o «Sin valoraciones todavía». Con su actividad en QvaPay se completan y se quitan
function fillFromQp(s) {
	const body = $('modalBody')
	const card = (label) => [...body.querySelectorAll('.peer > .peer-stats .peer-stat')].find((c) => c.querySelector('span')?.textContent === label)?.querySelector('b')
	const avg = s.raters ? ['1', '2', '3', '4', '5'].reduce((t, k) => t + Number(k) * s.stars[k], 0) / s.raters : null
	const ops = card(tl('broker.statOps'))
	if (ops?.textContent === '—') ops.textContent = s.completed.toLocaleString('en-US')
	const rate = card(tl('broker.statRating'))
	if (rate?.textContent === '—' && avg != null) rate.textContent = `⭐ ${avg.toFixed(2)}`
	for (const li of body.querySelectorAll('.peer-signals li')) {
		const t = li.textContent
		if ((avg != null && t === tl('broker.sigNoRatings')) || (s.completed >= 10 && t === tl('broker.sigFewOps', { n: 0 }))) li.remove()
	}
	const list = body.querySelector('.peer-signals')
	if (list && !list.children.length) list.remove()
}

// ── Comprar ya: comprar USD a la oferta de venta más barata en la que cabe tu monto ──
// Como «Vender», pero al revés y con cualquier vendedor: sus USD ya están en el escrow de QvaPay y tú pagas después de
// tomarla, a los datos que te da por el chat. Lo demás es una compra normal en «Mis operaciones»
async function showBuy() {
	const markets = state.overview.length ? state.overview : [{ tick: state.coin, name: nameOf(state.coin) }]
	const sw = { coin: store.get('swap.buyCoin', state.coin || 'BANK_CUP'), amount: store.get('swap.buyAmount', 50), quote: null, loading: false, error: '', timer: null, seq: 0, tried: 0, taking: false }
	if (!markets.some((m) => m.tick === sw.coin)) sw.coin = markets[0].tick
	openModal(
		`<div class="stack swap">
		<div class="swap-head">${swapTabs('buy')}</div>
		<p class="muted swap-sub">${tl('broker.swBuySub')}</p>
		<div class="swap-box">
			<div class="swap-row"><span>${tl('broker.kvBuy')}</span></div>
			<div class="swap-main">
				<input class="swap-input mono" id="swAmount" inputmode="decimal" data-num data-dec="2" autocomplete="off" value="${sw.amount}" aria-label="${tl('broker.swBuyAria')}" />
				<span class="swap-asset"><span class="swap-coin usd">$</span>USD QvaPay</span>
			</div>
		</div>
		<div class="swap-arrow" aria-hidden="true"><svg viewBox="0 0 24 24" width="18" height="18"><path d="M12 5v14M6 13l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg></div>
		<div class="swap-box">
			<div class="swap-row"><span>${tl('broker.kvPay')}</span><span class="swap-age" id="swAge"></span></div>
			<div class="swap-main">
				<b class="swap-out pay mono" id="swOut">—</b>
				<select class="swap-select" id="swCoin" aria-label="${tl('broker.swPayWith')}">${markets.map((m) => `<option value="${m.tick}" ${m.tick === sw.coin ? 'selected' : ''}>${esc(TPI18N.coin(m.tick, m.name))}</option>`).join('')}</select>
			</div>
		</div>
		<div id="swQuote" class="swap-quote"></div>
		${bk.acct.connected ? `<button class="btn primary block swap-go" id="swGo" disabled>${tl('broker.swBuy')}</button>` : `<button class="btn primary block" id="swConnect">${tl('broker.swConnectBuy')}</button>`}
		<p class="hint swap-foot">${tl('broker.swBuyFoot')}</p>
	</div>`,
		() => clearInterval(sw.timer),
	)
	bindSwapTabs(() => clearInterval(sw.timer))
	$('swConnect')?.addEventListener('click', showConnect)
	const amount = () => num2($('swAmount')?.value)
	const unit = () => unitOf(sw.coin)

	const options = (offers) =>
		offers
			.slice(0, 4)
			.map((o) => {
				const target = o.kind === 'flexible' ? Math.min(Math.max(amount() || 0, o.orderMin ?? 0), o.orderMax ?? o.usd) : o.usd
				const range = o.kind === 'flexible' ? `${o.orderMin ? fmtM(o.orderMin) : '0'}–${fmtM(o.orderMax ?? o.usd)} USD` : tl('broker.swExact', { usd: fmtM(o.usd) })
				return `<button type="button" class="chip-btn" data-sw-pick="${target}">${tl('broker.swPick', { range, price: fmtP(o.price) })}</button>`
			})
			.join('')

	function render() {
		if (!$('swOut')) return
		const q = sw.quote
		const best = q?.best
		const a = amount()
		$('swOut').textContent = best && a > 0 ? fmtM(a * best.price) : '—'
		$('swOut').classList.toggle('dim', !best)
		if ($('swAge')) $('swAge').textContent = sw.loading ? tl('broker.updating') : q ? tl('broker.priceAge', { s: Math.max(0, Math.round((Date.now() - q.at) / 1000)) }) : ''
		let html = ''
		if (!bk.acct.connected) html = `<p class="notice">${tl('broker.swBuyNoAcct')}</p>`
		else if (sw.error) html = `<p class="notice warn">${esc(sw.error)}</p>`
		else if (!q) html = `<p class="hint">${tl('broker.swSearchingAsks')}</p>`
		else if (!q.offers.length) html = `<p class="notice warn">${tl('broker.swNoSellers', { market: esc(nameOf(sw.coin)) })}</p>`
		else if (!best) html = `<p class="notice warn">${a > 0 ? tl('broker.swNoSellerFor', { usd: fmtM(a) }) : tl('broker.swHowManyBuy')} ${tl('broker.swPossible')}</p><div class="swap-picks">${options(q.offers)}</div>`
		else
			html = `<div class="kv swap-kv">
				<span>${tl('broker.colPrice')}</span><b>1 USD = ${fmtP(best.price)} ${esc(unit())}</b><span></span>
				<span>${tl('broker.tkSells')}</span><b>@${esc(best.user)}${best.vip ? ' <span class="badge ok">VIP</span>' : ''}${best.gold ? ' <span class="badge warn">GOLD</span>' : ''}</b><span></span>
				<span>${tl('broker.reputation')}</span><b>${best.rating ? `⭐ ${best.rating.toFixed(2)}` : tl('broker.noRatings')}${best.ops != null ? ` · ${tl('broker.nOps', { n: best.ops })}` : ''}</b><span></span>
			</div>`
		$('swQuote').innerHTML = html
		const go = $('swGo')
		if (go) {
			// Mientras se toma, ni el refresco de cada segundo ni una cotización nueva lo vuelven a activar
			go.disabled = sw.taking || !best || !(a > 0) || sw.loading
			go.textContent = sw.taking ? tl('broker.buying') : !best ? tl('broker.swBuy') : tl('broker.swBuyGo', { usd: fmtM(a), total: `${fmtM(a * best.price)} ${unit()}` })
		}
	}

	async function quote(fresh = false) {
		if (!bk.acct.connected) return render()
		const seq = ++sw.seq
		sw.tried = Date.now()
		sw.loading = true
		render()
		try {
			const q = await api(`/swap/quote?side=buy&coin=${sw.coin}&amount=${amount() || 0}${fresh ? '&fresh=1' : ''}`)
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
		store.set('swap.buyAmount', amount())
		render()
		clearTimeout(typing)
		typing = setTimeout(() => quote(), 250)
	})
	$('swCoin').addEventListener('change', () => {
		sw.coin = $('swCoin').value
		store.set('swap.buyCoin', sw.coin)
		sw.quote = null
		quote()
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
		if (!best || sw.taking) return
		const total = a * best.price
		const ok = await askConfirm(
			tl('broker.swConfirmBuy'),
			`<div class="kv">
				<span>${tl('broker.kvBuy')}</span><b>${fmtM(a)} USD</b><span></span>
				<span>${tl('broker.kvPay')}</span><b>${fmtM(total)} ${esc(unit())}</b><span></span>
				<span>${tl('broker.swWith')}</span><b>${esc(nameOf(sw.coin))}</b><span></span>
				<span>${tl('broker.tkSells')}</span><b>@${esc(best.user)}${best.vip ? ' (VIP)' : ''}</b><span></span>
			</div>
			<p class="notice">${tl('broker.swConfirmBuyNote', { usd: fmtM(a), total: `${fmtM(total)} ${esc(unit())}` })}</p>`,
			tl('broker.swBuy'),
			'primary',
		)
		if (!ok || sw.taking) return
		sw.taking = true
		render()
		try {
			const r = await api('/swap/buy', { offer: best.offer, amount: a, maxPrice: best.price })
			markOrigin(r.offer)
			window.TPPush?.watch(r.offer)
			toast(tl('broker.swBuyStarted', { user: best.user }))
			clearInterval(sw.timer)
			bk.tab = 'active'
			await loadTrades()
			loadBook()
			openTrade(r.offer, r.order)
		} catch (e) {
			sw.taking = false
			toast(e.message, true)
			if (e.status === 409) quote(true)
			else render()
		}
	})

	sw.timer = setInterval(() => {
		if (document.hidden || sw.loading || sw.taking) return
		if (bk.acct.connected && Date.now() - Math.max(sw.quote?.at ?? 0, sw.tried) >= SWAP_REFRESH_MS) quote(true)
		else render()
	}, 1000)
	quote()
}

// ── Vender ya: vender saldo a la oferta de compra que más paga ──
// Se ve como un swap: pones cuántos USD vendes y dónde quieres el dinero, y el terminal elige la
// oferta de compra que más paga en la que cabe ese monto. Por dentro es una operación P2P normal:
// tus USD quedan en el escrow de QvaPay y el comprador te transfiere a los datos que le pasas por el chat (si no es
// VIP, liberas tú al ver el pago)
const SWAP_REFRESH_MS = 15_000

// Comprar o vender: dos pestañas en la misma ventana. Se abre en la última que usaste (Comprar la primera vez: en el
// terminal casi todo es comprar USD)
const swapTabs = (mode) =>
	`<div class="seg-tabs swap-tabs" role="tablist">${[
		['buy', tl('broker.swBuy')],
		['sell', tl('broker.swSell')],
	]
		.map(([m, t]) => `<button type="button" role="tab" class="seg-tab${m === mode ? ' active' : ''}" aria-selected="${m === mode}" data-sw-mode="${m}">${t}</button>`)
		.join('')}</div>`
function bindSwapTabs(stop) {
	for (const b of document.querySelectorAll('[data-sw-mode]'))
		b.addEventListener('click', () => {
			if (b.classList.contains('active')) return
			stop()
			showSwap(b.dataset.swMode)
		})
}

async function showSwap(mode) {
	mode = mode === 'buy' || mode === 'sell' ? mode : store.get('swap.mode', 'buy')
	store.set('swap.mode', mode)
	if (mode === 'buy') return showBuy()
	const markets = state.overview.length ? state.overview : [{ tick: state.coin, name: nameOf(state.coin) }]
	const sw = { coin: store.get('swap.coin', 'BANK_CUP'), amount: store.get('swap.amount', 100), quote: null, loading: false, error: '', timer: null, seq: 0, tried: 0, taking: false }
	if (!markets.some((m) => m.tick === sw.coin)) sw.coin = markets[0].tick
	openModal(
		`<div class="stack swap">
		<div class="swap-head">${swapTabs('sell')}</div>
		<p class="muted swap-sub">${tl('broker.swSellSub')}</p>
		<div class="swap-box">
			<div class="swap-row"><span>${tl('broker.kvSell')}</span>${bk.acct.connected ? `<button type="button" class="link small" id="swMax">${tl('broker.balanceLink', { bal: fmtM(bk.acct.balance ?? 0) })}</button>` : ''}</div>
			<div class="swap-main">
				<input class="swap-input mono" id="swAmount" inputmode="decimal" data-num data-dec="2" autocomplete="off" value="${sw.amount}" aria-label="${tl('broker.swSellAria')}" />
				<span class="swap-asset"><span class="swap-coin usd">$</span>USD QvaPay</span>
			</div>
		</div>
		<div class="swap-arrow" aria-hidden="true"><svg viewBox="0 0 24 24" width="18" height="18"><path d="M12 5v14M6 13l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg></div>
		<div class="swap-box">
			<div class="swap-row"><span>${tl('broker.kvReceive')}</span><span class="swap-age" id="swAge"></span></div>
			<div class="swap-main">
				<b class="swap-out mono" id="swOut">—</b>
				<select class="swap-select" id="swCoin" aria-label="${tl('broker.swWhere')}">${markets.map((m) => `<option value="${m.tick}" ${m.tick === sw.coin ? 'selected' : ''}>${esc(TPI18N.coin(m.tick, m.name))}</option>`).join('')}</select>
			</div>
		</div>
		<div id="swQuote" class="swap-quote"></div>
		<div id="swDetailsBox" class="stack tight">
			<div class="swap-saved" id="swSaved" hidden></div>
			<div id="swEdit" class="stack tight">
				<p class="hint">${tl('broker.swDetailsHint')}</p>
				<div class="saved-methods" id="swMethods" hidden></div>
				<div id="swDetails" class="stack tight"></div>
				<label class="check"><input type="checkbox" id="swRemember" /> ${tl('broker.connectRemember')}</label>
			</div>
		</div>
		${bk.acct.connected ? `<button class="btn buy block swap-go" id="swGo" disabled>${tl('broker.swSell')}</button>` : `<button class="btn primary block" id="swConnect">${tl('broker.swConnectSell')}</button>`}
		<p class="hint swap-foot">${tl('broker.swSellFoot')}</p>
	</div>`,
		() => clearInterval(sw.timer),
	)
	bindSwapTabs(() => clearInterval(sw.timer))
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
		if ($('swMax')) $('swMax').innerHTML = tl('broker.balanceLink', { bal: fmtM(bk.acct.balance ?? 0) })
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
		const saved = store.getMine(`details.${sw.coin}`, {})
		const list = fields[sw.coin] ?? []
		$('swRemember').checked = Object.keys(saved).length > 0
		$('swDetails').innerHTML = list.length
			? list
					.map((f) => {
						const label = esc(f.label || f.name)
						return f.type === 'select' && f.options?.length
							? `<label class="field">${label}<select class="input" data-sw-detail="${esc(f.name)}" data-label="${label}">${f.options.map((o) => `<option ${o.value === saved[f.name] ? 'selected' : ''}>${esc(o.value)}</option>`).join('')}</select></label>`
							: `<label class="field">${label}<input class="input" data-sw-detail="${esc(f.name)}"${window.TPNum?.detail(f.name) ?? ''} data-label="${label}" value="${esc(window.TPNum?.show(f.name, saved[f.name]) ?? saved[f.name] ?? '')}" placeholder="${esc(f.placeholder ?? '')}" autocomplete="off" /></label>`
					})
					.join('')
			: `<p class="notice warn">${tl('broker.fieldsFailReopen')}</p>`
		for (const i of $('swDetails').querySelectorAll('[data-sw-detail]')) i.addEventListener('input', render)
		savedMethodChips($('swMethods'), sw.methods, sw.coin, () => [...$('swDetails').querySelectorAll('[data-sw-detail]')], (el) => el.dataset.swDetail)
		// Con los datos ya guardados basta un resumen; se editan con «Cambiar»
		const complete = list.length > 0 && list.every((f) => saved[f.name])
		$('swSaved').hidden = !complete
		$('swEdit').hidden = complete
		if (complete) {
			const card = list.find((f) => /tarjeta|cuenta|card/i.test(f.name))
			const shown = card ? `${esc(card.label || card.name)} <b>···· ${esc(String(saved[card.name]).replace(/\s/g, '').slice(-4))}</b>` : `<b>${esc(saved[list[0].name])}</b>`
			$('swSaved').innerHTML = `<span>${tl('broker.swPaidTo', { shown })}</span><button type="button" class="link small" id="swChange">${tl('broker.change')}</button>`
			$('swChange').onclick = () => {
				$('swSaved').hidden = true
				$('swEdit').hidden = false
			}
		}
	}
	const details = () => [...document.querySelectorAll('[data-sw-detail]')].map((i) => ({ name: i.dataset.swDetail, label: i.dataset.label, value: window.TPNum?.val(i) ?? i.value.trim() }))

	// Montos que sí caben, para cuando ninguna oferta acepta el que pusiste
	// Solo las que tu saldo alcanza
	const reachable = (offers) => offers.filter((o) => (o.kind === 'flexible' ? (o.orderMin ?? 0) : o.usd) <= maxUsd())
	const options = (offers) =>
		reachable(offers)
			.slice(0, 4)
			.map((o) => {
				const target = o.kind === 'flexible' ? Math.min(Math.max(amount() || 0, o.orderMin ?? 0), o.orderMax ?? o.usd, maxUsd()) : o.usd
				const range = o.kind === 'flexible' ? `${o.orderMin ? fmtM(o.orderMin) : '0'}–${fmtM(o.orderMax ?? o.usd)} USD` : tl('broker.swExact', { usd: fmtM(o.usd) })
				return `<button type="button" class="chip-btn" data-sw-pick="${target}">${tl('broker.swPick', { range, price: fmtP(o.price) })}</button>`
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
		if (!bk.acct.connected) html = `<p class="notice">${tl('broker.swSellNoAcct')}</p>`
		else if (sw.error) html = `<p class="notice warn">${esc(sw.error)}</p>`
		else if (!q) html = `<p class="hint">${tl('broker.swSearchingBids')}</p>`
		else if (!q.offers.length) html = `<p class="notice warn">${tl('broker.swNoBuyers', { market: esc(nameOf(sw.coin)) })}</p>`
		else if (!best && !reachable(q.offers).length)
			html = `<p class="notice warn">${maxUsd() > 0 ? tl('broker.swBelowMin', { bal: fmtM(maxUsd()) }) : tl('broker.swNoBalance')}</p>`
		else if (!best)
			html = `<p class="notice warn">${a > 0 ? tl('broker.swNoBuyerFor', { usd: fmtM(a) }) : tl('broker.swHowManySell')} ${tl('broker.swPossible')}</p><div class="swap-picks">${options(q.offers)}</div>`
		else {
			html = `<div class="kv swap-kv">
				<span>${tl('broker.colPrice')}</span><b>1 USD = ${fmtP(best.price)} ${esc(unit())}</b><span></span>
				<span>${tl('broker.tkBuys')}</span><b>@${esc(best.user)}${best.vip ? ' <span class="badge ok">VIP</span>' : ''}${best.gold ? ' <span class="badge warn">GOLD</span>' : ''}</b><span></span>
				<span>${tl('broker.reputation')}</span><b>${best.rating ? `⭐ ${best.rating.toFixed(2)}` : tl('broker.noRatings')}${best.ops != null ? ` · ${tl('broker.nOps', { n: best.ops })}` : ''}</b><span></span>
			</div>`
		}
		$('swQuote').innerHTML = html
		const go = $('swGo')
		if (go) {
			const missing = details().some((d) => !d.value)
			const badCard = window.TPNum?.cardError(document.querySelectorAll('[data-sw-detail]')) ?? ''
			const over = a > maxUsd()
			go.disabled = sw.taking || !best || !(a > 0) || missing || badCard || over || sw.loading
			go.textContent = sw.taking ? tl('broker.selling') : maxUsd() <= 0 ? tl('broker.swNoBalanceBtn') : !best ? tl('broker.swSell') : over ? tl('broker.swNotEnough') : missing ? tl('broker.swFillDetails') : badCard ? tl('broker.swCard16') : tl('broker.swSellGo', { usd: fmtM(a), total: `${fmtM(a * best.price)} ${unit()}` })
		}
	}

	function renderAge() {
		const q = sw.quote
		if ($('swAge')) $('swAge').textContent = sw.loading ? tl('broker.updating') : q ? tl('broker.priceAge', { s: Math.max(0, Math.round((Date.now() - q.at) / 1000)) }) : ''
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
		if (!best || sw.taking) return
		const d = details()
		const total = a * best.price
		const ok = await askConfirm(
			tl('broker.swConfirmSell'),
			`<div class="kv">
				<span>${tl('broker.kvSell')}</span><b>${fmtM(a)} USD</b><span></span>
				<span>${tl('broker.kvReceive')}</span><b>${fmtM(total)} ${esc(unit())}</b><span></span>
				<span>${tl('broker.swIn')}</span><b>${esc(nameOf(sw.coin))}</b><span></span>
				<span>${tl('broker.tkBuys')}</span><b>@${esc(best.user)}${best.vip ? ' (VIP)' : ''}</b><span></span>
				${d.map((x) => `<span>${esc(x.label)}</span><b>${esc(x.value)}</b><span></span>`).join('')}
			</div>
			<p class="notice">${tl('broker.swConfirmSellNote', { usd: fmtM(a) })}${best.vip ? '' : tl('broker.swConfirmSellNoVip')}</p>`,
			tl('broker.swSell'),
			'buy',
		)
		if (!ok || sw.taking) return
		sw.taking = true
		render()
		try {
			const r = await api('/swap', { offer: best.offer, amount: a, minPrice: best.price, details: d })
			markOrigin(r.offer)
			window.TPPush?.watch(r.offer)
			if ($('swRemember').checked) store.setMine(`details.${sw.coin}`, Object.fromEntries(d.map((x) => [x.name, x.value])))
			else store.setMine(`details.${sw.coin}`, {})
			toast(r.chatSent ? tl('broker.swSellStarted', { user: best.user }) : tl('broker.swSellNoChat'), !r.chatSent)
			clearInterval(sw.timer)
			bk.tab = 'active'
			await loadTrades()
			loadBook()
			openTrade(r.offer, r.order)
		} catch (e) {
			sw.taking = false
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
		if (document.hidden || sw.loading || sw.taking) return
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
	b.title = bk.alerts ? tl('broker.alertsOnTitle') : tl('broker.alertsOffTitle')
}

async function toggleAlerts() {
	bk.alerts = !bk.alerts
	store.set('alerts', bk.alerts)
	renderAlertsBtn()
	if (!bk.alerts) {
		window.TPPush?.unsubscribe()
		return toast(tl('broker.alertsOff'))
	}
	// El sonido necesita un gesto del usuario para poder sonar después
	try {
		audio ??= new AudioContext()
		await audio.resume()
	} catch {}
	let perm = 'Notification' in window ? Notification.permission : 'denied'
	if (perm === 'default') perm = await Notification.requestPermission().catch(() => 'denied')
	beep(false)
	if (perm !== 'granted') return toast(tl('broker.alertsSoundOnly'))
	// Con tu cuenta conectada, también con el terminal cerrado (avisos push): llega uno de prueba
	const push = bk.acct.connected && window.TPPush ? await TPPush.subscribe({ test: true }).catch(() => 'error') : null
	toast(
		push === 'on'
			? tl('broker.alertsPush')
			: push === 'unsupported' && /iPhone|iPad/.test(navigator.userAgent)
				? tl('broker.alertsIphone')
				: tl('broker.alertsTab'),
	)
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
// sale completada en «Mis operaciones» (la liberó la contraparte, o se terminó en la web de QvaPay o
// con el terminal cerrado), se avisa al servidor una vez, sin usuario ni token (ver worker/metrics.ts)
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
// Lo completado hace más de esto ya no se cuenta (el servidor tampoco lo acepta)
const REPORT_BACK_MS = 30 * 86_400_000
// Avisos en camino, para no mandar dos veces el mismo mientras el servidor contesta
const reporting = new Set()
// Devuelve si mandó el aviso. Queda como avisado solo si el servidor lo aceptó (o lo rechazó por no válido): si
// se pasó el tope por minuto o falló la red, se vuelve a intentar en la siguiente lectura
function reportCompleted(a, at) {
	const key = `${a.offer}:${a.order ?? ''}`
	const o = origin()
	if (!o.offers[a.offer] || o.reported[key] || reporting.has(key)) return false
	reporting.add(key)
	const t = bk.trades.find((x) => x.offerUuid === a.offer && (x.order ?? '') === (a.order ?? ''))
	fetch('/data/event', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ event: 'completed', offer: a.offer, order: a.order ?? undefined, coin: t?.coin, side: t?.offerType, usd: t?.usd, at }),
		keepalive: true,
	})
		.then((r) => {
			if (!r.ok && r.status !== 400) return
			const now = origin()
			now.reported[key] = Date.now()
			now.reported = Object.fromEntries(Object.entries(now.reported).sort((x, y) => y[1] - x[1]).slice(0, 300))
			store.set(ORIGIN_KEY, now)
		})
		.catch(() => {})
		.finally(() => reporting.delete(key))
	return true
}
// Cada lectura de «Mis operaciones»: lo que empezó aquí y ya está completado cuenta en el día en que se completó.
// La oferta por rango tuya vista entera no: sus partes cuentan cada una (y así no se cuenta dos veces)
// Como mucho unos pocos por lectura: la primera vez puede haber muchas, y el servidor acepta 30 avisos por minuto
const REPORT_PER_READ = 5
function reportFinished(trades) {
	let sent = 0
	for (const t of trades) {
		if (sent >= REPORT_PER_READ) return
		if (t.status !== 'completed' || (t.kind === 'flexible' && t.role === 'owner' && !t.order)) continue
		const at = Date.parse(t.updatedAt ?? '')
		if (!(at > Date.now() - REPORT_BACK_MS)) continue
		if (reportCompleted({ offer: t.offerUuid, order: t.order }, Math.min(at, Date.now()))) sent++
	}
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
		// Por el service worker si lo hay (en el móvil es la única forma). El tag, el mismo que el del aviso push de ese
		// suceso: si llegan los dos, uno reemplaza al otro
		const tag = `tp:${a.offer}:${a.kind}`
		if (window.TPPush?.ok) {
			TPPush.show(a.title, { body: a.body, tag, icon: '/icon-192.png', badge: '/badge-96.png', data: { url: '/#ops', offer: a.offer, order: a.order, kind: a.kind }, requireInteraction: a.urgent }).catch(() => {})
			continue
		}
		try {
			const n = new Notification(a.title, { body: a.body, tag, icon: '/icon-192.png', requireInteraction: a.urgent })
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
	if (ms <= 0) return tl('broker.expired')
	const s = Math.floor(ms / 1000)
	const h = Math.floor(s / 3600)
	const m = Math.floor((s % 3600) / 60)
	return h ? `${h} h ${String(m).padStart(2, '0')} min` : `${m}:${String(s % 60).padStart(2, '0')}`
}

function tickClocks() {
	// Con la hora real, no la del dispositivo (clock.js): un reloj adelantado daba el plazo por vencido antes de tiempo
	const now = nowMs()
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
			if (bk.cancelling.has(cancel.dataset.cancelBtn)) return
			if (!(await confirmDialog(tl('broker.cancelOffer'), `<p class="muted">${tl('broker.cancelListBody')}</p>`, tl('broker.cancelOffer'), 'danger'))) return
			try {
				const r = await cancelOffer(cancel.dataset.cancelBtn)
				if (!r) return
				toast(r.message || tl('broker.offerCancelled'))
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

// Una oferta por el enlace que te mandan: las privadas no salen en el libro, su dueño pasa el enlace de QvaPay
// (qvapay.com/p2p/<uuid>) o el del terminal. Vale también pegar solo el código de la oferta
const UUID_IN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i
function showOpenLink() {
	openModal(`<div class="stack"><h3>${tl('broker.linkTitle')}</h3>
		<p class="muted">${tl('broker.linkIntro')}</p>
		<form class="row-btns" id="linkForm"><input class="input" id="linkInput" placeholder="https://qvapay.com/p2p/…" autocomplete="off" spellcheck="false" /><button class="btn primary">${tl('broker.open')}</button></form>
		<p class="hint" id="linkErr" hidden>${tl('broker.linkErr')}</p>
		<p class="hint">${tl('broker.linkPaste')}</p></div>`)
	$('linkInput').focus()
	$('linkForm').addEventListener('submit', (e) => {
		e.preventDefault()
		const m = UUID_IN.exec($('linkInput').value)
		if (!m) return ($('linkErr').hidden = false)
		showTakeOfferById(m[0].toLowerCase())
	})
}
$('openLinkBtn')?.addEventListener('click', showOpenLink)
// Pegar el enlace de una oferta fuera de un campo de texto la abre
document.addEventListener('paste', (e) => {
	if (e.target?.closest?.('input, textarea, select, [contenteditable]')) return
	const text = e.clipboardData?.getData('text') ?? ''
	const m = /qvapay\.com|terminalp2p\.com/i.test(text) && UUID_IN.exec(text)
	if (!m) return
	e.preventDefault()
	showTakeOfferById(m[0].toLowerCase())
})

// Al llegar sin token guardado se pide, una vez por pestaña: cerrándola se sigue viendo el libro. No si al entrar ya
// se abrió otra cosa (una oferta por su enlace, la invitación a Pro) ni con la cuenta bloqueada. Tampoco entrando a
// las acciones de QvaPay, que se miran sin cuenta (stocks.js carga después: se mira el enlace y lo guardado)
function askToken() {
	if (bk.acct.connected || bk.acct.blocked || !$('modal').hidden) return
	if (window.TPStocks?.on || /^#acciones/.test(location.hash) || store.get('stk.on', false)) return
	try {
		if (sessionStorage.getItem('tp-asked-token')) return
		sessionStorage.setItem('tp-asked-token', '1')
	} catch {}
	showConnect()
}

bindBroker()
loadAccount().then(openOfferLink).then(askToken)
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
setInterval(() => !document.hidden && bk.detail && refreshDetail({ periodic: true }), 8_000)
