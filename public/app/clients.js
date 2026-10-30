// «Mis clientes»: un comerciante con Pro invita a sus clientes de siempre con un enlace (terminalp2p.com/c/<usuario>) y
// les manda ofertas privadas de QvaPay, que no salen en el libro. Sus clientes las ven aquí («Mi cuenta» → Clientes y
// un aviso arriba) y por Telegram, y la toma el primero que llegue. El servidor guarda la lista y lo público de cada
// oferta mandada (worker/clients.ts); para mandarla, la lee en QvaPay con tu token, de paso, como el relé
'use strict'

const CL_POLL_MS = 60_000
const INVITE_LINK = /^#clientes\/@?([A-Za-z0-9._-]{1,40})$/
// ready: ya se sabe si hay cuenta conectada (el primer tp:pro). announced: ya se puede avisar de lo nuevo
const cl = { data: null, at: 0, busy: false, invite: null, ready: false, announced: false }

// Las ofertas de tus comerciantes que ya viste (para avisar solo de las nuevas)
const clSeen = () => {
	try {
		return new Set(JSON.parse(localStorage.getItem('tp.clients.seen') ?? '[]'))
	} catch {
		return new Set()
	}
}
const clSaveSeen = (s) => {
	try {
		localStorage.setItem('tp.clients.seen', JSON.stringify([...s].slice(-200)))
	} catch {}
}
// La invitación del mismo entorno (staging.… desde app.staging.…)
const inviteLink = (u) => `${location.origin.replace('://app.', '://')}/c/${u}`
const clCount = (n, one, many) => `${n} ${n === 1 ? one : many}`
// «a tu cliente» / «a tus 3 clientes»
const toClients = (n) => (n === 1 ? 'a tu cliente' : `a tus ${n} clientes`)
const clAgo = (ms) => {
	const m = Math.round((Date.now() - ms) / 60_000)
	return m < 1 ? 'ahora mismo' : m < 60 ? `hace ${m} min` : m < 1440 ? `hace ${Math.round(m / 60)} h` : `hace ${Math.round(m / 1440)} d`
}

// El servidor solo sabe quién eres si el relé ya confirmó tu cuenta (proFetch lo reintenta una vez)
async function clientsCall(path, body = {}) {
	const d = await proFetch(path, { print: TPPro.print, ...body })
	cl.data = d
	cl.at = Date.now()
	renderClientsChip()
	return d
}

async function loadClients(force = false) {
	if (!bk.acct.connected || !TPPro.enabled || !TPPro.print || cl.busy) return cl.data
	if (!force && cl.data && Date.now() - cl.at < CL_POLL_MS / 2) return cl.data
	cl.busy = true
	try {
		await clientsCall('/pro/clients')
		announceClientOffers()
	} catch {
	} finally {
		cl.busy = false
	}
	return cl.data
}

// Una oferta nueva de tus comerciantes con el terminal abierto: un aviso (por Telegram llega aparte)
function announceClientOffers() {
	const seen = clSeen()
	const fresh = (cl.data?.offers ?? []).filter((o) => !seen.has(o.uuid))
	if (!fresh.length) return
	for (const o of fresh) seen.add(o.uuid)
	clSaveSeen(seen)
	// La primera vez (o tras unirte) no se avisa de lo que ya estaba
	if (!cl.announced) return
	const o = fresh[0]
	toast(`🤝 @${o.merchant} publicó para sus clientes: ${o.type === 'sell' ? 'vende' : 'compra'} ${fmtM(o.usd)} USD a ${fmtP(o.price)} ${unitOf(o.coin)}`)
}

// Arriba, junto a ★: cuántas ofertas de tus comerciantes siguen abiertas
function renderClientsChip() {
	const b = $('clientsChip')
	if (!b) return
	const n = cl.data?.offers?.length ?? 0
	b.hidden = !bk.acct.connected || !TPPro.enabled || !n
	b.innerHTML = `<span aria-hidden="true">🤝</span><span class="pro-label">${n}</span>`
	b.title = `${clCount(n, 'oferta', 'ofertas')} de tus comerciantes`
	b.onclick = () => showAccount('clients')
}

// ── «Mi cuenta» → Clientes ───────────────────────────────────────────

