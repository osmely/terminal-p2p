-- Desde qué parte del terminal se hizo cada acción: 'swap' para «Vender ya», '' para el resto
ALTER TABLE events ADD COLUMN via TEXT NOT NULL DEFAULT '';
