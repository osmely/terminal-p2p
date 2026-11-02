-- El bot del dólar (worker/ratebot.ts): los grupos donde está, para saber cuánto se extiende. De los chats privados no
-- se guarda nada (solo el contador del día en hits, site 'bot')
CREATE TABLE bot_groups (
	chat_id  INTEGER NOT NULL PRIMARY KEY,
	title    TEXT,
	kind     TEXT    NOT NULL, -- group o supergroup (o channel)
	added_at INTEGER NOT NULL,
	last_at  INTEGER NOT NULL,
	cmds     INTEGER NOT NULL DEFAULT 0, -- consultas respondidas en ese grupo
	left_at  INTEGER -- cuándo lo sacaron (NULL si sigue)
);
