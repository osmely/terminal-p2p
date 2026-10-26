-- Interruptores del panel. pro = '1' enciende Pro en la web, el terminal y el simulador; sin fila, apagado
CREATE TABLE app_flags (
	key        TEXT PRIMARY KEY,
	value      TEXT NOT NULL,
	updated_at INTEGER NOT NULL
) WITHOUT ROWID;
