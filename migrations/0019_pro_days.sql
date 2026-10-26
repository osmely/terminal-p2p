-- Una sola cuenta Pro por usuario de QvaPay (pro_licenses con uuid «qp:usuario»). Cada cambio de sus días es un
-- movimiento: días gratis, compras, regalos, devoluciones y ajustes, con el saldo de antes y el de después.
-- expires_at sigue siendo hasta cuándo tiene Pro
CREATE TABLE pro_days (
	id             INTEGER PRIMARY KEY AUTOINCREMENT,
	license        TEXT NOT NULL,            -- qp:usuario
	kind           TEXT NOT NULL,            -- trial | purchase | gift | refund | adjust | import
	days           INTEGER NOT NULL,         -- los que suma (+) o resta (−)
	expires_before INTEGER,                  -- epoch ms (NULL si la cuenta no existía)
	expires_after  INTEGER NOT NULL,
	checkout       TEXT,                     -- la compra, o la compra que se devolvió
	note           TEXT,                     -- el motivo
	actor          TEXT NOT NULL,            -- system | admin
	created_at     INTEGER NOT NULL
);
CREATE INDEX pro_days_license ON pro_days (license, created_at);

-- Las licencias sueltas de días gratis (trial:qp:usuario) y de regalo (gift:usuario) se juntan en la cuenta del
-- usuario, sumando los días que les quedaban. Las viejas no se borran: quedan apuntando a la cuenta
ALTER TABLE pro_licenses ADD COLUMN merged_into TEXT;

INSERT OR IGNORE INTO pro_licenses (uuid, username, plan, expires_at, revoked, created_at, updated_at)
	SELECT 'qp:' || LOWER(username), username, plan, 0, 0, MIN(created_at), MAX(updated_at)
	FROM pro_licenses WHERE uuid LIKE 'trial:qp:%' OR uuid LIKE 'gift:%'
	GROUP BY LOWER(username);

UPDATE pro_licenses SET expires_at = (
	SELECT CASE WHEN SUM(MAX(0, s.expires_at - n.now)) > 0 THEN n.now + SUM(MAX(0, s.expires_at - n.now)) ELSE MAX(s.expires_at) END
	FROM pro_licenses s, (SELECT CAST(strftime('%s', 'now') AS INTEGER) * 1000 AS now) n
	WHERE s.uuid IN (pro_licenses.uuid, 'trial:' || pro_licenses.uuid, 'gift:' || substr(pro_licenses.uuid, 4))
		AND (s.revoked = 0 OR s.uuid = pro_licenses.uuid)
)
WHERE uuid LIKE 'qp:%' AND EXISTS (SELECT 1 FROM pro_licenses s WHERE s.uuid IN ('trial:' || pro_licenses.uuid, 'gift:' || substr(pro_licenses.uuid, 4)));

-- El punto de partida de cada cuenta en el libro
INSERT INTO pro_days (license, kind, days, expires_before, expires_after, note, actor, created_at)
	SELECT uuid, 'import', MAX(0, CAST(ROUND((expires_at - n.now) / 86400000.0) AS INTEGER)), NULL, expires_at, 'Días que tenía al empezar el libro de movimientos', 'system', n.now
	FROM pro_licenses, (SELECT CAST(strftime('%s', 'now') AS INTEGER) * 1000 AS now) n
	WHERE uuid LIKE 'qp:%';

UPDATE pro_prints SET license = 'qp:' || substr(license, 10) WHERE license LIKE 'trial:qp:%';
UPDATE pro_prints SET license = 'qp:' || substr(license, 6) WHERE license LIKE 'gift:%';
UPDATE pro_checkouts SET license = 'qp:' || substr(license, 10) WHERE license LIKE 'trial:qp:%';
UPDATE pro_checkouts SET license = 'qp:' || substr(license, 6) WHERE license LIKE 'gift:%';
UPDATE pro_trials SET license = 'qp:' || substr(license, 10) WHERE license LIKE 'trial:qp:%';
UPDATE pro_licenses SET merged_into = 'qp:' || LOWER(username), revoked = 1 WHERE uuid LIKE 'trial:qp:%' OR uuid LIKE 'gift:%';
