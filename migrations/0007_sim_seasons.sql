-- Temporadas semanales del simulador: cada lunes a las 00:00 (hora de Cuba) todos empiezan con 10.000 USDT.
-- season = lunes de la temporada (YYYY-MM-DD). benched = reinició a mitad de semana: no compite hasta el lunes
ALTER TABLE sim_accounts ADD COLUMN season TEXT NOT NULL DEFAULT '';
ALTER TABLE sim_accounts ADD COLUMN benched INTEGER NOT NULL DEFAULT 0;

-- Clasificación final de cada temporada (quien hizo al menos 3 operaciones), para el salón de la fama
CREATE TABLE sim_results (
	season  TEXT    NOT NULL,
	rank    INTEGER NOT NULL,
	tg_id   INTEGER NOT NULL,
	name    TEXT    NOT NULL, -- @usuario o nombre de Telegram al cerrar la temporada
	pnl_pct REAL    NOT NULL,
	equity  REAL    NOT NULL,
	trades  INTEGER NOT NULL,
	PRIMARY KEY (season, rank)
) WITHOUT ROWID;
CREATE INDEX sim_results_winners ON sim_results (tg_id) WHERE rank <= 3;

-- Temporada en curso y borrador del resumen semanal para Telegram
CREATE TABLE sim_meta (
	key   TEXT PRIMARY KEY,
	value TEXT NOT NULL
) WITHOUT ROWID;
