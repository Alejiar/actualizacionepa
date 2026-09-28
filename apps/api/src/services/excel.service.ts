import ExcelJS from "exceljs";
import { prisma } from "../lib/prisma";
import { getMonthlyReport } from "./close.service";
import { bogotaMonthRange as monthRange } from "../lib/date-range";

function cop(n: number) {
  return new Intl.NumberFormat("es-CO", { style: "currency", currency: "COP", maximumFractionDigits: 0 }).format(n);
}

/**
 * Construye la hoja "CIERRE MES" replicando la estructura del Excel manual de la empresa,
 * pero con los datos reales del sistema (getMonthlyReport + desglose por categoría).
 */
async function buildCierreMesSheet(wb: ExcelJS.Workbook, month: string, report: Awaited<ReturnType<typeof getMonthlyReport>>, branchId?: string) {
  const range = monthRange(month);
  const monthPrefix = month;

  const [gEf, gBk, nEf, nBk, baseGiven, basePaid, bankIn, bankOut] = await Promise.all([
    prisma.movement.aggregate({ where: { category: 3, status: "confirmed", date: { startsWith: monthPrefix } }, _sum: { amount: true } }),
    prisma.movement.aggregate({ where: { category: 4, status: "confirmed", date: { startsWith: monthPrefix } }, _sum: { amount: true } }),
    prisma.movement.aggregate({ where: { category: 15, status: "confirmed", date: { startsWith: monthPrefix } }, _sum: { amount: true } }),
    prisma.movement.aggregate({ where: { category: { in: [16, 18] }, status: "confirmed", date: { startsWith: monthPrefix } }, _sum: { amount: true } }),
    prisma.baseTransaction.aggregate({ where: { type: "entrega", date: range, ...(branchId ? { branchId } : {}) }, _sum: { cashAmount: true, bankAmount: true, amount: true } }),
    prisma.baseTransaction.aggregate({ where: { type: "pago", date: range, ...(branchId ? { branchId } : {}) }, _sum: { cashAmount: true, bankAmount: true, amount: true } }),
    prisma.bankTransaction.aggregate({ where: { type: "ingreso", date: range }, _sum: { amount: true } }),
    prisma.bankTransaction.aggregate({ where: { type: "egreso", date: range }, _sum: { amount: true } }),
  ]);

  const ws = wb.addWorksheet("CIERRE MES");
  ws.columns = [
    { key: "a", width: 32 }, { key: "b", width: 16 }, { key: "c", width: 16 },
    { key: "d", width: 4 }, { key: "e", width: 28 }, { key: "f", width: 18 },
  ];

  const money = '"$"#,##0';
  const titleFill = (argb: string): Partial<ExcelJS.Style> => ({
    font: { bold: true, color: { argb: "FFFFFFFF" } },
    fill: { type: "pattern", pattern: "solid", fgColor: { argb } },
    alignment: { horizontal: "center" },
  });

  // ── Encabezado ──
  ws.mergeCells("A1:C1");
  ws.getCell("A1").value = `CAJA ${month}`;
  Object.assign(ws.getCell("A1"), titleFill("FF2E7D32"));
  ws.mergeCells("E1:F1");
  ws.getCell("E1").value = "CIERRE MES";
  Object.assign(ws.getCell("E1"), titleFill("FF1565C0"));

  // ── Columna izquierda: movimientos del mes por categoría ──
  ws.getCell("A2").value = "CONCEPTO"; ws.getCell("B2").value = "EFECTIVO"; ws.getCell("C2").value = "BANCO";
  ["A2", "B2", "C2"].forEach(c => Object.assign(ws.getCell(c), titleFill("FF455A64")));

  const givenCash = baseGiven._sum.cashAmount ?? 0;
  const givenBank = baseGiven._sum.bankAmount ?? 0;
  const givenTotal = baseGiven._sum.amount ?? 0;
  const paidCash = basePaid._sum.cashAmount ?? 0;
  const paidBank = basePaid._sum.bankAmount ?? 0;
  const paidTotal = basePaid._sum.amount ?? 0;

  const leftRows: [string, number | string, number | string][] = [
    ["1-Domicilios (comisión)", report.totalSales, ""],
    ["3-Gastos Efectivo / 4-Banco", gEf._sum.amount ?? 0, gBk._sum.amount ?? 0],
    ["5-Bases Entregadas", givenCash || givenTotal, givenBank],
    ["6-Bases Devueltas", paidCash || paidTotal, paidBank],
    ["Transferencias Ingreso", "", bankIn._sum.amount ?? 0],
    ["Transferencias Salida", "", bankOut._sum.amount ?? 0],
    ["15-Nómina Efectivo / 16-Banco", nEf._sum.amount ?? 0, nBk._sum.amount ?? 0],
    ["Deudas Clientes (saldo)", report.clientDebt.balance, ""],
  ];
  let r = 3;
  for (const [concept, ef, bk] of leftRows) {
    ws.getCell(`A${r}`).value = concept;
    ws.getCell(`B${r}`).value = ef === "" ? "" : ef; ws.getCell(`B${r}`).numFmt = money;
    ws.getCell(`C${r}`).value = bk === "" ? "" : bk; ws.getCell(`C${r}`).numFmt = money;
    r++;
  }

  // ── Columna derecha: CIERRE MES (resumen con fórmulas del sistema) ──
  const rightRows: [string, number, string?][] = [
    ["TOTAL VENTAS", report.totalSales],
    ["TOTAL GASTOS", report.expenses.total],
    ["TOTAL NÓMINA", report.payroll.total],
    ["DIFERENCIA BASES", report.bases.diff, "zero"],
    ["DIFERENCIA TRANSFERENCIAS", report.transfers.diff, "zero"],
    ["SALDO DEUDAS CLIENTES", report.clientDebt.balance, "zero"],
    ["COMISIONES PENDIENTES", report.commission.pending, "zero"],
    ["BASES PENDIENTES ANTERIORES", report.debtReconciliation.basesPrevious],
    ["DEUDA ACTUAL DOMICILIARIOS", report.debtReconciliation.total],
  ];
  let er = 2;
  for (const [label, val, kind] of rightRows) {
    ws.getCell(`E${er}`).value = label;
    ws.getCell(`F${er}`).value = val; ws.getCell(`F${er}`).numFmt = money;
    ws.getCell(`E${er}`).font = { bold: true };
    // verde si cuadra en 0, rojo si no (para los indicadores tipo "zero")
    if (kind === "zero") {
      const ok = val === 0;
      ws.getCell(`F${er}`).font = { bold: true, color: { argb: ok ? "FF2E7D32" : "FFC62828" } };
    }
    er++;
  }

  // Ganancia / Utilidad
  er++;
  ws.getCell(`E${er}`).value = "GANANCIA (Utilidad Neta)";
  Object.assign(ws.getCell(`E${er}`), titleFill("FF2E7D32"));
  ws.getCell(`F${er}`).value = report.netProfit; ws.getCell(`F${er}`).numFmt = money;
  ws.getCell(`F${er}`).font = { bold: true, color: { argb: report.netProfit >= 0 ? "FF2E7D32" : "FFC62828" } };
  er++;

  // Rentabilidad
  er++;
  ws.getCell(`E${er}`).value = "RENTABILIDAD"; ws.getCell(`E${er}`).font = { bold: true };
  ws.getCell(`F${er}`).value = `${report.profitability.toFixed(1)}%`;
  ws.getCell(`F${er}`).font = { bold: true };
  er++;
  ws.getCell(`E${er}`).value = "  ingresos mensuales"; ws.getCell(`F${er}`).value = report.totalSales; ws.getCell(`F${er}`).numFmt = money; er++;
  ws.getCell(`E${er}`).value = "  costos totales"; ws.getCell(`F${er}`).value = report.expenses.total + report.payroll.total; ws.getCell(`F${er}`).numFmt = money; er++;
  ws.getCell(`E${er}`).value = "  valor neto"; ws.getCell(`F${er}`).value = report.netProfit; ws.getCell(`F${er}`).numFmt = money; er++;
}

