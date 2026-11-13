// Carga el motor de idiomas y el diccionario español, como en el navegador: las pruebas de src/broker comprueban
// sus textos en español. Importarlo al principio de la prueba, antes de usar las rutas
import { readFileSync } from 'node:fs'
import { runInThisContext } from 'node:vm'

const root = new URL('../', import.meta.url)
runInThisContext(readFileSync(new URL('public/app/lang/es.js', root), 'utf8'))
runInThisContext(readFileSync(new URL('public/app/i18n.js', root), 'utf8'))
