// El Durable Object del libro en tiempo real (ver livebook.ts): guarda el libro, recibe los eventos del feed,
// lee con las credenciales de la app lo que haga falta y le empuja el libro a los terminales conectados: a los Pro,
// cada cambio al instante; al resto, lo que cambió cada FREE_EVERY_MS. Los eventos llegan por el stream de QvaPay (al
// que se conecta producción desde su alarma, y que se reenvía firmado a staging) y, de respaldo, por el webhook.
// Va aparte porque usa los tipos de Cloudflare (livebook.ts se prueba en Node)

import { COINS } from '../src/terminal/market.ts'
import type { P2POffer } from '../src/qvapay/types.ts'
import { ALARM_MS, Book, FEED_IDLE_MS, feedSign, FREE_EVERY_MS, POLL_MS, QVAPAY, READS_PER_MIN, RESYNC_MS, sideKey, sseEvents, STREAM_MAX_MS, TAKE, TICKS, type FeedEvent, type FeedSample, type LiveEnv, type LiveOffer, type LiveState, type Owner, type Side } from './livebook.ts'

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
	// Lados que cambiaron desde el último envío a los terminales sin Pro
	private freePending = new Set<string>()
	private freeAt = 0
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
			this.recent = (await this.ctx.storage.get<FeedSample[]>('recent')) ?? []
			const meta = await this.ctx.storage.get<{ events: number; lastEvent: number | null; synced?: string[] }>('meta')
			if (meta) Object.assign(this, { events: meta.events, lastEvent: meta.lastEvent, synced: new Set(meta.synced ?? []) })
			if (!(await this.ctx.storage.getAlarm())) await this.ctx.storage.setAlarm(Date.now() + ALARM_MS)
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
			version: 3,
			recent: this.recent,
			mode: this.feedOn(now) ? 'feed' : this.creds() ? 'poll' : 'off',
			events: this.events,
			lastEvent: this.lastEvent,
			lastRejected: this.lastRejected,
			offers: this.book.offers.size,
			owners: this.book.owners.size,
			clients: this.ctx.getWebSockets().length,
			proClients: this.ctx.getWebSockets().filter((ws) => (ws.deserializeAttachment() as Sock | null)?.pro).length,
			creds: this.creds(),
			stream: { on: this.streaming, since: this.streamSince, events: this.streamEvents, error: this.streamError },
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
		if (ch) {
			this.broadcast(ch.coin, ch.side)
			// De un dueño que no conocemos aún no sabemos nombre ni reputación: se lee ese lado pronto
			if (ch.unknownOwner) this.want.add(sideKey(ch.coin, ch.side))
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
		for (const coin of subs) {
			if (before.has(coin)) continue
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

	private subscribers(coin: string) {
		return this.ctx.getWebSockets().filter((ws) => ((ws.deserializeAttachment() as Sock | null)?.subs ?? []).includes(coin))
	}

	// A los Pro, ya; a los demás, en el próximo envío periódico (flushFree)
	private broadcast(coin: string, side: Side) {
		const to = this.subscribers(coin).filter((ws) => (ws.deserializeAttachment() as Sock | null)?.pro)
		this.freePending.add(sideKey(coin, side))
		if (!to.length) return
		const msg = this.sideMsg(coin, side)
		for (const ws of to)
			try {
				ws.send(msg)
			} catch {}
	}

	private flushFree(now: number) {
		if (now - this.freeAt < FREE_EVERY_MS - 500 || !this.freePending.size) return
		this.freeAt = now
		const free = this.ctx.getWebSockets().filter((ws) => !(ws.deserializeAttachment() as Sock | null)?.pro)
		for (const k of this.freePending) {
			const [coin, side] = k.split(':') as [string, Side]
			const to = free.filter((ws) => ((ws.deserializeAttachment() as Sock | null)?.subs ?? []).includes(coin))
			if (!to.length) continue
			const msg = this.sideMsg(coin, side)
			for (const ws of to)
				try {
					ws.send(msg)
				} catch {}
		}
		this.freePending.clear()
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
			const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
			let buffer = ''
			for (;;) {
				const { value, done } = await reader.read()
				if (done) break
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
		} finally {
			clearTimeout(stop)
			clearInterval(tick)
			this.streaming = false
		}
	}

	// A staging, firmado con el secreto del feed como lo firma QvaPay (el webhook de staging lo verifica igual)
	private async forward(raw: string) {
		if (!this.env.FEED_FORWARD?.startsWith('https://') || !this.env.QVAPAY_FEED_SECRET) return
		const headers = { 'Content-Type': 'application/json', ...(await feedSign(raw, this.env.QVAPAY_FEED_SECRET)) }
		this.ctx.waitUntil(fetch(this.env.FEED_FORWARD, { method: 'POST', body: raw, headers, signal: AbortSignal.timeout(8000) }).catch(() => {}))
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
		this.book.apply({
			event: 'p2p.created',
			data: { uuid, type: 'sell', coin, amount: String(usd), receive: String(Math.round(price * usd * 100) / 100), status: 'open', updated_at: new Date().toISOString(), offer_kind: 'fixed', owner_uuid: base.owner, only_vip: false, requirements: null },
		})
		this.broadcast(coin, 'ask')
		await this.save()
		return Response.json({ ok: true, offer: uuid, price })
	}
}
