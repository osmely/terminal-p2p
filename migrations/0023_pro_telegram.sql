-- Avisos de Pro por Telegram a cada usuario que los pide desde «Mi cuenta»: de él solo se guarda el chat
CREATE TABLE pro_telegram (
	license   TEXT PRIMARY KEY,            -- qp:usuario
	chat_id   INTEGER NOT NULL,
	linked_at INTEGER NOT NULL
);
CREATE INDEX pro_telegram_chat ON pro_telegram (chat_id);

-- Enlaces de un solo uso para conectar el chat (t.me/bot?start=código). Caducan en una hora
CREATE TABLE pro_tg_links (
	code       TEXT PRIMARY KEY,
	license    TEXT NOT NULL,
	created_at INTEGER NOT NULL
);

-- Recordatorios de vencimiento ya enviados, uno por vencimiento: exp3:<expires_at> (quedan 3 días) y exp0:<expires_at> (terminó)
CREATE TABLE pro_tg_sent (
	license TEXT NOT NULL,
	key     TEXT NOT NULL,
	at      INTEGER NOT NULL,
	PRIMARY KEY (license, key)
);
