// Motor del simulador: cuenta demo, órdenes y ejecución con precios reales de Binance.
// Adaptado del simulador trading-sim (engine.mjs): la misma lógica de órdenes, pero cada jugador
// tiene su cuenta en un objeto que el servidor carga y guarda en D1, y las órdenes pendientes se
// revisan con las velas de 1 segundo de Binance en vez de con cada cambio de precio en vivo.

export const MARKETS = {
	BTCUSDT: { base: 'BTC', name: 'Bitcoin', qtyStep: 0.00001, tick: 0.01 },
	ETHUSDT: { base: 'ETH', name: 'Ethereum', qtyStep: 0.0001, tick: 0.01 },
	SOLUSDT: { base: 'SOL', name: 'Solana', qtyStep: 0.001, tick: 0.01 },
	XRPUSDT: { base: 'XRP', name: 'XRP', qtyStep: 0.1, tick: 0.0001 },
	BNBUSDT: { base: 'BNB', name: 'BNB', qtyStep: 0.001, tick: 0.01 },
	// Más volátiles (rango 24 h típico 5-14 %)
	DOGEUSDT: { base: 'DOGE', name: 'Dogecoin', qtyStep: 1, tick: 0.00001 },
	SUIUSDT: { base: 'SUI', name: 'Sui', qtyStep: 0.1, tick: 0.0001 },
	PEPEUSDT: { base: 'PEPE', name: 'Pepe', qtyStep: 1, tick: 0.00000001 },
	TAOUSDT: { base: 'TAO', name: 'Bittensor', qtyStep: 0.0001, tick: 0.1 },
} as const
export type Symbol = keyof typeof MARKETS
export const SYMBOLS = Object.keys(MARKETS) as Symbol[]

export const FEE = 0.001 // 0,1 % por operación (como Binance spot)
export const MIN_NOTIONAL = 5 // mínimo $5 por orden
export const START_BALANCE = 10_000
// Lo que se guarda de cada cuenta: todas las órdenes abiertas y las últimas cerradas y operaciones
const KEEP_CLOSED_ORDERS = 100
const KEEP_TRADES = 300

export class SimError extends Error {}

export type Side = 'BUY' | 'SELL' | 'SHORT' | 'COVER'
export type OrderType = 'MARKET' | 'LIMIT' | 'STOP' | 'OCO'
export interface Quote {
	bid: number
	ask: number
}
// Vela de 1 s (o de 1 min si hay que ponerse al día con un hueco largo), en ms
export interface Candle {
	t: number
	o: number
	h: number
	l: number
	c: number
}

export interface Order {
	id: number
	symbol: Symbol
	side: Side
	type: OrderType
	qty: number
	price: number | null
	stopPrice: number | null
	status: 'OPEN' | 'FILLED' | 'CANCELED' | 'REJECTED'
	createdAt: number
	filledQty: number
	avgPrice: number | null
	locked: number
	stopLoss: number | null
	takeProfit: number | null
	note: string
	filledAt?: number
	trigger?: string | null
	reason?: string
}

export interface Trade {
	id: number
	orderId: number
	symbol: Symbol
	side: Side
	qty: number
	price: number
	quote: number
	fee: number
	realizedPnl: number | null
	time: number
	trigger: string | null
}

interface Balance {
	free: number
	locked: number
}
interface Short {
	qty: number
	cost: number
	fee: number
	free: number
	locked: number
}

export interface SimState {
	createdAt: number
	startBalance: number
	balances: Record<string, Balance>
	basis: Record<string, { qty: number; cost: number }>
	shorts: Record<string, Short>
	orders: Order[]
	trades: Trade[]
	nextId: number
	tradeCount: number
	// Hasta dónde se revisaron las órdenes pendientes con las velas
	checkedAt: number
	// Último precio conocido de cada mercado, por si la fuente no responde al valorar la cuenta
	marks?: Partial<Record<string, number>>
}

export interface OrderRequest {
	symbol: string
	side: string
	type?: string
	quantity?: number | null
	quoteAmount?: number | null
	price?: number | null
	stopPrice?: number | null
	stopLoss?: number | null
	takeProfit?: number | null
	note?: string
}

const round = (v: number, step: number) => Math.round(Math.round(v / step) * step * 1e10) / 1e10
const floorStep = (v: number, step: number) => Math.floor(v / step + 1e-9) * step
const emptyShort = (): Short => ({ qty: 0, cost: 0, fee: 0, free: 0, locked: 0 })
const SIDES: Side[] = ['BUY', 'SELL', 'SHORT', 'COVER']
// Se ejecutan contra el ask
const buyish = (side: Side) => side === 'BUY' || side === 'COVER'

