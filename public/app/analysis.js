// ★ Análisis de mercado (modo Pro). Su botón, como el del radar, sale con la cuenta conectada y Pro encendido (pro.js).
// Todo sale del informe que el servidor deja hecho cada madrugada, con la foto del libro de cada hora (/data/analysis, ver
// worker/analysis.ts): la tasa al cierre de cada día, las operaciones y el volumen, elTOQUE, el libro y las horas del
// mercado. Aquí solo se cuenta y se dibuja. Lo que aún no tiene datos lo dice («En espera de datos») en vez de inventar
;(() => {
	// Los que se comparan con el USD informal (como en la lectura del mercado); MLC y TropiPay, con su relación implícita
	const CUP_MARKETS = INFORMAL_MARKETS
	const vsInformal = (tick, rate, inf) => {
		if (rate == null || !inf?.usd) return null
		if (CUP_MARKETS.has(tick)) return rate / inf.usd - 1
		if (tick === 'BANK_MLC') return inf.mlc ? rate / (inf.usd / inf.mlc) - 1 : null
		if (tick === 'TROPIPAY') return inf.eur ? rate / (inf.usd / inf.eur) - 1 : null
		return null
	}
	const hasInformal = (tick) => CUP_MARKETS.has(tick) || tick === 'BANK_MLC' || tick === 'TROPIPAY'
	const DOW = tl('ana.dow').split('|')
	const PERIODS = [
		['last7', tl('ana.last7')],
		['week', tl('ana.lastWeek')],
		['month', tl('ana.lastMonth')],
	]
	const an = { tick: null, period: 'last7', cmp: null, measure: 'idx', smooth: 1, groups: new Set(), heat: 'bid', print: false, data: null }
	// Comparar mercados: cada mercado lleva siempre el mismo color (los 8 de la paleta, en orden fijo, de más a menos
	// volumen). Los que sobran repiten un color con trazo discontinuo. Nunca más de 8 líneas a la vez
	const CMP_ORDER = ['BANK_CUP', 'CLASICA', 'ZELLE', 'BANDECPREPAGO', 'ETECSA', 'USDCASH', 'BANK_MLC', 'TROPIPAY']
	const CMP_EXTRA = { BOLSATM: 3, CUPCASH: 7, USDT: 2, USDTBSC: 6, PAYPAL: 5, PIX: 4, EURCASH: 8 }
	const CMP_MAX = 8
	const cmpStyle = (tick) => {
		const i = CMP_ORDER.indexOf(tick)
		if (i >= 0) return { color: `var(--c${i + 1})` }
		return CMP_EXTRA[tick] ? { color: `var(--c${CMP_EXTRA[tick]})`, dash: true } : { color: 'var(--muted)', dash: true }
	}

	// ── Días de Cuba (AAAA-MM-DD) ──────────────────────────────────────
	const addDays = (day, n) => new Date(Date.parse(`${day}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10)
	const dates = (from, to) => {
		const out = []
		for (let d = from; d < to; d = addDays(d, 1)) out.push(d)
		return out
	}
	// Mediodía de ese día en la hora del navegador: para escribir la fecha
	const noon = (day) => new Date(`${day}T12:00:00`).getTime()
	// [desde, hasta) y el comienzo del periodo anterior
	function range(period) {
		const today = an.data.today
		if (period === 'last7') return [addDays(today, -7), today, addDays(today, -14)]
		if (period === 'week') {
			const end = addDays(today, -((new Date(`${today}T12:00:00Z`).getUTCDay() + 6) % 7))
			return [addDays(end, -7), end, addDays(end, -14)]
		}
		const [y, m] = today.split('-').map(Number)
		const first = (yy, mm) => new Date(Date.UTC(yy, mm - 1, 1)).toISOString().slice(0, 10)
		return [first(y, m - 1), first(y, m), first(y, m - 2)]
	}

	// ── Los datos ──────────────────────────────────────────────────────
	// Un mercado: sus días por fecha, con elTOQUE de ese día (o del último que tenga) al lado
	const coinCache = new Map()
	function coin(tick) {
		if (coinCache.has(tick)) return coinCache.get(tick)
		const raw = an.data.coins[tick] ?? { days: [], heatVol: null, heatBid: null, book: null, normal: null }
		const days = new Map(raw.days.map((d) => [d.day, d]))
		const out = { ...raw, byDay: days }
		coinCache.set(tick, out)
		return out
	}
	// elTOQUE de ese día, o del último día anterior que tenga
	const infMemo = new Map()
	const informalOn = (day) => {
		if (infMemo.has(day)) return infMemo.get(day)
		const keys = Object.keys(an.data.informal).filter((d) => d <= day).sort()
		const v = keys.length ? an.data.informal[keys.at(-1)] : null
		infMemo.set(day, v)
		return v
	}
	// El primer día con algún dato de tasa en cualquier mercado
	const firstDay = () => Object.values(an.data.coins).flatMap((c) => (c.days.length ? [c.days[0].day] : [])).sort()[0] ?? an.data.today
	// Desde cuándo hay volumen en algún mercado (el registro volvió a empezar al corregir su conteo)
	const volSince = () => {
		const day = Object.values(an.data.coins).flatMap((c) => c.days.filter((d) => d.usd != null).slice(0, 1).map((d) => d.day)).sort()[0]
		return day ? tl('ana.volSince', { day: dShort(day) }) : tl('ana.volJustStarted')
	}

	// Los días del periodo que se dibujan: desde el primero con datos (no se pintan días de antes de que existieran)
	function axisOf(period) {
		const [from, to] = range(period)
		const start = from < firstDay() ? firstDay() : from
		return dates(start, to)
	}
	const sumOf = (xs, k) => xs.reduce((t, x) => t + (x[k] ?? 0), 0)
	function summary(tick, period) {
		const [from, to, prevFrom] = range(period)
		const c = coin(tick)
		const pick = (a, b) => dates(a, b).map((d) => c.byDay.get(d)).filter(Boolean)
		const cur = pick(from, to)
		const prev = pick(prevFrom, from)
		const rated = cur.filter((x) => x.rate != null)
		const prevRated = prev.filter((x) => x.rate != null)
		const volDays = cur.filter((x) => x.usd != null)
		const prevVolDays = prev.filter((x) => x.usd != null)
		const opsDays = cur.filter((x) => x.ops != null)
		const moves = rated.slice(1).map((x, i) => Math.abs(x.rate / rated[i].rate - 1))
		const premiums = (xs) => xs.map((x) => vsInformal(tick, x.rate, informalOn(x.day))).filter((v) => v != null)
		const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null)
		// Comparar con el periodo anterior solo si tiene datos de casi tantos días como este
		const comparable = (a, b) => b.length > 0 && b.length >= a.length * 0.8
		const share = (xs) => {
			const vol = sumOf(xs, 'usd')
			if (vol > 0) return sumOf(xs, 'buyUsd') / vol
			const ops = sumOf(xs, 'buyOps') + sumOf(xs, 'sellOps')
			return ops > 0 ? sumOf(xs, 'buyOps') / ops : null
		}
		return {
			from,
			to,
			cur,
			days: cur.length,
			partialStart: from < firstDay(),
			rated: rated.length > 0,
			open: rated[0]?.rate ?? null,
			close: rated.at(-1)?.rate ?? null,
			prevClose: comparable(rated, prevRated) ? prevRated.at(-1).rate : null,
			hi: rated.length ? rated.reduce((a, b) => (b.rate > a.rate ? b : a)) : null,
			lo: rated.length ? rated.reduce((a, b) => (b.rate < a.rate ? b : a)) : null,
			move: avg(moves),
			vol: volDays.length ? sumOf(volDays, 'usd') : null,
			volDays: volDays.length,
			prevVol: comparable(volDays, prevVolDays) ? sumOf(prevVolDays, 'usd') : null,
			ops: opsDays.length ? sumOf(opsDays, 'ops') : null,
			opsDays: opsDays.length,
			buyShare: share(cur),
			prevBuyShare: comparable(cur, prev) ? share(prev) : null,
			premium: avg(premiums(rated)),
			prevPremium: comparable(rated, prevRated) ? avg(premiums(prevRated)) : null,
		}
	}

	// ── Formato ────────────────────────────────────────────────────────
	const dShort = (day) => new Date(noon(day)).toLocaleDateString(TPI18N.locale, { day: 'numeric', month: 'short' })
	const signPct = (x, digits = 1) => {
		const s = Math.abs(x * 100).toFixed(digits)
		return `${Number(s) === 0 ? '' : x > 0 ? '+' : '−'}${s}%`
	}
	const usdK = (n) => `${fmtU(Math.round(n))} USD`
	const tone = (x) => (x > 0 ? 'up' : x < 0 ? 'down' : '')
	const unitOf = (tick) => state.overview.find((c) => c.tick === tick)?.unit ?? ''
	const nameOf = (tick) => TPI18N.coin(tick, state.overview.find((c) => c.tick === tick)?.name ?? tick)
	const hhmm = (t) => cubaFmt(t, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
	const waiting = (what = '') => `<div class="an-wait"><b>${tl('ana.waiting')}</b>${what ? `<span>${what}</span>` : ''}</div>`
	// Un mercado con días registrados y ninguna tasa: QvaPay no la publica (USDCASH sale siempre en cero)
	const NO_RATE = tl('ana.noRate')
	const noRate = (tick) => {
		const days = coin(tick).days
		return days.length > 0 && !days.some((d) => d.rate != null)
	}
	const noRateBox = () => `<div class="an-wait"><b>${NO_RATE}</b><span>${tl('ana.noRateSub')}</span></div>`

	// ── Gráficos (SVG, con su tooltip) ─────────────────────────────────
	let tipEl = null
	const tip = (html, e) => {
		tipEl ??= Object.assign(document.body.appendChild(document.createElement('div')), { className: 'an-tip' })
		if (!html) return void (tipEl.hidden = true)
		tipEl.hidden = false
		tipEl.innerHTML = html
		const w = tipEl.offsetWidth
		tipEl.style.left = `${Math.min(window.innerWidth - w - 8, e.clientX + 12)}px`
		tipEl.style.top = `${e.clientY + 14}px`
	}

	// En el móvil el dibujo es más estrecho: así el texto de los ejes no se encoge
	const narrow = () => !an.print && window.innerWidth < 640

	// Líneas en una misma escala. series: [{ name, cls | color, dash?, values: [número o null por día], tipValue?(i) }]
	// Un día sin dato deja un hueco en la línea. opt.fmt da el texto del eje; opt.labels pone el nombre al final de cada
	// línea (solo con 4 o menos)
	const swatch = (s) => `<i class="an-sw ${s.cls ?? ''} ${s.dash ? 'dash' : ''}" ${s.color ? `style="--sw:${s.color}"` : ''}></i>`
	function lineChart(id, days, series, opt = {}) {
		const fmt = opt.fmt ?? fmtP
		const labels = opt.labels && series.length <= 4 && !narrow()
		const W = narrow() ? 360 : 640
		const H = narrow() ? 190 : 200
		const P = { l: 54, r: labels ? 112 : 12, t: 10, b: 24 }
		const all = series.flatMap((s) => s.values).filter((v) => v != null)
		let lo = Math.min(...all)
		let hi = Math.max(...all)
		const pad = (hi - lo) * 0.08 || Math.abs(hi) * 0.01 || 1
		lo = opt.zero ? Math.max(0, lo - pad) : lo - pad
		hi += pad
		const x = (i) => (days.length === 1 ? (P.l + W - P.r) / 2 : P.l + (i * (W - P.l - P.r)) / (days.length - 1))
		const y = (v) => P.t + (1 - (v - lo) / (hi - lo)) * (H - P.t - P.b)
		const ticks = [0, 0.5, 1].map((f) => lo + (hi - lo) * f)
		const xl = [...new Set([0, Math.floor((days.length - 1) / 2), days.length - 1])]
		const path = (vs) => {
			let d = ''
			let pen = false
			vs.forEach((v, i) => {
				if (v == null) return void (pen = false)
				d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`
				pen = true
			})
			return d
		}
		// Un día suelto (sin vecinos) se ve como un punto
		const dots = (s) =>
			s.values
				.map((v, i) => (v != null && s.values[i - 1] == null && s.values[i + 1] == null ? `<circle class="an-dot" cx="${x(i)}" cy="${y(v)}" r="3" ${s.color ? `style="fill:${s.color}"` : ''}/>` : ''))
				.join('')
		const lastOf = (s) => [...s.values].reverse().find((v) => v != null)
		// Los nombres al final de las líneas, separados para que no se pisen
		const ends = labels ? series.map((s, k) => ({ k, y: y(lastOf(s)) })).sort((a, b) => a.y - b.y) : []
		for (let i = 1; i < ends.length; i++) ends[i].y = Math.max(ends[i].y, ends[i - 1].y + 13)
		const svg = `<svg viewBox="0 0 ${W} ${H}" class="an-svg" id="${id}">
			${ticks.map((v) => `<line class="an-grid" x1="${P.l}" x2="${W - P.r}" y1="${y(v)}" y2="${y(v)}"/><text class="an-axis" x="${P.l - 6}" y="${y(v) + 4}" text-anchor="end">${fmt(v)}</text>`).join('')}
			${opt.base === undefined || opt.base < lo || opt.base > hi ? '' : `<line class="an-base" x1="${P.l}" x2="${W - P.r}" y1="${y(opt.base)}" y2="${y(opt.base)}"/>`}
			${xl.map((i) => `<text class="an-axis" x="${x(i)}" y="${H - 6}" text-anchor="${days.length === 1 ? 'middle' : i === 0 ? 'start' : i === days.length - 1 ? 'end' : 'middle'}">${dShort(days[i])}</text>`).join('')}
			${series.map((s) => `<path class="an-line ${s.cls ?? ''} ${s.dash ? 'dash' : ''}" ${s.color ? `style="stroke:${s.color}"` : ''} d="${path(s.values)}"/>${dots(s)}`).join('')}
			${ends.map((e) => `<text class="an-end" x="${W - P.r + 6}" y="${e.y + 4}">${esc(series[e.k].short ?? series[e.k].name)}</text>`).join('')}
			<line class="an-cross" id="${id}X" y1="${P.t}" y2="${H - P.b}" hidden/>
			<rect class="an-hit" x="${P.l}" y="0" width="${W - P.l - P.r}" height="${H}"/>
		</svg>`
		const legend = `<div class="an-legend">${series.map((s) => `<span>${swatch(s)}${esc(s.name)}</span>`).join('')}</div>`
		const bind = () => {
			const el = document.getElementById(id)
			const cross = document.getElementById(`${id}X`)
			el.querySelector('.an-hit').addEventListener('mousemove', (e) => {
				const box = el.getBoundingClientRect()
				const step = (W - P.l - P.r) / Math.max(1, days.length - 1)
				const i = days.length === 1 ? 0 : Math.max(0, Math.min(days.length - 1, Math.round((((e.clientX - box.left) / box.width) * W - P.l) / step)))
				cross.setAttribute('x1', x(i))
				cross.setAttribute('x2', x(i))
				cross.hidden = false
				const rows = [...series].sort((a, b) => (b.values[i] ?? -Infinity) - (a.values[i] ?? -Infinity))
				tip(`<b>${dShort(days[i])}</b>${rows.map((s) => `<div>${swatch(s)}${esc(s.name)} <b>${s.values[i] == null ? tl('ana.noData') : s.tipValue ? s.tipValue(i) : fmt(s.values[i])}</b></div>`).join('')}`, e)
			})
			el.querySelector('.an-hit').addEventListener('mouseleave', () => {
				cross.hidden = true
				tip(null)
			})
		}
		return { html: legend + svg, bind }
	}

	// Volumen por día: compras y ventas apiladas, con 2 px de aire entre las dos. Un día sin registro queda vacío
	function volumeChart(id, days, rows) {
		const W = narrow() ? 360 : 640
		const H = narrow() ? 160 : 150
		const P = { l: 54, r: 12, t: 8, b: 24 }
		const max = Math.max(...rows.map((d) => d?.usd ?? 0)) * 1.08 || 1
		const bw = (W - P.l - P.r) / days.length
		const y = (v) => (v / max) * (H - P.t - P.b)
		const base = H - P.b
		const bars = rows
			.map((d, i) => {
				const hit = `<rect class="an-hit" x="${P.l + i * bw}" y="0" width="${bw}" height="${H}"/>`
				if (d?.usd == null) return `<g data-i="${i}">${hit}</g>`
				const w = Math.max(2, Math.min(bw * 0.64, 36))
				const x0 = P.l + i * bw + (bw - w) / 2
				const hb = y(d.buyUsd)
				const hs = y(d.sellUsd)
				return `<g data-i="${i}"><rect class="an-bar buy" x="${x0}" y="${base - hb}" width="${w}" height="${Math.max(0, hb)}" rx="2"/><rect class="an-bar sell" x="${x0}" y="${base - hb - hs - (hb > 0 ? 2 : 0)}" width="${w}" height="${Math.max(0, hs)}" rx="2"/>${hit}</g>`
			})
			.join('')
		const ticks = [0, 0.5, 1].map((f) => max * f)
		const svg = `<svg viewBox="0 0 ${W} ${H}" class="an-svg" id="${id}">
			${ticks.map((v) => `<line class="an-grid" x1="${P.l}" x2="${W - P.r}" y1="${base - y(v)}" y2="${base - y(v)}"/><text class="an-axis" x="${P.l - 6}" y="${base - y(v) + 4}" text-anchor="end">${fmtU(Math.round(v))}</text>`).join('')}
			<text class="an-axis" x="${P.l}" y="${H - 6}">${dShort(days[0])}</text>${days.length > 1 ? `<text class="an-axis" x="${W - P.r}" y="${H - 6}" text-anchor="end">${dShort(days.at(-1))}</text>` : ''}
			${bars}</svg>`
		const legend = `<div class="an-legend"><span><i class="an-sw buy"></i>${tl('ana.usdBuys')}</span><span><i class="an-sw sell"></i>${tl('ana.usdSells')}</span></div>`
		const bind = () => {
			for (const g of document.getElementById(id).querySelectorAll('g[data-i]')) {
				const i = Number(g.dataset.i)
				const d = rows[i]
				g.addEventListener('mousemove', (e) =>
					tip(
						d?.usd == null
							? `<b>${dShort(days[i])}</b><div>${tl('ana.noVolume')}</div>`
							: `<b>${dShort(days[i])}</b><div>${tl('ana.total')} <b>${usdK(d.usd)}</b>${d.ops == null ? '' : ` · ${tl('ana.ops', { n: d.ops })}`}</div><div><i class="an-sw buy"></i>${tl('ana.buys')} <b>${usdK(d.buyUsd)}</b></div><div><i class="an-sw sell"></i>${tl('ana.sells')} <b>${usdK(d.sellUsd)}</b></div>`,
						e,
					),
				)
				g.addEventListener('mouseleave', () => tip(null))
			}
		}
		return { html: legend + svg, bind }
	}

	// Días de la semana × horas de Cuba, un solo color de claro a oscuro. kind: 'bid' (% sobre la media del día) o 'vol' (USD)
	function heatmap(id, heat, kind) {
		const vals = heat.flat().filter((v) => v !== null)
		const lo = Math.min(...vals)
		const hi = Math.max(...vals)
		const order = [1, 2, 3, 4, 5, 6, 0]
		const cells = order
			.map((d) => `<span class="an-hl">${DOW[d]}</span>${heat[d].map((v, h) => (v === null ? `<i class="an-cell off" data-d="${d}" data-h="${h}"></i>` : `<i class="an-cell" style="--a:${(0.12 + (0.88 * (v - lo)) / (hi - lo || 1)).toFixed(2)}" data-d="${d}" data-h="${h}" data-v="${v}"></i>`)).join('')}`)
			.join('')
		const hours = `<span></span>${Array.from({ length: 24 }, (_, h) => `<span class="an-hh">${h % 3 === 0 ? h : ''}</span>`).join('')}`
		const more = kind === 'vol' ? tl('ana.heatMoreVol') : tl('ana.heatMoreBid')
		const html = `<div class="an-heat" id="${id}">${cells}${hours}</div><div class="an-legend"><span>${tl('ana.less')}</span><span class="an-scale"></span><span>${more}</span><span><i class="an-cell off"></i>${tl('ana.noDataCap')}</span></div>`
		const bind = () => {
			for (const c of document.getElementById(id).querySelectorAll('.an-cell')) {
				c.addEventListener('mousemove', (e) => {
					const v = c.dataset.v
					const what = v === undefined ? tl('ana.noDataYet') : kind === 'vol' ? tl('ana.heatTipVol', { usd: usdK(Number(v)) }) : tl('ana.heatTipBid', { pct: signPct(Number(v) / 100, 2) })
					tip(`<b>${DOW[c.dataset.d]} · ${c.dataset.h}:00–${Number(c.dataset.h) + 1}:00</b><div>${what}</div>`, e)
				})
				c.addEventListener('mouseleave', () => tip(null))
			}
		}
		return { html, bind }
	}

	// Reparto del volumen entre mercados: la barra es el periodo, la marca, el periodo anterior
	function shareBars(id, rows, tick) {
		const total = rows.reduce((t, r) => t + (r.vol ?? 0), 0)
		const prevTotal = rows.reduce((t, r) => t + (r.prevVol ?? 0), 0)
		const list = rows
			.filter((r) => r.vol != null)
			.map((r) => ({ ...r, share: r.vol / total, prev: prevTotal && r.prevVol != null ? r.prevVol / prevTotal : null }))
			.sort((a, b) => b.share - a.share)
		const max = Math.max(...list.map((r) => Math.max(r.share, r.prev ?? 0))) * 1.05
		const html = `<div class="an-legend"><span><i class="an-sw box acc"></i>${tl('ana.thisPeriod')}</span>${list.some((r) => r.prev !== null) ? `<span><i class="an-sw mark"></i>${tl('ana.prevPeriod')}</span>` : ''}</div>
			<div class="an-hbars" id="${id}">${list
				.map(
					(r, i) => `<div class="an-hrow ${r.tick === tick ? 'on' : ''}" data-i="${i}"><span class="an-hname">${esc(r.name)}</span><span class="an-htrack"><i class="an-hfill" style="width:${((r.share / max) * 100).toFixed(1)}%"></i>${r.prev === null ? '' : `<i class="an-hmark" style="left:${((r.prev / max) * 100).toFixed(1)}%"></i>`}</span><span class="an-hval">${(r.share * 100).toFixed(r.share < 0.1 ? 1 : 0)}%</span></div>`,
				)
				.join('')}</div>`
		const bind = () => {
			for (const row of document.getElementById(id).querySelectorAll('.an-hrow')) {
				const r = list[Number(row.dataset.i)]
				row.addEventListener('mousemove', (e) =>
					tip(`<b>${esc(r.name)}</b><div>${tl('ana.shareTip', { pct: (r.share * 100).toFixed(1), usd: usdK(r.vol) })}</div>${r.prev === null ? '' : `<div>${tl('ana.before', { v: `${(r.prev * 100).toFixed(1)}% · ${usdK(r.prevVol)}` })}</div>`}`, e),
				)
				row.addEventListener('mouseleave', () => tip(null))
			}
		}
		return { html, bind }
	}

	// Frente a elTOQUE: cuánto paga QvaPay sobre la calle, de media en el periodo. Barras a los dos lados del cero
	function premiumBars(id, rows, tick) {
		const list = [...rows].sort((a, b) => b.cur - a.cur)
		const max = Math.max(...list.flatMap((r) => [Math.abs(r.cur), Math.abs(r.prev ?? 0)])) * 1.1 || 0.01
		const pos = (v) => 50 + (v / max) * 50
		const html = `<div class="an-legend"><span><i class="an-sw box pos"></i>${tl('ana.qpPaysMore')}</span><span><i class="an-sw box neg"></i>${tl('ana.qpPaysLess')}</span>${list.some((r) => r.prev !== null) ? `<span><i class="an-sw mark"></i>${tl('ana.prevPeriod')}</span>` : ''}</div>
			<div class="an-hbars div" id="${id}">${list
				.map((r, i) => {
					const a = Math.min(50, pos(r.cur))
					const w = Math.abs(pos(r.cur) - 50)
					return `<div class="an-hrow ${r.tick === tick ? 'on' : ''}" data-i="${i}"><span class="an-hname">${esc(r.name)}</span><span class="an-htrack"><i class="an-hzero"></i><i class="an-hfill ${r.cur >= 0 ? 'pos' : 'neg'}" style="left:${a.toFixed(1)}%;width:${w.toFixed(1)}%"></i>${r.prev === null ? '' : `<i class="an-hmark" style="left:${pos(r.prev).toFixed(1)}%"></i>`}</span><span class="an-hval">${signPct(r.cur)}</span></div>`
				})
				.join('')}</div>`
		const bind = () => {
			for (const row of document.getElementById(id).querySelectorAll('.an-hrow')) {
				const r = list[Number(row.dataset.i)]
				row.addEventListener('mousemove', (e) =>
					tip(`<b>${esc(r.name)}</b><div>${tl('ana.premTip', { pct: signPct(r.cur), ref: r.ref })}</div>${r.prev === null ? '' : `<div>${tl('ana.before', { v: signPct(r.prev) })}</div>`}`, e),
				)
				row.addEventListener('mouseleave', () => tip(null))
			}
		}
		return { html, bind }
	}
	const REF_NAME = { BANK_MLC: tl('ana.refMlc'), TROPIPAY: tl('ana.refEur') }

	// Comparar mercados: qué se mide (todo en una misma escala), la línea diaria o su media móvil, y medias de grupos
	const MEASURES = [
		['idx', tl('ana.mIdx'), tl('ana.mIdxSub')],
		['prem', tl('ana.mPrem'), tl('ana.mPremSub')],
		['vol', tl('ana.mVol'), tl('ana.mVolSub')],
		['buy', tl('ana.mBuy'), tl('ana.mBuySub')],
	]
	const SMOOTH = [
		[1, tl('ana.daily')],
		[3, tl('ana.avg3')],
		[7, tl('ana.avg7')],
	]
	// Varios mercados como uno: su media pesada por el volumen del periodo (en volumen, la suma). Van en tinta, no en color
	const GROUPS = [
		{ key: 'G_CUP', name: tl('ana.avgCup'), total: tl('ana.totalCup'), cls: 'g1', ticks: ['BANK_CUP', 'CUPCASH', 'BOLSATM'] },
		{ key: 'G_USD', name: tl('ana.avgUsd'), total: tl('ana.totalUsd'), cls: 'g2', ticks: ['CLASICA', 'ZELLE', 'BANDECPREPAGO'] },
	]
	// Media de los días con dato dentro de la ventana; sin ninguno, null
	const movingAvg = (xs, n) =>
		xs.map((_, i) => {
			const w = xs.slice(Math.max(0, i - n + 1), i + 1).filter((v) => v != null)
			return w.length ? w.reduce((a, b) => a + b, 0) / w.length : null
		})
	function compareChart(markets, axis) {
		const k = an.measure
		const valueOf = (m, d) => {
			const x = coin(m.tick).byDay.get(d)
			if (!x) return null
			if (k === 'idx') return x.rate
			if (k === 'prem') return vsInformal(m.tick, x.rate, informalOn(d))
			if (k === 'vol') return x.usd
			// Sin USD (los días del conteo viejo), con las operaciones
			return x.usd > 0 ? x.buyUsd / x.usd : x.ops > 0 && x.buyOps != null ? x.buyOps / x.ops : null
		}
		const has = (m) => (k !== 'prem' || hasInformal(m.tick)) && ((k !== 'idx' && k !== 'prem') || !noRate(m.tick))
		// La serie del periodo, ya suavizada (la media usa también los días de antes del periodo)
		const smoothed = (m) => {
			const pre = dates(addDays(axis[0], -(an.smooth - 1)), axis[0])
			return movingAvg([...pre, ...axis].map((d) => valueOf(m, d)), an.smooth).slice(pre.length)
		}
		const values = (m) => {
			const sm = smoothed(m)
			if (k === 'vol') return sm
			if (k !== 'idx') return sm.map((v) => (v == null ? null : v * 100))
			const base = sm.find((v) => v != null)
			return sm.map((v) => (v == null ? null : (v / base) * 100))
		}
		const val = (v) => (k === 'idx' ? signPct(v / 100 - 1) : k === 'prem' ? signPct(v / 100) : k === 'vol' ? usdK(v) : tl('ana.pctBuys', { n: v.toFixed(0) }))
		const fmt = (v) => (k === 'idx' ? v.toFixed(1) : k === 'vol' ? fmtU(Math.round(v)) : `${v.toFixed(k === 'prem' ? 1 : 0)}%`)
		const series = markets
			.filter((m) => an.cmp.has(m.tick) && has(m))
			.map((m) => {
				const vs = values(m)
				const rate = k === 'idx' ? smoothed(m) : null
				return { name: m.name, ...cmpStyle(m.tick), values: vs, tipValue: (i) => `${val(vs[i])}${rate?.[i] != null ? ` <small class="muted">${fmtP(rate[i])} ${esc(m.unit)}</small>` : ''}` }
			})
			.filter((s) => s.values.some((v) => v != null))
		const groupOk = (g) => markets.some((m) => g.ticks.includes(m.tick) && has(m))
		for (const g of GROUPS) {
			if (!an.groups.has(g.key) || !groupOk(g)) continue
			const ms = markets.filter((m) => g.ticks.includes(m.tick) && has(m))
			const each = ms.map((m) => values(m))
			// Cada día, con los mercados que tengan dato; pesan por su volumen del periodo (o igual, si no hay volumen)
			const vs = axis.map((_, i) => {
				const got = each.map((v, j) => [v[i], ms[j].ms.vol ?? 0]).filter(([v]) => v != null)
				if (!got.length) return null
				if (k === 'vol') return got.reduce((t, [v]) => t + v, 0)
				const wsum = got.reduce((t, [, w]) => t + w, 0)
				return wsum > 0 ? got.reduce((t, [v, w]) => t + v * w, 0) / wsum : got.reduce((t, [v]) => t + v, 0) / got.length
			})
			if (vs.some((v) => v != null)) series.push({ name: k === 'vol' ? g.total : g.name, cls: g.cls, values: vs, tipValue: (i) => val(vs[i]) })
		}
		const chart = series.length
			? lineChart('anIdx', axis, series, { fmt, base: k === 'idx' ? 100 : k === 'prem' ? 0 : k === 'buy' ? 50 : undefined, zero: k === 'vol', labels: true })
			: { html: waiting(k === 'vol' || k === 'buy' ? volSince() : ''), bind() {} }
		const chips = markets
			.map((m) => {
				const on = an.cmp.has(m.tick)
				const off = !has(m)
				return `<button class="an-chip ${on ? 'on' : ''}" data-an-cmp="${esc(m.tick)}" aria-pressed="${on}" ${off || (!on && an.cmp.size >= CMP_MAX) ? 'disabled' : ''} ${off ? `title="${noRate(m.tick) ? NO_RATE : tl('ana.noRef')}"` : ''}>${on && !off ? swatch(cmpStyle(m.tick)) : ''}${esc(m.name)}</button>`
			})
			.join('')
		const groups = GROUPS.map((g) => {
			const on = an.groups.has(g.key)
			const ok = groupOk(g)
			const names = g.ticks.map((t) => markets.find((m) => m.tick === t)?.name).filter(Boolean).join(', ')
			return `<button class="an-chip grp ${on ? 'on' : ''}" data-an-grp="${g.key}" aria-pressed="${on}" ${ok ? '' : 'disabled'} title="${esc(names)}">${on && ok ? swatch({ cls: g.cls }) : ''}${k === 'vol' ? g.total : g.name}</button>`
		}).join('')
		const controls = `<div class="an-cmpbar">
			<div class="seg-tabs an-measure" role="tablist">${MEASURES.map(([key, l]) => `<button class="seg-tab ${k === key ? 'active' : ''}" data-an-measure="${key}" role="tab">${l}</button>`).join('')}</div>
			<select class="input an-smooth" id="anSmooth" aria-label="${tl('ana.line')}">${SMOOTH.map(([n, l]) => `<option value="${n}" ${an.smooth === n ? 'selected' : ''}>${l}</option>`).join('')}</select>
		</div>
		<div class="an-chips">${chips}<span class="an-chipsep"></span>${groups}</div>`
		const sub = `${MEASURES.find((x) => x[0] === k)[2]}${an.smooth > 1 ? ` · ${tl('ana.avgOf', { n: an.smooth })}` : ''}`
		return { html: chart.html, controls, sub, bind: chart.bind }
	}

	// El libro ahora: la última foto (el informe la cambia cada hora), con un semáforo de reglas fijas y sus motivos
	function bookNow(tick, lastRate) {
		const c = coin(tick)
		const b = c.book
		if (!b?.ask?.best || !b?.bid?.best) return { html: waiting(tl('ana.bookSince')) }
		const n = c.normal
		const spread = b.ask.best / b.bid.best - 1
		const sellVsDone = lastRate ? b.bid.best / lastRate - 1 : null
		const buyVsDone = lastRate ? b.ask.best / lastRate - 1 : null
		const thinAsk = n?.usd1Ask ? b.ask.usd1 / n.usd1Ask : null
		const reasons = []
		let light = 'mid'
		let verdict = tl('ana.vNone')
		if (sellVsDone !== null && thinAsk !== null && sellVsDone > -0.004 && thinAsk < 0.8) {
			light = 'good'
			verdict = tl('ana.vSell')
		} else if (buyVsDone !== null && thinAsk !== null && buyVsDone < 0.006 && thinAsk > 1.1) {
			light = 'good'
			verdict = tl('ana.vBuy')
		} else if (spread < 0) {
			// Cruzado no siempre es ganancia: requisitos de las ofertas y la comisión de QvaPay
			verdict = tl('ana.vCrossed')
		} else if (n?.spread != null && n.spread > 0 && spread > n.spread * 1.6) {
			light = 'bad'
			verdict = tl('ana.vWait')
		}
		if (sellVsDone !== null) reasons.push(tl('ana.rTopBid', { bid: fmtP(b.bid.best), pct: signPct(sellVsDone), last: fmtP(lastRate) }))
		const normalTxt =
			n?.spread == null
				? ''
				: n.spread < 0
					? tl(n.hour ? 'ana.normalCrossedHour' : 'ana.normalCrossed', { pct: (-n.spread * 100).toFixed(1) })
					: tl(n.hour ? 'ana.normalHour' : 'ana.normal', { pct: (n.spread * 100).toFixed(1) })
		reasons.push(
			spread < 0
				? tl('ana.rCrossed', { pct: signPct(b.bid.best / b.ask.best - 1).replace(/^[+−]/, ''), normal: normalTxt })
				: tl('ana.rSpread', { pct: signPct(spread).replace(/^[+−]/, ''), normal: normalTxt }),
		)
		reasons.push(tl('ana.rDepth', { usd: usdK(b.ask.usd1), vs: thinAsk === null ? '' : thinAsk < 1 ? tl('ana.thinLess', { n: Math.round((1 - thinAsk) * 100) }) : tl('ana.thinMore', { n: Math.round((thinAsk - 1) * 100) }) }))
		const vs = vsInformal(tick, lastRate, informalOn(an.data.today))
		if (vs !== null) reasons.push(tl('ana.rInformal', { pct: signPct(vs), ref: CUP_MARKETS.has(tick) ? tl('ana.overInformal') : tl('ana.overRef', { ref: REF_NAME[tick] }) }))
		if (b.stale) reasons.push(tl('ana.rStale'))
		const fill = (v) => (v == null ? '—' : fmtP(v))
		const over = (v) => (v == null ? tl('ana.notEnough') : tl('ana.overBest', { pct: signPct(v / b.ask.best - 1, 2) }))
		return {
			when: tl('ana.snapAt', { time: hhmm(b.t) }),
			html: `<div class="an-light ${light}"><i></i><b>${verdict}</b></div>
				<ul class="an-words">${reasons.map((r) => `<li>${r}</li>`).join('')}</ul>
				<div class="an-kpis small">
					<div class="an-kpi"><span>${tl('ana.buy100')}</span><b>${fill(b.ask.fill100)}</b><small>${over(b.ask.fill100)}</small></div>
					<div class="an-kpi"><span>${tl('ana.buy500')}</span><b>${fill(b.ask.fill500)}</b><small>${over(b.ask.fill500)}</small></div>
					<div class="an-kpi"><span>${tl('ana.concentration')}</span><b>${b.ask.top1 == null ? '—' : `${Math.round(b.ask.top1 * 100)}%`}</b><small>${tl('ana.concentrationSub')}</small></div>
					<div class="an-kpi"><span>${tl('ana.freshness')}</span><b>${b.ask.age == null ? '—' : `${fmtU(b.ask.age)} min`}</b><small>${tl('ana.freshnessSub')}</small></div>
				</div>`,
		}
	}

	// ── La vista ───────────────────────────────────────────────────────
	function build() {
		const tick = an.tick
		const unit = unitOf(tick)
		const c = coin(tick)
		const s = summary(tick, an.period)
		const axis = axisOf(an.period)
		const cup = CUP_MARKETS.has(tick)
		const label = PERIODS.find((x) => x[0] === an.period)[1]
		const change = s.close == null ? null : s.prevClose ? s.close / s.prevClose - 1 : s.close / s.open - 1
		const changeVs = s.prevClose ? tl('ana.vsPrev') : tl('ana.inPeriod')
		const volChange = s.vol != null && s.prevVol ? s.vol / s.prevVol - 1 : null
		const lastRate = [...c.days].reverse().find((d) => d.rate != null)?.rate ?? null
		const book = bookNow(tick, lastRate)
		const since = s.partialStart && axis.length ? tl('ana.dataSince', { day: dShort(axis[0]) }) : ''
		const wait = `<small>${tl('ana.waiting')}</small>`
		const rateWait = noRate(tick) ? `<small>${NO_RATE}</small>` : wait
		const kpi = (k, v, sub, t = '', cls = '') => `<div class="an-kpi ${cls}"><span>${k}</span><b>${v}</b><small class="${t}">${sub}</small></div>`
		const kpis = [
			s.close == null ? kpi(tl('ana.kClose'), '—', rateWait) : kpi(tl('ana.kClose'), fmtP(s.close), `${signPct(change)} ${changeVs}`, tone(change)),
			s.hi ? kpi(tl('ana.kRange'), `${fmtP(s.lo.rate)}–${fmtP(s.hi.rate)}`, tl('ana.kRangeHi', { day: dShort(s.hi.day) }), '', 'sm') : kpi(tl('ana.kRange'), '—', rateWait),
			s.move == null ? kpi(tl('ana.kMove'), '—', rateWait) : kpi(tl('ana.kMove'), `${(s.move * 100).toFixed(2)}%`, tl('ana.kMoveSub')),
			s.vol == null
				? kpi(tl('ana.kVol'), '—', wait)
				: kpi(tl('ana.kVol'), usdK(s.vol), volChange === null ? tl('ana.kVolDays', { n: s.volDays }) : `${signPct(volChange)} ${tl('ana.vsPrev')}`, volChange === null ? '' : tone(volChange)),
			s.ops == null ? kpi(tl('ana.kOps'), '—', wait) : kpi(tl('ana.kOps'), fmtU(s.ops), tl('ana.kOpsDay', { n: fmtU(Math.round(s.ops / s.opsDays)) })),
			s.buyShare == null ? kpi(tl('ana.mBuy'), '—', wait) : kpi(tl('ana.mBuy'), tl('ana.pctBuys', { n: Math.round(s.buyShare * 100) }), tl('ana.pctSells', { n: Math.round((1 - s.buyShare) * 100) }), s.buyShare > 0.5 ? 'up' : 'down'),
		].join('')
		// Las mejores horas para vender: las tres en que el mejor comprador pagaba más sobre la media del día
		const top = c.heatBid ? c.heatBid.flatMap((row, dd) => row.map((v, h) => ({ v, d: dd, h }))).filter((x) => x.v !== null).sort((a, b) => b.v - a.v).slice(0, 3) : []
		const words = [
			s.close == null
				? ''
				: `${tl(change >= 0 ? (s.prevClose ? 'ana.wUpPrev' : 'ana.wUp') : s.prevClose ? 'ana.wDownPrev' : 'ana.wDown', { pct: signPct(change), close: fmtP(s.close), unit })}${s.hi && s.hi !== s.lo ? tl('ana.wHiLo', { hi: fmtP(s.hi.rate), hiDay: dShort(s.hi.day), lo: fmtP(s.lo.rate), loDay: dShort(s.lo.day) }) : ''}`,
			s.vol == null
				? ''
				: `${tl('ana.wVol', { usd: usdK(s.vol) })}${volChange === null ? '' : tl('ana.wVolChange', { pct: signPct(volChange) })}.${s.buyShare == null ? '' : ` ${s.buyShare > 0.5 ? tl('ana.wBuysWon') : tl('ana.wSellsWon')} (${Math.round(Math.max(s.buyShare, 1 - s.buyShare) * 100)}%)${s.prevBuyShare == null ? '' : `, ${Math.abs(s.buyShare - s.prevBuyShare) < 0.03 ? tl('ana.wAsBefore') : s.buyShare > s.prevBuyShare ? tl('ana.wMoreThan') : tl('ana.wLessThan')}`}.`}`,
			s.premium == null
				? ''
				: `${tl('ana.wPrem', { pct: signPct(s.premium), ref: cup ? tl('ana.overInformal') : tl('ana.overRef', { ref: REF_NAME[tick] }) })}${s.prevPremium == null ? '' : tl(s.premium > s.prevPremium ? 'ana.wGapOpened' : 'ana.wGapClosed', { pts: Math.abs((s.premium - s.prevPremium) * 100).toFixed(1) })}.`,
			top.length ? tl('ana.wBestHours', { list: top.map((x) => `<b>${DOW[x.d]} ${x.h}:00</b> (${signPct(x.v / 100, 2)})`).join(', ') }) : '',
		].filter(Boolean)
		const rows = axis.map((d) => c.byDay.get(d) ?? null)
		const rateVals = rows.map((x) => x?.rate ?? null)
		const lines = rateVals.some((v) => v != null)
			? lineChart('anRate', axis, [
					{ name: tl('ana.qpClose'), cls: 'qp', values: rateVals },
					...(cup ? [{ name: 'elTOQUE USDT', cls: 'tq', values: axis.map((d) => informalOn(d)?.usdt ?? null) }] : []),
				])
			: { html: noRate(tick) ? noRateBox() : waiting(), bind() {} }
		const vols = rows.some((x) => x?.usd != null) ? volumeChart('anVol', axis, rows) : { html: waiting(volSince()), bind() {} }
		const heatData = an.heat === 'vol' ? c.heatVol : c.heatBid
		const heat = heatData && heatData.flat().some((v) => v !== null) ? heatmap('anHeat', heatData, an.heat) : { html: waiting(an.heat === 'vol' ? tl('ana.heatNeedVol') : tl('ana.heatNeedBook')), bind() {} }
		// Comparar mercados en el mismo periodo: la gráfica (con sus opciones), el reparto del volumen y elTOQUE
		const markets = state.overview.map((m) => ({ tick: m.tick, name: TPI18N.coin(m.tick, m.name), unit: m.unit, ms: summary(m.tick, an.period) }))
		if (!an.cmp) {
			const top3 = markets.filter((m) => m.tick !== tick).sort((a, b) => (b.ms.vol ?? b.ms.ops ?? 0) - (a.ms.vol ?? a.ms.ops ?? 0)).slice(0, 3).map((m) => m.tick)
			an.cmp = new Set([tick, ...top3])
		}
		const cmp = axis.length ? compareChart(markets, axis) : { html: waiting(), controls: '', sub: '', bind() {} }
		const shares = markets.some((m) => m.ms.vol) ? shareBars('anShare', markets.map((m) => ({ tick: m.tick, name: m.name, vol: m.ms.vol, prevVol: m.ms.prevVol })), tick) : { html: waiting(volSince()), bind() {} }
		const premRows = markets.filter((m) => m.ms.premium != null).map((m) => ({ tick: m.tick, name: m.name, cur: m.ms.premium, prev: m.ms.prevPremium, ref: REF_NAME[m.tick] ?? tl('ana.refUsd') }))
		const prems = premRows.length ? premiumBars('anPrem', premRows, tick) : { html: waiting(), bind() {} }
		// Entre mercados: los últimos 7 días de cada uno
		const table = state.overview
			.map((m) => {
				const ms = summary(m.tick, 'last7')
				const ch = ms.close != null && ms.prevClose ? ms.close / ms.prevClose - 1 : null
				const vc = ms.vol != null && ms.prevVol ? ms.vol / ms.prevVol - 1 : null
				const last = ms.cur.filter((x) => x.rate != null).at(-1)
				const v = last ? vsInformal(m.tick, last.rate, informalOn(last.day)) : null
				const cell = (x, f) => (x == null ? '<td class="num muted">—</td>' : `<td class="num ${tone(x)}">${f(x)}</td>`)
				return `<tr class="${m.tick === tick ? 'on' : ''}"><td>${esc(TPI18N.coin(m.tick, m.name))}</td><td class="num">${ms.close == null ? '—' : `${fmtP(ms.close)} <small>${esc(m.unit)}</small>`}</td>${cell(ch, signPct)}<td class="num">${ms.vol == null ? '—' : usdK(ms.vol)}</td>${cell(vc, signPct)}${v == null ? '<td class="num muted">—</td>' : `<td class="num">${signPct(v)}</td>`}</tr>`
			})
			.join('')
		const end = addDays(s.to, -1) < an.data.today ? addDays(s.to, -1) : an.data.today
		const heatTabs = `<div class="seg-tabs an-heattabs" role="tablist">${[
			['bid', tl('ana.heatBid')],
			['vol', tl('ana.heatVol')],
		]
			.map(([k, l]) => `<button class="seg-tab ${an.heat === k ? 'active' : ''}" data-an-heat="${k}" role="tab">${l}</button>`)
			.join('')}</div>`
		return {
			html: `<div class="an-head">
				<div><p class="an-brand">Terminal P2P · terminalp2p.com</p><h3>${tl('ana.title')}<span class="an-market"> · ${esc(nameOf(tick))}</span></h3><p class="muted"><span class="an-market">${label} · </span>${dShort(axis[0] ?? s.from)} – ${dShort(end)}${since} · ${tl('ana.computedAt', { when: cubaFmt(an.data.at, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }) })}</p></div>
				<div class="an-tools"><button class="btn an-pdfbtn" id="anPdf" title="${tl('ana.pdfTitle')}">${ICON_SHARE} PDF</button><select class="input an-coin" id="anCoin" aria-label="${tl('ana.market')}">${state.overview.map((m) => `<option value="${esc(m.tick)}" ${m.tick === tick ? 'selected' : ''}>${esc(TPI18N.coin(m.tick, m.name))}</option>`).join('')}</select></div>
			</div>
			<div class="seg-tabs an-periods" role="tablist">${PERIODS.map(([k, l]) => `<button class="seg-tab ${an.period === k ? 'active' : ''}" data-an-period="${k}" role="tab">${l}</button>`).join('')}</div>
			${s.rated || s.vol != null ? `<div class="an-kpis">${kpis}</div>` : waiting(tl('ana.noPeriodData', { day: dShort(firstDay()) }))}
			<section class="an-box"><h4>${tl('ana.hWords')}</h4>${words.length ? `<ul class="an-words">${words.map((w) => `<li>${w}</li>`).join('')}</ul>` : waiting()}</section>
			<section class="an-box"><h4>${cup ? tl('ana.hRateVsUsdt') : tl('ana.mIdx')} <small>${tl('ana.hRateSub', { unit: esc(unit) })}</small></h4>${lines.html}</section>
			<section class="an-box"><h4>${tl('ana.hVol')} <small>${tl('ana.estimated')}</small></h4>${vols.html}</section>
			<section class="an-box"><div class="an-boxhead"><h4>${tl('ana.hHours')} <small>${tl('ana.hHoursSub')}</small></h4>${heatTabs}</div>${heat.html}</section>
			<section class="an-box"><h4>${tl('ana.hBook')}${book.when ? ` <small>${book.when}</small>` : ''}</h4>${book.html}</section>
			<section class="an-box an-cmp"><h4>${tl('ana.hCompare')}${cmp.sub ? ` <small>${cmp.sub}</small>` : ''}</h4>
				${cmp.controls}
				${cmp.html}
			</section>
			<div class="an-two">
				<section class="an-box"><h4>${tl('ana.hShare')}</h4>${shares.html}</section>
				<section class="an-box"><h4>${tl('ana.mPrem')} <small>${tl('ana.periodAvg')}</small></h4>${prems.html}<p class="muted small an-note">${tl('ana.premNote')}</p></section>
			</div>
			<section class="an-box"><h4>${tl('ana.hAcross')} <small>${tl('ana.last7Low')}</small></h4>
				<div class="an-table"><table><thead><tr><th>${tl('ana.market')}</th><th class="num">${tl('ana.mIdx')}</th><th class="num">${tl('ana.th7d')}</th><th class="num">${tl('ana.kVol')}</th><th class="num">${tl('ana.thVolVs')}</th><th class="num">${tl('ana.thVsTq')}</th></tr></thead><tbody>${table}</tbody></table></div>
			</section>
			<p class="muted small">${tl('ana.disclaimer')}</p>`,
			bind() {
				lines.bind()
				vols.bind()
				heat.bind()
				cmp.bind()
				shares.bind()
				prems.bind()
			},
		}
	}

	// Vuelve a pintar sin perder por dónde iba
	function redraw() {
		const y = document.querySelector('.modal')?.scrollTop
		view()
		const box = document.querySelector('.modal')
		if (box && y !== undefined) box.scrollTop = y
	}
	const closeAn = () => {
		document.querySelector('.modal-card')?.classList.remove('an-wide')
		tip(null)
	}
	function view() {
		const b = build()
		openModal(`<div class="an">${b.html}</div>`, closeAn)
		document.querySelector('.modal-card').classList.add('an-wide')
		b.bind()
		for (const el of document.querySelectorAll('[data-an-cmp]'))
			el.addEventListener('click', () => {
				const k = el.dataset.anCmp
				if (an.cmp.has(k)) {
					if (an.cmp.size > 1) an.cmp.delete(k)
				} else if (an.cmp.size < CMP_MAX) an.cmp.add(k)
				redraw()
			})
		for (const el of document.querySelectorAll('[data-an-grp]'))
			el.addEventListener('click', () => {
				const k = el.dataset.anGrp
				an.groups.has(k) ? an.groups.delete(k) : an.groups.add(k)
				redraw()
			})
		for (const el of document.querySelectorAll('[data-an-measure]'))
			el.addEventListener('click', () => {
				an.measure = el.dataset.anMeasure
				redraw()
			})
		for (const el of document.querySelectorAll('[data-an-heat]'))
			el.addEventListener('click', () => {
				an.heat = el.dataset.anHeat
				redraw()
			})
		$('anSmooth')?.addEventListener('change', (e) => {
			an.smooth = Number(e.target.value)
			redraw()
		})
		$('anCoin').addEventListener('change', (e) => {
			an.tick = e.target.value
			if (an.cmp.size < CMP_MAX) an.cmp.add(an.tick)
			view()
		})
		for (const el of document.querySelectorAll('[data-an-period]'))
			el.addEventListener('click', () => {
				an.period = el.dataset.anPeriod
				view()
			})
		$('anPdf').addEventListener('click', (e) => sharePdf(e.currentTarget))
	}

	// El informe lo rehace el servidor cada madrugada y su foto del libro cada hora: aquí se guarda unos minutos
	const FRESH_MS = 5 * 60_000
	let loadedAt = 0
	async function open() {
		const pro = window.TPPro
		if (!pro?.active || !pro?.license) {
			openModal(`<div class="stack"><h3>${tl('ana.title')}</h3><p class="muted">${tl('ana.proOnly')}</p><button class="btn primary block" id="anPro">${tl('ana.seePro')}</button></div>`)
			$('anPro').onclick = () => {
				closeModal()
				showPro()
			}
			return
		}
		if (an.data && Date.now() - loadedAt < FRESH_MS) return view()
		openModal(`<p class="muted">${tl('ana.loading')}</p>`, closeAn)
		try {
			const r = await fetch(`/data/analysis?l=${encodeURIComponent(pro.license)}`, { cache: 'no-store' })
			if (r.status === 503) throw new Error('wait')
			if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `${r.status}`)
			an.data = await r.json()
			loadedAt = Date.now()
			coinCache.clear()
			infMemo.clear()
		} catch (e) {
			$('modalBody').innerHTML = `<div class="stack"><h3>${tl('ana.title')}</h3>${e.message === 'wait' ? waiting(tl('ana.firstReport')) : `<p class="muted">${tl('ana.loadError', { error: esc(e.message) })}</p>`}</div>`
			return
		}
		view()
	}

	// ── Compartir todo en PDF ──────────────────────────────────────────
	// Se arma la vista entera en claro y a lo ancho, fuera de la pantalla; cada bloque pasa a imagen y se coloca en
	// páginas A4 sin partirlo. Las dos librerías (vendor/) solo se cargan al pedir el PDF
	const loadScript = (src) =>
		new Promise((ok, ko) => {
			if (document.querySelector(`script[src="${src}"]`)) return ok()
			const el = Object.assign(document.createElement('script'), { src, onload: ok, onerror: () => ko(new Error(src)) })
			document.head.append(el)
		})
	async function sharePdf(btn) {
		const label = btn.innerHTML
		btn.disabled = true
		btn.textContent = tl('ana.preparing')
		let box = null
		try {
			await Promise.all([loadScript('/vendor/jspdf.js'), loadScript('/vendor/html-to-image.js')])
			an.print = true
			let b
			try {
				b = build()
			} finally {
				an.print = false
			}
			box = Object.assign(document.createElement('div'), { className: 'an an-pdf' })
			box.innerHTML = b.html
			document.body.append(box)
			await document.fonts.ready
			const { jsPDF } = window.jspdf
			const doc = new jsPDF({ unit: 'pt', format: 'a4' })
			const PW = doc.internal.pageSize.getWidth()
			const PH = doc.internal.pageSize.getHeight()
			const M = 30
			const BOTTOM = PH - M - 12
			const fontEmbedCSS = await htmlToImage.getFontEmbedCSS(box)
			let y = M
			for (const el of box.children) {
				if (!el.offsetHeight) continue
				const img = await htmlToImage.toJpeg(el, { quality: 0.9, pixelRatio: 2, backgroundColor: '#ffffff', fontEmbedCSS })
				let w = PW - 2 * M
				let h = (el.offsetHeight * w) / el.offsetWidth
				// Un bloque más alto que la página se encoge para caber entero
				if (h > BOTTOM - M) {
					w *= (BOTTOM - M) / h
					h = BOTTOM - M
				}
				if (y + h > BOTTOM && y > M) {
					doc.addPage()
					y = M
				}
				doc.addImage(img, 'JPEG', M, y, w, h)
				y += h + 9
			}
			const pages = doc.getNumberOfPages()
			const when = cubaFmt(nowMs(), { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
			for (let i = 1; i <= pages; i++) {
				doc.setPage(i)
				doc.setFontSize(7.5)
				doc.setTextColor(120)
				doc.text(tl('ana.generatedAt', { when }), M, PH - 16)
				doc.text(`terminalp2p.com · ${i}/${pages}`, PW - M, PH - 16, { align: 'right' })
			}
			const name = `${tl('ana.fileName')}-${an.tick.toLowerCase()}-${an.period}-${cubaDate(nowMs())}.pdf`
			const file = new File([doc.output('blob')], name, { type: 'application/pdf' })
			const market = nameOf(an.tick)
			if (navigator.canShare?.({ files: [file] })) {
				try {
					await navigator.share({ files: [file], title: tl('ana.shareTitle', { market }), text: tl('ana.shareText', { market }) })
					return
				} catch (e) {
					if (e.name === 'AbortError') return
				}
			}
			const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(file), download: name })
			document.body.append(a)
			a.click()
			a.remove()
			setTimeout(() => URL.revokeObjectURL(a.href), 30_000)
		} catch (e) {
			toast(tl('ana.pdfError', { error: e.message ?? e }), true)
		} finally {
			box?.remove()
			btn.disabled = false
			btn.innerHTML = label
		}
	}

	// El botón, al final de las pestañas de la lectura del mercado
	const tabs = document.querySelector('.area-insights .seg-tabs')
	if (!tabs) return
	const btn = Object.assign(document.createElement('button'), { className: 'seg-tab an-open', textContent: tl('ana.button'), hidden: $('proBtn')?.hidden ?? true })
	btn.addEventListener('click', () => {
		an.tick = state.coin
		an.cmp = null
		open()
	})
	tabs.append(btn)
})()
