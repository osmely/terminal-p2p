// La página «Tasa del USD en QvaPay hoy» (terminalp2p.com/tasa-usd-qvapay-hoy/): el HTML lleva los números ya puestos
// desde lo último guardado en el KV (la tasa de cada mercado cada 10 min y elTOQUE), para que los buscadores y las vistas
// previas de Telegram vean la tasa sin ejecutar nada. La gráfica la dibuja el navegador con /data/rates

import { COINS } from '../src/terminal/market.ts'
import { cubaOffset, type D1 } from './rates.ts'
import { latestInformal } from './informal.ts'

export const TASA_PATH = '/tasa-usd-qvapay-hoy/'
// El cron la deja calculada aquí cada 10 min, al guardar la tasa: las visitas solo leen esto, no tocan la base
export const TASA_KEY = 'tasa/latest'
const DAY_MS = 86_400_000
// Más vieja que esto, la página no presume de «hoy»: enseña lo que hay con su hora
const FRESH_MS = 3 * 3600_000

interface Row {
	coin: string
	t: number
	median: number | null
	median_buy: number | null
	median_sell: number | null
	avg_buy: number | null
	avg_sell: number | null
	count: number | null
	window_h: number | null
}

export interface TasaData {
	t: number
	markets: { tick: string; name: string; unit: string; median: number | null; buy: number | null; sell: number | null; count: number; windowH: number }[]
	cup: { median: number; buy: number | null; sell: number | null; count: number; windowH: number; d1: number | null; d7: number | null }
	informal: { day: string; usd: number | null; usdt: number | null; eur: number | null; mlc: number | null } | null
}

async function medianAt(db: D1, t: number) {
	return (await db.prepare("SELECT median FROM rates WHERE coin = 'BANK_CUP' AND t <= ? AND median IS NOT NULL ORDER BY t DESC LIMIT 1").bind(t).first<{ median: number }>())?.median ?? null
}

// Lo último de cada mercado: con «coin IN (...) AND t = ?» cada fila sale por la clave (coin, t)
export async function tasaData(db: D1, now = Date.now()): Promise<TasaData | null> {
	const last = await db.prepare("SELECT MAX(t) AS t FROM rates WHERE coin = 'BANK_CUP' AND median IS NOT NULL").first<{ t: number | null }>()
	if (!last?.t) return null
	const ticks = COINS.map((c) => c.tick)
	const { results } = await db
		.prepare(`SELECT coin, t, median, median_buy, median_sell, avg_buy, avg_sell, count, window_h FROM rates WHERE coin IN (${ticks.map(() => '?').join(',')}) AND t = ?`)
		.bind(...ticks, last.t)
		.all<Row>()
	const by = new Map(results.map((r) => [r.coin, r]))
	const cup = by.get('BANK_CUP')
	if (!cup?.median) return null
	const [d1, d7, inf] = await Promise.all([medianAt(db, last.t - DAY_MS), medianAt(db, last.t - 7 * DAY_MS), latestInformal(db, now)])
	const markets = COINS.map((c) => {
		const r = by.get(c.tick)
		return {
			tick: c.tick,
			name: c.name,
			unit: c.unit,
			median: r?.median ?? null,
			buy: r?.median_buy ?? r?.avg_buy ?? null,
			sell: r?.median_sell ?? r?.avg_sell ?? null,
			count: r?.count ?? 0,
			windowH: r?.window_h ?? 24,
		}
	}).filter((m) => m.count > 0 && (m.median || m.buy || m.sell))
	const l = inf.last
	return {
		t: last.t,
		markets,
		cup: { median: cup.median, buy: cup.median_buy ?? cup.avg_buy, sell: cup.median_sell ?? cup.avg_sell, count: cup.count ?? 0, windowH: cup.window_h ?? 24, d1, d7 },
		informal: l ? { day: l.day, usd: l.usd ?? null, usdt: l.usdt ?? null, eur: l.eur ?? null, mlc: l.mlc ?? null } : null,
	}
}

const decimals = (p: number) => (p >= 100 ? 2 : 4)
const fmt = (n: number, d = 0) => n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })
const px = (p: number | null) => (p && p > 0 ? fmt(p, decimals(p)) : '—')
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
const period = (h: number) => (h >= 48 && h % 24 === 0 ? `${h / 24} días` : `${h} h`)
const cuba = (t: number) => new Date(t + cubaOffset(t))
const dayLong = (t: number) => cuba(t).toLocaleDateString('es', { timeZone: 'UTC', day: 'numeric', month: 'long', year: 'numeric' })
const dayShort = (t: number) => cuba(t).toLocaleDateString('es', { timeZone: 'UTC', day: 'numeric', month: 'long' })
const hour = (t: number) => cuba(t).toLocaleTimeString('es', { timeZone: 'UTC', hour: '2-digit', minute: '2-digit' })
const change = (now: number, before: number | null, label: string) => {
	if (!before) return ''
	const d = now / before - 1
	const cls = Math.abs(d) < 0.0005 ? 'flat' : d > 0 ? 'up' : 'down'
	return `<span class="chg ${cls}">${d > 0 ? '+' : ''}${fmt(d * 100, 1)}% <small>${label}</small></span>`
}

