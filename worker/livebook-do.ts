// El Durable Object del libro en tiempo real (ver livebook.ts): guarda el libro, recibe los eventos del feed,
// lee con las credenciales de la app lo que haga falta y le empuja el libro a los terminales conectados: a los Pro,
// cada cambio al instante; al resto, lo que cambió cada FREE_EVERY_MS. Los eventos llegan por el stream de QvaPay (al
// que se conecta producción desde su alarma, y que se reenvía firmado a staging) y, de respaldo, por el webhook.
// Va aparte porque usa los tipos de Cloudflare (livebook.ts se prueba en Node)

import { COINS } from '../src/terminal/market.ts'
import type { CompletedRates, P2POffer } from '../src/qvapay/types.ts'
import { intentOf } from '../src/terminal/stats.ts'
import { ACT_KEEP, ALARM_MS, Book, FEED_IDLE_MS, feedSign, FREE_EVERY_MS, HOUR_MS, POLL_MS, QVAPAY, READS_PER_MIN, RESYNC_MS, sideKey, sseEvents, STREAM_MAX_MS, STREAM_STALL_MS, TAKE, TICKS, tradeOf, type Act, type FeedEvent, type FeedSample, type LiveEnv, type LiveOffer, type LiveState, type Owner, type Side } from './livebook.ts'

// Las completadas de cada mercado se piden así de seguido, y las tomas cuentan para la actividad durante esto
const DONE_EVERY_MS = 5 * 60_000
const TAKES_KEEP_MS = 30 * 60_000

interface Sock {
	subs: string[]
	pro: boolean
}

export class LiveBook {
	private book = new Book()
	private events = 0
	private lastEvent: number | null = null
	private lastRejected: { at: number; reason: string } | null = null
	// Los últimos eventos tal como llegaron, para ver en el panel qué manda QvaPay
	private recent: FeedSample[] = []
	private readAt = new Map<string, number>()
	// Lados leídos enteros con las credenciales al menos una vez: solo esos se dan por completos (el feed solo trae lo nuevo)
	private synced = new Set<string>()
	// Lados y actividad que cambiaron desde el último envío a los terminales sin Pro
	private freePending = new Set<string>()
	private freeActs = new Set<string>()
	private freeAt = 0
	// Lo que pasó en cada mercado (lo dice el feed), la más reciente primero
	private acts = new Map<string, Act[]>()
	private actsChanged = new Set<string>()
	// El mejor precio de cada mercado cambió (para la lista de mercados de todos los terminales)
	private topDirty = false
	// Para la intención y la actividad de cada mercado: sus operaciones completadas (públicas, se piden cada pocos
	// minutos) y la hora de cada toma reciente (entera o en parte) de la última media hora
	private done = new Map<string, { data: CompletedRates | null; at: number }>()
	private takes = new Map<string, number[]>()
	private freeStats = new Set<string>()
	private want = new Set<string>()
	private reads: number[] = []
	private lastRead: number | null = null
	private readError: string | null = null
	private busy = false
	private streaming = false
	private streamSince: number | null = null
	private streamEvents = 0
	private streamError: string | null = null
	// Tras un 401/402 (sin suscripción) no se reintenta enseguida
	private streamPauseUntil = 0
	// Conexiones al stream y cuánto duró el último corte (lo que pasa en un corte llega luego por el webhook)
	private streamConnects = 0
	private streamEndedAt: number | null = null
	private streamGap: number | null = null
	// Operaciones ya sumadas al volumen en la última hora: el mismo evento puede llegar por el webhook y por el stream
	private volSeen = new Map<string, number>()

	private ctx: DurableObjectState
	private env: LiveEnv

