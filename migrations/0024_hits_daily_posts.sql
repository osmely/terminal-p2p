-- Contadores anónimos por día: visitas a la web, al terminal y al simulador, navegadores con la cuenta conectada,
-- y por qué enlace llegaron (?de=grupo, ?de=tasa…). Sin cookies, IP ni ningún identificador: solo sumas por día
CREATE TABLE hits (
	day  TEXT    NOT NULL, -- día de Cuba, YYYY-MM-DD
	site TEXT    NOT NULL, -- site (la web), app (el terminal) o sim (el simulador)
	kind TEXT    NOT NULL, -- visit (una por sesión del navegador), connect (cuenta conectada, una por navegador y día), first (primera vez que ese navegador conecta)
	ref  TEXT    NOT NULL, -- de dónde llegó ('' si no se sabe)
	n    INTEGER NOT NULL DEFAULT 0,
	PRIMARY KEY (day, site, kind, ref)
) WITHOUT ROWID;

-- La «Tasa QvaPay del día» publicada en el grupo: una por día de Cuba
CREATE TABLE daily_posts (
	day        TEXT    NOT NULL PRIMARY KEY,
	chat       TEXT    NOT NULL,
	message_id INTEGER,
	at         INTEGER NOT NULL
);
