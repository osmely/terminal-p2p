-- Avisos urgentes del radar por SMS (OTP Cuba) a quien pone su teléfono en «Mi cuenta» → Avisos. Una fila por cuenta:
-- el número verificado, el que está verificando (con el hash del código que le mandó OTP Cuba) y cuántos SMS van hoy
CREATE TABLE pro_sms (
	license     TEXT PRIMARY KEY,        -- qp:usuario
	phone       TEXT,                    -- verificado: +53XXXXXXXX (NULL mientras no verifica ninguno)
	verified_at INTEGER,
	pending     TEXT,                    -- el número al que se le mandó el código y aún no se verificó
	hash        TEXT,                    -- el del código pendiente (lo da OTP Cuba al mandarlo)
	sent_at     INTEGER,                 -- cuándo se mandó el último código
	day         TEXT,                    -- el día (hora de Cuba) de «sent»
	sent        INTEGER NOT NULL DEFAULT 0 -- SMS de ese día (códigos y avisos): con tope, cada uno cuesta
);
