-- Operaciones completadas por lado (QvaPay las publica en /p2p/averages como count_buy y count_sell)
ALTER TABLE rates ADD COLUMN count_buy INTEGER;
ALTER TABLE rates ADD COLUMN count_sell INTEGER;
