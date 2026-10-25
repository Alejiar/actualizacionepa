import type { Prisma } from "@prisma/client";
import { prisma, moneyTransaction } from "../lib/prisma";
import { assertOpenInstant, assertReconcilable, isDayClosed, moneyNow } from "../lib/period-guard";
import { assertMoney } from "../lib/money-validation";
import { badRequest, notFound } from "../lib/errors";
import { bogotaDayRange, toBogotaDateStr, todayBogota } from "../lib/date-range";
import { BANK_LINKED_PAYMENT_NOTE, bankLinkedBaseNote } from "../lib/balance-markers";
import { basePendingByDriver, getBaseLedger } from "../lib/base-balance";

// Usuario + equipo (PC) que hace la acción. Compatible con lo que devuelve getActor(req).
type ActorLike = { id?: string | null; name?: string | null; deviceId?: string | null; deviceName?: string | null };

/**
 * Aplica un cambio en la cuenta de COMISIONES de un domiciliario manteniendo SIEMPRE el
 * invariante de que deuda y crédito NO sean ambos positivos a la vez.
 *
 * F14 (14-oct-2026): esta cuenta es SOLO de comisiones. La base se lleva en su propio libro
 * (lib/base-balance) y no se compensa con la deuda ni con el crédito.
 *
 * La verdad única es el neto = pendingDebt − creditAmount:
 *   delta > 0  → debe más (comisión de un pedido)
 *   delta < 0  → se le debe más / paga (pago de comisión)
 *
 * Antes, al entrar un pedido se hacía `pendingDebt += comisión` SIN descontar el
 * crédito que la empresa ya le debía, dejando deuda y crédito positivos al tiempo
 * (p. ej. "debe 10.000" y a la vez "le debemos 1.000"). Esto netea: si tenía
 * 1.000 a favor y entra comisión de 10.000 → debe 9.000 (no 10.000 + 1.000 aparte).
 */
export async function applyDebtDelta(tx: Prisma.TransactionClient, driverId: string, delta: number): Promise<void> {
  if (!Number.isSafeInteger(delta)) throw badRequest("Monto inválido");
  if (!delta) return;
  await tx.$queryRaw`SELECT id FROM "Driver" WHERE id = ${driverId} FOR UPDATE`;
  const d = await tx.driver.findUnique({
    where: { id: driverId },
    select: { pendingDebt: true, creditAmount: true, creditMedium: true },
  });
  if (!d) return;
  const net = d.pendingDebt - (d.creditAmount ?? 0) + delta;
  await tx.driver.update({
    where: { id: driverId },
    data: {
      pendingDebt: net > 0 ? net : 0,
      creditAmount: net < 0 ? -net : 0,
      creditMedium: net < 0 ? d.creditMedium ?? null : null,
    },
  });
}

const DELIVERED_FILTER = { in: ["DELIVERED", "COMPLETED"] };

function formatCOP(n: number): string {
  return "$" + Math.round(n).toLocaleString("es-CO");
}

export async function listDrivers(branchId?: string) {
  // F14: un inactivo con base sin devolver también debe verse (para cobrársela).
  const withBase = [...(await basePendingByDriver(prisma, { branchId })).entries()].filter(([, v]) => v > 0).map(([id]) => id);
  const drivers = await prisma.driver.findMany({
    where: {
      ...(branchId ? { branchId } : {}),
      // Ocultar del roster a los domiciliarios INACTIVOS YA SALDADOS (los borrados en
      // Shipday que la reconciliación desactivó, sin deuda ni crédito). Su historial
      // (pedidos, pagos, stats) queda intacto en la BD para reportes; solo desaparecen
      // de la lista y de los selectores. Los inactivos que AÚN deban o se les deba SÍ se
      // muestran, para poder cobrarles/pagarles; al saldar quedan ocultos también.
      OR: [
        { active: true },
        { pendingDebt: { gt: 0 } },
        { creditAmount: { gt: 0 } },
        { id: { in: withBase } },
      ],
    },
    include: { branch: { select: { id: true, name: true } } },
    orderBy: { name: "asc" },
  });

  // F14: base pendiente PURA del libro de base (entregadas − devueltas), independiente de la
  // deuda por comisiones. `totalInformativo` es solo una suma para mostrar, no otra deuda.
  const baseById = await basePendingByDriver(prisma, { driverIds: drivers.map(d => d.id) });
  return drivers.map(d => {
    const basePending = baseById.get(d.id) ?? 0;
    return { ...d, basePending, totalInformativo: basePending + d.pendingDebt - (d.creditAmount ?? 0) };
  });
}

