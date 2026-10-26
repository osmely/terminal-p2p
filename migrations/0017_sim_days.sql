-- Uso del simulador por día (hora de Cuba): qué jugadores entraron y cuántas órdenes pusieron. Solo el número
-- de jugador del simulador, nada de QvaPay ni de Telegram. Para las estadísticas del panel
CREATE TABLE sim_days (
	day    TEXT    NOT NULL, -- AAAA-MM-DD
	player INTEGER NOT NULL,
	orders INTEGER NOT NULL DEFAULT 0,
	PRIMARY KEY (day, player)
) WITHOUT ROWID;
