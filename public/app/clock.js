// Reloj del terminal corregido con la hora del servidor. Muchos dispositivos creen que Cuba pasó a UTC-5 en noviembre
// (no cambió) y quien adelantó el reloj a mano para ver bien la hora lo tiene una hora por delante: los plazos de pago
// salían vencidos una hora antes. nowMs() es la hora real. Solo se corrige si el reloj se desvía más de un minuto
// (lo normal es que vaya bien). Archivo aparte y sin defer: data.js y los demás ya lo tienen al cargar
;(() => {
	let skew = 0
	let syncedAt = 0
	const sync = async () => {
		if (Date.now() - syncedAt < 60_000) return
		syncedAt = Date.now()
		try {
			const sent = Date.now()
			const res = await fetch('/data/now', { cache: 'no-store' })
			const got = Date.now()
			const { now } = await res.json()
			// La hora del servidor es la de la mitad del viaje; un viaje muy largo no sirve para medir
			const s = now - (sent + got) / 2
			if (Number.isFinite(s) && got - sent < 10_000) skew = Math.abs(s) > 60_000 ? s : 0
		} catch {}
	}
	window.nowMs = () => Date.now() + skew
	sync()
	setInterval(sync, 15 * 60_000)
	// Al volver a la pestaña: el reloj del teléfono pudo cambiar mientras tanto
	document.addEventListener('visibilitychange', () => !document.hidden && sync())
})()
