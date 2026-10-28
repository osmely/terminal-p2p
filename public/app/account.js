// «Mi cuenta»: tu cuenta de QvaPay, tus días de Pro (historial, compras y devoluciones) y tus estadísticas de
// trading. Las estadísticas se calculan aquí, con tus operaciones de QvaPay; de Pro, el servidor solo sabe tu
// usuario y tus días
'use strict'

const ACCT_KIND = { trial: 'Días gratis', purchase: 'Compra', gift: 'Regalo', refund: 'Devolución', adjust: 'Ajuste', import: 'Días que tenías' }
const ACCT_REFUND = { requested: 'Devolución pedida: la revisamos pronto', approved: 'Devolución aprobada: te transferimos el dinero en breve', transferred: 'Devuelto', rejected: 'Devolución rechazada' }
const acctDay = (ms) => new Date(ms).toLocaleDateString('es', { day: 'numeric', month: 'short', year: 'numeric' })
const acctMonth = (ym) => new Date(`${ym}-15T12:00:00Z`).toLocaleDateString('es', { month: 'long', year: 'numeric' })
let acctTab = 'summary'

function showAccount(tab = acctTab) {
	if (!bk.acct.connected) return showConnect()
	acctTab = tab === 'pro' && !TPPro.enabled ? 'summary' : tab
	const tabs = [['summary', 'Resumen'], ...(TPPro.enabled ? [['pro', '★ Pro']] : []), ['stats', 'Estadísticas']]
	openModal(`<div class="stack acct-modal">
		<div class="peer-head">${avatar(bk.acct.username, bk.acct.image, 'lg')}<div><h3>@${esc(bk.acct.username)}</h3><p class="muted small">Mi cuenta</p></div></div>
		<div class="seg-tabs" role="tablist">${tabs.map(([id, name]) => `<button class="seg-tab ${id === acctTab ? 'active' : ''}" data-acct-tab="${id}">${name}</button>`).join('')}</div>
		<div id="acctBody"></div></div>`)
	for (const b of $('modalBody').querySelectorAll('[data-acct-tab]')) b.onclick = () => showAccount(b.dataset.acctTab)
	;({ summary: acctSummary, pro: acctPro, stats: acctStats })[acctTab]()
}

function acctSummary() {
	const a = bk.acct
	const stat = (label, value, sub = '') => `<div class="peer-stat"><span>${label}</span><b>${value}</b>${sub ? `<small>${sub}</small>` : ''}</div>`
	const fee = feeOf(100) ? `${(a.p2pFee * 100).toLocaleString('en-US')} % al comprar` : 'sin comisión'
	$('acctBody').innerHTML = `<div class="stack">
		<div class="peer-stats">
			${stat('Saldo en QvaPay', `${fmtM(a.balance ?? 0)}`, 'USD')}
			${stat('Verificación', a.kyc ? '✓ KYC' : 'Sin KYC', a.kyc ? 'identidad verificada' : 'QvaPay la pide para el P2P')}
			${stat('Comisión P2P', a.gold ? 'GOLD' : '0.25 %', fee)}
		</div>
		${TPPro.enabled ? `<button class="btn block" id="acctGoPro">${TPPro.active ? `★ Te quedan ${daysText(daysLeft())} de Pro` : TPPro.canTrial ? '★ Probar Pro 14 días gratis' : '★ Terminal P2P Pro'}</button>` : ''}
		<p class="hint">Tu token solo está en este navegador. Desconectar lo borra de aquí; tus operaciones en QvaPay no se tocan.</p>
		<button class="btn danger block" id="acctOut">Desconectar cuenta</button></div>`
	$('acctGoPro')?.addEventListener('click', () => showAccount('pro'))
	$('acctOut').onclick = () => $('disconnectBtn')?.click()
}

