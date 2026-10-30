-- Tomas del radar de Pro: ms desde que el terminal vio la oferta hasta que pidió tomarla (null en el resto)
ALTER TABLE events ADD COLUMN ms INTEGER;
