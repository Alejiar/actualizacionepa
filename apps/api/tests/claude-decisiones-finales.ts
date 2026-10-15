/**
 * Las 3 decisiones finales del dueño (15-oct-2026):
 *   ORD — pedido manual con su fecha REAL de entrega, aunque el día tenga Cierre, si el mes sigue
 *         abierto: suma comisión y reportes, no toca efectivo/banco ni el conteo del Cierre.
 *   HR  — turno por hora que cruza medianoche: permitido solo con confirmación explícita
 *         (`confirmOvernight`), sin límite máximo; la tarifa queda congelada en el turno.
 *   WK  — renombrar / desactivar trabajadores sin perder historial; borrado físico solo admin y
 *         solo sin historial. Tarifas de clientes por hora editables (mismo permiso que antes).
 * Esperados calculados aquí a mano. SOLO contra la BD temporal local `cashbuddy_claude_decisiones`.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const u = new URL(process.env.DATABASE_URL || "invalid:");
if (u.pathname !== "/cashbuddy_claude_decisiones" || !["localhost", "127.0.0.1"].includes(u.hostname)) throw Error("Solo BD temporal local cashbuddy_claude_decisiones");

async function main() {
  const SRC = pathToFileURL(path.resolve(__dirname, "../src")).href;
  const { prisma: p } = await import(`${SRC}/lib/prisma.ts`);
  const { createServer } = await import(`${SRC}/server.ts`);
  const { signToken } = await import(`${SRC}/lib/jwt.ts`);
  const dash = await import(`${SRC}/services/shipday-dashboard.service.ts`);
  const days = await import(`${SRC}/services/day.service.ts`);
  const closes = await import(`${SRC}/services/close.service.ts`);
  const excel = await import(`${SRC}/services/excel.service.ts`);
  const { todayBogota, toBogotaDateStr } = await import(`${SRC}/lib/date-range.ts`);
  const ExcelJS = (await import("node:module")).createRequire(path.resolve(__dirname, "../package.json"))("exceljs");

  const today = todayBogota(), month = today.slice(0, 7);
  const dayBefore = (d: string, n = 1) => toBogotaDateStr(new Date(new Date(d + "T12:00:00-05:00").getTime() - n * 86400000));
  const yesterday = dayBefore(today);
  const prevMonthDay = toBogotaDateStr(new Date(new Date(month + "-01T12:00:00-05:00").getTime() - 86400000));
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any, init: any) => { if (!String(input).startsWith("http://127.0.0.1:")) throw Error("Red externa bloqueada"); return realFetch(input, init); }) as any;
  const server = createServer().listen(0, "127.0.0.1"); await new Promise<void>(r => server.once("listening", r));
  const origin = "http://127.0.0.1:" + (server.address() as any).port;
  let admin: any, oper: any, branch: any, A: any, B: any;
  const tok = (x: any) => signToken({ sub: x.id, email: x.email, name: x.name, role: x.role, tv: x.tokenVersion });
  async function api(route: string, method = "GET", body?: unknown, who: any = oper) {
    const r = await realFetch(origin + "/api" + route, { method, headers: { "Content-Type": "application/json", Authorization: "Bearer " + tok(who) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => null) as any };
  }
  async function ok(route: string, method = "GET", body?: unknown, who: any = oper) {
    const r = await api(route, method, body, who);
    if (r.status >= 300) throw Error(`${method} ${route} → ${r.status} ${JSON.stringify(r.body)}`);
    return r.body;
  }
  async function reset() {
    const tables = await p.$queryRawUnsafe(`SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename <> '_prisma_migrations'`) as any[];
    await p.$executeRawUnsafe("TRUNCATE TABLE " + tables.map((x: any) => '"' + x.tablename + '"').join(",") + " CASCADE");
    await p.settings.create({ data: { id: "singleton", initialCash: 100000, initialBank: 100000, setupComplete: true, termsAcceptedAt: new Date() } });
    admin = await p.user.create({ data: { email: "admin@dec.test", name: "Admin", role: "admin", passwordHash: "x" } });
    oper = await p.user.create({ data: { email: "oper@dec.test", name: "Operador", role: "user", passwordHash: "x" } });
    branch = await p.branch.create({ data: { name: "Sucursal", apiKeyEnc: "test-only" } });
    A = await p.driver.create({ data: { name: "Domi A", shipdayDriverId: "9001", branchId: branch.id } });
    B = await p.driver.create({ data: { name: "Domi B", shipdayDriverId: "9002", branchId: branch.id } });
  }
  const drv = (d: any) => p.driver.findUniqueOrThrow({ where: { id: d.id } });
  const bal = (date = today) => dash.getExpectedBalancesForDate(date);
  const closeDay = async (date: string) => {
    const e = await ok(`/shifts/${date}/expected`, "GET", undefined, admin);
    return ok("/shifts", "POST", { date, shift: "close", denominations: { bills: [{ value: 1, qty: e.expectedCash }], coins: [] }, bankCounted: e.expectedBank }, admin);
  };
  const order = (body: any, who: any = oper) => api("/sd/orders/manual", "POST", { branchId: branch.id, ...body }, who);
  const results: any[] = [];
  async function check(id: string, name: string, fn: (f: any) => Promise<void>) {
    await reset(); const f: any = {};
    try { await fn(f); results.push({ id, name, ok: true, f }); console.log("OK    " + id + " " + name); }
    catch (e) { results.push({ id, name, ok: false, f, error: String((e as Error).message).slice(0, 500) }); console.log("FALLA " + id + " " + name + "\n      " + JSON.stringify(f).slice(0, 400) + " " + String((e as Error).message).slice(0, 300)); }
  }

  try {
    // ═══════════════════ 1. Pedidos manuales después del Cierre ═══════════════════
    await check("ORD-M1", "Pedido manual antes del Cierre: 10.000 → comisión 3.000, caja igual", async f => {
      const r = await order({ driverId: A.id, deliveryValue: 10000 });
      f.r = [r.status, r.body.companyAmount]; assert.equal(r.status, 201); assert.equal(r.body.companyAmount, 3000);
      assert.equal((await drv(A)).pendingDebt, 3000);
      assert.deepEqual(await bal(), { cash: 100000, bank: 100000 });
    });
    await check("ORD-M2", "Ejemplo del dueño: Cierre y luego pedido de 40.000 del MISMO día → +12.000 comisión; caja, banco y conteo intactos; reportes y Excel lo incluyen", async f => {
      await ok("/sd/bases/" + B.id + "/give", "POST", { cashAmount: 5000 });            // algo de dinero en el día
      const close = await closeDay(today);
      const before = { bal: await bal(), debt: (await drv(A)).pendingDebt };
      const r = await order({ driverId: A.id, deliveryValue: 40000, orderNumber: "M2", deliveredAt: today });
      f.r = [r.status, r.body]; assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.equal(r.body.companyAmount, 12000);
      assert.equal(toBogotaDateStr(new Date(r.body.deliveredAt)), today, "fecha real de entrega");
      assert.equal((await drv(A)).pendingDebt, before.debt + 12000);
      assert.deepEqual(await bal(), before.bal, "efectivo y banco sin cambios");
      const sc = await p.shiftClose.findUniqueOrThrow({ where: { id: close.id } });
      assert.deepEqual([sc.totalCounted, sc.totalExpected, sc.difference, sc.bankDifference], [close.totalCounted, close.totalExpected, 0, 0], "conteo del Cierre intacto");
      const sum = await days.getDaySummary(today);
      f.sum = { comision: sum.comision, cuadrada: sum.cajaCuadrada, finalCash: sum.finalCash };
      assert.equal(sum.comision, 12000); assert.equal(sum.cajaCuadrada, true);
      const stat = await p.dailyDriverStat.findUniqueOrThrow({ where: { date_driverId: { date: today, driverId: A.id } } });
      assert.deepEqual([stat.orderCount, stat.totalValue, stat.companyTotal], [1, 40000, 12000]);
      const rep = await closes.getMonthlyReport(month); assert.equal(rep.totalSales, 12000);
      const wb = new ExcelJS.Workbook(); await wb.xlsx.load(await excel.buildMonthlyExcel(month) as any);
      const ws = wb.getWorksheet("CIERRE MES")!; let ventas: any = null;
      ws.eachRow((row: any) => { if (row.getCell(5).value === "TOTAL VENTAS") ventas = row.getCell(6).value; });
      assert.equal(ventas, 12000, "Excel: TOTAL VENTAS");
    });
    await check("ORD-M3", "Día ANTERIOR cerrado, mes abierto: se carga en ese día (mediodía), no en hoy", async f => {
      if (yesterday.slice(0, 7) !== month) { f.skip = "ayer es de otro mes"; return; }
      await closeDay(yesterday);
      const before = await bal(yesterday);
      const r = await order({ driverId: A.id, deliveryValue: 20000, deliveredAt: yesterday });
      f.r = r.status; assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.equal(toBogotaDateStr(new Date(r.body.deliveredAt)), yesterday);
      assert.ok(await p.dailyDriverStat.findUnique({ where: { date_driverId: { date: yesterday, driverId: A.id } } }));
      assert.equal(await p.dailyDriverStat.count({ where: { date: today } }), 0);
      assert.deepEqual(await bal(yesterday), before);
      assert.equal((await days.getDaySummary(yesterday)).comision, 6000);
    });
    await check("ORD-M4", "Mes cerrado: el pedido se rechaza con mensaje y no deja rastro", async f => {
      await closes.closeMonth(prevMonthDay.slice(0, 7));
      const r = await order({ driverId: A.id, deliveryValue: 10000, deliveredAt: prevMonthDay });
      f.r = [r.status, r.body.error]; assert.equal(r.status, 409); assert.match(r.body.error, /mes cerrado/);
      assert.equal(await p.shipdayOrder.count(), 0); assert.equal((await drv(A)).pendingDebt, 0);
    });
    await check("ORD-M5", "Tarifa cero, negativa, decimal, texto o fuera de rango → 400 sin efecto", async f => {
      f.r = [];
      for (const v of [0, -5000, 1500.5, "10000", 1e12, null]) f.r.push((await order({ driverId: A.id, deliveryValue: v })).status);
      assert.deepEqual(f.r, [400, 400, 400, 400, 400, 400]);
      assert.equal(await p.shipdayOrder.count(), 0);
    });
    await check("ORD-M6", "Duplicado: mismo número, sucursal y día → 409; otro día sí se permite", async f => {
      assert.equal((await order({ driverId: A.id, deliveryValue: 10000, orderNumber: "77" })).status, 201);
      const dup = await order({ driverId: A.id, deliveryValue: 10000, orderNumber: "77" });
      f.dup = [dup.status, dup.body.error]; assert.equal(dup.status, 409);
      if (yesterday.slice(0, 7) === month) assert.equal((await order({ driverId: A.id, deliveryValue: 10000, orderNumber: "77", deliveredAt: yesterday })).status, 201);
      assert.equal((await drv(A)).pendingDebt, yesterday.slice(0, 7) === month ? 6000 : 3000);
    });
    await check("ORD-M7", "Reintento (misma clave) y simultáneos: una sola comisión; dos pedidos distintos simultáneos suman bien", async f => {
      const key = "reintento-0001-abcd";
      const [r1, r2] = await Promise.all([order({ driverId: A.id, deliveryValue: 10000, idempotencyKey: key }), order({ driverId: A.id, deliveryValue: 10000, idempotencyKey: key })]);
      const r3 = await order({ driverId: A.id, deliveryValue: 10000, idempotencyKey: key });
      f.st = [r1.status, r2.status, r3.status].sort();
      assert.deepEqual(f.st, [200, 200, 201]);
      assert.equal(await p.shipdayOrder.count(), 1); assert.equal((await drv(A)).pendingDebt, 3000);
      await Promise.all([order({ driverId: B.id, deliveryValue: 20000 }), order({ driverId: B.id, deliveryValue: 30000 })]);
      assert.equal((await drv(B)).pendingDebt, 15000);
      assert.equal((await p.dailyDriverStat.findUniqueOrThrow({ where: { date_driverId: { date: today, driverId: B.id } } })).orderCount, 2);
    });
    await check("ORD-M8", "Domiciliario o sucursal desactivados → 400 con mensaje, sin efecto", async f => {
      await p.driver.update({ where: { id: A.id }, data: { active: false } });
      const r1 = await order({ driverId: A.id, deliveryValue: 10000 });
      await p.branch.update({ where: { id: branch.id }, data: { active: false } });
      const r2 = await order({ driverId: B.id, deliveryValue: 10000 });
      f.r = [r1.status, r1.body.error, r2.status, r2.body.error];
      assert.equal(r1.status, 400); assert.match(r1.body.error, /desactivado/);
      assert.equal(r2.status, 400); assert.match(r2.body.error, /desactivada/);
      assert.equal(await p.shipdayOrder.count(), 0);
    });
    await check("ORD-M9", "Fecha futura o inexistente → 400", async f => {
      const fut = toBogotaDateStr(new Date(Date.now() + 2 * 86400000));
      f.r = [(await order({ deliveryValue: 10000, deliveredAt: fut })).status, (await order({ deliveryValue: 10000, deliveredAt: "2026-02-31" })).status, (await order({ deliveryValue: 10000, deliveredAt: "ayer" })).status];
      assert.deepEqual(f.r, [400, 400, 400]);
    });
    await check("ORD-M10", "D7 sigue intacto: tras el Cierre, una base (sí mueve dinero) sigue rechazada", async f => {
      await closeDay(today);
      const r = await api(`/sd/bases/${A.id}/give`, "POST", { cashAmount: 1000 });
      f.r = r.status; assert.equal(r.status, 409);
      assert.equal((await order({ driverId: A.id, deliveryValue: 10000 })).status, 201);
    });
    await check("ORD-M11", "Pedido después del Cierre vinculado a cliente: deuda FIADA, caja intacta", async f => {
      const cli = await ok("/clients", "POST", { name: "Cliente pedido" });
      await closeDay(today); const before = await bal();
      const r = await order({ driverId: A.id, deliveryValue: 8000, clientId: cli.id, addToClientDebt: true });
      assert.equal(r.status, 201);
      assert.equal((await p.client.findUniqueOrThrow({ where: { id: cli.id } })).pendingDebt, 8000);
      const debt = await p.clientDebt.findFirstOrThrow({ where: { clientId: cli.id } }); f.medium = debt.medium;
      assert.equal(debt.medium, null); assert.deepEqual(await bal(), before);
    });

    // ═══════════════════ 2. Turnos que cruzan medianoche ═══════════════════
    const hc = async (d = 12000, c = 6000) => ok("/hourly-clients", "POST", { name: "Tienda", driverHourValue: d, companyHourValue: c });
    const shift = (cid: string, body: any, who: any = oper) => api(`/hourly-clients/${cid}/shifts`, "POST", { driverId: A.id, date: today, medium: "cash", ...body }, who);
    await check("HR-1", "Turno normal 08:00–10:00: 2 h, efectivo −24.000, deuda +36.000, tarifa congelada", async f => {
      const c = await hc(); const r = await shift(c.id, { startTime: "08:00", endTime: "10:00" });
      f.r = r.body; assert.equal(r.status, 201);
      assert.deepEqual([r.body.minutes, r.body.driverAmount, r.body.companyAmount, r.body.totalAmount, r.body.driverHourValue, r.body.companyHourValue], [120, 24000, 12000, 36000, 12000, 6000]);
      assert.deepEqual(await bal(), { cash: 76000, bank: 100000 });
      assert.equal((await p.hourlyClient.findUniqueOrThrow({ where: { id: c.id } })).pendingDebt, 36000);
    });
    await check("HR-2", "Nocturno 22:00–00:00 (2 h): sin confirmar → 409 con detalle y nada cambia; confirmado → se registra", async f => {
      const c = await hc(); const r1 = await shift(c.id, { startTime: "22:00", endTime: "00:00" });
      f.r1 = [r1.status, r1.body]; assert.equal(r1.status, 409);
      assert.equal(r1.body.details.code, "OVERNIGHT_CONFIRMATION_REQUIRED"); assert.equal(r1.body.details.minutes, 120);
      assert.equal(await p.hourlyShift.count(), 0); assert.deepEqual(await bal(), { cash: 100000, bank: 100000 });
      const r2 = await shift(c.id, { startTime: "22:00", endTime: "00:00", confirmOvernight: true });
      assert.equal(r2.status, 201); assert.equal(r2.body.minutes, 120); assert.equal(r2.body.date, today);
      assert.deepEqual(await bal(), { cash: 76000, bank: 100000 });
    });
    await check("HR-3", "Ejemplo del dueño 10:00 → 09:00: aviso de 23 horas con valores; confirmado = 1.380 min", async f => {
      const c = await hc(); const r1 = await shift(c.id, { startTime: "10:00", endTime: "09:00" });
      f.msg = r1.body.error; assert.equal(r1.status, 409); assert.match(r1.body.error, /termina mañana .* 23 horas/);
      assert.deepEqual([r1.body.details.driverAmount, r1.body.details.companyAmount, r1.body.details.totalAmount], [276000, 138000, 414000]);
      assert.equal(r1.body.details.startDate, today);
      const r2 = await shift(c.id, { startTime: "10:00", endTime: "09:00", confirmOvernight: true, medium: "bank" });
      assert.equal(r2.status, 201); assert.equal(r2.body.minutes, 1380);
      assert.deepEqual(await bal(), { cash: 100000, bank: 100000 - 276000 });
      assert.equal((await p.hourlyClient.findUniqueOrThrow({ where: { id: c.id } })).pendingDebt, 414000);
    });
    await check("HR-4", "Entrada = salida, hora/fecha inválidas, fecha futura, confirmación no booleana → rechazos sin efecto", async f => {
      const c = await hc();
      f.r = [
        (await shift(c.id, { startTime: "10:00", endTime: "10:00" })).status,
        (await shift(c.id, { startTime: "25:00", endTime: "10:00" })).status,
        (await shift(c.id, { startTime: "ab", endTime: "10:00" })).status,
        (await shift(c.id, { startTime: "08:00", endTime: "09:00", date: "2026-02-30" })).status,
        (await shift(c.id, { startTime: "08:00", endTime: "09:00", date: toBogotaDateStr(new Date(Date.now() + 2 * 86400000)) })).status,
        (await shift(c.id, { startTime: "22:00", endTime: "01:00", confirmOvernight: "true" })).status,
      ];
      assert.deepEqual(f.r, [400, 400, 400, 400, 400, 409]);
      assert.equal(await p.hourlyShift.count(), 0); assert.deepEqual(await bal(), { cash: 100000, bank: 100000 });
    });
    await check("HR-5", "Duplicado (doble clic y simultáneo): un solo turno y un solo pago", async f => {
      const c = await hc();
      const rs = await Promise.all([shift(c.id, { startTime: "08:00", endTime: "09:00" }), shift(c.id, { startTime: "08:00", endTime: "09:00" })]);
      f.st = rs.map(r => r.status).sort(); assert.deepEqual(f.st, [201, 409]);
      assert.equal(await p.hourlyShift.count(), 1); assert.deepEqual(await bal(), { cash: 88000, bank: 100000 });
    });
    await check("HR-6", "Turno de un mes cerrado → 409", async f => {
      await closes.closeMonth(prevMonthDay.slice(0, 7));
      const c = await hc(); const r = await shift(c.id, { startTime: "08:00", endTime: "09:00", date: prevMonthDay });
      f.r = [r.status, r.body.error]; assert.equal(r.status, 409); assert.equal(await p.hourlyShift.count(), 0);
    });
    await check("HR-7", "Tarifa: se valida; al cambiarla, turnos viejos y deuda NO cambian; editar uno viejo usa su tarifa; nuevos usan la nueva", async f => {
      const c = await hc(12000, 6000);
      const old = (await shift(c.id, { startTime: "08:00", endTime: "10:00" })).body;          // 24.000 / 36.000
      assert.equal((await api(`/hourly-clients/${c.id}`, "PATCH", { driverHourValue: -1 })).status, 400);
      assert.equal((await api(`/hourly-clients/${c.id}`, "PATCH", { driverHourValue: 0, companyHourValue: 0 })).status, 400);
      assert.equal((await api(`/hourly-clients/${c.id}`, "PATCH", { driverHourValue: 1.5 })).status, 400);
      await ok(`/hourly-clients/${c.id}`, "PATCH", { driverHourValue: 20000, companyHourValue: 10000 });
      const s0 = await p.hourlyShift.findUniqueOrThrow({ where: { id: old.id } });
      assert.deepEqual([s0.driverAmount, s0.totalAmount], [24000, 36000]);
      assert.equal((await p.hourlyClient.findUniqueOrThrow({ where: { id: c.id } })).pendingDebt, 36000);
      await ok(`/hourly-shifts/${old.id}`, "PATCH", { endTime: "11:00" }, admin);                    // 3 h a 12.000/6.000
      const s1 = await p.hourlyShift.findUniqueOrThrow({ where: { id: old.id } });
      assert.deepEqual([s1.minutes, s1.driverAmount, s1.companyAmount, s1.totalAmount], [180, 36000, 18000, 54000]);
      const nw = (await shift(c.id, { driverId: B.id, startTime: "08:00", endTime: "10:00" })).body;   // 2 h a 20.000/10.000
      assert.deepEqual([nw.driverAmount, nw.totalAmount, nw.driverHourValue], [40000, 60000, 20000]);
      assert.equal((await p.hourlyClient.findUniqueOrThrow({ where: { id: c.id } })).pendingDebt, 54000 + 60000);
      assert.deepEqual(await bal(), { cash: 100000 - 36000 - 40000, bank: 100000 });
    });
    await check("HR-8", "Editar a nocturno: admin sin confirmar 409, confirmado OK; solicitud del operador exige la confirmación y se aplica al aprobar", async f => {
      const c = await hc(); const s = (await shift(c.id, { startTime: "08:00", endTime: "10:00" })).body;
      assert.equal((await api(`/hourly-shifts/${s.id}`, "PATCH", { endTime: "07:00" }, admin)).status, 409);
      await ok(`/hourly-shifts/${s.id}`, "PATCH", { endTime: "07:00", confirmOvernight: true }, admin);
      assert.equal((await p.hourlyShift.findUniqueOrThrow({ where: { id: s.id } })).minutes, 1380);
      const s2 = (await shift(c.id, { driverId: B.id, startTime: "08:00", endTime: "10:00" })).body;
      const noConf = await api("/edit-requests", "POST", { entityType: "HourlyShift", entityId: s2.id, entityLabel: "Turno", changes: { endTime: { old: "10:00", new: "01:00" } }, reason: "x" });
      f.noConf = noConf.status; assert.equal(noConf.status, 409);
      const req = await ok("/edit-requests", "POST", { entityType: "HourlyShift", entityId: s2.id, entityLabel: "Turno", changes: { endTime: { old: "10:00", new: "01:00" }, confirmOvernight: { old: "", new: "true" } }, reason: "terminó a la 1" });
      await ok(`/edit-requests/${req.id}/review`, "POST", { action: "approved" }, admin);
      const s2b = await p.hourlyShift.findUniqueOrThrow({ where: { id: s2.id } });
      assert.deepEqual([s2b.minutes, s2b.driverAmount], [1020, 204000]);       // 08:00 → 01:00 = 17 h × 12.000
    });
    await check("HR-9", "Cliente o domiciliario desactivados → 400", async f => {
      const c = await hc(); await p.hourlyClient.update({ where: { id: c.id }, data: { active: false } });
      const r1 = await shift(c.id, { startTime: "08:00", endTime: "09:00" });
      const c2 = await hc(); await p.driver.update({ where: { id: A.id }, data: { active: false } });
      const r2 = await shift(c2.id, { startTime: "08:00", endTime: "09:00" });
      f.r = [r1.status, r2.status]; assert.deepEqual(f.r, [400, 400]); assert.equal(await p.hourlyShift.count(), 0);
    });
    await check("HR-10", "Reportes: el turno nocturno pagado por banco sale en Movimientos y en el resumen del día", async f => {
      const c = await hc(); await shift(c.id, { startTime: "20:00", endTime: "02:00", confirmOvernight: true, medium: "bank" });   // 6 h → 72.000
      const sum = await days.getDaySummary(today); f.sum = [sum.finalCash, sum.finalBank];
      assert.deepEqual(f.sum, [100000, 28000]);
      const movs = await ok(`/movements/unified?from=${today}&to=${today}`) as any[];
      assert.ok(movs.some(m => m.type === "egreso" && m.medium === "bank" && m.amount === 72000));
    });

    // ═══════════════════ 3. Trabajadores ═══════════════════
    const worker = (name: string, role = "administrativo") => ok("/workers", "POST", { name, role, active: true });
    const pay = (w: any, amount = 5000) => api("/movements", "POST", { date: today, category: 15, type: "egreso", medium: "cash", amount, workerId: w.id, description: "Nómina" });
    await check("WK-1", "Renombrar: mismo id; pagos siguen enlazados; sin duplicar; nombre limpio", async f => {
      const w = await worker("Ana Pérez"); assert.equal((await pay(w)).status, 201);
      const r = await ok(`/workers/${w.id}`, "PATCH", { name: "  Ana   María Pérez " });
      assert.equal(r.id, w.id); assert.equal(r.name, "Ana María Pérez");
      assert.equal(await p.worker.count(), 1);
      assert.equal(await p.movement.count({ where: { workerId: w.id } }), 1);
    });
    await check("WK-2", "Validación del nombre: vacío, espacios, >80, repetido (sin importar mayúsculas)", async f => {
      const w = await worker("Luis"); await worker("Carlos");
      f.r = [
        (await api(`/workers/${w.id}`, "PATCH", { name: "" }, admin)).status,
        (await api(`/workers/${w.id}`, "PATCH", { name: "   " }, admin)).status,
        (await api(`/workers/${w.id}`, "PATCH", { name: "x".repeat(81) }, admin)).status,
        (await api(`/workers/${w.id}`, "PATCH", { name: "CARLOS" }, admin)).status,
        (await api("/workers", "POST", { name: "carlos", role: "administrativo", active: true })).status,
      ];
      assert.deepEqual(f.r, [400, 400, 400, 409, 409]);
      assert.equal((await p.worker.findUniqueOrThrow({ where: { id: w.id } })).name, "Luis");
    });
    await check("WK-3", "Desactivar: conserva historial, bloquea pagos nuevos; reactivar los permite", async f => {
      const w = await worker("Rosa"); await pay(w, 7000);
      await ok(`/workers/${w.id}`, "PATCH", { active: false });
      const r = await pay(w); f.r = [r.status, r.body.error]; assert.equal(r.status, 400);
      assert.equal(await p.movement.count({ where: { workerId: w.id } }), 1);
      await ok(`/workers/${w.id}`, "PATCH", { active: true });
      assert.equal((await pay(w)).status, 201);
      assert.deepEqual(await bal(), { cash: 100000 - 7000 - 5000, bank: 100000 });
    });
    await check("WK-4", "Eliminar: operador 403; con historial → 409 y se conserva; sin historial → admin lo elimina", async f => {
      const w = await worker("Con historia"); await pay(w); const v = await worker("Sin historia");
      const r1 = await api(`/workers/${w.id}`, "DELETE", undefined, admin);
      f.r1 = [r1.status, r1.body?.error]; assert.equal(r1.status, 409);
      assert.ok(await p.worker.findUnique({ where: { id: w.id } }));
      assert.equal((await api(`/workers/${v.id}`, "DELETE", undefined, oper)).status, 403);
      assert.equal((await api(`/workers/${v.id}`, "DELETE", undefined, admin)).status, 204);
      assert.equal(await p.worker.count(), 1);
    });
  } finally {
    globalThis.fetch = realFetch;
    await new Promise<void>(r => server.close(() => r()));
    fs.writeFileSync(path.join(__dirname, "claude-decisiones-finales.json"), JSON.stringify(results, null, 2));
    console.log(`\nTOTAL ${results.length} · OK ${results.filter(r => r.ok).length} · FALLAS ${results.filter(r => !r.ok).length}`);
    await p.$disconnect();
    if (results.some(r => !r.ok)) process.exitCode = 1;
  }
}
main().catch(e => { console.error(e); process.exit(1); });