export async function getDriverDetail(id: string) {
  const driver = await prisma.driver.findUnique({
    where: { id },
    include: {
      branch: { select: { id: true, name: true } },
      bases: { orderBy: { date: "desc" }, take: 50 },
      payments: { orderBy: { date: "desc" }, take: 50 },
      orders: { where: { status: DELIVERED_FILTER }, orderBy: { deliveredAt: "desc" }, take: 100 },
      dailyStats: { orderBy: { date: "desc" }, take: 30 },
    },
  });
  if (!driver) throw notFound("Domiciliario no encontrado");
  // F14: base pendiente pura (libro de base), separada de la deuda por comisiones.
  const base = await getBaseLedger(prisma, id);
  return { ...driver, basePending: base.pending, basesGiven: base.given, basesReturned: base.returned, totalInformativo: base.pending + driver.pendingDebt - (driver.creditAmount ?? 0) };
}

/**
 * Pago de un domiciliario. F14: el OPERADOR divide el importe entre comisión y base
 * (`baseAmount`; el resto va a comisión). La parte de comisión reduce la deuda por
 * comisiones (si sobra, queda crédito a favor); la parte de base reduce solo el libro de
 * base y nunca puede superar la base pendiente. Un único ingreso de caja/banco por el total.
 */
export async function registerPayment(driverId: string, amount: number, medium: "cash" | "bank", notes?: string, actor?: ActorLike, baseAmount = 0) {
  return moneyTransaction(async () => {
  await assertOpenInstant(undefined, "El pago del domiciliario");
  // INC-02: mismo tope que el resto (antes un monto > INT4 llegaba a PostgreSQL y respondía 500).
  if (!Number.isSafeInteger(amount) || amount <= 0) throw badRequest("Monto inválido");
  assertMoney(amount);
  if (medium !== "cash" && medium !== "bank") throw badRequest("Medio de pago inválido (cash o bank)");
  const driver = await prisma.driver.findUnique({ where: { id: driverId } });
  if (!driver) throw notFound("Domiciliario no encontrado");
  await assertOpenInstant(undefined, "El pago del domiciliario", driver.branchId);

  const basePending = (await getBaseLedger(prisma, driverId)).pending;
  const { baseAlloc, commissionAlloc } = splitPayment(amount, baseAmount, basePending);

  // Registra UN solo movimiento (bankTransaction) como registro autoritativo de display y saldo.
  const recordedAt = await moneyNow(); // NEW02: el dinero cuenta en el día operativo (caja abierta), no según el reloj.
  // BaseTransaction y DriverPayment son contabilidad interna de la deuda del domiciliario;
  // se marcan como bank-linked para que getExpectedBalances y unified-movements los ignoren.
  let payment = null as Awaited<ReturnType<typeof prisma.driverPayment.create>> | null;

  await prisma.$transaction(async (tx) => {
    // Registro único de display y saldo (funciona para efectivo y transferencia).
    // Se crea PRIMERO para poder enlazar por ID los registros contables internos
    // que dependen de él — así, si este BankTransaction se elimina después, se
    // pueden encontrar y borrar SIN ambigüedad (antes se buscaban por fecha
    // aproximada ±5s, lo que fallaba y dejaba "pagos" huérfanos).
    const breakdown = [
      ...(baseAlloc > 0 ? [`base ${baseAlloc}`] : []),
      ...(commissionAlloc > 0 ? [`comisión ${commissionAlloc}`] : []),
    ].join(" + ");
    const bankTx = await tx.bankTransaction.create({
      data: {
        type: "ingreso",
        date: recordedAt,
        medium,
        amount,
        description: `Pago domiciliario ${driver.name}${breakdown ? ` (${breakdown})` : ""}${notes ? ` · ${notes}` : ""}`,
        driverId,
        driverName: driver.name,
        createdBy: actor?.id ?? null,
        createdByName: actor?.name ?? null,
        deviceId: actor?.deviceId ?? null,
        deviceName: actor?.deviceName ?? null,
        noCounterpart: true,
        // Este ingreso ES el pago: reduce la posición neta del domiciliario en `amount`.
        debtApplied: amount,
      },
    });

    // Contabilidad interna: devolución de base (excluida de saldo y display).
    if (baseAlloc > 0) {
      await tx.baseTransaction.create({
        data: {
          driverId,
          branchId: driver.branchId,
          amount: baseAlloc,
          date: recordedAt,
          cashAmount: medium === "cash" ? baseAlloc : 0,
          bankAmount: medium === "bank" ? baseAlloc : 0,
          type: "pago",
          notes: `${bankLinkedBaseNote(medium)} · Devolución de base${notes ? ` · ${notes}` : ""}`,
          createdBy: actor?.id ?? null,
          createdByName: actor?.name ?? null,
          deviceId: actor?.deviceId ?? null,
          deviceName: actor?.deviceName ?? null,
          bankTransactionId: bankTx.id,
        },
      });
    }

    // Contabilidad interna: pago de comisión (excluido de saldo y display).
    if (commissionAlloc > 0) {
      payment = await tx.driverPayment.create({
        data: {
          driverId,
          branchId: driver.branchId,
          amount: commissionAlloc,
          date: recordedAt,
          medium,
          notes: `${BANK_LINKED_PAYMENT_NOTE} · Pago de comisión${notes ? ` · ${notes}` : ""}`,
          createdBy: actor?.id ?? null,
          createdByName: actor?.name ?? null,
          deviceId: actor?.deviceId ?? null,
          deviceName: actor?.deviceName ?? null,
          bankTransactionId: bankTx.id,
        },
      });
    }

    // Solo la parte de comisión toca la cuenta de comisiones (el sobrante queda a favor).
    if (commissionAlloc > 0) {
      await applyDebtDelta(tx, driverId, -commissionAlloc);
      const after = await tx.driver.findUniqueOrThrow({ where: { id: driverId }, select: { creditAmount: true } });
      if ((after.creditAmount ?? 0) > (driver.creditAmount ?? 0)) await tx.driver.update({ where: { id: driverId }, data: { creditMedium: medium } });
    }
  });

  const final = await prisma.driver.findUniqueOrThrow({ where: { id: driverId }, select: { pendingDebt: true, creditAmount: true } });
  return { payment, baseAlloc, commissionAlloc, basePendingBefore: basePending, commissionDebt: final.pendingDebt, creditAmount: final.creditAmount ?? 0 };

  });
}

