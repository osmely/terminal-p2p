import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isOutlier } from '../src/terminal/market.ts'

test('precio raro: hacia el lado bueno para quien la toma basta un 8 %; hacia el malo, un 35 %', () => {
	// Clásica: referencia de compra 1,0945. Una compra a 1,20 (+9,6 %) es demasiado buena: rara
	assert.equal(isOutlier(1.2, 1.0945, 'bid'), true)
	assert.equal(isOutlier(1.11, 1.0945, 'bid'), false)
	// Una compra muy baja no engaña a nadie: solo rara si se va muy lejos
	assert.equal(isOutlier(0.9, 1.0945, 'bid'), false)
	assert.equal(isOutlier(0.6, 1.0945, 'bid'), true)
	// Ventas: rara si es mucho más barata que la referencia
	assert.equal(isOutlier(950, 1045, 'ask'), true)
	assert.equal(isOutlier(1030, 1045, 'ask'), false)
	assert.equal(isOutlier(1300, 1045, 'ask'), false)
	assert.equal(isOutlier(1500, 1045, 'ask'), true)
	assert.equal(isOutlier(1, null, 'ask'), false)
})
