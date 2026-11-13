// «Mi cuenta»: tu cuenta de QvaPay, tus días de Pro (historial, compras y devoluciones) y tus estadísticas de
// trading. Las estadísticas se calculan aquí, con tus operaciones de QvaPay; de Pro, el servidor solo sabe tu
// usuario y tus días
'use strict'

const ACCT_KIND = { trial: tl('acct.kindTrial'), purchase: tl('acct.kindPurchase'), gift: tl('acct.kindGift'), refund: tl('acct.kindRefund'), adjust: tl('acct.kindAdjust'), import: tl('acct.kindImport') }
const ACCT_REFUND = { requested: tl('acct.refundRequested'), approved: tl('acct.refundApproved'), transferred: tl('acct.refundTransferred'), rejected: tl('acct.refundRejected') }
// La referencia de una devolución: si es el uuid de la transferencia, enlaza a su detalle en QvaPay
const acctRef = (ref) =>
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ref)
		? `<a class="link mono acct-ref" href="https://www.qvapay.com/transaction/${ref}" target="_blank" rel="noopener">${ref}</a>`
		: `<span class="mono acct-ref">${esc(ref)}</span>`
const acctDay = (ms) => cubaFmt(ms, { day: 'numeric', month: 'short', year: 'numeric' })
const acctMonth = (ym) => new Date(`${ym}-15T12:00:00Z`).toLocaleDateString(TPI18N.locale, { month: 'long', year: 'numeric' })
let acctTab = 'summary'