/** Valida el reparto pedido por el operador (F14). */
function splitPayment(amount: number, baseAmount: unknown, basePending: number) {
  const b = baseAmount === undefined || baseAmount === null ? 0 : baseAmount;
  if (typeof b !== "number" || !Number.isSafeInteger(b) || b < 0) throw badRequest("La parte a base debe ser un entero ≥ 0.");
  if (b > amount) throw badRequest("La parte a base no puede superar el pago.");
  if (b > basePending) throw badRequest(`La parte a base ($${b.toLocaleString("es-CO")}) supera la base pendiente ($${basePending.toLocaleString("es-CO")}).`);
  return { baseAlloc: b, commissionAlloc: amount - b };
}

export async function getDriverStatement(id: string) {
  const driver = await prisma.driver.findUnique({ where: { id } });
  if (!driver) throw notFound("Domiciliario no encontrado");

  const [orders, bases, payments, stats] = await Promise.all([
    prisma.shipdayOrder.findMany({ where: { driverId: id, status: DELIVERED_FILTER }, orderBy: { deliveredAt: "desc" } }),
    prisma.baseTransaction.findMany({ where: { driverId: id }, orderBy: { date: "desc" } }),
    prisma.driverPayment.findMany({ where: { driverId: id }, orderBy: { date: "desc" } }),
    prisma.dailyDriverStat.findMany({ where: { driverId: id }, orderBy: { date: "desc" }, take: 30 }),
  ]);

  const totalOrders = orders.length;
  const totalValue = orders.reduce((s, o) => s + o.deliveryValue, 0);
  const totalCompany = orders.reduce((s, o) => s + o.companyAmount, 0);
  const totalBasesGiven = bases.filter(b => b.type === "entrega").reduce((s, b) => s + b.amount, 0);
  const totalBasesPaid = bases.filter(b => b.type === "pago").reduce((s, b) => s + b.amount, 0);
  const totalPaid = payments.reduce((s, p) => s + p.amount, 0);

  // INICIO DEL CICLO DE DEUDA ACTUAL — solo para VISUALIZACIÓN (pantalla de Deudas).
  // Reconstruye el saldo del domiciliario en orden cronológico (comisión de cada
  // domicilio suma; pagos y devoluciones de base restan) y marca el ÚLTIMO momento en
  // que la deuda quedó saldada (<= 0). Los domicilios de la deuda actual son los
  // entregados DESPUÉS de ese momento. Así, cuando paga TODO y vuelve a pedir, el conteo
  // arranca en 1; un abono PARCIAL (sigue debiendo) NO reinicia el conteo. No cambia
  // ningún saldo real (pendingDebt) ni la lógica de deuda.
  const events: { t: number; delta: number }[] = [];
  for (const o of orders) if (o.deliveredAt) events.push({ t: o.deliveredAt.getTime(), delta: o.companyAmount });
  // F14: el ciclo de la deuda es de COMISIONES; la base se lleva aparte.
  for (const p of payments) events.push({ t: p.date.getTime(), delta: -p.amount });
  events.sort((a, b) => a.t - b.t);
  let bal = 0;
  let cycleStartMs = 0; // 0 = nunca llegó a saldarse → se muestran todos (primer ciclo)
  for (const e of events) {
    bal += e.delta;
    if (bal <= 0) cycleStartMs = e.t; // cada vez que se salda, el ciclo se reinicia aquí
  }
  const debtCycleStart = cycleStartMs ? new Date(cycleStartMs) : null;

  return {
    driver,
    totalOrders,
    totalValue,
    totalCompany,
    totalBasesGiven,
    totalBasesPaid,
    totalPaid,
    debtCycleStart,
    pendingDebt: driver.pendingDebt,
    creditAmount: driver.creditAmount ?? 0,
    basePending: Math.max(0, totalBasesGiven - totalBasesPaid),
    totalInformativo: Math.max(0, totalBasesGiven - totalBasesPaid) + driver.pendingDebt - (driver.creditAmount ?? 0),
    creditMedium: driver.creditMedium ?? null,
    orders,
    bases,
    payments,
    stats,
  };
}

