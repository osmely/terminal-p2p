-- Las operaciones de QvaPay en Nostr ya no se guardan: sirvieron para comprobar que el volumen del feed cuadra con lo
-- que firma QvaPay (worker/qpnostr.ts). Nostr sigue diciendo quién es su tesorería, eso no usa esta tabla
DROP TABLE IF EXISTS qp_nostr_trades;
