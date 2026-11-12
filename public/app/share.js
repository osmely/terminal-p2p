// Compartir una oferta: su dueño la anuncia en sus grupos con una imagen (la tasa, el monto, el mercado y su reputación;
// nunca sus datos de pago) y un enlace corto, terminalp2p.com/o/<uuid>, que abre el terminal con ella delante.
// Quien llega sin la cuenta conectada la ve igual (el servidor la saca del libro en vivo, /data/offer) y la conecta
// para tomarla. Si la oferta ya no está, se enseñan las mejores de ese mercado. La imagen se dibuja en el navegador
'use strict'

// Lo público del servidor (/data/…): con fetch, no con TPApi (que atiende las rutas /api/* en el navegador)
async function getData(url) {
	const r = await fetch(url, { cache: 'no-cache' })
	if (!r.ok) throw new Error(`${r.status}`)
	return r.json()
}
const shareLink = (uuid) => `${location.origin.replace('://app.', '://')}/o/${uuid}`
const ICON_SHARE =
	'<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M12 15V3M12 3l-4.5 4.5M12 3l4.5 4.5M5 12v7a2 2 0 002 2h10a2 2 0 002-2v-7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>'

// ── La oferta compartida, para quien abre el enlace ───────────────────
async function showPublicOffer(uuid, amount) {
	openModal('<p class="muted">Cargando oferta…</p>')
	let o = null
	try {
		o = await getData(`/data/offer?id=${encodeURIComponent(uuid)}`)
	} catch {}
	if (o?.state === 'open') {
		const level = { ...o, kyc: false, requirementsMet: null }
		return renderTake(uuid, o.side, level, o.coin, amount)
	}
	if (o?.state === 'gone') return showGone(o.coin, o.side, uuid)
	if (o?.state === 'paused') return showPaused(o.coin, o.side, uuid, o)
	// Una privada (no sale en el libro) o una que el libro en vivo no conoce: con la cuenta conectada se lee de QvaPay
	$('modalBody').innerHTML = `<div class="stack">
		<h3>Te compartieron una oferta del P2P de QvaPay</h3>
		<p class="muted">Conecta tu cuenta de QvaPay para verla y tomarla. Operas con tu propia cuenta: el dinero sigue en el escrow de QvaPay.</p>
		<button class="btn primary block" id="puConnect">Conectar mi cuenta</button>
	</div>`
	$('puConnect').onclick = () => showConnect('Conecta tu cuenta para ver la oferta', () => showTakeOfferById(uuid, amount))
}

// La oferta ya no está: la tomaron o la retiró su dueño. Las mejores de ese mercado y lado, para no llegar a nada
function showGone(coin, side, exclude, why = 'La tomaron o la retiró su dueño.') {
	$('modalBody').innerHTML = `<div class="stack">
		<h3>Esta oferta ya no está</h3>
		<p class="muted">${esc(why)}</p>
		<div id="similar"></div>
	</div>`
	fillSimilar(coin, side, exclude)
}

// Sigue publicada pero en pausa (nadie la puede tomar ahora): por qué y, si es la automática, a qué hora vuelve sola
function pausedWhy(p) {
	if (p?.reason === 'taker_left') {
		const until = p.until ? cubaFmt(p.until, { hour: '2-digit', minute: '2-digit' }) : null
		return `Quien la tomó se fue y QvaPay la pausa unos minutos para que su dueño revise la tasa. ${until ? `Vuelve sola al mercado a las ${until} (hora de Cuba).` : 'Vuelve sola al mercado en unos minutos.'}`
	}
	return 'Su dueño la sacó del mercado un momento, sin cancelarla. Podrás tomarla cuando la vuelva a publicar.'
}
function showPaused(coin, side, exclude, pause) {
	$('modalBody').innerHTML = `<div class="stack">
		<h3>Esta oferta está en pausa</h3>
		<p class="muted">${esc(pausedWhy(pause))}</p>
		<div id="similar"></div>
	</div>`
	fillSimilar(coin, side, exclude)
}

