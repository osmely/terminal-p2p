import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cleanHistory, cleanQuote, historySource, isStock, isTimeframe, loadHistory, loadQuotes, marketStatus, STOCKS, trimHistory } from '../worker/stocks.ts'

test('acciones: solo las de la app de QvaPay y los intervalos que da su histórico', () => {
	assert.equal(STOCKS.length, 11)
	assert.ok(isStock('NVDA') && isStock('SPY'))
	for (const bad of ['nvda', 'XYZ', '', null, 'NVDA;']) assert.equal(isStock(bad), false)
	assert.ok(isTimeframe('1Y') && !isTimeframe('5Y') && !isTimeframe('toString'))
	// 1 mes sale del histórico de 1 año (los mismos puntos diarios); los demás, del suyo
	assert.equal(historySource('1M'), '1Y')
	for (const tf of ['1H', '24H', '1W', '1Y'] as const) assert.equal(historySource(tf), tf)
})

test('acciones: la cotización toma solo números válidos y sin precio no vale', () => {
	const q = cleanQuote('NVDA', { name: 'NVIDIA Corporation', price: '165.11', change: -4.96, changeDollar: -8.62, open: 150.99, high: 0, low: 'x', previousClose: 173.73, volume: 18067343, fiftyTwoWeekHigh: 243.37, fiftyTwoWeekLow: 148.8, ceo: '<script>' })
	assert.deepEqual(q, { symbol: 'NVDA', name: 'NVIDIA', fullName: 'NVIDIA Corporation', price: 165.11, change: -4.96, changeDollar: -8.62, open: 150.99, high: null, low: null, previousClose: 173.73, volume: 18067343, high52: 243.37, low52: 148.8, image: 'https://www.qvapay.com/img/stocks/NVDA.svg' })
	assert.equal(cleanQuote('NVDA', { price: 0 }), null)
	// El icono, solo si es de la carpeta de iconos de QvaPay
	assert.equal(cleanQuote('SPY', { price: 1, image: 'https://www.qvapay.com/img/stocks/SPY.svg' })?.image, 'https://www.qvapay.com/img/stocks/SPY.svg')
	for (const bad of ['https://evil.com/img/stocks/SPY.svg', 'http://www.qvapay.com/img/stocks/SPY.svg', 'https://www.qvapay.com/img/stocks/../x.svg', 'javascript:alert(1)', 42, undefined])
		assert.equal(cleanQuote('SPY', { price: 1, image: bad })?.image, '/stocks-ic/SPY.svg')
	// Las que tienen icono en QvaPay lo llevan aunque la respuesta no lo traiga (su cotización suelta no lo trae)
	assert.equal(cleanQuote('NVDA', { price: 1 })?.image, 'https://www.qvapay.com/img/stocks/NVDA.svg')
	assert.equal(cleanQuote('NVDA', { price: 1, image: 'https://evil.com/x.svg' })?.image, 'https://www.qvapay.com/img/stocks/NVDA.svg')
	assert.equal(cleanQuote('NVDA', null), null)
	assert.equal(cleanQuote('SPY', { price: 761.32 })?.fullName, 'S&P 500')
})

test('acciones: el histórico queda en orden, sin repetidos ni puntos rotos', () => {
	assert.deepEqual(cleanHistory([{ time: 30, value: 3 }, { time: 10, value: 1 }, { time: 20, value: -1 }, { time: 10, value: 1.5 }, { value: 4 }, 'x', { time: 40.7, value: '4' }]), [
		[10, 1.5],
		[30, 3],
		[40, 4],
	])
	assert.deepEqual(cleanHistory({ error: 'no' }), [])
})

