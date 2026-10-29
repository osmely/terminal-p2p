// Panel de administración único (app.terminalp2p.com/admin), con la clave del panel (METRICS_KEY):
// métricas del P2P, el simulador y Pro (inicio con lo pendiente, pagos, cuentas, informes y registro), con una
// barra lateral para moverse entre todo

export type AdminTab = 'metrics' | 'sim' | 'pro' | 'pro-pagos' | 'pro-cuentas' | 'pro-incidencias' | 'pro-informes' | 'pro-registro'

// Iconos de trazo (24×24), en línea para no depender de nada externo
const icon = (d: string) => `<svg viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`
const ICONS = {
	chart: icon('<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>'),
	candles: icon('<path d="M7 3v4M7 17v4M17 5v4M17 15v4"/><rect x="5" y="7" width="4" height="10" rx="1"/><rect x="15" y="9" width="4" height="6" rx="1"/>'),
	home: icon('<path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>'),
	card: icon('<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20M6 15h4"/>'),
	users: icon('<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 7M18 14a6 6 0 0 1 3.5 6"/>'),
	report: icon('<path d="M3 3v18h18"/><path d="m7 15 4-4 3 3 5-6"/>'),
	list: icon('<path d="M9 6h12M9 12h12M9 18h12M4 6h.01M4 12h.01M4 18h.01"/>'),
	flag: icon('<path d="M5 21V4M5 4h11l-2 4 2 4H5"/>'),
}

const NAV: [string, [AdminTab, string, string, string][]][] = [
	[
		'General',
		[
			['metrics', 'Métricas', '/admin/metrics', ICONS.chart],
			['sim', 'Simulador', '/admin/sim', ICONS.candles],
		],
	],
	[
		'Pro',
		[
			['pro', 'Inicio', '/admin/pro', ICONS.home],
			['pro-pagos', 'Pagos', '/admin/pro?view=pagos', ICONS.card],
			['pro-cuentas', 'Cuentas', '/admin/pro?view=cuentas', ICONS.users],
			['pro-incidencias', 'Incidencias', '/admin/pro?view=incidencias', ICONS.flag],
			['pro-informes', 'Informes', '/admin/pro?view=informes', ICONS.report],
			['pro-registro', 'Registro', '/admin/pro?view=registro', ICONS.list],
		],
	],
]

const LOGO = `<svg viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="8" fill="#5b8cff"/><path d="M7 21l6-7 4.5 4L25 9" fill="none" stroke="#fff" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`

