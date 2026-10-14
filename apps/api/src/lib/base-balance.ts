import type { Prisma, PrismaClient } from "@prisma/client";

/**
 * F14 (decisión del dueño, 14-oct-2026): la BASE y la deuda por COMISIONES son cuentas
 * INDEPENDIENTES que no se compensan entre sí.
 *
 *   Base pendiente      = Σ bases entregadas − Σ bases devueltas   (libro BaseTransaction)
 *   Deuda por comisión  = Driver.pendingDebt   /  crédito a favor = Driver.creditAmount
 *   Total informativo   = base pendiente + deuda por comisión − crédito  (NO es otra deuda)
 *
 * Antes la base se sumaba a `pendingDebt` (un único saldo neto) y la base mostrada se
 * "conciliaba" con min(libro, deuda neta): un crédito por comisiones ocultaba la base y un
 * pago iba primero a base. Ahora la base solo cambia con entregas y devoluciones (incluida
 * la parte de un pago que el operador asigna EXPLÍCITAMENTE a base).
 */
export function basePendingFrom(given: number, returned: number): number {
  return Math.max(0, given - returned);
}

type Db = PrismaClient | Prisma.TransactionClient;

/** Libro de base de un domiciliario (opcionalmente hasta un instante, exclusivo). */
export async function getBaseLedger(db: Db, driverId: string, before?: Date) {
  const dateWhere = before ? { date: { lt: before } } : {};
  const rows = await db.baseTransaction.groupBy({ by: ["type"], where: { driverId, ...dateWhere }, _sum: { amount: true } });
  const given = rows.find(r => r.type === "entrega")?._sum.amount ?? 0;
  const returned = rows.find(r => r.type === "pago")?._sum.amount ?? 0;
  return { given, returned, pending: basePendingFrom(given, returned) };
}

/** Base pendiente por domiciliario (todos o los indicados), opcionalmente hasta un instante. */
export async function basePendingByDriver(db: Db, opts: { driverIds?: string[]; before?: Date; branchId?: string } = {}) {
  const rows = await db.baseTransaction.groupBy({
    by: ["driverId", "type"],
    where: {
      ...(opts.driverIds ? { driverId: { in: opts.driverIds } } : {}),
      ...(opts.before ? { date: { lt: opts.before } } : {}),
      ...(opts.branchId ? { branchId: opts.branchId } : {}),
    },
    _sum: { amount: true },
  });
  const raw = new Map<string, number>();
  for (const r of rows) raw.set(r.driverId, (raw.get(r.driverId) ?? 0) + (r.type === "entrega" ? 1 : -1) * (r._sum.amount ?? 0));
  const out = new Map<string, number>();
  for (const [id, v] of raw) out.set(id, Math.max(0, v));
  return out;
}
