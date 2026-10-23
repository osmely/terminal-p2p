-- Métricas anónimas de las acciones del P2P hechas desde Terminal P2P.
-- Sin usuario, token ni IP: la oferta y la orden van cifradas (SHA-256), solo para
-- poder unir "publicada" con "completada". Nadie puede saber de qué oferta se trata.
CREATE TABLE events (
	t      INTEGER NOT NULL, -- epoch ms
	event  TEXT    NOT NULL, -- create, take, paid, release, cancel, rate, completed
	status TEXT    NOT NULL, -- ok o error
	offer  TEXT    NOT NULL, -- huella de la oferta ('' si no hay)
	ord    TEXT    NOT NULL, -- huella de la orden en ofertas por partes ('' si no hay)
	coin   TEXT    NOT NULL, -- mercado ('' si no se sabe)
	side   TEXT    NOT NULL, -- buy o sell, el tipo de la oferta ('' si no se sabe)
	usd    REAL    NOT NULL, -- monto en USD (0 si no se sabe)
	source TEXT    NOT NULL  -- relay (lo vio el servidor) o client (lo avisó el navegador)
);
CREATE INDEX events_t ON events (t);
CREATE INDEX events_offer ON events (offer);
