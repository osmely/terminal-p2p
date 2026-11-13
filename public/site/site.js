// Landing y blog de Terminal P2P: tema claro/oscuro y tasas de hoy desde la API pública de QvaPay
// (vía el relé del propio dominio, cacheado en el borde: sin token y sin datos de nadie).
const $ = (id) => document.getElementById(id)

// Textos de la portada en el idioma elegido (i18n.js, solo en la portada: el blog y la página de la tasa siguen en
// español y no llegan a usarlo). Fechas con el locale del idioma; los números, siempre 1,050.25
const LOCALE = () => globalThis.TPI18N?.locale ?? 'es'
const coinName = (tick, name) => globalThis.TPI18N?.coin(tick, name) ?? name

const MARKETS = [
	['BANK_CUP', 'CUP Transferencia', 'CUP'],
	['ETECSA', 'Saldo ETECSA', 'CUP'],
	['CUPCASH', 'CUP Efectivo', 'CUP'],
	['BOLSATM', 'Bolsa TM', 'CUP'],
	['BANK_MLC', 'MLC', 'MLC'],
	['CLASICA', 'Tarjeta Clásica', 'USD'],
	['ZELLE', 'Zelle', 'USD'],
	['BANDECPREPAGO', 'Bandec Prepago', 'USD'],
	['TROPIPAY', 'TropiPay', 'EUR'],
]

const decimals = (p) => (p >= 100 ? 2 : 4)
const fmt = (p) => (p > 0 ? p.toLocaleString('en-US', { minimumFractionDigits: decimals(p), maximumFractionDigits: decimals(p) }) : '—')
const pick = (a, median, average) => (a[median] > 0 ? a[median] : a[average] > 0 ? a[average] : 0)
const period = (h) => (h >= 48 && h % 24 === 0 ? tl('site.periodDays', { n: h / 24 }) : `${h} h`)

async function loadRates() {
	try {
		const r = await fetch('/qp/p2p/averages', { headers: { Accept: 'application/json' }, cache: 'no-cache' })
		if (!r.ok) throw new Error(String(r.status))
		const data = await r.json()
		const cards = MARKETS.filter(([tick]) => data[tick]?.count > 0).map(([tick, name, unit]) => {
			const a = data[tick]
			return `<article class="rate">
				<h3>${coinName(tick, name)}</h3><div class="unit">${tl('site.rateUnit', { unit })}</div>
				<div class="px"><span>${tl('site.rateSell')}</span><b class="ask">${fmt(pick(a, 'median_sell', 'average_sell'))}</b><span>${tl('site.rateBuy')}</span><b class="bid">${fmt(pick(a, 'median_buy', 'average_buy'))}</b></div>
				<div class="ops">${tl('site.rateOps', { n: a.count, period: period(a.window_hours ?? 24) })}</div>
			</article>`
		})
		if (!cards.length) throw new Error('vacío')
		$('rates').innerHTML = cards.join('')
		$('ratesSrc').textContent = tl('site.ratesAt', { time: inCuba(Date.now()).toLocaleTimeString(LOCALE(), { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'UTC' }) })
	} catch {
		if ($('rates').querySelector('.rate:not(.skeleton)')) return // se quedan las últimas que se vieron
		$('rates').innerHTML = ''
		$('ratesSrc').textContent = tl('site.ratesFail')
	}
}

// Mercado informal según elTOQUE: lo guarda el servidor una vez por día de Cuba (y hoy, cada 10 min)
const INFORMAL = [
	['usd', 'USD'],
	['eur', 'EUR'],
	['mlc', 'MLC'],
	['usdt', 'USDT'],
]
async function loadInformal() {
	try {
		const r = await fetch('/data/informal', { headers: { Accept: 'application/json' }, cache: 'no-cache' })
		if (!r.ok) throw new Error(String(r.status))
		const { last, prev } = await r.json()
		if (!last) return
		const cells = INFORMAL.filter(([k]) => last[k] > 0).map(([k, label]) => {
			const d = prev?.[k] > 0 ? last[k] / prev[k] - 1 : 0
			const chg = Math.abs(d) >= 0.0005 ? `<i class="${d > 0 ? 'up' : 'down'}" title="${tl('site.vsYesterday')}">${d > 0 ? '+' : ''}${(d * 100).toFixed(1)}%</i>` : ''
			return `<div class="inf"><span>${label}</span>${chg}<b>${fmt(last[k])}</b></div>`
		})
		if (!cells.length) return
		$('infRow').innerHTML = cells.join('')
		$('informal').hidden = false
	} catch {}
}