async function acctPro() {
	$('acctBody').innerHTML = '<p class="muted">Cargando…</p>'
	let d
	try {
		d = await proFetch('/pro/account', { print: TPPro.print })
	} catch (e) {
		$('acctBody').innerHTML = `<p class="empty">${esc(e.message)}</p>`
		return
	}
	if (acctTab !== 'pro' || !$('acctBody')) return
	const a = d.account
	if (!a) {
		$('acctBody').innerHTML = `<div class="stack"><p class="muted">Todavía no tienes días de Pro en esta cuenta.</p><button class="btn primary block" id="acctBuy">${TPPro.canTrial ? '★ Probar Pro 14 días gratis' : 'Ver Terminal P2P Pro'}</button></div>`
		$('acctBuy').onclick = showPro
		return
	}
	const left = Math.max(0, Math.ceil((a.expiresAt - Date.now()) / 86_400_000))
	const head = a.suspended
		? `<p class="notice warn">Tu cuenta Pro está en pausa. Escríbenos a <a class="link" href="https://t.me/terminalp2p" target="_blank" rel="noopener">@terminalp2p</a>.</p>`
		: a.active
			? `<div class="acct-days"><b>${daysText(left)}</b><span class="muted">de Pro, hasta el ${acctDay(a.expiresAt)}</span></div>`
			: `<div class="acct-days"><b>Sin días</b><span class="muted">tu Pro venció el ${acctDay(a.expiresAt)}</span></div>`
	const purchases = d.purchases
		.map((p) => {
			const state = p.refund
				? `<span class="chip ${p.refund.status === 'rejected' ? 'cancelled' : p.refund.status === 'transferred' ? 'completed' : 'paid'}">${ACCT_REFUND[p.refund.status]}</span>${p.refund.note ? `<small class="muted">${esc(p.refund.note)}</small>` : ''}`
				: p.canRefund
					? `<button class="link small" data-refund="${esc(p.id)}">Pedir devolución</button>`
					: ''
			return `<li><div><b>${p.days} días</b> · ${fmtM(p.amount)} USD<small class="muted"> · ${acctDay(p.at)}</small></div><div class="acct-refund">${state}</div><div class="acct-ask" id="ask-${esc(p.id)}"></div></li>`
		})
		.join('')
	const moves = d.moves
		.map(
			(m) =>
				`<li><span>${ACCT_KIND[m.kind] ?? esc(m.kind)}${m.note ? `<small class="muted"> · ${esc(m.note)}</small>` : ''}</span><b class="mono ${m.days < 0 ? 'ask' : 'bid'}">${m.days > 0 ? '+' : ''}${m.days}</b><small class="muted">${acctDay(m.at)}</small></li>`,
		)
		.join('')
	const tg = d.telegram
		? `<div class="acct-tg on"><span>✓ Recibes los avisos de tu Pro en Telegram</span><button class="link small" id="tgOff">Dejar de recibirlos</button></div>`
		: `<div class="acct-tg"><button class="btn block" id="tgOn">Recibir avisos en Telegram</button><p class="hint">Te escribimos cuando se confirme un pago, 3 días antes de que se acaben tus días y en cada paso de una devolución. Nada más.</p></div>`
	$('acctBody').innerHTML = `<div class="stack">
		${head}
		${tg}
		${canRenew() ? '<button class="btn primary block" id="acctBuy">Comprar días</button>' : `<p class="hint">Podrás comprar más días cuando te queden 5 o menos.</p>`}
		<div><p class="hint">Tus compras</p>${purchases ? `<ul class="acct-list">${purchases}</ul>` : '<p class="muted small">Aún no has comprado días.</p>'}
		${d.refundUntil && d.refundUntil > Date.now() ? `<p class="hint">Puedes pedir la devolución hasta el ${acctDay(d.refundUntil)} (${d.refundDays} días desde tu primera compra).</p>` : ''}</div>
		<div><p class="hint">Historial de tus días</p><ul class="acct-moves">${moves || '<li class="muted">Sin movimientos.</li>'}</ul></div></div>`
	$('acctBuy')?.addEventListener('click', showPro)
	$('tgOn')?.addEventListener('click', acctTelegram)
	$('tgOff')?.addEventListener('click', async () => {
		try {
			await proFetch('/pro/telegram/unlink', { print: TPPro.print })
			toast('Ya no te llegarán avisos por Telegram')
			acctPro()
		} catch (e) {
			toast(e.message, true)
		}
	})
	for (const b of $('acctBody').querySelectorAll('[data-refund]')) b.onclick = () => acctAskRefund(b.dataset.refund)
}

// El bot solo puede escribir a quien le escribió antes: se abre con un enlace de un solo uso y, al volver aquí,
// se mira si ya quedó conectado
async function acctTelegram() {
	// La pestaña se abre ya (al pulsar) para que el navegador no la bloquee, y luego va al enlace
	const tab = window.open('about:blank', '_blank')
	try {
		const { url } = await proFetch('/pro/telegram/link', { print: TPPro.print })
		if (tab) tab.location.href = url
		else location.href = url
		toast('Pulsa «Iniciar» en Telegram y vuelve aquí')
		window.addEventListener('focus', () => acctTab === 'pro' && $('acctBody') && acctPro(), { once: true })
	} catch (e) {
		tab?.close()
		toast(e.message, true)
	}
}

