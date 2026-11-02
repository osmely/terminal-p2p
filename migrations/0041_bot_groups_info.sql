-- La lista de grupos del bot en el panel: el @ del grupo si es público (para abrirlo) y cuántos miembros tiene
-- (se le pregunta a Telegram al entrar y como mucho una vez al día)
ALTER TABLE bot_groups ADD COLUMN username TEXT;
ALTER TABLE bot_groups ADD COLUMN members INTEGER;
ALTER TABLE bot_groups ADD COLUMN members_at INTEGER;