// En números: lo publicado, tomado y completado desde el terminal (/data/stats, anónimo y cacheado 10 min)
// Hora de Cuba: UTC-4 en verano y UTC-5 en invierno. El verano de 2026 sigue hasta el 7 nov 2027 (Cuba no atrasó
// el reloj) y los navegadores aún dicen UTC-5 para America/Havana: se calcula aquí, igual que en el servidor
function cubaOffset(ms) {
	const sunday = (y, m, nth) => Date.UTC(y, m, 1 + ((7 - new Date(Date.UTC(y, m, 1)).getUTCDay()) % 7) + (nth - 1) * 7, 5)
	const summer = (y) => [sunday(y, 2, 2), y === 2026 ? sunday(2027, 10, 1) : sunday(y, 10, 1)]
	const y = new Date(ms).getUTCFullYear()
	return [summer(y), summer(y - 1)].some(([a, b]) => ms >= a && ms < b) ? -4 * 3_600_000 : -5 * 3_600_000
}
const inCuba = (ms) => new Date(ms + cubaOffset(ms))
const cubaDay =(ms) => inCuba(ms).toLocaleDateString('en-CA', { timeZone: 'UTC' })
const dayName = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString(LOCALE(), { day: 'numeric', month: 'short' })
const whole = (n) => Math.round(n).toLocaleString('en-US')
async function loadStats() {
	let s
	try {
		const r = await fetch('/data/stats', { headers: { Accept: 'application/json' } })
		if (!r.ok) return
		s = await r.json()
	} catch {
		return
	}
	if (!s.since) return
	const sec = $('numeros')
	for (const k of ['created', 'taken', 'completed']) {
		const n = s.day[k]
		sec.querySelector(`[data-day="${k}"]`).innerHTML = n ? tl('site.last24h', { n: `+${whole(n)}` }) : ''
	}
	sec.querySelector('[data-day="volume"]').innerHTML = s.day.volume ? tl('site.last24h', { n: `+${whole(s.day.volume)} USD` }) : ''
	// Un día por barra, desde la primera acción (al menos una semana y como mucho 30 días), con los días sin nada en 0
	const vol = new Map(s.byDay.map((d) => [d.day, d]))
	const now = Date.now()
	const span = Math.min(30, Math.max(7, Math.round((now - s.since) / 86_400_000) + 1))
	const days = Array.from({ length: span }, (_, i) => cubaDay(now - (span - 1 - i) * 86_400_000))
	const max = Math.max(...days.map((d) => vol.get(d)?.volume ?? 0))
	$('statsBars').innerHTML = days
		.map((d) => {
			const v = vol.get(d)
			const usd = v?.volume ?? 0
			const tip = `${dayName(d)}: ${v ? `${tl('site.dayTrades', { n: v.completed, count: whole(v.completed) })} · ${whole(usd)} USD` : tl('site.noTrades')}`
			return `<i class="${usd ? (usd === max ? 'top' : '') : 'zero'}" style="--h:${usd ? Math.max(6, (usd / max) * 100) : 0}%" title="${tip}"></i>`
		})
		.join('')
	$('barsFrom').textContent = dayName(days[0])
	sec.hidden = false
	// Los números cuentan hasta su valor al verse la sección (de golpe si se prefiere sin animaciones)
	const nums = [...sec.querySelectorAll('[data-stat]')]
	const show = (p) => nums.forEach((el) => (el.textContent = whole(s[el.dataset.stat] * p)))
	const run = () => {
		$('statsBars').classList.add('in')
		if (matchMedia('(prefers-reduced-motion: reduce)').matches) return show(1)
		const t0 = performance.now()
		const step = (t) => {
			const p = Math.min(1, (t - t0) / 1400)
			show(1 - (1 - p) ** 3)
			if (p < 1) requestAnimationFrame(step)
		}
		requestAnimationFrame(step)
	}
	if (!('IntersectionObserver' in window)) return run()
	const io = new IntersectionObserver((entries) => {
		if (!entries.some((e) => e.isIntersecting)) return
		io.disconnect()
		run()
	}, { threshold: 0.3 })
	io.observe(sec)
}