async function acctClients() {
	$('acctBody').innerHTML = '<p class="muted">Cargando…</p>'
	let d
	try {
		d = await clientsCall('/pro/clients')
	} catch (e) {
		$('acctBody').innerHTML = `<p class="empty">${esc(e.message)}</p>`
		return
	}
	if (acctTab !== 'clients' || !$('acctBody')) return
	renderAcctClients(d)
}

const offerLine = (o) =>
	`<b class="${o.type === 'sell' ? 'ask' : 'bid'}">${o.type === 'sell' ? 'Vende' : 'Compra'}</b> <b class="mono">${fmtM(o.usd)} USD</b> a <b class="mono">${fmtP(o.price)} ${esc(unitOf(o.coin))}</b><small class="muted"> · ${esc(nameOf(o.coin))}${o.kind === 'flexible' && o.orderMin ? ` · de ${fmtM(o.orderMin)} a ${fmtM(o.orderMax)}` : ''}${o.vipOnly ? ' · solo VIP' : ''}</small>`

function renderAcctClients(d) {
	const me = bk.acct.username
	const tg = d.telegram
		? '<p class="hint">✓ Te avisamos también por Telegram.</p>'
		: `<div class="acct-tg"><button class="btn block" id="clTg">Recibir sus ofertas en Telegram</button><p class="hint">Así te enteras aunque no tengas el terminal abierto: llegan antes que a nadie y se las lleva el primero.</p></div>`
	const asClient = d.merchants.length
		? `<section class="stack tight"><p class="sec-box-t">Ofertas para ti</p>
			${
				d.offers.length
					? `<ul class="acct-list cl-offers">${d.offers
							.map((o) => `<li><button type="button" class="cl-offer" data-cl-offer="${esc(o.uuid)}"><span>${offerLine(o)}</span><small class="muted">@${esc(o.merchant)} · ${clAgo(o.createdAt)}</small></button></li>`)
							.join('')}</ul>`
					: '<p class="muted small">Ahora mismo no hay ninguna abierta. Te avisamos cuando publiquen.</p>'
			}
			${tg}
			<p class="hint">Recibes las ofertas privadas de ${d.merchants.map((m) => `<b>@${esc(m.username)}</b> <button class="link small" data-cl-leave="${esc(m.username)}">salir</button>`).join(' · ')}</p></section>
			<hr class="acct-sep">`
		: ''
	const link = inviteLink(me)
	const asMerchant = d.pro
		? `<section class="stack tight"><p class="sec-box-t">Tus clientes</p>
			<p class="hint">Pásales este enlace. Cuando publiques una oferta marcando «Solo para mis clientes», sale privada (no está en el libro, ni los bots la ven) y les avisamos aquí y por Telegram.</p>
			<div class="row-btns cl-link"><input class="input" id="clLink" readonly value="${esc(link)}" /><button class="btn icon-only" id="clCopy" title="Copiar enlace" aria-label="Copiar enlace">${ICON_COPY}</button>${navigator.share ? `<button class="btn icon-only" id="clShare" title="Compartir" aria-label="Compartir">${ICON_SHARE}</button>` : ''}</div>
			${
				d.clients.length
					? `<p class="hint">${clCount(d.clients.length, 'cliente', 'clientes')} (máximo ${d.maxClients})</p><ul class="cl-people">${d.clients.map((c) => `<li>${avatar(c.username, null)}<span>@${esc(c.username)}</span><button class="link small" data-cl-remove="${esc(c.username)}">quitar</button></li>`).join('')}</ul>`
					: '<p class="muted small">Aún no se ha unido nadie.</p>'
			}
			${
				d.mine.length
					? `<p class="hint">Lo que les mandaste</p><ul class="acct-list">${d.mine
							.map((o) => `<li><div>${offerLine(o)}</div><small class="muted">${o.status === 'open' ? 'Abierta' : 'Cerrada'} · ${clAgo(o.createdAt)} · ${clCount(o.sent, 'aviso', 'avisos')} por Telegram</small></li>`)
							.join('')}</ul>`
					: ''
			}</section>`
		: `<section class="stack tight"><p class="sec-box-t">Tus clientes <span class="pro-tag">PRO</span></p>
			<p class="muted">¿Vendes o compras a la misma gente de siempre? Con Pro les pasas un enlace y les publicas ofertas privadas: no salen en el libro, así que ni los bots ni la competencia las ven, y a ellos les llega el aviso al momento.</p>
			<button class="btn primary block" id="clPro">${TPPro.canTrial ? `★ Probar Pro ${proTrialDays} días gratis` : '★ Ver Terminal P2P Pro'}</button></section>`
	$('acctBody').innerHTML = `<div class="stack">${asClient}${asMerchant}</div>`

	const body = $('acctBody')
	$('clTg')?.addEventListener('click', acctTelegram)
	$('clPro')?.addEventListener('click', showPro)
	$('clCopy')?.addEventListener('click', () => {
		navigator.clipboard?.writeText(link)
		$('clCopy').innerHTML = ICON_DONE
		setTimeout(() => $('clCopy') && ($('clCopy').innerHTML = ICON_COPY), 1400)
		toast('Enlace copiado')
	})
	$('clShare')?.addEventListener('click', () => navigator.share({ text: `Te paso mis ofertas privadas en Terminal P2P: únete y te aviso cuando publique, antes que a nadie.\n${link}` }).catch(() => {}))
	for (const b of body.querySelectorAll('[data-cl-offer]'))
		b.onclick = () => {
			closeModal()
			showTakeOfferById(b.dataset.clOffer)
		}
	for (const b of body.querySelectorAll('[data-cl-leave]'))
		b.onclick = async () => {
			if (!(await confirmDialog(`Salir de @${esc(b.dataset.clLeave)}`, '<p class="muted">Dejarás de recibir sus ofertas privadas. Puedes volver con su enlace.</p>', 'Salir', 'danger'))) return showAccount('clients')
			try {
				await clientsCall('/pro/clients/leave', { merchant: b.dataset.clLeave })
			} catch (e) {
				toast(e.message, true)
			}
			showAccount('clients')
		}
	for (const b of body.querySelectorAll('[data-cl-remove]'))
		b.onclick = async () => {
			if (!(await confirmDialog(`Quitar a @${esc(b.dataset.clRemove)}`, '<p class="muted">Dejará de recibir tus ofertas privadas. Podría volver a unirse si tiene tu enlace.</p>', 'Quitar', 'danger'))) return showAccount('clients')
			try {
				await clientsCall('/pro/clients/remove', { client: b.dataset.clRemove })
			} catch (e) {
				toast(e.message, true)
			}
			showAccount('clients')
		}
}