const SIMILAR_TOP = 3
async function fillSimilar(coin, side, exclude) {
	const box = $('similar')
	if (!box || !coin || (side !== 'ask' && side !== 'bid')) return
	const unit = unitOf(coin)
	const youBuy = side === 'ask'
	let list = []
	try {
		const b = await getData(`/data/book?coin=${encodeURIComponent(coin)}`)
		list = (b[side]?.levels ?? []).filter((l) => l.uuid !== exclude && !l.vipOnly && !l.outlier).slice(0, SIMILAR_TOP)
	} catch {}
	if (!$('similar')) return
	box.innerHTML = `${
		list.length
			? `<p class="hint">Las mejores ${youBuy ? 'ventas' : 'compras'} de ${esc(nameOf(coin))} ahora</p>
		<div class="similar">${list
			.map(
				(l) =>
					`<button type="button" class="similar-row" data-similar="${l.uuid}"><b class="num ${side}">${fmtP(l.price)} ${unit}</b><span class="num">${l.kind === 'flexible' && l.orderMax ? `hasta ${fmtM(Math.min(l.orderMax, l.usd))}` : fmtM(l.usd)} USD</span><span class="muted">@${esc(l.user)}</span></button>`,
			)
			.join('')}</div>`
			: ''
	}<button class="btn block" id="seeBook">Ver el libro de ${esc(nameOf(coin))}</button>`
	for (const r of box.querySelectorAll('[data-similar]')) r.onclick = () => showTakeOfferById(r.dataset.similar)
	$('seeBook').onclick = () => {
		closeModal()
		selectCoin(coin)
	}
}

// ── Compartir la tuya ──────────────────────────────────────────────────
function shareFacts(o) {
	const flex = o.kind === 'flexible'
	const usd = flex ? (o.available ?? o.usd) : o.usd
	const max = flex ? Math.min(o.orderMax ?? usd, usd) : usd
	const owner = o.owner ?? {}
	return {
		sell: o.type === 'sell',
		market: nameOf(o.coin),
		unit: unitOf(o.coin),
		price: fmtP(o.price),
		amount: flex && o.orderMin ? `De ${fmtM(o.orderMin)} a ${fmtM(max)} QUSD` : `${fmtM(usd)} QUSD`,
		extra: [o.onlyVip && 'Solo cuentas VIP', reqText(o.requirements) && `Requisitos: ${reqText(o.requirements)}`].filter(Boolean).join(' · '),
		user: owner.username ?? bk.acct.username ?? '',
		// En tu propia oferta QvaPay no siempre trae tu reputación: la de tu perfil del P2P
		rating: owner.rating ?? bk.acct.p2pRating ?? null,
		ops: owner.ops ?? bk.acct.p2pCompleted ?? null,
		link: shareLink(o.offer),
	}
}

const shareText = (f) => `${f.sell ? 'Vendo' : 'Compro'} QUSD a ${f.price} ${f.unit} · ${f.market} · ${f.amount}\nTómala en Terminal P2P: ${f.link}`

async function showShareOffer(o) {
	const f = shareFacts(o)
	const text = shareText(f)
	openModal(`<div class="stack">
		<h3>Compartir la oferta</h3>
		<img class="share-img" id="shImg" alt="Imagen de la oferta" />
		<label class="share-switch">Oscura<input type="checkbox" role="switch" id="shLight" aria-label="Imagen clara" />Clara</label>
		<label class="field">Mensaje<textarea class="input" id="shText" rows="3" readonly>${esc(text)}</textarea></label>
		<div class="row-btns share-btns">
			${navigator.share ? `<button class="btn primary" id="shNative">${ICON_SHARE} Compartir</button>` : ''}
			${window.ClipboardItem ? '<button class="btn" id="shCopyImg">Copiar imagen</button>' : ''}
			<button class="btn" id="shCopyText">Copiar mensaje</button>
			<a class="btn" id="shSave" download="oferta-terminal-p2p.png">Descargar imagen</a>
		</div>
		<p class="hint">La imagen no lleva tus datos de pago. El enlace abre la oferta en el terminal: quien no tenga su cuenta conectada la ve y la conecta para tomarla.</p>
		<button type="button" class="link" id="shBack">← Volver a la oferta</button>
	</div>`)
	$('shBack').onclick = () => showManageOffer(o.offer)
	$('shCopyText').onclick = () => {
		navigator.clipboard?.writeText(text)
		toast('Mensaje copiado')
	}
	// La imagen del tema elegido; al cambiarlo se vuelve a pintar (lo que se copia o comparte es siempre la que se ve)
	let blob = null
	let file = null
	let theme = shareTheme()
	const paint = async () => {
		$('shLight').checked = theme === 'light'
		const want = theme
		const canvas = await drawShareCard(f, want)
		const b = await new Promise((r) => canvas.toBlob(r, 'image/png'))
		if (!$('shImg') || !b || want !== theme) return
		blob = b
		file = new File([b], 'oferta-terminal-p2p.png', { type: 'image/png' })
		const url = canvas.toDataURL('image/png')
		$('shImg').src = url
		$('shSave').href = url
	}
	$('shLight').onchange = (e) => {
		theme = e.target.checked ? 'light' : 'dark'
		try {
			localStorage.setItem('tp.shareTheme', theme)
		} catch {}
		paint()
	}
	await paint()
	$('shNative')?.addEventListener('click', async () => {
		if (!file) return
		const data = navigator.canShare?.({ files: [file] }) ? { files: [file], text } : { text }
		try {
			await navigator.share(data)
		} catch (e) {
			if (e?.name !== 'AbortError') toast('No se pudo abrir el menú de compartir: copia la imagen y el mensaje', true)
		}
	})
	$('shCopyImg')?.addEventListener('click', async () => {
		if (!blob) return
		try {
			await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
			toast('Imagen copiada: pégala en el chat y luego el mensaje')
		} catch {
			toast('Este navegador no deja copiar imágenes: descárgala', true)
		}
	})
}

