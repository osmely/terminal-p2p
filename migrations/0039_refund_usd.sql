-- Devolución de los días que no se usaron (worker/pro.ts: refundQuote): lo pagado menos los días usados.
-- Lo devuelto de cada compra, para que lo cobrado cuente lo que se queda. NULL en una devuelta antes de esto: todo
ALTER TABLE pro_checkouts ADD COLUMN refund_usd REAL;
-- Lo que se cobra por cada día usado al devolverla: el día de la semana cuando se compró (USED_DAY_USD). NULL en las
-- de antes: el de ahora
ALTER TABLE pro_checkouts ADD COLUMN day_usd REAL;
