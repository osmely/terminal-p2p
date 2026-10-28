-- Operaciones del P2P por hora, mercado y lado, sumadas desde el feed de QvaPay (worker/livebook-do.ts): las fijas al
-- completarse y, en las de rango, cada parte tomada (y se resta la que vuelve). Solo sumas: ninguna oferta ni usuario
CREATE TABLE volume (
	coin TEXT    NOT NULL,
	hour INTEGER NOT NULL, -- inicio de la hora, epoch ms
	side TEXT    NOT NULL, -- buy o sell: el tipo de la oferta
	ops  INTEGER NOT NULL DEFAULT 0,
	usd  REAL    NOT NULL DEFAULT 0,
	PRIMARY KEY (coin, hour, side)
) WITHOUT ROWID;
