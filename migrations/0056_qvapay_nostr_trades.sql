-- Las operaciones del P2P que QvaPay publica firmadas en Nostr (kind 35353, z = trade; worker/qpnostr.ts), para
-- compararlas con el volumen que suma el feed (tabla volume). Una fila por operación, sin nadie: QvaPay no publica
-- quién compró ni quién vendió
CREATE TABLE qp_nostr_trades (
	id    TEXT    PRIMARY KEY, -- la «d» de la operación (QvaPay no la reemplaza nunca)
	coin  TEXT,                -- el mercado del terminal; NULL si no es uno de los nuestros (va con f y pm)
	f     TEXT    NOT NULL,    -- la moneda (CUP, USD, …)
	pm    TEXT    NOT NULL,    -- el método de pago tal cual lo publica QvaPay
	side  TEXT    NOT NULL,    -- buy o sell: el tipo de la oferta, como en volume
	at    INTEGER NOT NULL,    -- executed_at, epoch ms
	usd   REAL    NOT NULL,    -- amt (QUSD)
	fiat  REAL    NOT NULL,    -- fa (precio = fiat / usd)
	plat  INTEGER NOT NULL DEFAULT 0 -- 1 si es de la tesorería de QvaPay (maker = platform)
);
CREATE INDEX qp_nostr_trades_at ON qp_nostr_trades (at);
