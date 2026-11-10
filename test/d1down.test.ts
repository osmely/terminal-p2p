import assert from 'node:assert/strict'
import { test } from 'node:test'
import { accessOf, anyBlocks } from '../worker/blocks.ts'
import { ordersPaused, proEnabled } from '../worker/flags.ts'

// Una base que responde bien hasta que se corta
function flaky(rows: { flags?: Record<string, string>; blocks?: { username: string; level: string; until: number | null }[] }) {
	const state = { down: false, reads: 0 }
	const stmt = (sql: string) => ({
		bind: () => stmt(sql),
		first: async () => {
			state.reads++
			if (state.down) throw new Error('D1_ERROR: network connection lost')
			const key = Object.keys(rows.flags ?? {}).find(() => sql.includes('app_flags'))
			return key ? { value: rows.flags![key] } : null
		},
		all: async () => {
			state.reads++
			if (state.down) throw new Error('D1_ERROR: network connection lost')
			return { results: sql.includes('FROM user_blocks b WHERE') && !sql.includes('UNION') ? (rows.blocks ?? []) : [] }
		},
	})
	return { db: { prepare: stmt, batch: async () => [] } as never, state }
}

test('corte de D1: los interruptores siguen con lo último que se supo (o lo de siempre) y no tumban nada', async () => {
	const T = 1_000_000
	const a = flaky({ flags: { pro: '0' } })
	assert.equal(await proEnabled(a.db, T), false)
	a.state.down = true
	// Pasado el medio minuto de la caché, con la base caída: lo último que se supo
	assert.equal(await proEnabled(a.db, T + 31_000), false)
	// Y no se vuelve a preguntar en cada petición, sino a los pocos segundos
	const reads = a.state.reads
	await proEnabled(a.db, T + 32_000)
	assert.equal(a.state.reads, reads)
	await proEnabled(a.db, T + 37_000)
	assert.equal(a.state.reads, reads + 1)
	// Sin nada sabido: Pro encendido y publicar ofertas sin pausa
	const b = flaky({})
	b.state.down = true
	assert.equal(await proEnabled(b.db, T), true)
	assert.equal(await ordersPaused(b.db, T), false)
})

test('corte de D1: el relé sigue con la última lista de bloqueos (o ninguna)', async () => {
	const T = 2_000_000
	const a = flaky({ blocks: [{ username: 'malo', level: 'blocked', until: null }] })
	assert.equal(await anyBlocks(a.db, T), true)
	a.state.down = true
	assert.equal((await accessOf(a.db, { username: 'malo' }, T + 31_000))?.level, 'blocked')
	const b = flaky({})
	b.state.down = true
	assert.equal(await anyBlocks(b.db, T), false)
	assert.equal(await accessOf(b.db, { username: 'malo' }, T), null)
})
