// Comprar bitcoin en Mostro desde el terminal (experimental, mercado «Bitcoin · Mostro», btc.js): el botón «Comprar» de
// una orden de venta de Mostro abre la compra; las compras en curso se ven arriba del libro, con su chat. Todo pasa en el navegador: las 12 palabras, las
// claves y el estado se guardan en este navegador (localStorage) y los mensajes van cifrados a los relays de Mostro.
// Terminal P2P no custodia nada: los sats los retiene Mostro (factura retenida) y los paga a la dirección Lightning de
// quien compra. Lo que viene de fuera se pinta como texto, nunca como HTML.

import { MOSTRO_RELAYS, QVAPAY_LN_DOMAIN } from '../src/nostr-relays.ts'
import {
	MAX_POW,
	STEP_OF,
	FINAL,
	cantDoReason,
	cantDoText,
	deadlineS,
	nodeHealth,
	chatKeys,
	fiatAmountOk,
	invoiceOk,
	isHex64,
	keyring,
	lnAddressOf,
	lnAddressOk,
	newWords,
	normWords,
	openChat,
	openFromMostro,
	pubOf,
	wordsOk,
	wrapChat,
	wrapToMostro,
	type ChatKeys,
	type Health,
	type Incoming,
	type Keyring,
	type NostrEvent,
	type Outgoing,
	type Step,
} from './mostro.ts'

// ---------------------------------------------------------------- lo que manda el libro (nostr.js)

interface BookOrder {
	side: 'ask' | 'bid'
	fiat: string
	min: number
	max: number
	sats: number | null
	premium: number | null
	price: number | null
	pays: string[]
	node: string | null
	score: number | null
	reviews: number | null
	take: { id: string; node: string; relays: string[] } | null
}
interface NodeInfo {
	protocol: number
	pow: number
	powFirst: number | null
	fee: number | null
	minSats: number | null
	maxSats: number | null
	bonds: boolean
	stepS: number | null
	cltv?: number | null
	marginBlocks?: number | null
	maintenance?: boolean
	health?: unknown
}

// ---------------------------------------------------------------- estado guardado

interface ChatLine {
	id: string
	mine: boolean
	text: string
	at: number
}
interface Trade {
	id: string
	node: string
	nodeName: string
	relays: string[]
	idx: number
	fiat: string
	amount: number
	// Orden con rango: la cantidad va en el mensaje al tomarla
	range: boolean
	price: number | null
	pays: string[]
	ln: string
	step: Step
	// Segundos del aviso de Mostro que dio el paso actual (los que llegan tarde y son más viejos no lo cambian)
	stepAt: number
	sats: number | null
	seller: string | null
	note: string
	startedAt: number
	seen: string[]
	chat: ChatLine[]
	chatSince: number
	canRate: boolean
	rated: boolean
	peerCancel: boolean
	retries: number
	// Cuándo bloqueó el vendedor los sats (de ahí sale el plazo para pagar)
	activeAt?: number
	// El mediador de la disputa (su clave, y la hora del aviso que lo asignó) y su chat con él
	admin?: string | null
	adminAt?: number
	adminChat?: ChatLine[]
	adminSince?: number
}
interface Saved {
	words: string | null
	saved: boolean
	next: number
	ln: string
	trades: Trade[]
}
// El terminal dice qué cuenta de QvaPay está conectada antes de cargar esto (btc.js): con ella la dirección Lightning
// sale sola (usuario@qvpay.me) y cada cuenta del navegador tiene su cuenta de Mostro y sus compras
declare global {
	interface Window {
		TPMostroConfig?: { user?: string }
	}
}
const QV_USER = /^[a-z0-9._-]{2,40}$/i.test(window.TPMostroConfig?.user ?? '') ? window.TPMostroConfig!.user!.toLowerCase() : null
const KEY = QV_USER ? `tp.mostro.v1:${QV_USER}` : 'tp.mostro.v1'
const qvAddress = QV_USER ? `${QV_USER}@${QVAPAY_LN_DOMAIN}` : ''
function load(): Saved {
	const empty: Saved = { words: null, saved: false, next: 1, ln: '', trades: [] }
	try {
		const raw = localStorage.getItem(KEY)
		if (!raw) return empty
		const s = JSON.parse(raw) as Saved
		return { ...empty, ...s, trades: Array.isArray(s.trades) ? s.trades : [] }
	} catch {
		return empty
	}
}
let state = load()
function save() {
	try {
		localStorage.setItem(KEY, JSON.stringify(state))
	} catch {
		// sin almacenamiento: la compra sigue en esta pestaña, pero no sobrevive a recargarla
	}
}
let ring: Keyring | null = null
const keys = () => {
	if (!state.words) throw new Error('sin cuenta')
	if (!ring) ring = keyring(state.words)
	return ring
}

// ---------------------------------------------------------------- reloj (Mostro descarta lo que llega con más de 10 s)

let skew = 0
async function syncClock() {
	try {
		const sent = Date.now()
		const res = await fetch('/data/now', { cache: 'no-store' })
		const got = Date.now()
		const { now } = (await res.json()) as { now: number }
		const s = now - (sent + got) / 2
		if (Number.isFinite(s) && got - sent < 5000) skew = Math.abs(s) > 1500 ? s : 0
	} catch {
		// sin red: se queda el reloj del equipo
	}
}
const nowS = () => Math.floor((Date.now() + skew) / 1000)

// ---------------------------------------------------------------- relays

