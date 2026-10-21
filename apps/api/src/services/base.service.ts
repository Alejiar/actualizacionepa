import { prisma, moneyTransaction } from "../lib/prisma";
import { notFound, badRequest, conflict } from "../lib/errors";
import { bogotaOpenRange } from "../lib/date-range";
import { getBaseLedger } from "../lib/base-balance";
import { assertOpenInstant, moneyNow } from "../lib/period-guard";
import { assertMoney } from "../lib/money-validation";

/**
 * F14: la base es una cuenta propia (ver lib/base-balance). Entregar, devolver, editar o
 * eliminar una base cambia SOLO el libro de base y la caja; nunca la deuda por comisiones
 * (`pendingDebt`) ni el crédito. El libro nunca puede quedar con más devuelto que entregado.
 */
async function assertLedgerStaysValid(driverId: string, givenDelta: number, returnedDelta: number) {
  const l = await getBaseLedger(prisma, driverId);
  if (l.given + givenDelta < l.returned + returnedDelta) {
    throw conflict("La base quedaría con más devoluciones que entregas. Corrige primero la devolución correspondiente.");
  }
}

// Eliminar una base (admin directo).
export async function removeBase(id: string) {
  return moneyTransaction(async () => {
  const base = await prisma.baseTransaction.findUnique({ where: { id } });
  if (!base) throw notFound("Base no encontrada");
  await assertOpenInstant(base.date, "La base", base.branchId);
  if (base.bankTransactionId) throw badRequest("Corrige el cobro original en Movimientos, no su desglose de base.");
  if (base.type === "entrega") await assertLedgerStaysValid(base.driverId, -base.amount, 0);
  await prisma.baseTransaction.delete({ where: { id } });
  return { ok: true };

  });
}

// Editar el monto de una base (admin directo): solo cambia el libro de base y la caja.
export async function editBase(id: string, input: { cashAmount?: number; bankAmount?: number; amount?: number; notes?: string }) {
  return moneyTransaction(async () => {
  const base = await prisma.baseTransaction.findUnique({ where: { id } });
  if (!base) throw notFound("Base no encontrada");
  if (input.amount !== undefined || input.cashAmount !== undefined || input.bankAmount !== undefined) {
    await assertOpenInstant(base.date, "La base", base.branchId);
    if (input.amount !== undefined) assertMoney(input.amount);
    if (input.cashAmount !== undefined) assertMoney(input.cashAmount, true);
    if (input.bankAmount !== undefined) assertMoney(input.bankAmount, true);
  }
  if (base.bankTransactionId) throw badRequest("Corrige el cobro original en Movimientos, no su desglose de base.");

  let cashAmount: number;
  let bankAmount: number;
  let newAmount: number;

  if (input.cashAmount != null || input.bankAmount != null) {
    cashAmount = Math.round(input.cashAmount ?? base.cashAmount);
    bankAmount = Math.round(input.bankAmount ?? base.bankAmount);
    newAmount = cashAmount + bankAmount;
  } else if (input.amount != null) {
    // Solo se editó el total: reescalar cashAmount/bankAmount proporcionalmente para
    // que sigan sumando el nuevo total (si no, el saldo de banco/efectivo, que usa
    // cashAmount/bankAmount y no amount, queda desincronizado del valor corregido).
    newAmount = Math.round(input.amount);
    const oldTotal = base.cashAmount + base.bankAmount;
    if (oldTotal > 0) {
      bankAmount = Math.round(base.bankAmount * (newAmount / oldTotal));
      cashAmount = newAmount - bankAmount;
    } else {
      cashAmount = newAmount;
      bankAmount = 0;
    }
  } else {
    cashAmount = base.cashAmount;
    bankAmount = base.bankAmount;
    newAmount = base.amount;
  }

  if (!Number.isSafeInteger(newAmount) || newAmount <= 0 || cashAmount < 0 || bankAmount < 0) throw badRequest("El monto debe ser mayor a 0");
  assertMoney(newAmount);
  if ((input.cashAmount !== undefined || input.bankAmount !== undefined) && input.amount !== undefined && input.amount !== newAmount) throw badRequest("El total no coincide con efectivo más banco.");
  const diff = newAmount - base.amount;
  await assertLedgerStaysValid(base.driverId, base.type === "entrega" ? diff : 0, base.type === "pago" ? diff : 0);
  await prisma.baseTransaction.update({ where: { id }, data: { amount: newAmount, cashAmount, bankAmount, ...(input.notes != null ? { notes: input.notes } : {}) } });
  return { ok: true };

  });
}

export async function listBases(branchId?: string, driverId?: string, from?: string, to?: string) {
  const where: Record<string, unknown> = {};
  if (branchId) where.branchId = branchId;
  if (driverId) where.driverId = driverId;
  const dateWhere = bogotaOpenRange(from, to);
  if (dateWhere) where.date = dateWhere;
  return prisma.baseTransaction.findMany({
    where,
    include: {
      driver: { select: { id: true, name: true } },
      branch: { select: { id: true, name: true } },
    },
    orderBy: { date: "desc" },
  });
}

