/**
 * FUN101/FUN102 (auditoría integral, 21-oct-2026): un MES REAL de operación con cierres diarios y el
 * cierre del mes, sin tocar el reloj. Gracias a NEW02 (todo cuenta en el día operativo) basta con
 * dejar el último Cierre hace 31 días: la caja queda atrasada y cada día se opera y se cierra, uno
 * tras otro, cruzando el cambio de mes, hasta alcanzar hoy. Entonces se cierra el mes anterior
 * (NEW10: solo con la caja al día). Todo por HTTP (rutas reales); los esperados se calculan aquí con
 * un libro propio, de forma independiente. SOLO contra la BD temporal local `cashbuddy_claude_mes`.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const u = new URL(process.env.DATABASE_URL || "invalid:");
if (u.pathname !== "/cashbuddy_claude_mes" || !["localhost", "127.0.0.1"].includes(u.hostname)) throw Error("Solo BD temporal local cashbuddy_claude_mes");

async function main() {
  const SRC = pathToFileURL(path.resolve(__dirname, "../src")).href;
  const { prisma: p } = await import(`${SRC}/lib/prisma.ts`);
  const { createServer } = await import(`${SRC}/server.ts`);
  const { signToken } = await import(`${SRC}/lib/jwt.ts`);
  const excel = await import(`${SRC}/services/excel.service.ts`);
  const { todayBogota, toBogotaDateStr, bogotaDayRange } = await import(`${SRC}/lib/date-range.ts`);
  const ExcelJS = (await import("node:module")).createRequire(path.resolve(__dirname, "../package.json"))("exceljs");

  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any, init: any) => { if (!String(input).startsWith("http://127.0.0.1:")) throw Error("Red externa bloqueada"); return realFetch(input, init); }) as any;
  const server = createServer().listen(0, "127.0.0.1"); await new Promise<void>(r => server.once("listening", r));
  const origin = "http://127.0.0.1:" + (server.address() as any).port;
  const results: any[] = [];
  const check = async (id: string, name: string, fn: (f: any) => Promise<void>) => {
    const f: any = {};
    try { await fn(f); results.push({ id, name, ok: true, facts: f }); console.log(`OK    ${id} ${name}`); }
    catch (e: any) { results.push({ id, name, ok: false, facts: f, error: String(e?.stack || e).slice(0, 1500) }); console.log(`FALLA ${id} ${name}\n      ${JSON.stringify(f).slice(0, 600)} ${String(e?.message || e).slice(0, 600)}`); }
  };

  const today = todayBogota();
  const addDays = (d: string, n: number) => toBogotaDateStr(new Date(new Date(d + "T12:00:00-05:00").getTime() + n * 86400000));
  const start = addDays(today, -30), seedClose = addDays(start, -1);
  const prevMonth = toBogotaDateStr(new Date(new Date(today.slice(0, 7) + "-01T12:00:00-05:00").getTime() - 86400000)).slice(0, 7);

  const tables = await p.$queryRawUnsafe(`SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename <> '_prisma_migrations'`) as any[];
  await p.$executeRawUnsafe("TRUNCATE TABLE " + tables.map((x: any) => '"' + x.tablename + '"').join(",") + " CASCADE");
  await p.settings.create({ data: { id: "singleton", initialCash: 100000, initialBank: 100000, setupComplete: true, termsAcceptedAt: new Date(), shipdayCommission: 30 } as any });
  const admin = await p.user.create({ data: { email: "admin@mes.test", name: "Admin", role: "admin", passwordHash: "x" } });
  const branch = await p.branch.create({ data: { name: "Sucursal Mes", apiKeyEnc: "test-only" } });
  const A = await p.driver.create({ data: { name: "Domi A", shipdayDriverId: "9001", branchId: branch.id } });
  const B = await p.driver.create({ data: { name: "Domi B", shipdayDriverId: "9002", branchId: branch.id } });
  const worker = await p.worker.create({ data: { name: "Auxiliar", color: "#888888" } as any });
  // Último Cierre hace 31 días: la caja abierta es la de `start` (atrasada 30 días respecto a hoy).
  await p.shiftClose.create({ data: { date: seedClose, shift: "close", denominations: { bills: [{ value: 100000, qty: 1 }], coins: [] }, totalCounted: 100000, totalExpected: 100000, difference: 0, bankCounted: 100000, bankExpected: 100000, bankDifference: 0, closedAt: new Date(seedClose + "T22:00:00-05:00"), locked: true } as any });

  const tok = signToken({ sub: admin.id, email: admin.email, name: admin.name, role: admin.role, tv: (admin as any).tokenVersion });
  async function api(route: string, method = "GET", body?: unknown) {
    const r = await realFetch(origin + "/api" + route, { method, headers: { "Content-Type": "application/json", Authorization: "Bearer " + tok }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => null) as any };
  }
  async function ok(route: string, method = "GET", body?: unknown) {
    const r = await api(route, method, body);
    if (r.status >= 300) throw Error(`${method} ${route} → ${r.status} ${JSON.stringify(r.body)}`);
    return r.body;
  }
  const BILLS = [100000, 50000, 20000, 10000, 5000, 2000, 1000], COINS = [500, 200, 100, 50];
  function denominate(amount: number) {
    let rest = amount; const bills: any[] = [], coins: any[] = [];
    for (const v of BILLS) { const q = Math.floor(rest / v); if (q) { bills.push({ value: v, qty: q }); rest -= q * v; } }
    for (const v of COINS) { const q = Math.floor(rest / v); if (q) { coins.push({ value: v, qty: q }); rest -= q * v; } }
    assert.equal(rest, 0, "efectivo no denominable: " + amount); return { bills, coins };
  }

  const hc = await ok("/hourly-clients", "POST", { name: "Empresa por hora", driverHourValue: 10000, companyHourValue: 15000 });
  const client = await ok("/clients", "POST", { name: "Tienda fiada" });
  // Libro independiente.
  let cash = 100000, bank = 100000, clientDebt = 0;
  const month: Record<string, { orders: number; hourly: number; expenses: number; payroll: number }> = {};
  const days: string[] = []; for (let d = start; d < today; d = addDays(d, 1)) days.push(d);

  await check("MES-00", `La caja abierta empieza atrasada en ${start} (hoy ${today})`, async f => {
    f.cur = (await ok("/shifts/current-date")).date; assert.equal(f.cur, start);
    f.cierreMesEnCurso = (await api("/sd/closes", "POST", { month: prevMonth, initialCash: 1, initialBank: 1 })).status; assert.equal(f.cierreMesEnCurso, 409);
  });

  for (const [i, d] of days.entries()) {
    await check(`MES-${String(i + 1).padStart(2, "0")}`, `Día ${d}: operación completa y Cierre cuadrado al peso`, async f => {
      const m = (month[d.slice(0, 7)] ??= { orders: 0, hourly: 0, expenses: 0, payroll: 0 });
      const g = 5000 * (1 + (i % 3)), v = 10000 + 1000 * (i % 5), c = Math.round(v * 0.3), exp = 1000 * (1 + (i % 4));
      const even = i % 2 === 0;
      const t0 = new Date();
      assert.equal((await ok("/shifts/current-date")).date, d);
      await ok(`/sd/bases/${A.id}/give`, "POST", { cashAmount: g }); cash -= g;
      await ok("/sd/orders/manual", "POST", { branchId: branch.id, driverId: A.id, deliveryValue: v, orderNumber: `M-${i}` }); m.orders += c;
      await ok(`/sd/drivers/${A.id}/payment`, "POST", { amount: c + g, medium: even ? "cash" : "bank", baseAmount: g }); if (even) cash += c + g; else bank += c + g;
      await ok("/movements", "POST", { date: d, category: even ? 3 : 4, type: "egreso", medium: even ? "cash" : "bank", amount: exp, description: `Gasto ${i}`, status: "confirmed" });
      if (even) cash -= exp; else bank -= exp; m.expenses += exp;
      if (i % 3 === 0) { await ok("/bank-transactions", "POST", { type: "ingreso", medium: "bank", amount: 3000, description: `Consignación ${i}`, noCounterpart: true }); bank += 3000; }
      await ok(`/clients/${client.id}/debt`, "POST", { description: `Fiado ${i}`, amount: 4000 }); clientDebt += 4000;
      await ok(`/clients/${client.id}/pay`, "POST", { amount: 2000, medium: "cash" }); cash += 2000; clientDebt -= 2000;
      if (even) {
        await ok(`/hourly-clients/${hc.id}/shifts`, "POST", { driverId: B.id, startTime: "08:00", endTime: "09:00", medium: "bank" }); bank -= 10000; m.hourly += 15000;
        await ok(`/hourly-clients/${hc.id}/pay`, "POST", { payAll: true, medium: "cash" }); cash += 25000;
      }
      if (i % 7 === 0) { await ok("/movements", "POST", { date: d, category: 15, type: "egreso", medium: "cash", amount: 5000, description: `Nómina ${i}`, workerId: worker.id, status: "confirmed" }); cash -= 5000; m.payroll += 5000; }

      const e = await ok(`/shifts/${d}/expected`); f.esperado = [e.expectedCash, e.expectedBank]; f.libro = [cash, bank];
      assert.deepEqual(f.esperado, f.libro, "el esperado del sistema no coincide con el libro independiente");
      // Todo lo de hoy cuenta en el día operativo `d`, aunque el reloj diga otra fecha.
      const range = bogotaDayRange(d);
      f.fueraDelDia = await p.bankTransaction.count({ where: { createdAt: { gte: t0 }, NOT: { date: range } } });
      assert.equal(f.fueraDelDia, 0);
      const s = await ok(`/days/${d}/summary`);
      assert.equal(s.initialTotal + s.ingresos - s.egresos, s.finalTotal, "el Historial no encadena");
      assert.equal(s.netProfit, c + (even ? 15000 : 0) - exp - (i % 7 === 0 ? 5000 : 0), "ganancia del día");
      const close = await ok("/shifts", "POST", { date: d, shift: "close", receivedBy: "Auditor", denominations: denominate(cash), expectedAmount: cash, bankCounted: bank });
      f.cierre = [close.difference, close.bankDifference]; assert.deepEqual(f.cierre, [0, 0]);
    });
  }

  await check("MES-90", `Hoy ${today} la caja quedó al día; cerrar el mes en curso sigue bloqueado`, async f => {
    f.cur = (await ok("/shifts/current-date")).date; assert.equal(f.cur, today);
    f.mesEnCurso = (await api("/sd/closes", "POST", { month: today.slice(0, 7), initialCash: 1, initialBank: 1 })).status; assert.equal(f.mesEnCurso, 409);
  });
  await check("MES-91", `Reporte y Excel de ${prevMonth} cuadran con el libro independiente (incluye clientes por hora)`, async f => {
    const m = month[prevMonth]; const r = await ok(`/sd/report/${prevMonth}`);
    f.reporte = { ventas: r.totalSales, sales: r.sales, gastos: r.expenses.total, nomina: r.payroll.total, utilidad: r.netProfit, deudaClientes: r.clientDebt.balance };
    f.libro = m;
    assert.deepEqual([r.sales.orders, r.sales.hourly, r.totalSales], [m.orders, m.hourly, m.orders + m.hourly]);
    assert.deepEqual([r.expenses.total, r.payroll.total], [m.expenses, m.payroll]);
    assert.equal(r.netProfit, m.orders + m.hourly - m.expenses - m.payroll);
    assert.equal(r.clientDebt.balance, clientDebt);
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load(await excel.buildMonthlyExcel(prevMonth) as any);
    const vals: Record<string, any> = {}; wb.getWorksheet("CIERRE MES")!.eachRow((row: any) => { vals[String(row.getCell(5).value)] = row.getCell(6).value; });
    f.excel = { ventas: vals["TOTAL VENTAS"], ganancia: vals["GANANCIA (Utilidad Neta)"] };
    assert.deepEqual([f.excel.ventas, f.excel.ganancia], [r.totalSales, r.netProfit]);
  });
  await check("MES-92", `Cierre de ${prevMonth} con la caja al día: saldos intactos y el dinero siguiente entra`, async f => {
    const before = await ok(`/shifts/${today}/expected`);
    const mc = await ok("/sd/closes", "POST", { month: prevMonth, initialCash: before.expectedCash, initialBank: before.expectedBank });
    f.cierre = { mes: mc.month, ventas: mc.totalSales, utilidad: mc.netProfit };
    assert.equal(mc.totalSales, month[prevMonth].orders + month[prevMonth].hourly);
    const after = await ok(`/shifts/${today}/expected`); assert.deepEqual([after.expectedCash, after.expectedBank], [before.expectedCash, before.expectedBank]);
    assert.equal((await api("/sd/closes", "POST", { month: prevMonth, initialCash: 1, initialBank: 1 })).status, 409, "segundo cierre del mismo mes");
    await ok(`/sd/bases/${A.id}/give`, "POST", { cashAmount: 1000 });
    const after2 = await ok(`/shifts/${today}/expected`); assert.deepEqual([after2.expectedCash, after2.expectedBank], [before.expectedCash - 1000, before.expectedBank]);
    // Un día del mes cerrado ya no admite dinero, ni con fecha explícita.
    f.retro = (await api("/movements", "POST", { date: `${prevMonth}-28`, category: 3, type: "egreso", medium: "cash", amount: 1000, description: "tarde", status: "confirmed" })).status;
    assert.equal(f.retro, 409);
  });

  await new Promise<void>(r => server.close(() => r())); globalThis.fetch = realFetch; await p.$disconnect();
  const fails = results.filter(r => !r.ok).length;
  fs.writeFileSync(path.join(__dirname, "claude-mes-simulado.json"), JSON.stringify(results, null, 2));
  console.log(`TOTAL ${results.length} · OK ${results.length - fails} · FALLAS ${fails}`);
  process.exit(fails ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