type Filter = Record<string, unknown>
const allowed = (urls: string[]) => {
	const ok = urls.filter((u) => MOSTRO_RELAYS.includes(u))
	return ok.length ? ok : MOSTRO_RELAYS
}
class Pool {
	private sockets = new Map<string, WebSocket>()
	private subs = new Map<string, { relays: string[]; filters: Filter[] }>()
	private wait = new Map<string, number>()
	private seen = new Set<string>()
	constructor(private onEvent: (sub: string, ev: NostrEvent) => void) {}
	private open(url: string) {
		if (this.sockets.has(url)) return
		const ws = new WebSocket(url)
		this.sockets.set(url, ws)
		ws.onopen = () => {
			this.wait.set(url, 1000)
			for (const [id, s] of this.subs) if (s.relays.includes(url)) ws.send(JSON.stringify(['REQ', id, ...s.filters]))
		}
		ws.onmessage = (m) => {
			let d: unknown
			try {
				d = JSON.parse(String(m.data))
			} catch {
				return
			}
			if (!Array.isArray(d) || d[0] !== 'EVENT' || typeof d[1] !== 'string' || !d[2] || typeof d[2] !== 'object') return
			const ev = d[2] as NostrEvent
			const key = `${d[1]}:${ev.id}`
			if (this.seen.has(key)) return
			this.seen.add(key)
			if (this.seen.size > 5000) this.seen = new Set([...this.seen].slice(-2500))
			this.onEvent(d[1], ev)
		}
		ws.onclose = () => {
			this.sockets.delete(url)
			if (![...this.subs.values()].some((s) => s.relays.includes(url))) return
			const ms = Math.min(this.wait.get(url) ?? 1000, 30_000)
			this.wait.set(url, ms * 2)
			setTimeout(() => this.open(url), ms)
		}
	}
	sub(id: string, relays: string[], filters: Filter[]) {
		const rs = allowed(relays)
		this.subs.set(id, { relays: rs, filters })
		for (const url of rs) {
			const ws = this.sockets.get(url)
			if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(['REQ', id, ...filters]))
			else this.open(url)
		}
	}
	unsub(id: string) {
		const s = this.subs.get(id)
		if (!s) return
		this.subs.delete(id)
		for (const url of s.relays) {
			const ws = this.sockets.get(url)
			if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(['CLOSE', id]))
		}
	}
	// Manda el evento a todos los relays; da cuántos lo aceptaron (los que aún conectan, lo reciben al abrir)
	publish(relays: string[], ev: NostrEvent): Promise<number> {
		const rs = allowed(relays)
		return new Promise((resolve) => {
			let oks = 0
			let left = rs.length
			const done = () => --left <= 0 && resolve(oks)
			for (const url of rs) {
				const go = () => {
					const ws = this.sockets.get(url)
					if (!ws) return done()
					const onMsg = (m: MessageEvent) => {
						try {
							const d = JSON.parse(String(m.data))
							if (Array.isArray(d) && d[0] === 'OK' && d[1] === ev.id) {
								if (d[2] === true) oks++
								ws.removeEventListener('message', onMsg)
								done()
							}
						} catch {
							// mensaje que no es JSON
						}
					}
					ws.addEventListener('message', onMsg)
					ws.send(JSON.stringify(['EVENT', ev]))
					setTimeout(() => {
						ws.removeEventListener('message', onMsg)
						if (left > 0) done()
					}, 8000)
				}
				const ws = this.sockets.get(url)
				if (ws?.readyState === WebSocket.OPEN) go()
				else {
					this.open(url)
					const w = this.sockets.get(url)
					if (!w) done()
					else {
						w.addEventListener('open', go, { once: true })
						w.addEventListener('close', () => left > 0 && done(), { once: true })
					}
				}
			}
		})
	}
}

// ---------------------------------------------------------------- la compra

const pool = new Pool(onEvent)
const nodes = new Map<string, NodeInfo>()
const chats = new Map<string, ChatKeys>()
const adminChats = new Map<string, ChatKeys>()
// Las que esperan respuesta del nodo al tomarlas: si no contesta en un minuto se dice
const timers = new Map<string, number>()

const tradeOf = (id: string) => state.trades.find((t) => t.id === id)
const subId = (t: Trade) => `m${t.id.slice(0, 8)}${t.idx}`
const chatSubId = (t: Trade) => `c${t.id.slice(0, 8)}${t.idx}`
const adminSubId = (t: Trade) => `a${t.id.slice(0, 8)}${t.idx}`
const reqId = () => Math.floor(Math.random() * 2 ** 31)

function watch(t: Trade) {
	if (FINAL.includes(t.step) && !(t.step === 'done' && t.canRate && !t.rated)) return
	const me = pubOf(keys().at(t.idx))
	pool.sub(subId(t), t.relays, [{ kinds: [14], authors: [t.node], '#p': [me], since: t.startedAt - 120 }])
	if (t.seller) watchChat(t)
	if (t.admin) watchAdmin(t)
}
function watchChat(t: Trade) {
	if (!t.seller || !isHex64(t.seller)) return
	let ck = chats.get(t.id)
	if (!ck) {
		ck = chatKeys(keys().at(t.idx), t.seller)
		chats.set(t.id, ck)
	}
	pool.sub(chatSubId(t), t.relays, [{ kinds: [14], authors: [ck.signPub], since: Math.max(0, t.chatSince - 5), limit: 200 }])
}
// El chat con el mediador: el mismo esquema que el del vendedor, con la clave del mediador (dispute_chat en la
// especificación). Ahí escriben solo tú y él
function watchAdmin(t: Trade) {
	if (!t.admin || !isHex64(t.admin)) return
	let ck = adminChats.get(t.id)
	if (!ck) {
		ck = chatKeys(keys().at(t.idx), t.admin)
		adminChats.set(t.id, ck)
	}
	pool.sub(adminSubId(t), t.relays, [{ kinds: [14], authors: [ck.signPub], since: Math.max(0, (t.adminSince ?? t.adminAt ?? nowS()) - 5), limit: 200 }])
}

