import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext, runInThisContext } from 'node:vm'

// Los diccionarios y el motor son scripts del navegador: se cargan tal cual. Cada juego (el terminal en public/app/lang,
// la portada en public/site/lang) en su propio contexto, que los dos escriben en TP_LANG
type Dict = Record<string, string | string[]>
const root = new URL('../', import.meta.url)
const read = (p: string) => readFileSync(new URL(p, root), 'utf8')
const load = (set: string) => {
	const ctx: { TP_LANG?: Record<string, Dict> } = {}
	for (const l of ['es', 'en', 'pt']) runInNewContext(read(`public/${set}/lang/${l}.js`), ctx)
	return ctx.TP_LANG!
}
const SETS = { app: load('app'), site: load('site') }

runInThisContext(read('public/app/lang/es.js'))
runInThisContext(read('public/app/i18n.js'))
const g = globalThis as unknown as {
	TP_LANG: Record<string, Dict>
	tl: (key: string, vars?: Record<string, unknown>) => string
	TPI18N: { lang: string }
}
// Huecos de tl ({n}) y de los trozos del HTML que se recolocan ({@trial})
const holes = (s: string) => [...s.matchAll(/\{@?\w+\}/g)].map((m) => m[0]).sort().join(',')
const variants = (v: string | string[]) => (Array.isArray(v) ? v : [v])

for (const [set, { es, en, pt }] of Object.entries(SETS)) {
	test(`${set}: los tres diccionarios tienen las mismas claves`, () => {
		const keys = Object.keys(es).sort()
		assert.ok(keys.length > 100)
		assert.deepEqual(Object.keys(en).sort(), keys)
		assert.deepEqual(Object.keys(pt).sort(), keys)
	})

	test(`${set}: cada traducción tiene la misma forma y los mismos huecos que el español`, () => {
		for (const k of Object.keys(es)) {
			for (const [name, d] of [['en', en], ['pt', pt]] as const) {
				assert.equal(Array.isArray(d[k]), Array.isArray(es[k]), `${name} ${k}: texto o [uno, varios]`)
				if (Array.isArray(es[k])) assert.equal(d[k].length, es[k].length, `${name} ${k}`)
				// Los de la forma «varios» del español (la de uno puede no llevar {n})
				assert.equal(holes(variants(d[k]).at(-1)!), holes(variants(es[k]).at(-1)!), `${name} ${k}: huecos`)
			}
		}
	})
}

test('todas las claves fijas que usa el código existen', () => {
	const files = [
		...readdirSync(new URL('public/app/', root)).filter((f) => f.endsWith('.js') && f !== 'i18n.js').map((f) => `public/app/${f}`),
		...readdirSync(new URL('web/', root)).filter((f) => f.endsWith('.ts')).map((f) => `web/${f}`),
		...['src/broker/routes.ts', 'src/broker/alerts.ts', 'src/broker/trades.ts'],
	]
	const used = (f: string) => [...read(f).matchAll(/\btl\(\s*'([\w.-]+)'/g)].map((m) => m[1])
	for (const f of files) for (const k of used(f)) assert.ok(SETS.app.es[k] != null, `falta en los diccionarios del terminal: ${k} (${f})`)
	for (const k of used('public/site/site.js')) assert.ok(SETS.site.es[k] != null, `falta en los diccionarios de la portada: ${k}`)
})

// El elemento entero (<tag …>…</tag>) que empieza en i, contando las etiquetas iguales anidadas
function element(html: string, i: number) {
	const tag = html.slice(i).match(/^<(\w+)/)![1]
	const re = new RegExp(`<${tag}[\\s>]|</${tag}>`, 'g')
	re.lastIndex = html.indexOf('>', i) + 1
	for (let depth = 1, m; (m = re.exec(html)); ) {
		depth += m[0].startsWith('</') ? -1 : 1
		if (!depth) return { outer: html.slice(i, re.lastIndex), inner: html.slice(html.indexOf('>', i) + 1, m.index) }
	}
	throw new Error(`etiqueta sin cerrar: ${html.slice(i, i + 80)}`)
}

for (const [file, set] of [['public/app/index.html', 'app'], ['public/site/index.html', 'site']] as const) {
	test(`${file}: el HTML fijo dice en español lo mismo que el diccionario`, () => {
		const es = SETS[set].es
		const html = read(file)
		const flat = (s: string) => s.replace(/\s+/g, ' ').trim()
		let n = 0
		// Texto: <tag … data-i18n="clave" …>texto</tag> (sin hijos)
		for (const m of html.matchAll(/data-i18n="([\w.]+)"[^>]*>([^<]*)</g)) {
			assert.equal(flat(m[2]), flat(String(es[m[1]])), m[1])
			n++
		}
		for (const attr of ['title', 'aria-label', 'placeholder', 'alt']) {
			for (const m of html.matchAll(new RegExp(`<[^>]*data-i18n-${attr}="([\\w.]+)"[^>]*>`, 'g'))) {
				const v = m[0].match(new RegExp(`\\s${attr}="([^"]*)"`))
				assert.ok(v, `${m[1]}: falta ${attr}`)
				assert.equal(v[1], es[m[1]], m[1])
				n++
			}
		}
		// HTML: lo de dentro, con cada {@hueco} sustituido por su elemento data-i18n-slot tal cual
		for (const m of html.matchAll(/<\w+[^>]*data-i18n-html="([\w.]+)"[^>]*>/g)) {
			const { inner } = element(html, m.index)
			const want = String(es[m[1]]).replace(/\{@(\w+)\}/g, (_, slot: string) => {
				const at = inner.search(new RegExp(`<\\w+[^>]*data-i18n-slot="${slot}"`))
				assert.ok(at >= 0, `${m[1]}: falta el hueco ${slot}`)
				return element(inner, at).outer
			})
			assert.equal(flat(inner), flat(want), m[1])
			n++
		}
		assert.ok(n > 50)
	})
}

test('tl: fuera del navegador es español, rellena huecos con números 1,050.25 y elige singular o plural', () => {
	const es = g.TP_LANG.es
	assert.equal(g.TPI18N.lang, 'es')
	es['test.n'] = ['{n} oferta', '{n} ofertas']
	es['test.v'] = 'Hola {user}: {usd} USD'
	try {
		assert.equal(g.tl('test.n', { n: 1 }), '1 oferta')
		assert.equal(g.tl('test.n', { n: 1050 }), '1,050 ofertas')
		assert.equal(g.tl('test.v', { user: 'ana', usd: 1050.25 }), 'Hola ana: 1,050.25 USD')
		assert.equal(g.tl('test.v'), 'Hola {user}: {usd} USD')
		assert.equal(g.tl('no.existe'), 'no.existe')
	} finally {
		delete es['test.n']
		delete es['test.v']
	}
})
