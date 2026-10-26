// Panel de administración único (app.terminalp2p.com/admin), con la clave del panel (METRICS_KEY):
// métricas del P2P y usuarios Pro, cada uno en su pestaña

export type AdminTab = 'metrics' | 'pro'
const TABS: [AdminTab, string][] = [
	['metrics', 'Métricas'],
	['pro', 'Pro'],
	
]

const CSS = `
:root{--bg:#0a0d12;--surface:#10151c;--line:#1e2733;--text:#e7ecf3;--text2:#a9b4c3;--muted:#7a8799;--accent:#5b8cff;--bid:#1fc28b;--ask:#f6465d;--warn:#f0b93a;color-scheme:dark}
@media (prefers-color-scheme:light){:root{--bg:#f6f8fb;--surface:#fff;--line:#e3e8ef;--text:#121821;--text2:#3f4b5b;--muted:#6b7788;--accent:#2f6bff;--bid:#0f9d6e;--ask:#d9304a;--warn:#b7791f;color-scheme:light}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 system-ui,-apple-system,'Segoe UI',sans-serif}
main{width:min(1040px,100% - 32px);margin:24px auto 64px}h1{margin:0;font-size:24px}h2{margin:32px 0 12px;font-size:17px}
.bar{display:flex;flex-wrap:wrap;gap:12px;align-items:center;justify-content:space-between;padding-bottom:16px;margin-bottom:20px;border-bottom:1px solid var(--line)}
.brand{font-weight:700;font-size:15px}.tabs{display:flex;gap:6px}
.tabs a{padding:6px 14px;border-radius:999px;border:1px solid var(--line);color:var(--text2);text-decoration:none;font-size:14px;font-weight:500}.tabs a.on{color:#fff;background:var(--accent);border-color:var(--accent)}
.top{display:flex;flex-wrap:wrap;gap:12px;align-items:center;justify-content:space-between}.note{color:var(--muted);font-size:13px;margin-top:6px}
.ranges{display:flex;gap:6px}.ranges a{padding:5px 12px;border-radius:999px;border:1px solid var(--line);color:var(--text2);text-decoration:none;font-size:13px}.ranges a.on{color:var(--accent);border-color:var(--accent)}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin-top:20px}
.card{display:flex;flex-direction:column;gap:4px;padding:16px;border-radius:12px;background:var(--surface);border:1px solid var(--line)}.card span{font-size:13px;color:var(--muted)}.card b{font:600 26px ui-monospace,Menlo,monospace}.card small{color:var(--text2);font-size:12.5px}
.funnels{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:12px}
.funnel{padding:16px;border-radius:12px;background:var(--surface);border:1px solid var(--line)}.funnel h3{margin:0 0 4px;font-size:15px}.funnel p{margin:0 0 12px;color:var(--muted);font-size:12.5px}
.funnel ol{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px}.funnel li{display:grid;grid-template-columns:70px 1fr auto;align-items:baseline;gap:10px;padding:8px 10px;border-radius:8px;background:var(--bg)}
.funnel li b{font:600 18px ui-monospace,Menlo,monospace}.funnel li em{font-style:normal;color:var(--bid);font:600 13px ui-monospace,Menlo,monospace}
table{width:100%;border-collapse:collapse;background:var(--surface);border:1px solid var(--line);border-radius:12px;overflow:hidden;font-size:14px}
th,td{padding:9px 12px;text-align:right;border-bottom:1px solid var(--line);white-space:nowrap}th:first-child,td:first-child{text-align:left}th{color:var(--muted);font-size:12px;font-weight:600}td{font-family:ui-monospace,Menlo,monospace}td:first-child{font-family:inherit}
table.left th,table.left td{text-align:left}
.wrap{overflow-x:auto}.empty{color:var(--muted);padding:16px;text-align:center}
input,select,textarea,button{font:inherit;color:inherit}
input,select{padding:7px 10px;border-radius:8px;border:1px solid var(--line);background:var(--surface)}
textarea{width:100%;min-height:260px;background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:12px;font:14px/1.5 ui-monospace,Menlo,monospace}
button{padding:8px 14px;border:0;border-radius:8px;background:var(--accent);color:#fff;font-weight:600;font-size:14px;cursor:pointer}
button.ghost{background:none;border:1px solid var(--line);color:var(--text2);padding:5px 10px;font-size:13px}
form.row{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.flag{margin-top:14px;padding:12px 14px;border:1px solid var(--line);border-radius:12px;background:var(--surface)}.flag .note{flex:1 1 300px;margin:0}.flag.on b{color:var(--bid)}
.ok{padding:10px 14px;border-radius:8px;background:color-mix(in srgb,var(--bid) 14%,transparent);color:var(--bid)}
.code{display:inline-block;font:600 18px ui-monospace,Menlo,monospace;padding:10px 14px;border-radius:8px;background:color-mix(in srgb,var(--warn) 14%,transparent);color:var(--warn)}
`

export function adminPage(active: AdminTab, title: string, body: string, status = 200) {
	const tabs = TABS.map(([id, name]) => `<a href="/admin/${id}" class="${id === active ? 'on' : ''}">${name}</a>`).join('')
	return new Response(
		`<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${title} · Panel de Terminal P2P</title><style>${CSS}</style></head>
<body><main><div class="bar"><span class="brand">Panel de Terminal P2P</span><nav class="tabs">${tabs}</nav></div>${body}</main></body></html>`,
		{ status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' } },
	)
}

// Sin la clave, el navegador la pide (la misma para todo el panel)
export const askKey = () =>
	new Response('Necesitas la clave del panel', { status: 401, headers: { 'WWW-Authenticate': 'Basic realm="Terminal P2P metrics", charset="UTF-8"', 'Cache-Control': 'no-store' } })
