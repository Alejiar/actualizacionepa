/**
 * Recorrido completo de UN pedido real importado de Shipday (solo lectura) en la DEMO, con
 * operaciones de dinero FICTICIAS por los endpoints reales. Solo `cashbuddy_demo` local.
 * Elige un domiciliario de la "Sucursal real (lectura)" con un único pedido hoy, para que
 * toda su deuda se explique por ese pedido.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const db = new URL(process.env.DATABASE_URL || "invalid:");
if (db.pathname !== "/cashbuddy_demo" || !["localhost", "127.0.0.1"].includes(db.hostname)) throw Error("Solo la BD DEMO local");
const BASE = "http://127.0.0.1:4000";

async function main() {
  const SRC = pathToFileURL(path.resolve(__dirname, "../src")).href;
  const { prisma: p } = await import(`${SRC}/lib/prisma.ts`);
  const { todayBogota, bogotaDayRange } = await import(`${SRC}/lib/date-range.ts`);
  const ExcelJS = (await import("node:module")).createRequire(path.resolve(__dirname, "../package.json"))("exceljs");
  const today = todayBogota(), month = today.slice(0, 7);
  const call = async (route: string, method = "GET", body?: unknown, tok?: string, raw = false) => {
    const r = await fetch(BASE + "/api" + route, { method, headers: { "Content-Type": "application/json", ...(tok ? { Authorization: "Bearer " + tok } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    if (raw) return { status: r.status, buf: Buffer.from(await r.arrayBuffer()) } as any;
    const j = await r.json().catch(() => null);
    if (r.status >= 400) throw Error(`${method} ${route} → ${r.status} ${JSON.stringify(j)}`);
    return j as any;
  };
  const admin = (await call("/auth/login", "POST", { email: process.env.DEMO_ADMIN, password: process.env.DEMO_PASS })).token;
  const oper = (await call("/auth/login", "POST", { email: "operador@epa.demo", password: process.env.DEMO_PASS })).token;

  const branch = await p.branch.findFirstOrThrow({ where: { name: "Sucursal real (lectura)" } });
  const range = bogotaDayRange(today);
  const orders = await p.shipdayOrder.findMany({ where: { branchId: branch.id, deliveredAt: range, companyAmount: { gt: 0 } } });
  const byDriver = new Map<string, any[]>();
  for (const o of orders) if (o.driverId) byDriver.set(o.driverId, [...(byDriver.get(o.driverId) ?? []), o]);
  const [driverId, [order]] = [...byDriver.entries()].filter(([, os]) => os.length === 1).sort((a, b) => b[1][0].companyAmount - a[1][0].companyAmount)[0];
  const driver = await p.driver.findUniqueOrThrow({ where: { id: driverId } });
  const facts: any = { pedido: { shipdayOrderId: order.shipdayOrderId, numero: order.orderNumber, tarifa: order.deliveryValue, tarifaShipday: order.shipdayDeliveryValue, comision: order.companyAmount, entregado: order.deliveredAt } };

  // 1) Pedido → comisión 30 % → deuda (cálculo independiente)
  const comision = Math.round(order.deliveryValue * 0.3);
  assert.equal(order.companyAmount, comision); assert.equal(order.shipdayDeliveryValue, order.deliveryValue);
  assert.equal(driver.pendingDebt, comision, "toda la deuda del domiciliario es la comisión de su único pedido");
  assert.equal(driver.creditAmount, 0);
  assert.equal(await p.shipdayOrder.count({ where: { shipdayOrderId: order.shipdayOrderId } }), 1);
  const exp0 = await call(`/shifts/${today}/expected`, "GET", undefined, admin);
  const rep0 = await call(`/sd/report/${month}`, "GET", undefined, admin);
  const xl = async () => { const r = await call(`/sd/closes/export/${month}`, "GET", undefined, admin, true); const wb = new ExcelJS.Workbook(); await wb.xlsx.load(r.buf); const ws = wb.getWorksheet("CIERRE MES"); const g = (n: number) => [ws.getRow(n).getCell(2).value, ws.getRow(n).getCell(3).value]; return { comision: g(3)[0], basesEnt: g(5), basesDev: g(6), ingresos: g(7), salidas: g(8) }; };
  const x0 = await xl();
  // Las ventas del mes incluyen la comisión de todos los pedidos reales importados + los 3 ficticios.
  const ventasBD = (await p.shipdayOrder.aggregate({ _sum: { companyAmount: true } }))._sum.companyAmount;
  assert.equal(rep0.totalSales, ventasBD); assert.equal(x0.comision, ventasBD);
  facts.antes = { efectivo: exp0.expectedCash, banco: exp0.expectedBank, deuda: driver.pendingDebt, ventasMes: rep0.totalSales, comisionPendienteMes: rep0.commission.pending };

  // 2) FICTICIO: base de 10.000 en efectivo y pago total del domiciliario (base + comisión) en efectivo
  await call(`/sd/bases/${driverId}/give`, "POST", { cashAmount: 10000, notes: "DEMO ficticio" }, oper);
  const d1 = await p.driver.findUniqueOrThrow({ where: { id: driverId } });
  assert.equal(d1.pendingDebt, comision + 10000);
  await call(`/sd/drivers/${driverId}/payment`, "POST", { amount: comision + 10000, medium: "cash", notes: "DEMO ficticio" }, oper);
  const d2 = await p.driver.findUniqueOrThrow({ where: { id: driverId } });
  const exp1 = await call(`/shifts/${today}/expected`, "GET", undefined, admin);
  const rep1 = await call(`/sd/report/${month}`, "GET", undefined, admin);
  const x1 = await xl();
  facts.despues = { efectivo: exp1.expectedCash, banco: exp1.expectedBank, deuda: d2.pendingDebt, credito: d2.creditAmount, comisionPendienteMes: rep1.commission.pending };
  facts.excel = { antes: x0, despues: x1 };

  // 3) Efectos esperados, calculados aparte
  assert.deepEqual([d2.pendingDebt, d2.creditAmount], [0, 0]);
  assert.equal(exp1.expectedCash, exp0.expectedCash - 10000 + (comision + 10000), "efectivo: −base +pago");
  assert.equal(exp1.expectedBank, exp0.expectedBank, "el banco no cambia");
  assert.equal(rep1.totalSales, rep0.totalSales, "pagar no cambia las ventas");
  assert.equal(rep1.commission.pending, rep0.commission.pending - comision, "la comisión pendiente baja exactamente la del pedido");
  assert.deepEqual(x1.basesEnt, [(x0.basesEnt[0] as number) + 10000, x0.basesEnt[1]]);
  assert.deepEqual(x1.basesDev, x0.basesDev, "la base devuelta dentro del pago ya está en Movimientos (sin doble conteo)");
  assert.deepEqual(x1.ingresos, [(x0.ingresos[0] as number) + comision + 10000, x0.ingresos[1]]);
  const sum = await call(`/days/${today}/summary`, "GET", undefined, admin);
  assert.equal(sum.initialTotal + sum.ingresos - sum.egresos, sum.finalTotal);
  assert.equal(sum.finalCash, exp1.expectedCash);
  fs.writeFileSync(path.join(__dirname, "demo-pedido-real.json"), JSON.stringify(facts, null, 2));
  console.log(JSON.stringify(facts, null, 1));
  await p.$disconnect();
}
main().catch(e => { console.error("FALLA:", e.message); process.exit(1); });
