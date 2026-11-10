-- Un navegador tiene una sola suscripción de push, pero puede tener varias cuentas de QvaPay conectadas: cada cuenta
-- con avisos en ese navegador va en su fila (antes la última que cargó le quitaba los avisos a las demás)
CREATE TABLE push_subs_new (
	endpoint   TEXT    NOT NULL,
	p256dh     TEXT    NOT NULL,
	auth       TEXT    NOT NULL,
	owner      TEXT    NOT NULL,   -- uuid de QvaPay en minúsculas
	username   TEXT    NOT NULL,
	created_at INTEGER NOT NULL,
	sent_at    INTEGER,
	fails      INTEGER NOT NULL DEFAULT 0,
	PRIMARY KEY (endpoint, owner)
);
INSERT INTO push_subs_new SELECT endpoint, p256dh, auth, owner, username, created_at, sent_at, fails FROM push_subs;
DROP TABLE push_subs;
ALTER TABLE push_subs_new RENAME TO push_subs;
CREATE INDEX push_subs_owner ON push_subs (owner);
