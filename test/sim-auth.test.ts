import assert from 'node:assert/strict'
import { createHash, createHmac } from 'node:crypto'
import { test } from 'node:test'
import { Engine, freshState, type Candle } from '../src/sim/engine.ts'
import { catchUp, readSession, sessionCookie, verifyTelegram } from '../worker/sim.ts'

const BOT = '123456:ABC-prueba'
const NOW_S = 1_792_900_000

// Firma como la del botón de Telegram
function signed(fields: Record<string, string>, token = BOT) {
	const check = Object.keys(fields)
		.sort()
		.map((k) => `${k}=${fields[k]}`)
		.join('\n')
	const hash = createHmac('sha256', createHash('sha256').update(token).digest()).update(check).digest('hex')
	return new URLSearchParams({ ...fields, hash })
}

test('Telegram: acepta su firma y rechaza la manipulada, la de otro bot o la caducada', async () => {
	const fields = { id: '42', first_name: 'Ana', username: 'ana_trader', auth_date: String(NOW_S - 60) }
	assert.deepEqual(await verifyTelegram(signed(fields), BOT, NOW_S), { id: 42, first_name: 'Ana', username: 'ana_trader', photo_url: undefined })
	const tampered = signed(fields)
	tampered.set('id', '43')
	assert.equal(await verifyTelegram(tampered, BOT, NOW_S), null)
	assert.equal(await verifyTelegram(signed(fields, '999:OTRO'), BOT, NOW_S), null)
	assert.equal(await verifyTelegram(signed({ ...fields, auth_date: String(NOW_S - 2 * 86_400) }), BOT, NOW_S), null)
})

test('sesión: cookie firmada, que caduca y no se puede falsificar', async () => {
	const c = await sessionCookie(42, 'clave', 1000)
	assert.equal(await readSession(`otra=1; tps=${c}`, 'clave', 2000), 42)
	assert.equal(await readSession(`tps=${c}`, 'otra-clave', 2000), null)
	assert.equal(await readSession(`tps=${c}`, 'clave', 1000 + 31 * 86_400_000), null)
	const [, sig] = c.split('.')
	const forged = `${Buffer.from(JSON.stringify({ u: 1, e: 9e15 })).toString('base64url')}.${sig}`
	assert.equal(await readSession(`tps=${forged}`, 'clave', 2000), null)
	assert.equal(await readSession(null, 'clave'), null)
})

test('revisión: velas de 1 minuto desde la última revisión, solo las ya cerradas', async () => {
	const t0 = Date.parse('2026-10-24T12:00:00Z')
	const e = new Engine(freshState(t0))
	e.placeOrder({ symbol: 'BTC', side: 'BUY', type: 'LIMIT', price: 99, quoteAmount: 500 }, { bid: 100, ask: 100.1 }, t0 + 20_000)
	const asked: [string, number, number][] = []
	const fake = async (s: string, from: number, to: number): Promise<Candle[]> => {
		asked.push([s, from, to])
		return [
			{ t: t0, o: 100, h: 100, l: 98, c: 99 }, // el minuto en que se puso la orden: no cuenta
			{ t: t0 + 60_000, o: 100, h: 100, l: 98.5, c: 99 },
			{ t: t0 + 120_000, o: 97, h: 97, l: 96, c: 96 }, // aún sin cerrar a t0 + 150 s
		]
	}
	await catchUp(e, t0 + 150_000, fake)
	assert.deepEqual(asked, [['BTCUSDT', t0, t0 + 150_000]])
	const [order] = e.state.orders
	assert.deepEqual([order.status, order.avgPrice, order.filledAt], ['FILLED', 99, t0 + 120_000])
	// Queda revisado hasta el inicio del minuto en curso
	assert.equal(e.state.checkedAt, t0 + 120_000)
})