async function send(t: Trade, m: Outgoing, first = false) {
	const node = nodes.get(t.node)
	const pow = (first ? (node?.powFirst ?? node?.pow) : node?.pow) ?? 0
	const k = keys()
	const ev = wrapToMostro(m, k.at(t.idx), k.at(0), t.node, nowS(), pow)
	return pool.publish(t.relays, ev)
}

function setStep(t: Trade, step: Step, at: number, note?: string) {
	const rank: Record<Step, number> = { taking: 0, invoice: 1, 'waiting-seller': 2, active: 3, canceling: 3.5, 'fiat-sent': 4, dispute: 4.5, released: 5, done: 6, canceled: 6, failed: 6 }
	if (FINAL.includes(t.step) && t.step !== step) return
	if (at < t.stepAt || (at === t.stepAt && rank[step] < rank[t.step])) return
	t.step = step
	t.stepAt = at
	if (note !== undefined) t.note = note
}

function onMostro(t: Trade, msg: Incoming) {
	const p = (msg.payload ?? {}) as Record<string, any>
	const order = p.order && typeof p.order === 'object' ? p.order : null
	if (order && typeof order.amount === 'number' && order.amount > 0) t.sats = order.amount
	if (order && isHex64(order.seller_trade_pubkey)) t.seller = order.seller_trade_pubkey
	// El aviso del mediador trae SU clave en el mismo sitio que la del vendedor: no la pisa
	if (isHex64(p.peer?.pubkey) && msg.action !== 'admin-took-dispute') t.seller = p.peer.pubkey
	clearTimeout(timers.get(t.id))
	switch (msg.action) {
		case 'admin-took-dispute': {
			setStep(t, 'dispute', msg.at, '')
			// Si cambia de mediador (Serbero pasa el caso a una persona) vale el aviso más nuevo; a la misma hora, el que había
			const admin = p.peer?.pubkey
			if (isHex64(admin) && admin !== t.admin && msg.at > (t.adminAt ?? 0)) {
				if (t.admin) pool.unsub(adminSubId(t))
				adminChats.delete(t.id)
				t.admin = admin
				t.adminAt = msg.at
				t.adminSince = msg.at
				t.note = 'Ya tienes mediador: escríbele abajo, en «Chat con el mediador»'
			}
			break
		}
		case 'hold-invoice-payment-accepted':
			setStep(t, 'active', msg.at, '')
			if (!t.activeAt || msg.at < t.activeAt) t.activeAt = msg.at
			break
		case 'cant-do': {
			const why = cantDoReason(msg.payload)
			// Con unas palabras que ya se usaron (en la app de Mostro u otro navegador), el nodo pide un número mayor
			if (why === 'invalid_trade_index' && t.step === 'taking' && t.retries < 2) {
				t.retries++
				resync(t)
				return
			}
			const text = cantDoText(why)
			if (t.step === 'taking') setStep(t, 'failed', msg.at, `El nodo no aceptó: ${text}`)
			else t.note = `El nodo dice: ${text}`
			break
		}
		case 'add-invoice':
			setStep(t, 'invoice', msg.at, 'El nodo pide una factura o dirección Lightning para pagarte')
			break
		case 'payment-failed': {
			const pf = p.payment_failed ?? {}
			t.note = `Falló el pago a tu dirección Lightning: el nodo lo reintenta${pf.payment_attempts ? ` (${pf.payment_attempts} intentos más, cada ${pf.payment_retries_interval ?? '?'} min)` : ''}`
			break
		}
		case 'rate':
			t.canRate = true
			break
		case 'rate-received':
			t.rated = true
			break
		case 'cooperative-cancel-initiated-by-peer':
			t.peerCancel = true
			t.note = 'El vendedor propone cancelar. Si aceptas, los sats vuelven a él y la compra se cierra'
			break
		case 'cooperative-cancel-initiated-by-you':
			setStep(t, 'canceling', msg.at, 'Pediste cancelar: falta que el vendedor acepte')
			break
		default: {
			const step = STEP_OF[msg.action]
			if (step) setStep(t, step, msg.at, '')
		}
	}
	if (t.step === 'active' || t.step === 'fiat-sent' || t.step === 'dispute') watchChat(t)
	if (t.admin && !FINAL.includes(t.step)) watchAdmin(t)
}

function onEvent(sub: string, ev: NostrEvent) {
	if (sub === 'idx') return onRestore(ev)
	for (const t of state.trades) {
		if (sub === subId(t)) {
			if (t.seen.includes(ev.id)) return
			const msg = openFromMostro(ev, keys().at(t.idx), t.node)
			t.seen = [...t.seen, ev.id].slice(-300)
			if (msg && (msg.id === t.id || msg.id === null)) onMostro(t, msg)
			save()
			return render()
		}
		if (sub === chatSubId(t)) {
			const ck = chats.get(t.id)
			if (!ck || !t.seller || t.chat.length >= 500) return
			const me = pubOf(keys().at(t.idx))
			const inner = openChat(ev, ck, [me, t.seller], nowS())
			if (!inner || t.chat.some((c) => c.id === inner.id)) return
			t.chat.push({ id: inner.id, mine: inner.pubkey === me, text: inner.content.slice(0, 2000), at: inner.created_at })
			t.chat.sort((a, b) => a.at - b.at)
			t.chatSince = Math.min(Math.max(t.chatSince, inner.created_at), nowS())
			save()
			return render()
		}
		if (sub === adminSubId(t)) {
			const ck = adminChats.get(t.id)
			const lines = (t.adminChat ??= [])
			if (!ck || !t.admin || lines.length >= 500) return
			const me = pubOf(keys().at(t.idx))
			const inner = openChat(ev, ck, [me, t.admin], nowS())
			if (!inner || lines.some((c) => c.id === inner.id)) return
			lines.push({ id: inner.id, mine: inner.pubkey === me, text: inner.content.slice(0, 2000), at: inner.created_at })
			lines.sort((a, b) => a.at - b.at)
			t.adminSince = Math.min(Math.max(t.adminSince ?? 0, inner.created_at), nowS())
			save()
			return render()
		}
	}
}