const CSS = `
:root{--bg:#0b0e13;--side:#0e1218;--surface:#12171f;--raised:#171d27;--line:#212935;--line2:#2b3442;--text:#e8ecf2;--text2:#b2bccb;--muted:#7f8a9c;--accent:#5b8cff;--accent-bg:rgba(91,140,255,.14);--bid:#22c58f;--ask:#f25467;--warn:#f0b93a;--shadow:0 1px 2px rgba(0,0,0,.3);color-scheme:dark}
@media (prefers-color-scheme:light){:root{--bg:#f5f6f8;--side:#fbfbfc;--surface:#fff;--raised:#f8f9fb;--line:#e5e8ed;--line2:#d7dce3;--text:#131a24;--text2:#3e4a5b;--muted:#6c7889;--accent:#2f6bff;--accent-bg:rgba(47,107,255,.09);--bid:#0d9668;--ask:#d72f48;--warn:#b7791f;--shadow:0 1px 2px rgba(16,24,40,.05);color-scheme:light}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 Inter,system-ui,-apple-system,'Segoe UI',sans-serif;font-feature-settings:'cv11','ss01';-webkit-font-smoothing:antialiased;font-variant-numeric:tabular-nums}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
svg{width:18px;height:18px;flex:none;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}

.shell{display:grid;grid-template-columns:236px minmax(0,1fr);min-height:100vh}
.side{position:sticky;top:0;height:100vh;display:flex;flex-direction:column;gap:18px;padding:18px 12px;background:var(--side);border-right:1px solid var(--line)}
.logo{display:flex;align-items:center;gap:10px;padding:4px 8px;color:var(--text)}.logo:hover{text-decoration:none}.logo svg{width:30px;height:30px}
.logo b{display:block;font-size:14px;font-weight:650;letter-spacing:-.01em}.logo small{display:block;color:var(--muted);font-size:12px;margin-top:-2px}
.nav{display:flex;flex-direction:column;gap:2px}
.nav .group{margin:14px 10px 6px;color:var(--muted);font-size:11px;font-weight:600;letter-spacing:.06em;text-transform:uppercase}.nav .group:first-child{margin-top:0}
.nav a{display:flex;align-items:center;gap:10px;padding:7px 10px;border-radius:8px;color:var(--text2);font-weight:500}
.nav a:hover{background:var(--raised);color:var(--text);text-decoration:none}
.nav a.on{background:var(--accent-bg);color:var(--accent)}
.nav a em{margin-left:auto;min-width:20px;padding:0 6px;border-radius:999px;background:#f5b83d;color:#1a1300;font:600 11.5px/20px Inter,system-ui,sans-serif;font-style:normal;text-align:center}
.side-foot{margin-top:auto;padding:10px;border-top:1px solid var(--line);color:var(--muted);font-size:12px}

.main{padding:28px 36px 72px;max-width:1240px;width:100%}
.ph{display:flex;flex-wrap:wrap;gap:16px;align-items:flex-end;justify-content:space-between;margin-bottom:22px}
.ph h1{margin:0;font-size:22px;font-weight:650;letter-spacing:-.02em;display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.ph p{margin:4px 0 0;color:var(--muted);font-size:13.5px;max-width:720px}
.ph-actions{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.crumb{display:inline-flex;align-items:center;gap:6px;margin-bottom:10px;color:var(--muted);font-size:13px}.crumb:hover{color:var(--text)}
h1{margin:0;font-size:22px}h2{margin:0;font-size:15px;font-weight:600}
h2.sec-title{margin:22px 0 8px;font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}
.note{color:var(--muted);font-size:12.5px}p.note{margin:8px 0 0}

.panel{margin-top:20px;background:var(--surface);border:1px solid var(--line);border-radius:12px;box-shadow:var(--shadow);overflow:hidden}
.panel-h{display:flex;flex-wrap:wrap;gap:10px;align-items:center;justify-content:space-between;padding:14px 18px;border-bottom:1px solid var(--line)}
.panel-h h2{display:flex;align-items:center;gap:8px}.panel-h p{margin:2px 0 0;color:var(--muted);font-size:12.5px}
.panel-a{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.panel-b{padding:16px 18px}.panel-b.flush{padding:0}
.panel-b.flush .wrap table{border:0;border-radius:0;box-shadow:none}
.panel-f{padding:10px 18px;border-top:1px solid var(--line);background:var(--raised);color:var(--muted);font-size:12.5px}

.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-top:4px}
.card{display:flex;flex-direction:column;gap:2px;padding:16px 18px;border-radius:12px;background:var(--surface);border:1px solid var(--line);box-shadow:var(--shadow)}
.card span{font-size:12.5px;color:var(--muted);font-weight:500}.card b{margin-top:4px;font-size:24px;font-weight:650;letter-spacing:-.02em}.card small{color:var(--text2);font-size:12.5px}

.ranges{display:inline-flex;gap:2px;padding:3px;border-radius:9px;background:var(--raised);border:1px solid var(--line)}
.ranges a{padding:5px 12px;border-radius:7px;color:var(--text2);font-size:13px;font-weight:500;white-space:nowrap}.ranges a:hover{text-decoration:none;color:var(--text)}
.ranges a.on{background:var(--surface);color:var(--text);box-shadow:0 1px 3px rgba(0,0,0,.18)}

.funnels{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:12px;margin-top:20px}
.funnel{padding:16px 18px;border-radius:12px;background:var(--surface);border:1px solid var(--line);box-shadow:var(--shadow)}.funnel h3{margin:0 0 4px;font-size:14px;font-weight:600}.funnel p{margin:0 0 14px;color:var(--muted);font-size:12.5px}
.funnel ol{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px}.funnel li{display:grid;grid-template-columns:64px 1fr auto;align-items:baseline;gap:10px;padding:8px 12px;border-radius:8px;background:var(--raised)}
.funnel li b{font-size:17px;font-weight:650}.funnel li span{color:var(--text2);font-size:13px}.funnel li em{font-style:normal;color:var(--bid);font-weight:600;font-size:13px}

.wrap{overflow-x:auto}
table{width:100%;border-collapse:separate;border-spacing:0;background:var(--surface);border:1px solid var(--line);border-radius:12px;font-size:13.5px}
th,td{padding:11px 14px;text-align:right;border-bottom:1px solid var(--line);white-space:nowrap;vertical-align:middle}
th:first-child,td:first-child{text-align:left}
th{position:sticky;top:0;background:var(--raised);color:var(--muted);font-size:11.5px;font-weight:600;letter-spacing:.04em;text-transform:uppercase}
tr:last-child td{border-bottom:0}tbody tr:hover td,tr:hover>td{background:color-mix(in srgb,var(--raised) 70%,transparent)}
table.left th,table.left td{text-align:left}table.left td.num,table.left th.num{text-align:right}
td .note{font-size:12px}
.empty{color:var(--muted);padding:28px 16px;text-align:center}td.empty{text-align:center!important}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px}

input,select,textarea,button{font:inherit;color:inherit}
input,select{height:34px;padding:0 11px;border-radius:8px;border:1px solid var(--line2);background:var(--surface);font-size:13.5px}
input:focus,select:focus,textarea:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-bg)}
input::placeholder{color:var(--muted)}
textarea{width:100%;min-height:260px;background:var(--surface);border:1px solid var(--line2);border-radius:10px;padding:12px;font:13px/1.5 ui-monospace,Menlo,monospace}
button{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:34px;padding:0 14px;border:1px solid var(--accent);border-radius:8px;background:var(--accent);color:#fff;font-weight:600;font-size:13.5px;cursor:pointer;white-space:nowrap}
button:hover{filter:brightness(1.08)}
button.ghost{background:var(--surface);border-color:var(--line2);color:var(--text)}button.ghost:hover{background:var(--raised);filter:none}
button.danger{background:transparent;border-color:color-mix(in srgb,var(--ask) 45%,transparent);color:var(--ask)}
.ph-actions a.btn,.panel-a a.btn{display:inline-flex;align-items:center;gap:6px;height:34px;padding:0 12px;border-radius:8px;border:1px solid var(--line2);background:var(--surface);color:var(--text);font-weight:500;font-size:13px}.ph-actions a.btn:hover,.panel-a a.btn:hover{background:var(--raised);text-decoration:none}
form.row{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:0}
.search{position:relative}.search input{width:260px;padding-left:34px}.search svg{position:absolute;left:10px;top:8px;width:16px;height:16px;color:var(--muted)}

.flash{margin-bottom:18px}
.flash>.ok,.flash>.note{margin:0 0 8px;padding:11px 14px;border-radius:10px;font-size:13.5px}
.flash>.ok{background:color-mix(in srgb,var(--bid) 12%,var(--surface));border:1px solid color-mix(in srgb,var(--bid) 35%,transparent);color:var(--text)}
.flash>.note{background:color-mix(in srgb,var(--warn) 12%,var(--surface));border:1px solid color-mix(in srgb,var(--warn) 40%,transparent);color:var(--text)}
.flash>.ok::before{content:"✓";margin-right:8px;color:var(--bid);font-weight:700}.flash>.note::before{content:'!';margin-right:8px;color:var(--warn);font-weight:700}
.flash button{height:28px;margin-left:4px}
.ok{color:var(--bid)}
.allclear{display:flex;align-items:center;gap:12px;color:var(--text2)}.allclear i{display:grid;place-items:center;width:32px;height:32px;border-radius:50%;background:color-mix(in srgb,var(--bid) 15%,transparent);color:var(--bid);font-style:normal;font-weight:700}

.toggles{display:flex;flex-direction:column}
.flag{display:grid;grid-template-columns:auto 1fr auto;gap:4px 14px;align-items:center;padding:14px 18px;border-bottom:1px solid var(--line);margin:0}.flag:last-child{border-bottom:0}
.flag b{grid-column:2;font-weight:600;display:flex;align-items:center;gap:8px}.flag .note{grid-column:2;margin:0}.flag button{grid-column:3;grid-row:1/3}
.flag::before{content:'';grid-row:1/3;width:10px;height:10px;border-radius:50%;background:var(--muted);box-shadow:0 0 0 4px color-mix(in srgb,var(--muted) 18%,transparent)}
.flag.on::before{background:var(--bid);box-shadow:0 0 0 4px color-mix(in srgb,var(--bid) 18%,transparent)}
.flag.paused::before{background:var(--warn);box-shadow:0 0 0 4px color-mix(in srgb,var(--warn) 20%,transparent)}

.pill{display:inline-flex;align-items:center;gap:6px;padding:2px 9px;border-radius:999px;font-size:12px;font-weight:600;line-height:18px;background:color-mix(in srgb,var(--muted) 16%,transparent);color:var(--text2);vertical-align:middle;white-space:nowrap}
.pill::before{content:'';width:6px;height:6px;border-radius:50%;background:currentColor}
.pill.requested{background:color-mix(in srgb,var(--warn) 16%,transparent);color:var(--warn)}.pill.approved{background:color-mix(in srgb,var(--ask) 14%,transparent);color:var(--ask)}
.pill.transferred,.pill.approved-ok{background:color-mix(in srgb,var(--bid) 14%,transparent);color:var(--bid)}.pill.rejected{background:color-mix(in srgb,var(--ask) 10%,transparent);color:var(--ask)}
.count{display:inline-block;min-width:22px;padding:0 7px;border-radius:999px;background:#f5b83d;color:#1a1300;font-size:12px;font-weight:600;line-height:20px;text-align:center}

.rf{padding:16px 18px;border-bottom:1px solid var(--line)}.rf:last-child{border-bottom:0}
.rf-head{display:flex;flex-wrap:wrap;align-items:center;gap:6px 8px}.rf p{margin:8px 0 0}.rf form{margin-top:12px}.rf form input{flex:1 1 260px}
.noteline{margin:0;padding:12px 18px;border-top:1px solid var(--line)}.noteline .note{display:block;margin-bottom:2px}
.bid{color:var(--bid)}.ask{color:var(--ask)}
.stack{display:flex;flex-direction:column;gap:10px}
.grid2{display:grid;grid-template-columns:minmax(0,1.4fr) minmax(0,1fr);gap:20px;align-items:start}.grid2>.panel{margin-top:20px}
.grid3{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:0 20px;align-items:start}
.grid3 .panel-b form.row input{min-width:0}
.code{display:inline-block;font:600 18px ui-monospace,Menlo,monospace;padding:10px 14px;border-radius:8px;background:color-mix(in srgb,var(--warn) 14%,transparent);color:var(--warn)}

@media (max-width:1000px){.grid2{grid-template-columns:minmax(0,1fr);gap:0}}
@media (max-width:860px){
.shell{display:block}
.side{position:sticky;z-index:5;height:auto;flex-direction:row;align-items:center;gap:10px;padding:10px 12px;border-right:0;border-bottom:1px solid var(--line);overflow-x:auto;scrollbar-width:none}
.logo{padding:0}.logo span{display:none}.nav{flex-direction:row;gap:2px}.nav .group,.side-foot{display:none}.nav a{padding:7px 10px;white-space:nowrap}.nav a svg{display:none}
.main{padding:18px 14px 56px}
.ph{margin-bottom:16px;align-items:flex-start}.ph h1{font-size:19px}.ph-actions,.ph-actions form,.search,.search input{width:100%}
.cards{grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}.card{padding:12px 14px}.card b{font-size:19px}
.panel{margin-top:14px}.panel-h,.panel-b,.rf,.flag{padding-left:14px;padding-right:14px}
.flag{grid-template-columns:auto 1fr}.flag button{grid-column:1/3;grid-row:auto;width:100%;margin-top:6px}
.rf form input,.rf form button{flex:1 1 100%}.rf form button.ghost{flex:1 1 40%}
th,td{padding:9px 10px}table{font-size:13px}
.ranges{max-width:100%;overflow-x:auto;scrollbar-width:none}
}
`

