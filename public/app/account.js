// «Mi cuenta»: tu cuenta de QvaPay, tus días de Pro (historial, compras y devoluciones) y tus estadísticas de
// trading. Las estadísticas se calculan aquí, con tus operaciones de QvaPay; de Pro, el servidor solo sabe tu
// usuario y tus días
'use strict'

const ACCT_KIND = { trial: 'Días gratis', purchase: 'Compra', gift: 'Regalo', refund: 'Devolución', adjust: 'Ajuste', import: 'Días que tenías' }
const ACCT_REFUND = { requested: 'Devolución pedida: la revisamos pronto', approved: 'Devolución aprobada: te transferimos el dinero en breve', transferred: 'Devuelto', rejected: 'Devolución rechazada' }
// La referencia de una devolución: si es el uuid de la transferencia, enlaza a su detalle en QvaPay
const acctRef = (ref) =>
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ref)
		? `<a class="link mono acct-ref" href="https://www.qvapay.com/transaction/${ref}" target="_blank" rel="noopener">${ref}</a>`
		: `<span class="mono acct-ref">${esc(ref)}</span>`
const acctDay = (ms) => cubaFmt(ms, { day: 'numeric', month: 'short', year: 'numeric' })
const acctMonth = (ym) => new Date(`${ym}-15T12:00:00Z`).toLocaleDateString('es', { month: 'long', year: 'numeric' })
let acctTab = 'summary'

function showAccount(tab = acctTab) {
	if (!bk.acct.connected) return showConnect()
	acctTab = (tab === 'pro' || tab === 'alerts') && !TPPro.enabled ? 'summary' : tab
	const tabs = [['summary', 'Resumen'], ...(TPPro.enabled ? [['pro', '★ Pro'], ['alerts', '★ Avisos']] : []), ['stats', 'Estadísticas']]
	openModal(`<div class="stack acct-modal">
		<div class="peer-head">${avatar(bk.acct.username, bk.acct.image, 'lg')}<div><h3>@${esc(bk.acct.username)}</h3><p class="muted small">Mi cuenta</p></div></div>
		<div class="seg-tabs" role="tablist">${tabs.map(([id, name]) => `<button class="seg-tab ${id === acctTab ? 'active' : ''}" data-acct-tab="${id}">${name}</button>`).join('')}</div>
		<div id="acctBody"></div></div>`)
	for (const b of $('modalBody').querySelectorAll('[data-acct-tab]')) b.onclick = () => showAccount(b.dataset.acctTab)
	;({ summary: acctSummary, pro: acctPro, alerts: acctAlertsTab, stats: acctStats })[acctTab]()
}

