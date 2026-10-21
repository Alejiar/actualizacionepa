import { basePendingByDriver } from "../lib/base-balance";
import { prisma } from "../lib/prisma";
import * as bankSvc from "./bank-transaction.service";
import * as shiftSvc from "./shift-close.service";
import { bogotaDayRange as dateRange, bogotaMonthRange as monthRange, todayBogota, toBogotaDateStr } from "../lib/date-range";
import { isBankLinkedPaymentNote, isBankLinkedBaseNote } from "../lib/balance-markers";
import { movementEffectiveAt } from "../lib/period-guard";

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

/** Saldo "crudo" al final de un día: todo lo registrado con fecha ≤ ese día, sin congelar su
 * Cierre. Sirve para medir el efecto de una corrección aprobada sobre un día cerrado (D7). */
export async function getRawExpectedEndOfDay(date: string) {
  return getExpectedBalances(date, dateRange(date), { raw: true });
}

/** D7: suma de correcciones aprobadas DESPUÉS del cierre `closedAt`, de días ≤ `date`. */
async function correctionsAfter(date: string, closedAt: Date) {
  const rows = await prisma.shiftClose.findMany({
    where: { shift: "close", date: { lte: date }, NOT: { corrections: { equals: [] } } },
    select: { corrections: true },
  });
  let cash = 0, bank = 0;
  for (const r of rows) {
    for (const c of (r.corrections as Array<{ cashDelta?: number; bankDelta?: number; approvedAt?: string }>) ?? []) {
      if (c.approvedAt && new Date(c.approvedAt).getTime() > closedAt.getTime()) { cash += c.cashDelta ?? 0; bank += c.bankDelta ?? 0; }
    }
  }
  return { cash, bank };
}

