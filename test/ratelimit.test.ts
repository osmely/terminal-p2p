import assert from 'node:assert/strict'
import { test } from 'node:test'
import { RateLimiter } from '../src/ratelimit.ts'

test('no pasa de max llamadas por ventana y respeta el orden', async () => {
	const limiter = new RateLimiter({ k: { max: 2, windowMs: 200 } })
	const t0 = Date.now()
	const done: [number, number][] = []
	await Promise.all([0, 1, 2, 3].map((i) => limiter.run('k', async () => void done.push([i, Date.now() - t0]))))
	assert.deepEqual(
		done.map(([i]) => i),
		[0, 1, 2, 3],
	)
	assert.ok(done[1][1] < 100, 'las dos primeras salen de inmediato')
	assert.ok(done[2][1] >= 195, `la tercera espera la ventana (${done[2][1]} ms)`)
})

test('un fallo no bloquea la cola', async () => {
	const limiter = new RateLimiter({ k: { max: 5, windowMs: 1000 } })
	await assert.rejects(limiter.run('k', async () => Promise.reject(new Error('boom'))))
	assert.equal(await limiter.run('k', async () => 42), 42)
})

test('penalize bloquea el bucket tras un 429', async () => {
	const limiter = new RateLimiter({ k: { max: 5, windowMs: 1000 } })
	limiter.penalize('k', 150)
	const t0 = Date.now()
	await limiter.run('k', async () => {})
	assert.ok(Date.now() - t0 >= 140)
})
