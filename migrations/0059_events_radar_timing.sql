-- Tomas del radar, de dónde sale el tiempo (ms; NULL si no se pudo medir). Ver worker/metrics.ts
--   feed_ms: de que QvaPay publicó o cambió la oferta a que nuestro servidor la mandó al terminal
--   net_ms:  el viaje por internet: del servidor al teléfono y del teléfono al relé (sin lo que pensó el teléfono, que es ms)
--   qp_ms:   lo que tardó QvaPay en contestar la toma
ALTER TABLE events ADD COLUMN feed_ms INTEGER;
ALTER TABLE events ADD COLUMN net_ms INTEGER;
ALTER TABLE events ADD COLUMN qp_ms INTEGER;
