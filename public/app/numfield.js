// Campos de números (data-num): solo cifras y, si llevan decimales, un punto. Cada campo dice su teclado del móvil:
// inputmode="decimal" (con punto) o, los enteros (data-num="int"), inputmode="numeric". data-dec="2": como mucho 2 decimales.
// data-num="digits": teléfonos y carnés (cifras, espacios y un + delante). data-num="card": tarjetas cubanas, 16 cifras de
// 4 en 4 (9200 1234 5678 9012); lo que se manda va sin los espacios (TPNum.val), que es lo que se pega bien en el banco.
// Junto a la tarjeta sale un aviso si QvaPay no la aceptaría (cardIssue)
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
		if (next !== v) {
			const d = Math.min(v.slice(0, el.selectionStart ?? v.length).replace(/\D/g, '').length, digits.length)
			const at = d ? d + Math.floor((d - 1) / 4) : 0
			el.value = next
			try {
				el.setSelectionRange(at, at)
			} catch {}
		}
		// Mientras se escribe no se avisa: al tener las 16 cifras, o si ya había un aviso (para quitarlo al corregir)
		if (digits.length === CARD_MAX || el.dataset.cardMsg) mark(el)
	}

	// Lo que QvaPay pide al Nro de tarjeta en CUP, MLC, Clásica y Tropical (docs/withdraw/list y docs/p2p/create): 16 cifras,
	// dígito de control Luhn y que la tarjeta sea del tipo que paga ese método. Al vender es obligatorio; al comprar el
	// campo es opcional y solo se rechazan las Visa y Mastercard. Los prefijos son los de su tabla, completada con su
	// catálogo público (github.com/qvapay/cuban_cards_prefixes). Un prefijo que no está en ninguna lista no se marca:
	// QvaPay acepta productos nuevos de los bancos que conoce. La 9250 sale como MLC en el catálogo y como Tropical en la
	// tabla de QvaPay: no se marca en ningún mercado
	const CARD_KINDS = {
		cup: ['9200', '9202', '9204', '9205', '9206', '9210', '9211', '9212', '9213', '9216', '9224', '9227', '9233', '9234', '9237', '9238', '9244', '9248'],
		mlc: ['9225', '9226', '9228', '9229', '9235', '9245'],
		tropical: ['9240', '9256'],
		clasica: ['9760'],
	}
	// Los tipos que acepta cada mercado, y el mercado de cada tipo (para decir dónde va esa tarjeta)
	const CARD_OK = { BANK_CUP: ['cup'], BANK_MLC: ['mlc'], BANDECPREPAGO: ['tropical'], CLASICA: ['clasica', 'tropical'] }
	const KIND_MARKET = { cup: 'BANK_CUP', mlc: 'BANK_MLC', tropical: 'BANDECPREPAGO', clasica: 'CLASICA' }

	// Dígito de control (ISO/IEC 7812): de derecha a izquierda, una cifra de cada dos se dobla
	function luhn(n) {
		let sum = 0
		for (let i = 0; i < n.length; i++) {
			let d = Number(n[n.length - 1 - i])
			if (i % 2) d = d * 2 > 9 ? d * 2 - 9 : d * 2
			sum += d
		}
		return sum % 10 === 0
	}

	// Visa (4…) y Mastercard (51–55 y 2221–2720): QvaPay no las deja en ningún lado de la oferta
	function brandOf(n) {
		const p4 = Number(n.slice(0, 4))
		if (n[0] === '4') return 'Visa'
		if ((p4 >= 5100 && p4 <= 5599) || (p4 >= 2221 && p4 <= 2720)) return 'Mastercard'
		return null
	}

	// El problema de un número de tarjeta: { block, key, vars } (block: QvaPay la rechazaría seguro), o null si está bien
	// o vacía. coin: el mercado ('' si no se sabe); optional: el campo es opcional (al comprar)
	function cardIssue(raw, coin = '', optional = false) {
		const n = String(raw ?? '').replace(/\D/g, '')
		if (!n) return null
		if (n.length !== CARD_MAX) return { block: true, key: 'digits', vars: { n: CARD_MAX } }
		const brand = brandOf(n)
		if (brand) return { block: true, key: 'foreign', vars: { brand } }
		if (!luhn(n)) return { block: !optional, key: 'checksum', vars: {} }
		const kind = Object.keys(CARD_KINDS).find((k) => CARD_KINDS[k].includes(n.slice(0, 4)))
		if (kind && CARD_OK[coin] && !CARD_OK[coin].includes(kind)) return { block: !optional, key: 'method', vars: { kind, coin, right: KIND_MARKET[kind] } }
		// Ni RED (92…) ni Clásica: puede ser un número de cuenta. La regla exacta de QvaPay no está publicada: solo se avisa
		if (!/^(92|9760)/.test(n) && (!coin || CARD_OK[coin])) return { block: false, key: 'notCuban', vars: {} }
		return null
	}

	// El texto del aviso. El simulador no carga i18n.js ni tiene tarjetas: allí, en español y sin detalle
	function cardText(issue) {
		if (typeof tl !== 'function') return `El número de tarjeta no es válido: revísalo`
		const market = (tick) => (typeof nameOf === 'function' ? nameOf(tick) : tick)
		const kinds = { cup: tl('numfield.kindCup'), mlc: tl('numfield.kindMlc'), tropical: tl('numfield.kindTropical'), clasica: tl('numfield.kindClasica') }
		const wants = { BANK_CUP: tl('numfield.wantCup'), BANK_MLC: tl('numfield.wantMlc'), BANDECPREPAGO: tl('numfield.wantTropical'), CLASICA: tl('numfield.wantClasica') }
		const v = issue.vars
		if (issue.key === 'digits') return tl('numfield.cardDigits', v)
		if (issue.key === 'foreign') return tl('numfield.cardForeign', v)
		if (issue.key === 'checksum') return tl('numfield.cardChecksum')
		if (issue.key === 'method') return tl('numfield.cardMethod', { kind: kinds[v.kind], market: market(v.coin), want: wants[v.coin], right: market(v.right) })
		return tl('numfield.cardNotCuban')
	}

	// El campo dice su mercado (data-coin) y, si es opcional, data-card-optional="1"
	const issueOf = (el) => (el.dataset?.num === 'card' ? cardIssue(el.value, el.dataset.coin ?? '', el.dataset.cardOptional === '1') : null)

	// El aviso junto al campo: en rojo si QvaPay la rechazaría, en amarillo si solo es raro
	function mark(el) {
		const issue = issueOf(el)
		let msg = el.nextElementSibling?.classList.contains('field-msg') ? el.nextElementSibling : null
		if (!issue) {
			msg?.remove()
			delete el.dataset.cardMsg
			el.removeAttribute('aria-invalid')
			return
		}
		if (!msg) {
			msg = document.createElement('span')
			msg.id = `fm-${Math.random().toString(36).slice(2, 9)}`
			el.after(msg)
			el.setAttribute('aria-describedby', msg.id)
		}
		msg.className = `field-msg ${issue.block ? 'err' : 'warn'}`
		msg.textContent = cardText(issue)
		el.dataset.cardMsg = '1'
		if (issue.block) el.setAttribute('aria-invalid', 'true')
		else el.removeAttribute('aria-invalid')
	}

	// Al salir del campo sí se avisa de una tarjeta a medias
	document.addEventListener('focusout', (e) => e.target instanceof HTMLInputElement && e.target.dataset.num === 'card' && mark(e.target))

	// Los datos de cobro de QvaPay son todos texto: los que son números (tarjeta, celular, carné) se marcan por su nombre.
	// «Correo o Celular» (Zelle) y el correo de TropiPay siguen siendo texto
	// «Nro de cuenta o tarjeta» (Sberbank) puede ser una cuenta, más larga: va como cifras, sin el formato de tarjeta
	const isCard = (n) => /tarjeta/i.test(n) && !/correo|mail|cuenta/i.test(n)
	window.TPNum = {
		// coin: el mercado del campo, para comprobar que la tarjeta es de su tipo
		detail(name, coin) {
			const n = String(name ?? '')
			if (/correo|mail/i.test(n) || !/tarjeta|celular|tel[eé]fono|m[oó]vil|carn[eé]t|^number$/i.test(n)) return ''
			if (isCard(n)) return ` data-num="card" inputmode="numeric"${coin ? ` data-coin="${String(coin).replace(/[^\w-]/g, '')}"` : ''}`
			return ` data-num="digits" inputmode="${/celular|tel[eé]fono|m[oó]vil/i.test(n) ? 'tel' : 'numeric'}"`
		},
		// Lo guardado, como se ve al escribir (la tarjeta de 4 en 4)
		show(name, v) {
			const s = String(v ?? '')
			return isCard(String(name ?? '')) && /^[\d\s-]+$/.test(s) ? s.replace(/\D/g, '').replace(/(\d{4})(?=\d)/g, '$1 ') : s
		},
		// ¿Alguna tarjeta de estos campos que QvaPay rechazaría? El aviso para el usuario, o '' si están bien (o vacías)
		cardError(els) {
			const issue = [...els].map(issueOf).find((i) => i?.block)
			return issue ? cardText(issue) : ''
		},
		// Lo que no bloquea pero conviene mirar (una tarjeta rara, o mal al comprar, donde es opcional): el aviso, o ''
		cardWarn(els) {
			const issue = [...els].map(issueOf).find((i) => i && !i.block)
			return issue ? cardText(issue) : ''
		},
		// Pone (o quita) el aviso de cada tarjeta con algo escrito: al pintar el formulario con lo guardado o al cambiar de lado
		markAll(root) {
			for (const el of root?.querySelectorAll('input[data-num="card"]') ?? []) if (el.value || el.dataset.cardMsg) mark(el)
		},
		cardIssue,
		// El valor que se manda: la tarjeta sin espacios, lo demás tal cual (sin espacios a los lados)
		val(el) {
			return el.dataset.num === 'card' ? el.value.replace(/\D/g, '') : el.value.trim()
		},
	}
})()