// Acepta "btc", "BTC/USDT", "btcusdt"…
export function normSymbol(s: unknown): Symbol {
	const up = String(s ?? '')
		.toUpperCase()
		.replace(/[^A-Z]/g, '')
	const sym = up.endsWith('USDT') ? up : `${up}USDT`
	if (!(sym in MARKETS)) throw new SimError(`Mercado no disponible: ${String(s)}`)
	return sym as Symbol
}

export function freshState(now = Date.now(), balance = START_BALANCE): SimState {
	const balances: SimState['balances'] = { USDT: { free: balance, locked: 0 } }
	const basis: SimState['basis'] = {}
	const shorts: SimState['shorts'] = {}
	for (const m of Object.values(MARKETS)) {
		balances[m.base] = { free: 0, locked: 0 }
		basis[m.base] = { qty: 0, cost: 0 }
		shorts[m.base] = emptyShort()
	}
	return { createdAt: now, startBalance: balance, balances, basis, shorts, orders: [], trades: [], nextId: 1, tradeCount: 0, checkedAt: now }
}

export class Engine {
	state: SimState

	constructor(state: SimState) {
		// Cuentas guardadas antes de añadir un mercado: se crean sus saldos vacíos
		for (const m of Object.values(MARKETS)) {
			state.balances[m.base] ??= { free: 0, locked: 0 }
			state.basis[m.base] ??= { qty: 0, cost: 0 }
			state.shorts[m.base] ??= emptyShort()
		}
		this.state = state
	}

	openOrders() {
		return this.state.orders.filter((o) => o.status === 'OPEN')
	}