	constructor(ctx: DurableObjectState, env: LiveEnv) {
		this.ctx = ctx
		this.env = env
		this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'))
		// El libro se guarda oferta a oferta (o:uuid) y dueño a dueño (u:uuid): sobrevive a que el objeto se duerma
		this.ctx.blockConcurrencyWhile(async () => {
			for (const o of (await this.ctx.storage.list<LiveOffer>({ prefix: 'o:' })).values()) this.book.offers.set(o.uuid, o)
			for (const [k, w] of await this.ctx.storage.list<Owner>({ prefix: 'u:' })) this.book.owners.set(k.slice(2), w)
			for (const [k, a] of await this.ctx.storage.list<Act[]>({ prefix: 'a:' })) {
				this.acts.set(k.slice(2), a)
				this.takes.set(k.slice(2), a.filter((x) => x.kind === 'taken' || x.kind === 'partial').map((x) => x.t))
			}
			this.recent = (await this.ctx.storage.get<FeedSample[]>('recent')) ?? []
			const meta = await this.ctx.storage.get<{ events: number; lastEvent: number | null; synced?: string[] }>('meta')
			if (meta) Object.assign(this, { events: meta.events, lastEvent: meta.lastEvent, synced: new Set(meta.synced ?? []) })
			// Al arrancar (también tras un despliegue), enseguida: así el stream vuelve a conectarse sin esperar
			await this.ctx.storage.setAlarm(Date.now() + 200)
		})
	}

	async fetch(req: Request) {
		const url = new URL(req.url)
		if (url.pathname === '/event' && req.method === 'POST') return this.onEvent(await req.text())
		if (url.pathname === '/ws') return this.connect(url.searchParams.get('pro') === '1')
		if (url.pathname === '/status') return Response.json(this.state())
		if (url.pathname === '/simulate' && req.method === 'POST') return this.simulate(String(((await req.json().catch(() => ({}))) as { coin?: string }).coin ?? 'BANK_CUP'))
		return new Response('no encontrado', { status: 404 })
	}

	private creds() {
		return !!(this.env.QVAPAY_APP_ID && this.env.QVAPAY_APP_SECRET)
	}

	private feedOn(now = Date.now()) {
		return this.lastEvent !== null && now - this.lastEvent < FEED_IDLE_MS
	}

	private state(): LiveState {
		const now = Date.now()
		return {
			version: 6,
			recent: this.recent,
			mode: this.feedOn(now) ? 'feed' : this.creds() ? 'poll' : 'off',
			events: this.events,
			lastEvent: this.lastEvent,
			lastRejected: this.lastRejected,
			offers: this.book.offers.size,
			owners: this.book.owners.size,
			acts: [...this.acts.values()].reduce((n, a) => n + a.length, 0),
			clients: this.ctx.getWebSockets().length,
			proClients: this.ctx.getWebSockets().filter((ws) => (ws.deserializeAttachment() as Sock | null)?.pro).length,
			creds: this.creds(),
			stream: { on: this.streaming, since: this.streamSince, events: this.streamEvents, error: this.streamError, connects: this.streamConnects, gap: this.streamGap },
			lastRead: this.lastRead,
			readError: this.readError,
		}
	}

	// Lo que reenvía el Worker desde el webhook: { raw, rejected }
	private async onEvent(body: string) {
		let m: { raw?: string; rejected?: string | null }
		try {
			m = JSON.parse(body)
		} catch {
			return Response.json({ ok: false })
		}
		return Response.json({ ok: await this.ingest(String(m.raw ?? ''), m.rejected ?? null) })
	}

	// Un evento del feed (del webhook o del stream): se apunta para el panel, entra al libro y sale hacia los terminales
	private async ingest(raw: string, rejected: string | null) {
		this.recent = [{ at: Date.now(), rejected, body: raw.slice(0, 4000) }, ...this.recent].slice(0, 15)
		await this.ctx.storage.put('recent', this.recent)
		if (rejected) {
			this.lastRejected = { at: Date.now(), reason: rejected }
			return false
		}
		let e: FeedEvent
		try {
			e = JSON.parse(raw)
		} catch {
			return false
		}
		this.events++
		this.lastEvent = Date.now()
		const ch = this.book.apply(e)
		if (ch?.changed) {
			this.broadcast(ch.coin, ch.side)
			// De un dueño que no conocemos aún no sabemos nombre ni reputación: se lee ese lado pronto
			if (ch.unknownOwner) this.want.add(sideKey(ch.coin, ch.side))
		}
		if (ch?.act) {
			this.addAct(ch.coin, ch.act)
			await this.addVolume(e.event, ch.coin, ch.act)
		}
		await this.save()
		if (this.want.size && !this.streaming) await this.soon(1500)
		return true
	}

