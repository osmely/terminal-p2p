-- Primer mes de Pro gratis, una vez por persona: por usuario de QvaPay y por dispositivo (terminal) o
-- por cuenta de Telegram (simulador). Cada fila es una llave ya usada: qp:usuario, print:huella o tg:id
CREATE TABLE pro_trials (
	key        TEXT PRIMARY KEY,
	license    TEXT NOT NULL,
	created_at INTEGER NOT NULL
);
