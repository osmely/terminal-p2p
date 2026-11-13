// Idiomas del terminal: español (el original), inglés y portugués. Archivo aparte y sin defer, como theme.js: elige el
// idioma antes de pintar y carga solo su diccionario (lang/es.js, lang/en.js o lang/pt.js), que llega antes que
// data.js, app.js y los demás.
//   · tl('clave', { n: 3, user }) devuelve el texto en el idioma elegido; {nombre} se rellena con vars (los números,
//     con el formato de siempre, 1,050.25). Un valor [uno, varios] elige por vars.n (1 → el primero)
//   · El HTML fijo lleva data-i18n (texto), data-i18n-html, data-i18n-title, data-i18n-aria-label,
//     data-i18n-placeholder y data-i18n-alt; en español no se toca (ya está escrito así). Lo usan el terminal y la portada, cada uno
//     con sus diccionarios (/lang/ de su carpeta)
//   · Cambiar de idioma recarga la página: todo se vuelve a pintar ya traducido
// La primera vez sale de navigator.languages; luego queda guardado ('lang', como lo demás de store en app.js).
// Fuera del navegador (las pruebas de src/broker) es siempre español
;(() => {
	const LANGS = ['es', 'en', 'pt']
	// Locale de las fechas (días y meses). Los números no: siempre en-US (1,050.25), en cualquier idioma
	const LOCALES = { es: 'es', en: 'en-US', pt: 'pt-BR' }
	const browser = typeof document !== 'undefined'

	const pick = () => {
		if (!browser) return 'es'
		try {
			const saved = JSON.parse(localStorage.getItem('lang') || 'null')
			if (LANGS.includes(saved)) return saved
		} catch {}
		// La primera vez, el del navegador; ni español, ni inglés, ni portugués: quien no lee español entiende antes el
		// inglés. Queda guardado: luego solo lo cambia el selector
		const bases = (navigator.languages?.length ? navigator.languages : [navigator.language || '']).map((l) => String(l).toLowerCase().slice(0, 2))
		const l = bases.find((b) => LANGS.includes(b)) ?? 'en'
		try {
			localStorage.setItem('lang', JSON.stringify(l))
		} catch {}
		return l
	}
	const lang = pick()
	const dict = () => globalThis.TP_LANG?.[lang] ?? {}

	const fill = (s, vars) =>
		s.replace(/\{(\w+)\}/g, (m, k) => {
			if (!vars || !(k in vars)) return m
			const v = vars[k]
			return typeof v === 'number' ? v.toLocaleString('en-US') : String(v ?? '')
		})
	const missing = new Set()
	function tl(key, vars) {
		let v = dict()[key]
		if (v == null) {
			if (!missing.has(key)) console.warn(`i18n: falta «${key}» en ${lang}`)
			missing.add(key)
			return key
		}
		if (Array.isArray(v)) v = v[vars?.n === 1 ? 0 : 1]
		return vars ? fill(v, vars) : v
	}
	const has = (key) => dict()[key] != null
	// Nombre de un mercado: lo descriptivo se traduce (CUP Transferencia); las marcas y los nombres de QvaPay se quedan
	// (Saldo ETECSA, Zelle, TropiPay…) y no llevan clave
	const coin = (tick, name) => (has(`coin.${tick}`) ? tl(`coin.${tick}`) : name)

	// El HTML fijo (index.html y lo que se pinta con data-i18n): en español ya está escrito.
	// En data-i18n-html, {@nombre} es el hijo marcado data-i18n-slot="nombre", que se recoloca tal cual: así siguen
	// los precios y los días que pone el servidor en la portada, y si el servidor lo quitó (lo de Pro), no sale
	function apply(root = document) {
		if (lang === 'es') return
		const each = (attr, set) => {
			for (const el of root.querySelectorAll(`[${attr}]`)) set(el, tl(el.getAttribute(attr)))
		}
		each('data-i18n', (el, s) => (el.textContent = s))
		each('data-i18n-html', (el, s) => {
			const slots = new Map([...el.querySelectorAll('[data-i18n-slot]')].map((x) => [x.dataset.i18nSlot, x]))
			el.innerHTML = s.replace(/\{@(\w+)\}/g, '<i data-i18n-at="$1"></i>')
			for (const at of el.querySelectorAll('[data-i18n-at]')) {
				const x = slots.get(at.dataset.i18nAt)
				if (x) at.replaceWith(x)
				else at.remove()
			}
		})
		each('data-i18n-title', (el, s) => (el.title = s))
		each('data-i18n-aria-label', (el, s) => el.setAttribute('aria-label', s))
		each('data-i18n-placeholder', (el, s) => (el.placeholder = s))
		each('data-i18n-alt', (el, s) => (el.alt = s))
	}

	function set(l) {
		if (!LANGS.includes(l) || l === lang) return
		try {
			localStorage.setItem('lang', JSON.stringify(l))
		} catch {}
		location.reload()
	}

	globalThis.tl = tl
	globalThis.TPI18N = { lang, locale: LOCALES[lang], langs: LANGS, has, coin, apply, set }
	if (!browser) return

	document.documentElement.lang = lang
	// Solo el diccionario del idioma elegido, y antes que los scripts con defer (que lo usan al cargar): por eso
	// document.write y no un <script> añadido, que llegaría cuando quisiera
	if (document.readyState === 'loading') document.write(`<script src="/lang/${lang}.js"></script>`)

	// Con el HTML ya leído y antes de los scripts con defer: se traduce lo fijo y se arma el selector de la cabecera
	const ready = () => {
		apply()
		const box = document.getElementById('langPick')
		if (!box) return
		const cur = box.querySelector('.lang-cur')
		if (cur) cur.textContent = lang.toUpperCase()
		for (const b of box.querySelectorAll('[data-lang]')) {
			b.setAttribute('aria-checked', String(b.dataset.lang === lang))
			b.addEventListener('click', () => (b.dataset.lang === lang ? box.removeAttribute('open') : set(b.dataset.lang)))
		}
		// Se cierra al tocar fuera, como el menú de ayuda
		document.addEventListener('click', (e) => box.open && !box.contains(e.target) && box.removeAttribute('open'))
	}
	if (document.readyState === 'loading') document.addEventListener('readystatechange', ready, { once: true })
	else ready()
})()
