-- Los mercados de QvaPay que el terminal no sigue (USDTBSC, PAYPAL…), contados desde el feed para saber cuáles tienen
-- movimiento antes de añadirlos (worker/othermarkets.ts). Solo cifras por mercado y día de Cuba: ni ofertas ni dueños
CREATE TABLE market_other (
	coin   TEXT NOT NULL,
	day    TEXT NOT NULL,              -- YYYY-MM-DD, hora de Cuba
	offers INTEGER NOT NULL DEFAULT 0, -- ofertas nuevas
	taken  INTEGER NOT NULL DEFAULT 0, -- tomadas (fijas enteras y partes de las de rango)
	done   INTEGER NOT NULL DEFAULT 0, -- operaciones contadas como volumen, como en los mercados del terminal
	usd    REAL NOT NULL DEFAULT 0,
	PRIMARY KEY (coin, day)
);

-- A qué mercados ya se avisó por pasar el umbral (un aviso por mercado)
CREATE TABLE market_other_alert (
	coin TEXT PRIMARY KEY,
	at   INTEGER NOT NULL
);