// Lo que cambia de la página con los datos: los textos de [data-tasa="…"], el título y la descripción
export function tasaFill(d: TasaData, now = Date.now()) {
	const c = d.cup
	const stale = now - d.t > FRESH_MS
	const rate = fmt(c.median)
	const inf = d.informal
	const gap = inf?.usd ? c.median / inf.usd - 1 : null
	const gapUsdt = inf?.usdt ? c.median / inf.usdt - 1 : null
	const title = `Tasa del USD en QvaPay hoy: ${rate} CUP (${dayShort(d.t)}) · Terminal P2P`
	const description = `1 USD de saldo QvaPay se paga a ${rate} CUP por transferencia, según las operaciones cerradas en el P2P en las últimas 24 h${
		inf?.usd ? `. El dólar en efectivo, ${fmt(inf.usd)} CUP (elTOQUE)` : ''
	}. Compra, venta y el resto de mercados, actualizado cada 10 minutos.`
	const cards = d.markets
		.filter((m) => m.tick !== 'BANK_CUP')
		.map(
			(m) => `<article class="rate">
				<h3>${esc(m.name)}</h3><div class="unit">${esc(m.unit)} por USD de QvaPay</div>
				<div class="px"><span>Venta</span><b class="ask">${px(m.sell)}</b><span>Compra</span><b class="bid">${px(m.buy)}</b></div>
				<div class="ops">${fmt(m.count)} operaciones en ${period(m.windowH)}</div>
			</article>`,
		)
		.join('')
	const infCells = inf
		? (
				[
					['USD', inf.usd],
					['USDT', inf.usdt],
					['EUR', inf.eur],
					['MLC', inf.mlc],
				] as const
			)
				.filter(([, v]) => v && v > 0)
				.map(([k, v]) => `<div class="inf"><span>${k}</span><b>${fmt(v!)}</b></div>`)
				.join('')
		: ''
	const vs = gap == null ? '' : `El saldo de QvaPay se paga un <b>${fmt(Math.abs(gap) * 100, 0)}% ${gap >= 0 ? 'por encima' : 'por debajo'}</b> del dólar en efectivo${
		gapUsdt == null ? '' : ` y ${Math.abs(gapUsdt) < 0.005 ? 'casi igual que el USDT' : `un ${fmt(Math.abs(gapUsdt) * 100, 0)}% ${gapUsdt >= 0 ? 'por encima' : 'por debajo'} del USDT`}`
	}.`
	const answer = `Hoy, ${dayLong(d.t)}, 1 USD de saldo QvaPay se paga a ${rate} CUP por transferencia: es la mediana de las ${fmt(c.count)} operaciones cerradas en el P2P de QvaPay en las últimas ${period(c.windowH)}.${
		c.sell && c.buy ? ` Quien compró USD pagó ${px(c.sell)} CUP y quien vendió recibió ${px(c.buy)} CUP (medianas).` : ''
	}`
	return {
		title,
		description,
		text: {
			rate,
			date: stale ? `${dayLong(d.t)}, ${hour(d.t)}` : `${dayLong(d.t)}`,
			updated: `Actualizado a las ${hour(d.t)} (hora de Cuba)${stale ? ' · sin datos más recientes ahora mismo' : ''}`,
			sell: px(c.sell),
			buy: px(c.buy),
			ops: `${fmt(c.count)} operaciones en ${period(c.windowH)}`,
			answer,
		},
		html: {
			changes: [change(c.median, c.d1, 'en 24 h'), change(c.median, c.d7, 'en 7 días')].join(''),
			markets: cards,
			informal: infCells,
			vs,
		},
		jsonld: JSON.stringify({
			'@context': 'https://schema.org',
			'@type': 'FAQPage',
			mainEntity: [
				{ '@type': 'Question', name: '¿A cuánto está el dólar en QvaPay hoy?', acceptedAnswer: { '@type': 'Answer', text: answer } },
				{
					'@type': 'Question',
					name: '¿Por qué la tasa de QvaPay es distinta a la de elTOQUE?',
					acceptedAnswer: {
						'@type': 'Answer',
						text: 'elTOQUE mide el dólar en efectivo a partir de ofertas publicadas en grupos y clasificados. La de QvaPay es el precio del saldo digital en operaciones que de verdad se cerraron, y se mueve más cerca del USDT que del efectivo.',
					},
				},
			],
		}).replace(/</g, '\\u003c'),
	}
}

export function tasaPage(res: Response, d: TasaData | null, now = Date.now()) {
	if (!d) return res
	const f = tasaFill(d, now)
	return new HTMLRewriter()
		.on('title', { element: (el) => void el.setInnerContent(f.title) })
		.on('meta[name="description"], meta[property="og:description"]', { element: (el) => void el.setAttribute('content', f.description) })
		.on('meta[property="og:title"]', { element: (el) => void el.setAttribute('content', f.title) })
		.on('script[data-tasa="jsonld"]', { element: (el) => void el.setInnerContent(f.jsonld, { html: true }) })
		// Sin elTOQUE (o staging, que no lo descarga) no se enseña su apartado vacío
		.on('[data-tasa-if="informal"]', { element: (el) => void (f.html.informal || el.remove()) })
		.on('[data-tasa]', {
			element: (el) => {
				const k = el.getAttribute('data-tasa') ?? ''
				if (k in f.text) el.setInnerContent(f.text[k as keyof typeof f.text])
				else if (k in f.html) el.setInnerContent(f.html[k as keyof typeof f.html], { html: true })
			},
		})
		.transform(res)
}
