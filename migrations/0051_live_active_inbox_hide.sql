-- Del tiempo con el terminal abierto, cuánto con la pestaña a la vista (o con el radar encendido): una pestaña en segundo
-- plano no pide mercados. NULL en los días de antes de contarlo (ahí solo se sabe el total)
ALTER TABLE live_seen ADD COLUMN active INTEGER;
-- Mensajes del buzón que el usuario borró de su buzón (para él; el mensaje sigue para los demás)
ALTER TABLE inbox_read ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0;