	// ── Órdenes ──────────────────────────────────────────────────────────
	// OCO solo cierra posiciones: SELL (objetivo arriba, stop abajo) o COVER (objetivo abajo, stop arriba).
	// stopLoss/takeProfit se adjuntan a entradas: BUY (stop abajo, objetivo arriba) o SHORT (stop arriba, objetivo abajo).
	placeOrder(req: OrderRequest, q: Quote, now = Date.now()): Order {
		const symbol = normSymbol(req.symbol)
		const m = MARKETS[symbol]
		const side = String(req.side ?? '').toUpperCase() as Side
		const type = String(req.type ?? 'MARKET').toUpperCase() as OrderType
		if (!SIDES.includes(side)) throw new SimError('Elige comprar o vender')
		if (!['MARKET', 'LIMIT', 'STOP', 'OCO'].includes(type)) throw new SimError('Tipo de orden no válido')
		if (type === 'OCO' && side !== 'SELL' && side !== 'COVER') throw new SimError('Una OCO solo cierra posiciones')
		if (!(q.bid > 0 && q.ask > 0)) throw new SimError('Aún no hay precio para este mercado; inténtalo en unos segundos')
		const buy = buyish(side)
		const note = req.note ? String(req.note).slice(0, 200) : ''
		const price = req.price != null && req.price !== ('' as unknown) ? round(+req.price, m.tick) : null
		const stopPrice = req.stopPrice != null && req.stopPrice !== ('' as unknown) ? round(+req.stopPrice, m.tick) : null
		if ((type === 'LIMIT' || type === 'OCO') && !(price! > 0)) throw new SimError('Pon el precio límite')
		if ((type === 'STOP' || type === 'OCO') && !(stopPrice! > 0)) throw new SimError('Pon el precio del stop')
		if (type === 'OCO' && side === 'SELL' && !(price! > q.bid && stopPrice! < q.bid))
			throw new SimError(`En una OCO de venta el objetivo va por encima del precio actual (${q.bid}) y el stop por debajo`)
		if (type === 'OCO' && side === 'COVER' && !(price! < q.ask && stopPrice! > q.ask))
			throw new SimError(`En una OCO de recompra el objetivo va por debajo del precio actual (${q.ask}) y el stop por encima`)
		if (type === 'STOP' && !buy && stopPrice! >= q.bid) throw new SimError(`Un stop de venta va por debajo del precio actual (${q.bid})`)
		if (type === 'STOP' && buy && stopPrice! <= q.ask) throw new SimError(`Un stop de compra va por encima del precio actual (${q.ask})`)

		// Cantidad: en monedas o en USDT (en entradas incluye la comisión)
		const refPrice = type === 'MARKET' ? (buy ? q.ask : q.bid) : type === 'STOP' ? stopPrice! : price!
		const entry = side === 'BUY' || side === 'SHORT'
		let qty: number
		if (req.quantity != null && +req.quantity > 0) qty = floorStep(+req.quantity, m.qtyStep)
		else if (req.quoteAmount != null && +req.quoteAmount > 0) qty = floorStep(+req.quoteAmount / refPrice / (entry ? 1 + FEE : 1), m.qtyStep)
		else throw new SimError('Indica la cantidad')
		qty = round(qty, m.qtyStep)
		if (!(qty > 0)) throw new SimError('La cantidad es demasiado pequeña')
		if (qty * refPrice < MIN_NOTIONAL) throw new SimError(`La orden mínima es de ${MIN_NOTIONAL} USDT`)

		const bal = this.state.balances
		const order: Order = {
			id: this.state.nextId++,
			symbol,
			side,
			type,
			qty,
			price,
			stopPrice,
			status: 'OPEN',
			createdAt: now,
			note,
			filledQty: 0,
			avgPrice: null,
			locked: 0,
			stopLoss: req.stopLoss != null && +req.stopLoss > 0 ? round(+req.stopLoss, m.tick) : null,
			takeProfit: req.takeProfit != null && +req.takeProfit > 0 ? round(+req.takeProfit, m.tick) : null,
		}
		if (!entry && (order.stopLoss || order.takeProfit)) throw new SimError('El stop loss y el take profit se adjuntan a compras o cortos')
		if (side === 'BUY' && order.stopLoss && order.stopLoss >= refPrice) throw new SimError('El stop loss va por debajo del precio de compra')
		if (side === 'BUY' && order.takeProfit && order.takeProfit <= refPrice) throw new SimError('El take profit va por encima del precio de compra')
		if (side === 'SHORT' && order.stopLoss && order.stopLoss <= refPrice) throw new SimError('En un corto el stop loss va por encima del precio de entrada')
		if (side === 'SHORT' && order.takeProfit && order.takeProfit >= refPrice) throw new SimError('En un corto el take profit va por debajo del precio de entrada')

		// Reservar fondos: USDT para entradas (en cortos, la garantía), monedas para SELL, deuda corta para COVER
		if (entry) {
			const need = qty * refPrice * (1 + FEE) * (type === 'MARKET' || type === 'STOP' ? 1.002 : 1)
			if (bal.USDT.free + 1e-9 < need) throw new SimError(`Saldo insuficiente: necesitas ${need.toFixed(2)} USDT y tienes ${bal.USDT.free.toFixed(2)} libres`)
			bal.USDT.free -= need
			bal.USDT.locked += need
			order.locked = need
		} else if (side === 'SELL') {
			const b = bal[m.base]
			if (b.free + 1e-12 < qty) throw new SimError(`No tienes suficiente ${m.base}: quieres vender ${qty} y tienes ${round(b.free, m.qtyStep)} libres`)
			b.free -= qty
			b.locked += qty
			order.locked = qty
		} else {
			const sh = this.state.shorts[m.base]
			if (sh.free + 1e-12 < qty) throw new SimError(`No tienes un corto de ${m.base} suficiente: quieres recomprar ${qty} y tienes ${round(sh.free, m.qtyStep)}`)
			sh.free -= qty
			sh.locked += qty
			order.locked = qty
		}
		this.state.orders.push(order)

		if (type === 'MARKET') this.fill(order, buy ? q.ask : q.bid, null, now)
		else if (type === 'LIMIT' && ((buy && q.ask <= price!) || (!buy && q.bid >= price!))) this.fill(order, buy ? q.ask : q.bid, null, now)
		this.trim()
		return order
	}

	cancelOrder(id: number) {
		const o = this.state.orders.find((x) => x.id === +id)
		if (!o) throw new SimError(`No existe la orden ${id}`)
		if (o.status !== 'OPEN') throw new SimError('Esa orden ya no está abierta')
		this.release(o)
		o.status = 'CANCELED'
		this.trim()
		return o
	}

	private release(o: Order) {
		const bal = this.state.balances
		const base = MARKETS[o.symbol].base
		const pool = o.side === 'BUY' || o.side === 'SHORT' ? bal.USDT : o.side === 'SELL' ? bal[base] : this.state.shorts[base]
		pool.locked -= o.locked
		pool.free += o.locked
		if (Math.abs(pool.locked) < 1e-9) pool.locked = 0 // evita restos negativos por redondeo
		o.locked = 0
	}

