// Diagnóstico: lo que hace el terminal en este navegador (lo que pides que cambie algo, lo que falla, los avisos que
// ves, tu estado de Pro), para que lo mandes desde «Mi cuenta» si algo sale mal y hay que entender qué pasó. Se queda
// aquí, 14 días: solo sale si lo envías tú. Nunca el token ni tus datos de pago: de cada petición, la ruta, el
// resultado y unos pocos campos sueltos (mercado, tipo, monto, precio)
'use strict'
;(() => {
	const KEY = 'tp.diag'
	const MAX = 400
	const KEEP_MS = 14 * 86_400_000
	// Lo mismo repetido seguido (un error que se reintenta) cuenta en una sola línea
	const SAME_MS = 60_000
	// Los únicos campos que se apuntan de lo que se manda: nada de datos de pago, chat ni texto libre
	const SAFE = new Set(['coin', 'type', 'side', 'amount', 'price', 'min', 'max', 'uuid', 'offer', 'status', 'code', 'ok', 'ms', 'plan', 'days', 'pro', 'kind', 'symbol', 'usd', 'n'])

	const read = () => {
		try {
			const xs = JSON.parse(localStorage.getItem(KEY) || '[]')
			return Array.isArray(xs) ? xs : []
		} catch {
			return []
		}
	}
	const write = (xs) => {
		try {
			localStorage.setItem(KEY, JSON.stringify(xs))
		} catch {}
	}
	// Con dos cuentas en el mismo navegador, cada línea dice de cuál es. Lo de antes de saberlo (conectar, cargar la
	// página) lleva la marca de esta carga de la página y se le cuenta a la cuenta que se conecte en ella
	const page = Math.random().toString(36).slice(2, 10)
	const who = () => {
		try {
			return typeof bk !== 'undefined' && bk.acct?.connected ? bk.acct.username : null
		} catch {
			return null
		}
	}

	function add(kind, msg, data) {
		const now = Date.now()
		const text = String(msg ?? '').slice(0, 300)
		const clean = {}
		if (data) for (const [k, v] of Object.entries(data)) if (SAFE.has(k) && v != null && typeof v !== 'object') clean[k] = typeof v === 'string' ? v.slice(0, 80) : v
		const u = who()
		const xs = read().filter((e) => now - e.t < KEEP_MS)
		const last = xs.at(-1)
		if (last && last.kind === kind && last.msg === text && last.u === u && last.p === page && now - last.t < SAME_MS) {
			last.n = (last.n ?? 1) + 1
			last.t = now
		} else xs.push({ t: now, kind, msg: text, p: page, ...(u ? { u } : {}), ...(Object.keys(clean).length ? { data: clean } : {}) })
		write(xs.slice(-MAX))
	}

	// Lo de esta cuenta, listo para enviar. Una línea sin cuenta es de la siguiente que se conectó en esa misma carga
	// de la página (o de la anterior, si después no se conectó ninguna); si en esa carga no hubo ninguna, va también
	function forAccount(username) {
		const xs = read()
		const mine = (u) => !username || u.toLowerCase() === username.toLowerCase()
		const owner = xs.map((e) => e.u ?? null)
		for (let i = xs.length - 1, next = {}; i >= 0; i--) {
			if (owner[i]) next[xs[i].p] = owner[i]
			else owner[i] = next[xs[i].p] ?? null
		}
		for (let i = 0, prev = {}; i < xs.length; i++) {
			if (xs[i].u) prev[xs[i].p] = xs[i].u
			else if (!owner[i]) owner[i] = prev[xs[i].p] ?? null
		}
		return xs
			.filter((e, i) => !owner[i] || mine(owner[i]))
			.map(({ t, kind, msg, data, n }) => ({ t, kind, msg: n > 1 ? `${msg} (×${n})` : msg, ...(data ? { data } : {}) }))
	}

	window.TPDiag = { add, forAccount, clear: () => write([]) }
	window.addEventListener('error', (e) => add('error', `${e.message} (${String(e.filename || '').split('/').pop()}:${e.lineno})`))
	window.addEventListener('unhandledrejection', (e) => add('error', String(e.reason?.message ?? e.reason)))
	add('page', 'Abrió el terminal')
})()
