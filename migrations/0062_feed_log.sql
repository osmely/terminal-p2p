-- Todo lo que manda el feed del P2P de QvaPay, tal cual (solo datos públicos del libro), 30 días. Una sola tabla: de
-- aquí se saca cualquier estudio (cuánto dura una oferta hasta que la toman, qué hace cada anunciante, a qué horas se
-- mueve cada mercado). Reemplaza a take_speed, que se calcula con esto
DROP TABLE IF EXISTS take_speed;
CREATE TABLE feed_log (
	t        INTEGER NOT NULL, -- hora del cambio según QvaPay (updated_at; si no viene, sent_at o la de llegada), epoch ms
	rx       INTEGER NOT NULL, -- cuándo nos llegó (epoch ms)
	sent     INTEGER,          -- cuándo lo mandó QvaPay (sent_at), epoch ms
	event    TEXT    NOT NULL, -- sin el «p2p.»: created, applied, cancelled, paused, resumed, range_updated…
	offer    TEXT    NOT NULL, -- uuid de la oferta
	coin     TEXT    NOT NULL,
	type     TEXT    NOT NULL, -- buy o sell, como lo dice QvaPay
	kind     TEXT    NOT NULL, -- fixed o flexible
	status   TEXT    NOT NULL,
	change   TEXT,             -- en las de rango: taken, returned, paused, resumed…
	amount   REAL    NOT NULL, -- QUSD de la oferta
	receive  REAL    NOT NULL, -- lo que se paga o cobra por ese monto (el precio es receive / amount)
	avail    REAL,             -- de rango: lo que queda disponible
	omin     REAL,
	omax     REAL,
	owner    TEXT,             -- uuid del anunciante
	username TEXT,             -- su usuario, si ya lo conocíamos
	vip      INTEGER,          -- el anunciante es VIP
	only_vip INTEGER,
	req      TEXT,             -- requisitos (JSON), si tiene
	pause    TEXT,             -- motivo de la pausa vigente (owner, taker_left…)
	UNIQUE (offer, event, t)   -- el mismo aviso llega por el webhook y por el stream: se guarda una vez
);
CREATE INDEX feed_log_t ON feed_log (t);
