import test from 'node:test'
import assert from 'node:assert/strict'
import { crossBook, isCrossFiat, parseBinance, parseBitget, parseBybit, parseMexc, parseOkx, SOURCES, sideOf } from '../worker/cross.ts'

test('cross: cada lado sale ordenado del mejor al peor y sin precios rotos', () => {
	const ad = (price: number, usdt: number | null = 100, max: number | null = null) => ({ price, usdt, min: null, max, user: 'u', orders: null, rate: null, pays: [] })
	assert.deepEqual(sideOf('ask', [ad(5), ad(3), null, ad(4), ad(0)], 10).ads.map((a) => a.price), [3, 4, 5])
	assert.deepEqual(sideOf('bid', [ad(5), ad(3), ad(4)], null).ads.map((a) => a.price), [5, 4, 3])
	// Sin total del exchange, cuenta los que mandó; nunca menos que esos
	assert.equal(sideOf('ask', [ad(1), ad(2)], undefined).total, 2)
	assert.equal(sideOf('ask', [ad(1), ad(2)], 1).total, 2)
	assert.equal(sideOf('ask', [ad(1)], '489').total, 489)
	// Un cebo: 1,100 VES por USDT pero como mucho 5,000 VES por operación (4.5 USDT), o con 3 USDT disponibles
	assert.deepEqual(sideOf('bid', [ad(1100, 5995, 5000), ad(1099, 3), ad(1076.8, 1500, 1_615_200), ad(1076, null, null)], 4).ads.map((a) => a.price), [1076.8, 1076])
})

test('cross: lee el formato de cada exchange', () => {
	const b = parseBinance('ask', {
		total: 489,
		data: [{ adv: { price: '1078.000', tradableQuantity: '204.90', minSingleTransAmount: '15000', maxSingleTransAmount: '4000000', dynamicMaxSingleTransAmount: '220890', tradeMethods: [{ tradeMethodName: 'Banco de Venezuela' }, { tradeMethodName: 'Banco de Venezuela' }] }, advertiser: { nickName: 'Ana\u0000<b>', monthOrderCount: 51, monthFinishRate: 0.98 } }],
	})
	assert.deepEqual(b, { total: 489, ads: [{ price: 1078, usdt: 204.9, min: 15000, max: 220890, user: 'Ana <b>', orders: 51, rate: 0.98, pays: ['Banco de Venezuela'] }] })

	const y = parseBybit('bid', { result: { count: 101, items: [{ price: '1075.000', lastQuantity: '100', minAmount: '5000', maxAmount: '63000', nickName: 'Em', recentOrderNum: 138, recentExecuteRate: 99, payments: ['302'] }] } })
	assert.equal(y.total, 101)
	assert.equal(y.ads[0].rate, 0.99)
	assert.deepEqual(y.ads[0].pays, [])

	const okx = { data: { sell: [{ price: '1079.8', availableAmount: '54.81', quoteMinAmountPerOrder: '900', quoteMaxAmountPerOrder: '59183.83', nickName: 'Bre', completedOrderQuantity: 89, completedRate: '1.0000', paymentMethods: ['Pago movil'] }], buy: [{ price: '1072', nickName: 'X' }] } }
	assert.equal(parseOkx('ask', okx).ads[0].price, 1079.8)
	assert.equal(parseOkx('bid', okx).ads[0].price, 1072)

	const g = parseBitget('ask', { data: { totalCount: 11, dataList: [{ price: '1083', lastAmount: '538.16', minAmount: '9000', maxAmount: '450000', nickName: 'Eb', thirtyTunoverNum: 147, thirtyCompletionRate: '0.95', paymethodInfo: [{ paymethodName: 'Pago Móvil' }] }] } })
	assert.deepEqual([g.total, g.ads[0].usdt, g.ads[0].rate, g.ads[0].pays], [11, 538.16, 0.95, ['Pago Móvil']])

	const m = parseMexc('ask', { page: { total: 20 }, data: [{ price: 1071, availableQuantity: 461.3, minTradeLimit: 51630, maxTradeLimit: 107100, merchant: { nickName: 'Pollo' }, merchantStatistics: { doneLastMonthCount: 97, lastMonthCompleteRate: '1.0000' } }] })
	assert.deepEqual([m.total, m.ads[0].user, m.ads[0].orders, m.ads[0].rate], [20, 'Pollo', 97, 1])

	// Un formato que cambió no se toma por un libro vacío: falla, y ese exchange sale como «no respondió»
	assert.throws(() => parseBinance('ask', { code: '000002', data: null }))
	assert.throws(() => parseOkx('ask', { data: {} }))
})

test('cross: un exchange que falla no tumba a los demás', async () => {
	const fetcher = (async (req: Request) => {
		const host = new URL(req.url).hostname
		if (host.includes('binance')) return Response.json({ total: 2, data: [{ adv: { price: '10' }, advertiser: {} }, { adv: { price: '9' }, advertiser: {} }] })
		if (host.includes('bybit')) return new Response('bloqueado', { status: 403 })
		if (host.includes('okx')) throw new Error('timeout')
		if (host.includes('bitget')) return Response.json({ code: 'x' })
		return Response.json({ data: [], page: { total: 0 } })
	}) as typeof fetch
	const r = await crossBook('VES', fetcher, 123)
	assert.equal(r.at, 123)
	assert.deepEqual(
		r.exchanges.map((e) => [e.id, e.ok]),
		[['binance', true], ['bybit', false], ['okx', false], ['bitget', false], ['mexc', true]],
	)
	assert.deepEqual(r.exchanges.map((e) => e.why ?? null), [null, 'HTTP 403', 'formato', 'formato', null])
	assert.deepEqual(r.exchanges[0].ask.ads.map((a) => a.price), [9, 10])
	assert.equal(r.exchanges[4].ask.total, 0)
})

test('cross: solo monedas conocidas, y cada exchange pide la moneda y el lado correctos', async () => {
	assert.ok(isCrossFiat('VES'))
	assert.ok(!isCrossFiat('CUP'))
	assert.ok(!isCrossFiat('ves'))
	for (const s of SOURCES) {
		const req = s.request('ARS', 'ask')
		const all = new URL(req.url).search + (req.body ? await req.text() : '')
		assert.match(all, /ARS/, s.id)
	}
	// Los lados al revés: «ask» son los anuncios que venden USDT
	const body = async (id: string, side: 'ask' | 'bid') => JSON.parse(await SOURCES.find((s) => s.id === id)!.request('VES', side).text())
	assert.equal((await body('binance', 'ask')).tradeType, 'BUY')
	assert.equal((await body('bybit', 'ask')).side, '1')
	assert.equal((await body('bitget', 'bid')).side, 2)
	assert.match(SOURCES.find((s) => s.id === 'okx')!.request('VES', 'ask').url, /side=sell/)
	assert.match(SOURCES.find((s) => s.id === 'mexc')!.request('VES', 'bid').url, /tradeType=BUY/)
})
