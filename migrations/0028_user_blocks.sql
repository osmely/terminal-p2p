-- Cuentas de QvaPay restringidas o bloqueadas en el terminal desde el panel, por seguridad (estafas, abusos, una
-- cuenta robada). Restringida: no publica, toma ni edita ofertas, pero termina las que tiene abiertas. Bloqueada:
-- el terminal, Pro y el simulador no le funcionan. Solo cierra Terminal P2P, no su cuenta de QvaPay
CREATE TABLE user_blocks (
	username   TEXT PRIMARY KEY,           -- usuario de QvaPay, en minúsculas
	level      TEXT NOT NULL,              -- restricted | blocked
	reason     TEXT NOT NULL,              -- por qué (solo lo ves tú)
	until      INTEGER,                    -- hasta cuándo; NULL: hasta que lo levantes
	created_at INTEGER NOT NULL,
	lifted_at  INTEGER                     -- cuándo lo levantaste (la fila queda; el historial está en pro_audit)
);

-- Huellas de token (nunca el token) vistas de una cuenta bloqueada o restringida: así se la reconoce aunque una
-- petición no traiga la cookie con su cuenta confirmada
CREATE TABLE user_block_prints (
	print    TEXT PRIMARY KEY,
	username TEXT NOT NULL,
	seen_at  INTEGER NOT NULL
);