	private async save() {
		const puts: Record<string, unknown> = { meta: { events: this.events, lastEvent: this.lastEvent, synced: [...this.synced] } }
		const dels: string[] = []
		for (const id of this.book.changed) {
			const o = this.book.offers.get(id)
			if (o) puts[`o:${id}`] = o
			else dels.push(`o:${id}`)
		}
		for (const id of this.book.changedOwners) puts[`u:${id}`] = this.book.owners.get(id)
		for (const coin of this.actsChanged) puts[`a:${coin}`] = this.acts.get(coin)
		this.actsChanged.clear()
		this.book.changed.clear()
		this.book.changedOwners.clear()
		// De 128 en 128, lo más que deja guardar o borrar de una vez
		const keys = Object.keys(puts)
		for (let i = 0; i < keys.length; i += 128) await this.ctx.storage.put(Object.fromEntries(keys.slice(i, i + 128).map((k) => [k, puts[k]])))
		for (let i = 0; i < dels.length; i += 128) await this.ctx.storage.delete(dels.slice(i, i + 128))
	}

	private async soon(ms: number) {
		const at = await this.ctx.storage.getAlarm()
		if (!at || at > Date.now() + ms) await this.ctx.storage.setAlarm(Date.now() + ms)
	}

	private connect(pro: boolean) {
		const pair = new WebSocketPair()
		const [client, server] = Object.values(pair)
		this.ctx.acceptWebSocket(server)
		server.serializeAttachment({ subs: [], pro } satisfies Sock)
		server.send(JSON.stringify({ t: 'hello', feed: this.feedOn(), pro, every: pro ? 0 : FREE_EVERY_MS }))
		return new Response(null, { status: 101, webSocket: client })
	}

	// El terminal dice qué mercados quiere (el que mira y los del radar): se le manda su libro y desde entonces cada cambio
	async webSocketMessage(ws: WebSocket, msg: string | ArrayBuffer) {
		if (typeof msg !== 'string' || msg.length > 1000) return
		let m: { sub?: unknown }
		try {
			m = JSON.parse(msg)
		} catch {
			return
		}
		if (!Array.isArray(m.sub)) return
		const subs = [...new Set(m.sub.map(String).filter((c) => TICKS.has(c)))].slice(0, TICKS.size)
		const was = ws.deserializeAttachment() as Sock | null
		const before = new Set(was?.subs ?? [])
		ws.serializeAttachment({ subs, pro: !!was?.pro } satisfies Sock)
		// La lista de mercados siempre va al día (el mejor precio de cada uno)
		if (!before.size) ws.send(this.topMsg())
		for (const coin of subs) {
			if (before.has(coin)) continue
			ws.send(this.actMsg(coin))
			ws.send(this.statsMsg(coin))
			for (const side of ['ask', 'bid'] as const) {
				ws.send(this.sideMsg(coin, side))
				// Un mercado que alguien empieza a mirar se lee ya si aún no está completo o, sin el feed, si su lectura es vieja
				const k = sideKey(coin, side)
				if (!this.synced.has(k) || (!this.feedOn() && Date.now() - (this.readAt.get(k) ?? 0) > POLL_MS)) this.want.add(k)
			}
		}
		if (this.want.size && !this.streaming) await this.soon(200)
	}

	async webSocketClose(ws: WebSocket, code: number) {
		try {
			ws.close(code === 1005 ? 1000 : code, 'adiós')
		} catch {}
	}

