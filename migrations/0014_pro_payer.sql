-- Pro queda a nombre de la cuenta conectada al terminal (requester), aunque pague otra cuenta de QvaPay
-- (payer, confirmado por QvaPay). La devolución, si la hay, va siempre a quien pagó
ALTER TABLE pro_checkouts ADD COLUMN requester TEXT;
ALTER TABLE pro_checkouts ADD COLUMN payer TEXT;
ALTER TABLE pro_checkouts ADD COLUMN payer_uuid TEXT;