// ── La invitación (terminalp2p.com/c/<usuario> → #clientes/<usuario>) ──

function openInviteLink() {
	const m = INVITE_LINK.exec(location.hash)
	if (!m) return
	history.replaceState(null, '', location.pathname + location.search)
	cl.invite = m[1]
	if (cl.ready) showInvite()
}

function showInvite() {
	const name = cl.invite
	if (!name) return
	if (!bk.acct.connected) {
		openModal(`<div class="stack"><h3>🤝 Ofertas privadas de @${esc(name)}</h3>
			<p class="muted">@${esc(name)} te invita a su lista de clientes en Terminal P2P. Cuando publique una oferta solo para sus clientes, te llega al momento, aquí y por Telegram. No sale en el libro: ni los bots la ven.</p>
			<button class="btn primary block" id="ivConnect">Conectar mi cuenta para unirme</button></div>`)
		$('ivConnect').onclick = () => showConnect(`Conecta tu cuenta para unirte a los clientes de @${name}`)
		return
	}
	// Con la cuenta conectada, en cuanto Pro diga la huella (tp:pro)
	if (!TPPro.print) return
	cl.invite = null
	if (name.toLowerCase() === bk.acct.username.toLowerCase()) {
		toast('Ese es tu enlace de invitación: pásaselo a tus clientes')
		return showAccount('clients')
	}
	if (cl.data?.merchants?.some((m) => m.username.toLowerCase() === name.toLowerCase())) {
		toast(`Ya recibes las ofertas de @${name}`)
		return showAccount('clients')
	}
	openModal(`<div class="stack"><h3>🤝 Ofertas privadas de @${esc(name)}</h3>
		<p class="muted">@${esc(name)} te invita a su lista de clientes. Cuando publique una oferta solo para sus clientes, te avisamos aquí y por Telegram, y se la lleva el primero que la tome. No sale en el libro: ni los bots la ven.</p>
		<p class="hint">@${esc(name)} sabrá que te uniste (ve tu usuario en su lista). Puedes salir cuando quieras.</p>
		<div class="row-btns"><button class="btn" id="ivNo">Ahora no</button><button class="btn primary" id="ivYes">Unirme</button></div></div>`)
	$('ivNo').onclick = closeModal
	$('ivYes').onclick = async () => {
		$('ivYes').disabled = true
		try {
			const d = await clientsCall('/pro/clients/join', { merchant: name })
			clSaveSeen(new Set([...clSeen(), ...d.offers.map((o) => o.uuid)]))
			toast(`Listo: ya recibes las ofertas de @${d.joined}`)
			showAccount('clients')
		} catch (e) {
			$('ivYes').disabled = false
			toast(e.message, true)
		}
	}
}

