// Contador anónimo de visitas de la web, el terminal y el simulador (worker/hits.ts). Suma 1 a un contador del día:
// una visita por sesión del navegador y, en el terminal, la cuenta conectada (una vez al día). Sin cookies ni
// identificadores: lo único que viaja es qué parte se visitó y por qué enlace (?de=…) se llegó
'use strict'
;(() => {
	const site = location.hostname.startsWith('app.') ? 'app' : location.hostname.startsWith('sim.') ? 'sim' : 'site'
	// El almacenamiento se pide dentro del try: con las cookies del sitio bloqueadas, solo nombrarlo ya lanza un error
	const store = (n) => (n === 'local' ? localStorage : sessionStorage)
	const get = (n, k) => {
		try {
			return store(n).getItem(k)
		} catch {
			return null
		}
	}
	const set = (n, k, v) => {
		try {
			store(n).setItem(k, v)
		} catch {}
	}
	const send = (kind, ref) =>
		fetch('/data/hit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ site, kind, ref }), keepalive: true }).catch(() => {})

	// El enlace con el que se llegó: se quita de la dirección (que no se comparta pegado) y se recuerda para la sesión.
	// En el terminal se recuerda también el primero que trajo a este navegador, para saber qué enlace trae cuentas
	const q = new URLSearchParams(location.search)
	const de = (q.get('de') ?? '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 20)
	if (q.has('de')) {
		q.delete('de')
		history.replaceState(null, '', `${location.pathname}${q.toString() ? `?${q}` : ''}${location.hash}`)
	}
	if (de) set('session', 'tp.de', de)
	if (de && site === 'app' && !get('local', 'tp.de')) set('local', 'tp.de', de)
	const ref = get('session', 'tp.de') ?? ''

	// Al pasar de la web al terminal o al simulador, el enlace de origen va con el clic
	if (ref && site === 'site')
		document.addEventListener('click', (e) => {
			const a = e.target.closest?.('a[href]')
			if (!a) return
			const u = new URL(a.href, location.href)
			if (!/^(app|sim)\./.test(u.hostname) || u.searchParams.has('de')) return
			u.searchParams.set('de', ref)
			a.href = u.toString()
		})

	if (!get('session', `tp.hit.${site}`)) {
		set('session', `tp.hit.${site}`, '1')
		send('visit', ref)
	}

	// El terminal avisa cuando hay una cuenta conectada (broker.js): una vez al día por navegador, y «first» la primera vez
	window.TPHit = {
		connected() {
			// El día de Cuba (app.js), no el del móvil, que puede ir en otra zona
			const now = typeof nowMs === 'function' ? nowMs() : Date.now()
			const today = typeof inCuba === 'function' ? inCuba(now).toISOString().slice(0, 10) : new Date().toDateString()
			const last = get('local', 'tp.hit.conn')
			// Lo apuntado antes con el día del navegador también vale para hoy (si no, hoy contaría dos veces)
			if (last === today || last === new Date().toDateString()) return void set('local', 'tp.hit.conn', today)
			const first = !last
			set('local', 'tp.hit.conn', today)
			const origin = get('local', 'tp.de') ?? ref
			send('connect', origin)
			if (first) send('first', origin)
		},
	}
})()
