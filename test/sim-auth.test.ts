import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Engine, freshState, type Candle } from '../src/sim/engine.ts'
import { catchUp } from '../worker/sim.ts'
import { readSession, sessionCookie, sessionToken } from '../worker/session.ts'

test('sesión del terminal: cookie firmada con la huella, que caduca y no se puede falsificar', async () => {
	const P = 'a'.repeat(64)
	const c = await sessionToken(P, 'clave', 1000)
	assert.equal(await readSession(`otra=1; tpid=${c}`, 'clave', 2000), P)
	assert.equal(await readSession(`tpid=${c}`, 'otra-clave', 2000), null)
	assert.equal(await readSession(`tpid=${c}`, 'clave', 1000 + 31 * 86_400_000), null)
	const [, sig] = c.split('.')
	const forged = `${Buffer.from(JSON.stringify({ k: 'sess', p: 'b'.repeat(64), e: 9e15 })).toString('base64url')}.${sig}`
	assert.equal(await readSession(`tpid=${forged}`, 'clave', 2000), null)
	// Una licencia firmada con la misma clave no sirve como sesión
	const { sign } = await import('../worker/crypto.ts')
	assert.equal(await readSession(`tpid=${await sign({ u: 'x', n: 'ana', e: 9e15, x: 9e15 }, 'clave')}`, 'clave', 2000), null)
	assert.equal(await readSession(null, 'clave'), null)
	// Llegan las cookies de producción y de staging con el mismo nombre: vale la de la clave de este entorno
	const prod = await sessionToken('c'.repeat(64), 'clave-prod', 1000)
	assert.equal(await readSession(`tpid=${prod}; tpid=${c}`, 'clave', 2000), P)
})

test('la cookie de sesión es del dominio principal: la comparten el terminal y el simulador de cada entorno', () => {
	assert.match(sessionCookie(new URL('https://app.terminalp2p.com/pro/status'), 'v'), /; Domain=terminalp2p\.com; Secure$/)
	assert.match(sessionCookie(new URL('https://app.staging.terminalp2p.com/pro/status'), 'v'), /; Domain=staging\.terminalp2p\.com; Secure$/)
	assert.match(sessionCookie(new URL('https://app.terminalp2p.com/pro/leave'), '', 0), /^tpid=; HttpOnly; SameSite=Lax; Path=\/; Max-Age=0; Domain=terminalp2p\.com/)
	assert.doesNotMatch(sessionCookie(new URL('http://app.localhost:5177/pro/status'), 'v'), /Domain|Secure/)
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
