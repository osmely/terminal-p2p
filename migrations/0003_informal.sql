-- Tasas del mercado informal según elTOQUE: una mediana por divisa y día de Cuba, en CUP.
-- Datos públicos de referencia, tal como los publica elTOQUE: ningún dato de usuarios.
CREATE TABLE informal (
	day   TEXT    NOT NULL, -- día de Cuba, YYYY-MM-DD
	cur   TEXT    NOT NULL, -- USD, ECU (euro), MLC, USDT_TRC20
	rate  REAL    NOT NULL, -- CUP por unidad; 0 = elTOQUE no tiene datos ese día
	final INTEGER NOT NULL, -- 1 = día cerrado; 0 = hoy, las últimas 24 h
	t     INTEGER NOT NULL, -- epoch ms de la última actualización
	PRIMARY KEY (day, cur)
) WITHOUT ROWID;
