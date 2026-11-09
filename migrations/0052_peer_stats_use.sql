-- Cuántas fichas con la actividad en QvaPay pidió cada licencia de Pro por día (hora de Cuba), para el tope diario.
-- Solo cuentan las que se piden a QvaPay (no las que ya estaban en la caché). Se borran a los 7 días
CREATE TABLE peer_stats_use (
	license TEXT NOT NULL,
	day TEXT NOT NULL,
	n INTEGER NOT NULL DEFAULT 0,
	PRIMARY KEY (license, day)
);
