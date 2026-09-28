import { prisma, moneyTransaction } from "../lib/prisma";
import { notFound, badRequest } from "../lib/errors";
import { applyDebtDelta } from "./driver.service";
import { bogotaOpenRange } from "../lib/date-range";
import { reconcileBasePending } from "../lib/base-balance";

// Eliminar una base (admin directo): revierte el efecto en la deuda del domiciliario.
// Usa applyDebtDelta (netea contra el crédito y nunca deja pendingDebt negativo) en
// vez de un `pendingDebt: { increment }` crudo. El increment crudo ignoraba el crédito
// y podía dejar pendingDebt negativo: un agujero silencioso que sacaba al domiciliario
// de "Deudas" (filtra por pendingDebt > 0) aunque su base siguiera pendiente.
export async function removeBase(id: string) {
  return moneyTransaction(async () => {
  const base = await prisma.baseTransaction.findUnique({ where: { id } });
  if (!base) throw notFound("Base no encontrada");
  if (base.bankTransactionId) throw badRequest("Corrige el cobro original en Movimientos, no su desglose de base.");
  // entrega subió la deuda → al borrar baja (−amount); pago la bajó → al borrar sube (+amount)
  const delta = base.type === "entrega" ? -base.amount : base.amount;
  await prisma.$transaction(async (tx) => {
    await tx.baseTransaction.delete({ where: { id } });
    await applyDebtDelta(tx, base.driverId, delta);
  });
  return { ok: true };

  });
}

// Editar el monto de una base (admin directo): ajusta la deuda por la diferencia.
export async function editBase(id: string, input: { cashAmount?: number; bankAmount?: number; amount?: number; notes?: string }) {
  return moneyTransaction(async () => {
  const base = await prisma.baseTransaction.findUnique({ where: { id } });
  if (!base) throw notFound("Base no encontrada");
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
  // Ajuste por la diferencia, neteado contra el crédito (entrega suma; pago resta).
  const sign = base.type === "entrega" ? 1 : -1;
  const delta = sign * (newAmount - base.amount);
  await prisma.$transaction(async (tx) => {
    await tx.baseTransaction.update({ where: { id }, data: { amount: newAmount, cashAmount, bankAmount, ...(input.notes != null ? { notes: input.notes } : {}) } });
    await applyDebtDelta(tx, base.driverId, delta);
  });
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
  const driver = await prisma.driver.findUnique({ where: { id: driverId } });
  if (!driver) throw notFound("Domiciliario no encontrado");
  const cashAmount = Math.round(input.cashAmount ?? 0);
  const bankAmount = Math.round(input.bankAmount ?? 0);
  const amount = (cashAmount + bankAmount) || Math.round(input.amount ?? 0);
  if (!Number.isSafeInteger(amount) || amount <= 0 || cashAmount < 0 || bankAmount < 0) throw badRequest("El monto debe ser mayor a 0");

  const tx = await prisma.$transaction(async (txc) => {
    const created = await txc.baseTransaction.create({
      data: { driverId, branchId: driver.branchId, amount, cashAmount, bankAmount, type: "entrega", notes: input.notes, createdBy: input.createdBy ?? null, createdByName: input.createdByName ?? null, deviceId: input.deviceId ?? null, deviceName: input.deviceName ?? null },
    });
    // Entregar base aumenta lo que debe, neteando contra cualquier crédito a favor.
    await applyDebtDelta(txc, driverId, amount);
    return created;
  });
  return tx;

  });
}

export async function payBase(driverId: string, input: { cashAmount?: number; bankAmount?: number; amount?: number; notes?: string; createdBy?: string | null; createdByName?: string | null; deviceId?: string | null; deviceName?: string | null }) {
  return moneyTransaction(async () => {
  const driver = await prisma.driver.findUnique({ where: { id: driverId } });
  if (!driver) throw notFound("Domiciliario no encontrado");
  const cashAmount = Math.round(input.cashAmount ?? 0);
  const bankAmount = Math.round(input.bankAmount ?? 0);
  const amount = (cashAmount + bankAmount) || Math.round(input.amount ?? 0);
  if (!Number.isSafeInteger(amount) || amount <= 0 || cashAmount < 0 || bankAmount < 0) throw badRequest("El monto debe ser mayor a 0");

  // Un "pago de base" es la DEVOLUCIÓN de una base prestada: solo tiene sentido si el
  // domiciliario efectivamente debe base. Sin esta guarda se podían registrar pagos de
  // base a alguien que no debía ninguna, dejando el saldo de bases (entregas − pagos)
  // NEGATIVO —un "crédito de base" fantasma que descuadra el módulo de Bases y, vía
  // applyDebtDelta, la deuda del domiciliario. La base pendiente se mide sobre TODO el
  // historial (no solo el día visible), igual que en registerPayment/applyBankToDriver.
  const [givenAgg, paidAgg] = await Promise.all([
    prisma.baseTransaction.aggregate({ where: { driverId, type: "entrega" }, _sum: { amount: true } }),
    prisma.baseTransaction.aggregate({ where: { driverId, type: "pago" }, _sum: { amount: true } }),
  ]);
  const basePending = reconcileBasePending((givenAgg._sum.amount ?? 0) - (paidAgg._sum.amount ?? 0), driver.pendingDebt);
  if (basePending <= 0) {
    throw badRequest("Este domiciliario no tiene base pendiente por devolver, así que no se puede registrar un pago de base.");
  }
  if (amount > basePending) {
    throw badRequest(`El pago de base ($${amount.toLocaleString("es-CO")}) supera la base pendiente ($${basePending.toLocaleString("es-CO")}). Ajusta el monto: no se puede devolver más base de la que se debe.`);
  }

  const tx = await prisma.$transaction(async (txc) => {
    const created = await txc.baseTransaction.create({
      data: { driverId, branchId: driver.branchId, amount, cashAmount, bankAmount, type: "pago", notes: input.notes, createdBy: input.createdBy ?? null, createdByName: input.createdByName ?? null, deviceId: input.deviceId ?? null, deviceName: input.deviceName ?? null },
    });
    // Devolver base reduce la deuda; si excede, queda como crédito (no deuda negativa).
    await applyDebtDelta(txc, driverId, -amount);
    return created;
  });
  return tx;

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

  // Base pendiente CONCILIADA con la deuda neta (ver lib/base-balance): el residuo bruto
  // given−paid puede sobrevalorar la base de un domiciliario ya saldado.
  return { given, paid, pending: reconcileBasePending(given - paid, driver.pendingDebt), history: bases };
}
