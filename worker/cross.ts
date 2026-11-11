// Comparador entre exchanges (experimental, solo en staging): los anuncios P2P de USDT de cada exchange para una
// moneda, todos con la misma forma, para ponerlos lado a lado. Se lee la lista pública de anuncios de cada uno (la que
// ve cualquiera en su web sin cuenta): solo lectura, sin claves y sin nada de ningún usuario.
//
// Los dos lados se nombran desde quien mira, como en el libro del terminal: «ask» son los anuncios que VENDEN USDT (ahí
// compras; el mejor es el más barato) y «bid» los que COMPRAN USDT (ahí vendes; el mejor es el más caro)

export const CROSS_FIATS = ['VES', 'ARS', 'COP', 'MXN', 'BRL', 'PEN', 'CLP', 'BOB'] as const
export type CrossFiat = (typeof CROSS_FIATS)[number]
export const isCrossFiat = (x: unknown): x is CrossFiat => typeof x === 'string' && (CROSS_FIATS as readonly string[]).includes(x)

export type CrossSideName = 'ask' | 'bid'
export interface CrossAd {
	price: number
	// USDT que le quedan al anuncio
	usdt: number | null
	// Límites por operación, en la moneda
	min: number | null
	max: number | null
	user: string
	// Operaciones recientes (30 días) y cuántas completó, de 0 a 1
	orders: number | null
	rate: number | null
	pays: string[]
}
export interface CrossSide {
	// Anuncios que dice tener el exchange en ese lado (si no lo dice, los que mandó)
	total: number
	ads: CrossAd[]
}
export interface CrossExchange {
	id: string
	name: string
	// false: el exchange no respondió o cambió su formato (los lados van vacíos)
	ok: boolean
	// Por qué no respondió (el código HTTP, «tiempo agotado» o «formato»), para ver desde fuera qué bloquea cada uno
	why?: string
	ask: CrossSide
	bid: CrossSide
}
export interface CrossBook {
	fiat: CrossFiat
	at: number
	exchanges: CrossExchange[]
}

const ADS = 20
const TIMEOUT_MS = 7000
const UA = 'Mozilla/5.0 (compatible; TerminalP2P/1.0; +https://terminalp2p.com)'

const num = (x: unknown): number | null => {
	const n = typeof x === 'number' ? x : typeof x === 'string' && x.trim() !== '' ? Number(x) : NaN
	return Number.isFinite(n) ? n : null
}
const pos = (x: unknown) => {
	const n = num(x)
	return n !== null && n > 0 ? n : null
}
// Lo que escriben otros (nombres, métodos de pago) va recortado y sin caracteres de control; el navegador lo pinta
// como texto, nunca como HTML
const text = (x: unknown, max = 40) =>
	String(typeof x === 'string' || typeof x === 'number' ? x : '')
		.replace(/[\u0000-\u001f\u007f]/g, ' ')
		.trim()
		.slice(0, max)
const list = (x: unknown): unknown[] => (Array.isArray(x) ? x : [])
const obj = (x: unknown): Record<string, unknown> => (x && typeof x === 'object' ? (x as Record<string, unknown>) : {})
const pays = (names: unknown[]) => [...new Set(names.map((n) => text(n)).filter(Boolean))].slice(0, 6)
// De 0 a 1, venga como 0.95, «0.95», 95 o «95»
const ratio = (x: unknown) => {
	const n = num(x)
	if (n === null || n < 0) return null
	return n > 1 ? Math.min(1, n / 100) : n
}

// Un anuncio que no deja operar ni 10 USDT de una vez (o al que le quedan menos) no es un precio de verdad: suelen ser
// cebos con un precio muy bueno y un tope mínimo, y se tomarían por el mejor del libro
export const MIN_USDT = 10
const usable = (a: CrossAd) => (a.max === null || a.max / a.price >= MIN_USDT) && (a.usdt === null || a.usdt >= MIN_USDT)

// Ordenado por precio (el mejor primero) y recortado: un anuncio destacado no cuenta como el mejor por ir arriba
export function sideOf(side: CrossSideName, ads: (CrossAd | null)[], total: unknown): CrossSide {
	const ok = ads.filter((a): a is CrossAd => !!a && a.price > 0 && usable(a))
	ok.sort((a, b) => (side === 'ask' ? a.price - b.price : b.price - a.price))
	return { total: Math.max(Math.round(num(total) ?? 0), ok.length), ads: ok.slice(0, ADS) }
}

