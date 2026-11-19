-- El primer día en que se vio cada cuenta en el terminal (live_seen se borra a los 90 días; esto no): para contar
-- cuentas nuevas y cuántas vuelven en el panel de métricas (worker/growth.ts). Lo completa la limpieza diaria
CREATE TABLE account_first (
	account TEXT NOT NULL PRIMARY KEY, -- usuario de QvaPay en minúsculas
	day     TEXT NOT NULL              -- AAAA-MM-DD en Cuba
) WITHOUT ROWID;
INSERT OR IGNORE INTO account_first (account, day) SELECT account, MIN(day) FROM live_seen GROUP BY account;
