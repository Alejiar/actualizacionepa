import { prisma } from "../lib/prisma";
import * as bankSvc from "./bank-transaction.service";
import * as shiftSvc from "./shift-close.service";
import { bogotaDayRange as dateRange, bogotaMonthRange as monthRange, todayBogota } from "../lib/date-range";
import { isBankLinkedPaymentNote, isBankLinkedBaseNote } from "../lib/balance-markers";

export async function getDashboardFull(branchId?: string, date?: string) {
  const day = date ?? todayBogota();
  const dayRange = dateRange(day);

  const [shipday, dayShifts, bankSummary, topClientDebtors, expectedBalances] = await Promise.all([
    getDashboard(branchId, day),
    shiftSvc.getShiftsForDate(day),
    bankSvc.summary(day, day),
    prisma.client.findMany({
      where: { pendingDebt: { gt: 0 }, active: true },
      orderBy: { pendingDebt: "desc" },
      take: 3,
      select: { id: true, name: true, phone: true, pendingDebt: true },
    }),
    // Saldos esperados en caja y banco acumulados hasta el final del día elegido
    getExpectedBalances(day, dayRange),
  ]);

  const shiftsMap = { AM: false, PM: false, close: false } as Record<string, boolean>;
  for (const s of dayShifts) { shiftsMap[s.shift] = true; }

  return {
    ...shipday,
    caja: {
      shifts: dayShifts,
      shiftsStatus: { AM: shiftsMap.AM, PM: shiftsMap.PM, close: shiftsMap.close },
      bankToday: bankSummary,
      expectedCash: expectedBalances.cash,
      expectedBank: expectedBalances.bank,
    },
    topClientDebtors,
  };
}

/**
 * Calcula el efectivo y banco ESPERADOS para una fecha (YYYY-MM-DD),
 * usado por los cierres de turno automáticos (#6). El usuario solo verifica.
 */
export async function getExpectedBalancesForDate(date: string) {
  const { gte, lte } = dateRange(date);
  return getExpectedBalances(date, { gte, lte });
}

