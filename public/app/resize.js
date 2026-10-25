// Paneles redimensionables en escritorio, para el terminal y el simulador. Cada asa cambia una variable
// CSS de la rejilla (ancho de una columna o alto de una fila), se guarda en este navegador y con doble
// clic vuelve a su tamaño original. En pantallas más estrechas que minWidth las asas no se muestran.
;(() => {
	const css = `
.rz { position: absolute; z-index: 15; touch-action: none; }
.rz::after { content: ''; position: absolute; border-radius: 2px; background: var(--accent); opacity: 0; transition: opacity 0.15s; }
.rz:hover::after, .rz.on::after { opacity: 0.55; }
.rz-v { width: 10px; cursor: col-resize; }
.rz-v::after { left: 4px; top: 25%; bottom: 25%; width: 2px; }
.rz-h { height: 10px; cursor: row-resize; }
.rz-h::after { top: 4px; left: 25%; right: 25%; height: 2px; }
body.rz-drag, body.rz-drag * { user-select: none !important; }
body.rz-drag-v, body.rz-drag-v * { cursor: col-resize !important; }
body.rz-drag-h, body.rz-drag-h * { cursor: row-resize !important; }`
	const style = document.createElement('style')
	style.textContent = css
	document.head.appendChild(style)

	const load = (key) => {
		try {
			return JSON.parse(localStorage.getItem(key) || '{}')
		} catch {
			return {}
		}
	}
	const save = (key, v) => {
		try {
			localStorage.setItem(key, JSON.stringify(v))
		} catch {}
	}

	// handles: [{ panel: selector, edge: 'right' | 'left' | 'bottom', v: '--variable', min, max }]
	window.TPResize = function setup({ layout, key, minWidth, handles }) {
		const root = document.querySelector(layout)
		if (!root) return
		if (getComputedStyle(root).position === 'static') root.style.position = 'relative'
		const saved = load(key)
		const desktop = () => window.innerWidth >= minWidth
		const apply = () => {
			for (const h of handles) {
				if (desktop() && saved[h.v]) root.style.setProperty(h.v, `${saved[h.v]}px`)
				else root.style.removeProperty(h.v)
			}
		}
		const gap = () => parseFloat(getComputedStyle(root).columnGap) || 10

		const els = handles.map((h) => {
			const el = document.createElement('div')
			el.className = `rz ${h.edge === 'bottom' ? 'rz-h' : 'rz-v'}`
			el.title = 'Arrastra para cambiar el tamaño · doble clic para el tamaño original'
			root.appendChild(el)
			el.addEventListener('pointerdown', (e) => {
				const panel = root.querySelector(h.panel)
				if (!panel || e.button !== 0) return
				e.preventDefault()
				el.setPointerCapture(e.pointerId)
				el.classList.add('on')
				document.body.classList.add('rz-drag', h.edge === 'bottom' ? 'rz-drag-h' : 'rz-drag-v')
				const r = panel.getBoundingClientRect()
				const start = h.edge === 'bottom' ? r.height : r.width
				const x0 = e.clientX
				const y0 = e.clientY
				const move = (ev) => {
					const d = h.edge === 'bottom' ? ev.clientY - y0 : h.edge === 'right' ? ev.clientX - x0 : x0 - ev.clientX
					const size = Math.round(Math.min(h.max, Math.max(h.min, start + d)))
					root.style.setProperty(h.v, `${size}px`)
					saved[h.v] = size
					place()
				}
				const up = () => {
					el.releasePointerCapture(e.pointerId)
					el.classList.remove('on')
					document.body.classList.remove('rz-drag', 'rz-drag-h', 'rz-drag-v')
					el.removeEventListener('pointermove', move)
					el.removeEventListener('pointerup', up)
					el.removeEventListener('pointercancel', up)
					save(key, saved)
				}
				el.addEventListener('pointermove', move)
				el.addEventListener('pointerup', up)
				el.addEventListener('pointercancel', up)
			})
			el.addEventListener('dblclick', () => {
				delete saved[h.v]
				save(key, saved)
				root.style.removeProperty(h.v)
				place()
			})
			return el
		})

		// Cada asa se coloca en el hueco junto a su panel
		function place() {
			const show = desktop()
			const lr = root.getBoundingClientRect()
			const g = gap()
			handles.forEach((h, i) => {
				const el = els[i]
				const panel = root.querySelector(h.panel)
				const r = panel?.getBoundingClientRect()
				el.hidden = !show || !r || !r.width
				if (el.hidden) return
				if (h.edge === 'bottom') {
					el.style.left = `${r.left - lr.left}px`
					el.style.width = `${r.width}px`
					el.style.top = `${r.bottom - lr.top + g / 2 - 5}px`
					el.style.height = ''
				} else {
					el.style.top = `${r.top - lr.top}px`
					el.style.height = `${r.height}px`
					el.style.left = `${(h.edge === 'right' ? r.right : r.left - g) - lr.left + g / 2 - 5}px`
					el.style.width = ''
				}
			})
		}

		apply()
		place()
		let wasDesktop = desktop()
		window.addEventListener('resize', () => {
			if (desktop() !== wasDesktop) {
				wasDesktop = desktop()
				apply()
			}
			place()
		})
		new ResizeObserver(place).observe(root)
	}
})()
