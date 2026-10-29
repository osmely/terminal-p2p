-- Incidencias de Pro: alguien usa (o intenta usar) Pro sin tenerlo. Una fila abierta por tipo, usuario y licencia
-- (key), que cuenta las veces y cuándo fue la primera y la última; al descartarla se cierra y otra vez abre una nueva
CREATE TABLE pro_incidents (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	key TEXT NOT NULL,
	kind TEXT NOT NULL,
	username TEXT, -- la cuenta que lo hizo (en minúsculas), si se sabe
	license TEXT, -- la licencia implicada (qp:usuario), si la hay
	detail TEXT,
	count INTEGER NOT NULL DEFAULT 1,
	first_at INTEGER NOT NULL,
	last_at INTEGER NOT NULL,
	resolved_at INTEGER
);
CREATE UNIQUE INDEX pro_incidents_open ON pro_incidents (key) WHERE resolved_at IS NULL;
CREATE INDEX pro_incidents_last ON pro_incidents (last_at);
