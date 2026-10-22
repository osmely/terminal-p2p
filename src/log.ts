const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const
type Level = keyof typeof LEVELS

// En Workers no hay process: el nivel por defecto es info
const envLevel = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.LOG_LEVEL as Level | undefined
const threshold = LEVELS[envLevel ?? 'info'] ?? LEVELS.info

function emit(level: Level, scope: string, msg: string, extra?: unknown) {
	if (LEVELS[level] < threshold) return
	const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${msg}`
	const out = level === 'error' || level === 'warn' ? console.error : console.log
	if (extra === undefined) out(line)
	else out(line, extra)
}

export type Logger = ReturnType<typeof logger>

export function logger(scope: string) {
	return {
		debug: (msg: string, extra?: unknown) => emit('debug', scope, msg, extra),
		info: (msg: string, extra?: unknown) => emit('info', scope, msg, extra),
		warn: (msg: string, extra?: unknown) => emit('warn', scope, msg, extra),
		error: (msg: string, extra?: unknown) => emit('error', scope, msg, extra),
	}
}
