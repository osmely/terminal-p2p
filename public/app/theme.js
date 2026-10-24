// Tema guardado antes de pintar, para que no parpadee (archivo aparte: la CSP no permite scripts en línea)
try {
	const t = JSON.parse(localStorage.getItem('theme') || 'null')
	if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t
} catch {}

// El color de tema (zona superior del navegador en el móvil) sigue al tema elegido, no al del sistema
;(() => {
	const metas = [...document.querySelectorAll('meta[name="theme-color"]')]
	const color = (t) => metas.find((m) => (m.getAttribute('media') || '').includes(t))?.dataset.color
	for (const m of metas) m.dataset.color = m.content
	const sync = () => {
		const t = document.documentElement.dataset.theme
		const c = t && color(t)
		if (c) for (const m of metas) m.content = c
	}
	sync()
	new MutationObserver(sync).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
})()