	private sideMsg(coin: string, side: Side) {
		// ready: el lado está completo (si no, el terminal sigue leyéndolo con su token)
		const ready = this.synced.has(sideKey(coin, side))
		return JSON.stringify({ t: 'side', coin, side, ready, levels: ready ? this.book.levels(coin, side) : [], total: this.book.count(coin, side), at: Date.now(), feed: this.feedOn() })
	}

	private actMsg(coin: string) {
		return JSON.stringify({ t: 'act', coin, items: this.book.named(this.acts.get(coin) ?? []) })
	}

	// Intención (con el libro completo y lo completado) y actividad (las tomas de la última media hora; el terminal las va
	// pesando según su edad, así el número baja solo entre una y otra) de un mercado
	private statsMsg(coin: string) {
		const now = Date.now()
		const done = this.done.get(coin)?.data ?? null
		const ready = this.synced.has(sideKey(coin, 'ask')) && this.synced.has(sideKey(coin, 'bid'))
		const takes = (this.takes.get(coin) ?? []).filter((t) => now - t < TAKES_KEEP_MS)
		return JSON.stringify({
			t: 'stats',
			coin,
			intent: ready && this.done.has(coin) ? intentOf(this.book.levels(coin, 'ask', 500), this.book.levels(coin, 'bid', 500), done) : null,
			takes,
			pace: done?.count && done.window_hours ? done.count / done.window_hours / 60 : null,
			at: now,
		})
	}

	// A los Pro, ya; a los demás, en el próximo envío periódico
	private pushStats(coin: string) {
		this.freeStats.add(coin)
		const to = this.subscribers(coin).filter((ws) => (ws.deserializeAttachment() as Sock | null)?.pro)
		if (!to.length) return
		const msg = this.statsMsg(coin)
		for (const ws of to)
			try {
				ws.send(msg)
			} catch {}
	}

	// El mejor precio de cada mercado y lado (las primeras ofertas; el terminal salta las solo-VIP y las de precio raro)
	private topMsg() {
		const top: Record<string, { ask: unknown[]; bid: unknown[] }> = {}
		for (const c of COINS) {
			if (!this.synced.has(sideKey(c.tick, 'ask')) || !this.synced.has(sideKey(c.tick, 'bid'))) continue
			top[c.tick] = { ask: this.book.levels(c.tick, 'ask', 5), bid: this.book.levels(c.tick, 'bid', 5) }
		}
		return JSON.stringify({ t: 'top', top, at: Date.now() })
	}

	// Suma la operación a su hora en D1 (una fila por mercado, hora y lado). Si falla, se pierde esa y nada más
	private async addVolume(event: string, coin: string, a: Act) {
		const n = tradeOf(event, a)
		if (!n) return
		const now = Date.now()
		const key = `${event}:${a.uuid}:${a.kind}:${a.t}:${a.usd}`
		if (this.volSeen.has(key)) return
		for (const [k, t] of this.volSeen) if (now - t > HOUR_MS) this.volSeen.delete(k)
		this.volSeen.set(key, now)
		try {
			await this.env.DB.prepare('INSERT INTO volume (coin, hour, side, ops, usd) VALUES (?, ?, ?, ?, ?) ON CONFLICT (coin, hour, side) DO UPDATE SET ops = ops + excluded.ops, usd = usd + excluded.usd')
				.bind(coin, Math.floor(a.t / HOUR_MS) * HOUR_MS, a.side === 'ask' ? 'sell' : 'buy', n, n * a.usd)
				.run()
		} catch (err) {
			console.error(`volumen: ${(err as Error).message}`)
		}
	}