test('acciones: el histórico se recorta a lo que dice el intervalo, con al menos una sesión', () => {
	const H = 3600
	const D = 86_400
	// Barras de 15 min durante 6 días seguidos (lo que QvaPay llama «24H»): quedan las de las últimas 24 h
	const bars = Array.from({ length: 6 * 96 }, (_, i): [number, number] => [1_000_000 + i * 900, 100 + i])
	const day = trimHistory(bars, '24H')
	assert.equal(day.length, 97)
	assert.equal(day[day.length - 1][0] - day[0][0], D)
	// La bolsa recién abierta: 2 barras de hoy y la sesión anterior 3 días antes. Quedan 26 (una sesión)
	const monday = [...Array.from({ length: 26 }, (_, i): [number, number] => [1_000_000 + i * 900, 1]), [1_000_000 + 3 * D, 2], [1_000_000 + 3 * D + 900, 2]] as [number, number][]
	assert.equal(trimHistory(monday, '24H').length, 26)
	assert.deepEqual(trimHistory(monday, '1H'), monday.slice(-2))
	// Diarios: 1 mes son 30 días, sin mínimo
	const daily = Array.from({ length: 45 }, (_, i): [number, number] => [i * D, 1])
	assert.equal(trimHistory(daily, '1M').length, 31)
	assert.equal(trimHistory(daily, '1Y').length, 45)
	assert.deepEqual(trimHistory([], '1W'), [])
	assert.equal(trimHistory([[5 * H, 1]], '24H').length, 1)
})

test('acciones: lo intradía de QvaPay viene en hora de Nueva York escrita como UTC y se pasa al instante real; lo diario no', async () => {
	const s = (iso: string) => Date.parse(iso) / 1000
	const answer = (body: unknown) => (async () => new Response(JSON.stringify(body))) as unknown as typeof fetch
	// 9:30 de Nueva York: 14:30 UTC en invierno, 13:30 en verano
	const bars = [{ time: s('2027-07-01T09:30:00Z'), value: 1 }, { time: s('2026-11-12T09:30:00Z'), value: 2 }]
	assert.deepEqual(await loadHistory('NVDA', '1Y', answer(bars)), [[s('2026-11-12T09:30:00Z'), 2], [s('2027-07-01T09:30:00Z'), 1]])
	const week = await loadHistory('NVDA', '1W', answer([{ time: s('2026-11-12T09:30:00Z'), value: 2 }, { time: s('2026-11-12T15:30:00Z'), value: 3 }]))
	assert.deepEqual(week, [[s('2026-11-12T14:30:00Z'), 2], [s('2026-11-12T20:30:00Z'), 3]])
	const summer = await loadHistory('NVDA', '1H', answer([{ time: s('2027-07-01T09:30:00Z'), value: 1 }]))
	assert.deepEqual(summer, [[s('2027-07-01T13:30:00Z'), 1]])
	const daily = await loadHistory('NVDA', '1M', answer([{ time: s('2026-11-12T00:00:00Z'), value: 5 }]))
	assert.deepEqual(daily, [[s('2026-11-12T00:00:00Z'), 5]])
})

test('acciones: sin histórico de un intervalo (404 de QvaPay) es una lista vacía; si QvaPay no responde, null', async () => {
	const status = (code: number) => (async () => Response.json({ error: 'No price history available' }, { status: code })) as unknown as typeof fetch
	assert.deepEqual(await loadHistory('QQQ', '1M', status(404)), [])
	assert.equal(await loadHistory('QQQ', '1M', status(429)), null)
	assert.equal(await loadHistory('QQQ', '1M', status(500)), null)
	const down = (async () => {
		throw new Error('sin red')
	}) as typeof fetch
	assert.equal(await loadHistory('QQQ', '1M', down), null)
})