const ad = (price: unknown, rest: Omit<CrossAd, 'price'>): CrossAd | null => {
	const p = pos(price)
	return p === null ? null : { price: p, ...rest }
}

export function parseBinance(side: CrossSideName, body: unknown): CrossSide {
	const j = obj(body)
	if (!Array.isArray(j.data)) throw new Error('formato')
	return sideOf(
		side,
		j.data.map((x) => {
			const a = obj(obj(x).adv)
			const u = obj(obj(x).advertiser)
			return ad(a.price, {
				usdt: pos(a.tradableQuantity) ?? pos(a.surplusAmount),
				min: pos(a.minSingleTransAmount),
				max: pos(a.dynamicMaxSingleTransAmount) ?? pos(a.maxSingleTransAmount),
				user: text(u.nickName),
				orders: num(u.monthOrderCount),
				rate: ratio(u.monthFinishRate),
				pays: pays(list(a.tradeMethods).map((m) => obj(m).tradeMethodName ?? obj(m).identifier)),
			})
		}),
		j.total,
	)
}

export function parseBybit(side: CrossSideName, body: unknown): CrossSide {
	const r = obj(obj(body).result)
	if (!Array.isArray(r.items)) throw new Error('formato')
	return sideOf(
		side,
		r.items.map((x) => {
			const a = obj(x)
			// Los métodos de pago vienen como números de su catálogo: sin nombres no se enseñan
			return ad(a.price, { usdt: pos(a.lastQuantity), min: pos(a.minAmount), max: pos(a.maxAmount), user: text(a.nickName), orders: num(a.recentOrderNum), rate: ratio(a.recentExecuteRate), pays: [] })
		}),
		r.count,
	)
}

export function parseOkx(side: CrossSideName, body: unknown): CrossSide {
	const d = obj(obj(body).data)
	const rows = d[side === 'ask' ? 'sell' : 'buy']
	if (!Array.isArray(rows)) throw new Error('formato')
	return sideOf(
		side,
		rows.map((x) => {
			const a = obj(x)
			return ad(a.price, {
				usdt: pos(a.availableAmount),
				min: pos(a.quoteMinAmountPerOrder),
				max: pos(a.quoteMaxAmountPerOrder),
				user: text(a.nickName),
				orders: num(a.completedOrderQuantity),
				rate: ratio(a.completedRate),
				pays: pays(list(a.paymentMethods)),
			})
		}),
		rows.length,
	)
}

export function parseBitget(side: CrossSideName, body: unknown): CrossSide {
	const d = obj(obj(body).data)
	if (!Array.isArray(d.dataList)) throw new Error('formato')
	return sideOf(
		side,
		d.dataList.map((x) => {
			const a = obj(x)
			return ad(a.price, {
				usdt: pos(a.lastAmount),
				min: pos(a.minAmount),
				max: pos(a.maxAmount),
				user: text(a.nickName),
				orders: num(a.thirtyTunoverNum),
				rate: ratio(a.thirtyCompletionRate),
				pays: pays(list(a.paymethodInfo).map((m) => obj(m).paymethodName)),
			})
		}),
		d.totalCount,
	)
}

export function parseMexc(side: CrossSideName, body: unknown): CrossSide {
	const j = obj(body)
	if (!Array.isArray(j.data)) throw new Error('formato')
	return sideOf(
		side,
		j.data.map((x) => {
			const a = obj(x)
			const s = obj(a.merchantStatistics)
			return ad(a.price, { usdt: pos(a.availableQuantity), min: pos(a.minTradeLimit), max: pos(a.maxTradeLimit), user: text(obj(a.merchant).nickName), orders: num(s.doneLastMonthCount), rate: ratio(s.lastMonthCompleteRate), pays: [] })
		}),
		obj(j.page).total,
	)
}

interface Source {
	id: string
	name: string
	request(fiat: CrossFiat, side: CrossSideName): Request
	parse(side: CrossSideName, body: unknown): CrossSide
}

