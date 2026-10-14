/**
 * Regresiones de la auditoría final de Claude (14-oct-2026) sobre el trabajo de Codex
 * (d801079). SOLO contra la BD local temporal cashbuddy_claude_auditoria, migrada.
 * Shipday simulado; cualquier red externa queda bloqueada.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const u = new URL(process.env.DATABASE_URL || "invalid:");
if (u.pathname !== "/cashbuddy_claude_auditoria" || !["localhost", "127.0.0.1"].includes(u.hostname)) throw Error("Solo BD temporal local cashbuddy_claude_auditoria");

async function main() {
  const SRC = pathToFileURL(path.resolve(__dirname, "../src")).href;
  const { prisma: p } = await import(`${SRC}/lib/prisma.ts`);
  const branchSvc = await import(`${SRC}/services/branch.service.ts`);
  const dash = await import(`${SRC}/services/shipday-dashboard.service.ts`);
  const { createServer } = await import(`${SRC}/server.ts`);
  const closes = await import(`${SRC}/services/close.service.ts`);
  const days = await import(`${SRC}/services/day.service.ts`);
  const drivers = await import(`${SRC}/services/driver.service.ts`);
  const excel = await import(`${SRC}/services/excel.service.ts`);
  const { createRequire } = await import("node:module");
  const ExcelJS = createRequire(path.resolve(__dirname, "../package.json"))("exceljs");
  const { todayBogota, toBogotaDateStr } = await import(`${SRC}/lib/date-range.ts`);

  const today = todayBogota();
  const yesterdayNoon = new Date(new Date(today + "T12:00:00-05:00").getTime() - 86400000);
  const yesterday = toBogotaDateStr(yesterdayNoon);
  // Decisión del dueño (14-oct-2026): un pedido de un DÍA cerrado se carga; solo un MES cerrado lo
  // bloquea. Las regresiones SYNC usan por eso un pedido del mes anterior ya cerrado.
  const prevMonthNoon = new Date(new Date(today.slice(0, 7) + "-01T12:00:00-05:00").getTime() - 86400000);
  const closePrevMonth = () => closes.closeMonth(toBogotaDateStr(prevMonthNoon).slice(0, 7), undefined, 100000, 100000);
  const realFetch = globalThis.fetch;
  const blocked = (async (input: any, init: any) => { if (!String(input).startsWith("http://127.0.0.1:")) throw Error("Red externa bloqueada"); return realFetch(input, init); }) as any;
  globalThis.fetch = blocked;
  let branch: any, driver: any;

  async function reset() {
    const tables = await p.$queryRawUnsafe(`SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename <> '_prisma_migrations'`) as any[];
    await p.$executeRawUnsafe("TRUNCATE TABLE " + tables.map((x: any) => '"' + x.tablename + '"').join(",") + " CASCADE");
    await p.settings.create({ data: { id: "singleton", initialCash: 100000, initialBank: 100000, setupComplete: true, termsAcceptedAt: new Date() } });
    branch = await p.branch.create({ data: { name: "Sucursal", apiKeyEnc: "test-only" } });
    driver = await p.driver.create({ data: { name: "Domiciliario", shipdayDriverId: "7001", branchId: branch.id } });
  }
  /** Shipday simulado: /carriers y /orders/query con los pedidos dados. */
  function mockShipday(orders: any[]) {
    globalThis.fetch = (async (input: any, init: any) => {
      const s = String(input);
      if (s.startsWith("http://127.0.0.1:")) return realFetch(input, init);
      if (s === "https://api.shipday.com/carriers") return new Response(JSON.stringify([{ id: 7001, name: "Domiciliario" }]));
      if (s === "https://api.shipday.com/orders/query") return new Response(JSON.stringify(orders));
      throw Error("Red externa bloqueada");
    }) as any;
  }
  const order = (id: string, fee: number, at: Date) => ({ orderId: id, orderNumber: id, deliveryFee: fee, deliveryTime: at.toISOString(), carrier: { id: 7001 } });
  const results: any[] = [];
  async function check(id: string, name: string, fn: (f: any) => Promise<void>) {
    await reset(); const f: any = {};
    try { await fn(f); results.push({ id, name, ok: true, f }); console.log("OK    " + id + " " + name); }
    catch (e) { results.push({ id, name, ok: false, f, error: String((e as Error).message).slice(0, 400) }); console.log("FALLA " + id + " " + name + "\n      " + JSON.stringify(f) + " " + String((e as Error).message).slice(0, 300)); }
    finally { globalThis.fetch = blocked; }
  }

  const server = createServer().listen(0, "127.0.0.1"); await new Promise<void>(r => server.once("listening", r));
  const origin = "http://127.0.0.1:" + (server.address() as any).port;
  const hook = (body: unknown) => realFetch(origin + "/api/webhooks/shipday/" + branch.id, { method: "POST", headers: { "Content-Type": "application/json", token: process.env.WEBHOOK_TOKEN! }, body: JSON.stringify(body) });
  try {
    await check("DOM01", "Domicilio Shipday (SIMULADO) de punta a punta: stub $0 → tarifa real → 30 % → deuda → pago → caja → reportes", async f => {
      const month = today.slice(0, 7);
      const t0 = Date.now();
      // 1) Webhook en el instante de la entrega: Shipday aún no fija tarifa (stub $0, #00).
      const ev = { event: "ORDER_COMPLETED", order: { id: "live-1", order_number: "00", delivery_fee: 0, delivery_time: t0 }, carrier: { id: "7001" } };
      assert.equal((await hook(ev)).status, 200);
      let o = await p.shipdayOrder.findUniqueOrThrow({ where: { shipdayOrderId: "live-1" } });
      f.stub = { valor: o.deliveryValue, comision: o.companyAmount, driver: !!o.driverId };
      assert.equal(o.deliveryValue, 0); assert.equal((await p.driver.findUniqueOrThrow({ where: { id: driver.id } })).pendingDebt, 0);
      // 2) El sondeo trae la tarifa y el número reales: se sana UNA vez y se cuenta.
      mockShipday([order("live-1", 15000, new Date(t0))]);
      await branchSvc.syncBranch(branch.id, { forceDrivers: true });
      await branchSvc.syncBranch(branch.id, {});              // segundo ciclo: idempotente
      globalThis.fetch = blocked;
      for (let i = 0; i < 5; i++) assert.equal((await hook(ev)).status, 200); // reintentos del webhook
      o = await p.shipdayOrder.findUniqueOrThrow({ where: { shipdayOrderId: "live-1" } });
      const d1 = await p.driver.findUniqueOrThrow({ where: { id: driver.id } });
      f.sanado = { valor: o.deliveryValue, comision: o.companyAmount, numero: o.orderNumber, deuda: d1.pendingDebt, pedidos: await p.shipdayOrder.count() };
      assert.deepEqual([o.deliveryValue, o.companyAmount, o.orderNumber, d1.pendingDebt], [15000, 4500, "live-1", 4500]);
      assert.equal(await p.shipdayOrder.count(), 1);
      const stat = await p.dailyDriverStat.findFirstOrThrow({ where: { driverId: driver.id } });
      assert.deepEqual([stat.orderCount, stat.totalValue, stat.companyTotal], [1, 15000, 4500]);
      // El pedido no mueve caja ni banco por sí mismo.
      assert.deepEqual(await dash.getExpectedBalancesForDate(today), { cash: 100000, bank: 100000 });
      // 3) El domiciliario paga su comisión en efectivo.
      await drivers.registerPayment(driver.id, 4500, "cash");
      const d2 = await p.driver.findUniqueOrThrow({ where: { id: driver.id } });
      assert.deepEqual([d2.pendingDebt, d2.creditAmount], [0, 0]);
      assert.deepEqual(await dash.getExpectedBalancesForDate(today), { cash: 104500, bank: 100000 });
      // 4) Reportes: Historial, reporte mensual y Excel.
      const s = await days.getDaySummary(today);
      assert.equal(s.comision, 4500); assert.equal(s.initialTotal + s.ingresos - s.egresos, s.finalTotal); assert.equal(s.finalCash, 104500);
      const rep = await closes.getMonthlyReport(month);
      f.reporte = { ventas: rep.totalSales, comisionPendiente: rep.commission.pending, deuda: rep.debtReconciliation.total };
      assert.deepEqual([rep.totalSales, rep.commission.pending, rep.debtReconciliation.total], [4500, 0, 0]);
      const wb = new ExcelJS.Workbook(); await wb.xlsx.load(await excel.buildMonthlyExcel(month) as any);
      const row = (n: number) => { const r = wb.getWorksheet("CIERRE MES")!.getRow(n); return [r.getCell(1).value, r.getCell(2).value, r.getCell(3).value]; };
      assert.deepEqual(row(3), ["1-Domicilios (comisión)", 4500, ""]);
      assert.deepEqual(row(7).slice(1), [4500, 0], "el pago en efectivo aparece una sola vez en Movimientos Ingreso");
      // 5) Persistencia: nueva conexión, mismos datos.
      await p.$disconnect(); await p.$connect();
      assert.equal((await p.shipdayOrder.findUniqueOrThrow({ where: { shipdayOrderId: "live-1" } })).companyAmount, 4500);
      assert.deepEqual(await dash.getExpectedBalancesForDate(today), { cash: 104500, bank: 100000 });
    });
    await check("SHIP01", "API key de Shipday rechazada (403) responde 400 con mensaje claro, no 500", async f => {
      globalThis.fetch = (async (input: any, init: any) => {
        const s = String(input);
        if (s.startsWith("http://127.0.0.1:")) return realFetch(input, init);
        if (s.startsWith("https://api.shipday.com/")) return new Response("forbidden", { status: 403 });
        throw Error("Red externa bloqueada");
      }) as any;
      const err: any = await branchSvc.startOrdersFromToday(branch.id).then(() => null, (e: any) => e);
      f.status = err?.status; f.mensaje = err?.message;
      assert.equal(err?.status, 400); assert.match(err.message, /API Key de Shipday inválida/);
      const b = await p.branch.findUniqueOrThrow({ where: { id: branch.id } });
      assert.equal(b.syncStatus, "error"); assert.equal(await p.shipdayOrder.count(), 0);
    });
    await check("SYNC01", "Un pedido de un día cerrado no impide cargar los pedidos válidos del mismo ciclo", async f => {
      // El mes anterior está cerrado; el sondeo trae primero un rezagado de ese mes y después
      // un pedido de hoy. El de hoy (período abierto) DEBE cargarse sin abortar el ciclo.
      await closePrevMonth();
      const before = await dash.getExpectedBalancesForDate(yesterday);
      mockShipday([order("rezagado-ayer", 10000, prevMonthNoon), order("hoy", 20000, new Date())]);
      let r: any, err: any;
      try { r = await branchSvc.syncBranch(branch.id, { forceDrivers: true, windowDays: 40 }); } catch (e) { err = e; }
      f.error = err ? String(err.message).slice(0, 120) : null; f.partial = r?.partial; f.mensaje = r?.error;
      f.pedidos = (await p.shipdayOrder.findMany({ select: { shipdayOrderId: true } })).map((o: any) => o.shipdayOrderId);
      f.deuda = (await p.driver.findUniqueOrThrow({ where: { id: driver.id } })).pendingDebt;
      assert.deepEqual(f.pedidos, ["hoy"], "el pedido abierto de hoy debe cargarse y el del mes cerrado no");
      assert.equal(f.deuda, 6000, "30 % de 20.000");
      assert.equal(r.partial, true, "el ciclo debe quedar marcado incompleto");
      assert.match(r.error, /rezagado-ayer/, "el pedido omitido debe quedar identificado");
      assert.equal((await p.branch.findUniqueOrThrow({ where: { id: branch.id } })).syncStatus, "error");
      assert.deepEqual(await dash.getExpectedBalancesForDate(yesterday), before, "la caja no cambia");
    });
    await check("SYNC02", "El pedido omitido se reintenta en el siguiente ciclo y nunca se duplica el válido", async f => {
      await closePrevMonth();
      mockShipday([order("rezagado-ayer", 10000, prevMonthNoon), order("hoy", 20000, new Date())]);
      await branchSvc.syncBranch(branch.id, { forceDrivers: true, windowDays: 40 }).catch(() => null);
      const r2 = await branchSvc.syncBranch(branch.id, { windowDays: 40 }).catch((e: any) => ({ thrown: e.message }));
      f.r2 = r2;
      assert.equal(await p.shipdayOrder.count({ where: { shipdayOrderId: "hoy" } }), 1);
      assert.equal((await p.driver.findUniqueOrThrow({ where: { id: driver.id } })).pendingDebt, 6000);
      assert.equal(await p.shipdayOrder.count({ where: { shipdayOrderId: "rezagado-ayer" } }), 0);
    });
    await check("SYNC03", "Reconciliación profunda: igual, omite el cerrado y carga el abierto", async f => {
      await closePrevMonth();
      globalThis.fetch = (async (input: any, init: any) => {
        const s = String(input);
        if (s.startsWith("http://127.0.0.1:")) return realFetch(input, init);
        if (s.startsWith("https://api.shipday.com/orders")) return new Response(JSON.stringify([
          { orderId: "rec-ayer", orderNumber: "1", orderStatus: { orderState: "DELIVERED" }, deliveryFee: 10000, costing: { deliveryFee: 10000 }, assignedCarrier: { id: 7001 }, activityLog: { deliveryTime: prevMonthNoon.toISOString() }, deliveryTime: prevMonthNoon.toISOString() },
          { orderId: "rec-hoy", orderNumber: "2", orderStatus: { orderState: "DELIVERED" }, deliveryFee: 20000, costing: { deliveryFee: 20000 }, assignedCarrier: { id: 7001 }, activityLog: { deliveryTime: new Date().toISOString() }, deliveryTime: new Date().toISOString() },
        ]));
        throw Error("Red externa bloqueada");
      }) as any;
      let r: any, err: any;
      try { r = await branchSvc.reconcileBranch(branch.id, toBogotaDateStr(prevMonthNoon), today); } catch (e) { err = e; }
      f.error = err ? String(err.message).slice(0, 160) : null; f.r = r;
      f.pedidos = (await p.shipdayOrder.findMany({ select: { shipdayOrderId: true } })).map((o: any) => o.shipdayOrderId);
      assert.equal(err, undefined, "la reconciliación no debe abortar por un pedido cerrado");
      assert.deepEqual(f.pedidos, ["rec-hoy"], "carga el abierto y omite el cerrado");
      assert.equal(r.checked, 2); assert.equal(r.created, 1); assert.deepEqual(r.skipped, ["rec-ayer"]);
    });
  } finally {
    globalThis.fetch = realFetch;
    await new Promise<void>(r => server.close(() => r()));
    fs.writeFileSync(path.join(__dirname, "claude-auditoria-final.json"), JSON.stringify(results, null, 2));
    console.log(`\nTOTAL ${results.length} · OK ${results.filter(r => r.ok).length} · FALLAS ${results.filter(r => !r.ok).length}`);
    await p.$disconnect();
    if (results.some(r => !r.ok)) process.exitCode = 1;
  }
}
main().catch(e => { console.error(e); process.exit(1); });
