// Avisos al grupo privado de Telegram de quien lleva Terminal P2P (solo esa persona y el bot): pagos nuevos,
// devoluciones pedidas y el repaso diario. Solo avisan, con un botón al panel: las decisiones se toman en el
// panel, con su contraseña. Un fallo de Telegram nunca rompe un pago ni una petición

export interface AlertEnv {
	// Token del bot (secreto: npx wrangler secret put TELEGRAM_BOT_TOKEN) y el chat del grupo (variable ALERT_CHAT)
	TELEGRAM_BOT_TOKEN?: string
	ALERT_CHAT?: string
	STAGING?: string
}

export const alertsReady = (env: AlertEnv) => !!(env.TELEGRAM_BOT_TOKEN && env.ALERT_CHAT)

// El panel del mismo entorno (los avisos de staging llevan a staging)
export const panelUrl = (env: AlertEnv, path = '/admin/pro') => `${env.STAGING === '1' ? 'https://app.staging.terminalp2p.com' : 'https://app.terminalp2p.com'}${path}`

export const tgEsc = (s: string) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!)

// Manda el aviso (HTML de Telegram). path: a qué parte del panel lleva el botón. Devuelve si salió
export async function notify(env: AlertEnv, text: string, path = '/admin/pro', fetcher: typeof fetch = fetch): Promise<boolean> {
	if (!alertsReady(env)) return false
	try {
		const res = await fetcher(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				chat_id: env.ALERT_CHAT,
				text: `${env.STAGING === '1' ? '🧪 <b>STAGING</b>\n' : ''}${text}`,
				parse_mode: 'HTML',
				disable_web_page_preview: true,
				reply_markup: { inline_keyboard: [[{ text: 'Abrir en el panel', url: panelUrl(env, path) }]] },
			}),
			signal: AbortSignal.timeout(8000),
		})
		if (!res.ok) console.error(`avisos: Telegram respondió ${res.status}`)
		return res.ok
	} catch (err) {
		console.error(`avisos: ${(err as Error).message}`)
		return false
	}
}
