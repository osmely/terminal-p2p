// Mini App de prueba de Terminal P2P: comprobar cómo se ve y se comporta dentro de la app de QvaPay.
// Usa el SDK que inyecta la app (o el puente del simulador). No guarda nada ni habla con nuestro servidor.
const $ = (id) => document.getElementById(id)
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])

function facts(rows) {
	$('facts').innerHTML = rows.filter(([, v]) => v != null && v !== '').map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')
	$('info').hidden = false
}

async function start() {
	const Q = window.QvaPay
	$('inside').hidden = false
	$('login').hidden = false

	// Colores de la app de QvaPay
	const apply = (t) => {
		if (!t?.colors) return
		const r = document.documentElement.style
		r.setProperty('--bg', t.colors.bg)
		r.setProperty('--surface', t.colors.surface)
		r.setProperty('--text', t.colors.text)
		r.setProperty('--primary', t.colors.primary)
		r.setProperty('--line', t.mode === 'dark' ? '#ffffff22' : '#00000014')
		r.setProperty('--muted', t.mode === 'dark' ? '#a9b4c3' : '#6b7788')
	}
	try {
		apply(await Q.getTheme())
		Q.on('themeChanged', apply)
	} catch {}

	facts([
		['SDK', Q.version],
		['Mini App', Q.launchParams?.slug],
		['Idioma', Q.launchParams?.language],
	])
	Q.ready()

	$('login').addEventListener('click', async () => {
		$('login').disabled = true
		try {
			const res = await Q.auth.requestLogin({ scopes: ['profile', 'kyc'] })
			const data = new URLSearchParams(res.init_data)
			let user = {}
			try {
				user = JSON.parse(data.get('user') || '{}')
			} catch {}
			$('hello').textContent = `Hola, @${user.username || 'usuario'}`
			$('sub').textContent = 'QvaPay nos dijo quién eres, sin registro ni contraseña.'
			$('login').hidden = true
			facts([
				['SDK', Q.version],
				['Mini App', data.get('mini_app') || Q.launchParams?.slug],
				['Idioma', Q.launchParams?.language],
				['Permisos', res.scopes?.join(', ') || data.get('scopes')],
				['KYC', user.kyc == null ? null : user.kyc ? 'verificado' : 'no'],
				['GOLD', user.gold == null ? null : user.gold ? 'sí' : 'no'],
			])
			Q.ui.haptic('success').catch(() => {})
		} catch (e) {
			$('login').disabled = false
			if (e?.code !== 'USER_CANCELLED') Q.ui.toast(e?.message || 'No se pudo entrar', { type: 'error' }).catch(() => {})
		}
	})
}

if (window.QvaPay) start()
else window.addEventListener('qvapay:ready', start, { once: true })
// Fuera de QvaPay no llega nunca el SDK
setTimeout(() => {
	if (!window.QvaPay) $('outside').hidden = false
}, 1500)
