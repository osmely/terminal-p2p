// Campos de números (data-num): solo cifras y, si llevan decimales, un punto. Cada campo dice su teclado del móvil:
// inputmode="decimal" (con punto) o, los enteros (data-num="int"), inputmode="numeric". data-dec="2": como mucho 2 decimales.
// data-num="digits": teléfonos y carnés (cifras, espacios y un + delante). data-num="card": tarjetas cubanas, 16 cifras de
// 4 en 4 (9200 1234 5678 9012); lo que se manda va sin los espacios (TPNum.val), que es lo que se pega bien en el banco
// La coma decimal de los teclados en español pasa a punto; al pegar 1,050.25 se quitan las comas de los miles.
// Lo usan el terminal, el módulo Pro y el simulador (los campos que se pintan después también: escucha en document)
'use strict'
;(() => {
	function clean(v, int, dec, paste, digits) {
		if (digits) return String(v).replace(/[^\d +]/g, '').replace(/(?!^)\+/g, '')
		let s = String(v).replace(/\s/g, '')
		if (s.includes(',')) {
			// Pegado con comas de miles (1,050 o 1,050.25): fuera las comas; si no, la coma es el punto decimal
			const thousands = s.includes('.') || (paste && /^\d{1,3}(,\d{3})+$/.test(s))
			s = thousands ? s.replace(/,/g, '') : s.replace(/,/g, '.')
		}
		s = s.replace(/[^\d.]/g, '')
		if (int) return s.replace(/\./g, '')
		const i = s.indexOf('.')
		if (i < 0) return s
		const frac = s.slice(i + 1).replace(/\./g, '')
		return `${s.slice(0, i)}.${dec >= 0 ? frac.slice(0, dec) : frac}`
	}

	document.addEventListener(
		'input',
		(e) => {
			const el = e.target
			if (!(el instanceof HTMLInputElement) || !el.hasAttribute('data-num')) return
			if (el.dataset.num === 'card') return card(el)
			const int = el.dataset.num === 'int'
			const digits = el.dataset.num === 'digits'
			const dec = el.dataset.dec == null ? -1 : Number(el.dataset.dec)
			const v = el.value
			const next = clean(v, int, dec, e.inputType === 'insertFromPaste', digits)
			if (next === v) return
			// El cursor se queda donde estaba, sin contar lo que se quitó antes de él
			const caret = el.selectionStart ?? v.length
			const before = clean(v.slice(0, caret), int, dec, false, digits).length
			el.value = next
			try {
				el.setSelectionRange(Math.min(before, next.length), Math.min(before, next.length))
			} catch {}
		},
		true,
	)

	// Las cifras de 4 en 4; el cursor sigue detrás de la misma cifra. Las tarjetas de los mercados del terminal (CUP, MLC,
	// Clásica, Bandec Prepago) son cubanas: 16 cifras
	const CARD_MAX = 16
	function card(el) {
		const v = el.value
		const digits = v.replace(/\D/g, '').slice(0, CARD_MAX)
		const next = digits.replace(/(\d{4})(?=\d)/g, '$1 ')
		if (next === v) return
		const d = Math.min(v.slice(0, el.selectionStart ?? v.length).replace(/\D/g, '').length, digits.length)
		const at = d ? d + Math.floor((d - 1) / 4) : 0
		el.value = next
		try {
			el.setSelectionRange(at, at)
		} catch {}
	}

	// Los datos de cobro de QvaPay son todos texto: los que son números (tarjeta, celular, carné) se marcan por su nombre.
	// «Correo o Celular» (Zelle) y el correo de TropiPay siguen siendo texto
	// «Nro de cuenta o tarjeta» (Sberbank) puede ser una cuenta, más larga: va como cifras, sin el formato de tarjeta
	const isCard = (n) => /tarjeta/i.test(n) && !/correo|mail|cuenta/i.test(n)
	window.TPNum = {
		detail(name) {
			const n = String(name ?? '')
			if (/correo|mail/i.test(n) || !/tarjeta|celular|tel[eé]fono|m[oó]vil|carn[eé]t|^number$/i.test(n)) return ''
			if (isCard(n)) return ' data-num="card" inputmode="numeric"'
			return ` data-num="digits" inputmode="${/celular|tel[eé]fono|m[oó]vil/i.test(n) ? 'tel' : 'numeric'}"`
		},
		// Lo guardado, como se ve al escribir (la tarjeta de 4 en 4)
		show(name, v) {
			const s = String(v ?? '')
			return isCard(String(name ?? '')) && /^[\d\s-]+$/.test(s) ? s.replace(/\D/g, '').replace(/(\d{4})(?=\d)/g, '$1 ') : s
		},
		// ¿Hay alguna tarjeta a medias entre estos campos? El aviso para el usuario, o '' si están bien (o vacías)
		cardError(els) {
			const bad = [...els].some((el) => el.dataset?.num === 'card' && el.value.replace(/\D/g, '').length && el.value.replace(/\D/g, '').length !== CARD_MAX)
			return bad ? `El número de tarjeta lleva ${CARD_MAX} cifras: revísalo` : ''
		},
		// El valor que se manda: la tarjeta sin espacios, lo demás tal cual (sin espacios a los lados)
		val(el) {
			return el.dataset.num === 'card' ? el.value.replace(/\D/g, '') : el.value.trim()
		},
	}
})()
