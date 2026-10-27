-- Radar de Pro: los avisos por Telegram que ya se mandaron, uno por oferta y cuenta (aunque el radar corra en
-- varias pestañas o dispositivos), y para el tope por hora. Se borran al día siguiente
CREATE TABLE pro_radar_sent (
	license TEXT NOT NULL,
	offer TEXT NOT NULL,
	kind TEXT NOT NULL,
	at INTEGER NOT NULL,
	PRIMARY KEY (license, offer, kind)
) WITHOUT ROWID;
CREATE INDEX pro_radar_sent_at ON pro_radar_sent (license, at);
