-- Los días de una cuenta en «En vivo» (live_seen), sin recorrer los de todas: el terminal invita a probar Pro a quien
-- lo usa mucho y aún no lo ha probado (worker/pro.ts, /pro/status)
CREATE INDEX live_seen_account ON live_seen (account, day);