	// ── Revisión con velas ───────────────────────────────────────────────
	// Recorre en orden las velas de un mercado (de spanMs cada una) y ejecuta las órdenes pendientes que tocan. Cada orden solo
	// mira velas que empiezan después de crearse (nunca un precio que ya se conocía al ponerla). Si en una
	// misma vela se tocan objetivo y stop, se asume el stop; si la vela abre más allá del stop, se ejecuta
	// al precio de apertura (el hueco lo paga quien tenía el stop, como en un mercado real)
	replay(symbol: Symbol, candles: Candle[], spanMs = 60_000) {
		for (const c of candles) {
			for (const o of this.state.orders) {
				if (o.status !== 'OPEN' || o.symbol !== symbol || c.t < o.createdAt) continue
				const buy = buyish(o.side)
				const at = c.t + spanMs
				if (o.type === 'LIMIT') {
					if (buy && c.l <= o.price!) this.fill(o, Math.min(o.price!, c.o), null, at)
					else if (!buy && c.h >= o.price!) this.fill(o, Math.max(o.price!, c.o), null, at)
				} else if (o.type === 'STOP') {
					if (!buy && c.l <= o.stopPrice!) this.fill(o, Math.min(o.stopPrice!, c.o), 'stop', at)
					else if (buy && c.h >= o.stopPrice!) this.fill(o, Math.max(o.stopPrice!, c.o), 'stop', at)
				} else if (o.type === 'OCO' && o.side === 'SELL') {
					if (c.o <= o.stopPrice!) this.fill(o, c.o, 'stop', at)
					else if (c.o >= o.price!) this.fill(o, c.o, 'objetivo', at)
					else if (c.l <= o.stopPrice!) this.fill(o, o.stopPrice!, 'stop', at)
					else if (c.h >= o.price!) this.fill(o, o.price!, 'objetivo', at)
				} else if (o.type === 'OCO' && o.side === 'COVER') {
					if (c.o >= o.stopPrice!) this.fill(o, c.o, 'stop', at)
					else if (c.o <= o.price!) this.fill(o, c.o, 'objetivo', at)
					else if (c.h >= o.stopPrice!) this.fill(o, o.stopPrice!, 'stop', at)
					else if (c.l <= o.price!) this.fill(o, o.price!, 'objetivo', at)
				}
			}
		}
		this.trim()
	}

