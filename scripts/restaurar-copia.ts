// Restaura una copia de Pro en la base de staging o de producción.
//
//   node scripts/restaurar-copia.ts <archivo> [--env staging|prod] [--aplicar]
//
// <archivo>: la copia cifrada (.copia, la del grupo de avisos o «Copia cifrada» del panel) o la copia en claro (JSON,
// la del KV o «Copia completa» del panel). La cifrada pide BACKUP_KEY al empezar, sin enseñarla.
// Sin --aplicar solo dice qué hay en la copia y deja el SQL listo: no toca nada. Con --aplicar, y tras escribir el nombre
// de la base para confirmar, deja las tablas de Pro exactamente como en la copia (las demás no se tocan)

import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { isSealed, open, restoreSql, tablesOf } from '../worker/backup.ts'

const args = process.argv.slice(2)
const file = args.find((a) => !a.startsWith('--'))
const env = args.includes('--env') ? args[args.indexOf('--env') + 1] : 'staging'
const apply = args.includes('--aplicar')
if (!file || !['staging', 'prod'].includes(env)) {
	console.error('Uso: node scripts/restaurar-copia.ts <archivo> [--env staging|prod] [--aplicar]')
	process.exit(1)
}
const db = env === 'prod' ? 'terminal-p2p' : 'terminal-p2p-staging'

// Una pregunta en la terminal; con hidden, lo que se escribe no se ve
function ask(question: string, hidden = false): Promise<string> {
	const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true })
	if (hidden) (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = (s) => void (s.includes(question) && process.stdout.write(question))
	return new Promise((resolve) =>
		rl.question(question, (answer) => {
			rl.close()
			if (hidden) process.stdout.write('\n')
			resolve(answer.trim())
		}),
	)
}

let text = readFileSync(file, 'utf8')
if (isSealed(text)) text = await open(text, process.env.BACKUP_KEY || (await ask('BACKUP_KEY: ', true)))
const copy = JSON.parse(text) as { at?: string }
const tables = tablesOf(copy)
if (!Object.keys(tables).length) throw new Error('El archivo no parece una copia de Pro')

console.log(`Copia del ${copy.at ?? '?'}:`)
for (const [t, rows] of Object.entries(tables)) console.log(`  ${t.padEnd(18)} ${rows.length}`)
const sql = join(tmpdir(), `restaurar-pro-${Date.now()}.sql`)
writeFileSync(sql, restoreSql(tables))
console.log(`SQL listo en ${sql}`)

if (!apply) {
	console.log(`Nada cambiado. Para restaurarla en ${db}, repite con --aplicar.`)
	process.exit(0)
}
console.log(`\nVas a dejar las tablas de arriba en ${db} exactamente como en la copia: lo de después se pierde.`)
if ((await ask(`Escribe ${db} para seguir: `)) !== db) {
	console.log('Cancelado. No se tocó nada.')
	process.exit(1)
}
const r = spawnSync('npx', ['wrangler', 'd1', 'execute', db, '--remote', '--file', sql, ...(env === 'staging' ? ['--env', 'staging'] : [])], { stdio: 'inherit' })
process.exit(r.status ?? 1)
