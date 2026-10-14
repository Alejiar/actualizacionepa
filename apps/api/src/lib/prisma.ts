import { PrismaClient, Prisma } from "@prisma/client";
import { AsyncLocalStorage } from "node:async_hooks";
import { HttpError } from "./errors";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

const root =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = root;
}

const scope = new AsyncLocalStorage<Prisma.TransactionClient>();

/** Los servicios de una operación financiera comparten su transacción. Un fallo
 * revierte saldo, movimiento, registros derivados y aprobación conjuntamente. */
export const prisma: PrismaClient = new Proxy(root, {
  get(target, prop) {
    const tx = scope.getStore();
    if (tx && prop === "$transaction") {
      return async (work: ((client: Prisma.TransactionClient) => unknown) | Promise<unknown>[]) => {
        if (typeof work === "function") return work(tx);
        // Conserva el orden declarado de las operaciones (incluidas sus FK).
        const results = [];
        for (const query of work) results.push(await query);
        return results;
      };
    }
    const client = tx ?? target;
    const value = Reflect.get(client, prop);
    return typeof value === "function" ? value.bind(client) : value;
  },
});

/** Exclusión entre procesos vía PostgreSQL, ANTES de leer cualquier saldo.
 * Adecuado al volumen de una caja: serializa escrituras, no lecturas normales.
 * Nunca envolver llamadas a Shipday; solo persistencia local de cada pedido. */
const MONEY_TX_TIMEOUT_MS = 120_000;
let moneyBusySince: number | null = null;

export async function moneyTransaction<T>(work: () => Promise<T>): Promise<T> {
  if (scope.getStore()) return work();
  const granted = await enterMoneyQueue();
  // Liberación idempotente: liberar dos veces entregaría la caja a dos operaciones a la vez.
  let released = false;
  const release = () => { if (!released) { released = true; moneyBusySince = null; granted(); } };
  moneyBusySince = Date.now();
  let guardTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    const txPromise = root.$transaction(async tx => {
      await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '3s'");
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(20260928, 1)`;
      return scope.run(tx, work);
    }, { maxWait: 15000, timeout: MONEY_TX_TIMEOUT_MS });
    // Si el trabajo queda colgado (promesa que nunca se resuelve), Prisma cierra y revierte la
    // transacción a los 120 s pero NO rechaza esta promesa. Sin este límite propio, la cola en
    // memoria quedaba tomada para siempre y toda la caja respondía 503 hasta reiniciar.
    const guard = new Promise<never>((_, reject) => {
      guardTimer = setTimeout(() => reject(new HttpError(503, "La operación de caja excedió el tiempo máximo y se canceló.")), MONEY_TX_TIMEOUT_MS + 5000);
    });
    txPromise.catch(() => {}); // evita un rechazo no manejado si el guardia ganó la carrera
    return await Promise.race([txPromise, guard]);
  } finally {
    if (guardTimer) clearTimeout(guardTimer);
    release();
  }
}

/** Estado de la cola financiera para /api/health (detecta una caja trabada). */
export function moneyQueueStatus() {
  return { busyMs: moneyBusySince ? Date.now() - moneyBusySince : 0, waiting: moneyQueue.length };
}

// Esperar fuera de PostgreSQL: una ráfaga legítima no ocupa todas las conexiones
// esperando el mismo candado. El candado SQL sigue protegiendo entre procesos.
let moneyBusy = false;
const moneyQueue: Array<() => void> = [];
function releaseMoney() {
  const next = moneyQueue.shift();
  if (next) next(); else moneyBusy = false;
}
function enterMoneyQueue(): Promise<() => void> {
  if (!moneyBusy) { moneyBusy = true; return Promise.resolve(releaseMoney); }
  if (moneyQueue.length >= 64) return Promise.reject(new HttpError(503,"Caja ocupada; reintenta la operación."));
  return new Promise((resolve,reject) => {
    const grant = () => { clearTimeout(timer); resolve(releaseMoney); };
    const timer = setTimeout(() => {
      const i = moneyQueue.indexOf(grant);
      if (i >= 0) moneyQueue.splice(i,1);
      reject(new HttpError(503,"Tiempo de espera agotado; reintenta la operación."));
    },15000);
    moneyQueue.push(grant);
  });
}
