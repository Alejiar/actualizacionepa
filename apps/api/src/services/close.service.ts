import { assertMoney } from "../lib/money-validation";
import { prisma, moneyTransaction } from "../lib/prisma";
import { conflict } from "../lib/errors";
import { bogotaMonthRange as monthRange } from "../lib/date-range";
import { reconcileBasePending } from "../lib/base-balance";

/**
 * Reporte mensual con la lógica del Excel.
 * Total Ventas = comisión de la empresa (companyAmount de pedidos del mes).
 * Indicadores que deben cuadrar devuelven el valor exacto y el detalle del descuadre.
 */
export async function getMonthlyReport(month: string, branchId?: string) {
  const range = monthRange(month);
  const monthPrefix = month; // "YYYY-MM"
  const orderWhere = branchId
    ? { branchId, status: { in: ["DELIVERED", "COMPLETED"] }, deliveredAt: range }
    : { status: { in: ["DELIVERED", "COMPLETED"] }, deliveredAt: range };
  const baseWhere = branchId ? { branchId, date: range } : { date: range };

  const [
    ventasAgg,
    gastosEfAgg, gastosBkAgg,
    nominaEfAgg, nominaBkAgg,
    basesGivenAgg, basesPaidAgg,
    bankIngAgg, bankEgrAgg,
    debtsGenAgg, debtsPaidAgg,
    driversWithBase,
    clientsWithDebt,
    normalDebtAgg, hourlyDebtAgg, hourlyClientsWithDebt,
  ] = await Promise.all([
    prisma.shipdayOrder.aggregate({ where: orderWhere, _sum: { companyAmount: true } }),
    prisma.movement.aggregate({ where: { category: 3, status: "confirmed", date: { startsWith: monthPrefix } }, _sum: { amount: true } }),
    prisma.movement.aggregate({ where: { category: 4, status: "confirmed", date: { startsWith: monthPrefix } }, _sum: { amount: true } }),
    prisma.movement.aggregate({ where: { category: 15, status: "confirmed", date: { startsWith: monthPrefix } }, _sum: { amount: true } }),
    prisma.movement.aggregate({ where: { category: { in: [16, 18] }, status: "confirmed", date: { startsWith: monthPrefix } }, _sum: { amount: true } }),
    prisma.baseTransaction.aggregate({ where: { ...baseWhere, type: "entrega" }, _sum: { amount: true } }),
    prisma.baseTransaction.aggregate({ where: { ...baseWhere, type: "pago" }, _sum: { amount: true } }),
    // Solo movimientos que NECESITAN contraparte (noCounterpart=false) y AÚN no están
    // cuadrados (pairId=null). Los marcados "sin contraparte" son correctos y NO entran;
    // los ya enlazados a su contraparte tampoco. (Se excluyen los asignados a domiciliario.)
    prisma.bankTransaction.aggregate({ where: { type: "ingreso", date: range, driverId: null, noCounterpart: false, pairId: null }, _sum: { amount: true } }),
    prisma.bankTransaction.aggregate({ where: { type: "egreso", date: range, driverId: null, noCounterpart: false, pairId: null }, _sum: { amount: true } }),
    prisma.clientDebt.aggregate({ where: { createdAt: range }, _sum: { amount: true } }),
    prisma.clientDebtPayment.aggregate({ where: { paidAt: range }, _sum: { paidAmount: true } }),
    // Saldo de BASE por domiciliario (entrega − pago), NO la deuda total (que incluye comisiones de domicilios)
    prisma.baseTransaction.groupBy({
      by: ["driverId", "type"],
      _sum: { amount: true },
      where: branchId ? { branchId } : {},
    }),
    prisma.client.findMany({ where: { pendingDebt: { gt: 0 } }, select: { id: true, name: true, pendingDebt: true }, orderBy: { pendingDebt: "desc" }, take: 20 }),
    // Saldo VIVO de deuda de clientes (lo que aún deben AHORA), normal y por hora. Es el número
    // real del indicador "Saldo Deudas Clientes": antes usaba solo el neto del mes de clientes
    // normales (generadas − pagadas) y jamás miraba a los clientes por hora, así que salía en
    // ✅ $0 aunque los clientes por hora debieran. Clientes (normal/hora) son globales (sin branchId).
    prisma.client.aggregate({ where: { pendingDebt: { gt: 0 } }, _sum: { pendingDebt: true } }),
    prisma.hourlyClient.aggregate({ where: { pendingDebt: { gt: 0 } }, _sum: { pendingDebt: true } }),
    prisma.hourlyClient.findMany({ where: { pendingDebt: { gt: 0 } }, select: { id: true, name: true, pendingDebt: true }, orderBy: { pendingDebt: "desc" }, take: 20 }),
  ]);

  // ── BASES: dos alcances con el MISMO criterio (reconcileBasePending contra la deuda neta viva) ──
  // El saldo de base (entrega − pago) es un registro paralelo que puede quedar POR ENCIMA de la
  // deuda neta real (los pagos se reparten entre base y comisión y la deuda tiene piso en 0), así
  // que un domiciliario ya saldado puede conservar un residuo de libro. La verdad única es la
  // posición neta (pendingDebt): quien no debe nada NO debe base → min(saldoBase, deudaNeta).
  //
  // (1) Libro COMPLETO (todos los tiempos). Sirve para: (a) separar "base" de "comisión" dentro de
  //     la deuda neta viva (abajo), y (b) el proyector de cierre, donde "plata física fuera" es
  //     TODA la base sin devolver, no solo la del mes (`diffAllTime`).
  const baseBalanceByDriver = new Map<string, number>();
  for (const row of driversWithBase) {
    const cur = baseBalanceByDriver.get(row.driverId) ?? 0;
    const amt = row._sum.amount ?? 0;
    baseBalanceByDriver.set(row.driverId, cur + (row.type === "entrega" ? amt : -amt));
  }
  // (2) Libro DEL MES seleccionado. Es lo que muestran el indicador "Diferencia Bases", la tarjeta
  //     del cierre y el Excel. Antes el panel usaba el libro COMPLETO, y por eso un mes ya cerrado y
  //     limpio mostraba base pendiente de OTROS meses (incoherente con la tarjeta, que sí es del mes
  //     vía getMonthBasePendingReconciled). Ahora panel/tarjeta/Excel usan el MISMO criterio.
  const monthBaseGrp = await prisma.baseTransaction.groupBy({
    by: ["driverId", "type"], _sum: { amount: true }, where: baseWhere,
  });
  const monthBaseByDriver = new Map<string, number>();
  for (const row of monthBaseGrp) {
    const cur = monthBaseByDriver.get(row.driverId) ?? 0;
    const amt = row._sum.amount ?? 0;
    monthBaseByDriver.set(row.driverId, cur + (row.type === "entrega" ? amt : -amt));
  }
  // Deuda neta viva de todo domiciliario con base > 0 (histórica o del mes), para reconciliar ambos.
  const baseDriverIds = [...new Set([
    ...[...baseBalanceByDriver.entries()].filter(([, b]) => b > 0).map(([id]) => id),
    ...[...monthBaseByDriver.entries()].filter(([, b]) => b > 0).map(([id]) => id),
  ])];
  const baseDriverRows = baseDriverIds.length
    ? await prisma.driver.findMany({ where: { id: { in: baseDriverIds } }, select: { id: true, name: true, pendingDebt: true } })
    : [];
  const netDebtById = new Map(baseDriverRows.map(d => [d.id, d.pendingDebt] as const));
  const nameById = new Map(baseDriverRows.map(d => [d.id, d.name] as const));
  // All-time (para el proyector de cierre). Ledger ≤ 0 reconcilia a 0, así que sumar todos es seguro.
  const basePendingAllTime = [...baseBalanceByDriver.entries()]
    .reduce((s, [id, ledger]) => s + reconcileBasePending(ledger, netDebtById.get(id) ?? 0), 0);
  // Del mes (indicador "Diferencia Bases" + lista de quién debe + Excel).
  const pendingBaseDrivers = [...monthBaseByDriver.entries()]
    .map(([id, ledger]) => ({ id, name: nameById.get(id) ?? "?", pendingDebt: reconcileBasePending(ledger, netDebtById.get(id) ?? 0) }))
    .filter(d => d.pendingDebt > 0)
    .sort((a, b) => b.pendingDebt - a.pendingDebt)
    .slice(0, 20);
  const basePendingReconciled = [...monthBaseByDriver.entries()]
    .reduce((s, [id, ledger]) => s + reconcileBasePending(ledger, netDebtById.get(id) ?? 0), 0);

  // COMISIONES: deuda del domiciliario que NO es base (la comisión que deben por domicilios)
  const driversWithDebt = await prisma.driver.findMany({
    where: { pendingDebt: { gt: 0 }, ...(branchId ? { branchId } : {}) },
    select: { id: true, name: true, pendingDebt: true },
  });
  const pendingCommissionDrivers = driversWithDebt
    .map(d => ({ id: d.id, name: d.name, pendingDebt: d.pendingDebt - Math.max(0, baseBalanceByDriver.get(d.id) ?? 0) }))
    .filter(d => d.pendingDebt > 0)
    .sort((a, b) => b.pendingDebt - a.pendingDebt)
    ;
  const commissionPending = pendingCommissionDrivers.reduce((s, d) => s + d.pendingDebt, 0);
  const totalDriverDebt = driversWithDebt.reduce((s,d) => s+d.pendingDebt,0);
  // Por driver: bases del mes aplicables, remanente histórico y comisión viva.
  const monthlyLiveBase = [...baseBalanceByDriver.entries()].reduce((sum,[id,ledger]) => {
    const all = reconcileBasePending(ledger,netDebtById.get(id) ?? 0);
    return sum+Math.min(all,reconcileBasePending(monthBaseByDriver.get(id) ?? 0,netDebtById.get(id) ?? 0));
  },0);
  const debtReconciliation = { total:totalDriverDebt, basesCurrentMonth:monthlyLiveBase,
    basesPrevious:basePendingAllTime-monthlyLiveBase, basesAllTime:basePendingAllTime, commission:commissionPending };

  const gastosEf = gastosEfAgg._sum.amount ?? 0;
  const gastosBk = gastosBkAgg._sum.amount ?? 0;
  const nominaEf = nominaEfAgg._sum.amount ?? 0;
  const nominaBk = nominaBkAgg._sum.amount ?? 0;
  const basesGiven = basesGivenAgg._sum.amount ?? 0;
  const basesPaid = basesPaidAgg._sum.amount ?? 0;
  // Pares "conciliados" que NO cuadran (registrados antes de validar contrapartes): un
  // pairId no prueba que los importes cuadren. Se reincorporan al indicador pendiente.
  const pairedRows = await prisma.bankTransaction.findMany({
    where: { date: range, driverId: null, noCounterpart: false, pairId: { not: null } },
    select: { id: true, type: true, amount: true, description: true, pairId: true },
  });
  const pairNet = new Map<string, { ing: number; egr: number }>();
  for (const r of pairedRows) {
    const g = pairNet.get(r.pairId!) ?? { ing: 0, egr: 0 };
    if (r.type === "ingreso") g.ing += r.amount; else g.egr += r.amount;
    pairNet.set(r.pairId!, g);
  }
  const brokenPairRows = pairedRows.filter(r => { const g = pairNet.get(r.pairId!)!; return g.ing !== g.egr || g.ing === 0 || g.egr === 0; });
  const bankIng = (bankIngAgg._sum.amount ?? 0) + brokenPairRows.filter(r => r.type === "ingreso").reduce((t, r) => t + r.amount, 0);
  const bankEgr = (bankEgrAgg._sum.amount ?? 0) + brokenPairRows.filter(r => r.type === "egreso").reduce((t, r) => t + r.amount, 0);
  const debtsGen = debtsGenAgg._sum.amount ?? 0;
  const debtsPaid = debtsPaidAgg._sum.paidAmount ?? 0;

  // Movimientos que necesitan contraparte y aún no se han cuadrado (para el detalle del reporte).
  const pendingTransferMovs = await prisma.bankTransaction.findMany({
    where: { date: range, driverId: null, noCounterpart: false, pairId: null },
    select: { id: true, type: true, amount: true, description: true },
    orderBy: { date: "desc" }, take: 20,
  });
  for (const r of brokenPairRows) pendingTransferMovs.push({ id: r.id, type: r.type, amount: r.amount, description: `${r.description} (par que no cuadra)` });
  const transferPendingItems = pendingTransferMovs.map(m => ({
    id: m.id,
    name: `${m.type === "ingreso" ? "📥" : "📤"} ${m.description || (m.type === "ingreso" ? "Ingreso" : "Salida")}`,
    pendingDebt: m.amount,
  }));

  const totalSales = ventasAgg._sum.companyAmount ?? 0;
  const totalExpenses = gastosEf + gastosBk;
  const totalPayroll = nominaEf + nominaBk;
  // Diferencia de bases = base realmente sin devolver, conciliada con la deuda neta de cada
  // domiciliario (NO el residuo bruto entrega−pago del libro, que puede sobrevalorar la base
  // de un domiciliario ya saldado). Así el indicador cuadra con la lista pendingDrivers.
  const basesDiff = basePendingReconciled;           // esperado 0
  const transferDiff = bankIng - bankEgr;            // esperado 0
  // Saldo VIVO de clientes = lo que AÚN deben (normal + por hora), no el neto del mes. Es la
  // plata que está fuera de la caja; el indicador es "cuadrado" (verde) solo si nadie debe.
  const clientDebtNormal = normalDebtAgg._sum.pendingDebt ?? 0;
  const clientDebtHourly = hourlyDebtAgg._sum.pendingDebt ?? 0;
  const clientDebtBalance = clientDebtNormal + clientDebtHourly;
  // Lista de quién debe: normales + por hora (estos con sufijo para distinguirlos), top 20.
  const pendingClients = [
    ...clientsWithDebt.map(c => ({ id: c.id, name: c.name, pendingDebt: c.pendingDebt })),
    ...hourlyClientsWithDebt.map(c => ({ id: c.id, name: `${c.name} (por hora)`, pendingDebt: c.pendingDebt })),
  ].sort((a, b) => b.pendingDebt - a.pendingDebt).slice(0, 20);
  const netProfit = totalSales - totalExpenses - totalPayroll;
  const profitability = totalSales > 0 ? (netProfit / totalSales) * 100 : 0;

  return {
    month,
    debtReconciliation,
    totalSales,
    expenses: { cash: gastosEf, bank: gastosBk, total: totalExpenses },
    payroll: { cash: nominaEf, bank: nominaBk, total: totalPayroll },
    // diff = base sin devolver DEL MES (indicador/tarjeta/Excel, coherente entre sí).
    // diffAllTime = base sin devolver de TODOS los tiempos (solo la usa el proyector de cierre para
    // la plata física realmente fuera). Ver getMonthCloseProjection.
    bases: { given: basesGiven, returned: basesPaid, diff: basesDiff, diffAllTime: basePendingAllTime, ok: basesDiff === 0, pendingDrivers: pendingBaseDrivers },
    commission: { pending: commissionPending, ok: commissionPending === 0, pendingDrivers: pendingCommissionDrivers },
    transfers: { ingresos: bankIng, egresos: bankEgr, diff: transferDiff, ok: pendingTransferMovs.length === 0, pendingItems: transferPendingItems },
    clientDebt: { generated: debtsGen, paid: debtsPaid, balance: clientDebtBalance, normal: clientDebtNormal, hourly: clientDebtHourly, ok: clientDebtBalance === 0, pendingClients },
    netProfit,
    profitability,
  };
}