function showAccount(tab = acctTab) {
	if (!bk.acct.connected) return showConnect()
	acctTab = (tab === 'pro' || tab === 'alerts') && !TPPro.enabled ? 'summary' : tab
	const tabs = [['summary', tl('acct.tabSummary')], ...(TPPro.enabled ? [['pro', '★ Pro'], ['alerts', tl('acct.tabAlerts')]] : []), ['stats', tl('acct.tabStats')]]
	openModal(`<div class="stack acct-modal">
		<div class="peer-head">${avatar(bk.acct.username, bk.acct.image, 'lg')}<div><h3>@${esc(bk.acct.username)}</h3><p class="muted small">${tl('acct.myAccount')}</p></div></div>
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
	const fee = feeOf(100) ? tl('acct.feeBuy', { pct }) : tl('acct.noFee')
	$('acctBody').innerHTML = `<div class="stack">
		<div class="peer-stats">
			${stat(tl('acct.balance'), `${fmtM(a.balance ?? 0)}`, 'USD')}
			${stat(tl('acct.verification'), a.kyc ? '✓ KYC' : tl('acct.noKyc'), a.kyc ? tl('acct.kycOk') : tl('acct.kycNeeded'))}
			${stat(tl('acct.p2pFee'), a.gold ? 'GOLD' : pct, fee)}
		</div>
		${TPPro.enabled ? `<button class="btn block" id="acctGoPro">${TPPro.active ? tl('pro.daysLeft', { days: daysText(daysLeft()) }) : TPPro.canTrial ? tl('acct.tryFree', { n: proTrialDays }) : '★ Terminal P2P Pro'}</button>` : ''}
		<p class="hint">${HELP}</p>
		<p class="hint">${tl('acct.tokenHint')}</p>
		<button class="btn danger block" id="acctOut">${tl('acct.disconnect')}</button></div>`
	$('acctGoPro')?.addEventListener('click', () => showAccount('pro'))
	$('acctOut').onclick = () => $('disconnectBtn')?.click()
}

async function acctPro() {
	$('acctBody').innerHTML = `<p class="muted">${tl('acct.loading')}</p>`
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
		$('acctBody').innerHTML = `<div class="stack"><p class="muted">${tl('acct.noDays')}</p><button class="btn primary block" id="acctBuy">${TPPro.canTrial ? tl('acct.tryFree', { n: proTrialDays }) : tl('acct.seePro')}</button></div>`
		$('acctBuy').onclick = showPro
		return
	}
	const left = Math.max(0, Math.ceil((a.expiresAt - Date.now()) / 86_400_000))
	const head = a.suspended
		? `<p class="notice warn">${tl('acct.suspended')}</p>`
		: a.active
			? `<div class="acct-days">${tl('acct.daysUntil', { days: daysText(left), date: acctDay(a.expiresAt) })}</div>`
			: `<div class="acct-days">${tl('acct.expired', { date: acctDay(a.expiresAt) })}</div>`
	const purchases = d.purchases
		.map((p) => {
			const r = p.refund
			// Devuelta: cuándo y con qué transferencia de QvaPay
			const sent =
				r?.status === 'transferred'
					? `<small class="muted">${r.transferredAt ? tl('acct.sentOn', { date: acctDay(r.transferredAt) }) : tl('acct.sentTo')}</small>${r.ref ? `<small class="muted">${tl('acct.transfer', { ref: acctRef(r.ref) })}</small>` : ''}`
					: ''
			// Sin devoluciones (salvo error en el pago, que decidimos nosotros): si le hicimos una, cómo va
			const state = r
				? `<span class="chip ${r.status === 'rejected' ? 'cancelled' : r.status === 'transferred' ? 'completed' : 'paid'}">${ACCT_REFUND[r.status]}${r.usd != null && r.status !== 'rejected' ? ` · ${fmtM(r.usd)} USD` : ''}</span>${r.note ? `<small class="muted">${esc(r.note)}</small>` : ''}${sent}`
				: ''
			return `<li><div><b>${tl('acct.purchaseDays', { n: p.days })}</b> · ${fmtM(p.amount)} USD<small class="muted"> · ${acctDay(p.at)}</small></div><div class="acct-refund">${state}</div></li>`
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
			<p class="sec-box-t">${tl('acct.yourDays')}</p>
			${head}
			${canRenew() ? `<button class="btn primary block" id="acctBuy">${tl('pro.buyDays')}</button>` : `<p class="hint">${tl('acct.renewLater')}</p>`}
			${d.telegram ? '' : `<p class="hint">${tl('acct.tgHint')}</p>`}
		</section>
		<section class="sec-box">
			<p class="sec-box-t">${tl('acct.yourPurchases')}</p>
			${purchases ? `<ul class="acct-list">${purchases}</ul>` : `<p class="muted small">${tl('acct.noPurchases')}</p>`}
			<p class="hint">${NO_REFUNDS}</p>
		</section>
		<section class="sec-box"><p class="sec-box-t">${tl('acct.history')}</p><ul class="acct-moves">${moves || `<li class="muted">${tl('acct.noMoves')}</li>`}</ul></section></div>`
	$('acctBuy')?.addEventListener('click', showPro)
	$('acctGoAlerts')?.addEventListener('click', () => showAccount('alerts'))
}

// La pestaña ★ Avisos: los avisos de tasa por Telegram (con Pro); sin Pro, qué son y cómo tenerlos
function acctAlertsTab() {
	if (!TPPro.active) {
		$('acctBody').innerHTML = `<div class="stack"><p class="muted">${tl('acct.alertsNoPro')}</p><button class="btn primary block" id="acctBuy">${TPPro.canTrial ? tl('acct.tryFree', { n: proTrialDays }) : tl('acct.seePro')}</button></div>`
		$('acctBuy').onclick = showPro
		return
	}
	$('acctBody').innerHTML = `<div id="acctAlerts"><p class="muted">${tl('acct.loading')}</p></div>`
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
	const alertName = (c) => (stockOf(c) ? tl('acct.stockName', { s: stockOf(c) }) : nameOf(c))
	const rateOf = (c) => d.rates[c] ?? (stockOf(c) ? window.TPStocks?.price(stockOf(c)) : null)
	const now = (coin) => (rateOf(coin) ? tl('acct.nowRate', { p: fmtP(rateOf(coin)) }) : stockOf(coin) ? tl('acct.noPriceNow') : tl('acct.noRateNow'))
	const list = d.alerts
		.map(
			(x) =>
				`<li><span>${esc(alertName(x.coin))} · ${tl(x.dir === 'up' ? 'acct.whenUp' : 'acct.whenDown')} <b class="mono">${fmtP(x.price)}</b><small class="muted"> · ${now(x.coin)}${x.armed ? '' : tl('acct.fired', { date: acctDay(x.fired_at), rate: fmtP(x.fired_rate) })}</small></span><button class="link small" data-alert-del="${x.id}">${tl('acct.remove')}</button></li>`,
		)
		.join('')
	const picked = window.TPStocks?.takePick() ?? null
	const coin = picked ?? (window.TPStocks?.on ? null : d.alerts.at(-1)?.coin) ?? (window.TPStocks?.on ? `stock:${window.TPStocks.current()}` : state.coin)
	$('acctAlerts').innerHTML = `<div class="stack">
		<section class="sec-box">
			<p class="sec-box-t">Telegram</p>
			${
				d.telegram
					? `<div class="acct-tg on"><span>${tl('acct.tgOn')}</span><button class="link small" id="tgOff">${tl('acct.tgOff')}</button></div>`
					: `<p class="notice warn">${tl('acct.tgConnectWarn')}</p><button class="btn block" id="alTg">${tl('acct.tgConnect')}</button>`
			}
			<p class="hint">${tl('acct.tgWhat')}</p>
		</section>
		<section class="sec-box">
			<p class="sec-box-t">${tl('acct.yourOffers')}</p>
			<label class="check"><input type="checkbox" id="alOffers" ${d.offers ? 'checked' : ''} /> ${tl('acct.offersCheck')}</label>
			<p class="hint">${tl('acct.offersHint')}</p>
		</section>
		<section class="sec-box">
			<p class="sec-box-t">${tl('acct.rateAndStocks')}</p>
		${list ? `<ul class="acct-list">${list}</ul>` : `<p class="muted small">${tl('acct.rateEmpty')}</p>`}
		${
			d.alerts.length < d.max
				? `<div class="grid2">
				<label class="field">${tl('acct.market')}<select class="input" id="alCoin"><optgroup label="${tl('acct.qvapayRate')}">${markets.map((m) => `<option value="${m.tick}" ${m.tick === coin ? 'selected' : ''}>${esc(TPI18N.coin(m.tick, m.name))}</option>`).join('')}</optgroup><optgroup label="${tl('acct.qvapayStocks')}">${stockList.map(([s, n]) => `<option value="stock:${esc(s)}" ${`stock:${s}` === coin ? 'selected' : ''}>${esc(s)} · ${esc(n)}</option>`).join('')}</optgroup></select></label>
				<label class="field">${tl('acct.alertWhen')}<select class="input" id="alDir"><option value="up">${tl('acct.goesUp')}</option><option value="down">${tl('acct.goesDown')}</option></select></label>
			</div>
			<label class="field"><span id="alPriceLabel">${tl('acct.ratePerUsd')}</span><input class="input" id="alPrice" inputmode="decimal" data-num autocomplete="off" /></label>
			<p class="hint" id="alNow"></p>
			<button class="btn block" id="alAdd">${tl('acct.addAlert')}</button>`
				: `<p class="hint">${tl('acct.maxAlerts', { max: d.max })}</p>`
		}
		</section>
	</div>`
	const sync = () => {
		const c = $('alCoin').value
		const s = stockOf(c)
		const r = rateOf(c)
		$('alPriceLabel').textContent = s ? tl('acct.priceUsd') : tl('acct.ratePerUsd')
		$('alNow').textContent = r ? (s ? tl('acct.stockNow', { s, p: fmtP(r) }) : tl('acct.rateNow', { name: nameOf(c), p: fmtP(r), unit: unitOf(c) })) : ''
		$('alPrice').placeholder = r ? fmtP(r) : ''
	}
	$('alTg')?.addEventListener('click', acctTelegram)
	$('tgOff')?.addEventListener('click', async () => {
		try {
			await proFetch('/pro/telegram/unlink', { print: TPPro.print })
			toast(tl('acct.tgStopped'))
			acctAlerts()
		} catch (e) {
			toast(e.message, true)
		}
	})
	$('alOffers').onchange = async (e) => {
		const on = e.target.checked
		try {
			acctAlerts(await proFetch('/pro/alerts/offers', { print: TPPro.print, on }))
			toast(on ? tl('acct.offersOn') : tl('acct.offersOff'))
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
				toast(tl('acct.alertSet'))
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
		toast(tl('acct.tgStart'))
		window.addEventListener('focus', () => (acctTab === 'pro' || acctTab === 'alerts') && $('acctBody') && showAccount(acctTab), { once: true })
	} catch (e) {
		tab?.close()
		toast(e.message, true)
	}
}

async function acctStats() {
	$('acctBody').innerHTML = `<p class="muted">${tl('acct.readingTrades')}</p>`
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
		$('acctBody').innerHTML = `<p class="muted">${tl('acct.noTrades')}</p>`
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
			<p class="sec-box-t">${tl('acct.yourTrades')}</p>
			<div class="peer-stats">
				${stat(tl('acct.completed'), String(s.completed), tl('acct.ofFinished', { rate }))}
				${stat(tl('acct.bought'), `${fmtM(s.usdBought)}`, 'USD')}
				${stat(tl('acct.sold'), `${fmtM(s.usdSold)}`, 'USD')}
			</div>
			<p class="small muted">${tl('acct.split', { owner: String(s.asOwner), taker: String(s.asTaker), cancelled: String(s.cancelled) })}</p>
		</section>
		<section class="sec-box"><p class="sec-box-t">${tl('acct.byMonth')}</p><table class="acct-table"><tr><th>${tl('acct.month')}</th><th class="r">Ops</th><th class="r">${tl('acct.buys')}</th><th class="r">${tl('acct.sells')}</th></tr>${months}</table></section>
		<section class="sec-box"><p class="sec-box-t">${tl('acct.avgByMarket')}</p><table class="acct-table"><tr><th>${tl('acct.market')}</th><th class="r">Ops</th><th class="r">${tl('acct.boughtAt')}</th><th class="r">${tl('acct.soldAt')}</th></tr>${markets}</table></section>
		${peers ? `<section class="sec-box"><p class="sec-box-t">${tl('acct.topPeers')}</p><div class="chips-row">${peers}</div></section>` : ''}
		<p class="hint">${tl(r.partial ? 'acct.basisPartial' : 'acct.basisAll')}${s.since ? tl('acct.since', { date: acctDay(Date.parse(s.since)) }) : ''}${tl('acct.basisEnd')}</p></div>`
	for (const b of $('acctBody').querySelectorAll('[data-acct-peer]')) b.onclick = () => showPeer(b.dataset.acctPeer)
	if (TPPro.active) window.TPProGains?.render($('acctGains'), r)
	else $('acctGainsPro')?.addEventListener('click', showPro)
}

// Tus ganancias (Pro): las calcula el módulo Pro con tus operaciones de aquí arriba; sin Pro, se dice que existen
function acctGainsSlot() {
	if (!TPPro.enabled) return ''
	if (TPPro.active) return '<section class="sec-box" id="acctGains"></section>'
	return `<section class="sec-box"><p class="sec-box-t">${tl('acct.gains')}</p><p class="hint">${tl('acct.gainsHint')}</p></section>`
}

document.addEventListener('click', (e) => e.target.closest('#acctOpen') && showAccount('summary'))
// Para cualquier dificultad (también con un pago): el grupo de Telegram. Las compras no se devuelven
const HELP = tl('acct.help')
const NO_REFUNDS = tl('acct.noRefunds', { help: HELP })
// Lo que apuntaba el diagnóstico (diag.js), que ya no existe: se borra de este navegador
try {
	localStorage.removeItem('tp.diag')
} catch {}
