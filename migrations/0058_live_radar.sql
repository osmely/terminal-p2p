-- Los tramos de 10 min en que cada cuenta tuvo el radar encendido (para pintarlos en la barra de «En vivo»). Lo dice el
-- terminal por el libro en vivo; se borra a los 90 días, como live_seen
CREATE TABLE live_radar (
	account TEXT NOT NULL,    -- usuario de QvaPay en minúsculas
	slot    INTEGER NOT NULL, -- inicio de la franja de 10 min (epoch ms)
	PRIMARY KEY (account, slot)
) WITHOUT ROWID;
CREATE INDEX live_radar_slot ON live_radar (slot);