// Acepta split efectivo/transferencia combinable. amount = cash + bank.
export async function giveBase(driverId: string, input: { cashAmount?: number; bankAmount?: number; amount?: number; notes?: string; createdBy?: string | null; createdByName?: string | null; deviceId?: string | null; deviceName?: string | null }) {
  return moneyTransaction(async () => {
  await assertOpenInstant(undefined, "La entrega de base");
  if (input.amount !== undefined) assertMoney(input.amount);
  if (input.cashAmount !== undefined) assertMoney(input.cashAmount, true);
  if (input.bankAmount !== undefined) assertMoney(input.bankAmount, true);
  const driver = await prisma.driver.findUnique({ where: { id: driverId } });
  if (!driver) throw notFound("Domiciliario no encontrado");
  await assertOpenInstant(undefined, "La entrega de base", driver.branchId);
  const cashAmount = Math.round(input.cashAmount ?? 0);
  const bankAmount = Math.round(input.bankAmount ?? 0);
  const amount = (cashAmount + bankAmount) || Math.round(input.amount ?? 0);
  assertMoney(amount);
  if ((input.cashAmount !== undefined || input.bankAmount !== undefined) && input.amount !== undefined && input.amount !== cashAmount + bankAmount) throw badRequest("El total no coincide con efectivo más banco.");
  if (!Number.isSafeInteger(amount) || amount <= 0 || cashAmount < 0 || bankAmount < 0) throw badRequest("El monto debe ser mayor a 0");

  const recordedAt = await moneyNow(); // NEW02: el dinero cuenta en el día operativo (caja abierta), no según el reloj.
  // F14: la base entregada se lleva en su propio libro; no suma a la deuda por comisiones.
  return prisma.baseTransaction.create({
    data: { driverId, branchId: driver.branchId, amount, cashAmount, bankAmount, type: "entrega", date: recordedAt, notes: input.notes, createdBy: input.createdBy ?? null, createdByName: input.createdByName ?? null, deviceId: input.deviceId ?? null, deviceName: input.deviceName ?? null },
  });

  });
}

export async function payBase(driverId: string, input: { cashAmount?: number; bankAmount?: number; amount?: number; notes?: string; createdBy?: string | null; createdByName?: string | null; deviceId?: string | null; deviceName?: string | null }) {
  return moneyTransaction(async () => {
  await assertOpenInstant(undefined, "La devolución de base");
  if (input.amount !== undefined) assertMoney(input.amount);
  if (input.cashAmount !== undefined) assertMoney(input.cashAmount, true);
  if (input.bankAmount !== undefined) assertMoney(input.bankAmount, true);
  const driver = await prisma.driver.findUnique({ where: { id: driverId } });
  if (!driver) throw notFound("Domiciliario no encontrado");
  await assertOpenInstant(undefined, "La devolución de base", driver.branchId);
  const cashAmount = Math.round(input.cashAmount ?? 0);
  const bankAmount = Math.round(input.bankAmount ?? 0);
  const amount = (cashAmount + bankAmount) || Math.round(input.amount ?? 0);
  assertMoney(amount);
  if ((input.cashAmount !== undefined || input.bankAmount !== undefined) && input.amount !== undefined && input.amount !== cashAmount + bankAmount) throw badRequest("El total no coincide con efectivo más banco.");
  if (!Number.isSafeInteger(amount) || amount <= 0 || cashAmount < 0 || bankAmount < 0) throw badRequest("El monto debe ser mayor a 0");

  // Un "pago de base" es la DEVOLUCIÓN de una base prestada: solo si el domiciliario debe
  // base, y nunca más de lo que debe (el libro de base no puede quedar negativo). La base
  // pendiente se mide sobre TODO el historial. F14: independiente de comisiones y crédito.
  const basePending = (await getBaseLedger(prisma, driverId)).pending;
  if (basePending <= 0) {
    throw badRequest("Este domiciliario no tiene base pendiente por devolver, así que no se puede registrar un pago de base.");
  }
  if (amount > basePending) {
    throw badRequest(`El pago de base ($${amount.toLocaleString("es-CO")}) supera la base pendiente ($${basePending.toLocaleString("es-CO")}). Ajusta el monto: no se puede devolver más base de la que se debe.`);
  }

  const recordedAt = await moneyNow(); // NEW02: el dinero cuenta en el día operativo (caja abierta), no según el reloj.
  // F14: devolver base reduce solo el libro de base (no la deuda por comisiones).
  return prisma.baseTransaction.create({
    data: { driverId, branchId: driver.branchId, amount, cashAmount, bankAmount, type: "pago", date: recordedAt, notes: input.notes, createdBy: input.createdBy ?? null, createdByName: input.createdByName ?? null, deviceId: input.deviceId ?? null, deviceName: input.deviceName ?? null },
  });

  });
}

export async function getBaseSummary(driverId: string) {
  const driver = await prisma.driver.findUnique({ where: { id: driverId } });
  if (!driver) throw notFound("Domiciliario no encontrado");

  const bases = await prisma.baseTransaction.findMany({
    where: { driverId },
    orderBy: { date: "asc" },
  });

  const given = bases.filter(b => b.type === "entrega").reduce((s, b) => s + b.amount, 0);
  const paid = bases.filter(b => b.type === "pago").reduce((s, b) => s + b.amount, 0);

  // F14: base pendiente pura del libro (entregadas − devueltas), independiente de comisiones.
  return { given, paid, pending: Math.max(0, given - paid), history: bases };
}
