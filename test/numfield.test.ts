import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

// numfield.js y broker.js son scripts del navegador: se cargan tal cual, con lo mínimo de document y window
const root = new URL('../', import.meta.url)
const read = (p: string) => readFileSync(new URL(p, root), 'utf8')

type Issue = { block: boolean; key: string; vars: Record<string, unknown> } | null
type El = { value: string; dataset: Record<string, string> }
const ctx: Record<string, unknown> = {
	document: { addEventListener() {} },
	HTMLInputElement: class {},
	// El texto del aviso: la clave y sus huecos, para comprobar cuál sale
	tl: (k: string, v?: Record<string, unknown>) => (v ? `${k} ${JSON.stringify(v)}` : k),
	nameOf: (tick: string) => `«${tick}»`,
}
ctx.window = ctx
runInNewContext(read('public/app/numfield.js'), ctx)
const TPNum = ctx.TPNum as {
	cardIssue: (raw: string, coin?: string, optional?: boolean) => Issue
	cardError: (els: El[]) => string
	cardWarn: (els: El[]) => string
	detail: (name: string, coin?: string) => string
}

// Una tarjeta de 16 cifras con su dígito de control bien puesto
function card(first15: string) {
	const d = first15.replace(/\D/g, '')
	for (let c = 0; c < 10; c++) {
		const n = d + c
		let sum = 0
		for (let i = 0; i < n.length; i++) {
			let x = Number(n[n.length - 1 - i])
			if (i % 2) x = x * 2 > 9 ? x * 2 - 9 : x * 2
			sum += x
		}
		if (sum % 10 === 0) return n
	}
	throw new Error('sin dígito')
}
// La misma tarjeta con el último dígito cambiado: el dígito de control ya no cuadra
const typo = (n: string) => n.slice(0, -1) + ((Number(n.at(-1)) + 1) % 10)
const key = (i: Issue) => (i ? `${i.key}${i.block ? '' : '?'}` : null)

const CUP = card('922706991234567')
const MLC = card('922506991234567')
const TROPICAL = card('924006991234567')
const CLASICA = card('976003123456789')

test('tarjeta: una cubana del tipo del mercado vale, también escrita con espacios', () => {
	assert.equal(TPNum.cardIssue(CUP, 'BANK_CUP'), null)
	assert.equal(TPNum.cardIssue(CUP.replace(/(\d{4})(?=\d)/g, '$1 '), 'BANK_CUP'), null)
	assert.equal(TPNum.cardIssue(MLC, 'BANK_MLC'), null)
	assert.equal(TPNum.cardIssue(TROPICAL, 'BANDECPREPAGO'), null)
	// En Clásica entran la Clásica y la Tropical
	assert.equal(TPNum.cardIssue(CLASICA, 'CLASICA'), null)
	assert.equal(TPNum.cardIssue(TROPICAL, 'CLASICA'), null)
	assert.equal(TPNum.cardIssue('', 'BANK_CUP'), null)
})

test('tarjeta: sin 16 cifras o con el dígito de control mal, QvaPay la rechaza', () => {
	assert.equal(key(TPNum.cardIssue(CUP.slice(0, 15), 'BANK_CUP')), 'digits')
	assert.equal(key(TPNum.cardIssue(typo(CUP), 'BANK_CUP')), 'checksum')
	assert.equal(key(TPNum.cardIssue(typo(CLASICA), 'CLASICA')), 'checksum')
	// Al comprar el campo es opcional: el dígito mal se avisa sin bloquear; las 16 cifras siguen siendo obligatorias
	assert.equal(key(TPNum.cardIssue(typo(CUP), 'BANK_CUP', true)), 'checksum?')
	assert.equal(key(TPNum.cardIssue(CUP.slice(0, 12), 'BANK_CUP', true)), 'digits')
})

test('tarjeta: una Visa o Mastercard no vale en ningún lado', () => {
	for (const n of ['4111111111111111', '5500000000000004', card('222100000000000'), card('272000000000000')]) {
		assert.equal(key(TPNum.cardIssue(n, 'BANK_CUP')), 'foreign', n)
		assert.equal(key(TPNum.cardIssue(n, 'CLASICA', true)), 'foreign', n)
	}
	assert.match(TPNum.cardError([{ value: '4111 1111 1111 1111', dataset: { num: 'card', coin: 'BANK_CUP' } }]), /Visa/)
})

