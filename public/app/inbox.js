// Buzón del terminal: la campanita con los mensajes del equipo y los avisos de tu cuenta (como el fin de tus días de
// Pro). Se piden con tu cuenta (la que confirmó QvaPay). Si llega uno con el terminal abierto, el libro en vivo lo
// avisa (tp:inbox) y salta al momento en una tarjeta; los que llegaron con el terminal cerrado saltan al entrar
;(() => {
	const btn = document.getElementById('inboxBtn')
	if (!btn) return
	const badge = btn.querySelector('.inbox-n')
	const POP_SHOWN = 'inbox.popped'
	const POP_MAX_MS = 3 * 86_400_000
	let items = []
	let loadedFor = null
	let lastLoad = 0
	let panel = null
	// Los que estaban sin leer al abrir el buzón siguen resaltados mientras está abierto
	let fresh = new Set()

	const when = (ms) => {
		const d = Date.now() - ms
		if (d < 60_000) return tl('inbox.now')
		if (d < 3_600_000) return tl('inbox.minAgo', { n: Math.floor(d / 60_000) })
		if (d < 86_400_000) return tl('inbox.hAgo', { n: Math.floor(d / 3_600_000) })
		return inCuba(ms).toLocaleDateString(TPI18N.locale, { timeZone: 'UTC', day: 'numeric', month: 'short' })
	}
	const TRASH = '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 002 2h6a2 2 0 002-2l1-12M9 7V4h6v3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>'
	const unread = () => items.filter((i) => !i.read).length

	function paintBadge() {
		const n = unread()
		btn.hidden = !loadedFor
		badge.hidden = !n
		badge.textContent = n > 9 ? '9+' : String(n)
		btn.title = n ? tl('inbox.titleNew', { n }) : tl('inbox.title')
		btn.setAttribute('aria-label', btn.title)
	}

	function act(it) {
		if (!it.cta) return
		if (it.cta === 'pro') return typeof showPro === 'function' && showPro()
		window.open(it.cta, '_blank', 'noopener')
	}

	const ctaBtn = (it, cls = 'btn primary small') => (it.cta ? `<button class="${cls}" data-cta="${it.id}">${esc(it.ctaLabel || tl('inbox.open'))}</button>` : '')

	async function load(force = false) {
		if (typeof pro === 'undefined' || !pro.print || typeof proFetch !== 'function') return
		if (!force && loadedFor === pro.print && Date.now() - lastLoad < 60_000) return
		lastLoad = Date.now()
		const print = pro.print
		try {
			const d = await proFetch('/pro/inbox', { print })
			// Si mientras tanto se cambió de cuenta, estos mensajes son de la otra
			if (pro.print !== print) return
			loadedFor = print
			items = Array.isArray(d.items) ? d.items : []
			paintBadge()
			if (panel) paintPanel()
			popNewest()
		} catch {}
	}

	// La tarjeta que salta: el más nuevo sin leer que aún no saltó (de los últimos 3 días)
	function popNewest() {
		const shown = new Set(store.getMine(POP_SHOWN, []))
		const it = items.find((i) => !i.read && !shown.has(i.id) && Date.now() - i.at < POP_MAX_MS)
		if (!it || panel) return
		store.setMine(POP_SHOWN, [it.id, ...shown].slice(0, 50))
		document.getElementById('inboxPop')?.remove()
		const el = document.createElement('div')
		el.id = 'inboxPop'
		el.className = 'inbox-pop'
		el.setAttribute('role', 'status')
		el.innerHTML = `<div class="inbox-pop-head"><span class="inbox-pop-tag">${tl(it.kind === 'system' ? 'inbox.tagSystem' : 'inbox.tagTeam')}</span><button class="icon-btn small" data-x aria-label="${tl('common.close')}">✕</button></div>
			<b>${esc(it.title)}</b><p>${esc(it.body)}</p>
			<div class="inbox-pop-act">${ctaBtn(it)}<button class="btn small" data-open>${tl('inbox.see')}</button></div>`
		el.addEventListener('click', (e) => {
			const t = e.target.closest('button')
			if (!t) return
			if (t.dataset.cta) {
				markRead([it.id])
				act(it)
			}
			if (t.dataset.open) openPanel()
			el.remove()
		})
		document.body.append(el)
		document.getElementById('proNudge')?.setAttribute('hidden', '')
	}

	async function markRead(ids) {
		const todo = ids.filter((id) => items.find((i) => i.id === id && !i.read))
		if (!todo.length) return
		for (const i of items) if (todo.includes(i.id)) i.read = true
		paintBadge()
		try {
			const d = await proFetch('/pro/inbox/read', { print: pro.print, ids: todo })
			if (Array.isArray(d.items)) items = d.items
			paintBadge()
		} catch {}
	}

	// Borrar de tu buzón (para los demás sigue)
	async function hide(ids) {
		items = items.filter((i) => !ids.includes(i.id))
		paintBadge()
		if (panel) paintPanel()
		try {
			const d = await proFetch('/pro/inbox/hide', { print: pro.print, ids })
			if (Array.isArray(d.items)) items = d.items
		} catch {
			load(true)
		}
		paintBadge()
		if (panel) paintPanel()
	}

	function paintPanel() {
		const list = items.length
			? items
					.map(
						(it) => `<div class="inbox-item${it.read && !fresh.has(it.id) ? '' : ' new'}"><div class="inbox-item-head"><b>${esc(it.title)}</b><span>${when(it.at)}</span><button class="inbox-del" data-del="${it.id}" title="${tl('inbox.del')}" aria-label="${tl('inbox.delAria')}">${TRASH}</button></div><p>${esc(it.body)}</p>${it.cta ? `<div>${ctaBtn(it, 'btn small')}</div>` : ''}</div>`,
					)
					.join('')
			: `<p class="inbox-empty">${tl('inbox.empty')}</p>`
		panel.querySelector('.inbox-list').innerHTML = list
		panel.querySelector('[data-all]').hidden = items.length < 2
	}

	function openPanel() {
		document.getElementById('inboxPop')?.remove()
		if (panel) return closePanel()
		fresh = new Set(items.filter((i) => !i.read).map((i) => i.id))
		panel = document.createElement('div')
		panel.className = 'inbox-panel'
		panel.setAttribute('role', 'dialog')
		panel.setAttribute('aria-label', tl('inbox.title'))
		panel.innerHTML = `<div class="inbox-panel-head"><b>${tl('inbox.title')}</b><span class="inbox-head-act"><button class="inbox-all" data-all hidden>${tl('inbox.delAll')}</button><button class="icon-btn small" data-x aria-label="${tl('common.close')}">✕</button></span></div><div class="inbox-list"></div>`
		panel.addEventListener('click', (e) => {
			const t = e.target.closest('button')
			if (!t) return
			if (t.dataset.x !== undefined) return closePanel()
			if (t.dataset.del) return hide([Number(t.dataset.del)])
			if (t.dataset.all !== undefined) return confirm(tl('inbox.confirmAll')) && hide(items.map((i) => i.id))
			const it = items.find((i) => String(i.id) === t.dataset.cta)
			if (it) {
				closePanel()
				act(it)
			}
		})
		btn.parentNode.append(panel)
		paintPanel()
		btn.setAttribute('aria-expanded', 'true')
		markRead(items.filter((i) => !i.read).map((i) => i.id))
		load(true)
	}
	function closePanel() {
		panel?.remove()
		panel = null
		btn.setAttribute('aria-expanded', 'false')
	}

	btn.addEventListener('click', (e) => {
		e.stopPropagation()
		openPanel()
	})
	document.addEventListener('click', (e) => {
		// composedPath: el botón pulsado puede haberse quitado ya al repintar la lista (borrar)
		if (panel && !e.composedPath().includes(panel) && e.target !== btn) closePanel()
	})
	document.addEventListener('keydown', (e) => e.key === 'Escape' && closePanel())
	window.addEventListener('tp:inbox', () => load(true))
	document.addEventListener('visibilitychange', () => !document.hidden && load())
	window.TPInbox = { open: openPanel, load }

	// Hasta que el terminal sabe la huella de tu token no se puede pedir nada; luego, cada 5 min por si el aviso en vivo
	// no llegó (sin libro en vivo, por ejemplo)
	let wantOpen = new URLSearchParams(location.search).get('buzon') === 'open'
	setInterval(() => {
		if (typeof pro === 'undefined' || !pro.print) {
			if (loadedFor) (loadedFor = null), (items = []), paintBadge()
			return
		}
		if (loadedFor !== pro.print) {
			// Otra cuenta: los mensajes de la anterior no se ven ni un momento
			if (loadedFor) {
				loadedFor = null
				items = []
				closePanel()
				document.getElementById('inboxPop')?.remove()
				paintBadge()
				// Y los de la nueva se piden ya
				lastLoad = 0
			}
			if (Date.now() - lastLoad <= 20_000) return
			load(true).then(() => {
				if (wantOpen && loadedFor) (wantOpen = false), openPanel()
			})
		}
	}, 1500)
	setInterval(() => load(), 5 * 60_000)
})()
