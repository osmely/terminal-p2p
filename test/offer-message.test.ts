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

test('el banco de la tarjeta llega al libro en mayúsculas; sin banco no hay campo', () => {
	const withBank = (bank?: string | null) => ({ uuid: 'y', type: 'sell', coin: 'BANK_CUP', amount: '10', receive: '11300', status: 'open', bank }) as unknown as P2POffer
	assert.equal(toLevel(withBank('BANDEC'), false, null).bank, 'BANDEC')
	assert.equal(toLevel(withBank(' metropolitano '), false, null).bank, 'METROPOLITANO')
	assert.equal('bank' in toLevel(withBank(null), false, null), false)
	assert.equal('bank' in toLevel(withBank(''), false, null), false)
	assert.equal('bank' in toLevel(withBank(), false, null), false)
})
