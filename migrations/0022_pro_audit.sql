-- Registro de lo que se hace en el panel de Pro: qué, sobre quién y cuándo. Solo se añade, nunca se borra
CREATE TABLE pro_audit (
	id      INTEGER PRIMARY KEY AUTOINCREMENT,
	at      INTEGER NOT NULL,
	action  TEXT NOT NULL,                 -- days | refund | refund-approve | refund-reject | refund-transfer | note | revoke | restore | recover | check | reconcile | pro-on | pro-off | orders-pause | orders-resume | alert-test
	target  TEXT,                          -- el usuario, la compra, la devolución o la factura
	detail  TEXT                           -- lo que dijo el panel al hacerlo
);
CREATE INDEX pro_audit_at ON pro_audit (at);