// El número de operación que el nodo tiene de estas palabras: se pide con la clave de la identidad y se reintenta con
// el siguiente
let resyncing: Trade | null = null
async function resync(t: Trade) {
	resyncing = t
	const id = keys().at(0)
	pool.sub('idx', t.relays, [{ kinds: [14], authors: [t.node], '#p': [pubOf(id)], since: nowS() - 60 }])
	const ev = wrapToMostro({ wrapper: 'restore', action: 'last-trade-index' }, id, null, t.node, nowS(), nodes.get(t.node)?.pow ?? 0)
	await pool.publish(t.relays, ev)
}
function onRestore(ev: NostrEvent) {
	const t = resyncing
	if (!t) return
	const msg = openFromMostro(ev, keys().at(0), t.node)
	if (!msg || msg.action !== 'last-trade-index' || typeof msg.tradeIndex !== 'number') return
	resyncing = null
	pool.unsub('idx')
	pool.unsub(subId(t))
	state.next = Math.max(state.next, msg.tradeIndex + 1)
	t.idx = state.next++
	t.seen = []
	save()
	takeNow(t)
}

async function takeNow(t: Trade) {
	t.startedAt = nowS()
	watch(t)
	const payload = { payment_request: [null, t.ln, t.range ? t.amount : null] as [null, string, number | null] }
	const oks = await send(t, { wrapper: 'order', action: 'take-sell', id: t.id, requestId: reqId(), tradeIndex: t.idx, payload }, true)
	if (!oks) t.note = 'Ningún relay aceptó el mensaje: revisa la conexión y reintenta'
	timers.set(
		t.id,
		window.setTimeout(() => {
			if (t.step === 'taking') {
				t.note = 'El nodo no contesta todavía. Puedes esperar o reintentar'
				render()
			}
		}, 60_000),
	)
	save()
	render()
}

// ---------------------------------------------------------------- pantalla

const $ = (id: string) => document.getElementById(id)!
function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string | null, text?: string): HTMLElementTagNameMap[K] {
	const e = document.createElement(tag)
	if (cls) e.className = cls
	if (text !== undefined) e.textContent = text
	return e
}
function button(text: string, cls: string, fn: () => void) {
	const b = el('button', cls, text)
	b.type = 'button'
	b.addEventListener('click', fn)
	return b
}
const n0 = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 0 })
const clock = (s: number) => new Date(s * 1000).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' })
// «unas 19 h» / «unos 40 min»
const left = (s: number) => (s >= 5400 ? `unas ${Math.round(s / 3600)} h` : `unos ${Math.max(1, Math.round(s / 60))} min`)
// Lo que queda hasta que el nodo actúe solo (cancelar, o abrir él la disputa si marcaste «Ya pagué»)
function timeLeft(t: Trade) {
	if (!t.activeAt) return null
	const n = nodes.get(t.node)
	return t.activeAt + deadlineS(n?.cltv, n?.marginBlocks) - nowS()
}

const STEP_TEXT: Record<Step, string> = {
	taking: 'Tomando la orden…',
	invoice: 'Falta tu factura Lightning',
	'waiting-seller': 'Esperando a que el vendedor bloquee los sats',
	active: 'Paga al vendedor',
	canceling: 'Cancelación pedida',
	'fiat-sent': 'Esperando a que el vendedor libere',
	dispute: 'En disputa',
	released: 'Liberado: Mostro te está pagando',
	done: 'Completada',
	canceled: 'Cancelada',
	failed: 'No se pudo tomar',
}

const drafts = new Map<string, string>()
function render() {
	const box = $('mxTrades')
	const shown = state.trades
	const focused = (document.activeElement as HTMLElement | null)?.dataset?.draft
	box.hidden = shown.length === 0
	box.replaceChildren(...(shown.length ? [el('h2', 'mx-title', 'Tus compras en Mostro'), ...shown.map(card)] : []))
	if (focused) box.querySelector<HTMLInputElement>(`input[data-draft="${focused}"]`)?.focus()
}

