-- Facturas pendientes de la última hora: el cron las revisa cada minuto y la consulta de estado de
-- cada dispositivo busca las suyas. paid_at: si pagas una factura anterior mientras esperas otra, la
-- pantalla de espera también se entera
ALTER TABLE pro_checkouts ADD COLUMN paid_at INTEGER;
CREATE INDEX pro_checkouts_pending ON pro_checkouts (status, created_at);
