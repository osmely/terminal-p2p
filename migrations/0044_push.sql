-- Avisos push (worker/push.ts): los navegadores que los activaron, para avisar de tus operaciones con el terminal
-- cerrado. Solo la suscripción que da el navegador (el servicio de push de Google, Mozilla o Apple y sus claves) y de
-- qué cuenta de QvaPay es, confirmada por QvaPay en ese navegador. Se borra al desactivarlos o cuando el navegador
-- dice que ya no existe
CREATE TABLE push_subs (
	endpoint   TEXT PRIMARY KEY,
	p256dh     TEXT NOT NULL,
	auth       TEXT NOT NULL,
	owner      TEXT NOT NULL,      -- uuid de QvaPay en minúsculas (el feed dice el dueño de cada oferta por su uuid)
	username   TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	sent_at    INTEGER,            -- el último aviso entregado
	fails      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX push_subs_owner ON push_subs (owner);

-- Las ofertas fijas que tomaste desde el terminal, para avisarte de lo que haga su dueño (te pagó, te liberó). Solo
-- hasta que la operación termina o como mucho 3 días
CREATE TABLE push_watch (
	offer      TEXT NOT NULL,
	endpoint   TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	PRIMARY KEY (offer, endpoint)
);
CREATE INDEX push_watch_endpoint ON push_watch (endpoint);
