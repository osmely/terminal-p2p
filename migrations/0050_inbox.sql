-- Buzón del terminal: mensajes del equipo (a una cuenta, a varias o a todos) y avisos del sistema (fin de días de Pro).
-- Solo el mensaje, a quién va y si lo leyó: nada de lo que hace cada uno en el P2P. Caducan (expires_at) y se borran
CREATE TABLE inbox (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	audience TEXT NOT NULL,          -- 'all' (todos) o 'list' (las cuentas de inbox_to)
	kind TEXT NOT NULL,              -- 'admin' o 'system'
	title TEXT NOT NULL,
	body TEXT NOT NULL,
	cta TEXT,                        -- 'pro' (abre Pro) o una dirección https
	cta_label TEXT,
	segment TEXT,                    -- de qué grupo salió la lista (para el panel)
	recipients INTEGER NOT NULL DEFAULT 0,
	pushed INTEGER NOT NULL DEFAULT 0,
	created_at INTEGER NOT NULL,
	expires_at INTEGER NOT NULL,
	actor TEXT
);
CREATE INDEX inbox_expires ON inbox (expires_at);
CREATE TABLE inbox_to (
	account TEXT NOT NULL,           -- usuario de QvaPay en minúsculas
	msg INTEGER NOT NULL,
	PRIMARY KEY (account, msg)
);
CREATE INDEX inbox_to_msg ON inbox_to (msg);
CREATE TABLE inbox_read (
	account TEXT NOT NULL,
	msg INTEGER NOT NULL,
	read_at INTEGER NOT NULL,
	PRIMARY KEY (account, msg)
);
CREATE INDEX inbox_read_msg ON inbox_read (msg);
