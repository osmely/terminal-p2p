-- El simulador deja de tener login propio: la sesión viene del terminal (cookie del dominio con la huella del
-- token). La cuenta de cada jugador va con el dueño de la licencia Pro del dispositivo (la misma en todos sus
-- dispositivos) o, sin licencia, con la huella. Sin ranking ni temporadas por ahora (ni Telegram).
-- Las cuentas que había (con Telegram) no tienen cómo pasarse a la identidad nueva: se empieza de cero
DROP TABLE IF EXISTS sim_results;
DROP TABLE IF EXISTS sim_accounts;
DROP TABLE IF EXISTS sim_users;
DROP TABLE IF EXISTS sim_meta;

CREATE TABLE sim_players (
	id         INTEGER PRIMARY KEY,
	created_at INTEGER NOT NULL,
	last_seen  INTEGER NOT NULL
);

-- Cómo se llega a cada jugador: user:<dueño de la licencia> o print:<huella del token>
CREATE TABLE sim_ids (
	key    TEXT PRIMARY KEY,
	player INTEGER NOT NULL
) WITHOUT ROWID;
CREATE INDEX sim_ids_player ON sim_ids (player);

CREATE TABLE sim_accounts (
	player      INTEGER PRIMARY KEY,
	state       TEXT    NOT NULL, -- JSON: saldos, posiciones, órdenes y operaciones (motor de src/sim/engine.ts)
	equity      REAL    NOT NULL,
	pnl_pct     REAL    NOT NULL,
	trades      INTEGER NOT NULL,
	open_orders INTEGER NOT NULL, -- órdenes abiertas: el cron solo revisa estas cuentas
	checked_at  INTEGER NOT NULL,
	updated_at  INTEGER NOT NULL,
	version     INTEGER NOT NULL  -- control de concurrencia: cada escritura sube la versión
);
CREATE INDEX sim_accounts_open ON sim_accounts (open_orders) WHERE open_orders > 0;
