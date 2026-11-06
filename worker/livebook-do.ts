// El Durable Object del libro en tiempo real (ver livebook.ts): guarda el libro, recibe los eventos del feed,
// lee con las credenciales de la app lo que haga falta y le empuja el libro a los terminales conectados: a los Pro,
// cada cambio al instante; al resto, lo que cambió cada FREE_EVERY_MS. Los eventos llegan por el stream de QvaPay (al
// que se conecta producción desde su alarma, y que se reenvía firmado a staging) y, de respaldo, por el webhook.
// Va aparte porque usa los tipos de Cloudflare (livebook.ts se prueba en Node)

import { COINS } from '../src/terminal/market.ts'
import type { CompletedRates, P2POffer } from '../src/qvapay/types.ts'
import { intentOf } from '../src/terminal/stats.ts'
import { ACT_KEEP, ALARM_MS, LAG_KEEP, lagStats, Book, FEED_IDLE_MS, feedSign, FREE_EVERY_MS, HOUR_MS, LIVE_VERSION, POLL_MS, QVAPAY, READS_PER_MIN, RESYNC_MS, sideKey, sseEvents, STREAM_MAX_MS, STREAM_STALL_MS, TAKE, TICKS, type Act, type BookRefs, type BookSnapshot, type FeedEvent, type FeedSample, type LiveEnv, type LiveOffer, type LiveState, type Owner, type Side, type Trade } from './livebook.ts'
import { NOTICE_MAX_AGE_MS, NOTICES_PER_HOUR, offerNotice, offerWatchers, sendNotice, WATCH_TTL_MS, type Notice } from './offeralerts.ts'
import type { BotEnv } from './userbot.ts'
import { alertOther, OtherMarkets, saveOther } from './othermarkets.ts'
import type { AlertEnv } from './alerts.ts'
import { deliverPush, ownerPush, pushTargets, takerPush, TARGETS_TTL_MS, type PushEnv, type PushNotice } from './push.ts'

// Las completadas de cada mercado se piden así de seguido, y las tomas cuentan para la actividad durante esto
const DONE_EVERY_MS = 5 * 60_000
// Las mejores de cada lado que ve la mini app
const BOOK_TOP = 30
const TAKES_KEEP_MS = 30 * 60_000
// Los otros mercados (othermarkets.ts) se guardan en D1 cada tanto, y el umbral se mira cada hora
const OTHER_SAVE_MS = 60_000
const OTHER_ALERT_MS = 60 * 60_000

interface Sock {
	subs: string[]
	pro: boolean
	// De qué cuenta es y desde cuándo está conectado (para el panel: quién tiene el terminal abierto ahora)
	u?: string | null
	at?: number
}

