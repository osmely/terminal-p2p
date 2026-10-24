-- Competir en el ranking es opcional: por defecto se juega en privado y nadie ve tu nombre
ALTER TABLE sim_users ADD COLUMN compete INTEGER NOT NULL DEFAULT 0;
