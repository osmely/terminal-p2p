// Landing y blog de Terminal P2P: tema claro/oscuro y tasas de hoy desde la API pública de QvaPay
// (vía el relé del propio dominio, cacheado en el borde: sin token y sin datos de nadie).
const $ = (id) => document.getElementById(id)

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
const fmt = (p) => (p > 0 ? p.toLocaleString('es', { minimumFractionDigits: decimals(p), maximumFractionDigits: decimals(p) }) : '—')
const pick = (a, median, average) => (a[median] > 0 ? a[median] : a[average] > 0 ? a[average] : 0)
const period = (h) => (h >= 48 && h % 24 === 0 ? `${h / 24} días` : `${h} h`)

async function loadRates() {
	try {
		const r = await fetch('/qp/p2p/averages', { headers: { Accept: 'application/json' }, cache: 'no-cache' })
		if (!r.ok) throw new Error(String(r.status))
		const data = await r.json()
		const cards = MARKETS.filter(([tick]) => data[tick]?.count > 0).map(([tick, name, unit]) => {
			const a = data[tick]
			return `<article class="rate">
				<h3>${name}</h3><div class="unit">${unit} por USD de QvaPay</div>
				<div class="px"><span>Venta</span><b class="ask">${fmt(pick(a, 'median_sell', 'average_sell'))}</b><span>Compra</span><b class="bid">${fmt(pick(a, 'median_buy', 'average_buy'))}</b></div>
				<div class="ops">${a.count.toLocaleString('es')} operaciones en ${period(a.window_hours ?? 24)}</div>
			</article>`
		})
		if (!cards.length) throw new Error('vacío')
		$('rates').innerHTML = cards.join('')
		$('ratesSrc').textContent = `Fuente: API pública de QvaPay · actualizado a las ${new Date().toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' })}`
	} catch {
		if ($('rates').querySelector('.rate:not(.skeleton)')) return // se quedan las últimas que se vieron
		$('rates').innerHTML = ''
		$('ratesSrc').textContent = 'No se pudieron cargar las tasas ahora mismo. Ábrelas en el terminal.'
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
			const chg = Math.abs(d) >= 0.0005 ? `<i class="${d > 0 ? 'up' : 'down'}" title="Respecto al día anterior">${d > 0 ? '+' : ''}${(d * 100).toFixed(1)}%</i>` : ''
			return `<div class="inf"><span>${label}</span>${chg}<b>${fmt(last[k])}</b></div>`
		})
		if (!cells.length) return
		$('infRow').innerHTML = cells.join('')
		$('informal').hidden = false
	} catch {}
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
		img.alt = b.dataset.alt
	})

// Las tasas solo están en la portada (el blog comparte este script)
if ($('rates')) {
	loadRates()
	// Solo con la pestaña visible; el relé las cachea 60 s en el borde
	setInterval(() => !document.hidden && loadRates(), 60_000)
}
if ($('informal')) loadInformal()

// El menú de ayuda se cierra al tocar fuera o con Escape
document.addEventListener('click', (e) => {
	for (const d of document.querySelectorAll('details.help[open]')) if (!d.contains(e.target)) d.open = false
})
document.addEventListener('keydown', (e) => {
	if (e.key === 'Escape') for (const d of document.querySelectorAll('details.help[open]')) d.open = false
})