export async function applyBankToDriver(
  bankTxId: string,
  driverId: string,
  actor?: ActorLike,
  baseAmount = 0,
) {
  return moneyTransaction(async () => {
  const [bankTx, driver] = await Promise.all([
    prisma.bankTransaction.findUnique({ where: { id: bankTxId } }),
    prisma.driver.findUnique({ where: { id: driverId } }),
  ]);
  if (!bankTx) throw notFound("Movimiento bancario no encontrado");
  if (!driver) throw notFound("Domiciliario no encontrado");
  // Conciliación (25-oct-2026): el ingreso ya se contó en su día; descontarlo de la deuda no mueve
  // caja ni banco, así que un día con Cierre no lo impide (solo un mes cerrado). Si su día ya está
  // cerrado, la contabilidad interna (pago de comisión/base, excluida del esperado) se fecha en el
  // día operativo: ahí es cuando bajó la deuda, y el día cerrado queda intacto.
  await assertReconcilable(bankTx.date, "La aplicación del ingreso a deuda", driver.branchId);
  const closedDay = await isDayClosed(bankTx.date);
  const bookedAt = closedDay ? await moneyNow() : bankTx.date;
  await assertOpenInstant(bookedAt, "La aplicación del ingreso a deuda", driver.branchId);

  // Un cobro o pago de cliente por hora ya está consolidado con su turno: no es plata de
  // ningún domiciliario y descontarlo de una deuda contaría el mismo dinero dos veces.
  if (bankTx.hourlyShiftId) {
    throw badRequest("Este movimiento es de un cliente por hora (ya está consolidado con su turno); no se descuenta de la deuda de un domiciliario.");
  }
  // Un ingreso mixto son dos filas (efectivo + transferencia): aplicar una sola descontaba solo esa
  // mitad aunque la pantalla mostrara el total. Se rechaza; el pago va por "Registrar pago" dividido.
  if (bankTx.groupId) {
    throw badRequest("Este ingreso es mixto (efectivo + transferencia). Para un pago de domiciliario dividido usa «Registrar pago» en Deudas.");
  }

  // Una deuda solo baja cuando ENTRA plata. Una salida es plata que la empresa
  // entregó: descontarla de una deuda es contabilidad al revés. Esto ocurrió de
  // verdad (17-jul-2026): se aplicó una salida de $100.000 a la deuda de una
  // domiciliaria y le borró $18.600 que sí debía.
  if (bankTx.type !== "ingreso") {
    throw badRequest(
      "Una salida no puede descontarse de una deuda: solo los ingresos reducen lo que debe un domiciliario."
    );
  }
  // Un movimiento con contraparte es plata de paso (entra y vuelve a salir), no un
  // pago del domiciliario. Aplicarlo a una deuda contaría el mismo dinero dos veces.
  if (bankTx.pairId) {
    throw badRequest(
      "Este ingreso tiene contraparte registrada, así que no es un pago del domiciliario y no puede descontarse de su deuda."
    );
  }
  if (bankTx.debtApplied !== 0) {
    throw badRequest("Este movimiento ya fue descontado de la deuda de un domiciliario.");
  }

  const amount = bankTx.amount;
  const medium = (bankTx.medium ?? "bank") as "cash" | "bank";
  // F14: el operador indica cuánto del ingreso es devolución de base; el resto es comisión.
  const basePending = (await getBaseLedger(prisma, driverId)).pending;
  const { baseAlloc, commissionAlloc } = splitPayment(amount, baseAmount, basePending);

  await prisma.$transaction(async (tx) => {
    if (baseAlloc > 0) {
      await tx.baseTransaction.create({
        data: {
          driverId,
          branchId: driver.branchId,
          amount: baseAlloc,
          cashAmount: medium === "cash" ? baseAlloc : 0,
          bankAmount: medium === "bank" ? baseAlloc : 0,
          type: "pago",
          notes: bankLinkedBaseNote(medium),
          createdBy: actor?.id ?? null,
          createdByName: actor?.name ?? null,
          deviceId: actor?.deviceId ?? null,
          deviceName: actor?.deviceName ?? null,
          bankTransactionId: bankTxId,
          date: bookedAt,
        },
      });
    }
    if (commissionAlloc > 0) {
      await tx.driverPayment.create({
        data: {
          driverId,
          branchId: driver.branchId,
          amount: commissionAlloc,
          medium,
          notes: BANK_LINKED_PAYMENT_NOTE,
          createdBy: actor?.id ?? null,
          createdByName: actor?.name ?? null,
          deviceId: actor?.deviceId ?? null,
          deviceName: actor?.deviceName ?? null,
          bankTransactionId: bankTxId,
          date: bookedAt,
        },
      });
      await applyDebtDelta(tx, driverId, -commissionAlloc);
      const after = await tx.driver.findUniqueOrThrow({ where: { id: driverId }, select: { creditAmount: true } });
      if ((after.creditAmount ?? 0) > (driver.creditAmount ?? 0)) await tx.driver.update({ where: { id: driverId }, data: { creditMedium: medium } });
    }

    // Dejar escrito en la descripción del movimiento QUÉ se descontó y a quién.
    const partes: string[] = [];
    if (baseAlloc > 0) partes.push(`base ${formatCOP(baseAlloc)}`);
    if (commissionAlloc > 0) partes.push(`comisión ${formatCOP(commissionAlloc)}`);
    await tx.bankTransaction.update({
      where: { id: bankTxId },
      data: {
        driverId,
        driverName: driver.name,
        // Marca el movimiento como aplicado al domiciliario para poder revertirlo al
        // eliminarlo: comisión = debtApplied − bases enlazadas (ver revertDriverApplication).
        noCounterpart: true,
        debtApplied: amount,
        description: `${bankTx.description} · Aplicado a ${driver.name}: ${partes.join(" + ")}${closedDay ? ` (el ${toBogotaDateStr(bookedAt)})` : ""}`,
      },
    });
  });

  const final = await prisma.driver.findUniqueOrThrow({ where: { id: driverId }, select: { pendingDebt: true, creditAmount: true, creditMedium: true } });
  return { applied: amount, baseAlloc, commissionAlloc, previousDebt: driver.pendingDebt, newDebt: final.pendingDebt, creditAmount: final.creditAmount ?? 0, creditMedium: final.creditMedium, basePendingBefore: basePending };

  });
}