// ── La imagen ──────────────────────────────────────────────────────────
const CARD = 1080
const PAD = 84
const SANS = 'Inter, system-ui, sans-serif'
const MONO = '"JetBrains Mono", ui-monospace, monospace'

// El tamaño de letra más grande (hasta size) con el que el texto cabe en maxW
function fitFont(ctx, text, maxW, size, weight, family) {
	let s = size
	do ctx.font = `${weight} ${s}px ${family}`
	while (ctx.measureText(text).width > maxW && --s > 12)
	return s
}

function roundRect(ctx, x, y, w, h, r) {
	ctx.beginPath()
	ctx.roundRect ? ctx.roundRect(x, y, w, h, r) : ctx.rect(x, y, w, h)
}

// Los colores de la imagen en cada tema. El claro oscurece el rojo y el verde para que se lean sobre blanco
const SHARE_THEMES = {
	dark: { bg: '#070a0f', glow: 0.16, blue: 'rgba(91,140,255,0.16)', grid: 'rgba(255,255,255,0.025)', ask: [246, 70, 93], bid: [31, 194, 139], text: '#e9eef6', price: '#ffffff', unit: '#b4c0d0', label: '#7d8a9c', extra: '#f0b93a', line: 'rgba(255,255,255,0.1)', face: 'rgba(91,140,255,0.18)', accent: '#9db8ff', rep: '#9aa7b8' },
	light: { bg: '#f5f7fb', glow: 0.1, blue: 'rgba(91,140,255,0.12)', grid: 'rgba(15,23,42,0.045)', ask: [214, 40, 66], bid: [10, 148, 100], text: '#0f1726', price: '#0b1220', unit: '#475569', label: '#64748b', extra: '#a86a06', line: 'rgba(15,23,42,0.12)', face: 'rgba(91,140,255,0.16)', accent: '#3159d6', rep: '#475569' },
}
// El tema de la imagen: el que elegiste la última vez o, si no, el del terminal
const shareTheme = () => {
	try {
		const t = localStorage.getItem('tp.shareTheme')
		if (t === 'light' || t === 'dark') return t
	} catch {}
	const t = document.documentElement.dataset.theme
	return t === 'light' || t === 'dark' ? t : matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
}

