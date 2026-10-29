-- Traceo de cada cuenta: lo que el servidor hizo con ella o le dio (conexiones, estado de Pro, días gratis, facturas,
-- módulo Pro, radar, avisos, accesos cortados, simulador, errores). Para entender un reclamo o ver un abuso. Nunca el
-- token ni lo que el usuario hace en el P2P de QvaPay: eso solo lo guarda su navegador (ver user_diag)
CREATE TABLE user_log (
	id      INTEGER PRIMARY KEY AUTOINCREMENT,
	at      INTEGER NOT NULL,
	account TEXT,                  -- usuario de QvaPay en minúsculas (confirmado por QvaPay o por su licencia); NULL si no se sabe
	print   TEXT,                  -- huella del token (nunca el token); NULL si no la hay
	kind    TEXT NOT NULL,         -- login | status | device | trial | leave | checkout | refund | telegram | radar | rotate | module | denied | sim | diag | error
	ok      INTEGER NOT NULL,      -- 1 salió bien, 0 el servidor dijo que no o falló
	detail  TEXT,
	dk      TEXT UNIQUE            -- para no repetir lo mismo (la consulta de estado, una vez por hora)
);
CREATE INDEX user_log_account ON user_log (account, at);
CREATE INDEX user_log_print ON user_log (print, at);
CREATE INDEX user_log_at ON user_log (at);

-- Diagnósticos que manda el usuario desde «Mi cuenta» al reclamar: lo que su navegador apuntó (operaciones que pidió,
-- errores, avisos), sin token ni datos de pago. Solo llega si él lo envía
CREATE TABLE user_diag (
	id      INTEGER PRIMARY KEY AUTOINCREMENT,
	at      INTEGER NOT NULL,
	account TEXT,
	print   TEXT,
	note    TEXT,                  -- lo que cuenta que pasó
	body    TEXT NOT NULL,         -- JSON: [{t, kind, msg, data}]
	entries INTEGER NOT NULL
);
CREATE INDEX user_diag_account ON user_diag (account, at);