test('acciones: la lista sale de la lista pública de QvaPay y solo las que faltan van de una en una, hasta que QvaPay pide esperar; las que faltan, de la lectura anterior', async () => {
	const asked: string[] = []
	const fetcher = (async (input: string | URL) => {
		const url = String(input).replace('https://api.qvapay.com', '')
		asked.push(url)
		if (url === '/stocks') return Response.json([{ symbol: 'NVDA', name: 'NVIDIA Corporation', price: 165, change: -5, volume: 10 }, { symbol: 'XYZ', price: 1 }, { symbol: 'AAPL', price: 0 }])
		const m = url.match(/^\/stocks\/([A-Z]+)\?type=quote$/)
		if (m?.[1] === 'SPY') return Response.json({ name: 'SPDR S&P 500', price: 761 })
		if (m?.[1] === 'TSLA') return new Response('roto', { status: 200 })
		return new Response('{}', { status: 429 })
	}) as typeof fetch
	const list = await loadQuotes(fetcher)
	assert.deepEqual(list.map((q) => [q.symbol, q.price, q.fullName]), [['SPY', 761, 'SPDR S&P 500'], ['NVDA', 165, 'NVIDIA']])
	// NVDA vino en la lista: no se pidió su cotización
	assert.ok(!asked.includes('/stocks/NVDA?type=quote'))
	// SPY, TSLA y QQQ: con el 429 de QQQ ya no se piden más
	assert.deepEqual(asked.filter((u) => u.endsWith('?type=quote')), ['/stocks/SPY?type=quote', '/stocks/TSLA?type=quote', '/stocks/QQQ?type=quote'])
	// Con la lectura anterior, las que faltan siguen con su precio de entonces (lo nuevo manda)
	const before = [{ ...list[1], price: 150 }, { ...list[0], symbol: 'CRCL' as const, name: 'Circle', fullName: 'Circle', price: 64 }]
	const merged = await loadQuotes(fetcher, before)
	assert.deepEqual(merged.map((q) => [q.symbol, q.price]), [['SPY', 761], ['NVDA', 165], ['CRCL', 64]])
	// Con SPY ya en la lectura anterior, primero se piden las que faltan (QQQ…) y SPY al final
	asked.length = 0
	await loadQuotes(fetcher, [{ ...list[0] }])
	assert.equal(asked.filter((u) => u.endsWith('?type=quote'))[0], '/stocks/TSLA?type=quote')
	const down = (async () => {
		throw new Error('sin red')
	}) as typeof fetch
	assert.deepEqual(await loadQuotes(down), [])
	// Sin la lista pública (QvaPay pide esperar) y con una lectura guardada de antes de los iconos: llevan su icono igual
	const noList = (async (input: string | URL) => (String(input).endsWith('/stocks') ? new Response('{}', { status: 429 }) : Response.json({ price: 10 }))) as typeof fetch
	const old = [{ ...list[1], image: null }]
	assert.deepEqual((await loadQuotes(noList, old)).map((q) => [q.symbol, q.image]), [['NVDA', 'https://www.qvapay.com/img/stocks/NVDA.svg']])
})

test('bolsa de Nueva York: de 9:30 a 16:00 de allí, sin fines de semana ni festivos, y los días que cierra a las 13:00', () => {
	const at = (iso: string) => marketStatus(Date.parse(iso))
	const iso = (ms: number) => new Date(ms).toISOString()
	// Jueves 12 nov 2026 (invierno en Nueva York, UTC-5): abre 14:30 UTC, cierra 21:00 UTC
	assert.deepEqual(at('2026-11-12T15:00:00Z'), { open: true, until: Date.parse('2026-11-12T21:00:00Z') })
	assert.equal(iso(at('2026-11-12T13:00:00Z').until), '2026-11-12T14:30:00.000Z')
	assert.equal(at('2026-11-12T13:00:00Z').open, false)
	// El viernes por la noche abre el lunes
	assert.deepEqual(at('2026-11-13T22:00:00Z'), { open: false, until: Date.parse('2026-11-16T14:30:00Z') })
	// Acción de Gracias (jueves 26) cerrada todo el día; el viernes 27 cierra a las 13:00 de allí
	assert.deepEqual(at('2026-11-26T16:00:00Z'), { open: false, until: Date.parse('2026-11-27T14:30:00Z') })
	assert.deepEqual(at('2026-11-27T16:00:00Z'), { open: true, until: Date.parse('2026-11-27T18:00:00Z') })
	assert.equal(at('2026-11-27T18:30:00Z').open, false)
	// En verano (UTC-4) abre a las 13:30 UTC
	assert.deepEqual(at('2027-06-01T13:45:00Z'), { open: true, until: Date.parse('2027-06-01T20:00:00Z') })
	// Navidad de 2027 se descansa el viernes 24
	assert.equal(iso(at('2027-12-23T22:00:00Z').until), '2027-12-27T14:30:00.000Z')
})