async function drawShareCard(f, theme = 'dark') {
	const P = SHARE_THEMES[theme] ?? SHARE_THEMES.dark
	await Promise.all(['700 40px Inter', '600 40px Inter', '500 40px Inter', '600 40px "JetBrains Mono"'].map((x) => document.fonts?.load(x).catch(() => {})))
	const c = document.createElement('canvas')
	c.width = c.height = CARD
	const ctx = c.getContext('2d')
	const rgb = (f.sell ? P.ask : P.bid).join(',')
	const side = `rgb(${rgb})`
	const sideBg = `rgba(${rgb},`

	// Fondo: del tema, con un brillo del color del lado y otro azul, y una rejilla tenue
	ctx.fillStyle = P.bg
	ctx.fillRect(0, 0, CARD, CARD)
	for (const [x, y, r, col] of [
		[180, 260, 620, `${sideBg}${P.glow})`],
		[960, 900, 640, P.blue],
	]) {
		const g = ctx.createRadialGradient(x, y, 0, x, y, r)
		g.addColorStop(0, col)
		g.addColorStop(1, `${col.slice(0, col.lastIndexOf(','))},0)`)
		ctx.fillStyle = g
		ctx.fillRect(0, 0, CARD, CARD)
	}
	ctx.strokeStyle = P.grid
	ctx.lineWidth = 1
	for (let p = 0; p <= CARD; p += 54) {
		ctx.beginPath()
		ctx.moveTo(p + 0.5, 0)
		ctx.lineTo(p + 0.5, CARD)
		ctx.moveTo(0, p + 0.5)
		ctx.lineTo(CARD, p + 0.5)
		ctx.stroke()
	}

	// Marca
	ctx.fillStyle = '#5b8cff'
	roundRect(ctx, PAD, PAD, 60, 60, 16)
	ctx.fill()
	ctx.save()
	ctx.translate(PAD + 6, PAD + 6)
	ctx.scale(2, 2)
	ctx.strokeStyle = '#fff'
	ctx.lineWidth = 2.6
	ctx.lineCap = ctx.lineJoin = 'round'
	ctx.beginPath()
	ctx.moveTo(4, 16)
	ctx.lineTo(8.5, 11)
	ctx.lineTo(12, 14)
	ctx.lineTo(19, 6)
	ctx.stroke()
	ctx.restore()
	ctx.fillStyle = P.text
	ctx.font = `700 34px ${SANS}`
	ctx.textBaseline = 'middle'
	ctx.fillText('Terminal P2P', PAD + 80, PAD + 31)

	// Vendo o compro
	const tag = f.sell ? 'VENDO QUSD' : 'COMPRO QUSD'
	ctx.font = `700 30px ${SANS}`
	const tw = ctx.measureText(tag).width + 48
	ctx.fillStyle = `${sideBg}0.16)`
	roundRect(ctx, CARD - PAD - tw, PAD + 2, tw, 56, 28)
	ctx.fill()
	ctx.strokeStyle = `${sideBg}0.55)`
	ctx.lineWidth = 2
	ctx.stroke()
	ctx.fillStyle = side
	ctx.fillText(tag, CARD - PAD - tw + 24, PAD + 31)

	const W = CARD - PAD * 2
	ctx.textBaseline = 'alphabetic'
	const label = (text, y) => {
		ctx.fillStyle = P.label
		ctx.font = `500 28px ${SANS}`
		ctx.fillText(text, PAD, y)
	}

	label('Mercado', 268)
	ctx.fillStyle = P.text
	fitFont(ctx, f.market, W, 60, 700, SANS)
	ctx.fillText(f.market, PAD, 336)

	label('Precio por QUSD', 446)
	ctx.font = `600 52px ${MONO}`
	const unitW = ctx.measureText(` ${f.unit}`).width
	ctx.fillStyle = P.price
	const ps = fitFont(ctx, f.price, W - unitW, 168, 600, MONO)
	ctx.fillText(f.price, PAD - ps * 0.04, 610)
	const pw = ctx.measureText(f.price).width
	ctx.fillStyle = P.unit
	ctx.font = `600 52px ${MONO}`
	ctx.fillText(` ${f.unit}`, PAD + pw, 610)

	label('Monto', 712)
	ctx.fillStyle = P.text
	fitFont(ctx, f.amount, W, 58, 700, SANS)
	ctx.fillText(f.amount, PAD, 778)
	if (f.extra) {
		ctx.fillStyle = P.extra
		fitFont(ctx, f.extra, W, 28, 500, SANS)
		ctx.fillText(f.extra, PAD, 830)
	}

	// Abajo: quién la publica y dónde tomarla
	ctx.strokeStyle = P.line
	ctx.lineWidth = 2
	ctx.beginPath()
	ctx.moveTo(PAD, 880)
	ctx.lineTo(CARD - PAD, 880)
	ctx.stroke()
	const cy = 952
	ctx.fillStyle = P.face
	ctx.beginPath()
	ctx.arc(PAD + 36, cy, 36, 0, Math.PI * 2)
	ctx.fill()
	ctx.fillStyle = P.accent
	ctx.font = `700 28px ${SANS}`
	ctx.textAlign = 'center'
	ctx.textBaseline = 'middle'
	ctx.fillText((f.user || '?').slice(0, 2).toUpperCase(), PAD + 36, cy + 1)
	ctx.textAlign = 'left'
	const rep = [f.rating ? `★ ${f.rating.toFixed(2)}` : null, f.ops != null ? `${f.ops.toLocaleString('en-US')} operaciones` : null].filter(Boolean).join(' · ')
	// Sin reputación que enseñar, el usuario va centrado con el círculo
	ctx.fillStyle = P.text
	fitFont(ctx, `@${f.user}`, 470, 34, 700, SANS)
	ctx.fillText(`@${f.user}`, PAD + 92, rep ? cy - 18 : cy)
	if (rep) {
		ctx.fillStyle = P.rep
		ctx.font = `500 26px ${SANS}`
		ctx.fillText(rep, PAD + 92, cy + 22)
	}
	ctx.textAlign = 'right'
	ctx.fillStyle = P.label
	ctx.font = `500 26px ${SANS}`
	ctx.fillText('Tómala en', CARD - PAD, cy - 18)
	ctx.fillStyle = P.accent
	ctx.font = `700 34px ${SANS}`
	ctx.fillText(new URL(f.link).host, CARD - PAD, cy + 22)
	ctx.textAlign = 'left'
	return c
}
