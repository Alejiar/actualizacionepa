/**
 * AUDITORÍA RONDA 2 (22-oct-2026) — Simulación A CONTINUADA: uso PROLONGADO.
 * Retoma el estado final verificado de la Simulación A de la ronda 1 (dump de cashbuddy_final_a: 61 días,
 * agosto y septiembre cerrados) y la continúa día por día con la MISMA operación diaria hasta
 * FIN (por defecto 2027-04-30): cierre de cada mes el día 1 del siguiente, cambio de año, febrero,
 * más volumen de pedidos por día. El reloj es SIMULADO solo en este proceso (fake-clock.cjs).
 * Libro independiente: arranca del libro final de la ronda 1 (simA-ronda1.json) y se compara con el
 * sistema antes de continuar. Mide además tiempos de respuesta, tamaño de la BD y memoria por mes.
 * SOLO contra la BD temporal local `cashbuddy_final_ap`.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

const u = new URL(process.env.DATABASE_URL || "invalid:");
if (u.pathname !== "/cashbuddy_final_ap" || !["localhost", "127.0.0.1"].includes(u.hostname)) throw Error("Solo BD temporal local cashbuddy_final_ap");
const clock = (globalThis as any).__fakeClock; if (!clock) throw Error("Falta el reloj simulado (fake-clock.cjs)");
const RealDate = clock.Real as DateConstructor;
const REAL_START = RealDate.now();
const FIN = process.env.FIN || "2027-04-30";
const BULK = Number(process.env.BULK || 40); // pedidos extra por día (volumen de uso prolongado)

async function main() {
  const setNow = (iso: string) => clock.set(new RealDate(iso).getTime());
  setNow("2026-10-22T22:00:00-05:00");
  const SRC = pathToFileURL(path.resolve(__dirname, "../src")).href;
  const { prisma: p } = await import(`${SRC}/lib/prisma.ts`);
  const { createServer } = await import(`${SRC}/server.ts`);
  const { signToken } = await import(`${SRC}/lib/jwt.ts`);
  const { toBogotaDateStr } = await import(`${SRC}/lib/date-range.ts`);
  const ExcelJS = (await import("node:module")).createRequire(path.resolve(__dirname, "../package.json"))("exceljs");
  const R1 = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../../auditoria-final-preproduccion/ronda2/bases-ronda1/simA-ronda1.json"), "utf8"));

  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any, init: any) => { if (!String(input).startsWith("http://127.0.0.1:")) throw Error("Red externa bloqueada: " + String(input)); return realFetch(input, init); }) as any;
  const server = createServer().listen(0, "127.0.0.1"); await new Promise<void>(r => server.once("listening", r));
  const origin = "http://127.0.0.1:" + (server.address() as any).port;
  const results: any[] = []; const ledgerLog: any[] = []; const perf: any[] = []; const monthly: any[] = [];
  const check = async (id: string, name: string, fn: (f: any) => Promise<void>) => {
    const f: any = {};
    try { await fn(f); results.push({ id, name, ok: true, facts: f }); console.log(`OK    ${id} ${name}`); }
    catch (e: any) { results.push({ id, name, ok: false, facts: f, error: String(e?.stack || e).slice(0, 1500) }); console.log(`FALLA ${id} ${name}\n      ${JSON.stringify(f).slice(0, 900)} ${String(e?.message || e).slice(0, 900)}`); }
  };
  const addDays = (d: string, n: number) => toBogotaDateStr(new Date(new Date(d + "T12:00:00-05:00").getTime() + n * 86400000));

  // ── Entidades de la ronda 1 ───────────────────────────────────────────────────────
  const admin = await p.user.findUniqueOrThrow({ where: { email: "admin@final.test" } });
  const oper = await p.user.findUniqueOrThrow({ where: { email: "oper@final.test" } });
  const N = await p.branch.findFirstOrThrow({ where: { name: "Sucursal Norte" } });
  const S = await p.branch.findFirstOrThrow({ where: { name: "Sucursal Sur" } });
  const drivers = [];
  for (const sd of ["7101", "7102", "7201", "7202"]) drivers.push(await p.driver.findFirstOrThrow({ where: { shipdayDriverId: sd } }));
  const branchOf = (i: number) => (i < 2 ? N : S);
  const w1 = await p.worker.findFirstOrThrow({ where: { name: "Auxiliar 1" } });
  const w2 = await p.worker.findFirstOrThrow({ where: { name: "Auxiliar 2" } });
  const hc = await p.hourlyClient.findFirstOrThrow({ where: { name: "Empresa por hora" } });
  const cFiado = await p.client.findFirstOrThrow({ where: { name: "Tienda fiada" } });
  const cPrest = await p.client.findFirstOrThrow({ where: { name: "Cliente préstamo" } });

  let tokA = "", tokO = "";
  const resign = () => {
    tokA = signToken({ sub: admin.id, email: admin.email, name: admin.name, role: admin.role, tv: (admin as any).tokenVersion });
    tokO = signToken({ sub: oper.id, email: oper.email, name: oper.name, role: oper.role, tv: (oper as any).tokenVersion });
  };
  resign();
  async function api(route: string, method = "GET", body?: unknown, tok = tokO) {
    const r = await realFetch(origin + "/api" + route, { method, headers: { "Content-Type": "application/json", Authorization: "Bearer " + tok }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => null) as any };
  }
  async function ok(route: string, method = "GET", body?: unknown, tok = tokO) {
    const r = await api(route, method, body, tok);
    if (r.status >= 300) throw Error(`${method} ${route} → ${r.status} ${JSON.stringify(r.body)}`);
    return r.body;
  }
  const adm = (route: string, method = "GET", body?: unknown) => ok(route, method, body, tokA);
  const timed = async (label: string, route: string, tok = tokA) => { const t = performance.now(); const r = await api(route, "GET", undefined, tok); const ms = Math.round(performance.now() - t); if (r.status !== 200) throw Error(`${route} → ${r.status}`); return { label, ms, body: r.body }; };
  const hook = async (branchId: string, body: unknown) => { const r = await realFetch(origin + "/api/webhooks/shipday/" + branchId, { method: "POST", headers: { "Content-Type": "application/json", token: process.env.WEBHOOK_TOKEN! }, body: JSON.stringify(body) }); if (r.status !== 200) throw Error("webhook " + r.status + " " + await r.text()); return r.json(); };
  const BILLS = [100000, 50000, 20000, 10000, 5000, 2000, 1000], COINS = [500, 200, 100, 50];
  function denominate(amount: number) {
    assert.ok(amount >= 0, "efectivo negativo en el libro: " + amount);
    let rest = amount; const bills: any[] = [], coins: any[] = [];
    for (const v of BILLS) { const q = Math.floor(rest / v); if (q) { bills.push({ value: v, qty: q }); rest -= q * v; } }
    for (const v of COINS) { const q = Math.floor(rest / v); if (q) { coins.push({ value: v, qty: q }); rest -= q * v; } }
    assert.equal(rest, 0, "efectivo no denominable: " + amount); return { bills, coins };
  }
  const commission = (v: number) => Math.round(v * 0.3);

  // ── Libro de control: continúa el de la ronda 1 ──────────────────────────────────
  const last = R1.ledger[R1.ledger.length - 1];
  assert.equal(last.dia, "2026-10-21");
  const L = {
    cash: last.efectivo - 7000, bank: last.banco, physicalShort: 0, // A-94 de la ronda 1: base de 7.000 a Domi N1
    net: [...last.comisiones], base: last.bases.map((b: number, k: number) => b + (k === 0 ? 7000 : 0)),
    client: { [cFiado.id]: last.clientes[cFiado.id], [cPrest.id]: last.clientes[cPrest.id] } as Record<string, number>,
    hourlyOwed: last.porHora,
    month: JSON.parse(JSON.stringify(R1.months)) as Record<string, { orders: number; ordersBy: Record<string, number>; hourly: number; expenses: number; payroll: number; nOrders: number }>,
    redDays: [] as string[],
  };
  const M = (d: string) => (L.month[d.slice(0, 7)] ??= { orders: 0, ordersBy: { [N.id]: 0, [S.id]: 0 }, hourly: 0, expenses: 0, payroll: 0, nOrders: 0 });
  const closedMonths = new Set<string>(["2026-08", "2026-09"]);
  const closeSnap: Record<string, any> = {};
  // Ancla de capital = instante del último cierre de mes. INC-R2-01: un día (aunque sea de un mes abierto) cuyo
  // final es anterior a ese instante no admite correcciones D7 de dinero; el sistema las rechaza sin efecto.
  let anchor = (await p.monthlyClose.findFirstOrThrow({ where: { branchId: null }, orderBy: { closedAt: "desc" } })).closedAt.getTime();
  const beforeAnchor = (day: string) => closedMonths.has(day.slice(0, 7)) || new Date(day + "T23:59:59.999-05:00").getTime() <= anchor;
  let orderSeq = 100000;
  const manualOrders: { id: string; drv: number; c: number; month: string; branch: string }[] = [];
  const gastoIds: { id: string; amount: number; medium: string; month: string; day: string }[] = [];
  // Correcciones posteriores a un Cierre (D7 / eliminación aprobada): cambian el saldo final de los días ya cerrados.
  const adj: Record<string, { c: number; b: number }> = {};
  const adjFrom = (dayX: string, dc: number, db: number) => { for (const x of ledgerLog) if (x.dia >= dayX) { const a = (adj[x.dia] ??= { c: 0, b: 0 }); a.c += dc; a.b += db; } };

  async function verifyBalances(f: any, label: string) {
    const ds = await ok("/sd/drivers");
    f.drivers = drivers.map(dr => { const x = ds.find((y: any) => y.id === dr.id); return [x.pendingDebt - x.creditAmount, x.basePending]; });
    assert.deepEqual(f.drivers, drivers.map((_, k) => [L.net[k], L.base[k]]), label + ": saldos de domiciliarios ≠ libro");
    const cl = await ok("/clients");
    f.clients = [cFiado.id, cPrest.id].map(id => cl.find((y: any) => y.id === id).pendingDebt);
    assert.deepEqual(f.clients, [L.client[cFiado.id], L.client[cPrest.id]], label + ": deuda de clientes ≠ libro");
    f.hourly = (await ok(`/hourly-clients/${hc.id}`)).pendingDebt;
    assert.equal(f.hourly, L.hourlyOwed, label + ": deuda del cliente por hora ≠ libro");
  }

  let opDay = "";
  await check("AP-00", "Continuidad: el sistema restaurado coincide con el libro final de la ronda 1 (incluida la base A-94)", async f => {
    opDay = (await ok("/shifts/current-date")).date; f.diaOperativo = opDay; assert.equal(opDay, "2026-10-22");
    const e = await ok(`/shifts/${opDay}/expected`); f.esperado = [e.expectedCash, e.expectedBank]; f.libro = [L.cash, L.bank];
    assert.deepEqual(f.esperado, f.libro);
    await verifyBalances(f, "continuidad");
    f.mesesCerrados = (await p.monthlyClose.findMany({ select: { month: true } })).map((m: any) => m.month).sort(); assert.deepEqual(f.mesesCerrados, ["2026-08", "2026-09"]);
    for (const mo of f.mesesCerrados) { const r = await adm(`/sd/report/${mo}`); closeSnap[mo] = { ventas: r.totalSales, utilidad: r.netProfit, gastos: r.expenses.total, nomina: r.payroll.total }; }
  });

  const days: string[] = []; for (let d = opDay; d <= FIN; d = addDays(d, 1)) days.push(d);
  const I0 = 61; // continúa los patrones de la ronda 1 (día 62 en adelante)

  async function monthClose(d: string) {
    const mo = addDays(d, -1).slice(0, 7);
    setNow(`${d}T08:00:00-05:00`); resign();
    await check(`AP-M-${mo}`, `Día 1 (${d}): reporte, reporte por sucursal y Excel (descargado por la ruta real) de ${mo} = libro; luego cierre del mes, segundo cierre 409 y dinero retroactivo 409`, async f => {
      assert.equal((await ok("/shifts/current-date")).date, d);
      const m = L.month[mo];
      const tr = await timed("reporte", `/sd/report/${mo}`); const r = tr.body;
      f.reporte = { pedidos: r.sales.orders, hora: r.sales.hourly, ventas: r.totalSales, gastos: r.expenses.total, nomina: r.payroll.total, utilidad: r.netProfit }; f.libro = m;
      assert.deepEqual([r.sales.orders, r.sales.hourly, r.totalSales], [m.orders, m.hourly, m.orders + m.hourly], "ventas");
      assert.deepEqual([r.expenses.total, r.payroll.total], [m.expenses, m.payroll], "gastos/nómina");
      assert.equal(r.netProfit, m.orders + m.hourly - m.expenses - m.payroll, "utilidad");
      for (const b of [N, S]) { const rb = await adm(`/sd/report/${mo}?branchId=${b.id}`); f["pedidos_" + b.name] = rb.sales.orders; assert.equal(rb.sales.orders, m.ordersBy[b.id], "comisión por sucursal " + b.name); }
      const t0 = performance.now();
      const xr = await realFetch(`${origin}/api/sd/closes/export/${mo}`, { headers: { Authorization: "Bearer " + tokA } }); assert.equal(xr.status, 200, "Excel");
      const buf = Buffer.from(await xr.arrayBuffer()); const msExcel = Math.round(performance.now() - t0);
      const wb = new ExcelJS.Workbook(); await wb.xlsx.load(buf as any);
      const vals: Record<string, any> = {}; wb.getWorksheet("CIERRE MES")!.eachRow((row: any) => { vals[String(row.getCell(5).value)] = row.getCell(6).value; });
      f.excel = { ventas: vals["TOTAL VENTAS"], ganancia: vals["GANANCIA (Utilidad Neta)"] };
      assert.deepEqual([f.excel.ventas, f.excel.ganancia], [m.orders + m.hourly, m.orders + m.hourly - m.expenses - m.payroll], "Excel");
      const before = await ok(`/shifts/${d}/expected`); assert.deepEqual([before.expectedCash, before.expectedBank], [L.cash, L.bank], "esperado antes del cierre de mes");
      const t1 = performance.now();
      const mc = await adm("/sd/closes", "POST", { month: mo, initialCash: before.expectedCash, initialBank: before.expectedBank });
      const msClose = Math.round(performance.now() - t1);
      f.cierre = { mes: mc.month, ventas: mc.totalSales, utilidad: mc.netProfit }; assert.equal(mc.totalSales, m.orders + m.hourly);
      closedMonths.add(mo); anchor = new Date(mc.closedAt).getTime(); closeSnap[mo] = { ventas: r.totalSales, utilidad: r.netProfit, gastos: r.expenses.total, nomina: r.payroll.total };
      const after = await ok(`/shifts/${d}/expected`); assert.deepEqual([after.expectedCash, after.expectedBank], [L.cash, L.bank], "el cierre de mes cambió el esperado");
      assert.equal((await api("/sd/closes", "POST", { month: mo, initialCash: 1, initialBank: 1 }, tokA)).status, 409, "segundo cierre");
      f.retro = (await api("/movements", "POST", { date: `${mo}-15`, category: 3, type: "egreso", medium: "cash", amount: 1000, description: "tarde", status: "confirmed" }, tokA)).status; assert.equal(f.retro, 409);
      const r2 = await adm(`/sd/report/${mo}`); assert.deepEqual([r2.totalSales, r2.netProfit], [r.totalSales, r.netProfit], "el reporte cambió al cerrar");
      // Crecimiento: tiempos de pantallas pesadas, tamaño de la BD y memoria del proceso.
      const todo = await timed("historial-todo (no lo pide la interfaz)", `/days/summaries?from=2026-08-22&to=${addDays(d, -1)}`);
      const heavy = [await timed("historial-mes (pantalla Historial)", `/days/summaries?from=${mo}-01&to=${addDays(d, -1)}`), await timed("movimientos-mes", `/movements/unified?from=${mo}-01&to=${addDays(d, -1)}`), await timed("deudas", "/sd/dashboard/debts"), await timed("dashboard", "/sd/dashboard/full")];
      const size = (await p.$queryRawUnsafe(`select pg_database_size(current_database())::bigint as s`) as any[])[0].s;
      const counts = { pedidos: await p.shipdayOrder.count(), bases: await p.baseTransaction.count(), pagos: await p.driverPayment.count(), banco: await p.bankTransaction.count(), movimientos: await p.movement.count(), cierres: await p.shiftClose.count() };
      monthly.push({ mes: mo, msReporte: tr.ms, msExcel, msCierreMes: msClose, pesadas: heavy.map(h => [h.label, h.ms]), historialTodoMs: todo.ms, bdMB: Math.round(Number(size) / 1048576 * 10) / 10, heapMB: Math.round(process.memoryUsage().heapUsed / 1048576), filas: counts });
      f.crecimiento = monthly[monthly.length - 1];
      for (const [label, ms] of [["reporte", tr.ms], ["excel", msExcel], ["cierre de mes", msClose], ...heavy.map(h => [h.label, h.ms])] as [string, number][]) assert.ok(ms < 10000, `${label} tardó ${ms} ms`);
    });
  }

  for (const [j, d] of days.entries()) {
    const i = I0 + j;
    if (d.endsWith("-01")) { await monthClose(d); if (!results[results.length - 1].ok) break; }
    setNow(`${d}T22:00:00-05:00`); resign();
    const idle = i % 7 === 6, high = i % 10 === 3, mult = high ? 3 : 1;
    const kind = idle ? "sin actividad" : high ? "ALTA actividad" : "normal";
    await check(`AP-${String(j + 1).padStart(3, "0")}`, `Día ${d} (${kind})`, async f => {
      const m = M(d);
      assert.equal((await ok("/shifts/current-date")).date, d, "día operativo");
      if (!idle) {
        if (i % 2 === 0) { const am = await ok("/shifts", "POST", { date: d, shift: "AM", receivedBy: "Operador", handedBy: "Noche", denominations: denominate(L.cash - L.physicalShort), expectedAmount: L.cash, bankCounted: L.bank }); f.am = am.difference; assert.equal(am.difference, L.physicalShort ? -L.physicalShort : 0); }
        if (L.physicalShort) { await adm("/bank-transactions", "POST", { type: "egreso", medium: "cash", amount: L.physicalShort, description: "Faltante de caja día anterior", noCounterpart: true }); L.cash -= L.physicalShort; f.ajusteFaltante = L.physicalShort; L.physicalShort = 0; }
        for (let k = 0; k < 4; k++) {
          const g = 10000 + 5000 * ((i + k) % 3), gb = i % 5 === 0 && k === 0 ? 5000 : 0;
          await ok(`/sd/bases/${drivers[k].id}/give`, "POST", gb ? { cashAmount: g, bankAmount: gb } : { cashAmount: g });
          L.cash -= g; L.bank -= gb; L.base[k] += g + gb;
        }
        for (let r = 0; r < mult; r++) for (let k = 0; k < 4; k++) {
          const fee = 6000 + 1000 * ((i + k + r) % 6), at = new Date(`${d}T${String(11 + r * 3 + k).padStart(2, "0")}:15:00-05:00`).getTime();
          const id = `ap-${d}-${r}-${k}`;
          await hook(branchOf(k).id, { event: "ORDER_COMPLETED", order: { id, order_number: String(++orderSeq), delivery_fee: fee, delivery_time: at }, carrier: { id: drivers[k].shipdayDriverId } });
          if (r === 0 && k === 1) await hook(branchOf(k).id, { event: "ORDER_COMPLETED", order: { id, order_number: String(orderSeq), delivery_fee: fee, delivery_time: at }, carrier: { id: drivers[k].shipdayDriverId } });
          const c = commission(fee); L.net[k] += c; m.orders += c; m.ordersBy[branchOf(k).id] += c; m.nOrders++;
        }
        // Volumen de uso prolongado: BULK pedidos más por día, repartidos de 08:00 a 19:59.
        for (let b = 0; b < BULK; b++) {
          const k = b % 4, fee = 5000 + 1000 * ((i + b) % 5);
          const at = new Date(`${d}T${String(8 + (b % 12)).padStart(2, "0")}:${String((b * 7) % 60).padStart(2, "0")}:00-05:00`).getTime();
          await hook(branchOf(k).id, { event: "ORDER_COMPLETED", order: { id: `apb-${d}-${b}`, order_number: String(++orderSeq), delivery_fee: fee, delivery_time: at }, carrier: { id: drivers[k].shipdayDriverId } });
          const c = commission(fee); L.net[k] += c; m.orders += c; m.ordersBy[branchOf(k).id] += c; m.nOrders++;
        }
        if (i % 3 === 1) {
          const k = i % 4, v = 12000; const key = `man-${d}`;
          const o = await ok("/sd/orders/manual", "POST", { branchId: branchOf(k).id, driverId: drivers[k].id, deliveryValue: v, orderNumber: `M-${i}`, idempotencyKey: key });
          const o2 = await ok("/sd/orders/manual", "POST", { branchId: branchOf(k).id, driverId: drivers[k].id, deliveryValue: v, orderNumber: `M-${i}`, idempotencyKey: key });
          assert.equal(o2.id, o.id, "reintento del pedido manual duplicó");
          const c = commission(v); L.net[k] += c; m.orders += c; m.ordersBy[branchOf(k).id] += c; m.nOrders++;
          manualOrders.push({ id: o.id, drv: k, c, month: d.slice(0, 7), branch: branchOf(k).id });
        }
        for (let k = 0; k < 4; k++) {
          const owe = Math.max(L.net[k], 0), b = L.base[k];
          const partial = (i % 6 === 2 && k === 3) || (i % 4 === 2 && k === 1);
          if (k === 2 && i % 5 === 3) { f.sinPago = drivers[k].name; continue; }
          const over = k === 0 && i % 10 === 7 ? 3000 : 0;
          const amount = partial ? Math.floor((owe + b) / 2000) * 1000 : owe + b + over;
          const baseAmount = Math.min(b, amount);
          if (amount <= 0) continue;
          const medium = (i + k) % 3 === 0 ? "bank" : "cash";
          await ok(`/sd/drivers/${drivers[k].id}/payment`, "POST", { amount, medium, baseAmount });
          if (medium === "cash") L.cash += amount; else L.bank += amount;
          L.base[k] -= baseAmount; L.net[k] -= amount - baseAmount;
        }
        if (i % 20 === 18 && L.net[0] < 0) { await ok(`/sd/drivers/${drivers[0].id}/pay-credit`, "POST", { medium: "cash" }); L.cash += L.net[0]; f.creditoDevuelto = -L.net[0]; L.net[0] = 0; }
        if (i % 4 === 0 && L.base[0] > 0) { await ok(`/sd/bases/${drivers[0].id}/pay`, "POST", { cashAmount: L.base[0] }); L.cash += L.base[0]; L.base[0] = 0; }
        const exp = 2000 + 1000 * (i % 5), med = i % 2 ? "bank" : "cash";
        const g = await ok("/movements", "POST", { date: d, category: med === "cash" ? 3 : 4, type: "egreso", medium: med, amount: exp, description: `Gasto ${i}`, status: "confirmed" });
        assert.equal(g.status, "pending", "el operador creó un gasto confirmado");
        if (i % 5 === 4) { await adm(`/movements/${g.id}/reject`, "POST", {}); f.gastoRechazado = exp; }
        else { await adm(`/movements/${g.id}/approve`, "POST", {}); if (med === "cash") L.cash -= exp; else L.bank -= exp; m.expenses += exp; gastoIds.push({ id: g.id, amount: exp, medium: med, month: d.slice(0, 7), day: d }); }
        if (i % 7 === 5) for (const w of [w1, w2]) { await adm("/movements", "POST", { date: d, category: 15, type: "egreso", medium: "cash", amount: 50000, description: `Nómina ${w.name}`, workerId: w.id, status: "confirmed" }); L.cash -= 50000; m.payroll += 50000; }
        if (i % 3 === 0) { await ok("/bank-transactions", "POST", { type: "ingreso", medium: "bank", amount: 15000, description: `Consignación ${i}`, noCounterpart: true }); L.bank += 15000; }
        if (i % 8 === 2) {
          const out = await ok("/bank-transactions", "POST", { type: "egreso", medium: "bank", amount: 40000, description: `Préstamo a caja menor ${i}` });
          await ok("/bank-transactions", "POST", { type: "ingreso", medium: "cash", amount: 40000, description: `Retorno ${i}`, pairWith: out.id });
          L.bank -= 40000; L.cash += 40000;
        }
        if (i % 4 === 1) { const t = i % 8 === 1 ? "efectivo_a_banco" : "banco_a_efectivo"; await ok("/sd/conversions", "POST", { branchId: (i % 2 ? N : S).id, amount: 20000, type: t }); if (t === "efectivo_a_banco") { L.cash -= 20000; L.bank += 20000; } else { L.cash += 20000; L.bank -= 20000; } }
        if (i % 7 === 3) { await adm("/sd/conversions", "POST", { branchId: N.id, amount: 150000, type: "banco_a_efectivo" }); L.cash += 150000; L.bank -= 150000; }
        // Con más volumen la caja crece: consignar el excedente al banco una vez por semana (efectivo → banco).
        if (i % 7 === 0 && L.cash > 3000000) { const x = Math.floor((L.cash - 2500000) / 1000) * 1000; await adm("/sd/conversions", "POST", { branchId: S.id, amount: x, type: "efectivo_a_banco" }); L.cash -= x; L.bank += x; f.consignado = x; }
        if (i % 2 === 1) { await ok(`/clients/${cFiado.id}/debt`, "POST", { description: `Fiado ${i}`, amount: 8000 }); L.client[cFiado.id] += 8000; }
        if (i % 5 === 1) { await ok(`/clients/${cFiado.id}/pay`, "POST", { amount: 6000, medium: i % 2 ? "cash" : "bank" }); L.client[cFiado.id] -= 6000; if (i % 2) L.cash += 6000; else L.bank += 6000; }
        if (i % 15 === 2) { await ok(`/clients/${cPrest.id}/debt`, "POST", { description: `Préstamo ${i}`, amount: 30000, medium: "cash" }); L.client[cPrest.id] += 30000; L.cash -= 30000; }
        if (i % 15 === 9 && L.client[cPrest.id] > 0) { await ok(`/clients/${cPrest.id}/pay`, "POST", { amount: 10000, medium: "bank" }); L.client[cPrest.id] -= 10000; L.bank += 10000; }
        if (i % 3 === 2) {
          const payNow = i % 2 === 0;
          const sh = await ok(`/hourly-clients/${hc.id}/shifts`, "POST", { driverId: drivers[2].id, startTime: "14:00", endTime: "16:00", medium: payNow ? "bank" : "cash" });
          L.hourlyOwed += 2 * 9000 + 2 * 14000; m.hourly += 2 * 14000;
          if (payNow) L.bank -= 18000; else L.cash -= 18000; f.turno = sh.id ? "ok" : "?";
        }
        if (i % 6 === 5 && L.hourlyOwed > 0) { await ok(`/hourly-clients/${hc.id}/pay`, "POST", { payAll: true, medium: "bank" }); L.bank += L.hourlyOwed; L.hourlyOwed = 0; }
        // D7: gasto olvidado AYER. Si ayer pertenece a un mes ya cerrado, la aprobación debe rechazarse sin efecto.
        if (i % 9 === 7) {
          const prev = addDays(d, -1);
          const rq = await ok("/edit-requests", "POST", { requestType: "create", entityType: "BankTransaction", entityId: "nuevo", entityLabel: "", changes: { date: prev, type: "egreso", medium: "cash", amount: 3000, description: "Gasto olvidado ayer", noCounterpart: true }, reason: "Se olvidó registrar" }).catch((e: any) => ({ error: String(e.message) }));
          if (beforeAnchor(prev)) {
            f.d7MesCerrado = rq.error ? "creación rechazada" : (await api(`/edit-requests/${rq.id}/review`, "POST", { action: "approved" }, tokA)).status;
            assert.ok(rq.error || f.d7MesCerrado >= 400, "se aprobó una corrección sobre un mes cerrado");
            if (!rq.error) await adm(`/edit-requests/${rq.id}/review`, "POST", { action: "rejected" });
          } else {
            assert.ok(!rq.error, "solicitud D7 rechazada: " + rq.error);
            await adm(`/edit-requests/${rq.id}/review`, "POST", { action: "approved" });
            L.cash -= 3000; adjFrom(prev, -3000, 0);
            const sc = await p.shiftClose.findUniqueOrThrow({ where: { date_shift: { date: prev, shift: "close" } } });
            f.d7 = { dia: prev }; assert.ok(JSON.stringify((sc as any).corrections ?? "").includes("3000"), "la corrección D7 no quedó en el Cierre del día");
          }
        }
        if (i % 14 === 10 && manualOrders.length) {
          const o = manualOrders.shift()!;
          const rq = await ok("/edit-requests", "POST", { requestType: "delete", entityType: "ShipdayOrder", entityId: o.id, entityLabel: "Pedido manual", reason: "Pedido duplicado" }).catch((e: any) => ({ error: String(e.message) }));
          if (closedMonths.has(o.month)) {
            f.borrarPedidoMesCerrado = rq.error ? "creación rechazada" : (await api(`/edit-requests/${rq.id}/review`, "POST", { action: "approved" }, tokA)).status;
            assert.ok(rq.error || f.borrarPedidoMesCerrado >= 400, "se borró un pedido de un mes cerrado");
            if (!rq.error) await adm(`/edit-requests/${rq.id}/review`, "POST", { action: "rejected" });
          } else {
            await adm(`/edit-requests/${rq.id}/review`, "POST", { action: "approved" });
            L.net[o.drv] -= o.c; const mm = L.month[o.month]; mm.orders -= o.c; mm.ordersBy[o.branch] -= o.c; mm.nOrders--; f.pedidoEliminado = o.c;
          }
        }
        if (i % 14 === 11 && gastoIds.length) {
          const gx = gastoIds.pop()!;
          if (gx.month === d.slice(0, 7)) {
            const rq = await ok("/edit-requests", "POST", { requestType: "delete", entityType: "Movement", entityId: gx.id, entityLabel: "Gasto", reason: "Mal registrado" });
            await adm(`/edit-requests/${rq.id}/review`, "POST", { action: "approved" });
            if (gx.medium === "cash") L.cash += gx.amount; else L.bank += gx.amount; L.month[gx.month].expenses -= gx.amount; f.gastoEliminado = gx.amount;
            adjFrom(gx.day, gx.medium === "cash" ? gx.amount : 0, gx.medium === "bank" ? gx.amount : 0);
          }
        }
      }
      const te = performance.now(); const e = await ok(`/shifts/${d}/expected`); const msExp = Math.round(performance.now() - te);
      f.esperado = [e.expectedCash, e.expectedBank]; f.libro = [L.cash, L.bank];
      assert.deepEqual(f.esperado, f.libro, "esperado del sistema ≠ libro independiente");
      const td = performance.now(); await verifyBalances(f, d); const msBal = Math.round(performance.now() - td);
      const ts = performance.now(); const s = await ok(`/days/${d}/summary`); const msSum = Math.round(performance.now() - ts);
      assert.equal(s.initialTotal + s.ingresos - s.egresos, s.finalTotal, "el Historial no encadena");
      const short = !idle && i % 11 === 6 ? 1000 : 0;
      const tc = performance.now();
      const close = await ok("/shifts", "POST", { date: d, shift: "close", receivedBy: "Operador", denominations: denominate(L.cash - short), expectedAmount: L.cash, bankCounted: L.bank });
      const msClose = Math.round(performance.now() - tc);
      f.cierre = [close.difference, close.bankDifference]; assert.deepEqual(f.cierre, [short ? -short : 0, 0]);
      if (short) { L.physicalShort = short; L.redDays.push(d); }
      perf.push({ dia: d, esperado: msExp, saldos: msBal, historialDia: msSum, cierre: msClose });
      ledgerLog.push({ dia: d, tipo: kind, efectivo: L.cash, banco: L.bank, comisiones: [...L.net], bases: [...L.base], clientes: { ...L.client }, porHora: L.hourlyOwed, faltante: short });
    });
    if (!results[results.length - 1].ok) break;
  }

  const lastDay = ledgerLog.length ? ledgerLog[ledgerLog.length - 1].dia : opDay;
  const nextOp = addDays(lastDay, 1);
  setNow(`${nextOp}T09:00:00-05:00`); resign();
  await check("AP-90", "Al final del período: día operativo siguiente, semáforo = solo días con faltante, Historial encadenado de punta a punta (ronda 1 + ronda 2)", async f => {
    f.cur = (await ok("/shifts/current-date")).date; assert.equal(f.cur, nextOp);
    const closes = await p.shiftClose.findMany({ where: { shift: "close", date: { gte: "2026-10-22" } } });
    f.rojos = closes.filter((c: any) => c.difference !== 0 || (c.bankDifference ?? 0) !== 0).map((c: any) => c.date).sort();
    assert.deepEqual(f.rojos, [...L.redDays].sort());
    const t0 = performance.now();
    const arr = await adm(`/days/summaries?from=2026-08-22&to=${lastDay}`) as any[];
    f.msHistorialCompleto = Math.round(performance.now() - t0); f.dias = arr.length;
    // (1) Consistencia interna: saldo final de cada día cerrado = esperado guardado en su Cierre + correcciones D7 posteriores.
    const allCloses = new Map((await p.shiftClose.findMany({ where: { shift: "close" } })).map((c: any) => [c.date, c]));
    const incons: any[] = [];
    for (const s of arr) { const c: any = allCloses.get(s.date); if (!c) continue; const corr = (Array.isArray(c.corrections) ? c.corrections : []) as any[];
      const ec = c.totalExpected + corr.reduce((t, x) => t + (x.cashDelta ?? 0), 0), eb = (c.bankExpected ?? 0) + corr.reduce((t, x) => t + (x.bankDelta ?? 0), 0);
      if (s.finalCash !== ec || s.finalBank !== eb) incons.push({ dia: s.date, historial: [s.finalCash, s.finalBank], cierreMasCorrecciones: [ec, eb] }); }
    f.diasInconsistentes = incons.slice(0, 8); assert.equal(incons.length, 0, "Historial ≠ Cierre + correcciones");
    // (2) Libro independiente (días de la ronda 2): saldo final = libro al cerrar + correcciones aprobadas después.
    const byDate = new Map(arr.map((s: any) => [s.date, s]));
    const malosLibro = ledgerLog.filter(x => { const s: any = byDate.get(x.dia); const a = adj[x.dia] ?? { c: 0, b: 0 }; return !s || s.finalCash !== x.efectivo + a.c || s.finalBank !== x.banco + a.b; }).map(x => ({ dia: x.dia, historial: [(byDate.get(x.dia) as any)?.finalCash, (byDate.get(x.dia) as any)?.finalBank], libro: [x.efectivo + (adj[x.dia]?.c ?? 0), x.banco + (adj[x.dia]?.b ?? 0)] }));
    f.diasDistintosAlLibro = malosLibro.slice(0, 8); assert.equal(malosLibro.length, 0, "Historial ≠ libro independiente");
    for (let k = 1; k < arr.length; k++) assert.equal(arr[k].initialTotal, arr[k - 1].finalTotal, "cadena rota en " + arr[k].date);
    // El esperado guardado en cada Cierre de la ronda 2 = libro de ese día.
    const byDay = new Map(closes.map((c: any) => [c.date, c]));
    const malos = ledgerLog.filter(x => { const c: any = byDay.get(x.dia); return !c || c.totalExpected !== x.efectivo || c.bankExpected !== x.banco; }).map(x => x.dia);
    f.cierresConEsperadoDistinto = malos.slice(0, 10); assert.equal(malos.length, 0);
  });
  await check("AP-91", "Inmutabilidad: los reportes de TODOS los meses cerrados (ago-2026 en adelante) no cambiaron después de meses de operación", async f => {
    const diffs: any[] = [];
    for (const mo of [...closedMonths].sort()) { const r = await adm(`/sd/report/${mo}`); const now = { ventas: r.totalSales, utilidad: r.netProfit, gastos: r.expenses.total, nomina: r.payroll.total }; if (JSON.stringify(now) !== JSON.stringify(closeSnap[mo])) diffs.push({ mo, antes: closeSnap[mo], ahora: now }); }
    f.meses = [...closedMonths].sort(); f.diferencias = diffs; assert.equal(diffs.length, 0);
    const mcs = await p.monthlyClose.findMany({ orderBy: { month: "asc" } }); f.cierresGuardados = mcs.map((m: any) => m.month);
    assert.deepEqual(f.cierresGuardados, [...closedMonths].sort());
  });
  await check("AP-92", "Saldos finales = libro; ninguna fila de dinero tomó la hora REAL del PC (todas usan la hora del negocio)", async f => {
    await verifyBalances(f, "final");
    const lo = new RealDate(REAL_START - 60000), hi = new RealDate(RealDate.now() + 60000);
    f.filasConHoraReal = {
      bases: await p.baseTransaction.count({ where: { date: { gte: lo, lte: hi } } }),
      pagos: await p.driverPayment.count({ where: { date: { gte: lo, lte: hi } } }),
      conversiones: await p.conversion.count({ where: { date: { gte: lo, lte: hi } } }),
      banco: await p.bankTransaction.count({ where: { date: { gte: lo, lte: hi } } }),
      movimientos: await p.movement.count({ where: { createdAt: { gte: lo, lte: hi } } }),
      deudasClientes: await p.clientDebt.count({ where: { createdAt: { gte: lo, lte: hi } } }),
      abonosClientes: await p.clientDebtPayment.count({ where: { paidAt: { gte: lo, lte: hi } } }),
      pedidos: await p.shipdayOrder.count({ where: { deliveredAt: { gte: lo, lte: hi } } }),
      turnos: await p.hourlyShift.count({ where: { createdAt: { gte: lo, lte: hi } } }),
      cierres: await p.shiftClose.count({ where: { closedAt: { gte: lo, lte: hi } } }),
    };
    assert.ok(Object.values(f.filasConHoraReal).every(n => n === 0), "hay registros de dinero con la hora real del PC en vez de la del negocio");
  });
  await check("AP-93", "Rendimiento con meses de datos: ninguna operación diaria supera 3 s y el crecimiento queda registrado", async f => {
    const by = (k: string) => perf.map(x => x[k]);
    const avg = (a: number[]) => Math.round(a.reduce((s, x) => s + x, 0) / Math.max(1, a.length));
    const first = perf.slice(0, 30), lastP = perf.slice(-30);
    f.promedioPrimerMes = Object.fromEntries(["esperado", "saldos", "historialDia", "cierre"].map(k => [k, avg(first.map((x: any) => x[k]))]));
    f.promedioUltimoMes = Object.fromEntries(["esperado", "saldos", "historialDia", "cierre"].map(k => [k, avg(lastP.map((x: any) => x[k]))]));
    f.maximos = Object.fromEntries(["esperado", "saldos", "historialDia", "cierre"].map(k => [k, Math.max(...by(k))]));
    f.mensual = monthly;
    for (const [k, v] of Object.entries(f.maximos)) assert.ok((v as number) < 3000, `${k} llegó a ${v} ms`);
  });

  await new Promise<void>(r => server.close(() => r())); globalThis.fetch = realFetch; await p.$disconnect();
  const fails = results.filter(r => !r.ok).length;
  fs.writeFileSync(path.join(__dirname, "final-r2-prolongado-a.json"), JSON.stringify({ results, ledger: ledgerLog, months: L.month, perf, monthly }, null, 2));
  console.log(`TOTAL ${results.length} · OK ${results.length - fails} · FALLAS ${fails}`);
  process.exit(fails ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