function card(t: Trade) {
	const c = el('article', `mx-card mx-${t.step}`)
	const rest = t.step === 'active' || t.step === 'fiat-sent' ? timeLeft(t) : null
	const head = el('div', 'mx-head')
	head.append(el('b', null, `${n0(t.amount)} ${t.fiat}`), el('span', 'mx-step', STEP_TEXT[t.step]))
	const meta = el('p', 'mx-meta', [t.nodeName, t.sats ? `${n0(t.sats)} sats` : null, t.pays.join(', '), `a ${t.ln}`].filter(Boolean).join(' · '))
	c.append(head, meta)
	const help: Record<Step, string> = {
		taking: 'Se mandó la orden al nodo; contesta en segundos.',
		invoice: '',
		'waiting-seller': 'El vendedor tiene unos minutos para bloquear los sats en Mostro. Aún no pagues nada.',
		active: `Los sats están bloqueados en Mostro. Pide al vendedor en el chat a dónde pagar, paga ${n0(t.amount)} ${t.fiat} y pulsa «Ya pagué».${rest !== null ? (rest > 0 ? ` Tienes ${left(rest)}: si para entonces no lo marcaste, Mostro cancela y los sats vuelven al vendedor.` : ' Se acabó el plazo: Mostro cancela la compra si no marcaste «Ya pagué».') : ''}`,
		canceling: '',
		'fiat-sent': `Avisaste que pagaste. Cuando el vendedor lo confirme, libera y los sats llegan a tu dirección. Si no contesta, abre una disputa pronto${rest !== null && rest > 0 ? ` (quedan ${left(rest)} de plazo)` : ''}: la que abre Mostro solo al final deja muy poco tiempo al mediador.`,
		dispute: t.admin
			? 'El mediador está con tu caso: escríbele en su chat y mándale el comprobante del pago. Él no lee el chat con el vendedor salvo que le compartas su clave (eso hoy solo se hace en la app de Mostro, con tus 12 palabras).'
			: 'Abriste una disputa: el nodo te asigna un mediador y aquí aparece su chat. Ten a mano el comprobante del pago.',
		released: 'El vendedor liberó los sats. Mostro los está mandando a tu dirección Lightning.',
		done: 'Los sats se mandaron a tu dirección Lightning.',
		canceled: 'La compra se cerró sin pagos. Si bloqueaste algo, vuelve solo.',
		failed: '',
	}
	const h = t.note || help[t.step]
	if (h) c.append(el('p', 'mx-help', h))
	const acts = el('div', 'mx-acts')
	if (t.step === 'taking' && t.note) acts.append(button('Reintentar', 'btn', () => takeNow(t)))
	if (t.step === 'invoice') acts.append(invoiceForm(t))
	if (t.step === 'waiting-seller') acts.append(button('Cancelar', 'btn', () => act(t, 'cancel', '¿Cancelar la compra? La orden vuelve al libro.')))
	if (t.step === 'active') {
		acts.append(button('Ya pagué', 'btn primary', () => act(t, 'fiat-sent', `¿Ya pagaste ${n0(t.amount)} ${t.fiat} al vendedor? Solo púlsalo cuando el pago salió de tu cuenta.`)))
		acts.append(button('Proponer cancelar', 'btn', () => act(t, 'cancel', 'El vendedor tiene que aceptar la cancelación. ¿Proponerla?')))
	}
	if (t.peerCancel && (t.step === 'active' || t.step === 'fiat-sent' || t.step === 'dispute')) acts.append(button('Aceptar cancelar', 'btn', () => act(t, 'cancel', '¿Aceptar la cancelación? Los sats vuelven al vendedor. Si ya le pagaste, no aceptes: pídele que te devuelva el dinero o abre una disputa.')))
	if (t.step === 'active' || t.step === 'fiat-sent') acts.append(button('Abrir disputa', 'btn', () => act(t, 'dispute', '¿Abrir una disputa? Un mediador del nodo decide a quién van los sats.')))
	if (t.step === 'done' && t.canRate && !t.rated) acts.append(rateForm(t))
	if (FINAL.includes(t.step) && !(t.canRate && !t.rated)) acts.append(button('Quitar', 'btn', () => remove(t)))
	if (acts.childElementCount) c.append(acts)
	if (t.seller && (t.step === 'active' || t.step === 'fiat-sent' || t.step === 'dispute' || t.step === 'canceling' || t.chat.length)) c.append(chatBox(t, 'peer'))
	if (t.admin) c.append(chatBox(t, 'admin'))
	return c
}

function chatBox(t: Trade, room: 'peer' | 'admin') {
	const admin = room === 'admin'
	const lines = admin ? (t.adminChat ?? []) : t.chat
	const box = el('div', `mx-chat${admin ? ' mx-admin' : ''}`)
	if (admin || t.admin) box.append(el('h3', 'mx-room', admin ? 'Chat con el mediador' : 'Chat con el vendedor'))
	const list = el('ol', 'mx-lines')
	if (!lines.length) list.append(el('li', 'mx-empty', admin ? 'Cuéntale al mediador qué pasó y mándale el comprobante del pago' : 'Escribe al vendedor: pídele los datos de pago'))
	for (const m of lines.slice(-80)) {
		const li = el('li', m.mine ? 'mx-mine' : 'mx-peer')
		li.append(el('span', null, m.text), el('time', null, clock(m.at)))
		list.append(li)
	}
	box.append(list)
	queueMicrotask(() => (list.scrollTop = list.scrollHeight))
	// Cerrada la compra queda la conversación, sin poder escribir
	if (FINAL.includes(t.step)) return box
	const form = el('form', 'mx-say')
	const input = el('input')
	input.maxLength = 1000
	input.placeholder = admin ? 'Mensaje al mediador' : 'Mensaje al vendedor'
	input.autocomplete = 'off'
	// Lo que se está escribiendo sobrevive a que llegue un mensaje (la tarjeta se vuelve a pintar)
	const draft = `${t.id}:${room}`
	input.dataset.draft = draft
	input.value = drafts.get(draft) ?? ''
	input.addEventListener('input', () => drafts.set(draft, input.value))
	form.append(input, el('button', 'btn', 'Enviar'))
	form.addEventListener('submit', async (e) => {
		e.preventDefault()
		const text = input.value.trim()
		const ck = (admin ? adminChats : chats).get(t.id)
		if (!text || !ck) return
		input.value = ''
		drafts.delete(draft)
		const { outer, inner } = wrapChat(text, keys().at(t.idx), ck, nowS())
		if (admin) (t.adminChat ??= []).push({ id: inner.id, mine: true, text, at: inner.created_at })
		else t.chat.push({ id: inner.id, mine: true, text, at: inner.created_at })
		save()
		render()
		const oks = await pool.publish(t.relays, outer)
		if (!oks) {
			t.note = 'El último mensaje no llegó a ningún relay: escríbelo otra vez'
			render()
		}
	})
	box.append(form)
	return box
}