export async function buildMonthlyExcel(month: string, branchId?: string): Promise<Buffer> {
  const range = monthRange(month);
  const orderWhere = branchId ? { branchId, deliveredAt: range } : { deliveredAt: range };
  const baseWhere = branchId ? { branchId, date: range } : { date: range };
  const convWhere = branchId ? { branchId, date: range } : { date: range };

  const [orders, bases, conversions, drivers] = await Promise.all([
    prisma.shipdayOrder.findMany({
      where: orderWhere,
      include: { driver: { select: { name: true } }, branch: { select: { name: true } } },
      orderBy: { deliveredAt: "asc" },
    }),
    prisma.baseTransaction.findMany({
      where: baseWhere,
      include: { driver: { select: { name: true } }, branch: { select: { name: true } } },
      orderBy: { date: "asc" },
    }),
    prisma.conversion.findMany({
      where: convWhere,
      include: { branch: { select: { name: true } } },
      orderBy: { date: "asc" },
    }),
    prisma.driver.findMany({
      where: branchId ? { branchId } : {},
      include: { branch: { select: { name: true } } },
    }),
  ]);

  // Reporte del mes (misma fuente que la pantalla de Reportes) — se calcula una sola vez y
  // se reutiliza para la hoja CIERRE MES y para "Bases pendientes" del Resumen, de modo que
  // TODAS las cifras del Excel coincidan con lo que muestra el sistema.
  const report = await getMonthlyReport(month, branchId);

  const wb = new ExcelJS.Workbook();
  wb.creator = "Cash Buddy EPA";
  wb.created = new Date();

  // Hoja principal con la estructura "CIERRE MES" (igual al Excel manual)
  await buildCierreMesSheet(wb, month, report, branchId);

  const headerStyle: Partial<ExcelJS.Style> = {
    font: { bold: true, color: { argb: "FFFFFFFF" } },
    fill: { type: "pattern", pattern: "solid", fgColor: { argb: "FF1E3A5F" } },
    alignment: { horizontal: "center" },
  };

  // ─── Sheet 1: Resumen ───────────────────────────────────────────────────
  const summary = wb.addWorksheet("Resumen");
  summary.columns = [
    { header: "Concepto", key: "concept", width: 35 },
    { header: "Valor", key: "value", width: 20 },
  ];
  summary.getRow(1).eachCell(c => Object.assign(c, headerStyle));

  const totalValue = orders.reduce((s, o) => s + o.deliveryValue, 0);
  const totalCompany = orders.reduce((s, o) => s + o.companyAmount, 0);
  const basesGiven = bases.filter(b => b.type === "entrega").reduce((s, b) => s + b.amount, 0);
  const basesPaid = bases.filter(b => b.type === "pago").reduce((s, b) => s + b.amount, 0);
  const convB2E = conversions.filter(c => c.type === "banco_a_efectivo").reduce((s, c) => s + c.amount, 0);
  const convE2B = conversions.filter(c => c.type === "efectivo_a_banco").reduce((s, c) => s + c.amount, 0);

  [
    ["Período", month],
    ["Total domicilios", orders.length],
    ["Total valor domicilios", cop(totalValue)],
    ["Total porcentaje empresa (30%)", cop(totalCompany)],
    ["Bases entregadas", cop(basesGiven)],
    ["Bases pagadas", cop(basesPaid)],
    // Base realmente sin devolver, conciliada con la deuda neta de cada domiciliario (misma
    // cifra que el indicador "Diferencia Bases"). NO es entregadas − pagadas: un domiciliario
    // ya saldado no debe base aunque su libro muestre residuo.
    ["Bases sin devolver (conciliado)", cop(report.bases.diff)],
    ["Conversiones banco→efectivo", cop(convB2E)],
    ["Conversiones efectivo→banco", cop(convE2B)],
  ].forEach(([c, v]) => summary.addRow({ concept: c, value: v }));

  // ─── Sheet 2: Domicilios ────────────────────────────────────────────────
  const ordersSheet = wb.addWorksheet("Domicilios");
  ordersSheet.columns = [
    { header: "Sucursal", key: "branch", width: 18 },
    { header: "Fecha", key: "date", width: 20 },
    { header: "# Pedido", key: "number", width: 12 },
    { header: "Domiciliario", key: "driver", width: 22 },
    { header: "Cliente", key: "customer", width: 22 },
    { header: "Valor domicilio", key: "value", width: 18 },
    { header: "% Empresa (30%)", key: "company", width: 18 },
    { header: "Estado", key: "status", width: 14 },
  ];
  ordersSheet.getRow(1).eachCell(c => Object.assign(c, headerStyle));
  for (const o of orders) {
    ordersSheet.addRow({
      branch: o.branch?.name ?? "",
      date: o.deliveredAt ? o.deliveredAt.toLocaleString("es-CO") : "",
      number: o.orderNumber ?? "",
      driver: o.driver?.name ?? "Sin asignar",
      customer: o.customerName ?? "",
      value: o.deliveryValue,
      company: o.companyAmount,
      status: o.status,
    });
  }
  ordersSheet.getColumn("value").numFmt = '"$"#,##0';
  ordersSheet.getColumn("company").numFmt = '"$"#,##0';

  // ─── Sheet 3: Domiciliarios ─────────────────────────────────────────────
  const driversSheet = wb.addWorksheet("Domiciliarios");
  driversSheet.columns = [
    { header: "Sucursal", key: "branch", width: 18 },
    { header: "Nombre", key: "name", width: 22 },
    { header: "Teléfono", key: "phone", width: 16 },
    { header: "Deuda pendiente", key: "debt", width: 20 },
    { header: "Estado", key: "active", width: 12 },
  ];
  driversSheet.getRow(1).eachCell(c => Object.assign(c, headerStyle));
  for (const d of drivers) {
    driversSheet.addRow({
      branch: d.branch?.name ?? "",
      name: d.name,
      phone: d.phone ?? "",
      debt: d.pendingDebt,
      active: d.active ? "Activo" : "Inactivo",
    });
  }
  driversSheet.getColumn("debt").numFmt = '"$"#,##0';

  // ─── Sheet 4: Bases ─────────────────────────────────────────────────────
  const basesSheet = wb.addWorksheet("Bases");
  basesSheet.columns = [
    { header: "Sucursal", key: "branch", width: 18 },
    { header: "Fecha", key: "date", width: 20 },
    { header: "Domiciliario", key: "driver", width: 22 },
    { header: "Tipo", key: "type", width: 12 },
    { header: "Monto", key: "amount", width: 16 },
    { header: "Notas", key: "notes", width: 30 },
  ];
  basesSheet.getRow(1).eachCell(c => Object.assign(c, headerStyle));
  for (const b of bases) {
    basesSheet.addRow({
      branch: b.branch?.name ?? "",
      date: b.date.toLocaleString("es-CO"),
      driver: b.driver?.name ?? "",
      type: b.type === "entrega" ? "Entrega" : "Pago",
      amount: b.amount,
      notes: b.notes ?? "",
    });
  }
  basesSheet.getColumn("amount").numFmt = '"$"#,##0';

  // ─── Sheet 5: Conversiones ──────────────────────────────────────────────
  const convSheet = wb.addWorksheet("Conversiones");
  convSheet.columns = [
    { header: "Sucursal", key: "branch", width: 18 },
    { header: "Fecha", key: "date", width: 20 },
    { header: "Tipo", key: "type", width: 24 },
    { header: "Monto", key: "amount", width: 16 },
    { header: "Notas", key: "notes", width: 30 },
  ];
  convSheet.getRow(1).eachCell(c => Object.assign(c, headerStyle));
  for (const c of conversions) {
    convSheet.addRow({
      branch: c.branch?.name ?? "",
      date: c.date.toLocaleString("es-CO"),
      type: c.type === "banco_a_efectivo" ? "Banco → Efectivo" : "Efectivo → Banco",
      amount: c.amount,
      notes: c.notes ?? "",
    });
  }
  convSheet.getColumn("amount").numFmt = '"$"#,##0';

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}
