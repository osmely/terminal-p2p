-- Plan Pro. Quién pagó lo dice QvaPay con el propio pago (PaidBy): uuid y usuario verificados. De cada
-- dispositivo solo se guarda una huella del token (HMAC calculado en el navegador), nunca el token

CREATE TABLE pro_licenses (
	uuid        TEXT PRIMARY KEY,           -- identificador de QvaPay de quien pagó (o «gift:usuario» si es un regalo)
	username    TEXT NOT NULL,
	plan        TEXT NOT NULL,              -- month | year | gift
	expires_at  INTEGER NOT NULL,           -- epoch ms
	backup_hash TEXT,                       -- SHA-256 del código de respaldo; el código no se guarda
	revoked     INTEGER NOT NULL DEFAULT 0,
	created_at  INTEGER NOT NULL,
	updated_at  INTEGER NOT NULL
);

-- Dispositivos de cada licencia: como mucho PRO_DEVICES; el que entra de más expulsa al más antiguo
CREATE TABLE pro_prints (
	print    TEXT PRIMARY KEY,              -- huella del token (64 caracteres hex)
	license  TEXT NOT NULL,
	added_at INTEGER NOT NULL,
	seen_at  INTEGER NOT NULL
);
CREATE INDEX pro_prints_license ON pro_prints (license);

-- Cada factura: con qué huella se pidió y qué plan. backup_code guarda el código nuevo solo hasta
-- que el navegador que compró lo recoge una vez
CREATE TABLE pro_checkouts (
	id          TEXT PRIMARY KEY,           -- remote_id de la factura en QvaPay
	print       TEXT NOT NULL,
	plan        TEXT NOT NULL,
	amount      REAL NOT NULL,
	invoice     TEXT,                       -- transaction_uuid de QvaPay
	status      TEXT NOT NULL,              -- pending | paid
	license     TEXT,
	backup_code TEXT,
	created_at  INTEGER NOT NULL
);
CREATE INDEX pro_checkouts_invoice ON pro_checkouts (invoice);

-- Códigos de 6 cifras para añadir un dispositivo desde otro que ya es Pro: un solo uso, 5 minutos
CREATE TABLE pro_pairings (
	code       TEXT PRIMARY KEY,
	license    TEXT NOT NULL,
	expires_at INTEGER NOT NULL
);