function acctSummary() {
	const a = bk.acct
	const stat = (label, value, sub = '') => `<div class="peer-stat"><span>${label}</span><b>${value}</b>${sub ? `<small>${sub}</small>` : ''}</div>`
	// La comisión sale de un solo sitio: la que manda el terminal (P2P_FEE en src/qvapay/fees.ts); GOLD no la paga
	const pct = `${((a.p2pFee ?? 0) * 100).toLocaleString('en-US')} %`
	const fee = feeOf(100) ? `${pct} al comprar` : 'sin comisión'
	$('acctBody').innerHTML = `<div class="stack">
		<div class="peer-stats">
			${stat('Saldo en QvaPay', `${fmtM(a.balance ?? 0)}`, 'USD')}
			${stat('Verificación', a.kyc ? '✓ KYC' : 'Sin KYC', a.kyc ? 'identidad verificada' : 'QvaPay la pide para el P2P')}
			${stat('Comisión P2P', a.gold ? 'GOLD' : pct, fee)}
		</div>
		${TPPro.enabled ? `<button class="btn block" id="acctGoPro">${TPPro.active ? `★ Te quedan ${daysText(daysLeft())} de Pro` : TPPro.canTrial ? `★ Probar Pro ${proTrialDays} días gratis` : '★ Terminal P2P Pro'}</button>` : ''}
		<p class="hint">${HELP}</p>
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
		$('acctBody').innerHTML = `<div class="stack"><p class="muted">Todavía no tienes días de Pro en esta cuenta.</p><button class="btn primary block" id="acctBuy">${TPPro.canTrial ? `★ Probar Pro ${proTrialDays} días gratis` : 'Ver Terminal P2P Pro'}</button></div>`
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
			const r = p.refund
			// Devuelta: cuándo y con qué transferencia de QvaPay
			const sent =
				r?.status === 'transferred'
					? `<small class="muted">${r.transferredAt ? `El ${acctDay(r.transferredAt)} a` : 'A'} tu cuenta de QvaPay</small>${r.ref ? `<small class="muted">Transferencia: ${acctRef(r.ref)}</small>` : ''}`
					: ''
			// Sin devoluciones (salvo error en el pago, que decidimos nosotros): si le hicimos una, cómo va
			const state = r
				? `<span class="chip ${r.status === 'rejected' ? 'cancelled' : r.status === 'transferred' ? 'completed' : 'paid'}">${ACCT_REFUND[r.status]}${r.usd != null && r.status !== 'rejected' ? ` · ${fmtM(r.usd)} USD` : ''}</span>${r.note ? `<small class="muted">${esc(r.note)}</small>` : ''}${sent}`
				: ''
			return `<li><div><b>${p.days} días</b> · ${fmtM(p.amount)} USD<small class="muted"> · ${acctDay(p.at)}</small></div><div class="acct-refund">${state}</div></li>`
		})
		.join('')
	const moves = d.moves
		.map(
			(m) =>
				`<li><span>${ACCT_KIND[m.kind] ?? esc(m.kind)}${m.note ? `<small class="muted"> · ${esc(m.note)}</small>` : ''}</span><b class="mono ${m.days < 0 ? 'ask' : 'bid'}">${m.days > 0 ? '+' : ''}${m.days}</b><small class="muted">${acctDay(m.at)}</small></li>`,
		)
		.join('')
	$('acctBody').innerHTML = `<div class="stack">
		<section class="sec-box">
			<p class="sec-box-t">Tus días</p>
			${head}
			${canRenew() ? '<button class="btn primary block" id="acctBuy">Comprar días</button>' : `<p class="hint">Podrás comprar más días cuando te queden 5 o menos.</p>`}
			${d.telegram ? '' : '<p class="hint">Para saber por Telegram cuándo se confirma un pago o se acaban tus días, conéctalo en <button class="link" id="acctGoAlerts">★ Avisos</button>.</p>'}
		</section>
		<section class="sec-box">
			<p class="sec-box-t">Tus compras</p>
			${purchases ? `<ul class="acct-list">${purchases}</ul>` : '<p class="muted small">Aún no has comprado días.</p>'}
			<p class="hint">${NO_REFUNDS}</p>
		</section>
		<section class="sec-box"><p class="sec-box-t">Historial de tus días</p><ul class="acct-moves">${moves || '<li class="muted">Sin movimientos.</li>'}</ul></section></div>`
	$('acctBuy')?.addEventListener('click', showPro)
	$('acctGoAlerts')?.addEventListener('click', () => showAccount('alerts'))
}

// La pestaña ★ Avisos: los avisos de tasa por Telegram (con Pro); sin Pro, qué son y cómo tenerlos
function acctAlertsTab() {
	if (!TPPro.active) {
		$('acctBody').innerHTML = `<div class="stack"><p class="muted">Con Pro te escribimos por Telegram cuando tomen tus ofertas, te paguen o te liberen, aunque cierres el terminal, y cuando la Tasa QvaPay de un mercado suba o baje del valor que pongas.</p><button class="btn primary block" id="acctBuy">${TPPro.canTrial ? `★ Probar Pro ${proTrialDays} días gratis` : 'Ver Terminal P2P Pro'}</button></div>`
		$('acctBuy').onclick = showPro
		return
	}
	$('acctBody').innerHTML = '<div id="acctAlerts"><p class="muted">Cargando…</p></div>'
	acctAlerts()
}

// Avisos de tasa por Telegram (Pro): «avísame cuando la Tasa QvaPay de un mercado suba de / baje de X». Los mira el
// servidor cada 10 minutos con la tasa que publica QvaPay (la mediana de lo completado)
async function acctAlerts(d) {
	if (!$('acctAlerts')) return
	if (!d)
		try {
			d = await proFetch('/pro/alerts', { print: TPPro.print })
		} catch (e) {
			$('acctAlerts').innerHTML = `<p class="hint">${esc(e.message)}</p>`
			return
		}
	if (!$('acctAlerts')) return
	const markets = state.overview.length ? state.overview : [{ tick: state.coin, name: nameOf(state.coin), unit: unitOf(state.coin) }]
	// Las acciones de QvaPay (stocks.js): su «mercado» es stock:NVDA y avisan por su precio en USD
	const stockOf = (c) => (String(c).startsWith('stock:') ? String(c).slice(6) : null)
	const stockList = window.TPStocks?.names() ?? [['SPY', 'S&P 500'], ['NVDA', 'NVIDIA'], ['TSLA', 'Tesla'], ['QQQ', 'Nasdaq 100'], ['CRCL', 'Circle'], ['MSTR', 'Strategy'], ['MSFT', 'Microsoft'], ['AAPL', 'Apple'], ['META', 'Meta'], ['GOOGL', 'Alphabet'], ['AMZN', 'Amazon']]
	const alertName = (c) => (stockOf(c) ? `${stockOf(c)} (acción)` : nameOf(c))
	const rateOf = (c) => d.rates[c] ?? (stockOf(c) ? window.TPStocks?.price(stockOf(c)) : null)
	const now = (coin) => (rateOf(coin) ? `ahora ${fmtP(rateOf(coin))}` : stockOf(coin) ? 'sin precio ahora' : 'sin tasa ahora')
	const list = d.alerts
		.map(
			(x) =>
				`<li><span>${esc(alertName(x.coin))} · cuando ${x.dir === 'up' ? 'suba de' : 'baje de'} <b class="mono">${fmtP(x.price)}</b><small class="muted"> · ${now(x.coin)}${x.armed ? '' : ` · avisó el ${acctDay(x.fired_at)} (${fmtP(x.fired_rate)})`}</small></span><button class="link small" data-alert-del="${x.id}">Quitar</button></li>`,
		)
		.join('')
	const picked = window.TPStocks?.takePick() ?? null
	const coin = picked ?? (window.TPStocks?.on ? null : d.alerts.at(-1)?.coin) ?? (window.TPStocks?.on ? `stock:${window.TPStocks.current()}` : state.coin)
	$('acctAlerts').innerHTML = `<div class="stack">
		<section class="sec-box">
			<p class="sec-box-t">Telegram</p>
			${
				d.telegram
					? '<div class="acct-tg on"><span>✓ Te llegan los avisos a Telegram</span><button class="link small" id="tgOff">Dejar de recibirlos</button></div>'
					: '<p class="notice warn">Para que te lleguen los avisos de abajo, conecta el bot de Telegram.</p><button class="btn block" id="alTg">Recibir avisos en Telegram</button>'
			}
			<p class="hint">Te escribimos cuando se confirme un pago, 3 días antes de que se acaben tus días, en cada paso de una devolución y con los avisos que actives aquí. Nada más.</p>
		</section>
		<section class="sec-box">
			<p class="sec-box-t">Tus ofertas</p>
			<label class="check"><input type="checkbox" id="alOffers" ${d.offers ? 'checked' : ''} /> Avísame cuando tomen mis ofertas, me marquen pagado, me liberen o una vuelva al libro, aunque tenga el terminal cerrado</label>
			<p class="hint">Solo tus ofertas públicas: QvaPay no avisa de las privadas. En las de rango, de lo que te toman y lo que vuelve (QvaPay no avisa del pago de cada parte).</p>
		</section>
		<section class="sec-box">
			<p class="sec-box-t">Tasa QvaPay y acciones</p>
		${list ? `<ul class="acct-list">${list}</ul>` : '<p class="muted small">Te escribimos cuando la Tasa QvaPay de un mercado, o el precio de una acción de QvaPay, suba o baje del valor que pongas.</p>'}
		${
			d.alerts.length < d.max
				? `<div class="grid2">
				<label class="field">Mercado<select class="input" id="alCoin"><optgroup label="Tasa QvaPay">${markets.map((m) => `<option value="${m.tick}" ${m.tick === coin ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</optgroup><optgroup label="Acciones de QvaPay">${stockList.map(([s, n]) => `<option value="stock:${esc(s)}" ${`stock:${s}` === coin ? 'selected' : ''}>${esc(s)} · ${esc(n)}</option>`).join('')}</optgroup></select></label>
				<label class="field">Avisarme cuando<select class="input" id="alDir"><option value="up">suba de</option><option value="down">baje de</option></select></label>
			</div>
			<label class="field"><span id="alPriceLabel">Tasa por USD</span><input class="input" id="alPrice" inputmode="decimal" data-num autocomplete="off" /></label>
			<p class="hint" id="alNow"></p>
			<button class="btn block" id="alAdd">Añadir aviso</button>`
				: `<p class="hint">Tienes ${d.max} avisos, el máximo: quita alguno para poner otro.</p>`
		}
		</section>
	</div>`
	const sync = () => {
		const c = $('alCoin').value
		const s = stockOf(c)
		const r = rateOf(c)
		$('alPriceLabel').textContent = s ? 'Precio en USD' : 'Tasa por USD'
		$('alNow').textContent = r ? (s ? `${s} en QvaPay ahora: ${fmtP(r)} USD` : `La Tasa QvaPay de ${nameOf(c)} ahora: ${fmtP(r)} ${unitOf(c)}`) : ''
		$('alPrice').placeholder = r ? fmtP(r) : ''
	}
	$('alTg')?.addEventListener('click', acctTelegram)
	$('tgOff')?.addEventListener('click', async () => {
		try {
			await proFetch('/pro/telegram/unlink', { print: TPPro.print })
			toast('Ya no te llegarán avisos por Telegram')
			acctAlerts()
		} catch (e) {
			toast(e.message, true)
		}
	})
	$('alOffers').onchange = async (e) => {
		const on = e.target.checked
		try {
			acctAlerts(await proFetch('/pro/alerts/offers', { print: TPPro.print, on }))
			toast(on ? 'Te avisaremos de tus ofertas por Telegram' : 'Ya no te avisaremos de tus ofertas')
		} catch (err) {
			e.target.checked = !on
			toast(err.message, true)
		}
	}
	if ($('alCoin')) {
		$('alCoin').onchange = sync
		sync()
		$('alAdd').onclick = async () => {
			const price = Number(String($('alPrice').value).replace(/,/g, ''))
			try {
				acctAlerts(await proFetch('/pro/alerts/add', { print: TPPro.print, coin: $('alCoin').value, dir: $('alDir').value, price }))
				toast('Aviso puesto')
			} catch (e) {
				toast(e.message, true)
			}
		}
	}
	for (const b of $('acctAlerts').querySelectorAll('[data-alert-del]'))
		b.onclick = async () => {
			try {
				acctAlerts(await proFetch('/pro/alerts/delete', { print: TPPro.print, id: Number(b.dataset.alertDel) }))
			} catch (e) {
				toast(e.message, true)
			}
		}
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
		window.addEventListener('focus', () => (acctTab === 'pro' || acctTab === 'alerts') && $('acctBody') && showAccount(acctTab), { once: true })
	} catch (e) {
		tab?.close()
		toast(e.message, true)
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
		${acctGainsSlot()}
		<section class="sec-box">
			<p class="sec-box-t">Tus operaciones</p>
			<div class="peer-stats">
				${stat('Completadas', String(s.completed), `${rate} % de las terminadas`)}
				${stat('Compraste', `${fmtM(s.usdBought)}`, 'USD')}
				${stat('Vendiste', `${fmtM(s.usdSold)}`, 'USD')}
			</div>
			<p class="small muted">${s.asOwner} en tus ofertas · ${s.asTaker} tomando ofertas de otros · ${s.cancelled} canceladas</p>
		</section>
		<section class="sec-box"><p class="sec-box-t">Por mes (USD)</p><table class="acct-table"><tr><th>Mes</th><th class="r">Ops</th><th class="r">Compras</th><th class="r">Ventas</th></tr>${months}</table></section>
		<section class="sec-box"><p class="sec-box-t">Precio medio por mercado</p><table class="acct-table"><tr><th>Mercado</th><th class="r">Ops</th><th class="r">Compraste a</th><th class="r">Vendiste a</th></tr>${markets}</table></section>
		${peers ? `<section class="sec-box"><p class="sec-box-t">Con quién más operas</p><div class="chips-row">${peers}</div></section>` : ''}
		<p class="hint">${r.partial ? 'Con tus últimas 200 ofertas y tomas' : 'Con todas tus ofertas y tomas'}${s.since ? `, desde el ${acctDay(Date.parse(s.since))}` : ''}. Con tus datos de QvaPay. No se guarda.</p></div>`
	for (const b of $('acctBody').querySelectorAll('[data-acct-peer]')) b.onclick = () => showPeer(b.dataset.acctPeer)
	if (TPPro.active) window.TPProGains?.render($('acctGains'), r)
	else $('acctGainsPro')?.addEventListener('click', showPro)
}

// Tus ganancias (Pro): las calcula el módulo Pro con tus operaciones de aquí arriba; sin Pro, se dice que existen
function acctGainsSlot() {
	if (!TPPro.enabled) return ''
	if (TPPro.active) return '<section class="sec-box" id="acctGains"></section>'
	return `<section class="sec-box"><p class="sec-box-t">★ Ganancias</p><p class="hint">Con Pro: cuánto ganaste comprando y vendiendo (con la comisión de QvaPay), cuánto pagaste de más o de menos frente a lo normal de cada día, y todas tus operaciones en CSV. <button class="link" id="acctGainsPro">Ver Pro</button></p></section>`
}

document.addEventListener('click', (e) => e.target.closest('#acctOpen') && showAccount('summary'))
// Para cualquier dificultad (también con un pago): el grupo de Telegram. Las compras no se devuelven
const HELP = '¿Tienes alguna dificultad? <a class="link" href="https://t.me/terminalp2p" target="_blank" rel="noopener">Consúltanos en el grupo de Telegram</a>'
const NO_REFUNDS = `Puedes probarlo gratis antes de pagar. Las compras no se reembolsan. ${HELP}`
// Lo que apuntaba el diagnóstico (diag.js), que ya no existe: se borra de este navegador
try {
	localStorage.removeItem('tp.diag')
} catch {}