test('tarjeta: una de otro tipo que el del mercado (la causa de los rechazos en Clásica)', () => {
	const i = TPNum.cardIssue(CUP, 'CLASICA')
	assert.equal(key(i), 'method')
	assert.deepEqual({ ...i!.vars }, { kind: 'cup', coin: 'CLASICA', right: 'BANK_CUP' })
	assert.equal(key(TPNum.cardIssue(MLC, 'BANK_CUP')), 'method')
	assert.equal(key(TPNum.cardIssue(CUP, 'BANK_MLC')), 'method')
	assert.equal(key(TPNum.cardIssue(CLASICA, 'BANDECPREPAGO')), 'method')
	assert.equal(key(TPNum.cardIssue(CUP, 'CLASICA', true)), 'method?')
	// El texto dice qué tarjeta es, qué pide el mercado y dónde va
	const text = TPNum.cardError([{ value: CUP, dataset: { num: 'card', coin: 'CLASICA' } }])
	assert.match(text, /^numfield\.cardMethod /)
	assert.match(text, /numfield\.kindCup/)
	assert.match(text, /«CLASICA»/)
	assert.match(text, /numfield\.wantClasica/)
	assert.match(text, /«BANK_CUP»/)
})

test('tarjeta: lo que no se sabe seguro solo se avisa', () => {
	// Un producto nuevo de la red RED: QvaPay lo acepta
	assert.equal(TPNum.cardIssue(card('929906991234567'), 'BANK_CUP'), null)
	// La 9250: MLC según el catálogo, Tropical según la tabla de QvaPay
	assert.equal(TPNum.cardIssue(card('925006991234567'), 'BANK_MLC'), null)
	assert.equal(TPNum.cardIssue(card('925006991234567'), 'BANDECPREPAGO'), null)
	// Ni 92 ni 9760: quizá un número de cuenta
	const acct = card('059900001234567')
	assert.equal(key(TPNum.cardIssue(acct, 'BANK_CUP')), 'notCuban?')
	const els = [{ value: acct, dataset: { num: 'card', coin: 'BANK_CUP' } }]
	assert.equal(TPNum.cardError(els), '')
	assert.equal(TPNum.cardWarn(els), 'numfield.cardNotCuban')
	// Sin mercado (el radar Pro): sin comprobar el tipo, el resto igual
	assert.equal(TPNum.cardIssue(CUP), null)
	assert.equal(key(TPNum.cardIssue(typo(CUP))), 'checksum')
})

test('tarjeta: cardError bloquea según cada campo (data-card-optional al comprar) y no mira lo que no es tarjeta', () => {
	const bad = typo(CUP)
	assert.equal(TPNum.cardError([{ value: bad, dataset: { num: 'card', coin: 'BANK_CUP' } }]), 'numfield.cardChecksum')
	const optional = [{ value: bad, dataset: { num: 'card', coin: 'BANK_CUP', cardOptional: '1' } }]
	assert.equal(TPNum.cardError(optional), '')
	assert.equal(TPNum.cardWarn(optional), 'numfield.cardChecksum')
	assert.equal(TPNum.cardError([{ value: bad, dataset: { num: 'digits' } }]), '')
})

test('tarjeta: el campo lleva su mercado para comprobar el tipo', () => {
	assert.match(TPNum.detail('Nro de tarjeta', 'CLASICA'), /data-num="card".*data-coin="CLASICA"/)
	assert.doesNotMatch(TPNum.detail('Nro de tarjeta'), /data-coin/)
	assert.equal(TPNum.detail('Nro de cuenta o tarjeta', 'SBERBANK'), ' data-num="digits" inputmode="numeric"')
})

// flexOfferOf, tal cual está en broker.js (el resto del fichero necesita la página entera)
const src = read('public/app/broker.js').match(/^function flexOfferOf[\s\S]*?^}/m)![0]
const flexOfferOf = (openOffers: object[], ...args: unknown[]) =>
	runInNewContext(`${src}; flexOfferOf(...args)`, { bk: { openOffers }, args }) as { offerUuid: string } | null

test('oferta por rango: QvaPay deja una viva por mercado y lado', () => {
	const mine = [
		{ offerUuid: 'a', kind: 'fixed', coin: 'BANK_CUP', offerType: 'sell' },
		{ offerUuid: 'b', kind: 'flexible', coin: 'BANK_CUP', offerType: 'sell', available: 0 },
		{ offerUuid: 'c', kind: 'flexible', coin: 'CLASICA', offerType: 'buy' },
	]
	// Una agotada con órdenes en curso sigue abierta y cuenta
	assert.equal(flexOfferOf(mine, 'BANK_CUP', 'sell')?.offerUuid, 'b')
	assert.equal(flexOfferOf(mine, 'BANK_CUP', 'buy'), null)
	assert.equal(flexOfferOf(mine, 'CLASICA', 'buy')?.offerUuid, 'c')
	assert.equal(flexOfferOf(mine, 'CLASICA', 'sell'), null)
	// Al convertir una oferta en por rango, ella misma no cuenta
	assert.equal(flexOfferOf(mine, 'BANK_CUP', 'sell', 'b'), null)
	assert.equal(flexOfferOf([], 'BANK_CUP', 'sell'), null)
})
