// Copia a public/app/vendor las dependencias de la interfaz para servirlas
// desde nuestro dominio: así ningún tercero (Google Fonts, CDNs) ve a los visitantes.
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs'

const out = 'public/app/vendor'
mkdirSync(out, { recursive: true })

copyFileSync('node_modules/lightweight-charts/dist/lightweight-charts.standalone.production.js', `${out}/lightweight-charts.js`)

const fonts = [
	['Inter', '@fontsource/inter/files/inter-latin', [400, 500, 600, 700]],
	['JetBrains Mono', '@fontsource/jetbrains-mono/files/jetbrains-mono-latin', [400, 500, 600]],
]
let css = '/* Generado por scripts/vendor.mjs */\n'
for (const [family, base, weights] of fonts) {
	for (const w of weights) {
		const file = `${base.split('/').pop()}-${w}-normal.woff2`
		copyFileSync(`node_modules/${base}-${w}-normal.woff2`, `${out}/${file}`)
		css += `@font-face { font-family: '${family}'; font-style: normal; font-weight: ${w}; font-display: swap; src: url('/vendor/${file}') format('woff2'); }\n`
	}
}
writeFileSync(`${out}/fonts.css`, css)

// Las licencias viajan con los archivos (Apache 2.0 y SIL OFL 1.1 lo exigen)
mkdirSync(`${out}/licenses`, { recursive: true })
copyFileSync('node_modules/lightweight-charts/LICENSE', `${out}/licenses/lightweight-charts-LICENSE.txt`)
copyFileSync('node_modules/@fontsource/inter/LICENSE', `${out}/licenses/inter-OFL.txt`)
copyFileSync('node_modules/@fontsource/jetbrains-mono/LICENSE', `${out}/licenses/jetbrains-mono-OFL.txt`)
console.log('vendor listo')
