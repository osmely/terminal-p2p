-- Devoluciones en pasos: la pide el usuario desde «Mi cuenta» (o la apuntas tú), la apruebas (se le quitan los
-- días de esa compra), haces la transferencia en QvaPay y la marcas con su referencia. O la rechazas con un motivo
CREATE TABLE pro_refunds (
	id             TEXT PRIMARY KEY,
	checkout       TEXT NOT NULL UNIQUE,    -- la compra que se devuelve (una vez)
	license        TEXT NOT NULL,           -- qp:usuario
	amount         REAL NOT NULL,
	payee          TEXT NOT NULL,           -- a quién se transfiere: quien pagó según QvaPay
	status         TEXT NOT NULL,           -- requested | approved | transferred | rejected
	reason         TEXT,                    -- por qué la pide
	requested_by   TEXT NOT NULL,           -- user | admin
	requested_at   INTEGER NOT NULL,
	decided_at     INTEGER,
	decision_note  TEXT,                    -- tu nota al aprobar, o el motivo del rechazo (lo ve el usuario)
	transferred_at INTEGER,
	transfer_ref   TEXT                     -- referencia de la transferencia en QvaPay
);
CREATE INDEX pro_refunds_status ON pro_refunds (status, requested_at);
CREATE INDEX pro_refunds_license ON pro_refunds (license);

-- Notas tuyas sobre un cliente («escribió por Telegram el 3/11…»). Solo las ves tú
CREATE TABLE pro_notes (
	id         INTEGER PRIMARY KEY AUTOINCREMENT,
	license    TEXT NOT NULL,
	text       TEXT NOT NULL,
	created_at INTEGER NOT NULL
);
CREATE INDEX pro_notes_license ON pro_notes (license, created_at);

-- Las devoluciones de antes (refunded_at) pasan como transferidas: se hicieron a mano con el flujo anterior
INSERT INTO pro_refunds (id, checkout, license, amount, payee, status, reason, requested_by, requested_at, decided_at, transferred_at)
	SELECT 'rf-' || c.id, c.id, c.license, c.amount, COALESCE(c.payer, l.username, '?'), 'transferred', NULL, 'admin', c.refunded_at, c.refunded_at, c.refunded_at
	FROM pro_checkouts c LEFT JOIN pro_licenses l ON l.uuid = c.license
	WHERE c.refunded_at IS NOT NULL AND c.license IS NOT NULL;
