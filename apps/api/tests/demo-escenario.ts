/**
 * Escenario DEMO con valores conocidos (auditoría final de Claude, 14-oct-2026).
 *
 * Ejecuta operaciones ficticias por los ENDPOINTS REALES de una app ya en marcha y compara
 * cada saldo con un libro propio, calculado aquí de forma independiente (no reutiliza las
 * funciones de saldo de la app). Solo admite la BD DEMO `cashbuddy_demo` o la temporal
 * `cashbuddy_claude_auditoria`, ambas locales.
 *
 * Uso:  DATABASE_URL=<demo> BASE_URL=http://127.0.0.1:4000 DEMO_ADMIN=... DEMO_PASS=... \
 *       node node_modules/tsx/dist/cli.mjs apps/api/tests/demo-escenario.ts [--cerrar]
 *   --cerrar  registra además el Cierre del día y comprueba los rechazos posteriores
 *             (no usarlo en la DEMO del propietario: bloquea el día para sus ensayos).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const db = new URL(process.env.DATABASE_URL || "invalid:");
if (!["/cashbuddy_demo", "/cashbuddy_claude_auditoria"].includes(db.pathname) || !["localhost", "127.0.0.1"].includes(db.hostname)) {
  throw Error("Solo la BD DEMO cashbuddy_demo o la temporal cashbuddy_claude_auditoria (locales)");
}
const BASE = process.env.BASE_URL || "http://127.0.0.1:4000";
if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(BASE)) throw Error("BASE_URL debe ser local");
const CERRAR = process.argv.includes("--cerrar");

async function main() {
  const SRC = pathToFileURL(path.resolve(__dirname, "../src")).href;
  const { prisma: p } = await import(`${SRC}/lib/prisma.ts`);
  const { todayBogota } = await import(`${SRC}/lib/date-range.ts`);
  const { createRequire } = await import("node:module");
  const ExcelJS = createRequire(path.resolve(__dirname, "../package.json"))("exceljs");
  const today = todayBogota(), month = today.slice(0, 7);
  const log: any[] = [];

  async function call(route: string, method = "GET", body?: unknown, token?: string, raw = false) {
    const r = await fetch(BASE + "/api" + route, { method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    if (raw) return { status: r.status, buf: Buffer.from(await r.arrayBuffer()) } as any;
    return { status: r.status, body: await r.json().catch(() => null) as any };
  }
  async function ok(route: string, method: string, body: unknown, token: string, expect = [200, 201, 204]) {
    const r = await call(route, method, body, token);
    if (!expect.includes(r.status)) throw Error(`${method} ${route} → ${r.status} ${JSON.stringify(r.body)}`);
    return r.body;
  }
  const login = async (email: string, password: string) => {
    const r = await call("/auth/login", "POST", { email, password });
    assert.equal(r.status, 200, "login " + email); return r.body.token as string;
  };

  // ── Libro independiente ─────────────────────────────────────────────────────────
  const L = { cash: 100000, bank: 100000 };
  const debt: Record<string, number> = {};
  const step = (n: string, cash: number, bank: number, extra: Record<string, unknown> = {}) => {
    L.cash += cash; L.bank += bank; log.push({ paso: n, efectivo: cash, banco: bank, saldoEfectivo: L.cash, saldoBanco: L.bank, ...extra });
  };
  async function expectBalances(label: string) {
    const r = await ok(`/shifts/${today}/expected`, "GET", undefined, admin);
    const got = { cash: r.cash ?? r.expectedCash ?? r.expected?.cash, bank: r.bank ?? r.expectedBank ?? r.expected?.bank };
    assert.deepEqual(got, { cash: L.cash, bank: L.bank }, `${label}: saldo esperado de la app ≠ libro independiente (${JSON.stringify(r)})`);
  }

  const admin = await login(process.env.DEMO_ADMIN!, process.env.DEMO_PASS!);
  if ((await p.shiftClose.count()) || (await p.monthlyClose.count()) || (await p.branch.count())) {
    throw Error("La BD ya tiene sucursales o cierres: el escenario espera una DEMO recién creada.");
  }

  // 0. Capital inicial y usuarios
  await ok("/settings", "PATCH", { initialCash: 100000, initialBank: 100000, companyName: "EPA DEMO", setupComplete: true, termsAcceptedAt: new Date().toISOString() }, admin);
  await ok("/users", "POST", { email: "operador@epa.demo", password: process.env.DEMO_PASS, name: "Operador DEMO", role: "user" }, admin);
  const oper = await login("operador@epa.demo", process.env.DEMO_PASS!);
  log.push({ paso: "0 Capital inicial", saldoEfectivo: 100000, saldoBanco: 100000 });
  await expectBalances("Capital inicial");

  // 1. Sucursal ficticia y domiciliarios (no hay endpoint de alta: llegan de Shipday; se
  //    insertan con los mismos campos que escribe la sincronización).
  const branch = await ok("/branches", "POST", { name: "Sucursal DEMO (ficticia)", apiKey: "DEMO-SIN-SHIPDAY" }, admin);
  const A = await p.driver.create({ data: { name: "Domiciliario Demo A", shipdayDriverId: "demo-a", branchId: branch.id } });
  const B = await p.driver.create({ data: { name: "Domiciliario Demo B", shipdayDriverId: "demo-b", branchId: branch.id } });
  debt[A.id] = 0; debt[B.id] = 0;
  // F14 (14-oct-2026): la base es una cuenta aparte de la deuda por comisiones.
  const base: Record<string, number> = { [A.id]: 0, [B.id]: 0 };

  // 2. Pedidos manuales: comisión 30 % → deuda del domiciliario (no mueve caja ni banco)
  for (const [num, d, v] of [["D1", A, 10000], ["D2", A, 8000], ["D3", B, 12000]] as const) {
    const o = await ok("/sd/orders/manual", "POST", { branchId: branch.id, driverId: d.id, deliveryValue: v, orderNumber: num, customerName: "Cliente " + num }, oper);
    assert.equal(o.companyAmount, Math.round(v * 0.3)); debt[d.id] += Math.round(v * 0.3);
    step(`2 Pedido ${num} ${d.name} $${v}`, 0, 0, { comision: Math.round(v * 0.3) });
  }
  await ok(`/branches/${branch.id}`, "DELETE", undefined, admin); // desactivar: sin sondeos a Shipday
  await expectBalances("Pedidos");

  // 3. Base entregada a A (efectivo) y devolución parcial
  await ok(`/sd/bases/${A.id}/give`, "POST", { cashAmount: 20000 }, oper); base[A.id] += 20000; step("3 Base entregada a A (efectivo)", -20000, 0);
  await ok(`/sd/bases/${A.id}/pay`, "POST", { cashAmount: 5000 }, oper); base[A.id] -= 5000; step("3 Base devuelta por A (efectivo)", 5000, 0);
  // 4. Pago de A por banco
  // F14: el operador asigna el pago a comisión (D1 3.000 + D2 2.400); la base de 15.000 sigue pendiente.
  await ok(`/sd/drivers/${A.id}/payment`, "POST", { amount: 5400, medium: "bank", baseAmount: 0 }, oper); debt[A.id] -= 5400; step("4 Pago de A (banco) a comisión", 0, 5400);
  await expectBalances("Bases y pago");
  // 5. Ingreso bancario sin contraparte
  await ok("/bank-transactions", "POST", { type: "ingreso", medium: "bank", amount: 30000, description: "Ingreso bancario DEMO", noCounterpart: true }, oper); step("5 Ingreso bancario", 0, 30000);
  // 6. Gasto en efectivo: el operador lo deja pendiente (no mueve caja) y el admin lo aprueba
  const gasto = await ok("/movements", "POST", { date: today, category: 3, type: "egreso", medium: "cash", amount: 10000, description: "Gasto DEMO" }, oper);
  assert.equal(gasto.status, "pending"); await expectBalances("Gasto pendiente");
  await ok(`/movements/${gasto.id}/approve`, "POST", {}, admin); step("6 Gasto aprobado (efectivo)", -10000, 0);
  // 7. Conversión efectivo → banco
  await ok("/sd/conversions", "POST", { branchId: branch.id, amount: 7000, type: "efectivo_a_banco" }, oper); step("7 Conversión efectivo→banco", -7000, 7000);
  // 8. Transferencia con contraparte: sale del banco y entra a efectivo (no crea dinero)
  const out = await ok("/bank-transactions", "POST", { type: "egreso", medium: "bank", amount: 50000, description: "Retiro a caja" }, oper);
  const back = await ok("/bank-transactions", "POST", { type: "ingreso", medium: "cash", amount: 50000, description: "Retiro a caja (contraparte)", pairWith: out.id }, oper);
  assert.ok(back.pairId); step("8 Transferencia banco→efectivo", 50000, -50000);
  // 9. Cliente normal: deuda de 20.000 (sin desembolso) y abono de 5.000 en efectivo
  const cli = await ok("/clients", "POST", { name: "Cliente DEMO" }, oper);
  await ok(`/clients/${cli.id}/debt`, "POST", { description: "Domicilios fiados DEMO", amount: 20000 }, oper); step("9 Deuda cliente (sin desembolso)", 0, 0);
  await ok(`/clients/${cli.id}/pay`, "POST", { amount: 5000, medium: "cash" }, oper); step("9 Abono cliente (efectivo)", 5000, 0);
  // 10. Cliente por hora: 2 h × (10.000 domiciliario + 5.000 empresa); se paga al domiciliario
  //     en efectivo al registrar y el cliente paga el total por banco
  const hc = await ok("/hourly-clients", "POST", { name: "Cliente por hora DEMO", driverHourValue: 10000, companyHourValue: 5000 }, oper);
  const shift = await ok(`/hourly-clients/${hc.id}/shifts`, "POST", { driverId: B.id, startTime: "08:00", endTime: "10:00", medium: "cash" }, oper);
  assert.deepEqual([shift.driverAmount, shift.companyAmount, shift.totalAmount], [20000, 10000, 30000]); step("10 Turno por hora: pago al domiciliario (efectivo)", -20000, 0);
  await ok(`/hourly-clients/${hc.id}/pay`, "POST", { amount: 30000, medium: "bank" }, oper); step("10 Cobro al cliente por hora (banco)", 0, 30000);
  // 11. B paga su comisión en efectivo
  await ok(`/sd/drivers/${B.id}/payment`, "POST", { amount: 3600, medium: "cash" }, oper); debt[B.id] -= 3600; step("11 Pago de B (efectivo)", 3600, 0);
  await expectBalances("Final del día");

  // ── Comprobaciones cruzadas ─────────────────────────────────────────────────────
  const facts: Record<string, unknown> = {};
  for (const d of [A, B]) {
    const row = await p.driver.findUniqueOrThrow({ where: { id: d.id } });
    facts["comision " + d.name] = row.pendingDebt; assert.equal(row.pendingDebt, debt[d.id], "comisión " + d.name); assert.equal(row.creditAmount, 0);
    const det = await ok(`/sd/drivers/${d.id}`, "GET", undefined, admin); facts["base " + d.name] = det.basePending; assert.equal(det.basePending, base[d.id], "base " + d.name);
  }
  assert.deepEqual([debt[A.id], base[A.id], debt[B.id], base[B.id]], [0, 15000, 0, 0]);
  assert.equal((await p.client.findUniqueOrThrow({ where: { id: cli.id } })).pendingDebt, 15000);
  assert.equal((await p.hourlyClient.findUniqueOrThrow({ where: { id: hc.id } })).pendingDebt, 0);
  const rep = (await ok(`/sd/report/${month}`, "GET", undefined, admin));
  facts.reporte = { totalSales: rep.totalSales, expenses: rep.expenses, payroll: rep.payroll, netProfit: rep.netProfit, bases: { given: rep.bases.given, returned: rep.bases.returned, diff: rep.bases.diff }, commission: rep.commission.pending, transfers: rep.transfers.diff, clientDebt: rep.clientDebt };
  // Cálculo independiente (F14): base del mes = saldo anterior 0 + entregadas 20.000 − devueltas
  // 5.000 = 15.000; comisión pendiente = 9.000 − 5.400 (A) − 3.600 (B) = 0.
  // NEW03 (decisión del dueño, 21-oct-2026): ventas = comisión de domicilios (30 % de 30.000 = 9.000)
  // + ganancia empresa por hora (2 h × 5.000 = 10.000).
  assert.deepEqual([rep.sales?.orders, rep.sales?.hourly, rep.totalSales], [9000, 10000, 19000]);
  assert.deepEqual([rep.expenses.cash, rep.expenses.bank, rep.expenses.total], [10000, 0, 10000]);
  assert.equal(rep.payroll.total, 0);
  assert.equal(rep.netProfit, 19000 - 10000, "utilidad = ventas (domicilios + por hora) − gastos − nómina");
  assert.deepEqual([rep.bases.previous, rep.bases.given, rep.bases.returned, rep.bases.diff], [0, 20000, 5000, 15000]);
  assert.equal(rep.commission.pending, 0); assert.equal(rep.debtReconciliation.total, 15000);
  assert.equal(rep.transfers.diff, 0, "la transferencia con contraparte debe cuadrar");
  assert.deepEqual([rep.clientDebt.normal, rep.clientDebt.hourly, rep.clientDebt.balance], [15000, 0, 15000]);
  const orders = await p.shipdayOrder.findMany({ select: { deliveryValue: true, companyAmount: true } });
  assert.equal(orders.length, 3); assert.equal(orders.reduce((t: number, o: any) => t + o.deliveryValue, 0), 30000);
  const sum = await ok(`/days/${today}/summary`, "GET", undefined, admin);
  facts.historial = sum;
  assert.equal(sum.initialTotal + sum.ingresos - sum.egresos, sum.finalTotal, "Historial: apertura + ingresos − egresos ≠ cierre");
  assert.deepEqual([sum.finalCash, sum.finalBank], [L.cash, L.bank]);
  assert.equal(sum.comision, 9000);
  // Excel del mes
  const xl = await call(`/sd/closes/export/${month}`, "GET", undefined, admin, true);
  assert.equal(xl.status, 200);
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(xl.buf);
  const ws = wb.getWorksheet("CIERRE MES");
  const rows: any[] = []; ws?.eachRow((r: any, n: number) => rows.push([n, r.getCell(1).value, r.getCell(2).value, r.getCell(3).value]));
  facts.excel = rows.slice(0, 30);
  fs.writeFileSync(path.join(__dirname, "demo-escenario-excel.xlsx"), xl.buf);

  if (CERRAR) {
    const counted = { date: today, shift: "close", denominations: { bills: [{ value: 1000, qty: L.cash / 1000 }], coins: [] }, bankCounted: L.bank };
    const c = await ok("/shifts", "POST", counted, admin);
    facts.cierre = { esperado: c.totalExpected, contado: c.totalCounted, diferencia: c.difference, bancoEsperado: c.bankExpected, bancoDif: c.bankDifference };
    assert.deepEqual([c.totalExpected, c.difference, c.bankExpected, c.bankDifference], [L.cash, 0, L.bank, 0]);
    // Después del Cierre, el día no admite dinero nuevo ni cambios (D7 pendiente).
    for (const [route, body] of [["/bank-transactions", { type: "ingreso", medium: "cash", amount: 1000, description: "tras cierre", noCounterpart: true }], [`/sd/bases/${A.id}/give`, { cashAmount: 1000 }]] as const) {
      assert.equal((await call(route, "POST", body, oper)).status, 409, route);
    }
    assert.deepEqual(await ok(`/shifts/${today}/expected`, "GET", undefined, admin).then((r: any) => [r.cash ?? r.expectedCash, r.bank ?? r.expectedBank]), [L.cash, L.bank]);
  }

  const out2 = { fecha: today, libro: log, saldoFinal: { ...L }, deudas: { comisionA: debt[A.id], baseA: base[A.id], comisionB: debt[B.id], baseB: base[B.id], cliente: 15000, porHora: 0 }, facts };
  fs.writeFileSync(path.join(__dirname, `demo-escenario-${db.pathname.slice(1)}.json`), JSON.stringify(out2, null, 2));
  console.log(JSON.stringify({ ok: true, saldoFinal: L, deudas: out2.deudas, reporte: facts.reporte }, null, 1));
  await p.$disconnect();
}
main().catch(async e => { console.error("FALLA:", e.message); process.exit(1); });
