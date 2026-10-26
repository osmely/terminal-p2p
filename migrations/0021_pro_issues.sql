-- Pagos que QvaPay cobró y aquí no constan (los encuentra el repaso diario o el botón del panel). Siguen en
-- «Pendientes» hasta que se activan para quien pagó
CREATE TABLE pro_issues (
	invoice     TEXT PRIMARY KEY,           -- transaction_uuid de QvaPay
	remote_id   TEXT,
	payer       TEXT,
	amount      REAL,
	paid_at     TEXT,                       -- como lo da QvaPay
	found_at    INTEGER NOT NULL,
	resolved_at INTEGER
);
