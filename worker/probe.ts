// Pieza de prueba: se crea en la región que se le pida (enam, wnam…) y mide cuánto le tarda QvaPay en contestar desde
// allí, para saber dónde conviene el libro en vivo. No guarda nada; mide como mucho cada 10 min
import { DurableObject } from 'cloudflare:workers'
import { QVAPAY } from './livebook.ts'

export interface Where {
	colo: string | null
	ms: number[]
}

export async function measureQvaPay(): Promise<Where> {
	const colo = await fetch('https://www.cloudflare.com/cdn-cgi/trace')
		.then((r) => r.text())
		.then((t) => /^colo=(\w+)$/m.exec(t)?.[1] ?? null)
		.catch(() => null)
	const ms: number[] = []
	for (let i = 0; i < 5; i++) {
		const at = Date.now()
		const ok = await fetch(`${QVAPAY}/p2p/00000000-0000-4000-8000-000000000000`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(5000) })
			.then((r) => r.body?.cancel().then(() => true) ?? true)
			.catch(() => false)
		if (ok) ms.push(Date.now() - at)
	}
	return { colo, ms: ms.sort((a, b) => a - b) }
}

export class Probe extends DurableObject {
	private last: (Where & { at: number }) | null = null
	async fetch() {
		if (!this.last || Date.now() - this.last.at > 600_000) this.last = { ...(await measureQvaPay()), at: Date.now() }
		return Response.json(this.last)
	}
}

export const PROBE_REGIONS = ['enam', 'wnam'] as const
