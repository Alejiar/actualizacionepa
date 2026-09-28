import { badRequest } from "./errors";

// Los importes en pesos se almacenan como INTEGER de PostgreSQL. Rechazar antes
// de escribir evita desbordamientos, redondeos silenciosos y entradas no numéricas.
export const MAX_MONEY = 2_147_483_647;
export function assertMoney(value: unknown, allowZero = false): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value > MAX_MONEY || value < (allowZero ? 0 : 1)) {
    throw badRequest(`El monto debe ser un entero entre ${allowZero ? 0 : 1} y ${MAX_MONEY} pesos.`);
  }
}