	private addAct(coin: string, a: Act) {
		const list = this.acts.get(coin) ?? []
		if (list.some((x) => x.uuid === a.uuid && x.kind === a.kind && x.t === a.t)) return
		this.acts.set(coin, [a, ...list].sort((x, y) => y.t - x.t).slice(0, ACT_KEEP))
		this.actsChanged.add(coin)
		this.freeActs.add(coin)
		if (a.kind === 'taken' || a.kind === 'partial') {
			const now = Date.now()
			this.takes.set(coin, [...(this.takes.get(coin) ?? []).filter((t) => now - t < TAKES_KEEP_MS), a.t])
		}
		const msg = this.actMsg(coin)
		for (const ws of this.subscribers(coin).filter((w) => (w.deserializeAttachment() as Sock | null)?.pro))
			try {
				ws.send(msg)
			} catch {}
		this.pushStats(coin)
	}

	private subscribers(coin: string) {
		return this.ctx.getWebSockets().filter((ws) => ((ws.deserializeAttachment() as Sock | null)?.subs ?? []).includes(coin))
	}

	// A los Pro, ya; a los demás, en el próximo envío periódico (flushFree)
	private broadcast(coin: string, side: Side) {
		const to = this.subscribers(coin).filter((ws) => (ws.deserializeAttachment() as Sock | null)?.pro)
		this.freePending.add(sideKey(coin, side))
		this.topDirty = true
		if (to.length) {
			const msg = this.sideMsg(coin, side)
			for (const ws of to)
				try {
					ws.send(msg)
				} catch {}
		}
		this.pushStats(coin)
	}

	// Cada FREE_EVERY_MS: a los terminales sin Pro, los lados y la actividad que cambiaron; a todos, la lista de mercados
	private flushFree(now: number) {
		if (now - this.freeAt < FREE_EVERY_MS - 500 || (!this.freePending.size && !this.freeActs.size && !this.freeStats.size && !this.topDirty)) return
		this.freeAt = now
		const all = this.ctx.getWebSockets()
		const free = all.filter((ws) => !(ws.deserializeAttachment() as Sock | null)?.pro)
		const send = (msg: string, to: WebSocket[]) => {
			for (const ws of to)
				try {
					ws.send(msg)
				} catch {}
		}
		const subs = (coin: string) => free.filter((ws) => ((ws.deserializeAttachment() as Sock | null)?.subs ?? []).includes(coin))
		for (const k of this.freePending) {
			const [coin, side] = k.split(':') as [string, Side]
			const to = subs(coin)
			if (to.length) send(this.sideMsg(coin, side), to)
		}
		for (const coin of this.freeActs) {
			const to = subs(coin)
			if (to.length) send(this.actMsg(coin), to)
		}
		for (const coin of this.freeStats) {
			const to = subs(coin)
			if (to.length) send(this.statsMsg(coin), to)
		}
		if (this.topDirty && all.length) send(this.topMsg(), all)
		this.freePending.clear()
		this.freeActs.clear()
		this.freeStats.clear()
		this.topDirty = false
	}

	// Cada pocos segundos: lo periódico y, en producción, escuchar el stream de QvaPay hasta que se corte
	async alarm() {
		await this.periodic()
		const stream = !this.env.STAGING && this.creds() && Date.now() >= this.streamPauseUntil
		if (stream) await this.stream()
		await this.ctx.storage.setAlarm(Date.now() + (stream ? 1000 : this.want.size ? 2000 : ALARM_MS))
	}

