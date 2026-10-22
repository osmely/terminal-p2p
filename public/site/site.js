// Landing de Terminal P2P: tema claro/oscuro y tasas de hoy desde la API pública de QvaPay
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
		const r = await fetch('/qp/p2p/averages', { headers: { Accept: 'application/json' } })
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

loadRates()
// Solo con la pestaña visible; el relé las cachea 60 s en el borde
setInterval(() => !document.hidden && loadRates(), 60_000)