async function getExpectedBalances(today: string, todayRange: { gte: Date; lte: Date }) {
  // ANCLA = ÚLTIMO CIERRE: un cierre de mes es un punto de reinicio. El período
  // actual arranca con el capital definido en ese cierre y va sumando TODOS los
  // flujos registrados DESPUÉS del mes cerrado. Si no hay cierres, arranca con el
  // capital configurado (Settings) desde el inicio del mes calendario.
  const settings = await prisma.settings.findUnique({ where: { id: "singleton" } });
  const lastClose = await prisma.monthlyClose.findFirst({
    where: { branchId: null },
    orderBy: { month: "desc" },
  });

  // periodStart = MOMENTO del último cierre (no el mes siguiente). Así, apenas cierras,
  // el saldo arranca con el capital del cierre, y CADA movimiento que registras después
  // (aunque sea el mismo día/mes) se suma de inmediato. Sin cierres: inicio del mes actual.
  let baseCash: number;
  let baseBank: number;
  let periodStart: Date;
  if (lastClose) {
    baseCash = lastClose.initialCash ?? settings?.initialCash ?? 0;
    baseBank = lastClose.initialBank ?? settings?.initialBank ?? 0;
    periodStart = lastClose.closedAt;
  } else {
    baseCash = settings?.initialCash ?? 0;
    baseBank = settings?.initialBank ?? 0;
    periodStart = monthRange(today.slice(0, 7)).gte;
  }
  const cumRange = { gte: periodStart, lte: todayRange.lte };

  const [movements, bankTxs, convs, driverPayments, bases, clientPays, clientDebtsOut] = await Promise.all([
    // Caja: se cuentan los movimientos REGISTRADOS después del cierre (por createdAt).
    prisma.movement.findMany({ where: { createdAt: cumRange, status: "confirmed" }, select: { type: true, medium: true, amount: true } }),
    prisma.bankTransaction.findMany({ where: { date: cumRange }, select: { type: true, medium: true, amount: true } }),
    prisma.conversion.findMany({ where: { date: cumRange }, select: { type: true, amount: true } }),
    prisma.driverPayment.findMany({ where: { date: cumRange }, select: { medium: true, amount: true, notes: true } }),
    prisma.baseTransaction.findMany({ where: { date: cumRange }, select: { type: true, cashAmount: true, bankAmount: true, amount: true, notes: true } }),
    prisma.clientDebtPayment.findMany({ where: { paidAt: cumRange }, select: { paidCash: true, paidBank: true } }),
    // Deudas creadas en el período que SÍ desembolsaron dinero (préstamo/adelanto):
    // el dinero salió del medio elegido al crearlas. Se descuenta aquí; el reingreso
    // al cobrar ya lo cubre `clientPays` (paidCash/paidBank).
    prisma.clientDebt.findMany({ where: { createdAt: cumRange, medium: { not: null } }, select: { amount: true, medium: true } }),
  ]);

  // Gastos/nómina del sistema original (solo confirmados)
  for (const m of movements) {
    const sign = m.type === "ingreso" ? 1 : -1;
    if (m.medium === "cash") baseCash += sign * m.amount;
    else baseBank += sign * m.amount;
  }
  // Banco: ahora cada movimiento tiene medio (efectivo/transferencia)
  for (const t of bankTxs) {
    const sign = t.type === "ingreso" ? 1 : -1;
    if (t.medium === "cash") baseCash += sign * t.amount;
    else baseBank += sign * t.amount;
  }
  // Conversiones antiguas (compatibilidad histórica)
  for (const c of convs) {
    if (c.type === "banco_a_efectivo") { baseBank -= c.amount; baseCash += c.amount; }
    else { baseCash -= c.amount; baseBank += c.amount; }
  }
  // Pagos de comisión de domiciliarios: dinero que entra.
  // EXCEPTO los pagos que son contraparte de un movimiento bancario ya contado
  // (applyBankToDriver): ese dinero entró por el BankTransaction, contarlo aquí
  // otra vez infla el saldo (era la causa del doble conteo en banco).
  for (const p of driverPayments) {
    if (isBankLinkedPaymentNote(p.notes)) continue;
    if (p.medium === "cash") baseCash += p.amount;
    else baseBank += p.amount;
  }
  // Bases: split efectivo/transferencia. Entrega sale, devolución vuelve.
  // Igual que arriba: las "pago" generadas al descontar de un movimiento bancario
  // ya están contadas por ese BankTransaction → se excluyen del saldo.
  for (const b of bases) {
    if (b.type === "pago" && isBankLinkedBaseNote(b.notes)) continue;
    const cash = b.cashAmount || (b.bankAmount ? 0 : b.amount); // fallback a efectivo si no hay split
    const bank = b.bankAmount;
    if (b.type === "entrega") { baseCash -= cash; baseBank -= bank; }
    else { baseCash += cash; baseBank += bank; }
  }
  // Cobros de deudas de clientes: según el medio del abono
  for (const cp of clientPays) {
    baseCash += cp.paidCash;
    baseBank += cp.paidBank;
  }
  // Desembolso al CREAR una deuda con medio (préstamo): el dinero sale de ese medio.
  for (const d of clientDebtsOut) {
    if (d.medium === "cash") baseCash -= d.amount;
    else if (d.medium === "bank") baseBank -= d.amount;
  }

  return { cash: baseCash, bank: baseBank };
}