	// Leer con las credenciales de la app lo que haga falta (dueños nuevos, lados viejos o, sin feed, lo que se mira) y
	// mandar a los terminales sin Pro lo que cambió
	private async periodic() {
		if (this.busy) return
		this.busy = true
		try {
			const now = Date.now()
			this.book.prune(now)
			this.flushFree(now)
			const watched = new Set(this.ctx.getWebSockets().flatMap((ws) => (ws.deserializeAttachment() as Sock | null)?.subs ?? []))
			const feed = this.feedOn(now)
			for (const coin of COINS.map((c) => c.tick))
				for (const side of ['ask', 'bid'] as const) {
					const k = sideKey(coin, side)
					const age = now - (this.readAt.get(k) ?? 0)
					// Con el feed, todo se repasa cada RESYNC_MS; sin él, lo que alguien mira cada POLL_MS
					if (feed ? age > RESYNC_MS : watched.has(coin) && age > POLL_MS) this.want.add(k)
				}
			// Las completadas de un mercado que se mira (públicas, sin credenciales), cada DONE_EVERY_MS; una por pasada
			const doneDue = [...watched].filter((c) => now - (this.done.get(c)?.at ?? 0) > DONE_EVERY_MS).sort((a, b) => (this.done.get(a)?.at ?? 0) - (this.done.get(b)?.at ?? 0))[0]
			if (doneDue) await this.readDone(doneDue)
			const due = [...this.want].sort((a, b) => (this.readAt.get(a) ?? 0) - (this.readAt.get(b) ?? 0))
			this.reads = this.reads.filter((t) => now - t < 60_000)
			let changed = false
			for (const k of due) {
				if (!this.creds() || this.reads.length >= READS_PER_MIN) break
				// Como mucho dos por pasada: el resto en la siguiente
				if (this.reads.length && now - this.reads[this.reads.length - 1] < 2000) break
				this.want.delete(k)
				const [coin, side] = k.split(':') as [string, Side]
				this.reads.push(Date.now())
				if (await this.read(coin, side)) changed = true
			}
			if (changed) await this.save()
		} finally {
			this.busy = false
		}
	}

	// El stream de QvaPay (los mismos eventos que el webhook, al momento). Mientras está abierto, lo periódico sigue con
	// un temporizador. QvaPay lo corta cada pocos minutos: al volver de aquí, la alarma reconecta al segundo
	private async stream() {
		const ac = new AbortController()
		const stop = setTimeout(() => ac.abort(), STREAM_MAX_MS)
		// QvaPay manda una señal de vida cada 25 s: si en STREAM_STALL_MS no llega nada, la conexión se colgó y se rehace
		let heard = Date.now()
		const watch = setInterval(() => Date.now() - heard > STREAM_STALL_MS && ac.abort(), 10_000)
		const tick = setInterval(() => void this.periodic().catch(() => {}), 2500)
		this.streaming = true
		this.streamSince = Date.now()
		try {
			const res = await fetch(`${QVAPAY}/v2/p2p/stream`, {
				headers: { 'app-id': this.env.QVAPAY_APP_ID!, 'app-secret': this.env.QVAPAY_APP_SECRET!, Accept: 'text/event-stream' },
				signal: ac.signal,
			})
			if (!res.ok || !res.body) {
				this.streamError = `QvaPay respondió ${res.status}`
				// Sin suscripción o sin permiso: se vuelve a probar en 10 minutos
				if (res.status === 401 || res.status === 402 || res.status === 403) this.streamPauseUntil = Date.now() + 10 * 60_000
				return
			}
			this.streamError = null
			this.streamConnects++
			this.streamGap = this.streamEndedAt ? Date.now() - this.streamEndedAt : null
			// Lo que pasó mientras estaba cortado: se releen ya los mercados que alguien mira
			if (this.streamGap === null || this.streamGap > 5000)
				for (const coin of new Set(this.ctx.getWebSockets().flatMap((ws) => (ws.deserializeAttachment() as Sock | null)?.subs ?? [])))
					for (const side of ['ask', 'bid'] as const) this.want.add(sideKey(coin, side))
			const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
			let buffer = ''
			for (;;) {
				const { value, done } = await reader.read()
				if (done) break
				heard = Date.now()
				const r = sseEvents(buffer + value)
				buffer = r.rest
				for (const ev of r.events) {
					if (ev.event === 'subscription_expired') {
						this.streamError = 'La suscripción al feed venció'
						this.streamPauseUntil = Date.now() + 10 * 60_000
						return
					}
					if (!ev.event.startsWith('p2p.')) continue
					this.streamEvents++
					await this.ingest(ev.data, null)
					await this.forward(ev.data)
				}
			}
		} catch (e) {
			if ((e as Error).name !== 'AbortError') this.streamError = (e as Error).message
			else if (Date.now() - heard > STREAM_STALL_MS) this.streamError = 'se colgó (sin señal de vida): se reconecta'
		} finally {
			clearTimeout(stop)
			clearInterval(watch)
			clearInterval(tick)
			this.streaming = false
			this.streamEndedAt = Date.now()
		}
	}

