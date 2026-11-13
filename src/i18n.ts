// Textos de pantalla de lo que corre en el navegador (src/broker, web/): los traduce public/app/i18n.js, que se
// carga antes que data.js. Sin él (las pruebas, si no lo cargan) queda la clave
type Vars = Record<string, string | number | null | undefined>
const g = globalThis as { tl?: (key: string, vars?: Vars) => string; TPI18N?: { locale?: string } }

export const tl = (key: string, vars?: Vars): string => (g.tl ? g.tl(key, vars) : key)

// Locale de fechas y horas del idioma elegido (los números van siempre en en-US). Las horas, con hourCycle 'h23'
export const locale = (): string => g.TPI18N?.locale ?? 'es'
