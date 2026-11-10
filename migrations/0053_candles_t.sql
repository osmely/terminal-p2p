-- La referencia propia de cada mercado (worker/candles.ts ownRefs) lee las velas de las últimas 48 h de todos los
-- mercados: sin este índice recorría la tabla entera cada 15 min, y crece cada día
CREATE INDEX candles_t ON candles (t);