	// A staging, firmado con el secreto del feed como lo firma QvaPay (el webhook de staging lo verifica igual)
	private async forward(raw: string) {
		if (!this.env.FEED_FORWARD?.startsWith('https://') || !this.env.QVAPAY_FEED_SECRET) return
		const headers = { 'Content-Type': 'application/json', ...(await feedSign(raw, this.env.QVAPAY_FEED_SECRET)) }
		this.ctx.waitUntil(fetch(this.env.FEED_FORWARD, { method: 'POST', body: raw, headers, signal: AbortSignal.timeout(8000) }).catch(() => {}))
	}

	private async readDone(coin: string) {
		const had = this.done.get(coin)
		this.done.set(coin, { data: had?.data ?? null, at: Date.now() })
		try {
			const res = await fetch(`${QVAPAY}/p2p/completed_pairs_average?coin=${encodeURIComponent(coin)}`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10_000) })
			if (!res.ok) throw new Error(String(res.status))
			this.done.set(coin, { data: (await res.json()) as CompletedRates, at: Date.now() })
			this.pushStats(coin)
		} catch {
			// Se reintenta antes (en un minuto) en vez de esperar el ciclo entero
			this.done.set(coin, { data: had?.data ?? null, at: Date.now() - DONE_EVERY_MS + 60_000 })
		}
	}

	private async read(coin: string, side: Side) {
		const k = sideKey(coin, side)
		this.readAt.set(k, Date.now())
		try {
			const q = new URLSearchParams({ type: side === 'ask' ? 'sell' : 'buy', coin, orderBy: 'best_rate', orderType: 'desc', take: String(TAKE) })
			const res = await fetch(`${QVAPAY}/p2p?${q}`, { headers: { 'app-id': this.env.QVAPAY_APP_ID!, 'app-secret': this.env.QVAPAY_APP_SECRET!, Accept: 'application/json' }, signal: AbortSignal.timeout(10_000) })
			if (!res.ok) throw new Error(`QvaPay respondió ${res.status}`)
			const body = (await res.json()) as { data?: P2POffer[]; promoted?: { offer?: P2POffer } }
			const promoted = body.promoted?.offer
			const list = promoted ? [promoted, ...(body.data ?? []).filter((o) => o.uuid !== promoted.uuid)] : (body.data ?? [])
			this.book.merge(coin, side, list)
			this.synced.add(k)
			this.lastRead = Date.now()
			this.readError = null
			this.broadcast(coin, side)
			return true
		} catch (e) {
			this.readError = (e as Error).message
			return false
		}
	}

	private async simulate(coin: string) {
		if (!this.env.STAGING) return Response.json({ ok: false, error: 'Solo en staging' }, { status: 403 })
		const best = this.book.levels(coin, 'ask', 1)[0]
		const base = [...this.book.offers.values()].find((o) => o.uuid === best?.uuid)
		if (!base) return Response.json({ ok: false, error: 'No hay ventas en el libro de ese mercado: espera a que se lea' })
		const uuid = crypto.randomUUID()
		const price = Math.round(base.price * 0.99 * 100) / 100
		const usd = 20
		const r = this.book.apply({
			event: 'p2p.created',
			data: { uuid, type: 'sell', coin, amount: String(usd), receive: String(Math.round(price * usd * 100) / 100), status: 'open', updated_at: new Date().toISOString(), offer_kind: 'fixed', owner_uuid: base.owner, only_vip: false, requirements: null },
		})
		this.broadcast(coin, 'ask')
		if (r?.act) this.addAct(coin, r.act)
		await this.save()
		return Response.json({ ok: true, offer: uuid, price })
	}
}
