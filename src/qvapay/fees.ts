// Comisión de QvaPay al liberar una operación P2P: se descuenta de los USD que recibe quien compra, y las
// cuentas GOLD no la pagan. QvaPay no la publica por API (solo en la documentación de «Confirmar recepción»):
// si un día cobra otra cosa, el relé lo avisa en los registros (worker/metrics.ts, feeMismatch)
export const P2P_FEE = 0.0025

const cents = (n: number) => Math.round(n * 100) / 100

// La comisión de una operación de usd USD, y lo que le queda a quien compra
export const p2pFee = (usd: number, gold = false) => (gold ? 0 : cents(usd * P2P_FEE))
export const netUsd = (usd: number, gold = false) => cents(usd - p2pFee(usd, gold))
