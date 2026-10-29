-- Historial de «En vivo»: cada minuto el cron mira quién tiene el terminal abierto (las conexiones del libro en vivo) y
-- lo suma a su día (hora de Cuba). Solo presencia: cuántos y quiénes, desde y hasta cuándo, con Pro o no; nunca qué
-- mercados miran. Se borra a los 90 días

-- El máximo de cada franja de 10 minutos (la gráfica del día)
CREATE TABLE live_slots (
	slot     INTEGER PRIMARY KEY,   -- inicio de la franja (epoch ms, múltiplo de 10 min)
	accounts INTEGER NOT NULL,      -- cuentas distintas conectadas a la vez (el máximo en la franja)
	tabs     INTEGER NOT NULL,      -- pestañas con el libro en vivo
	pro      INTEGER NOT NULL       -- cuentas con Pro
);

-- Cada cuenta en cada día: la primera y la última vez que se la vio conectada y cuántos minutos
CREATE TABLE live_seen (
	day      TEXT NOT NULL,         -- AAAA-MM-DD en Cuba
	account  TEXT NOT NULL,         -- usuario de QvaPay en minúsculas
	name     TEXT NOT NULL,         -- como lo escribe QvaPay
	first_at INTEGER NOT NULL,
	last_at  INTEGER NOT NULL,
	minutes  INTEGER NOT NULL,
	pro      INTEGER NOT NULL,      -- 1 si en algún momento del día estuvo con Pro
	PRIMARY KEY (day, account)
);
