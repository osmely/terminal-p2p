-- Tope de días gratis nuevos por IP y día (muchos usuarios en Cuba comparten IP, por eso el tope es amplio).
-- La IP no se guarda: solo una huella cifrada con la clave de Pro, y solo dos días
CREATE TABLE pro_trial_ips (
	day TEXT    NOT NULL, -- AAAA-MM-DD (UTC)
	ip  TEXT    NOT NULL, -- HMAC de la IP
	n   INTEGER NOT NULL,
	PRIMARY KEY (day, ip)
) WITHOUT ROWID;