/**
 * #5 — Recálculo del capital físico a dejar para el próximo mes.
 * El usuario define el capital OBJETIVO (efectivo + banco). Si hay diferencias
 * pendientes o deudas, el dinero físico real a dejar es menor, porque esa plata
 * sigue registrada como pendiente. El operador no tiene que calcularlo a mano.
 */
export async function getMonthCloseProjection(
  month: string,
  targetCash: number,
  targetBank: number,
  branchId?: string,
) {
  const report = await getMonthlyReport(month, branchId);

  const tCash = Math.round(targetCash);
  const tBank = Math.round(targetBank);
  const targetCapital = tCash + tBank;

  // Diferencias pendientes que deben cuadrar (esperado 0 cada una).
  // Base: aquí SÍ se usa el saldo de TODOS los tiempos (diffAllTime), no el del mes: para el capital
  // físico a dejar, TODA la base sin devolver es plata que no está en caja (igual que comisiones y
  // deudas de clientes, que también son saldos vivos totales). El indicador del panel usa diff (mes).
  const basesDiff = report.bases.diffAllTime;
  const transferDiff = report.transfers.diff;
  const commissionPending = report.commission.pending;
  const pendingDiffs = basesDiff + transferDiff + commissionPending;

  // Deudas de clientes pendientes = plata que los clientes AÚN deben y no está en la caja.
  // Es el saldo VIVO actual (igual que bases/comisiones, que usan la deuda neta actual del
  // domiciliario), normal + por hora. Se toma del reporte, que ya lo calcula así (fuente única);
  // antes se usaba el neto "generadas − pagadas" del mes, que ignoraba deudas viejas y a los
  // clientes por hora, así que al cerrar el mes las deudas de clientes no se descontaban.
  const clientDebtsNormal = report.clientDebt.normal;
  const clientDebtsHourly = report.clientDebt.hourly;
  const pendingDebts = report.clientDebt.balance;

  // Atribución del faltante por medio:
  //  - Banco: diferencias de transferencias (movimientos bancarios sin contraparte).
  //  - Efectivo: bases pendientes + comisiones + deudas de clientes (plata física que
  //    drivers/clientes aún tienen y no está en la caja).
  const bankShortfall = transferDiff;
  const cashShortfall = basesDiff + commissionPending + pendingDebts;

  // Capital FÍSICO a dejar, separado por medio.
  const physicalCash = tCash - cashShortfall;
  const physicalBank = tBank - bankShortfall;
  const physicalToLeave = physicalCash + physicalBank;

  return {
    month,
    targetCash: tCash,
    targetBank: tBank,
    targetCapital,
    pending: {
      basesDiff,
      transferDiff,
      commissionPending,
      totalDiffs: pendingDiffs,
      clientDebts: pendingDebts,
      clientDebtsNormal,
      clientDebtsHourly,
      cashShortfall,
      bankShortfall,
      total: pendingDiffs + pendingDebts,
    },
    // Lo que realmente debe quedar físicamente para arrancar el próximo mes:
    physicalCash,
    physicalBank,
    physicalToLeave,
    explanation:
      `Objetivo: ${tCash} efectivo + ${tBank} banco = ${targetCapital}. ` +
      `Falta en efectivo ${cashShortfall} (bases ${basesDiff} + comisiones ${commissionPending} + ` +
      `deudas clientes ${pendingDebts} [normal ${clientDebtsNormal} + por hora ${clientDebtsHourly}]) ` +
      `y en banco ${bankShortfall} (transferencias). ` +
      `Dejar físicamente: ${physicalCash} en efectivo y ${physicalBank} en banco = ${physicalToLeave}.`,
    report,
  };
}

