import { test } from 'node:test'
import assert from 'node:assert/strict'
import { toLevel } from '../src/terminal/market.ts'
import type { P2POffer } from '../src/qvapay/types.ts'

const offer = (message?: string | null) => ({ uuid: 'x', type: 'sell', coin: 'CUPCASH', amount: '10', receive: '9300', status: 'open', message }) as unknown as P2POffer

test('la nota pública de la oferta llega al libro (sin espacios) y sin nota no hay campo', () => {
	assert.equal(toLevel(offer('  Isla de la Juventud  '), false, null).message, 'Isla de la Juventud')
	assert.equal('message' in toLevel(offer(null), false, null), false)
	assert.equal('message' in toLevel(offer('   '), false, null), false)
	assert.equal('message' in toLevel(offer(), false, null), false)
})