function acctAskRefund(checkout) {
	const box = $(`ask-${checkout}`)
	box.innerHTML = `<div class="stack"><label class="field">¿Por qué la pides?<textarea class="input" id="rfReason" rows="2" maxlength="300" placeholder="Así mejoramos Pro"></textarea></label>
		<p class="hint">Te devolvemos el dinero a la cuenta de QvaPay que pagó, y se quitan los días de esta compra.</p>
		<button class="btn primary" id="rfGo">Pedir devolución</button></div>`
	$('rfGo').onclick = async () => {
		$('rfGo').disabled = true
		try {
			await proFetch('/pro/refund', { print: TPPro.print, checkout, reason: $('rfReason').value })
			toast('Devolución pedida: la revisamos pronto')
			acctPro()
		} catch (e) {
			$('rfGo').disabled = false
			toast(e.message, true)
		}
	}
}

async function acctStats() {
	$('acctBody').innerHTML = '<p class="muted">Leyendo tus operaciones en QvaPay…</p>'
	let r
	try {
		r = await api('/stats')
	} catch (e) {
		$('acctBody').innerHTML = `<p class="empty">${esc(e.message)}</p>`
		return
	}
	if (acctTab !== 'stats' || !$('acctBody')) return
	const s = r.stats
	if (!s.completed && !s.cancelled) {
		$('acctBody').innerHTML = '<p class="muted">Todavía no tienes operaciones terminadas en el P2P.</p>'
		return
	}
	const stat = (label, value, sub = '') => `<div class="peer-stat"><span>${label}</span><b>${value}</b>${sub ? `<small>${sub}</small>` : ''}</div>`
	const rate = s.completed + s.cancelled ? Math.round((s.completed / (s.completed + s.cancelled)) * 100) : 0
	const months = s.months
		.slice(0, 6)
		.map((m) => `<tr><td>${acctMonth(m.month)}</td><td class="r num">${m.ops}</td><td class="r num bid">${fmtM(m.usdBought)}</td><td class="r num ask">${fmtM(m.usdSold)}</td></tr>`)
		.join('')
	const markets = s.markets
		.map(
			(m) =>
				`<tr><td>${esc(nameOf(m.coin))}</td><td class="r num">${m.ops}</td><td class="r num">${m.avgBuy != null ? fmtP(m.avgBuy) : '—'}</td><td class="r num">${m.avgSell != null ? fmtP(m.avgSell) : '—'}</td></tr>`,
		)
		.join('')
	const peers = s.peers.map((p) => `<button type="button" class="chip-btn" data-acct-peer="${esc(p.username)}">@${esc(p.username)} <b class="mono">${p.ops}</b></button>`).join('')
	$('acctBody').innerHTML = `<div class="stack">
		<div class="peer-stats">
			${stat('Completadas', String(s.completed), `${rate} % de las terminadas`)}
			${stat('Compraste', `${fmtM(s.usdBought)}`, 'USD')}
			${stat('Vendiste', `${fmtM(s.usdSold)}`, 'USD')}
		</div>
		<p class="small muted">${s.asOwner} en tus ofertas · ${s.asTaker} tomando ofertas de otros · ${s.cancelled} canceladas</p>
		<div><p class="hint">Por mes (USD)</p><table class="acct-table"><tr><th>Mes</th><th class="r">Ops</th><th class="r">Compras</th><th class="r">Ventas</th></tr>${months}</table></div>
		<div><p class="hint">Precio medio por mercado</p><table class="acct-table"><tr><th>Mercado</th><th class="r">Ops</th><th class="r">Compraste a</th><th class="r">Vendiste a</th></tr>${markets}</table></div>
		${peers ? `<div><p class="hint">Con quién más operas</p><div class="chips-row">${peers}</div></div>` : ''}
		<p class="hint">${r.partial ? 'Con tus últimas 200 ofertas y tomas' : 'Con todas tus ofertas y tomas'}${s.since ? `, desde el ${acctDay(Date.parse(s.since))}` : ''}. Con tus datos de QvaPay. No se guarda.</p></div>`
	for (const b of $('acctBody').querySelectorAll('[data-acct-peer]')) b.onclick = () => showPeer(b.dataset.acctPeer)
}

document.addEventListener('click', (e) => e.target.closest('#acctOpen') && showAccount('summary'))