export async function closeMonth(month: string, branchId?: string, initialCash?: number, initialBank?: number, actor?: { id?: string | null; name?: string | null }) {
  if (initialCash !== undefined) assertMoney(initialCash, true);
  if (initialBank !== undefined) assertMoney(initialBank, true);
  return moneyTransaction(async () => {
  // findFirst (no findUnique): la clave compuesta no admite branchId null en findUnique.
  const existing = await prisma.monthlyClose.findFirst({
    where: { month, branchId: branchId ?? null },
  });
  if (existing) throw conflict(`Ya existe un cierre para ${month}`);

  const range = monthRange(month);
  const orderWhere = branchId
    ? { branchId, deliveredAt: range }
    : { deliveredAt: range };
  const baseWhere = branchId ? { branchId, date: range } : { date: range };
  const convWhere = branchId ? { branchId, date: range } : { date: range };

  const [orders, bases, conversions] = await Promise.all([
    prisma.shipdayOrder.findMany({
      where: orderWhere,
      include: { driver: { select: { id: true, name: true } }, branch: { select: { id: true, name: true } } },
    }),
    prisma.baseTransaction.findMany({ where: baseWhere }),
    prisma.conversion.findMany({ where: convWhere }),
  ]);

  const totalOrders = orders.length;
  const totalValue = orders.reduce((s, o) => s + o.deliveryValue, 0);
  const companyTotal = orders.reduce((s, o) => s + o.companyAmount, 0);
  const basesGiven = bases.filter(b => b.type === "entrega").reduce((s, b) => s + b.amount, 0);
  const basesPaid = bases.filter(b => b.type === "pago").reduce((s, b) => s + b.amount, 0);

  const conversionsSummary = {
    banco_a_efectivo: conversions.filter(c => c.type === "banco_a_efectivo").reduce((s, c) => s + c.amount, 0),
    efectivo_a_banco: conversions.filter(c => c.type === "efectivo_a_banco").reduce((s, c) => s + c.amount, 0),
    count: conversions.length,
  };

  // Build per-driver snapshot
  const driverMap = new Map<string, { name: string; orders: number; value: number; company: number }>();
  for (const o of orders) {
    if (!o.driverId) continue;
    const cur = driverMap.get(o.driverId) ?? { name: o.driver?.name ?? "?", orders: 0, value: 0, company: 0 };
    cur.orders++;
    cur.value += o.deliveryValue;
    cur.company += o.companyAmount;
    driverMap.set(o.driverId, cur);
  }

  const snapshot = {
    capitalAnterior: null as null | { cash: number; bank: number },
    drivers: Object.fromEntries(driverMap),
    orders: orders.map(o => ({
      id: o.id,
      orderNumber: o.orderNumber,
      driver: o.driver?.name ?? null,
      branch: o.branch?.name ?? null,
      value: o.deliveryValue,
      company: o.companyAmount,
      deliveredAt: o.deliveredAt,
    })),
  };

  // Reporte mensual con indicadores estilo Excel
  const report = await getMonthlyReport(month, branchId);

  // El capital inicial definido para el mes SIGUIENTE pasa a ser el saldo base del
  // sistema: actualiza el efectivo y banco de arranque (Settings). Así el nuevo mes
  // comienza acumulando desde esos valores.
  // Capital vigente ANTES de este cierre: se guarda en el snapshot para que las consultas de
  // fechas anteriores reconstruyan su ancla (Settings se sobrescribe a continuación).
  const settingsBefore = await prisma.settings.findUnique({ where: { id: "singleton" } });
  const capitalAnterior = { cash: settingsBefore?.initialCash ?? 0, bank: settingsBefore?.initialBank ?? 0 };
  // Capital del período siguiente: el indicado, o el vigente si no se indicó. Se persiste
  // SIEMPRE en el cierre; si quedaba nulo, el ancla dependía de Settings y un cierre
  // posterior cambiaba retroactivamente los saldos de este período.
  const newCash = initialCash ?? capitalAnterior.cash;
  const newBank = initialBank ?? capitalAnterior.bank;
  if (initialCash != null || initialBank != null) {
    await prisma.settings.update({
      where: { id: "singleton" },
      data: {
        ...(initialCash != null ? { initialCash } : {}),
        ...(initialBank != null ? { initialBank } : {}),
      },
    });
  }

  // Base sin devolver del mes, conciliada con la deuda neta (no el residuo bruto entrega−pago,
  // que puede ser base ya saldada con crédito/comisión). Misma lógica que usa la tarjeta al leer.
  const basesPendingReconciled = await getMonthBasePendingReconciled(month, branchId ?? null);

  return prisma.monthlyClose.create({
    data: {
      branchId: branchId ?? null,
      month,
      totalOrders,
      totalValue,
      companyTotal,
      basesGiven,
      basesPaid,
      basesPending: basesPendingReconciled,
      conversions: conversionsSummary,
      snapshot: { ...snapshot, capitalAnterior },
      initialCash: newCash,
      initialBank: newBank,
      totalSales: report.totalSales,
      totalExpenses: report.expenses.total,
      totalPayroll: report.payroll.total,
      transferDiff: report.transfers.diff,
      clientDebtBalance: report.clientDebt.balance,
      netProfit: report.netProfit,
      profitability: report.profitability,
      closedBy: actor?.id ?? null,
      closedByName: actor?.name ?? null,
    },
  });

  });
}

