-- Avisos de tus ofertas por Telegram (Pro), aunque cierres el terminal: el feed del mercado dice el uuid del dueño de
-- cada oferta y el libro en vivo avisa a quien lo activó cuando le toman una, se la marcan pagada, le liberan o vuelve
-- al libro. Solo se guarda quién lo activó (su uuid de QvaPay, de la cookie firmada al conectar): nada de sus ofertas
CREATE TABLE pro_offer_alerts (
	owner      TEXT PRIMARY KEY,           -- uuid de QvaPay del dueño de las ofertas (como lo manda el feed)
	license    TEXT NOT NULL UNIQUE,       -- qp:usuario
	created_at INTEGER NOT NULL
);