async function getExpectedBalances(today: string, todayRange: { gte: Date; lte: Date }, opts: { raw?: boolean } = {}) {
  const dayClose = opts.raw ? null : await prisma.shiftClose.findUnique({
    where: { date_shift: { date: today, shift: "close" } },
    select: { closedAt: true, totalExpected: true, bankExpected: true },
  });
  // Una consulta histórica cerrada conserva el corte registrado. Un cierre mensual
  // posterior del mismo día no puede sustituir su capital ni su esperado guardado.
  const cutoff = dayClose && dayClose.closedAt < todayRange.lte ? dayClose.closedAt : todayRange.lte;
  // ANCLA = ÚLTIMO CIERRE: un cierre de mes es un punto de reinicio. El período
  // actual arranca con el capital definido en ese cierre y va sumando TODOS los
  // flujos registrados DESPUÉS del mes cerrado. Si no hay cierres, arranca con el
  // capital configurado (Settings) desde el inicio del mes calendario.
  const settings = await prisma.settings.findUnique({ where: { id: "singleton" } });
  // ANCLA HISTÓRICA: solo cierres registrados hasta el final del día consultado. Antes se
  // tomaba SIEMPRE el último cierre, y consultar un día anterior a él devolvía el capital
  // nuevo (un cierre posterior reescribía el pasado).
  const closes = await prisma.monthlyClose.findMany({
    where: { branchId: null },
    orderBy: { closedAt: "asc" },
    select: { closedAt: true, initialCash: true, initialBank: true, snapshot: true },
  });
  const anchor = [...closes].reverse().find(c => c.closedAt.getTime() <= cutoff.getTime());

  // periodStart = MOMENTO del cierre ancla. Sin ancla (fecha anterior a todo cierre, o sin
  // cierres): capital vigente ANTES del primer cierre, desde el inicio del mes consultado.
  let baseCash: number;
  let baseBank: number;
  let periodStart: Date;
  if (anchor) {
    baseCash = anchor.initialCash ?? settings?.initialCash ?? 0;
    baseBank = anchor.initialBank ?? settings?.initialBank ?? 0;
    periodStart = anchor.closedAt;
  } else {
    // El primer cierre posterior guarda en su snapshot el capital que reemplazó
    // (`capitalAnterior`). Los cierres antiguos no lo tienen: entonces solo queda
    // Settings (puede ya reflejar un capital posterior; ver CLAUDE_CORRECCION_12_DEFECTOS.md).
    const prev = (closes[0]?.snapshot as { capitalAnterior?: { cash: number; bank: number } } | null)?.capitalAnterior;
    baseCash = prev?.cash ?? settings?.initialCash ?? 0;
    baseBank = prev?.bank ?? settings?.initialBank ?? 0;
    // NEW11: el capital de Configuración rige desde la instalación (no puede cambiarse tras el primer
    // Cierre de caja), así que sin cierre de mes cuenta TODO lo registrado. Antes arrancaba en el
    // día 1 del mes consultado: si un mes aún no se había cerrado, el día 1 la caja "olvidaba" todo
    // el mes anterior (simulación de un mes: 1-oct esperado 127.000 con 226.000 en caja).
    periodStart = new Date(0);
  }
  const cumRange = { gte: periodStart, lte: cutoff };

  const [movementRows, bankTxs, convs, driverPayments, bases, clientPays, clientDebtsOut] = await Promise.all([
    // Caja: por FECHA OPERATIVA (movementEffectiveAt), la misma que usan el Historial y
    // los reportes. Antes se filtraba por createdAt y un movimiento retroactivo afectaba
    // el saldo de otro día.
    prisma.movement.findMany({
      where: { status: "confirmed", date: { gte: toBogotaDateStr(periodStart), lte: today } },
      select: { type: true, medium: true, amount: true, date: true, createdAt: true },
    }),
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
  const movements = movementRows.filter(m => {
    const t = movementEffectiveAt(m).getTime();
    return t > periodStart.getTime() && t <= cutoff.getTime();
  });

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

  if (!dayClose) return { cash: baseCash, bank: baseBank };
  // Día cerrado: conserva el esperado registrado en su Cierre (su conteo nunca cambia) y suma las
  // correcciones aprobadas DESPUÉS de ese cierre sobre días ≤ este (D7). Así el cierre de un día
  // corregido sigue siendo la apertura del siguiente y la cadena del Historial cuadra.
  const corr = await correctionsAfter(today, dayClose.closedAt);
  return {
    cash: dayClose.totalExpected + corr.cash,
    bank: dayClose.bankExpected != null ? dayClose.bankExpected + corr.bank : baseBank,
  };
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
    // F14: comisiones y bases son cuentas separadas; `combined` es solo informativo.
    debts: await (async () => {
      const bases = await basePendingByDriver(prisma, branchId ? { branchId } : {});
      const baseTotal = [...bases.values()].reduce((t, v) => t + v, 0);
      const baseDrivers = [...bases.values()].filter(v => v > 0).length;
      const commission = pendingDebts._sum.pendingDebt ?? 0;
      return { totalAmount: commission, driverCount: pendingDebts._count.id, commission, basesPending: baseTotal, baseDriverCount: baseDrivers, combined: commission + baseTotal };
    })(),
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
  // F14: "deben" = deuda por comisiones o base sin devolver (cuentas separadas, sin
  // compensarse con el crédito); un domiciliario con base y crédito aparece en ambas listas.
  const bases = await basePendingByDriver(prisma, branchFilter);
  const withBase = [...bases.entries()].filter(([, v]) => v > 0).map(([id]) => id);
  const [debtorRows, creditorRows] = await Promise.all([
    prisma.driver.findMany({
      where: { ...branchFilter, OR: [{ pendingDebt: { gt: 0 } }, { id: { in: withBase } }] },
      include,
    }),
    prisma.driver.findMany({
      where: { ...branchFilter, creditAmount: { gt: 0 } },
      include,
      orderBy: [{ creditAmount: "desc" }, { name: "asc" }],
    }),
  ]);
  const enrich = <T extends { id: string; pendingDebt: number; creditAmount: number | null }>(d: T) => {
    const basePending = bases.get(d.id) ?? 0;
    return { ...d, commissionDebt: d.pendingDebt, basePending, totalInformativo: d.pendingDebt + basePending - (d.creditAmount ?? 0) };
  };
  const debtors = debtorRows.map(enrich).sort((a, b) => (b.pendingDebt + b.basePending) - (a.pendingDebt + a.basePending) || a.name.localeCompare(b.name));
  return { debtors, creditors: creditorRows.map(enrich) };
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
