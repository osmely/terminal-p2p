-- El simulador deja de tener login propio: la sesión viene del terminal (cookie del dominio con la huella del
-- token). La cuenta de cada jugador va con el dueño de la licencia Pro del dispositivo (la misma en todos sus
-- dispositivos) o, sin licencia, con la huella. Telegram ya no sirve para entrar: solo para salir en el ranking.
-- Las cuentas que había (con Telegram) no tienen cómo pasarse a la identidad nueva: se empieza de cero
DROP TABLE IF EXISTS sim_results;
DROP TABLE IF EXISTS sim_accounts;
DROP TABLE IF EXISTS sim_users;

CREATE TABLE sim_players (
	id         INTEGER PRIMARY KEY,
	tg_id      INTEGER UNIQUE,              -- Telegram vinculado para competir (null: juega en privado)
	first_name TEXT,
	username   TEXT,
	photo_url  TEXT,
	compete    INTEGER NOT NULL DEFAULT 0,  -- sale en el ranking (exige Telegram)
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
	open_orders INTEGER NOT NULL,
	checked_at  INTEGER NOT NULL,
	updated_at  INTEGER NOT NULL,
	version     INTEGER NOT NULL,
	season      TEXT    NOT NULL DEFAULT '',
	benched     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX sim_accounts_open ON sim_accounts (open_orders) WHERE open_orders > 0;
CREATE INDEX sim_accounts_rank ON sim_accounts (pnl_pct) WHERE trades > 0;

CREATE TABLE sim_results (
	season  TEXT    NOT NULL,
	rank    INTEGER NOT NULL,
	player  INTEGER NOT NULL,
	name    TEXT    NOT NULL, -- @usuario o nombre de Telegram al cerrar la temporada
	pnl_pct REAL    NOT NULL,
	equity  REAL    NOT NULL,
	trades  INTEGER NOT NULL,
	PRIMARY KEY (season, rank)
) WITHOUT ROWID;
CREATE INDEX sim_results_winners ON sim_results (player) WHERE rank <= 3;

-- La temporada vuelve a empezar con las cuentas nuevas; el borrador del resumen anterior ya no vale
DELETE FROM sim_meta;