/**
 * Revierte el efecto de un BankTransaction aplicado a un domiciliario. `debtApplied` guarda
 * el TOTAL aplicado (comisión + base) desde siempre; la parte de base vive en las
 * BaseTransaction enlazadas por `bankTransactionId` (que el borrado elimina en cascada y así
 * restaura el libro de base). Por eso la cuenta de comisiones se revierte solo por
 * `debtApplied − Σ bases enlazadas`. Vale para registros anteriores y posteriores a F14, y
 * para el egreso que pagó un crédito (debtApplied < 0, sin bases enlazadas).
 * Debe llamarse ANTES de borrar el movimiento (necesita sus bases enlazadas).
 */
export async function revertDriverApplication(tx: Prisma.TransactionClient, row: { id: string; driverId: string | null; debtApplied: number }) {
  if (!row.driverId || row.debtApplied === 0) return;
  const linkedBase = (await tx.baseTransaction.aggregate({ where: { bankTransactionId: row.id }, _sum: { amount: true } }))._sum.amount ?? 0;
  await applyDebtDelta(tx, row.driverId, row.debtApplied - linkedBase);
}

export async function payCredit(
  driverId: string,
  medium: "cash" | "bank",
  actor?: ActorLike
) {
  return moneyTransaction(async () => {
  await assertOpenInstant(undefined, "El pago del crédito");
  if (medium !== "cash" && medium !== "bank") throw badRequest("Medio inválido");
  const driver = await prisma.driver.findUnique({ where: { id: driverId } });
  if (!driver) throw notFound("Domiciliario no encontrado");
  await assertOpenInstant(undefined, "El pago del crédito", driver.branchId);
  const creditAmount = driver.creditAmount ?? 0;
  if (creditAmount <= 0) throw badRequest("Este domiciliario no tiene crédito pendiente");
  const recordedAt = await moneyNow(); // NEW02: el dinero cuenta en el día operativo (caja abierta), no según el reloj.

  await prisma.$transaction(async (tx) => {
    // Egreso de la empresa hacia el domiciliario.
    // debtApplied = -creditAmount: MARCA de reversión. Este egreso SUBE la posición neta del
    // domiciliario en `creditAmount` (paga el crédito: creditAmount → 0). Al eliminarlo, remove()
    // / edit-request revierten con `net + debtApplied`, restaurando el crédito. Sin esta marca,
    // borrar el pago del crédito NO devolvía la deuda a favor del domiciliario (bug real: al
    // eliminar el egreso de pago-crédito el crédito quedaba en cero y luego el ingreso original
    // revertía sobre cero → deuda fantasma). Es NEGATIVO a propósito (egreso que pagó crédito),
    // opuesto al ingreso que descuenta deuda (debtApplied > 0).
    await tx.bankTransaction.create({
      data: {
        type: "egreso",
        date: recordedAt,
        medium,
        amount: creditAmount,
        description: `Pago a domiciliario ${driver.name}`,
        driverId,
        driverName: driver.name,
        debtApplied: -creditAmount,
        createdBy: actor?.id ?? null,
        createdByName: actor?.name ?? null,
        deviceId: actor?.deviceId ?? null,
        deviceName: actor?.deviceName ?? null,
      },
    });
    // Cerrar el crédito
    await tx.driver.update({
      where: { id: driverId },
      data: { creditAmount: 0, creditMedium: null },
    });
  });

  return { paid: creditAmount, medium, driverName: driver.name };

  });
}

export async function getOrdersToday(branchId?: string, date?: string) {
  // Ventana del día en zona Bogotá, sin depender de la TZ del proceso Node.
  const { gte, lte } = bogotaDayRange(date ?? todayBogota());
  const where: Record<string, unknown> = {
    status: DELIVERED_FILTER,
    deliveredAt: { gte, lte },
  };
  if (branchId) where.branchId = branchId;
  return prisma.shipdayOrder.findMany({
    where,
    include: {
      driver: { select: { id: true, name: true } },
      branch: { select: { id: true, name: true } },
    },
    orderBy: { deliveredAt: "desc" },
  });
}
