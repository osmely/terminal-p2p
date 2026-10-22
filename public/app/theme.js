// Tema guardado antes de pintar, para que no parpadee (archivo aparte: la CSP no permite scripts en línea)
try {
	const t = JSON.parse(localStorage.getItem('theme') || 'null')
	if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t
} catch {}
