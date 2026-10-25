-- Simulador con Pro: los usuarios Pro operan todos los mercados; el resto, BTC y ETH. La cuenta del
-- simulador (Telegram) se vincula a una licencia Pro con un código o comprando desde el propio simulador
ALTER TABLE sim_users ADD COLUMN pro_license TEXT;

-- Una factura pedida desde el simulador no tiene huella del terminal: se vincula a esa cuenta de Telegram
ALTER TABLE pro_checkouts ADD COLUMN tg INTEGER;
