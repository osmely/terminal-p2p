# Terminal P2P

**El mercado P2P de QvaPay como un exchange, en vivo.** → [app.terminalp2p.com](https://app.terminalp2p.com) · presentación en [terminalp2p.com](https://terminalp2p.com)

Libro de órdenes por moneda (CUP Transferencia, Saldo ETECSA, Tarjeta Clásica, MLC, Zelle, Bandec Prepago, TropiPay, CUP Efectivo, Bolsa TM), diferencial, profundidad, distribución de las operaciones completadas en 48 h, histórico de la tasa (con la referencia del mercado informal de [elTOQUE](https://eltoque.com) desde 2020), lectura automática del mercado y actividad del libro. Además, cada usuario puede conectar su cuenta y operar desde aquí: publicar y tomar ofertas y seguir cada operación paso a paso.

> **Sin custodia.** El dinero de cada operación queda siempre en el escrow de QvaPay, y tu token y tus datos se quedan en tu navegador.

## Privacidad

- **Todo lo que depende de tu cuenta corre en tu navegador.** Tu token de QvaPay, la lectura del libro y "Mis operaciones" viven ahí; el servidor no guarda tokens ni datos de usuarios.
- **Nadie usa datos de otro.** El libro se lee con el token de quien mira. Sin cuenta conectada se ven los datos públicos del mercado: promedios, operaciones completadas e histórico.
- **El token** se guarda solo en tu navegador: se borra al cerrar la pestaña, salvo que elijas recordarlo. "Desconectar" lo borra.
- **Sin custodia:** el dinero de cada operación queda en el escrow de QvaPay.
- Sin cookies ni rastreadores, y una política de seguridad estricta que solo admite scripts del propio dominio.

## Mis operaciones

Conecta tu cuenta con un token de [qvapay.com/dev/tokens](https://www.qvapay.com/dev/tokens) (`read` + `p2p:buy` y/o `p2p:sell`; **nunca** `transfer` ni `withdraw`). Desde el terminal publicas ofertas (fijas o por partes, con requisitos), las editas, pausas o cancelas, y tomas ofertas del libro. "Mis operaciones" muestra tus operaciones en curso, tus ofertas publicadas y las completadas, y guía cada paso: datos de pago de la contraparte, "ya pagué" con referencia, **liberar en dos pasos y solo si QvaPay confirma que está en "pagado"**, cancelar o disputar, chat y calificación. Puede avisarte cuando te pagan, te escriben o se acaba el plazo de pago.

## Desarrollo

```bash
npm install
```

El terminal en local (<http://app.localhost:5177>):

```bash
npm run dev
```

La landing en local (<http://localhost:5179>):

```bash
npm run dev:site
```

Tests y tipos:

```bash
npm test
```

```bash
npm run typecheck
```

Para desplegar tu propia copia, parte de `wrangler.example.jsonc`. La referencia del mercado informal es opcional: pide una clave en [tasas-token.eltoque.com](https://tasas-token.eltoque.com) y guárdala como secreto del Worker con `npx wrangler secret put ELTOQUE_TOKEN` (en local, en `.env`). Sin clave, el resto funciona igual.

## Estructura

```
web/           lógica que corre en el navegador
worker/        servidor: sirve la web y los datos públicos del mercado
public/app/    el terminal (HTML, CSS, JS sin framework)
public/site/   la landing
src/           libro de órdenes, "Mis operaciones" y cliente de la API de QvaPay
test/          pruebas
```

## Fuentes de datos

- **QvaPay:** el libro (con el token de quien mira) y los promedios públicos del P2P, guardados cada 10 minutos.
- **[elTOQUE](https://eltoque.com/tasas-de-cambio-de-moneda-en-cuba-hoy):** la tasa representativa del mercado informal (USD, EUR, MLC y USDT en CUP), una mediana por día, tal como la publica elTOQUE. Son tasas de referencia.

## Licencia

Copyright 2026 [osmely](https://github.com/osmely). Publicado bajo la licencia [Apache 2.0](LICENSE).

Puedes usar, modificar y distribuir este código, también con fines comerciales, **siempre que acredites la autoría**: conserva el aviso de copyright y el archivo [NOTICE](NOTICE), inclúyelos de forma visible en la documentación o en los créditos de tu producto, y deja claro qué cambiaste.
