-- «Mis clientes»: un comerciante con Pro invita a sus clientes de siempre con un enlace y les manda ofertas privadas de
-- QvaPay (no salen en el libro ni en el feed). Se guarda quién está en la lista de quién y lo público de cada oferta que
-- el comerciante mandó (nunca sus datos de pago). Usuarios de QvaPay en minúsculas, y tal cual para enseñarlos
CREATE TABLE client_members (
	merchant      TEXT NOT NULL,
	merchant_name TEXT NOT NULL,
	client        TEXT NOT NULL,
	client_name   TEXT NOT NULL,
	joined_at     INTEGER NOT NULL,
	PRIMARY KEY (merchant, client)
);
CREATE INDEX client_members_client ON client_members (client);

CREATE TABLE client_offers (
	uuid          TEXT PRIMARY KEY,
	merchant      TEXT NOT NULL,
	merchant_name TEXT NOT NULL,
	coin          TEXT NOT NULL,
	type          TEXT NOT NULL,              -- sell: el comerciante vende USD · buy: compra USD
	price         REAL NOT NULL,
	usd           REAL NOT NULL,
	kind          TEXT NOT NULL,              -- fixed · flexible
	order_min     REAL,
	order_max     REAL,
	vip_only      INTEGER NOT NULL DEFAULT 0,
	requirements  TEXT,                       -- JSON, como lo da QvaPay
	status        TEXT NOT NULL DEFAULT 'open', -- open · closed (la tomaron, la cancelaste o caducó)
	sent          INTEGER NOT NULL DEFAULT 0, -- avisos por Telegram que salieron
	created_at    INTEGER NOT NULL,
	closed_at     INTEGER
);
CREATE INDEX client_offers_merchant ON client_offers (merchant, created_at);
CREATE INDEX client_offers_open ON client_offers (status, created_at);
