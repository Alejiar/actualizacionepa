import type { Prisma } from "@prisma/client";
import { prisma, moneyTransaction } from "../lib/prisma";
import { assertOpenInstant, financialNow } from "../lib/period-guard";
import { badRequest, notFound } from "../lib/errors";
import { bogotaDayRange, todayBogota } from "../lib/date-range";
import { BANK_LINKED_PAYMENT_NOTE, bankLinkedBaseNote } from "../lib/balance-markers";
import { reconcileBasePending } from "../lib/base-balance";

// Usuario + equipo (PC) que hace la acción. Compatible con lo que devuelve getActor(req).
type ActorLike = { id?: string | null; name?: string | null; deviceId?: string | null; deviceName?: string | null };

/**
 * Aplica un cambio en la cuenta de un domiciliario manteniendo SIEMPRE el
 * invariante de que deuda y crédito NO sean ambos positivos a la vez.
 *
 * La verdad única es el neto = pendingDebt − creditAmount:
 *   delta > 0  → debe más (comisión de un pedido, base entregada)
 *   delta < 0  → se le debe más / paga (devolución de base, pago)
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
      ],
    },
    include: { branch: { select: { id: true, name: true } } },
    orderBy: { name: "asc" },
  });

  // Base pendiente CONCILIADA con la deuda neta, por domiciliario. Es la FUENTE ÚNICA que usa
  // el módulo de Bases para el estado "Debe base / Cuadrado", de modo que coincida siempre con
  // Deudas/Domiciliarios/Reportes (todos derivan de la posición neta). Ver lib/base-balance.
  const ledger = drivers.length
    ? await prisma.baseTransaction.groupBy({
        by: ["driverId", "type"],
        _sum: { amount: true },
        where: { driverId: { in: drivers.map(d => d.id) } },
      })
    : [];
  const ledgerByDriver = new Map<string, number>();
  for (const row of ledger) {
    const cur = ledgerByDriver.get(row.driverId) ?? 0;
    const amt = row._sum.amount ?? 0;
    ledgerByDriver.set(row.driverId, cur + (row.type === "entrega" ? amt : -amt));
  }
  return drivers.map(d => ({
    ...d,
    basePending: reconcileBasePending(ledgerByDriver.get(d.id) ?? 0, d.pendingDebt),
  }));
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
  return driver;
}

export async function registerPayment(driverId: string, amount: number, medium: "cash" | "bank", notes?: string, actor?: ActorLike) {
  return moneyTransaction(async () => {
  await assertOpenInstant(undefined, "El pago del domiciliario");
  if (!Number.isSafeInteger(amount) || amount <= 0) throw badRequest("Monto inválido");
  if (medium !== "cash" && medium !== "bank") throw badRequest("Medio de pago inválido (cash o bank)");
  const driver = await prisma.driver.findUnique({ where: { id: driverId } });
  if (!driver) throw notFound("Domiciliario no encontrado");
  await assertOpenInstant(undefined, "El pago del domiciliario", driver.branchId);

  // Saldo de base pendiente vía aggregate (no carga todas las filas)
  const [givenAgg, paidAgg] = await Promise.all([
    prisma.baseTransaction.aggregate({ where: { driverId, type: "entrega" }, _sum: { amount: true } }),
    prisma.baseTransaction.aggregate({ where: { driverId, type: "pago" }, _sum: { amount: true } }),
  ]);
  const basesGiven = givenAgg._sum.amount ?? 0;
  const basesPaid = paidAgg._sum.amount ?? 0;
  const basePending = reconcileBasePending(basesGiven - basesPaid, driver.pendingDebt);

  // Asignación: primero a base, el resto a comisión
  const baseAlloc = Math.min(amount, basePending);
  const commissionAlloc = amount - baseAlloc;

  // Registra UN solo movimiento (bankTransaction) como registro autoritativo de display y saldo.
  const recordedAt = await financialNow();
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

    // Deuda del domiciliario
    const newDebt = Math.max(0, driver.pendingDebt - amount);
    const excess = Math.max(0, amount - driver.pendingDebt);
    const newCredit = (driver.creditAmount ?? 0) + excess;
    await tx.driver.update({
      where: { id: driverId },
      data: {
        pendingDebt: newDebt,
        ...(excess > 0 ? { creditAmount: newCredit, creditMedium: medium } : {}),
      },
    });
  });

  const excess = Math.max(0, amount - driver.pendingDebt);
  const newCredit = (driver.creditAmount ?? 0) + excess;
  return { payment, baseAlloc, commissionAlloc, basePendingBefore: basePending, excess, creditAmount: excess > 0 ? newCredit : 0 };

  });
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
  for (const b of bases) events.push({ t: b.date.getTime(), delta: b.type === "entrega" ? b.amount : -b.amount });
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
  actor?: ActorLike
) {
  return moneyTransaction(async () => {
  const [bankTx, driver] = await Promise.all([
    prisma.bankTransaction.findUnique({ where: { id: bankTxId } }),
    prisma.driver.findUnique({ where: { id: driverId } }),
  ]);
  if (!bankTx) throw notFound("Movimiento bancario no encontrado");
  await assertOpenInstant(bankTx.date, "La aplicación del ingreso a deuda");
  if (!driver) throw notFound("Domiciliario no encontrado");
  await assertOpenInstant(bankTx.date, "La aplicación del ingreso a deuda", driver.branchId);

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
  if (bankTx.debtApplied > 0) {
    throw badRequest("Este movimiento ya fue descontado de la deuda de un domiciliario.");
  }

  const amount = bankTx.amount;
  const medium = (bankTx.medium ?? "bank") as "cash" | "bank";
  const previousDebt = driver.pendingDebt;
  const previousCredit = driver.creditAmount ?? 0;

  // Si el domiciliario ya tiene crédito (empresa le debe), sumar al crédito
  if (previousDebt <= 0 && previousCredit > 0) {
    const newCredit = previousCredit + amount;
    await prisma.$transaction([
      prisma.driver.update({
        where: { id: driverId },
        data: { creditAmount: newCredit, creditMedium: medium },
      }),
      prisma.bankTransaction.update({
        where: { id: bankTxId },
        data: {
          driverId,
          driverName: driver.name,
          // noCounterpart: marca este movimiento como "aplicado a la deuda/crédito del
          // domiciliario", para que al eliminarlo se revierta ese efecto (igual que
          // registerPayment). Sin esto, borrar el movimiento dejaba el crédito fantasma.
          noCounterpart: true,
          // Sube el crédito en `amount` = baja la posición neta en `amount`.
          debtApplied: amount,
          description: `${bankTx.description} · Abonado al crédito de ${driver.name} (${formatCOP(amount)})`,
        },
      }),
    ]);
    return { applied: amount, previousDebt: 0, newDebt: 0, creditAmount: newCredit, creditMedium: medium, excess: newCredit };
  }

  // Caso normal: descontar del pendingDebt
  const applied = Math.min(amount, previousDebt);
  const excess = amount - previousDebt; // positivo = empresa queda debiendo

  await prisma.$transaction(async (tx) => {
    // Registrar el pago para que quede en el historial del domiciliario
    const [givenAgg, paidAgg] = await Promise.all([
      tx.baseTransaction.aggregate({ where: { driverId, type: "entrega" }, _sum: { amount: true } }),
      tx.baseTransaction.aggregate({ where: { driverId, type: "pago" }, _sum: { amount: true } }),
    ]);
    const basePending = reconcileBasePending((givenAgg._sum.amount ?? 0) - (paidAgg._sum.amount ?? 0), driver.pendingDebt);
    const baseAlloc = Math.min(applied, basePending);
    const commissionAlloc = applied - baseAlloc;

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
          date: bankTx.date,
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
          date: bankTx.date,
        },
      });
    }

    const newDebt = Math.max(0, previousDebt - amount);
    const newCredit = excess > 0 ? excess : 0;

    await tx.driver.update({
      where: { id: driverId },
      data: {
        pendingDebt: newDebt,
        creditAmount: newCredit,
        creditMedium: newCredit > 0 ? medium : null,
      },
    });

    // Dejar escrito en la descripción del movimiento QUÉ se descontó y a quién.
    const partes: string[] = [];
    if (baseAlloc > 0) partes.push(`base ${formatCOP(baseAlloc)}`);
    if (commissionAlloc > 0) partes.push(`comisión ${formatCOP(commissionAlloc)}`);
    const detalle = partes.length ? `: ${partes.join(" + ")}` : "";
    const sobrante = excess > 0 ? ` · sobrante a crédito ${formatCOP(excess)}` : "";
    await tx.bankTransaction.update({
      where: { id: bankTxId },
      data: {
        driverId,
        driverName: driver.name,
        // Ver nota en la rama de crédito: marca el movimiento como aplicado a la
        // deuda del domiciliario para poder revertirlo al eliminarlo.
        noCounterpart: true,
        // La posición neta bajó en `amount` completo (parte a deuda, sobrante a crédito).
        debtApplied: amount,
        description: `${bankTx.description} · Descontado de la deuda de ${driver.name}${detalle}${sobrante}`,
      },
    });
  });

  const newDebt = Math.max(0, previousDebt - amount);
  const creditAmount = excess > 0 ? excess : 0;
  return { applied, previousDebt, newDebt, creditAmount, creditMedium: creditAmount > 0 ? medium : null, excess };

  });
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
  const recordedAt = await financialNow();

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
