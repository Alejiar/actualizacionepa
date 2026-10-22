/**
 * AUDITORÍA FINAL PREPRODUCCIÓN (22-oct-2026) — Simulación A: DOS MESES de operación normal.
 * Sin tocar el reloj: la caja arranca atrasada 61 días (NEW02) y cada día se opera y se cierra,
 * cruzando dos cambios de mes, hasta alcanzar hoy; entonces se cierran los meses (NEW10).
 * Todo por HTTP contra las rutas reales, con dos roles (operador "user" y admin), dos sucursales,
 * pedidos por webhook y manuales, bases, pagos, gastos pendientes/aprobados, nómina, banco con
 * contrapartes, conversiones, clientes (fiado y préstamo), clientes por hora, solicitudes D7,
 * Recibo AM, Cierres (con faltantes reales) y reportes/Excel por sucursal.
 * El libro de control se calcula AQUÍ con las reglas del negocio (CLAUDE.md), sin reutilizar EPA.
 * SOLO contra la BD temporal local `cashbuddy_final_a`.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const u = new URL(process.env.DATABASE_URL || "invalid:");
if (u.pathname !== "/cashbuddy_final_a" || !["localhost", "127.0.0.1"].includes(u.hostname)) throw Error("Solo BD temporal local cashbuddy_final_a");

async function main() {
  const SRC = pathToFileURL(path.resolve(__dirname, "../src")).href;
  const { prisma: p } = await import(`${SRC}/lib/prisma.ts`);
  const { createServer } = await import(`${SRC}/server.ts`);
  const { signToken } = await import(`${SRC}/lib/jwt.ts`);
  const excel = await import(`${SRC}/services/excel.service.ts`);
  const { todayBogota, toBogotaDateStr } = await import(`${SRC}/lib/date-range.ts`);
  const ExcelJS = (await import("node:module")).createRequire(path.resolve(__dirname, "../package.json"))("exceljs");

  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any, init: any) => { if (!String(input).startsWith("http://127.0.0.1:")) throw Error("Red externa bloqueada: " + String(input)); return realFetch(input, init); }) as any;
  const server = createServer().listen(0, "127.0.0.1"); await new Promise<void>(r => server.once("listening", r));
  const origin = "http://127.0.0.1:" + (server.address() as any).port;
  const results: any[] = []; const ledgerLog: any[] = [];
  const check = async (id: string, name: string, fn: (f: any) => Promise<void>) => {
    const f: any = {};
    try { await fn(f); results.push({ id, name, ok: true, facts: f }); console.log(`OK    ${id} ${name}`); }
    catch (e: any) { results.push({ id, name, ok: false, facts: f, error: String(e?.stack || e).slice(0, 1500) }); console.log(`FALLA ${id} ${name}\n      ${JSON.stringify(f).slice(0, 900)} ${String(e?.message || e).slice(0, 900)}`); }
  };

  const today = todayBogota();
  const addDays = (d: string, n: number) => toBogotaDateStr(new Date(new Date(d + "T12:00:00-05:00").getTime() + n * 86400000));
  const start = addDays(today, -61), seedClose = addDays(start, -1);

  const tables = await p.$queryRawUnsafe(`SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename <> '_prisma_migrations'`) as any[];
  await p.$executeRawUnsafe("TRUNCATE TABLE " + tables.map((x: any) => '"' + x.tablename + '"').join(",") + " CASCADE");
  await p.settings.create({ data: { id: "singleton", initialCash: 2000000, initialBank: 1000000, setupComplete: true, termsAcceptedAt: new Date(), shipdayCommission: 30 } as any });
  const admin = await p.user.create({ data: { email: "admin@final.test", name: "Admin Final", role: "admin", passwordHash: "x" } });
  const oper = await p.user.create({ data: { email: "oper@final.test", name: "Operador Final", role: "user", passwordHash: "x" } });
  const N = await p.branch.create({ data: { name: "Sucursal Norte", apiKeyEnc: "test-only" } });
  const S = await p.branch.create({ data: { name: "Sucursal Sur", apiKeyEnc: "test-only" } });
  const drivers = [
    await p.driver.create({ data: { name: "Domi N1", shipdayDriverId: "7101", branchId: N.id } }),
    await p.driver.create({ data: { name: "Domi N2", shipdayDriverId: "7102", branchId: N.id } }),
    await p.driver.create({ data: { name: "Domi S1", shipdayDriverId: "7201", branchId: S.id } }),
    await p.driver.create({ data: { name: "Domi S2", shipdayDriverId: "7202", branchId: S.id } }),
  ];
  const branchOf = (i: number) => (i < 2 ? N : S);
  const w1 = await p.worker.create({ data: { name: "Auxiliar 1", color: "#888888" } as any });
  const w2 = await p.worker.create({ data: { name: "Auxiliar 2", color: "#444444" } as any });
  await p.shiftClose.create({ data: { date: seedClose, shift: "close", denominations: { bills: [{ value: 100000, qty: 20 }], coins: [] }, totalCounted: 2000000, totalExpected: 2000000, difference: 0, bankCounted: 1000000, bankExpected: 1000000, bankDifference: 0, closedAt: new Date(seedClose + "T22:00:00-05:00"), locked: true } as any });

  const tokA = signToken({ sub: admin.id, email: admin.email, name: admin.name, role: admin.role, tv: (admin as any).tokenVersion });
  const tokO = signToken({ sub: oper.id, email: oper.email, name: oper.name, role: oper.role, tv: (oper as any).tokenVersion });
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
  process.env.WEBHOOK_TOKEN = process.env.WEBHOOK_TOKEN || "final-a-token";
  const hook = async (branchId: string, body: unknown) => { const r = await realFetch(origin + "/api/webhooks/shipday/" + branchId, { method: "POST", headers: { "Content-Type": "application/json", token: process.env.WEBHOOK_TOKEN! }, body: JSON.stringify(body) }); if (r.status !== 200) throw Error("webhook " + r.status + " " + await r.text()); };
  const BILLS = [100000, 50000, 20000, 10000, 5000, 2000, 1000], COINS = [500, 200, 100, 50];
  function denominate(amount: number) {
    let rest = amount; const bills: any[] = [], coins: any[] = [];
    for (const v of BILLS) { const q = Math.floor(rest / v); if (q) { bills.push({ value: v, qty: q }); rest -= q * v; } }
    for (const v of COINS) { const q = Math.floor(rest / v); if (q) { coins.push({ value: v, qty: q }); rest -= q * v; } }
    assert.equal(rest, 0, "efectivo no denominable: " + amount); return { bills, coins };
  }
  const commission = (v: number) => Math.round(v * 0.3);

  const hc = await ok("/hourly-clients", "POST", { name: "Empresa por hora", driverHourValue: 9000, companyHourValue: 14000 });
  const cFiado = await ok("/clients", "POST", { name: "Tienda fiada" });
  const cPrest = await ok("/clients", "POST", { name: "Cliente préstamo" });

  // ── Libro de control independiente ────────────────────────────────────────────────
  const L = {
    cash: 2000000, bank: 1000000, physicalShort: 0,
    net: drivers.map(() => 0),            // comisiones: pendingDebt − creditAmount
    base: drivers.map(() => 0),           // base pendiente (Σ entregas − Σ devoluciones)
    client: { [cFiado.id]: 0, [cPrest.id]: 0 } as Record<string, number>,
    hourlyOwed: 0, hourlyDriverUnpaid: 0,
    month: {} as Record<string, { orders: number; ordersBy: Record<string, number>; hourly: number; expenses: number; payroll: number; nOrders: number }>,
    redDays: [] as string[],
  };
  const M = (d: string) => (L.month[d.slice(0, 7)] ??= { orders: 0, ordersBy: { [N.id]: 0, [S.id]: 0 }, hourly: 0, expenses: 0, payroll: 0, nOrders: 0 });
  const days: string[] = []; for (let d = start; d < today; d = addDays(d, 1)) days.push(d);
  let orderSeq = 0, pendingD7: { day: string; amount: number } | null = null;
  const manualOrders: { id: string; drv: number; c: number; month: string; branch: string }[] = [];
  const gastoIds: { id: string; amount: number; medium: string; month: string }[] = [];

  async function verifyBalances(f: any, label: string) {
    const ds = await ok("/sd/drivers");
    f.drivers = drivers.map((dr, k) => { const x = ds.find((y: any) => y.id === dr.id); return [x.pendingDebt - x.creditAmount, x.basePending]; });
    assert.deepEqual(f.drivers, drivers.map((_, k) => [L.net[k], L.base[k]]), label + ": saldos de domiciliarios ≠ libro");
    const cl = await ok("/clients");
    f.clients = [cFiado.id, cPrest.id].map(id => { const x = cl.find((y: any) => y.id === id); return x.pendingDebt; });
    assert.deepEqual(f.clients, [L.client[cFiado.id], L.client[cPrest.id]], label + ": deuda de clientes ≠ libro");
    const h = await ok(`/hourly-clients/${hc.id}`);
    f.hourly = h.pendingDebt;
    assert.equal(f.hourly, L.hourlyOwed, label + ": deuda del cliente por hora ≠ libro");
  }

  await check("A-00", `Arranque: caja abierta en ${start} (hoy ${today}); cerrar un mes con la caja atrasada se rechaza`, async f => {
    f.cur = (await ok("/shifts/current-date")).date; assert.equal(f.cur, start);
    f.cierreMes = (await api("/sd/closes", "POST", { month: start.slice(0, 7), initialCash: 1, initialBank: 1 }, tokA)).status; assert.equal(f.cierreMes, 409);
  });

  for (const [i, d] of days.entries()) {
    const idle = i % 7 === 6, high = i % 10 === 3, mult = high ? 3 : 1;
    const kind = idle ? "sin actividad" : high ? "ALTA actividad" : "normal";
    await check(`A-${String(i + 1).padStart(2, "0")}`, `Día ${d} (${kind})`, async f => {
      const m = M(d);
      assert.equal((await ok("/shifts/current-date")).date, d, "día operativo");
      if (!idle) {
        // Recibo AM (turno de la mañana) en días pares: no mueve dinero.
        if (i % 2 === 0) { const am = await ok("/shifts", "POST", { date: d, shift: "AM", receivedBy: "Operador", handedBy: "Noche", denominations: denominate(L.cash - L.physicalShort), expectedAmount: L.cash, bankCounted: L.bank }); f.am = am.difference; assert.equal(am.difference, L.physicalShort ? -L.physicalShort : 0); }
        // Ajuste del faltante del día anterior (lo registra el admin en la mañana).
        if (L.physicalShort) { await adm("/bank-transactions", "POST", { type: "egreso", medium: "cash", amount: L.physicalShort, description: "Faltante de caja día anterior", noCounterpart: true }); L.cash -= L.physicalShort; f.ajusteFaltante = L.physicalShort; L.physicalShort = 0; }
        // Bases de la mañana (efectivo; en días múltiplos de 5 una parte por banco).
        for (let k = 0; k < 4; k++) {
          const g = 10000 + 5000 * ((i + k) % 3), gb = i % 5 === 0 && k === 0 ? 5000 : 0;
          await ok(`/sd/bases/${drivers[k].id}/give`, "POST", gb ? { cashAmount: g, bankAmount: gb } : { cashAmount: g });
          L.cash -= g; L.bank -= gb; L.base[k] += g + gb;
        }
        // Pedidos: webhook (Shipday en prueba) y manuales.
        for (let r = 0; r < mult; r++) for (let k = 0; k < 4; k++) {
          const fee = 6000 + 1000 * ((i + k + r) % 6), at = new Date(`${d}T${String(11 + r * 3 + k).padStart(2, "0")}:15:00-05:00`).getTime();
          const id = `fa-${d}-${r}-${k}`;
          await hook(branchOf(k).id, { event: "ORDER_COMPLETED", order: { id, order_number: String(++orderSeq), delivery_fee: fee, delivery_time: at }, carrier: { id: drivers[k].shipdayDriverId } });
          if (r === 0 && k === 1) await hook(branchOf(k).id, { event: "ORDER_COMPLETED", order: { id, order_number: String(orderSeq), delivery_fee: fee, delivery_time: at }, carrier: { id: drivers[k].shipdayDriverId } }); // reenvío de Shipday
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
        // Pagos de la tarde: cada domiciliario paga su base y su comisión del día (efectivo o banco).
        for (let k = 0; k < 4; k++) {
          const owe = Math.max(L.net[k], 0), b = L.base[k];
          const partial = (i % 6 === 2 && k === 3) || (i % 4 === 2 && k === 1); // a veces paga solo una parte
          if (k === 2 && i % 5 === 3) { f.sinPago = drivers[k].name; continue; } // a veces no paga hasta otro día
          const over = k === 0 && i % 10 === 7 ? 3000 : 0; // pago de más → crédito a favor
          const amount = partial ? Math.floor((owe + b) / 2000) * 1000 : owe + b + over;
          const baseAmount = Math.min(b, amount);
          if (amount <= 0) continue;
          const medium = (i + k) % 3 === 0 ? "bank" : "cash";
          await ok(`/sd/drivers/${drivers[k].id}/payment`, "POST", { amount, medium, baseAmount });
          if (medium === "cash") L.cash += amount; else L.bank += amount;
          L.base[k] -= baseAmount; L.net[k] -= amount - baseAmount;
        }
        // Devolver el crédito a favor en efectivo (pay-credit) a veces.
        if (i % 20 === 18 && L.net[0] < 0) { await ok(`/sd/drivers/${drivers[0].id}/pay-credit`, "POST", { medium: "cash" }); L.cash += L.net[0]; f.creditoDevuelto = -L.net[0]; L.net[0] = 0; }
        // Devolución de base sin comisión (domiciliario que termina temprano), días múltiplos de 4.
        if (i % 4 === 0 && L.base[0] > 0) { await ok(`/sd/bases/${drivers[0].id}/pay`, "POST", { cashAmount: L.base[0] }); L.cash += L.base[0]; L.base[0] = 0; }
        // Gastos: el operador los deja pendientes; el admin aprueba (y uno de cada 5 lo rechaza).
        const exp = 2000 + 1000 * (i % 5), med = i % 2 ? "bank" : "cash";
        const g = await ok("/movements", "POST", { date: d, category: med === "cash" ? 3 : 4, type: "egreso", medium: med, amount: exp, description: `Gasto ${i}`, status: "confirmed" });
        assert.equal(g.status, "pending", "el operador creó un gasto confirmado");
        if (i % 5 === 4) { await adm(`/movements/${g.id}/reject`, "POST", {}); f.gastoRechazado = exp; }
        else { await adm(`/movements/${g.id}/approve`, "POST", {}); if (med === "cash") L.cash -= exp; else L.bank -= exp; m.expenses += exp; gastoIds.push({ id: g.id, amount: exp, medium: med, month: d.slice(0, 7) }); }
        // Nómina semanal (admin) a dos trabajadores.
        if (i % 7 === 5) for (const w of [w1, w2]) { await adm("/movements", "POST", { date: d, category: 15, type: "egreso", medium: "cash", amount: 50000, description: `Nómina ${w.name}`, workerId: w.id, status: "confirmed" }); L.cash -= 50000; m.payroll += 50000; }
        // Banco: consignación suelta; salida con retorno (contraparte) el mismo día; conversión por sucursal.
        if (i % 3 === 0) { await ok("/bank-transactions", "POST", { type: "ingreso", medium: "bank", amount: 15000, description: `Consignación ${i}`, noCounterpart: true }); L.bank += 15000; }
        if (i % 8 === 2) {
          const out = await ok("/bank-transactions", "POST", { type: "egreso", medium: "bank", amount: 40000, description: `Préstamo a caja menor ${i}` });
          await ok("/bank-transactions", "POST", { type: "ingreso", medium: "cash", amount: 40000, description: `Retorno ${i}`, pairWith: out.id });
          L.bank -= 40000; L.cash += 40000;
        }
        if (i % 4 === 1) { const t = i % 8 === 1 ? "efectivo_a_banco" : "banco_a_efectivo"; await ok("/sd/conversions", "POST", { branchId: (i % 2 ? N : S).id, amount: 20000, type: t }); if (t === "efectivo_a_banco") { L.cash -= 20000; L.bank += 20000; } else { L.cash += 20000; L.bank -= 20000; } }
        // Retiro semanal del banco para la caja (el admin lo convierte en la sucursal Norte).
        if (i % 7 === 3) { await adm("/sd/conversions", "POST", { branchId: N.id, amount: 150000, type: "banco_a_efectivo" }); L.cash += 150000; L.bank -= 150000; }
        // Clientes: fiado (sin medio), préstamo en efectivo y abonos.
        if (i % 2 === 1) { await ok(`/clients/${cFiado.id}/debt`, "POST", { description: `Fiado ${i}`, amount: 8000 }); L.client[cFiado.id] += 8000; }
        if (i % 5 === 1) { await ok(`/clients/${cFiado.id}/pay`, "POST", { amount: 6000, medium: i % 2 ? "cash" : "bank" }); L.client[cFiado.id] -= 6000; if (i % 2) L.cash += 6000; else L.bank += 6000; }
        if (i % 15 === 2) { await ok(`/clients/${cPrest.id}/debt`, "POST", { description: `Préstamo ${i}`, amount: 30000, medium: "cash" }); L.client[cPrest.id] += 30000; L.cash -= 30000; }
        if (i % 15 === 9 && L.client[cPrest.id] > 0) { await ok(`/clients/${cPrest.id}/pay`, "POST", { amount: 10000, medium: "bank" }); L.client[cPrest.id] -= 10000; L.bank += 10000; }
        // Clientes por hora: turno de 2 h; a veces se le paga al domiciliario en el acto, a veces después.
        if (i % 3 === 2) {
          const payNow = i % 2 === 0;
          const sh = await ok(`/hourly-clients/${hc.id}/shifts`, "POST", { driverId: drivers[2].id, startTime: "14:00", endTime: "16:00", medium: payNow ? "bank" : "cash" });
          L.hourlyOwed += 2 * 9000 + 2 * 14000; m.hourly += 2 * 14000;
          if (payNow) L.bank -= 18000; else L.cash -= 18000; f.turno = sh.id ? "ok" : "?";
        }
        if (i % 6 === 5 && L.hourlyOwed > 0) { await ok(`/hourly-clients/${hc.id}/pay`, "POST", { payAll: true, medium: "bank" }); L.bank += L.hourlyOwed; L.hourlyOwed = 0; }
        // D7: el día anterior se olvidó un gasto; el operador pide agregarlo y el admin aprueba.
        if (i % 9 === 7) {
          const prev = addDays(d, -1);
          const rq = await ok("/edit-requests", "POST", { requestType: "create", entityType: "BankTransaction", entityId: "nuevo", entityLabel: "", changes: { date: prev, type: "egreso", medium: "cash", amount: 3000, description: "Gasto olvidado ayer", noCounterpart: true }, reason: "Se olvidó registrar" });
          await adm(`/edit-requests/${rq.id}/review`, "POST", { action: "approved" });
          L.cash -= 3000; pendingD7 = { day: prev, amount: 3000 };
          const sc = await p.shiftClose.findUniqueOrThrow({ where: { date_shift: { date: prev, shift: "close" } } });
          f.d7 = { dia: prev, correcciones: (sc as any).corrections }; assert.ok(JSON.stringify((sc as any).corrections ?? "").includes("3000") || JSON.stringify((sc as any).corrections ?? "").includes("-3000"), "la corrección D7 no quedó en el Cierre del día");
        }
        // Solicitudes: corregir una base a la baja y eliminar un pedido manual y un gasto (cada ~2 semanas).
        if (i % 14 === 10 && manualOrders.length) {
          const o = manualOrders.shift()!;
          const rq = await ok("/edit-requests", "POST", { requestType: "delete", entityType: "ShipdayOrder", entityId: o.id, entityLabel: "Pedido manual", reason: "Pedido duplicado" });
          await adm(`/edit-requests/${rq.id}/review`, "POST", { action: "approved" });
          L.net[o.drv] -= o.c; const mm = L.month[o.month]; mm.orders -= o.c; mm.ordersBy[o.branch] -= o.c; mm.nOrders--; f.pedidoEliminado = o.c;
        }
        if (i % 14 === 11 && gastoIds.length) {
          const gx = gastoIds.pop()!;
          if (gx.month === d.slice(0, 7)) {
            const rq = await ok("/edit-requests", "POST", { requestType: "delete", entityType: "Movement", entityId: gx.id, entityLabel: "Gasto", reason: "Mal registrado" });
            await adm(`/edit-requests/${rq.id}/review`, "POST", { action: "approved" });
            if (gx.medium === "cash") L.cash += gx.amount; else L.bank += gx.amount; L.month[gx.month].expenses -= gx.amount; f.gastoEliminado = gx.amount;
          }
        }
      }
      // Libro vs sistema antes del Cierre.
      const e = await ok(`/shifts/${d}/expected`); f.esperado = [e.expectedCash, e.expectedBank]; f.libro = [L.cash, L.bank];
      assert.deepEqual(f.esperado, f.libro, "esperado del sistema ≠ libro independiente");
      await verifyBalances(f, d);
      const s = await ok(`/days/${d}/summary`);
      assert.equal(s.initialTotal + s.ingresos - s.egresos, s.finalTotal, "el Historial no encadena");
      // Cierre: cada 11 días el conteo físico sale con 1.000 de menos (faltante real).
      const short = !idle && i % 11 === 6 ? 1000 : 0;
      const close = await ok("/shifts", "POST", { date: d, shift: "close", receivedBy: "Operador", denominations: denominate(L.cash - short), expectedAmount: L.cash, bankCounted: L.bank });
      f.cierre = [close.difference, close.bankDifference]; assert.deepEqual(f.cierre, [short ? -short : 0, 0]);
      if (short) { L.physicalShort = short; L.redDays.push(d); }
      ledgerLog.push({ dia: d, tipo: kind, efectivo: L.cash, banco: L.bank, comisiones: [...L.net], bases: [...L.base], clientes: { ...L.client }, porHora: L.hourlyOwed, faltante: short });
    });
    if (!results[results.length - 1].ok) break; // un día fallido invalida el resto de la cadena
  }

  await check("A-90", `Hoy ${today} la caja quedó al día; semáforo del Historial = solo los días con faltante`, async f => {
    f.cur = (await ok("/shifts/current-date")).date; assert.equal(f.cur, today);
    const sums = await ok(`/days/summaries?from=${start}&to=${addDays(today, -1)}`).catch(() => null);
    const closes = await p.shiftClose.findMany({ where: { shift: "close", date: { gte: start } } });
    f.rojos = closes.filter((c: any) => c.difference !== 0 || (c.bankDifference ?? 0) !== 0).map((c: any) => c.date).sort();
    assert.deepEqual(f.rojos, [...L.redDays].sort());
    f.resumenes = Array.isArray(sums) ? sums.length : typeof sums;
  });
  const months = Object.keys(L.month).sort();
  for (const mo of months.filter(x => x < today.slice(0, 7))) {
    await check(`A-91-${mo}`, `Reporte, reporte por sucursal y Excel de ${mo} = libro independiente`, async f => {
      const m = L.month[mo]; const r = await adm(`/sd/report/${mo}`);
      f.reporte = { pedidos: r.sales.orders, hora: r.sales.hourly, ventas: r.totalSales, gastos: r.expenses.total, nomina: r.payroll.total, utilidad: r.netProfit };
      f.libro = m;
      assert.deepEqual([r.sales.orders, r.sales.hourly, r.totalSales], [m.orders, m.hourly, m.orders + m.hourly], "ventas");
      assert.deepEqual([r.expenses.total, r.payroll.total], [m.expenses, m.payroll], "gastos/nómina");
      assert.equal(r.netProfit, m.orders + m.hourly - m.expenses - m.payroll, "utilidad");
      for (const b of [N, S]) { const rb = await adm(`/sd/report/${mo}?branchId=${b.id}`); f["pedidos_" + b.name] = rb.sales.orders; assert.equal(rb.sales.orders, m.ordersBy[b.id], "comisión por sucursal " + b.name); }
      const wb = new ExcelJS.Workbook(); await wb.xlsx.load(await excel.buildMonthlyExcel(mo) as any);
      const vals: Record<string, any> = {}; wb.getWorksheet("CIERRE MES")!.eachRow((row: any) => { vals[String(row.getCell(5).value)] = row.getCell(6).value; });
      f.excel = { ventas: vals["TOTAL VENTAS"], ganancia: vals["GANANCIA (Utilidad Neta)"] };
      assert.deepEqual([f.excel.ventas, f.excel.ganancia], [m.orders + m.hourly, m.orders + m.hourly - m.expenses - m.payroll], "Excel");
    });
  }
  await check("A-92", `Saldos finales (domiciliarios, clientes, cliente por hora) = libro`, async f => { await verifyBalances(f, "final"); });
  for (const mo of months.filter(x => x < today.slice(0, 7))) {
    await check(`A-93-${mo}`, `Cierre del mes ${mo} con la caja al día: saldos intactos, segundo cierre 409, dinero retroactivo 409`, async f => {
      const before = await ok(`/shifts/${today}/expected`);
      const mc = await adm("/sd/closes", "POST", { month: mo, initialCash: before.expectedCash, initialBank: before.expectedBank });
      f.cierre = { mes: mc.month, ventas: mc.totalSales, utilidad: mc.netProfit };
      assert.equal(mc.totalSales, L.month[mo].orders + L.month[mo].hourly);
      const after = await ok(`/shifts/${today}/expected`); assert.deepEqual([after.expectedCash, after.expectedBank], [L.cash, L.bank]);
      assert.equal((await api("/sd/closes", "POST", { month: mo, initialCash: 1, initialBank: 1 }, tokA)).status, 409, "segundo cierre");
      f.retro = (await api("/movements", "POST", { date: `${mo}-15`, category: 3, type: "egreso", medium: "cash", amount: 1000, description: "tarde", status: "confirmed" }, tokA)).status;
      assert.equal(f.retro, 409);
      f.retroD7 = (await api("/edit-requests", "POST", { requestType: "create", entityType: "BankTransaction", entityId: "nuevo", entityLabel: "", changes: { date: `${mo}-15`, type: "egreso", medium: "cash", amount: 1, description: "x" }, reason: "x" })).status;
    });
  }
  await check("A-94", "Después de los cierres de mes, el dinero de hoy entra y el esperado sigue al libro", async f => {
    await ok(`/sd/bases/${drivers[0].id}/give`, "POST", { cashAmount: 7000 }); L.cash -= 7000; L.base[0] += 7000;
    const e = await ok(`/shifts/${today}/expected`); f.esperado = [e.expectedCash, e.expectedBank]; f.libro = [L.cash, L.bank];
    assert.deepEqual(f.esperado, f.libro);
  });

  await new Promise<void>(r => server.close(() => r())); globalThis.fetch = realFetch; await p.$disconnect();
  const fails = results.filter(r => !r.ok).length;
  fs.writeFileSync(path.join(__dirname, "final-2meses-normal.json"), JSON.stringify({ results, ledger: ledgerLog, months: L.month }, null, 2));
  console.log(`TOTAL ${results.length} · OK ${results.length - fails} · FALLAS ${fails}`);
  process.exit(fails ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