export class LiveBook {
	private book = new Book()
	private events = 0
	private lastEvent: number | null = null
	private lastRejected: { at: number; reason: string } | null = null
	// Avisos de las ofertas por Telegram (offeralerts.ts): los ya enviados (el mismo evento llega dos veces), quién los
	// tiene activados (se relee cada WATCH_TTL_MS) y cuántos salieron a cada cuenta en la última hora
	private noticed = new Map<string, number>()
	private watch: { at: number; map: Promise<Map<string, string>> } | null = null
	private noticeTimes = new Map<string, number[]>()
	// Avisos push (push.ts): los ya enviados, quién puede recibirlos (se relee cada TARGETS_TTL_MS o al momento cuando
	// alguien los activa) y los envíos de la última hora de cada navegador
	private pushed = new Map<string, number>()
	private pushT: { at: number; t: Promise<{ owners: Set<string>; offers: Set<string> }> } | null = null
	private pushTimes = new Map<string, number[]>()
	// Los últimos eventos tal como llegaron, para ver en el panel qué manda QvaPay
	private recent: FeedSample[] = []
	// Los mercados que el terminal no sigue, contados para saber si tienen movimiento
	private others = new OtherMarkets(TICKS)
	private otherSavedAt = 0
	private otherAlertAt = 0
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
	// Cuánto tardan en llegar los eventos (desde que QvaPay los manda y desde que cambió la oferta), los últimos LAG_KEEP
	private lags = { sent: [] as number[], upd: [] as number[] }

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
			for (const [k, f] of await this.ctx.storage.list<{ usd: number; at: number }>({ prefix: 'f:' })) this.book.filled.set(k.slice(2), f)
			for (const [k, t] of await this.ctx.storage.list<number>({ prefix: 'd:' })) this.book.completed.set(k.slice(2), t)
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
		if (url.pathname === '/push-refresh') return (this.pushT = null), Response.json({ ok: true })
		if (url.pathname === '/push-sim' && req.method === 'POST') return Response.json(await this.pushSim(await req.json()))
		if (url.pathname === '/ws') return this.connect(url.searchParams.get('pro') === '1', url.searchParams.get('u') || null)
		if (url.pathname === '/clients') return Response.json(this.clients())
		if (url.pathname === '/book') return this.bookOf(url.searchParams.get('coin') ?? '')
		if (url.pathname === '/offer') return Response.json(this.book.find(url.searchParams.get('id') ?? ''))
		if (url.pathname === '/status') return Response.json(this.state())
		if (url.pathname === '/snapshot' && req.method === 'POST') return Response.json(this.snapshot(((await req.json().catch(() => ({}))) as { refs?: BookRefs }).refs ?? {}))
		if (url.pathname === '/simulate' && req.method === 'POST') return this.simulate(String(((await req.json().catch(() => ({}))) as { coin?: string }).coin ?? 'BANK_CUP'))
		return new Response('no encontrado', { status: 404 })
	}

	private creds() {
		return !!(this.env.QVAPAY_APP_ID && this.env.QVAPAY_APP_SECRET)
	}

	private feedOn(now = Date.now()) {
		return this.lastEvent !== null && now - this.lastEvent < FEED_IDLE_MS
	}

	// La foto del libro para el histórico (bookstats.ts): cada lado completo de cada mercado
	private snapshot(refs: BookRefs): BookSnapshot {
		const now = Date.now()
		const sides: BookSnapshot['sides'] = []
		for (const c of COINS)
			for (const side of ['ask', 'bid'] as const)
				if (this.synced.has(sideKey(c.tick, side))) sides.push({ coin: c.tick, side, stat: this.book.stats(c.tick, side, refs[c.tick]?.[side] ?? null, now) })
		return { stale: !this.feedOn(now), sides }
	}

	// Un mercado entero para la mini app de QvaPay (solo mirar, sin cuenta): lo mismo que un terminal sin Pro. Un lado
	// que aún no está completo se pide a QvaPay y sale vacío (ready: false) hasta la próxima consulta
	private async bookOf(coin: string) {
		if (!TICKS.has(coin)) return Response.json({ error: 'Mercado desconocido' }, { status: 400 })
		const side = (s: Side) => {
			const k = sideKey(coin, s)
			const ready = this.synced.has(k)
			if (!ready || (!this.feedOn() && Date.now() - (this.readAt.get(k) ?? 0) > POLL_MS)) this.want.add(k)
			return { ready, levels: ready ? this.book.levels(coin, s, BOOK_TOP) : [], total: this.book.count(coin, s) }
		}
		const out = { coin, at: Date.now(), feed: this.feedOn(), version: LIVE_VERSION, ask: side('ask'), bid: side('bid') }
		if (this.want.size && !this.streaming) await this.soon(200)
		return Response.json(out)
	}

	// Quién tiene el terminal abierto: la última señal es el último «ping» del terminal (cada 25 s), al que contesta
	// Cloudflare sin despertar este objeto
	private clients() {
		return this.ctx.getWebSockets().map((ws) => {
			const s = ws.deserializeAttachment() as Sock | null
			return { u: s?.u ?? null, pro: !!s?.pro, subs: s?.subs ?? [], at: s?.at ?? null, seen: this.ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime() ?? null }
		})
	}

	private state(): LiveState {
		const now = Date.now()
		return {
			version: LIVE_VERSION,
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
			lag: { sent: lagStats(this.lags.sent), upd: lagStats(this.lags.upd) },
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
		this.addLag(e)
		if (this.others.add(e)) await this.saveOthers()
		const ch = this.book.apply(e)
		this.notice(e, ch?.trade ?? null)
		this.push(e, ch?.trade ?? null)
		let unknown = false
		if (ch?.changed) {
			this.broadcast(ch.coin, ch.side)
			// De un dueño que no conocemos aún no sabemos nombre ni reputación (el radar no la toma sin ellos): ese lado se
			// lee ya, sin esperar a la próxima pasada
			if (ch.unknownOwner) {
				unknown = true
				this.want.add(sideKey(ch.coin, ch.side))
			}
		}
		if (ch?.act) this.addAct(ch.coin, ch.act)
		if (ch?.trade) await this.addVolume(ch.coin, ch.trade)
		await this.save()
		if (unknown && this.streaming) void this.periodic().catch(() => {})
		else if (this.want.size && !this.streaming) await this.soon(unknown ? 100 : 1500)
		return true
	}

	// Si el dueño de la oferta activó los avisos de sus ofertas, se le escribe por Telegram (sin esperar: el libro sigue)
	private notice(e: FeedEvent, trade: Trade | null) {
		const n = offerNotice(e, trade)
		if (!n || this.noticed.has(n.key)) return
		const now = Date.now()
		this.noticed.set(n.key, now)
		if (this.noticed.size > 2000) for (const [k, t] of this.noticed) if (now - t > 2 * NOTICE_MAX_AGE_MS) this.noticed.delete(k)
		this.ctx.waitUntil(this.sendNotice(n, now).catch((err) => console.error(`aviso de oferta: ${(err as Error).message}`)))
	}

	private async sendNotice(n: Notice, now: number) {
		if (!this.watch || now - this.watch.at > WATCH_TTL_MS) this.watch = { at: now, map: offerWatchers(this.env.DB, now).catch(() => new Map<string, string>()) }
		const license = (await this.watch.map).get(n.owner.toLowerCase())
		if (!license) return
		const sent = (this.noticeTimes.get(license) ?? []).filter((t) => now - t < HOUR_MS)
		if (sent.length >= NOTICES_PER_HOUR) return
		sent.push(now)
		this.noticeTimes.set(license, sent)
		await sendNotice(this.env as unknown as BotEnv, license, n.text)
	}

	// Avisos push al dueño de la oferta y a quien la tomó desde el terminal (sin esperar: el libro sigue)
	private push(e: FeedEvent, trade: Trade | null) {
		const d = e?.data
		if (!d?.uuid || !(this.env as unknown as PushEnv).VAPID_PRIVATE_JWK) return
		this.ctx.waitUntil(this.pushNow(e, trade).catch((err) => console.error(`aviso push: ${(err as Error).message}`)))
	}

	private async pushNow(e: FeedEvent, trade: Trade | null, now = Date.now()) {
		if (!this.pushT || now - this.pushT.at > TARGETS_TTL_MS) this.pushT = { at: now, t: pushTargets(this.env.DB, now).catch(() => ({ owners: new Set<string>(), offers: new Set<string>() })) }
		const t = await this.pushT.t
		const list: PushNotice[] = []
		const owner = e.data.owner_uuid?.toLowerCase()
		if (owner && t.owners.has(owner)) {
			const n = ownerPush(e, trade, now)
			if (n) list.push(n)
		}
		if (t.offers.has(e.data.uuid.toLowerCase())) {
			const n = takerPush(e, now)
			if (n) list.push({ ...n, offer: e.data.uuid.toLowerCase() })
		}
		let sent = 0
		for (const n of list) {
			if (this.pushed.has(n.key)) continue
			this.pushed.set(n.key, now)
			sent += await deliverPush(this.env as unknown as PushEnv, n, now, this.pushTimes)
			if (n.end) t.offers.delete(n.offer!)
		}
		if (this.pushed.size > 2000) for (const [k, at] of this.pushed) if (now - at > 3_600_000) this.pushed.delete(k)
		return { notices: list.length, sent }
	}

	// Staging y local: un evento inventado (push.ts, simEvent) pasa por el mismo camino que uno del feed, sin tocar el libro
	private async pushSim(e: FeedEvent) {
		this.pushT = null
		return this.pushNow(e, null)
	}

	private addLag(e: FeedEvent) {
		const now = Date.now()
		const push = (list: number[], at: string | undefined) => {
			const t = Date.parse(at ?? '')
			if (!Number.isFinite(t)) return
			list.push(now - t)
			if (list.length > LAG_KEEP) list.shift()
		}
		push(this.lags.sent, e.sent_at)
		push(this.lags.upd, e.data?.updated_at)
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
		for (const k of this.book.changedTrades) puts[k] = k.startsWith('f:') ? this.book.filled.get(k.slice(2)) : this.book.completed.get(k.slice(2))
		dels.push(...this.book.pruneTrades())
		for (const coin of this.actsChanged) puts[`a:${coin}`] = this.acts.get(coin)
		this.actsChanged.clear()
		this.book.changed.clear()
		this.book.changedOwners.clear()
		this.book.changedTrades.clear()
		// De 128 en 128, lo más que deja guardar o borrar de una vez
		const keys = Object.keys(puts)
		for (let i = 0; i < keys.length; i += 128) await this.ctx.storage.put(Object.fromEntries(keys.slice(i, i + 128).map((k) => [k, puts[k]])))
		for (let i = 0; i < dels.length; i += 128) await this.ctx.storage.delete(dels.slice(i, i + 128))
	}

	private async soon(ms: number) {
		const at = await this.ctx.storage.getAlarm()
		if (!at || at > Date.now() + ms) await this.ctx.storage.setAlarm(Date.now() + ms)
	}

	private connect(pro: boolean, u: string | null) {
		const pair = new WebSocketPair()
		const [client, server] = Object.values(pair)
		this.ctx.acceptWebSocket(server)
		server.serializeAttachment({ subs: [], pro, u, at: Date.now() } satisfies Sock)
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
		ws.serializeAttachment({ ...was, subs, pro: !!was?.pro } satisfies Sock)
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
	private async addVolume(coin: string, tr: Trade) {
		try {
			await this.env.DB.prepare('INSERT INTO volume (coin, hour, side, ops, usd) VALUES (?, ?, ?, ?, ?) ON CONFLICT (coin, hour, side) DO UPDATE SET ops = ops + excluded.ops, usd = usd + excluded.usd')
				.bind(coin, Math.floor(tr.t / HOUR_MS) * HOUR_MS, tr.side === 'ask' ? 'sell' : 'buy', tr.ops, tr.ops * tr.usd)
				.run()
		} catch (err) {
			console.error(`volumen: ${(err as Error).message}`)
		}
	}

	// Lo contado de los otros mercados, a D1 como mucho cada OTHER_SAVE_MS; y cada hora, el aviso de los que pasan el
	// umbral. Si D1 falla se pierde esa tanda y nada más
	private async saveOthers(now = Date.now()) {
		if (this.others.hasPending() && now - this.otherSavedAt >= OTHER_SAVE_MS) {
			this.otherSavedAt = now
			await saveOther(this.env.DB, this.others.take()).catch((err) => console.error(`otros mercados: ${(err as Error).message}`))
		}
		if (now - this.otherAlertAt >= OTHER_ALERT_MS && this.otherSavedAt) {
			this.otherAlertAt = now
			this.ctx.waitUntil(alertOther(this.env.DB, this.env as LiveEnv & AlertEnv, now).catch((err) => console.error(`otros mercados, aviso: ${(err as Error).message}`)))
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
			await this.saveOthers(now)
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