// La tasa de hoy: 30 días de QvaPay (venta y compra, hora a hora) con el USDT y el USD de elTOQUE (uno por día).
// Los números de arriba ya vienen puestos del servidor; aquí solo la gráfica, con su cruz al pasar el dedo o el ratón
const SERIES = [
	['sell', 'QvaPay venta'],
	['buy', 'QvaPay compra'],
	['usdt', 'USDT (elTOQUE)'],
	['usd', 'USD efectivo (elTOQUE)'],
]
const SVG_NS = 'http://www.w3.org/2000/svg'
const whenOf = (t) => inCuba(t).toLocaleString('es', { timeZone: 'UTC', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
async function loadTasaChart() {
	const box = $('tasaChart')
	let d
	try {
		const r = await fetch('/data/rates?coin=BANK_CUP&days=30', { headers: { Accept: 'application/json' } })
		if (!r.ok) throw new Error(String(r.status))
		d = await r.json()
	} catch {
		box.innerHTML = '<p class="muted-sm">No se pudo cargar la gráfica ahora mismo.</p>'
		return
	}
	const qp = d.points.filter((p) => p.sell > 0 || p.buy > 0)
	const inf = (d.informal ?? []).filter((x) => x.usd > 0 || x.usdt > 0)
	if (qp.length < 2) {
		box.innerHTML = '<p class="muted-sm">Aún no hay suficientes datos para la gráfica.</p>'
		return
	}
	const lines = {
		sell: qp.filter((p) => p.sell > 0).map((p) => [p.t, p.sell]),
		buy: qp.filter((p) => p.buy > 0).map((p) => [p.t, p.buy]),
		usdt: inf.filter((x) => x.usdt > 0 && x.t >= qp[0].t - 86_400_000).map((x) => [x.t, x.usdt]),
		usd: inf.filter((x) => x.usd > 0 && x.t >= qp[0].t - 86_400_000).map((x) => [x.t, x.usd]),
	}
	const all = Object.values(lines).flat()
	const t0 = Math.min(...all.map(([t]) => t))
	const t1 = Math.max(...all.map(([t]) => t))
	const step = (() => {
		const span = Math.max(...all.map(([, v]) => v)) - Math.min(...all.map(([, v]) => v)) || 10
		const raw = span / 4
		const pow = 10 ** Math.floor(Math.log10(raw))
		return [1, 2, 2.5, 5, 10].map((m) => m * pow).find((x) => x >= raw)
	})()
	const lo = Math.floor(Math.min(...all.map(([, v]) => v)) / step) * step
	const hi = Math.ceil(Math.max(...all.map(([, v]) => v)) / step) * step
	const W = Math.max(300, box.clientWidth)
	const H = W < 500 ? 220 : 260
	const pad = { l: 8, r: 52, t: 10, b: 24 }
	const x = (t) => pad.l + ((t - t0) / (t1 - t0 || 1)) * (W - pad.l - pad.r)
	const y = (v) => pad.t + (1 - (v - lo) / (hi - lo || 1)) * (H - pad.t - pad.b)
	let svg = `<svg class="tchart" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Tasa del USD en QvaPay y en elTOQUE en los últimos 30 días">`
	for (let v = lo; v <= hi + 1e-9; v += step)
		svg += `<line class="grid" x1="${pad.l}" x2="${W - pad.r}" y1="${y(v)}" y2="${y(v)}"/><text class="ax" x="${W - pad.r + 6}" y="${y(v) + 4}">${v.toLocaleString('en-US')}</text>`
	// Una fecha cada pocos días, a mediodía de Cuba
	const days = Math.round((t1 - t0) / 86_400_000)
	const every = Math.max(1, Math.ceil(days / Math.floor((W - pad.l - pad.r) / 70)))
	for (let i = 0; i <= days; i += every) {
		const t = t0 + i * 86_400_000
		if (x(t) > W - pad.r - 20) break
		svg += `<text class="ax" x="${x(t)}" y="${H - 6}" text-anchor="${i === 0 ? 'start' : 'middle'}">${inCuba(t).toLocaleDateString('es', { timeZone: 'UTC', day: 'numeric', month: 'short' })}</text>`
	}
	for (const [k] of SERIES) if (lines[k].length > 1) svg += `<path class="ln ${k}" d="${lines[k].map(([t, v], i) => `${i ? 'L' : 'M'}${x(t).toFixed(1)},${y(v).toFixed(1)}`).join('')}"/>`
	svg += `<line class="cross" id="tasaCross" y1="${pad.t}" y2="${H - pad.b}" visibility="hidden"/><g id="tasaDots"></g><rect class="hit" x="${pad.l}" y="0" width="${W - pad.l - pad.r}" height="${H}"/></svg>`
	box.innerHTML = `${svg}<div class="tasa-tip" id="tasaTip" hidden></div>`
	const color = { sell: 'var(--ask)', buy: 'var(--bid)', usdt: 'var(--s-usdt)', usd: 'var(--s-usd)' }
	// El valor de cada serie en ese momento: el último punto que no pasa de ahí
	const at = (k, t) => {
		let v = null
		for (const [pt, pv] of lines[k]) if (pt <= t + 1) v = [pt, pv]
		return v
	}
	const show = (e) => {
		const r = box.querySelector('svg').getBoundingClientRect()
		const px = ((e.clientX - r.left) / r.width) * W
		const t = t0 + ((px - pad.l) / (W - pad.l - pad.r)) * (t1 - t0)
		const near = qp.reduce((a, p) => (Math.abs(p.t - t) < Math.abs(a.t - t) ? p : a))
		const vals = SERIES.map(([k, name]) => [k, name, at(k, near.t)]).filter(([, , v]) => v)
		const cross = $('tasaCross')
		cross.setAttribute('x1', x(near.t))
		cross.setAttribute('x2', x(near.t))
		cross.setAttribute('visibility', 'visible')
		$('tasaDots').innerHTML = vals.map(([k, , [pt, v]]) => `<circle class="dot" cx="${x(k === 'sell' || k === 'buy' ? near.t : pt)}" cy="${y(v)}" r="4" fill="${color[k]}"/>`).join('')
		const tip = $('tasaTip')
		tip.innerHTML = `<div>${whenOf(near.t)}</div>${vals.map(([k, name, [, v]]) => `<div><i style="background:${color[k]}"></i>${name}: <b>${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</b></div>`).join('')}`
		tip.hidden = false
		const left = (x(near.t) / W) * r.width
		tip.style.left = `${Math.min(Math.max(0, left + 12), r.width - tip.offsetWidth)}px`
		if (left + 12 + tip.offsetWidth > r.width) tip.style.left = `${Math.max(0, left - tip.offsetWidth - 12)}px`
	}
	const hit = box.querySelector('.hit')
	hit.addEventListener('pointermove', show)
	hit.addEventListener('pointerdown', show)
	hit.addEventListener('pointerleave', () => {
		$('tasaTip').hidden = true
		$('tasaCross').setAttribute('visibility', 'hidden')
		$('tasaDots').innerHTML = ''
	})
}

$('themeBtn').addEventListener('click', () => {
	const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light'
	document.documentElement.dataset.theme = next
	try {
		localStorage.setItem('theme', JSON.stringify(next))
	} catch {}
})

// Operar: cada paso muestra su captura
const steps = [...document.querySelectorAll('.op-step')]
for (const b of steps)
	b.addEventListener('click', () => {
		for (const o of steps) {
			o.classList.toggle('active', o === b)
			o.setAttribute('aria-selected', String(o === b))
		}
		const img = $('opImg')
		img.src = b.dataset.img
		img.width = Number(b.dataset.w)
		img.height = Number(b.dataset.h)
		img.alt = b.dataset.altKey && typeof tl === 'function' ? tl(b.dataset.altKey) : b.dataset.alt
	})

// Las tasas solo están en la portada (el blog comparte este script)
if ($('rates')) {
	loadRates()
	// Solo con la pestaña visible; el relé las cachea 60 s en el borde
	setInterval(() => !document.hidden && loadRates(), 60_000)
}
if ($('informal')) loadInformal()
if ($('numeros')) loadStats()
if ($('tasaChart')) {
	loadTasaChart()
	// Se dibuja al ancho que tiene: al girar el móvil o cambiar la ventana, otra vez
	let w = $('tasaChart').clientWidth
	new ResizeObserver(() => {
		const now = $('tasaChart').clientWidth
		if (Math.abs(now - w) < 24) return
		w = now
		loadTasaChart()
	}).observe($('tasaChart'))
}

// El menú de ayuda se cierra al tocar fuera o con Escape
document.addEventListener('click', (e) => {
	for (const d of document.querySelectorAll('details.help[open]')) if (!d.contains(e.target)) d.open = false
})
document.addEventListener('keydown', (e) => {
	if (e.key === 'Escape') for (const d of document.querySelectorAll('details.help[open]')) d.open = false
})
