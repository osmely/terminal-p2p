-- Velas de lo completado: cada operación del feed (las fijas al completarse, cada parte tomada de las de rango) en su
-- franja de 15 minutos, por mercado (worker/candles.ts). Solo precios y sumas: ninguna oferta ni usuario. Lo atípico
-- (casi siempre un error de tipeo) no cuenta
CREATE TABLE candles (
	coin     TEXT    NOT NULL,
	t        INTEGER NOT NULL, -- inicio de la franja, epoch ms
	o        REAL    NOT NULL, -- precio de la primera operación de la franja
	h        REAL    NOT NULL,
	l        REAL    NOT NULL,
	c        REAL    NOT NULL, -- precio de la última
	first_at INTEGER NOT NULL, -- cuándo fue la primera (para saber cuál abre si llegan desordenadas)
	last_at  INTEGER NOT NULL,
	ops      INTEGER NOT NULL,
	usd      REAL    NOT NULL,
	PRIMARY KEY (coin, t)
) WITHOUT ROWID;