/**
 * Base REALMENTE sin devolver de un mes, CONCILIADA con la deuda neta de cada domiciliario.
 * Toma el libro de base del mes (entrega − pago por domiciliario) y lo acota a su deuda neta
 * actual: si un domiciliario ya está saldado (deuda 0), su residuo de base del mes NO cuenta
 * (fue saldado con crédito/comisión). Reemplaza el "basesGiven − basesPaid" crudo que dejaba
 * fantasmas como los $65.400 de Andrés en la tarjeta del cierre. Ver lib/base-balance.
 */
export async function getMonthBasePendingReconciled(month: string, branchId?: string | null): Promise<number> {
  const range = monthRange(month);
  const baseWhere = branchId ? { branchId, date: range } : { date: range };
  const grp = await prisma.baseTransaction.groupBy({ by: ["driverId", "type"], _sum: { amount: true }, where: baseWhere });
  const ledgerByDriver = new Map<string, number>();
  for (const row of grp) {
    const cur = ledgerByDriver.get(row.driverId) ?? 0;
    ledgerByDriver.set(row.driverId, cur + (row.type === "entrega" ? (row._sum.amount ?? 0) : -(row._sum.amount ?? 0)));
  }
  const ids = [...ledgerByDriver.keys()];
  if (!ids.length) return 0;
  const drivers = await prisma.driver.findMany({ where: { id: { in: ids } }, select: { id: true, pendingDebt: true } });
  const netById = new Map(drivers.map(d => [d.id, d.pendingDebt]));
  let total = 0;
  for (const [id, ledger] of ledgerByDriver) total += reconcileBasePending(ledger, netById.get(id) ?? 0);
  return total;
}

export async function listCloses(branchId?: string) {
  const where = branchId ? { branchId } : {};
  const closes = await prisma.monthlyClose.findMany({
    where,
    include: { branch: { select: { id: true, name: true } } },
    orderBy: { month: "desc" },
  });
  // "Bases pendientes" de cada cierre se RECALCULA conciliada al leer (no se usa el valor viejo
  // guardado, que podía mostrar base ya saldada con crédito). Así la tarjeta nunca vuelve a
  // enseñar un fantasma, incluso en cierres creados antes de este arreglo.
  return Promise.all(closes.map(async c => ({
    ...c,
    basesPending: await getMonthBasePendingReconciled(c.month, c.branchId),
  })));
}

export async function getClose(id: string) {
  return prisma.monthlyClose.findUnique({
    where: { id },
    include: { branch: { select: { id: true, name: true } } },
  });
}
