/**
 * Reglas aprobadas por el dueño el 14-oct-2026 (CLAUDE_COBERTURA / CLAUDE.md):
 *   F14 — base y comisiones son cuentas independientes; el operador divide cada pago;
 *         crédito y base NO se compensan; el total combinado es solo informativo.
 *   D7  — un día con Cierre se corrige (editar, eliminar o agregar) solo por solicitud
 *         aprobada, mientras el mes esté abierto; el conteo original del Cierre no cambia.
 *   ORD — un pedido de Shipday entregado después del Cierre de su día se carga en su día.
 * Valores esperados calculados aquí, de forma independiente. SOLO contra la BD temporal local
 * `cashbuddy_claude_f14`, migrada. Red externa bloqueada; Shipday simulado.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { realCount } from "./real-count";

const u = new URL(process.env.DATABASE_URL || "invalid:");
if (u.pathname !== "/cashbuddy_claude_f14" || !["localhost", "127.0.0.1"].includes(u.hostname)) throw Error("Solo BD temporal local cashbuddy_claude_f14");

async function main() {
  const SRC = pathToFileURL(path.resolve(__dirname, "../src")).href;
  const { prisma: p } = await import(`${SRC}/lib/prisma.ts`);
  const { createServer } = await import(`${SRC}/server.ts`);
  const { signToken } = await import(`${SRC}/lib/jwt.ts`);
  const dash = await import(`${SRC}/services/shipday-dashboard.service.ts`);
  const days = await import(`${SRC}/services/day.service.ts`);
  const closes = await import(`${SRC}/services/close.service.ts`);
  const excel = await import(`${SRC}/services/excel.service.ts`);
  const branchSvc = await import(`${SRC}/services/branch.service.ts`);
  const { todayBogota, toBogotaDateStr } = await import(`${SRC}/lib/date-range.ts`);
  const ExcelJS = (await import("node:module")).createRequire(path.resolve(__dirname, "../package.json"))("exceljs");

  const today = todayBogota(), month = today.slice(0, 7);
  const dayBefore = (d: string, n = 1) => toBogotaDateStr(new Date(new Date(d + "T12:00:00-05:00").getTime() - n * 86400000));
  const yesterday = dayBefore(today), twoAgo = dayBefore(today, 2);
  const prevMonthLast = toBogotaDateStr(new Date(new Date(month + "-01T12:00:00-05:00").getTime() - 86400000));
  const realFetch = globalThis.fetch;
  const blocked = (async (input: any, init: any) => { if (!String(input).startsWith("http://127.0.0.1:")) throw Error("Red externa bloqueada"); return realFetch(input, init); }) as any;
  globalThis.fetch = blocked;
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
  const hook = (body: unknown) => realFetch(origin + "/api/webhooks/shipday/" + branch.id, { method: "POST", headers: { "Content-Type": "application/json", token: process.env.WEBHOOK_TOKEN! }, body: JSON.stringify(body) });
  async function reset() {
    const tables = await p.$queryRawUnsafe(`SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename <> '_prisma_migrations'`) as any[];
    await p.$executeRawUnsafe("TRUNCATE TABLE " + tables.map((x: any) => '"' + x.tablename + '"').join(",") + " CASCADE");
    await p.settings.create({ data: { id: "singleton", initialCash: 100000, initialBank: 100000, setupComplete: true, termsAcceptedAt: new Date() } });
    admin = await p.user.create({ data: { email: "admin@f14.test", name: "Admin", role: "admin", passwordHash: "x" } });
    oper = await p.user.create({ data: { email: "oper@f14.test", name: "Operador", role: "user", passwordHash: "x" } });
    branch = await p.branch.create({ data: { name: "Sucursal", apiKeyEnc: "test-only" } });
    A = await p.driver.create({ data: { name: "Domi A", shipdayDriverId: "8001", branchId: branch.id } });
    B = await p.driver.create({ data: { name: "Domi B", shipdayDriverId: "8002", branchId: branch.id } });
  }
  const order = (driver: any, value: number) => ok("/sd/orders/manual", "POST", { branchId: branch.id, driverId: driver.id, deliveryValue: value });
  const drv = (d: any) => p.driver.findUniqueOrThrow({ where: { id: d.id } });
  const bal = () => dash.getExpectedBalancesForDate(today);
  const basePending = async (d: any) => (await ok(`/sd/drivers/${d.id}`)).basePending as number;
  const closeDay = async (date: string) => {
    const e = await ok(`/shifts/${date}/expected`, "GET", undefined, admin);
    return ok("/shifts", "POST", { date, shift: "close", denominations: realCount(e.expectedCash), bankCounted: e.expectedBank }, admin);
  };
  const results: any[] = [];
  async function check(id: string, name: string, fn: (f: any) => Promise<void>) {
    await reset(); const f: any = {};
    try { await fn(f); results.push({ id, name, ok: true, f }); console.log("OK    " + id + " " + name); }
    catch (e) { results.push({ id, name, ok: false, f, error: String((e as Error).message).slice(0, 500) }); console.log("FALLA " + id + " " + name + "\n      " + JSON.stringify(f).slice(0, 400) + " " + String((e as Error).message).slice(0, 300)); }
    finally { globalThis.fetch = blocked; }
  }

  try {
    // ════════════════════════════ F14 ════════════════════════════
    await check("F14-A", "Caso A: comisión 100.000, paga 30.000 → queda 70.000 y entra 30.000 a caja", async f => {
      await order(A, 333333);                                   // 30 % = 99.999,9 → 100.000
      assert.equal((await drv(A)).pendingDebt, 100000);
      await ok(`/sd/drivers/${A.id}/payment`, "POST", { amount: 30000, medium: "cash" });
      const d = await drv(A); f.deuda = d.pendingDebt;
      assert.deepEqual([d.pendingDebt, d.creditAmount, await basePending(A)], [70000, 0, 0]);
      assert.deepEqual(await bal(), { cash: 130000, bank: 100000 });
      assert.equal((await closes.getMonthlyReport(month)).commission.pending, 70000);
    });
    await check("F14-B", "Caso B: base 50.000 y comisión 20.000 separadas; total informativo 70.000 en todas las vistas", async f => {
      await ok(`/sd/bases/${A.id}/give`, "POST", { cashAmount: 50000 });
      await order(A, 66667);                                    // 20.000
      const d = await drv(A);
      assert.equal(d.pendingDebt, 20000, "la base NO suma a la deuda por comisiones");
      assert.equal(await basePending(A), 50000);
      const list = (await ok("/sd/drivers")).find((x: any) => x.id === A.id);
      const st = await ok(`/sd/drivers/${A.id}/statement`);
      const debts = await ok("/sd/dashboard/debts");
      const row = debts.debtors.find((x: any) => x.id === A.id);
      const rep = await closes.getMonthlyReport(month);
      Object.assign(f, { list: [list.pendingDebt, list.basePending, list.totalInformativo], st: [st.pendingDebt, st.basePending, st.totalInformativo], row: [row.commissionDebt, row.basePending, row.totalInformativo], rep: [rep.commission.pending, rep.bases.diff, rep.debtReconciliation.total] });
      for (const v of [f.list, f.st, f.row, f.rep]) assert.deepEqual(v, [20000, 50000, 70000]);
      assert.deepEqual(await bal(), { cash: 50000, bank: 100000 });
      const wb = new ExcelJS.Workbook(); await wb.xlsx.load(await excel.buildMonthlyExcel(month) as any);
      const ws = wb.getWorksheet("Domiciliarios")!; let xr: any[] = [];
      ws.eachRow((r: any) => { if (r.getCell(2).value === "Domi A") xr = [r.getCell(4).value, r.getCell(5).value, r.getCell(6).value, r.getCell(7).value]; });
      f.excel = xr; assert.deepEqual(xr, [20000, 0, 50000, 70000]);
    });
    await check("F14-C1", "Pagar comisiones NO devuelve base", async () => {
      await ok(`/sd/bases/${A.id}/give`, "POST", { cashAmount: 50000 }); await order(A, 66667);
      await ok(`/sd/drivers/${A.id}/payment`, "POST", { amount: 20000, medium: "bank" });
      assert.deepEqual([(await drv(A)).pendingDebt, await basePending(A)], [0, 50000]);
      assert.deepEqual(await bal(), { cash: 50000, bank: 120000 });
    });
    await check("F14-C2", "Devolver base NO paga comisiones", async () => {
      await ok(`/sd/bases/${A.id}/give`, "POST", { cashAmount: 50000 }); await order(A, 66667);
      await ok(`/sd/bases/${A.id}/pay`, "POST", { cashAmount: 30000 });
      assert.deepEqual([(await drv(A)).pendingDebt, await basePending(A)], [20000, 20000]);
      assert.deepEqual(await bal(), { cash: 80000, bank: 100000 });
    });
    await check("F14-C", "Caso C: base pendiente + comisión + crédito: no se compensan ni hay doble descuento", async f => {
      await ok(`/sd/bases/${A.id}/give`, "POST", { cashAmount: 50000 }); await order(A, 66667);
      const r = await ok(`/sd/drivers/${A.id}/payment`, "POST", { amount: 30000, medium: "cash" }); // 10.000 de más
      let d = await drv(A); f.trasPago = [d.pendingDebt, d.creditAmount, await basePending(A), r.commissionAlloc, r.baseAlloc];
      assert.deepEqual(f.trasPago, [0, 10000, 50000, 30000, 0]);
      const debts = await ok("/sd/dashboard/debts");
      assert.ok(debts.debtors.some((x: any) => x.id === A.id), "debe base → aparece entre los que deben");
      assert.ok(debts.creditors.some((x: any) => x.id === A.id), "tiene crédito → aparece entre a quienes se debe");
      await ok(`/sd/drivers/${A.id}/pay-credit`, "POST", { medium: "cash" });   // la empresa le paga el crédito
      d = await drv(A); f.trasCredito = [d.pendingDebt, d.creditAmount, await basePending(A)];
      assert.deepEqual(f.trasCredito, [0, 0, 50000]);
      assert.deepEqual(await bal(), { cash: 100000 - 50000 + 30000 - 10000, bank: 100000 });
      const rep = await closes.getMonthlyReport(month);
      assert.deepEqual([rep.bases.diff, rep.commission.pending, rep.commission.credit, rep.debtReconciliation.total], [50000, 0, 0, 50000]);
    });
    await check("F14-D", "Caso D: deuda grande con abonos sucesivos hasta liquidar", async () => {
      await order(A, 333333);
      for (const [amt, med, left] of [[25000, "bank", 75000], [25000, "cash", 50000], [50000, "cash", 0]] as const) {
        await ok(`/sd/drivers/${A.id}/payment`, "POST", { amount: amt, medium: med });
        assert.equal((await drv(A)).pendingDebt, left);
      }
      assert.deepEqual(await bal(), { cash: 175000, bank: 125000 });
      assert.equal((await closes.getMonthlyReport(month)).commission.pending, 0);
    });
    await check("F14-SPLIT", "Pago dividido por el operador; borrarlo revierte cada cuenta por separado", async f => {
      await ok(`/sd/bases/${A.id}/give`, "POST", { cashAmount: 50000 }); await order(A, 66667);
      const r = await ok(`/sd/drivers/${A.id}/payment`, "POST", { amount: 45000, medium: "cash", baseAmount: 30000 });
      f.split = [r.commissionAlloc, r.baseAlloc];
      assert.deepEqual([(await drv(A)).pendingDebt, await basePending(A)], [5000, 20000]);
      assert.deepEqual(await bal(), { cash: 95000, bank: 100000 });
      const tx = await p.bankTransaction.findFirstOrThrow({ where: { driverId: A.id } });
      assert.equal(tx.amount, 45000); assert.equal(await p.bankTransaction.count(), 1, "un solo movimiento de caja por el total");
      assert.equal((await api(`/bank-transactions/${tx.id}`, "DELETE", undefined, admin)).status, 200);
      assert.deepEqual([(await drv(A)).pendingDebt, (await drv(A)).creditAmount, await basePending(A)], [20000, 0, 50000]);
      assert.deepEqual(await bal(), { cash: 50000, bank: 100000 });
    });
    await check("F14-VAL", "Reparto inválido se rechaza sin efectos", async f => {
      await ok(`/sd/bases/${A.id}/give`, "POST", { cashAmount: 10000 }); await order(A, 66667);
      f.estados = [];
      for (const body of [{ amount: 20000, baseAmount: 15000 }, { amount: 5000, baseAmount: 6000 }, { amount: 5000, baseAmount: -1 }, { amount: 5000, baseAmount: 1.5 }, { amount: 5000, baseAmount: "1000" }]) {
        f.estados.push((await api(`/sd/drivers/${A.id}/payment`, "POST", { ...body, medium: "cash" })).status);
      }
      assert.deepEqual(f.estados, [400, 400, 400, 400, 400]);
      assert.deepEqual([(await drv(A)).pendingDebt, await basePending(A), await p.bankTransaction.count()], [20000, 10000, 0]);
    });
    await check("F14-BANK", "Descontar de deuda un ingreso bancario con reparto; borrarlo restaura ambas cuentas", async () => {
      await ok(`/sd/bases/${A.id}/give`, "POST", { bankAmount: 20000 }); await order(A, 133333); // 40.000
      const inc = await ok("/bank-transactions", "POST", { type: "ingreso", medium: "bank", amount: 40000, description: "Consignación", noCounterpart: true });
      const r = await ok(`/bank-transactions/${inc.id}/apply-to-driver`, "POST", { driverId: A.id, baseAmount: 10000 });
      assert.deepEqual([r.baseAlloc, r.commissionAlloc], [10000, 30000]);
      assert.deepEqual([(await drv(A)).pendingDebt, await basePending(A)], [10000, 10000]);
      assert.deepEqual(await bal(), { cash: 100000, bank: 120000 });
      assert.equal((await api(`/bank-transactions/${inc.id}/apply-to-driver`, "POST", { driverId: A.id }, oper)).status, 400, "no se aplica dos veces");
      assert.equal((await api(`/bank-transactions/${inc.id}`, "DELETE", undefined, admin)).status, 200);
      assert.deepEqual([(await drv(A)).pendingDebt, await basePending(A)], [40000, 20000]);
      assert.deepEqual(await bal(), { cash: 100000, bank: 80000 });
    });
    await check("F14-MIX", "Bases en efectivo, banco y mixtas; varias devoluciones; caja, banco y Excel por medio", async f => {
      await ok(`/sd/bases/${A.id}/give`, "POST", { cashAmount: 30000, bankAmount: 20000 });
      await ok(`/sd/bases/${A.id}/give`, "POST", { cashAmount: 10000 });
      await ok(`/sd/bases/${A.id}/pay`, "POST", { bankAmount: 15000 });
      await ok(`/sd/bases/${A.id}/pay`, "POST", { cashAmount: 25000 });
      assert.equal(await basePending(A), 60000 - 40000);
      assert.deepEqual(await bal(), { cash: 100000 - 40000 + 25000, bank: 100000 - 20000 + 15000 });
      const wb = new ExcelJS.Workbook(); await wb.xlsx.load(await excel.buildMonthlyExcel(month) as any);
      const ws = wb.getWorksheet("CIERRE MES")!; const row = (n: number) => [ws.getRow(n).getCell(2).value, ws.getRow(n).getCell(3).value];
      f.excel = [row(5), row(6)]; assert.deepEqual(f.excel, [[40000, 20000], [25000, 15000]]);
      assert.equal((await drv(A)).pendingDebt, 0, "las bases no tocan comisiones");
    });
    await check("F14-MES", "Base de un mes devuelta en otro: saldo anterior + entregadas − devueltas", async f => {
      const b = await ok(`/sd/bases/${A.id}/give`, "POST", { cashAmount: 40000 });
      await p.baseTransaction.update({ where: { id: b.id }, data: { date: new Date(prevMonthLast + "T12:00:00-05:00") } });
      await ok(`/sd/bases/${A.id}/pay`, "POST", { cashAmount: 15000 });
      const cur = await closes.getMonthlyReport(month), prev = await closes.getMonthlyReport(prevMonthLast.slice(0, 7));
      f.cur = [cur.bases.previous, cur.bases.given, cur.bases.returned, cur.bases.diff]; f.prev = [prev.bases.previous, prev.bases.given, prev.bases.returned, prev.bases.diff];
      assert.deepEqual(f.cur, [40000, 0, 15000, 25000]); assert.deepEqual(f.prev, [0, 40000, 0, 40000]);
    });
    await check("F14-CONC", "Dos devoluciones de base simultáneas no devuelven más de lo pendiente", async f => {
      await ok(`/sd/bases/${A.id}/give`, "POST", { cashAmount: 50000 });
      const st = await Promise.all([1, 2].map(() => api(`/sd/bases/${A.id}/pay`, "POST", { cashAmount: 30000 })));
      f.estados = st.map(x => x.status).sort(); assert.deepEqual(f.estados, [201, 400]);
      assert.equal(await basePending(A), 20000); assert.deepEqual(await bal(), { cash: 80000, bank: 100000 });
    });
    await check("MOV-PARTS", "Movimientos: base mixta, cobro dividido y conversión cuadran por medio con la caja real", async f => {
      await ok(`/sd/bases/${A.id}/give`, "POST", { cashAmount: 7000, bankAmount: 3000 });
      await ok("/sd/conversions", "POST", { branchId: branch.id, amount: 7000, type: "efectivo_a_banco" });
      const cli = await ok("/clients", "POST", { name: "Cliente partes" });
      await ok(`/clients/${cli.id}/debt`, "POST", { description: "Fiado", amount: 9000 });
      await ok(`/clients/${cli.id}/pay`, "POST", { cashAmount: 5000, bankAmount: 4000 });
      // Esperado calculado a mano: efectivo −7.000 −7.000 +5.000; banco −3.000 +7.000 +4.000.
      const exp = { cash: 100000 - 7000 - 7000 + 5000, bank: 100000 - 3000 + 7000 + 4000 };
      assert.deepEqual(await bal(), exp);
      const movs = await ok(`/movements/unified?from=${today}&to=${today}`) as any[];
      const net = { cash: 0, bank: 0 };
      for (const m of movs) for (const pt of m.parts ?? [{ type: m.type, medium: m.medium, amount: m.amount }]) net[pt.medium as "cash" | "bank"] += pt.type === "ingreso" ? pt.amount : -pt.amount;
      f.net = net; f.parts = movs.filter(m => m.parts).map(m => [m.source, m.parts]);
      assert.deepEqual(net, { cash: exp.cash - 100000, bank: exp.bank - 100000 });
      // El cobro dividido ya se guarda como un ClientDebtPayment por medio; la base mixta y la
      // conversión son un solo registro con dos medios y por eso llevan desglose.
      assert.deepEqual(f.parts.map((x: any) => x[0]).sort(), ["Bases", "Conversión"]);
    });
    await check("USR-ADMIN", "Nunca queda el sistema sin un administrador activo (desactivar, quitar rol, eliminar)", async f => {
      const r1 = await api(`/users/${admin.id}`, "PATCH", { active: false }, admin);
      const r2 = await api(`/users/${admin.id}`, "PATCH", { role: "user" }, admin);
      const r3 = await api(`/users/${admin.id}`, "DELETE", undefined, admin);
      f.solo = [r1.status, r2.status, r3.status];
      assert.deepEqual(f.solo, [400, 400, 400]);
      assert.equal((await p.user.findUniqueOrThrow({ where: { id: admin.id } })).active, true);
      // Con un segundo admin activo sí se permite (y el operador nunca puede: 403).
      const admin2 = await p.user.create({ data: { email: "admin2@f14.test", name: "Admin 2", role: "admin", passwordHash: "x" } });
      assert.equal((await api(`/users/${admin2.id}`, "PATCH", { active: false }, oper)).status, 403);
      assert.equal((await api(`/users/${admin2.id}`, "PATCH", { active: false }, admin)).status, 200);
      assert.equal((await api(`/users/${admin.id}`, "PATCH", { active: false }, admin)).status, 400, "admin2 ya está inactivo");
      await p.user.update({ where: { id: admin2.id }, data: { active: true } });
      assert.equal((await api(`/users/${admin2.id}`, "DELETE", undefined, admin)).status, 200);
    });
    await check("F14-INACT", "Domiciliario inactivo con base pendiente sigue visible para cobrarle", async () => {
      await ok(`/sd/bases/${A.id}/give`, "POST", { cashAmount: 5000 });
      await p.driver.update({ where: { id: A.id }, data: { active: false } });
      assert.ok((await ok("/sd/drivers")).some((x: any) => x.id === A.id));
      assert.ok((await ok("/sd/dashboard/debts")).debtors.some((x: any) => x.id === A.id));
    });
    await check("F14-CIERRE", "Cierre mensual guarda la base pura pendiente al final del mes", async f => {
      const b = await ok(`/sd/bases/${A.id}/give`, "POST", { cashAmount: 40000 });
      await p.baseTransaction.update({ where: { id: b.id }, data: { date: new Date(prevMonthLast + "T12:00:00-05:00") } });
      await order(A, 66667);
      const c = await closes.closeMonth(prevMonthLast.slice(0, 7));
      f.snap = (c as any).basesPending;
      assert.equal(f.snap, 40000);
      assert.equal(await basePending(A), 40000); assert.equal((await drv(A)).pendingDebt, 20000);
    });
    await check("F14-INTEG", "El libro de base nunca queda con más devuelto que entregado (editar/eliminar/solicitud)", async () => {
      const g = await ok(`/sd/bases/${A.id}/give`, "POST", { cashAmount: 20000 });
      const r = await ok(`/sd/bases/${A.id}/pay`, "POST", { cashAmount: 15000 });
      assert.equal((await api(`/sd/bases/${g.id}`, "DELETE", undefined, admin)).status, 409);
      assert.equal((await api(`/sd/bases/${r.id}`, "PATCH", { cashAmount: 25000 }, admin)).status, 409);
      const req = await ok("/edit-requests", "POST", { entityType: "BaseTransaction", entityId: g.id, entityLabel: "Base", changes: {}, reason: "x", requestType: "delete" });
      assert.equal((await api(`/edit-requests/${req.id}/review`, "POST", { action: "approved" }, admin)).status, 409);
      assert.equal((await p.editRequest.findUniqueOrThrow({ where: { id: req.id } })).status, "pending");
      assert.equal(await basePending(A), 5000); assert.equal((await drv(A)).pendingDebt, 0);
    });

    // ════════════════════════════ D7 ════════════════════════════
    await check("D7-EDIT", "Editar por solicitud un movimiento de un día cerrado: conteo original intacto, corrección registrada, cadena cuadra", async f => {
      const m = await ok("/movements", "POST", { date: yesterday, category: 1, type: "ingreso", medium: "cash", amount: 10000 }, admin);
      const c = await closeDay(yesterday);
      const before = { y: await dash.getExpectedBalancesForDate(yesterday), t: await bal() };
      assert.equal((await api(`/movements/${m.id}`, "PATCH", { amount: 7000 }, admin)).status, 409, "la edición directa sigue bloqueada");
      const req = await ok("/edit-requests", "POST", { entityType: "Movement", entityId: m.id, entityLabel: "Ingreso olvidado", changes: { amount: { old: "10000", new: "7000" } }, reason: "Se digitó mal" });
      assert.equal((await api(`/edit-requests/${req.id}/review`, "POST", { action: "approved" }, oper)).status, 403);
      await ok(`/edit-requests/${req.id}/review`, "POST", { action: "approved" }, admin);
      const sc = await p.shiftClose.findUniqueOrThrow({ where: { id: c.id } });
      f.corr = sc.corrections; f.original = [sc.totalExpected, sc.totalCounted, sc.difference];
      assert.deepEqual(f.original, [c.totalExpected, c.totalCounted, 0], "el conteo original no cambia");
      assert.equal((sc.corrections as any[]).length, 1); assert.deepEqual([(sc.corrections as any)[0].cashDelta, (sc.corrections as any)[0].bankDelta], [-3000, 0]);
      assert.deepEqual(await dash.getExpectedBalancesForDate(yesterday), { cash: before.y.cash - 3000, bank: before.y.bank });
      assert.deepEqual(await bal(), { cash: before.t.cash - 3000, bank: before.t.bank });
      const sy = await days.getDaySummary(yesterday), st = await days.getDaySummary(today);
      assert.equal(sy.cajaCuadrada, true, "el semáforo depende solo del Cierre original");
      assert.equal(st.initialTotal, sy.finalTotal, "el cierre corregido es la apertura del día siguiente");
      assert.equal(sy.initialTotal + sy.ingresos - sy.egresos, sy.finalTotal);
    });
    await check("D7-REJ", "Solicitud rechazada: sin cambio de dinero ni corrección", async () => {
      const m = await ok("/movements", "POST", { date: yesterday, category: 1, type: "ingreso", medium: "cash", amount: 10000 }, admin);
      await closeDay(yesterday); const before = await bal();
      const req = await ok("/edit-requests", "POST", { entityType: "Movement", entityId: m.id, entityLabel: "x", changes: { amount: { old: "10000", new: "1" } }, reason: "x" });
      await ok(`/edit-requests/${req.id}/review`, "POST", { action: "rejected" }, admin);
      assert.deepEqual(await bal(), before);
      assert.deepEqual((await p.shiftClose.findFirstOrThrow({ where: { date: yesterday } })).corrections, []);
      assert.equal((await p.movement.findUniqueOrThrow({ where: { id: m.id } })).amount, 10000);
    });
    await check("D7-DEL", "Eliminar por solicitud un movimiento bancario de un día cerrado", async f => {
      await ok("/bank-transactions", "POST", { type: "ingreso", medium: "bank", amount: 5000, description: "Duplicado", date: yesterday, noCounterpart: true }, admin);
      const tx = await p.bankTransaction.findFirstOrThrow(); await closeDay(yesterday); const before = await bal();
      assert.equal((await api(`/bank-transactions/${tx.id}`, "DELETE", undefined, admin)).status, 409);
      const req = await ok("/edit-requests", "POST", { entityType: "BankTransaction", entityId: tx.id, entityLabel: "Duplicado", changes: {}, reason: "duplicado", requestType: "delete" });
      await ok(`/edit-requests/${req.id}/review`, "POST", { action: "approved" }, admin);
      f.corr = (await p.shiftClose.findFirstOrThrow({ where: { date: yesterday } })).corrections;
      assert.deepEqual([(f.corr as any)[0].cashDelta, (f.corr as any)[0].bankDelta], [0, -5000]);
      assert.deepEqual(await bal(), { cash: before.cash, bank: before.bank - 5000 });
      assert.equal(await p.bankTransaction.count(), 0);
    });
    await check("D7-ADD", "Agregar por solicitud un egreso olvidado a un día cerrado; el mes abierto lo refleja", async f => {
      await closeDay(yesterday); const before = await bal();
      assert.equal((await api("/bank-transactions", "POST", { type: "egreso", medium: "cash", amount: 2000, description: "Olvido", date: yesterday, noCounterpart: true }, oper)).status, 409, "directo: rechazado");
      const req = await ok("/edit-requests", "POST", { requestType: "create", entityType: "BankTransaction", entityId: "nuevo", entityLabel: "", changes: { date: yesterday, type: "egreso", medium: "cash", amount: 2000, description: "Taxi olvidado" }, reason: "No se registró" });
      const r = await ok(`/edit-requests/${req.id}/review`, "POST", { action: "approved" }, admin);
      const tx = await p.bankTransaction.findFirstOrThrow(); f.tx = { fecha: toBogotaDateStr(tx.date), monto: tx.amount };
      assert.equal(toBogotaDateStr(tx.date), yesterday); assert.equal(r.entityId, tx.id);
      assert.deepEqual(await bal(), { cash: before.cash - 2000, bank: before.bank });
      const corr = (await p.shiftClose.findFirstOrThrow({ where: { date: yesterday } })).corrections as any[];
      assert.deepEqual([corr[0].cashDelta, corr[0].requestType], [-2000, "create"]);
      const repT = await closes.getMonthlyReport(yesterday.slice(0, 7)); assert.ok(repT);
      const sy = await days.getDaySummary(yesterday); assert.equal(sy.initialTotal + sy.ingresos - sy.egresos, sy.finalTotal);
    });
    await check("D7-ADELANTADO", "Corrección aprobada de un día cerrado por adelantado (aún futuro en el reloj)", async f => {
      // Auditoría visual 21-oct-2026: con el 22 cerrado el 21, aprobar un egreso olvidado del 22
      // fallaba con "la fecha del dinero no puede ser futura".
      const tomorrow = dayBefore(today, -1), op = dayBefore(today, -2);
      await closeDay(today); await closeDay(tomorrow);
      const before = await ok(`/shifts/${op}/expected`, "GET", undefined, admin);
      assert.equal((await api("/bank-transactions", "POST", { type: "egreso", medium: "cash", amount: 1000, description: "Olvido", date: tomorrow, noCounterpart: true }, oper)).status, 409, "directo: día cerrado");
      const req = await ok("/edit-requests", "POST", { requestType: "create", entityType: "BankTransaction", entityId: "nuevo", entityLabel: "", changes: { date: tomorrow, type: "egreso", medium: "cash", amount: 1000, description: "Parqueadero olvidado" }, reason: "x" });
      f.review = (await api(`/edit-requests/${req.id}/review`, "POST", { action: "approved" }, admin)).status;
      assert.equal(f.review, 200);
      const after = await ok(`/shifts/${op}/expected`, "GET", undefined, admin);
      assert.deepEqual([after.expectedCash, after.expectedBank], [before.expectedCash - 1000, before.expectedBank]);
      const corr = (await p.shiftClose.findFirstOrThrow({ where: { date: tomorrow, shift: "close" } })).corrections as any[];
      assert.deepEqual([corr.length, corr[0].cashDelta], [1, -1000]);
    });
    await check("D7-ADDMOV","Agregar por solicitud un movimiento de Caja (gasto) a un día cerrado", async () => {
      await closeDay(yesterday); const before = await bal();
      const req = await ok("/edit-requests", "POST", { requestType: "create", entityType: "Movement", entityId: "nuevo", entityLabel: "", changes: { date: yesterday, type: "egreso", medium: "cash", amount: 3000, description: "Gasto olvidado", category: 3 }, reason: "x" });
      await ok(`/edit-requests/${req.id}/review`, "POST", { action: "approved" }, admin);
      const m = await p.movement.findFirstOrThrow(); assert.deepEqual([m.date, m.status, m.amount], [yesterday, "confirmed", 3000]);
      assert.deepEqual(await bal(), { cash: before.cash - 3000, bank: before.bank });
      assert.equal((await closes.getMonthlyReport(yesterday.slice(0, 7))).expenses.cash, 3000);
    });
    await check("D7-CHAIN", "Corrección en un día cerrado anterior a otro día cerrado: ambos y la cadena cuadran", async f => {
      const m = await ok("/movements", "POST", { date: twoAgo, category: 1, type: "ingreso", medium: "cash", amount: 10000 }, admin);
      await closeDay(twoAgo);
      await ok("/movements", "POST", { date: yesterday, category: 1, type: "ingreso", medium: "bank", amount: 4000 }, admin);
      await closeDay(yesterday);
      const req = await ok("/edit-requests", "POST", { entityType: "Movement", entityId: m.id, entityLabel: "x", changes: { amount: { old: "10000", new: "6000" } }, reason: "x" });
      await ok(`/edit-requests/${req.id}/review`, "POST", { action: "approved" }, admin);
      const d2 = await days.getDaySummary(twoAgo), d1 = await days.getDaySummary(yesterday), d0 = await days.getDaySummary(today);
      f.cadena = [[d2.initialTotal, d2.finalTotal], [d1.initialTotal, d1.finalTotal], [d0.initialTotal, d0.finalTotal]];
      assert.equal(d1.initialTotal, d2.finalTotal); assert.equal(d0.initialTotal, d1.finalTotal);
      for (const s of [d2, d1, d0]) assert.equal(s.initialTotal + s.ingresos - s.egresos, s.finalTotal);
      assert.deepEqual([d2.finalCash, d1.finalCash, d1.finalBank], [106000, 106000, 104000]);
    });
    await check("MES-FUTURO", "Cierre de mes con dinero fechado más tarde hoy: se rechaza (no se cuenta dos veces)", async f => {
      // NEW15: registrado con la caja adelantada con hora explícita del día operativo, que hoy aún no llega.
      for (let d = dayBefore(prevMonthLast, -1); d < today; d = dayBefore(d, -1)) await closeDay(d);
      const tx = await p.bankTransaction.create({ data: { type: "egreso", medium: "cash", amount: 10, description: "Hora futura", date: new Date(Date.now() + 3600_000), noCounterpart: true } });
      f.err = await closes.closeMonth(prevMonthLast.slice(0, 7)).then(() => "cerró", (e: Error) => e.message);
      assert.match(f.err, /hora posterior a este momento/);
      assert.equal(await p.monthlyClose.count(), 0);
      await p.bankTransaction.delete({ where: { id: tx.id } });
      await closes.closeMonth(prevMonthLast.slice(0, 7));
      assert.equal(await p.monthlyClose.count(), 1);
    });
    await check("MES-LEGADO", "Movimiento registrado antes del cierre de mes con fecha posterior: no se descuenta dos veces", async f => {
      // INC-R3-01 (base real, cierre de septiembre): con la versión anterior se registró "Shipday
      // Septiembre" con la caja adelantada (fecha del día siguiente) y DESPUÉS se cerró el mes. El capital
      // declarado ya lo incluía; contarlo tras el ancla dejaba la caja 1.760.000 abajo desde entonces.
      for (let d = dayBefore(prevMonthLast, -1); d < today; d = dayBefore(d, -1)) await closeDay(d);
      const close = await closes.closeMonth(prevMonthLast.slice(0, 7));
      const before = await bal();
      await p.day.upsert({ where: { date: today }, create: { date: today, initialCash: 0, initialBank: 0 }, update: {} });
      await p.movement.create({ data: { date: today, category: 3, type: "egreso", medium: "cash", amount: 1760000, description: "Legado: registrado antes del cierre", status: "confirmed", createdAt: new Date(close.closedAt.getTime() - 86400000) } });
      f.antes = before; f.despues = await bal();
      assert.deepEqual(f.despues, before);
    });
    await check("D7-MES","Mes cerrado: la solicitud no se aplica y queda pendiente", async f => {
      const m = await ok("/movements", "POST", { date: prevMonthLast, category: 1, type: "ingreso", medium: "cash", amount: 10000 }, admin);
      await closeDay(prevMonthLast);
      // NEW10: el mes solo se cierra con la caja al día (día operativo = hoy).
      for (let d = dayBefore(prevMonthLast, -1); d < today; d = dayBefore(d, -1)) await closeDay(d);
      await closes.closeMonth(prevMonthLast.slice(0, 7));
      const req = await ok("/edit-requests", "POST", { entityType: "Movement", entityId: m.id, entityLabel: "x", changes: { amount: { old: "10000", new: "1" } }, reason: "x" });
      f.status = (await api(`/edit-requests/${req.id}/review`, "POST", { action: "approved" }, admin)).status;
      assert.equal(f.status, 409);
      assert.equal((await p.editRequest.findUniqueOrThrow({ where: { id: req.id } })).status, "pending");
      assert.equal((await p.movement.findUniqueOrThrow({ where: { id: m.id } })).amount, 10000);
      assert.equal((await api("/edit-requests", "POST", { requestType: "create", entityType: "BankTransaction", entityId: "nuevo", entityLabel: "", changes: { date: prevMonthLast, type: "ingreso", medium: "cash", amount: 1, description: "x" }, reason: "x" })).status, 201);
    });
    await check("D7-VAL", "Solicitud de agregar inválida se rechaza al crearla", async f => {
      await closeDay(yesterday);
      const bad = [
        { entityType: "BankTransaction", changes: { date: today, type: "ingreso", medium: "cash", amount: 1, description: "x" } },      // día sin cierre
        { entityType: "BankTransaction", changes: { date: yesterday, type: "x", medium: "cash", amount: 1, description: "x" } },
        { entityType: "BankTransaction", changes: { date: yesterday, type: "ingreso", medium: "card", amount: 1, description: "x" } },
        { entityType: "BankTransaction", changes: { date: yesterday, type: "ingreso", medium: "cash", amount: -5, description: "x" } },
        { entityType: "BankTransaction", changes: { date: "2026-02-31", type: "ingreso", medium: "cash", amount: 1, description: "x" } },
        { entityType: "Conversion", changes: { date: yesterday, type: "ingreso", medium: "cash", amount: 1, description: "x" } },
        { entityType: "Movement", changes: { date: yesterday, type: "ingreso", medium: "cash", amount: 1, description: "x" } },        // sin categoría
      ];
      f.estados = []; for (const b of bad) f.estados.push((await api("/edit-requests", "POST", { ...b, requestType: "create", entityId: "nuevo", entityLabel: "", reason: "x" })).status);
      assert.deepEqual(f.estados, [400, 400, 400, 400, 400, 400, 400]); assert.equal(await p.editRequest.count(), 0);
    });
    await check("D7-DUP", "Dos aprobaciones simultáneas de la misma solicitud: el efecto ocurre una vez", async () => {
      await closeDay(yesterday); const before = await bal();
      const req = await ok("/edit-requests", "POST", { requestType: "create", entityType: "BankTransaction", entityId: "nuevo", entityLabel: "", changes: { date: yesterday, type: "ingreso", medium: "cash", amount: 1000, description: "x" }, reason: "x" });
      const st = await Promise.all([1, 2].map(() => api(`/edit-requests/${req.id}/review`, "POST", { action: "approved" }, admin)));
      assert.deepEqual(st.map(x => x.status).sort(), [200, 400]);
      assert.equal(await p.bankTransaction.count(), 1); assert.deepEqual(await bal(), { cash: before.cash + 1000, bank: before.bank });
      assert.equal(((await p.shiftClose.findFirstOrThrow({ where: { date: yesterday } })).corrections as any[]).length, 1);
    });

    // ════════════════════════ Pedidos post-cierre ════════════════════════
    await check("ORD-POST", "Pedido de Shipday entregado después del Cierre del día se carga en su día; la caja cerrada no cambia", async f => {
      await closeDay(today); const before = await bal();
      const r = await hook({ event: "ORDER_COMPLETED", order: { id: "post-close", delivery_fee: 10000, delivery_time: Date.now() }, carrier: { id: "8001" } });
      f.status = r.status; assert.equal(r.status, 200);
      const o = await p.shipdayOrder.findUniqueOrThrow({ where: { shipdayOrderId: "post-close" } });
      assert.deepEqual([o.companyAmount, toBogotaDateStr(o.deliveredAt!)], [3000, today]);
      assert.equal((await drv(A)).pendingDebt, 3000); assert.deepEqual(await bal(), before);
      assert.equal((await closes.getMonthlyReport(month)).totalSales, 3000);
    });
    const ord = (id: string, at: Date) => ({ orderId: id, orderNumber: id, deliveryFee: 10000, deliveryTime: at.toISOString(), carrier: { id: 8001 } });
    const mockOrders = (orders: unknown[]) => { globalThis.fetch = (async (input: any, init: any) => {
      const s = String(input);
      if (s.startsWith("http://127.0.0.1:")) return realFetch(input, init);
      if (s === "https://api.shipday.com/carriers") return new Response(JSON.stringify([{ id: 8001, name: "Domi A" }, { id: 8002, name: "Domi B" }]));
      if (s === "https://api.shipday.com/orders/query") return new Response(JSON.stringify(orders));
      throw Error("Red externa bloqueada");
    }) as any; };
    await check("ORD-SYNC1", "Sondeo: un rezagado de un día con Cierre (mes abierto) se carga en su día", async f => {
      await closeDay(yesterday); const before = await dash.getExpectedBalancesForDate(yesterday);
      mockOrders([ord("dia-cerrado", new Date(yesterday + "T20:00:00-05:00")), ord("hoy", new Date())]);
      const r = await branchSvc.syncBranch(branch.id, { forceDrivers: true, windowDays: 3 });
      f.r = r; f.pedidos = (await p.shipdayOrder.findMany({ select: { shipdayOrderId: true }, orderBy: { shipdayOrderId: "asc" } })).map((o: any) => o.shipdayOrderId);
      assert.deepEqual(f.pedidos, ["dia-cerrado", "hoy"]); assert.equal(r.partial, false);
      assert.equal((await drv(A)).pendingDebt, 6000);
      assert.deepEqual(await dash.getExpectedBalancesForDate(yesterday), before, "la caja del día cerrado no cambia");
    });
    await check("ORD-SYNC2", "Sondeo: un pedido de un MES cerrado se omite y se avisa; el resto se carga (aunque el cierre sea posterior)", async f => {
      await closes.closeMonth(prevMonthLast.slice(0, 7));
      mockOrders([ord("mes-cerrado", new Date(prevMonthLast + "T12:00:00-05:00")), ord("mes-abierto-antes-del-cierre", new Date(yesterday + "T12:00:00-05:00")), ord("hoy", new Date())]);
      const r = await branchSvc.syncBranch(branch.id, { forceDrivers: true, windowDays: 40 });
      f.r = r; f.pedidos = (await p.shipdayOrder.findMany({ select: { shipdayOrderId: true }, orderBy: { shipdayOrderId: "asc" } })).map((o: any) => o.shipdayOrderId);
      assert.deepEqual(f.pedidos, ["hoy", "mes-abierto-antes-del-cierre"]); assert.equal(r.partial, true); assert.match(r.error!, /mes-cerrado/);
      assert.equal((await drv(A)).pendingDebt, 6000);
    });
  } finally {
    globalThis.fetch = realFetch;
    await new Promise<void>(r => server.close(() => r()));
    fs.writeFileSync(path.join(__dirname, "claude-f14-d7.json"), JSON.stringify(results, null, 2));
    console.log(`\nTOTAL ${results.length} · OK ${results.filter(r => r.ok).length} · FALLAS ${results.filter(r => !r.ok).length}`);
    await p.$disconnect();
    if (results.some(r => !r.ok)) process.exitCode = 1;
  }
}
main().catch(e => { console.error(e); process.exit(1); });
