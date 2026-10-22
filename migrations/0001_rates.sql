-- Histórico público de la tasa del P2P de QvaPay.
-- Solo agregados que QvaPay publica sin cuenta (/p2p/averages): ningún dato de usuarios.
CREATE TABLE rates (
	coin        TEXT    NOT NULL,
	t           INTEGER NOT NULL, -- epoch ms, redondeado a 10 minutos
	average     REAL,             -- tasa media de las operaciones completadas
	avg_buy     REAL,
	avg_sell    REAL,
	median      REAL,
	median_buy  REAL,
	median_sell REAL,
	count       INTEGER,          -- operaciones completadas en la ventana
	window_h    INTEGER,          -- ventana usada por QvaPay: 24, 72 o 168 h
	PRIMARY KEY (coin, t)
) WITHOUT ROWID;
