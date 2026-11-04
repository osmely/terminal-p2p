// Service worker del terminal: solo para los avisos push (push.js, worker/push.ts). No guarda nada en caché: el
// terminal se sigue cargando siempre de la red
'use strict'

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()))

// Un aviso del servidor: se enseña siempre (el navegador lo exige); con el terminal delante, sin sonido, que el
// terminal ya avisa (otra página del dominio no cuenta). El tag es el mismo que usa el terminal para ese suceso: si los dos avisan, uno reemplaza al otro
self.addEventListener('push', (e) => {
	let m = {}
	try {
		m = e.data ? e.data.json() : {}
	} catch {}
	e.waitUntil(
		(async () => {
			const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
			const seen = wins.some((w) => w.visibilityState === 'visible' && w.focused && new URL(w.url).pathname === '/')
			await self.registration.showNotification(m.title || 'Terminal P2P', {
				body: m.body || '',
				tag: m.tag || undefined,
				icon: '/icon-192.png',
				badge: '/badge-96.png',
				data: { url: m.url || '/#ops', offer: m.offer, kind: m.kind },
				requireInteraction: !!m.urgent && !seen,
				silent: seen,
			})
		})(),
	)
})

// Al tocarlo: el terminal que ya esté abierto pasa a «Mis operaciones»; si no hay ninguno, se abre
self.addEventListener('notificationclick', (e) => {
	e.notification.close()
	const url = new URL(e.notification.data?.url || '/#ops', self.location.origin).href
	e.waitUntil(
		(async () => {
			const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
			const w = wins.find((c) => new URL(c.url).origin === self.location.origin)
			if (w) {
				await w.focus()
				w.postMessage({ type: 'tp:open', url, ...e.notification.data })
				return
			}
			await self.clients.openWindow(url)
		})(),
	)
})