// ── Al publicar y en tu oferta ───────────────────────────────────────

// La casilla del formulario de publicar (con Pro): la oferta sale privada y se manda a tus clientes
function clientsFormBox() {
	if (!TPPro.active) return ''
	const n = cl.data?.clients?.length ?? 0
	return `<section class="sec-box" id="ofClientsBox"><label class="check sec-box-h"><input type="checkbox" id="ofClients"${n ? '' : ' disabled'} /> 🤝 Solo para mis clientes</label>
		<p class="hint">${n ? `Sale privada (no está en el libro) y avisamos ${toClients(n)} aquí y por Telegram.` : 'Aún no tienes clientes: invítalos desde «Mi cuenta» → Clientes.'}</p></section>`
}

// Tras publicarla (o desde tu oferta abierta): que el servidor la lea con tu token y avise a tus clientes
async function sendToClients(uuid) {
	try {
		const r = await api('/clients/send', { offer: uuid })
		cl.data = r
		cl.at = Date.now()
		const n = r.clients?.length ?? 0
		toast(r.fresh ? `Mandada ${toClients(n)}${r.sent ? ` (${clCount(r.sent, 'aviso', 'avisos')} por Telegram)` : ''}` : 'Ya se la habías mandado a tus clientes')
		return true
	} catch (e) {
		// La cookie con tu cuenta era de otra pestaña: se pide el perfil y se reintenta una vez
		if (e.code === 'TP_WHO') {
			await api('/me').catch(() => {})
			return api('/clients/send', { offer: uuid })
				.then((r) => ((cl.data = r), toast('Mandada a tus clientes'), true))
				.catch((e2) => (toast(e2.message, true), false))
		}
		toast(e.message, true)
		return false
	}
}

// En tu oferta abierta y privada (con Pro): si ya la mandaste, o el botón para mandarla
function clientsManageBox(o) {
	if (!TPPro.active || o.status !== 'open' || !o.isPrivate) return ''
	const sent = cl.data?.mine?.find((m) => m.uuid === o.offer)
	return `<div class="share"><p class="hint">${sent ? `🤝 Mandada a tus clientes ${clAgo(sent.createdAt)} · ${clCount(sent.sent, 'aviso', 'avisos')} por Telegram` : '🤝 Es privada: no está en el libro. Puedes mandársela a tus clientes.'}</p>${sent ? '' : `<button class="btn" id="mgClients"${cl.data?.clients?.length ? '' : ' disabled title="Aún no tienes clientes"'}>Mandar a mis clientes</button>`}</div>`
}

// Lo que mandaste y ya no está abierto (la tomaron o la cancelaste) deja de enseñarse a tus clientes
document.addEventListener('tp:offers', () => {
	const open = (cl.data?.mine ?? []).filter((o) => o.status === 'open')
	if (!open.length || !bk.tradesSeen) return
	const live = new Set(bk.openOffers.map((o) => o.offerUuid))
	const gone = open.filter((o) => !live.has(o.uuid)).map((o) => o.uuid)
	if (!gone.length) return
	for (const o of open) if (gone.includes(o.uuid)) o.status = 'closed'
	proFetch('/pro/clients/close', { print: TPPro.print, offers: gone }).catch(() => {})
})

document.addEventListener('tp:pro', () => {
	cl.ready = true
	renderClientsChip()
	if (cl.invite) showInvite()
	if (!cl.data && bk.acct.connected && TPPro.enabled) loadClients(true).then(() => (cl.announced = true))
})
window.addEventListener('hashchange', openInviteLink)
openInviteLink()
setInterval(() => !document.hidden && cl.data && loadClients(), CL_POLL_MS)
document.addEventListener('visibilitychange', () => !document.hidden && cl.data && loadClients())
