-- Una foto del libro del P2P cada 10 minutos, por mercado y lado (worker/bookstats.ts), para el análisis de mercado.
-- Solo números del mercado: ninguna oferta ni usuario. Lo atípico (casi siempre un error de tipeo) no cuenta
CREATE TABLE book_stats (
	coin     TEXT    NOT NULL,
	t        INTEGER NOT NULL, -- epoch ms, redondeado a 10 minutos
	side     TEXT    NOT NULL, -- ask (venden USD) o bid (compran USD)
	offers   INTEGER NOT NULL, -- ofertas en el libro (sin las atípicas)
	outliers INTEGER NOT NULL, -- ofertas atípicas que no cuentan
	best     REAL,             -- el mejor precio que puede tomar cualquiera (sin las solo-VIP)
	usd      REAL    NOT NULL, -- USD en el libro
	usd1     REAL    NOT NULL, -- USD hasta un 1 % del mejor precio
	usd3     REAL    NOT NULL, -- USD hasta un 3 % del mejor precio
	top1     REAL,             -- parte de los USD del que más tiene (0–1)
	top3     REAL,             -- parte de los tres que más tienen
	age      INTEGER,          -- minutos desde el último cambio, mediana de las 10 mejores
	fill100  REAL,             -- precio medio de tomar 100 USD (NULL si no llega)
	fill500  REAL,             -- precio medio de tomar 500 USD
	stale    INTEGER NOT NULL, -- 1 si el feed de QvaPay estaba parado (el libro puede ir atrasado)
	PRIMARY KEY (coin, t, side)
) WITHOUT ROWID;