export async function getDashboard(branchId?: string, date?: string) {
  const day = date ?? todayBogota();
  const month = day.slice(0, 7);

  const branchWhere = branchId ? { branchId } : {};

  const DELIVERED_STATUS = { in: ["DELIVERED", "COMPLETED"] };

  const [
    totalDrivers,
    activeDrivers,
    todayStats,         // Ahora directo desde ShipdayOrder — mismo origen que la página de pedidos
    monthStats,
    pendingDebts,
    recentOrders,
    branches,
  ] = await Promise.all([
    prisma.driver.count({ where: { ...branchWhere } }),
    prisma.driver.count({ where: { ...branchWhere, active: true } }),
    // Usar ShipdayOrder directamente (misma fuente que /pedidos) — evita desincronización con DailyDriverStat
    prisma.shipdayOrder.aggregate({
      where: { ...branchWhere, status: DELIVERED_STATUS, deliveredAt: dateRange(day) },
      _sum: { deliveryValue: true, companyAmount: true },
      _count: { id: true },
    }),
    prisma.shipdayOrder.aggregate({
      where: { ...branchWhere, status: DELIVERED_STATUS, deliveredAt: monthRange(month) },
      _sum: { deliveryValue: true, companyAmount: true },
      _count: { id: true },
    }),
    prisma.driver.aggregate({
      where: { ...branchWhere, pendingDebt: { gt: 0 } },
      _sum: { pendingDebt: true },
      _count: { id: true },
    }),
    prisma.shipdayOrder.findMany({
      where: { ...branchWhere, status: { in: ["DELIVERED", "COMPLETED"] } },
      orderBy: { deliveredAt: "desc" },
      take: 10,
      include: {
        driver: { select: { id: true, name: true } },
        branch: { select: { id: true, name: true } },
      },
    }),
    prisma.branch.findMany({ where: { active: true }, select: { id: true, name: true, syncStatus: true, lastSyncAt: true } }),
  ]);

  return {
    today: {
      orders: todayStats._count.id,             // conteo directo desde ShipdayOrder
      value: todayStats._sum.deliveryValue ?? 0,
      company: todayStats._sum.companyAmount ?? 0,
    },
    month: {
      orders: monthStats._count.id,
      value: monthStats._sum.deliveryValue ?? 0,
      company: monthStats._sum.companyAmount ?? 0,
    },
    drivers: { total: totalDrivers, active: activeDrivers },
    debts: {
      totalAmount: pendingDebts._sum.pendingDebt ?? 0,
      driverCount: pendingDebts._count.id,
    },
    recentOrders,
    branches,
  };
}

export async function getDailyStats(date: string, branchId?: string) {
  const where = branchId ? { date, branchId } : { date };
  return prisma.dailyDriverStat.findMany({
    where,
    include: {
      driver: { select: { id: true, name: true } },
      branch: { select: { id: true, name: true } },
    },
    orderBy: { orderCount: "desc" },
  });
}

export async function getDebtsDashboard(branchId?: string) {
  const branchFilter = branchId ? { branchId } : {};
  const include = {
    branch: { select: { id: true, name: true } },
    orders: { orderBy: { deliveredAt: "desc" } as const, take: 5 },
    bases: { where: { type: "entrega" as const }, orderBy: { date: "desc" } as const, take: 20 },
  };
  const [debtors, creditors] = await Promise.all([
    prisma.driver.findMany({
      where: { ...branchFilter, pendingDebt: { gt: 0 } },
      include,
      orderBy: [{ pendingDebt: "desc" }, { name: "asc" }],

    }),
    prisma.driver.findMany({
      where: { ...branchFilter, pendingDebt: 0, creditAmount: { gt: 0 } },
      include,
      orderBy: [{ creditAmount: "desc" }, { name: "asc" }],

    }),
  ]);
  return { debtors, creditors };
}

const DELIVERED = { in: ["DELIVERED", "COMPLETED"] };

export async function getOrdersByBranch(branchId: string, from?: string, to?: string) {
  const where: Record<string, unknown> = { branchId, status: DELIVERED };
  if (from || to) {
    where.deliveredAt = {};
    if (from) (where.deliveredAt as Record<string, Date>).gte = dateRange(from).gte;
    if (to) (where.deliveredAt as Record<string, Date>).lte = dateRange(to).lte;
  }
  return prisma.shipdayOrder.findMany({
    where,
    include: { driver: { select: { id: true, name: true } } },
    orderBy: { deliveredAt: "desc" },
    take: 300,
  });
}
