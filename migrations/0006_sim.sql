-- Simulador de trading (sim.terminalp2p.com): dinero ficticio y precios reales de Binance.
-- Se entra con Telegram: solo se guarda lo que da su botón de inicio de sesión (id, nombre,
-- usuario y foto) y la cuenta ficticia de cada jugador. Nada de QvaPay.
CREATE TABLE sim_users (
	tg_id      INTEGER PRIMARY KEY,
	first_name TEXT    NOT NULL,
	username   TEXT,
	photo_url  TEXT,
	created_at INTEGER NOT NULL, -- epoch ms
	last_login INTEGER NOT NULL
);

CREATE TABLE sim_accounts (
	tg_id       INTEGER PRIMARY KEY,
	state       TEXT    NOT NULL, -- JSON: saldos, posiciones, órdenes y operaciones (motor de src/sim/engine.ts)
	equity      REAL    NOT NULL, -- patrimonio a precio de mercado en la última revisión
	pnl_pct     REAL    NOT NULL, -- rentabilidad desde que se creó o reinició la cuenta
	trades      INTEGER NOT NULL, -- operaciones ejecutadas (el ranking solo cuenta a quien ha operado)
	open_orders INTEGER NOT NULL, -- órdenes abiertas: el cron solo revisa estas cuentas
	checked_at  INTEGER NOT NULL, -- hasta dónde se revisaron sus órdenes con las velas de 1 s
	updated_at  INTEGER NOT NULL,
	version     INTEGER NOT NULL  -- control de concurrencia: cada escritura sube la versión
);
CREATE INDEX sim_accounts_open ON sim_accounts (open_orders) WHERE open_orders > 0;
CREATE INDEX sim_accounts_rank ON sim_accounts (pnl_pct) WHERE trades > 0;
