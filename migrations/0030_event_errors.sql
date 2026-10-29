-- Por qué rechazó QvaPay una acción hecha desde el terminal: su código (OFFER_PAUSED…) o el estado HTTP con su
-- mensaje, sin números ni @usuarios. Vacío si salió bien (y en las filas de antes, que no lo apuntaban)
ALTER TABLE events ADD COLUMN err TEXT NOT NULL DEFAULT '';
