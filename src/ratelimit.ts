// Ventana deslizante por bucket. Cada bucket corre sus tareas en serie y
// espera lo necesario para no pasar de `max` llamadas cada `windowMs`.

export interface BucketSpec {
	max: number
	windowMs: number
}

// Límites documentados por QvaPay, con algo de margen
export const QVAPAY_BUCKETS = {
	list: { max: 22, windowMs: 60_000 }, // GET /p2p: 25/min por cuenta
	general: { max: 3, windowMs: 5_500 }, // resto: 3 cada 5 s
	cancel: { max: 1, windowMs: 20_500 },
	paid: { max: 1, windowMs: 10_500 },
	received: { max: 1, windowMs: 10_500 },
	averages: { max: 1, windowMs: 60_000 }, // cacheado 60 s del lado del servidor
	completed: { max: 8, windowMs: 60_000 }, // /p2p/completed_pairs_average: 10/min por IP
} satisfies Record<string, BucketSpec>

export type BucketName = keyof typeof QVAPAY_BUCKETS

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

class Bucket {
	private stamps: number[] = []
	private tail: Promise<unknown> = Promise.resolve()
	private readonly spec: BucketSpec
	private readonly now: () => number

	constructor(spec: BucketSpec, now: () => number) {
		this.spec = spec
		this.now = now
	}

	run<T>(fn: () => Promise<T>): Promise<T> {
		const next = this.tail.then(async () => {
			await this.waitTurn()
			this.stamps.push(this.now())
			return fn()
		})
		// Un fallo no debe bloquear la cola
		this.tail = next.catch(() => {})
		return next
	}

	// Tras un 429 nadie más entra hasta que pase `ms`
	penalize(ms: number) {
		const until = this.now() + ms
		this.stamps = Array.from({ length: this.spec.max }, () => until - this.spec.windowMs)
	}

	private async waitTurn() {
		for (;;) {
			const t = this.now()
			this.stamps = this.stamps.filter((s) => t - s < this.spec.windowMs)
			if (this.stamps.length < this.spec.max) return
			await sleep(this.spec.windowMs - (t - this.stamps[0]) + 5)
		}
	}
}

export class RateLimiter<K extends string> {
	private buckets = new Map<K, Bucket>()
	private readonly specs: Record<K, BucketSpec>
	private readonly now: () => number

	constructor(specs: Record<K, BucketSpec>, now: () => number = Date.now) {
		this.specs = specs
		this.now = now
	}

	run<T>(key: K, fn: () => Promise<T>): Promise<T> {
		return this.bucket(key).run(fn)
	}

	penalize(key: K, ms: number) {
		this.bucket(key).penalize(ms)
	}

	private bucket(key: K): Bucket {
		let b = this.buckets.get(key)
		if (!b) {
			b = new Bucket(this.specs[key], this.now)
			this.buckets.set(key, b)
		}
		return b
	}
}
