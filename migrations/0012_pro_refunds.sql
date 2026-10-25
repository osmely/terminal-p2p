-- Devoluciones: la API de QvaPay no devuelve pagos, así que se devuelven a mano desde el panel (se revoca
-- la licencia y se apunta aquí) y el dinero se transfiere desde QvaPay a quien pagó
ALTER TABLE pro_checkouts ADD COLUMN refunded_at INTEGER;