function invoiceForm(t: Trade) {
	const f = el('form', 'mx-say')
	const input = el('input')
	input.value = t.ln
	input.placeholder = 'usuario@dominio o factura lnbc…'
	f.append(input, el('button', 'btn primary', 'Mandar'))
	f.addEventListener('submit', async (e) => {
		e.preventDefault()
		const v = invoiceOk(input.value) ? input.value.trim() : lnAddressOf(input.value)
		if (!lnAddressOk(v) && !invoiceOk(v)) return void (t.note = 'Eso no es una dirección Lightning ni una factura', render())
		const info = lnAddressOk(v) ? await checkLn(v) : null
		if (info && !info.ok) return void (t.note = `La dirección Lightning no vale: ${info.reason ?? 'revísala'}`, render())
		t.ln = v
		await send(t, { wrapper: 'order', action: 'add-invoice', id: t.id, requestId: reqId(), payload: { payment_request: [null, v, null] } })
		t.note = 'Enviada: esperando al nodo'
		save()
		render()
	})
	return f
}

function rateForm(t: Trade) {
	const f = el('div', 'mx-rate')
	f.append(el('span', null, 'Valora al vendedor:'))
	for (let i = 1; i <= 5; i++)
		f.append(
			button('★'.repeat(i), 'btn mx-star', async () => {
				await send(t, { wrapper: 'order', action: 'rate-user', id: t.id, requestId: reqId(), payload: { rating_user: i } })
				t.rated = true
				save()
				render()
			}),
		)
	return f
}

async function act(t: Trade, action: 'cancel' | 'fiat-sent' | 'dispute', ask: string) {
	if (!confirm(ask)) return
	const oks = await send(t, { wrapper: 'order', action, id: t.id, requestId: reqId() })
	t.note = oks ? 'Enviado: esperando al nodo' : 'Ningún relay aceptó el mensaje: reintenta'
	if (action === 'cancel') t.peerCancel = false
	save()
	render()
}

function remove(t: Trade) {
	pool.unsub(subId(t))
	pool.unsub(chatSubId(t))
	pool.unsub(adminSubId(t))
	state.trades = state.trades.filter((x) => x !== t)
	save()
	render()
}

// ---------------------------------------------------------------- la dirección Lightning

// Lo que contesta /data/lnaddr (el servidor pregunta al dominio de la dirección). null: no se pudo comprobar ahora
interface LnInfo {
	ok: boolean
	reason?: string
	min?: number
	max?: number
	text?: string
	qvapay?: boolean
}
const lnSeen = new Map<string, LnInfo>()
async function checkLn(addr: string): Promise<LnInfo | null> {
	const a = addr.toLowerCase()
	const hit = lnSeen.get(a)
	if (hit) return hit
	try {
		const res = await fetch(`/data/lnaddr?a=${encodeURIComponent(a)}`, { signal: AbortSignal.timeout(8000) })
		if (!res.ok) return null
		const info = (await res.json()) as LnInfo
		if (typeof info?.ok !== 'boolean') return null
		lnSeen.set(a, info)
		return info
	} catch {
		return null
	}
}

// ---------------------------------------------------------------- tomar una orden

