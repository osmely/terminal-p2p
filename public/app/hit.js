// Contador anónimo de visitas de la web, el terminal y el simulador (worker/hits.ts). Suma 1 a un contador del día:
// una visita por sesión del navegador y, en el terminal, la cuenta conectada (una vez al día). Sin cookies ni
// identificadores: lo único que viaja es qué parte se visitó y por qué enlace (?de=…) se llegó
'use strict'
;(() => {
	const site = location.hostname.startsWith('app.') ? 'app' : location.hostname.startsWith('sim.') ? 'sim' : 'site'
	const get = (s, k) => {
		try {
			return s.getItem(k)
		} catch {
			return null
		}
	}
	const set = (s, k, v) => {
		try {
			s.setItem(k, v)
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
		history.replaceState(null, '', `${location.pathname}${q.size ? `?${q}` : ''}${location.hash}`)
	}
	if (de) set(sessionStorage, 'tp.de', de)
	if (de && site === 'app' && !get(localStorage, 'tp.de')) set(localStorage, 'tp.de', de)
	const ref = get(sessionStorage, 'tp.de') ?? ''

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

	if (!get(sessionStorage, `tp.hit.${site}`)) {
		set(sessionStorage, `tp.hit.${site}`, '1')
		send('visit', ref)
	}

	// El terminal avisa cuando hay una cuenta conectada (broker.js): una vez al día por navegador, y «first» la primera vez
	window.TPHit = {
		connected() {
			const today = new Date().toDateString()
			if (get(localStorage, 'tp.hit.conn') === today) return
			const first = !get(localStorage, 'tp.hit.conn')
			set(localStorage, 'tp.hit.conn', today)
			const origin = get(localStorage, 'tp.de') ?? ref
			send('connect', origin)
			if (first) send('first', origin)
		},
	}
})()
