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
	create: { max: 1, windowMs: 10_500 }, // POST /p2p/create: 1 cada 10 s
	edit: { max: 1, windowMs: 10_500 }, // POST /p2p/:uuid/edit: 1 cada 10 s
	pause: { max: 5, windowMs: 61_000 }, // POST /p2p/:uuid/pause: 5/min
	apply: { max: 2, windowMs: 61_000 }, // POST /p2p/:uuid/apply: 2/min
	coins: { max: 2, windowMs: 60_000 }, // GET /coins (público)
} satisfies Record<string, BucketSpec>

export type BucketName = keyof typeof QVAPAY_BUCKETS

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

interface Job {
	urgent: boolean
	go: () => Promise<unknown>
}

class Bucket {
	private stamps: number[] = []
	// En serie, por orden de llegada; las urgentes (una toma del radar y lo que la sigue) pasan delante de las de fondo
	private queue: Job[] = []
	private busy = false
	private readonly spec: BucketSpec
	private readonly now: () => number

	constructor(spec: BucketSpec, now: () => number) {
		this.spec = spec
		this.now = now
	}

	run<T>(fn: () => Promise<T>, urgent = false): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			const job: Job = { urgent, go: () => Promise.resolve().then(fn).then(resolve, reject) }
			const at = urgent ? this.queue.findIndex((j) => !j.urgent) : -1
			if (at < 0) this.queue.push(job)
			else this.queue.splice(at, 0, job)
			void this.pump()
		})
	}

	// Lo que esperaría ahora una llamada (una ventana entera si ya hay otras delante)
	waitMs() {
		if (this.queue.length || this.busy) return this.spec.windowMs
		const t = this.now()
		const live = this.stamps.filter((s) => t - s < this.spec.windowMs)
		return live.length < this.spec.max ? 0 : this.spec.windowMs - (t - live[0])
	}

	// Tras un 429 nadie más entra hasta que pase `ms`
	penalize(ms: number) {
		const until = this.now() + ms
		this.stamps = Array.from({ length: this.spec.max }, () => until - this.spec.windowMs)
	}

	private async pump() {
		if (this.busy) return
		this.busy = true
		try {
			while (this.queue.length) {
				await this.waitTurn()
				// La que toca se decide después de esperar: una urgente que llegó mientras tanto se lleva el turno
				const job = this.queue.shift()!
				this.stamps.push(this.now())
				// Un fallo no bloquea la cola (lo recibe quien la pidió)
				await job.go()
			}
		} finally {
			this.busy = false
		}
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

	run<T>(key: K, fn: () => Promise<T>, urgent = false): Promise<T> {
		return this.bucket(key).run(fn, urgent)
	}

	waitMs(key: K) {
		return this.bucket(key).waitMs()
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
