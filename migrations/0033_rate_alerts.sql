-- Avisos de tasa por Telegram (Pro): «avísame cuando la Tasa QvaPay de un mercado suba de / baje de X». Se miran cada
-- 10 minutos con la tasa que publica QvaPay (la mediana de lo completado, la misma del mensaje diario). Solo llegan a
-- quien tiene Pro y conectó el bot
CREATE TABLE pro_rate_alerts (
	id         INTEGER PRIMARY KEY AUTOINCREMENT,
	license    TEXT NOT NULL,
	coin       TEXT NOT NULL,
	dir        TEXT NOT NULL,              -- up: cuando suba de price · down: cuando baje de price
	price      REAL NOT NULL,
	armed      INTEGER NOT NULL DEFAULT 1, -- 0: ya avisó; se vuelve a armar cuando la tasa regresa al otro lado (con margen)
	created_at INTEGER NOT NULL,
	fired_at   INTEGER,
	fired_rate REAL
);
CREATE INDEX pro_rate_alerts_license ON pro_rate_alerts (license);
CREATE INDEX pro_rate_alerts_coin ON pro_rate_alerts (coin, armed);