function openTake(o: BookOrder, nodeName: string) {
	const take = o.take
	const node = take ? nodes.get(take.node) : null
	if (!take || !node) return
	const dlg = $('mxDialog') as HTMLDialogElement
	const body = el('form', 'mx-form')
	body.method = 'dialog'
	const fixed = o.min === o.max
	const title = el('h2', null, `Comprar bitcoin · ${nodeName}`)
	const facts = el('ul', 'mx-facts')
	const fact = (k: string, v: string) => {
		const li = el('li')
		li.append(el('span', null, k), el('b', null, v))
		facts.append(li)
	}
	if (o.price) fact('Precio', `${n0(o.price)} ${o.fiat} por BTC${o.premium !== null ? ` (${o.premium > 0 ? '+' : ''}${o.premium} %)` : ''}`)
	fact('Pago', o.pays.join(', ') || '—')
	fact('Monto', fixed ? `${n0(o.min)} ${o.fiat}` : `${n0(o.min)} – ${n0(o.max)} ${o.fiat}`)
	if (o.score !== null) fact('Vendedor', `★${o.score.toFixed(2)}${o.reviews ? ` (${n0(o.reviews)} valoraciones)` : ''}`)
	// La comisión del nodo se reparte a medias entre comprador y vendedor
	const pct = (x: number) => `${(x * 100).toLocaleString('en-US', { maximumFractionDigits: 2 })} %`
	const half = node.fee !== null && node.fee > 0 ? node.fee / 2 : 0
	if (node.fee !== null) fact('Tu comisión', half ? `${pct(half)} (el nodo cobra ${pct(node.fee)} entre los dos)` : 'ninguna')
	const h = healthOf(take.node)
	fact('Estado del nodo', h.status === 'ok' ? 'funciona ✓' : h.status === 'degraded' ? 'con problemas (puede ir lento)' : h.status === 'down' ? 'caído' : 'sin informe reciente')

	const amount = el('input')
	amount.inputMode = 'numeric'
	amount.required = true
	amount.value = fixed ? String(o.min) : ''
	amount.disabled = fixed
	amount.placeholder = `${n0(o.min)} – ${n0(o.max)}`
	const est = el('small', 'mx-est')
	const upd = () => {
		const v = Number(amount.value.replace(/[,\s]/g, ''))
		est.textContent = o.price && v > 0 ? `≈ ${n0((v / o.price) * 1e8 * (1 - half))} sats para ti${half ? ', ya sin tu parte de la comisión' : ''}` : ''
	}
	amount.addEventListener('input', upd)
	upd()
	const ln = el('input')
	ln.required = true
	ln.value = state.ln || qvAddress
	ln.placeholder = 'tu usuario de QvaPay o usuario@dominio'
	ln.autocomplete = 'off'
	ln.autocapitalize = 'none'
	ln.spellcheck = false
	// Debajo, si la dirección existe (y de quién es) o por qué no vale. Se mira al dejar de escribir
	const lnSays = el('small', 'mx-ln')
	let lnInfo: LnInfo | null = null
	let lnFor = ''
	const sats = () => {
		const v = Number(amount.value.replace(/[,\s]/g, ''))
		return o.price && v > 0 ? Math.round((v / o.price) * 1e8 * (1 - half)) : null
	}
	const showLn = () => {
		lnSays.className = 'mx-ln'
		if (!lnInfo) return void (lnSays.textContent = '')
		if (!lnInfo.ok) {
			lnSays.classList.add('bad')
			return void (lnSays.textContent = `✗ ${lnInfo.reason ?? 'No vale'}`)
		}
		const s = sats()
		const range = lnInfo.min !== undefined && lnInfo.max !== undefined ? `recibe de ${n0(lnInfo.min)} a ${n0(lnInfo.max)} sats` : ''
		const out = s !== null && ((lnInfo.min && s < lnInfo.min) || (lnInfo.max && s > lnInfo.max))
		lnSays.classList.add(out ? 'bad' : 'good')
		lnSays.textContent = `${out ? '✗' : '✓'} ${[lnInfo.qvapay ? 'QvaPay' : null, lnInfo.text, range].filter(Boolean).join(' · ')}`
	}
	// Mientras escribe solo se mira; el usuario de QvaPay se completa en el campo al salir de él o al tomar la orden
	// (si no, una pausa entre «ana» y «@blink.sv» lo dejaría en ana@qvpay.me)
	let lnCheck: Promise<LnInfo | null> = Promise.resolve(null)
	const verify = (fill: boolean) => {
		const addr = lnAddressOf(ln.value)
		if (fill && addr !== ln.value.trim()) ln.value = addr
		if (addr === lnFor) return lnCheck
		lnFor = addr
		lnInfo = null
		showLn()
		if (!lnAddressOk(addr)) return (lnCheck = Promise.resolve(null))
		lnSays.textContent = `Comprobando ${addr}…`
		return (lnCheck = checkLn(addr).then((info) => {
			if (lnFor === addr) {
				lnInfo = info
				if (!info) lnSays.textContent = 'No se pudo comprobar ahora'
				else showLn()
			}
			return info
		}))
	}
	let lnTimer = 0
	ln.addEventListener('input', () => {
		clearTimeout(lnTimer)
		lnTimer = window.setTimeout(() => {
			if (ln.value.includes('@') ? lnAddressOk(ln.value) : ln.value.trim().length >= 2) verify(false)
		}, 900)
	})
	ln.addEventListener('blur', () => {
		clearTimeout(lnTimer)
		if (ln.value.trim()) verify(true)
	})
	amount.addEventListener('input', showLn)
	if (ln.value) verify(false)

	const field = (label: string, input: HTMLElement, hint?: string, extra?: HTMLElement) => {
		const l = el('label', 'mx-field')
		l.append(el('span', null, label), input)
		if (extra) l.append(extra)
		if (hint) l.append(el('small', null, hint))
		return l
	}
	body.append(
		title,
		facts,
		field(`¿Cuánto vas a pagar? (${o.fiat})`, amount),
		est,
		field(
			'Tu dirección Lightning',
			ln,
			qvAddress
				? `Ahí manda Mostro los sats cuando el vendedor libere. Viene puesta la de tu cuenta de QvaPay (${qvAddress}): caen en tu saldo. Puedes poner la de otra cartera Lightning.`
				: `Ahí manda Mostro los sats cuando el vendedor libere. Con QvaPay basta tu usuario (es usuario@${QVAPAY_LN_DOMAIN} y caen en tu saldo); sirve también la de cualquier cartera Lightning.`,
			lnSays,
		),
	)

	// La cuenta: 12 palabras nuevas (o las de la app de Mostro), que hay que guardar antes de la primera compra
	const acct = el('div', 'mx-acct')
	let words = state.words ?? newWords()
	const savedBox = el('input')
	savedBox.type = 'checkbox'
	if (!state.words || !state.saved) {
		const w = el('p', 'mx-words', words)
		const imp = el('textarea')
		imp.rows = 2
		imp.placeholder = 'Pega aquí tus 12 palabras de la app de Mostro'
		imp.hidden = true
		const swap = button('Ya tengo cuenta de Mostro', 'linkish', () => {
			imp.hidden = !imp.hidden
			w.hidden = !imp.hidden
		})
		imp.addEventListener('input', () => {
			if (wordsOk(imp.value)) words = normWords(imp.value)
		})
		const ok = el('label', 'mx-check')
		ok.append(savedBox, document.createTextNode(' Guardé estas 12 palabras en un lugar seguro'))
		acct.append(el('p', null, 'Tu cuenta de Mostro se crea en este navegador. Guarda estas 12 palabras: con ellas sigues tus compras en la app de Mostro si pierdes este navegador. Quien las tenga puede actuar en tus compras.'), w, swap, imp, ok)
		body.append(acct)
	}
	const steps = el('ol', 'mx-how')
	for (const s of ['Tomas la orden y el vendedor bloquea los sats en Mostro (tiene unos minutos).', `Le pagas los ${o.fiat} por ${o.pays.join(' o ') || 'el método acordado'} con los datos que te dé en el chat y pulsas «Ya pagué».`, 'Él confirma, libera y Mostro manda los sats a tu dirección Lightning.'])
		steps.append(el('li', null, s))
	const err = el('p', 'mx-err')
	const actions = el('div', 'mx-acts')
	const go = el('button', 'btn primary', 'Tomar la orden')
	go.type = 'submit'
	actions.append(button('Cerrar', 'btn', () => dlg.close()), go)
	body.append(steps, el('p', 'mx-fine', 'Experimental. Terminal P2P no custodia ni intermedia: la garantía la da Mostro con la factura retenida. Si algo sale mal, se resuelve en el nodo (disputa).'), err, actions)

	let busy = false
	body.addEventListener('submit', async (e) => {
		e.preventDefault()
		if (busy) return
		err.textContent = ''
		const v = Number(amount.value.replace(/[,\s]/g, ''))
		if (!fiatAmountOk(v, o.min, o.max)) return void (err.textContent = `Pon una cantidad entera entre ${n0(o.min)} y ${n0(o.max)}`)
		if (o.price && node.minSats && (v / o.price) * 1e8 < node.minSats) return void (err.textContent = 'Es menos de lo mínimo que acepta el nodo')
		if (o.price && node.maxSats && (v / o.price) * 1e8 > node.maxSats) return void (err.textContent = 'Es más de lo máximo que acepta el nodo')
		if (!lnAddressOk(lnAddressOf(ln.value))) return void (err.textContent = 'Pon tu usuario de QvaPay o una dirección usuario@dominio')
		if ((!state.words || !state.saved) && !savedBox.checked) return void (err.textContent = 'Primero guarda las 12 palabras y marca la casilla')
		if (state.trades.some((t) => t.id === take.id && !FINAL.includes(t.step))) return void (err.textContent = 'Ya estás comprando en esta orden')
		// La dirección tiene que existir y recibir esa cantidad; si ahora no se puede comprobar, se sigue (Mostro la mira)
		busy = true
		go.disabled = true
		clearTimeout(lnTimer)
		const info = await verify(true)
		busy = false
		go.disabled = false
		const s = sats()
		if (info && !info.ok) return void (err.textContent = `La dirección Lightning no vale: ${info.reason ?? 'revísala'}`)
		if (info?.ok && s !== null && info.min && s < info.min) return void (err.textContent = `Esa dirección recibe desde ${n0(info.min)} sats`)
		if (info?.ok && s !== null && info.max && s > info.max) return void (err.textContent = `Esa dirección recibe hasta ${n0(info.max)} sats: compra menos o usa otra`)
		const addr = ln.value.trim()
		if (!state.words || state.words !== words) {
			state.words = words
			ring = null
		}
		state.saved = true
		state.ln = addr
		const t: Trade = {
			id: take.id,
			node: take.node,
			nodeName,
			relays: allowed(take.relays),
			idx: state.next++,
			fiat: o.fiat,
			amount: v,
			range: !fixed,
			price: o.price,
			pays: o.pays,
			ln: addr,
			step: 'taking',
			stepAt: 0,
			sats: null,
			seller: null,
			note: '',
			startedAt: nowS(),
			seen: [],
			chat: [],
			chatSince: nowS(),
			canRate: false,
			rated: false,
			peerCancel: false,
			retries: 0,
		}
		state.trades = [t, ...state.trades.filter((x) => x.id !== t.id)]
		save()
		dlg.close()
		takeNow(t)
		$('mxTrades').scrollIntoView({ behavior: 'smooth', block: 'start' })
	})
	dlg.replaceChildren(body)
	dlg.showModal()
}