	private fill(o: Order, px: number, trigger: string | null, now: number) {
		const m = MARKETS[o.symbol]
		const bal = this.state.balances
		const basis = this.state.basis[m.base]
		const notional = o.qty * px
		const fee = notional * FEE
		let realized: number | null = null
		this.release(o)
		if (o.side === 'BUY') {
			const cost = notional + fee
			if (bal.USDT.free + 1e-6 < cost) {
				o.status = 'REJECTED'
				o.reason = 'Saldo insuficiente al ejecutar'
				return
			}
			bal.USDT.free -= cost
			bal[m.base].free += o.qty
			basis.qty += o.qty
			basis.cost += cost
		} else if (o.side === 'SELL') {
			bal[m.base].free -= o.qty
			bal.USDT.free += notional - fee
			const avg = basis.qty > 0 ? basis.cost / basis.qty : px
			realized = (px - avg) * o.qty - fee
			basis.cost -= avg * Math.min(o.qty, basis.qty)
			basis.qty = Math.max(0, basis.qty - o.qty)
			if (basis.qty < m.qtyStep / 2) {
				basis.qty = 0
				basis.cost = 0
			}
		} else if (o.side === 'SHORT') {
			// Vende prestado: paga comisión y deja el importe de la venta reservado como garantía
			const cost = notional + fee
			const sh = this.state.shorts[m.base]
			if (bal.USDT.free + 1e-6 < cost) {
				o.status = 'REJECTED'
				o.reason = 'Saldo insuficiente al ejecutar'
				return
			}
			bal.USDT.free -= cost
			sh.qty += o.qty
			sh.free += o.qty
			sh.cost += notional
			sh.fee += fee
		} else {
			// COVER: recompra; se libera la garantía y se cobra o paga la diferencia
			const sh = this.state.shorts[m.base]
			const avg = sh.qty > 0 ? sh.cost / sh.qty : px
			const q2 = Math.min(o.qty, sh.qty)
			const entryFee = sh.qty > 0 ? (sh.fee * q2) / sh.qty : 0
			sh.free -= o.qty
			realized = (avg - px) * o.qty - fee - entryFee
			bal.USDT.free += avg * q2 + (avg - px) * o.qty - fee
			sh.cost -= avg * q2
			sh.fee -= entryFee
			sh.qty = Math.max(0, sh.qty - o.qty)
			if (sh.qty < m.qtyStep / 2) Object.assign(sh, emptyShort())
			sh.free = round(sh.free, m.qtyStep / 100)
		}
		bal[m.base].free = round(bal[m.base].free, m.qtyStep / 100)
		o.status = 'FILLED'
		o.filledQty = o.qty
		o.avgPrice = px
		o.filledAt = now
		o.trigger = trigger
		this.state.tradeCount++
		this.state.trades.push({ id: this.state.tradeCount, orderId: o.id, symbol: o.symbol, side: o.side, qty: o.qty, price: px, quote: notional, fee, realizedPnl: realized, time: now, trigger })
		// Entrada con stop u objetivo adjuntos: se crea sola la orden de salida
		if ((o.side === 'BUY' || o.side === 'SHORT') && (o.stopLoss || o.takeProfit)) {
			const exit =
				o.stopLoss && o.takeProfit
					? { type: 'OCO', price: o.takeProfit, stopPrice: o.stopLoss }
					: o.stopLoss
						? { type: 'STOP', stopPrice: o.stopLoss }
						: { type: 'LIMIT', price: o.takeProfit }
			try {
				// La salida se valida contra el precio de ejecución, y empieza a mirar velas desde la siguiente
				this.placeOrder({ symbol: o.symbol, side: o.side === 'BUY' ? 'SELL' : 'COVER', quantity: o.qty, ...exit, note: `Salida automática de la orden #${o.id}` }, { bid: px, ask: px }, now)
			} catch {
				// Si el precio ya pasó el objetivo o el stop al ejecutarse, la posición queda abierta sin salida
			}
		}
	}

	// Todas las órdenes abiertas y las últimas cerradas; las últimas operaciones
	private trim() {
		const closed = this.state.orders.filter((o) => o.status !== 'OPEN')
		if (closed.length > KEEP_CLOSED_ORDERS) {
			const drop = new Set(closed.slice(0, closed.length - KEEP_CLOSED_ORDERS))
			this.state.orders = this.state.orders.filter((o) => !drop.has(o))
		}
		if (this.state.trades.length > KEEP_TRADES) this.state.trades.splice(0, this.state.trades.length - KEEP_TRADES)
	}

	// ── Cuenta ───────────────────────────────────────────────────────────
	account(mids: Partial<Record<Symbol, number>>) {
		const s = this.state
		const bal = s.balances
		let equity = bal.USDT.free + bal.USDT.locked
		const positions = []
		for (const sym of SYMBOLS) {
			const m = MARKETS[sym]
			const b = bal[m.base]
			const qty = b.free + b.locked
			const px = mids[sym] ?? s.marks?.[sym] ?? 0
			if (qty > 0) {
				equity += qty * px
				const basis = s.basis[m.base]
				const avg = basis.qty > 0 ? basis.cost / basis.qty : null
				positions.push({ symbol: sym, side: 'LONG', qty: round(qty, m.qtyStep), price: px, value: qty * px, avgCost: avg, unrealizedPnl: avg ? (px - avg) * qty : null, unrealizedPct: avg ? (px / avg - 1) * 100 : null })
			}
			// Cortos: garantía reservada (cost) más la ganancia o pérdida no realizada
			const sh = s.shorts[m.base]
			if (sh?.qty) {
				const avg = sh.cost / sh.qty
				const upnl = (avg - px) * sh.qty
				equity += sh.cost + upnl
				positions.push({ symbol: sym, side: 'SHORT', qty: round(sh.qty, m.qtyStep), price: px, value: sh.cost + upnl, avgCost: avg, unrealizedPnl: upnl - sh.fee, unrealizedPct: ((upnl - sh.fee) / sh.cost) * 100 })
			}
		}
		return {
			startBalance: s.startBalance,
			createdAt: s.createdAt,
			cash: { free: bal.USDT.free, locked: bal.USDT.locked },
			equity,
			pnl: equity - s.startBalance,
			pnlPct: (equity / s.startBalance - 1) * 100,
			positions,
			trades: s.tradeCount,
		}
	}
}