// Cabecera de página: título, una línea de explicación y las acciones a la derecha
export const pageHead = (title: string, sub = '', actions = '') =>
	`<header class="ph"><div><h1>${title}</h1>${sub ? `<p>${sub}</p>` : ''}</div>${actions ? `<div class="ph-actions">${actions}</div>` : ''}</header>`

// Una sección con su título; `flush` para tablas de borde a borde
export const panel = (title: string, body: string, o: { sub?: string; actions?: string; flush?: boolean; foot?: string } = {}) =>
	`<section class="panel"><div class="panel-h"><div><h2>${title}</h2>${o.sub ? `<p>${o.sub}</p>` : ''}</div>${o.actions ? `<div class="panel-a">${o.actions}</div>` : ''}</div><div class="panel-b${o.flush ? ' flush' : ''}">${body}</div>${o.foot ? `<div class="panel-f">${o.foot}</div>` : ''}</section>`

export const searchIcon = icon('<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>')

// badges: un número junto a una sección del menú (lo pendiente en Inicio)
export function adminPage(active: AdminTab, title: string, body: string, status = 200, badges: Partial<Record<AdminTab, number>> = {}) {
	const nav = NAV.map(
		([group, items]) =>
			`<p class="group">${group}</p>${items.map(([id, name, href, svg]) => `<a href="${href}" class="${id === active ? 'on' : ''}">${svg}<span>${name}</span>${badges[id] ? `<em>${badges[id]}</em>` : ''}</a>`).join('')}`,
	).join('')
	return new Response(
		`<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${title} · Panel de Terminal P2P</title>
<link rel="icon" href="/favicon.svg"><link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap"><style>${CSS}</style></head>
<body><div class="shell"><aside class="side"><a class="logo" href="/admin/pro">${LOGO}<span><b>Terminal P2P</b><small>Panel de administración</small></span></a><nav class="nav">${nav}</nav><div class="side-foot">Horas de Cuba</div></aside>
<main class="main">${body}</main></div></body></html>`,
		{ status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' } },
	)
}

// Sin la clave, el navegador la pide (la misma para todo el panel)
export const askKey = () =>
	new Response('Necesitas la clave del panel', { status: 401, headers: { 'WWW-Authenticate': 'Basic realm="Terminal P2P metrics", charset="UTF-8"', 'Cache-Control': 'no-store' } })