// Lo que se puede comprar desde aquí: venta de Mostro en un nodo con el protocolo 2, sin fianza, con poca prueba de
// trabajo y que escucha en alguno de los relays que la página puede abrir (si no, el mensaje no le llegaría nunca)
// La salud del nodo según su último informe (si falta o es viejo, «unknown»: no impide comprar, pero lo dice)
const healthOf = (node: string): Health => nodeHealth(nodes.get(node)?.health, node, nowS())
// Por qué no se puede comprar ahora en ese nodo aunque la orden se pueda tomar (null: se puede)
function blocked(o: BookOrder): string | null {
	const node = o.take?.node
	if (!node) return null
	const h = healthOf(node)
	if (nodes.get(node)?.maintenance || h.maintenance) return 'Nodo en mantenimiento'
	if (h.status === 'down') return 'Nodo caído'
	if (h.payouts === 'fail') return 'El nodo no está pagando'
	return null
}

function canTake(o: BookOrder) {
	if (o.side !== 'ask' || !o.take || !o.take.relays.some((r) => MOSTRO_RELAYS.includes(r))) return false
	const n = nodes.get(o.take.node)
	return !!n && n.protocol === 2 && !n.bonds && Math.max(n.pow, n.powFirst ?? n.pow) <= MAX_POW
}

declare global {
	interface Window {
		TPMostro?: { setNodes(n: Record<string, NodeInfo>): void; canTake(o: BookOrder): boolean; blocked(o: BookOrder): string | null; take(o: BookOrder): void }
	}
}
window.TPMostro = {
	setNodes(n) {
		for (const [k, v] of Object.entries(n ?? {})) if (isHex64(k)) nodes.set(k, v)
	},
	canTake: (o) => canTake(o) && !blocked(o),
	// Se podría tomar, pero el nodo ahora no está para operar: el porqué, para enseñarlo en vez de «Comprar»
	blocked: (o) => (canTake(o) ? blocked(o) : null),
	take(o) {
		if (canTake(o) && !blocked(o)) openTake(o, o.node ?? 'Mostro')
	},
}

// Al cargar: las compras abiertas siguen escuchando al nodo y a su chat
syncClock().then(() => {
	if (!state.words) return render()
	for (const t of state.trades) {
		try {
			watch(t)
		} catch {
			// unas palabras dañadas: se ve la compra, sin escuchar
		}
	}
	render()
})
document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && syncClock())
window.addEventListener('storage', (e) => {
	if (e.key === KEY) {
		state = load()
		ring = null
		render()
	}
})
