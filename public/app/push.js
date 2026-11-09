// Avisos push: con la campana activada, el servidor te avisa de tus operaciones aunque cierres el terminal (cuando
// toman tu oferta, te pagan o te liberan). Se activan con el permiso de notificaciones del navegador; la suscripción
// queda en el servidor con tu cuenta de QvaPay (worker/push.ts). En el iPhone solo funcionan con el terminal añadido
// a la pantalla de inicio
'use strict'

window.TPPush = (() => {
	const ok = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
	let reg = null
	let key = null

	const ready = async () => {
		if (!ok) return null
		reg ??= await navigator.serviceWorker.register('/sw.js').catch(() => null)
		return reg
	}
	const bytes = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4)), (c) => c.charCodeAt(0))
	const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

	async function post(path, body) {
		const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), credentials: 'same-origin' })
		const d = await r.json().catch(() => ({}))
		if (!r.ok) throw Object.assign(new Error(d.error || `Error ${r.status}`), { status: r.status })
		return d
	}
	// Tu cuenta, confirmada en este navegador: la huella del token y la cookie que firma el relé (si falta, se pide)
	async function mine(path, body) {
		const print = (await api('/print')).print
		try {
			return await post(path, { ...body, print })
		} catch (e) {
			if (e.status !== 401) throw e
			await api('/me')
			return post(path, { ...body, print })
		}
	}
	const current = async () => (await ready())?.pushManager.getSubscription().catch(() => null)

	// Activa (o renueva, al cargar o al cambiar de cuenta) la suscripción de este navegador. test: manda un aviso de
	// prueba. Devuelve 'on', o por qué no: 'unsupported' (navegador sin push), 'permission' u 'off' (sin configurar)
	async function subscribe({ test = false } = {}) {
		const g = await ready()
		if (!g) return 'unsupported'
		if (Notification.permission !== 'granted') return 'permission'
		if (!key) {
			const r = await fetch('/push/key').catch(() => null)
			if (!r?.ok) return 'off'
			key = (await r.json()).key
		}
		let sub = await g.pushManager.getSubscription()
		// Hecha con otra clave del servidor: se rehace
		if (sub?.options?.applicationServerKey && b64u(sub.options.applicationServerKey) !== key) {
			await sub.unsubscribe().catch(() => {})
			sub = null
		}
		sub ??= await g.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: bytes(key) })
		await mine('/push/subscribe', { sub: sub.toJSON() })
		// El de prueba: si no llega, se reintenta una vez (los avisos ya quedaron activados igual)
		if (test)
			await mine('/push/test', { endpoint: sub.endpoint }).catch(async () => {
				await new Promise((r) => setTimeout(r, 3000))
				await mine('/push/test', { endpoint: sub.endpoint }).catch(() => {})
			})
		return 'on'
	}

	async function unsubscribe() {
		const sub = await current()
		if (!sub) return
		await post('/push/unsubscribe', { endpoint: sub.endpoint }).catch(() => {})
		await sub.unsubscribe().catch(() => {})
	}

	// Una oferta que acabas de tomar: el servidor te avisa de lo que haga su dueño
	async function watch(offer) {
		if (!offer || !bk.alerts || !ok || Notification.permission !== 'granted') return
		const sub = await current()
		if (sub) await mine('/push/watch', { endpoint: sub.endpoint, offer }).catch(() => {})
	}

	// Un aviso del terminal abierto, por el service worker (en el móvil, new Notification no funciona)
	async function show(title, opts) {
		const g = ok && Notification.permission === 'granted' ? await ready() : null
		if (!g) return false
		await g.showNotification(title, opts)
		return true
	}

	// Al tocar un aviso con el terminal ya abierto, el service worker pide pasar a «Mis operaciones»
	if (ok)
		navigator.serviceWorker.addEventListener('message', (e) => {
			const d = e.data
			if (d?.type !== 'tp:open' || typeof showView !== 'function') return
			// El aviso de que se acaban los días de Pro abre la ventana de Pro
			if (d.kind === 'pro') return typeof showPro === 'function' && showPro()
			// Un mensaje del buzón abre el buzón
			if (d.kind === 'inbox') return window.TPInbox?.open()
			state.view = 'orders'
			showView('orders')
			// Un aviso del terminal abierto sabe qué operación es: se abre (si la contraparte se fue, la oferta)
			if (d.offer && d.kind === 'left') showManageOffer(d.offer)
			else if (d.offer && d.kind) openTrade(d.offer, d.order ?? null)
		})

	return { ok, subscribe, unsubscribe, watch, show }
})()
