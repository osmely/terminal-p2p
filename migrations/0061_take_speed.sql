-- Cuánto dura una oferta en el libro hasta que alguien la toma entera (para saber qué tan rápido son los que cazan
-- ofertas, del terminal o de fuera). Solo datos públicos del libro: la oferta como huella, su dueño y lo que pedía.
-- Se borra a los 30 días
CREATE TABLE take_speed (
	t      INTEGER NOT NULL, -- cuándo la tomaron, según QvaPay (epoch ms)
	coin   TEXT    NOT NULL,
	side   TEXT    NOT NULL, -- ask (venta) o bid (compra)
	usd    REAL    NOT NULL,
	price  REAL    NOT NULL,
	owner  TEXT    NOT NULL, -- usuario del anunciante ('' si no se sabe)
	ms     INTEGER NOT NULL, -- de que se pudo tomar a que la tomaron, con las horas de QvaPay
	rx_ms  INTEGER           -- lo mismo con las horas en que nos llegaron los dos avisos
);
CREATE INDEX take_speed_t ON take_speed (t);