const post = (url: string, body: unknown) => new Request(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', 'user-agent': UA }, body: JSON.stringify(body) })
const get = (url: string) => new Request(url, { headers: { accept: 'application/json', 'user-agent': UA } })
// El USDT en el catálogo de MEXC
const MEXC_USDT = '128f589271cb4951b03e71e6323eb7be'

export const SOURCES: Source[] = [
	{
		id: 'binance',
		name: 'Binance',
		request: (fiat, side) => post('https://p2p.binance.com/bapi/c2c/v2/friendly/c2c/adv/search', { fiat, page: 1, rows: ADS, tradeType: side === 'ask' ? 'BUY' : 'SELL', asset: 'USDT', countries: [], payTypes: [] }),
		parse: parseBinance,
	},
	{
		id: 'bybit',
		name: 'Bybit',
		request: (fiat, side) => post('https://api2.bybit.com/fiat/otc/item/online', { tokenId: 'USDT', currencyId: fiat, payment: [], side: side === 'ask' ? '1' : '0', size: String(ADS), page: '1' }),
		parse: parseBybit,
	},
	{
		id: 'okx',
		name: 'OKX',
		request: (fiat, side) =>
			get(`https://www.okx.com/v3/c2c/tradingOrders/books?quoteCurrency=${fiat}&baseCurrency=USDT&side=${side === 'ask' ? 'sell' : 'buy'}&paymentMethod=all&userType=all&showTrade=false&showFollow=false&showAlreadyTraded=false&isAbleFilter=false&receivingAds=false`),
		parse: parseOkx,
	},
	{
		id: 'bitget',
		name: 'Bitget',
		request: (fiat, side) => post('https://www.bitget.com/v1/p2p/pub/adv/queryAdvList', { side: side === 'ask' ? 1 : 2, pageNo: 1, pageSize: ADS, coinCode: 'USDT', fiatCode: fiat, languageType: 0 }),
		parse: parseBitget,
	},
	{
		id: 'mexc',
		name: 'MEXC',
		request: (fiat, side) => get(`https://p2p.mexc.com/api/market?allowTrade=false&amount=&blockTrade=false&coinId=${MEXC_USDT}&countryCode=&currency=${fiat}&follow=false&haveTrade=false&page=1&payMethod=&tradeType=${side === 'ask' ? 'SELL' : 'BUY'}`),
		parse: parseMexc,
	},
]

const EMPTY: CrossSide = { total: 0, ads: [] }

async function readSide(src: Source, fiat: CrossFiat, side: CrossSideName, fetcher: typeof fetch): Promise<CrossSide> {
	const res = await fetcher(src.request(fiat, side), { signal: AbortSignal.timeout(TIMEOUT_MS) })
	if (!res.ok) throw new Error(`HTTP ${res.status}`)
	// Algunos contestan 200 con una página de bloqueo en vez de JSON
	if (!(res.headers.get('content-type') ?? '').includes('json')) throw new Error(`HTTP ${res.status} sin JSON`)
	return src.parse(side, await res.json())
}

const reason = (e: unknown) => {
	const m = (e as Error)?.message ?? ''
	if ((e as Error)?.name === 'TimeoutError') return 'tiempo agotado'
	if (/^HTTP /.test(m)) return m
	return 'formato'
}

// Los cinco a la vez; el que falla sale con ok: false y no tumba a los demás
export async function crossBook(fiat: CrossFiat, fetcher: typeof fetch = fetch, now = Date.now()): Promise<CrossBook> {
	const exchanges = await Promise.all(
		SOURCES.map(async (src): Promise<CrossExchange> => {
			const [ask, bid] = await Promise.allSettled([readSide(src, fiat, 'ask', fetcher), readSide(src, fiat, 'bid', fetcher)])
			const ok = ask.status === 'fulfilled' || bid.status === 'fulfilled'
			const fail = [ask, bid].find((r) => r.status === 'rejected') as PromiseRejectedResult | undefined
			const why = ok ? undefined : reason(fail?.reason)
			return { id: src.id, name: src.name, ok, ...(why ? { why } : {}), ask: ask.status === 'fulfilled' ? ask.value : EMPTY, bid: bid.status === 'fulfilled' ? bid.value : EMPTY }
		}),
	)
	return { fiat, at: now, exchanges }
}
