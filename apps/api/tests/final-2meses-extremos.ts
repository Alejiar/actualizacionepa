/**
 * AUDITORÍA FINAL PREPRODUCCIÓN (22-oct-2026) — Simulación B: DOS MESES de casos extremos.
 * Misma mecánica que la A (caja atrasada 61 días, NEW02, sin tocar el reloj), con operación base
 * diaria y, repartidos en el calendario, escenarios de error con su RESULTADO ESPERADO escrito antes
 * de ejecutarlos: duplicados, doble clic concurrente, reintentos, cortes de conexión, sesión vencida,
 * cambio de contraseña, permisos, dos usuarios a la vez, doble cierre, operaciones fuera de orden,
 * anulación después de pagar, estados inesperados, datos inválidos, cierres con diferencia,
 * medianoche, cambio de mes, REINICIO REAL del servidor (proceso dist matado en plena ráfaga) y
 * meses cerrados. Tras cada día: esperado y saldos = libro independiente.
 * SOLO contra la BD temporal local `cashbuddy_final_b`.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import cp from "node:child_process";
import { pathToFileURL } from "node:url";

const u = new URL(process.env.DATABASE_URL || "invalid:");
if (u.pathname !== "/cashbuddy_final_b" || !["localhost", "127.0.0.1"].includes(u.hostname)) throw Error("Solo BD temporal local cashbuddy_final_b");

async function main() {
  const SRC = pathToFileURL(path.resolve(__dirname, "../src")).href;
  const { prisma: p } = await import(`${SRC}/lib/prisma.ts`);
  const { createServer } = await import(`${SRC}/server.ts`);
  const { signToken } = await import(`${SRC}/lib/jwt.ts`);
  const { todayBogota, toBogotaDateStr } = await import(`${SRC}/lib/date-range.ts`);
  const req = (await import("node:module")).createRequire(path.resolve(__dirname, "../package.json"));
  const jwt = req("jsonwebtoken");

  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any, init: any) => { if (!String(input).startsWith("http://127.0.0.1:")) throw Error("Red externa bloqueada: " + String(input)); return realFetch(input, init); }) as any;
  const server = createServer().listen(0, "127.0.0.1"); await new Promise<void>(r => server.once("listening", r));
  let origin = "http://127.0.0.1:" + (server.address() as any).port;
  const results: any[] = [];
  const check = async (id: string, name: string, esperado: string, fn: (f: any) => Promise<void>) => {
    const f: any = {};
    try { await fn(f); results.push({ id, name, esperado, ok: true, facts: f }); console.log(`OK    ${id} ${name}`); }
    catch (e: any) { results.push({ id, name, esperado, ok: false, facts: f, error: String(e?.stack || e).slice(0, 1500) }); console.log(`FALLA ${id} ${name}\n      esperado: ${esperado}\n      ${JSON.stringify(f).slice(0, 900)} ${String(e?.message || e).slice(0, 900)}`); }
  };

  const today = todayBogota();
  const addDays = (d: string, n: number) => toBogotaDateStr(new Date(new Date(d + "T12:00:00-05:00").getTime() + n * 86400000));
  const start = addDays(today, -61), seedClose = addDays(start, -1);
  const tables = await p.$queryRawUnsafe(`SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename <> '_prisma_migrations'`) as any[];
  await p.$executeRawUnsafe("TRUNCATE TABLE " + tables.map((x: any) => '"' + x.tablename + '"').join(",") + " CASCADE");
  await p.settings.create({ data: { id: "singleton", initialCash: 2000000, initialBank: 1000000, setupComplete: true, termsAcceptedAt: new Date(), shipdayCommission: 30 } as any });
  const bcrypt = req("bcryptjs");
  const admin = await p.user.create({ data: { email: "admin@extremos.test", name: "Admin B", role: "admin", passwordHash: await bcrypt.hash("Admin-clave-1", 10) } });
  const oper = await p.user.create({ data: { email: "oper@extremos.test", name: "Operador B", role: "user", passwordHash: await bcrypt.hash("Oper-clave-1", 10) } });
  const oper2 = await p.user.create({ data: { email: "oper2@extremos.test", name: "Operador B2", role: "user", passwordHash: await bcrypt.hash("Oper2-clave-1", 10) } });
  const N = await p.branch.create({ data: { name: "Norte B", apiKeyEnc: "test-only" } });
  const S = await p.branch.create({ data: { name: "Sur B", apiKeyEnc: "test-only" } });
  const drivers = [
    await p.driver.create({ data: { name: "Domi X1", shipdayDriverId: "8101", branchId: N.id } }),
    await p.driver.create({ data: { name: "Domi X2", shipdayDriverId: "8102", branchId: N.id } }),
    await p.driver.create({ data: { name: "Domi Y1", shipdayDriverId: "8201", branchId: S.id } }),
  ];
  const branchOf = (k: number) => (k < 2 ? N : S);
  const worker = await p.worker.create({ data: { name: "Auxiliar B", color: "#888888" } as any });
  await p.shiftClose.create({ data: { date: seedClose, shift: "close", denominations: { bills: [{ value: 100000, qty: 20 }], coins: [] }, totalCounted: 2000000, totalExpected: 2000000, difference: 0, bankCounted: 1000000, bankExpected: 1000000, bankDifference: 0, closedAt: new Date(seedClose + "T22:00:00-05:00"), locked: true } as any });

  const sign = (x: any) => signToken({ sub: x.id, email: x.email, name: x.name, role: x.role, tv: x.tokenVersion });
  let tokA = sign(admin), tokO = sign(oper); const tokO2 = sign(oper2);
  async function api(route: string, method = "GET", body?: unknown, tok = tokO, rawBody?: string) {
    const r = await realFetch(origin + "/api" + route, { method, headers: { "Content-Type": "application/json", Authorization: "Bearer " + tok }, body: rawBody ?? (body === undefined ? undefined : JSON.stringify(body)) });
    return { status: r.status, body: await r.json().catch(() => null) as any };
  }
  async function ok(route: string, method = "GET", body?: unknown, tok = tokO) {
    const r = await api(route, method, body, tok);
    if (r.status >= 300) throw Error(`${method} ${route} → ${r.status} ${JSON.stringify(r.body)}`);
    return r.body;
  }
  const adm = (route: string, method = "GET", body?: unknown) => ok(route, method, body, tokA);
  const hook = (branchId: string, body: unknown) => realFetch(origin + "/api/webhooks/shipday/" + branchId, { method: "POST", headers: { "Content-Type": "application/json", token: process.env.WEBHOOK_TOKEN! }, body: JSON.stringify(body) });
  const BILLS = [100000, 50000, 20000, 10000, 5000, 2000, 1000], COINS = [500, 200, 100, 50];
  function denominate(amount: number) {
    assert.ok(amount >= 0, "efectivo negativo en el libro: " + amount);
    let rest = amount; const bills: any[] = [], coins: any[] = [];
    for (const v of BILLS) { const q = Math.floor(rest / v); if (q) { bills.push({ value: v, qty: q }); rest -= q * v; } }
    for (const v of COINS) { const q = Math.floor(rest / v); if (q) { coins.push({ value: v, qty: q }); rest -= q * v; } }
    assert.equal(rest, 0, "efectivo no denominable: " + amount); return { bills, coins };
  }
  const commission = (v: number) => Math.round(v * 0.3);
  const hc = await ok("/hourly-clients", "POST", { name: "Por hora B", driverHourValue: 10000, companyHourValue: 5000 });
  const client = await ok("/clients", "POST", { name: "Cliente B" });

  const L = { cash: 2000000, bank: 1000000, net: drivers.map(() => 0), base: drivers.map(() => 0), client: 0, hourlyOwed: 0, cashOver: 0, bankOff: 0, month: {} as Record<string, { orders: number; hourly: number; expenses: number; payroll: number }> };
  const M = (d: string) => (L.month[d.slice(0, 7)] ??= { orders: 0, hourly: 0, expenses: 0, payroll: 0 });
  const snapshot = async () => {
    const e = await ok(`/shifts/${cur}/expected`); const ds = await ok("/sd/drivers"); const cl = await ok("/clients"); const h = await ok(`/hourly-clients/${hc.id}`);
    return { cash: e.expectedCash, bank: e.expectedBank, drivers: drivers.map(dr => { const x = ds.find((y: any) => y.id === dr.id); return [x.pendingDebt - x.creditAmount, x.basePending]; }), client: cl.find((y: any) => y.id === client.id).pendingDebt, hourly: h.pendingDebt };
  };
  const ledgerView = () => ({ cash: L.cash, bank: L.bank, drivers: drivers.map((_, k) => [L.net[k], L.base[k]]), client: L.client, hourly: L.hourlyOwed });
  const assertLedger = async (f: any, label: string) => { f.sistema = await snapshot(); f.libro = ledgerView(); assert.deepEqual(f.sistema, f.libro, label + ": sistema ≠ libro independiente"); };
  // Una petición inválida NO debe cambiar nada.
  const noChange = async (f: any, label: string, fn: () => Promise<void>) => { const a = await snapshot(); await fn(); const b = await snapshot(); assert.deepEqual(b, a, label + ": una petición rechazada cambió saldos"); };

  const days: string[] = []; for (let d = start; d < today; d = addDays(d, 1)) days.push(d);
  let cur = start, orderSeq = 0;
  const paidOrders: { id: string; drv: number; c: number; month: string }[] = [];

  // ── Escenarios por día (índice → escenario) ─────────────────────────────────────────
  const scenarios: Record<number, { id: string; name: string; esperado: string; run: (d: string, f: any) => Promise<void> }[]> = {};
  const at = (i: number, id: string, name: string, esperado: string, run: (d: string, f: any) => Promise<void>) => (scenarios[i] ??= []).push({ id, name, esperado, run });

  at(1, "B-DUP-WEBHOOK", "Shipday reenvía el mismo pedido 5 veces A LA VEZ", "1 pedido, comisión aplicada una vez", async (d, f) => {
    const ev = { event: "ORDER_COMPLETED", order: { id: "dup-1", order_number: "D1", delivery_fee: 10000, delivery_time: new Date(d + "T13:00:00-05:00").getTime() }, carrier: { id: "8101" } };
    f.status = (await Promise.all([1, 2, 3, 4, 5].map(() => hook(N.id, ev)))).map(r => r.status);
    f.pedidos = await p.shipdayOrder.count({ where: { shipdayOrderId: "dup-1" } }); assert.equal(f.pedidos, 1);
    L.net[0] += 3000; M(d).orders += 3000;
  });
  at(2, "B-DUP-MANUAL", "Pedido manual: doble clic concurrente con la misma idempotencyKey y luego otro número igual", "1 pedido; el mismo número+sucursal+día con otra clave → 409", async (d, f) => {
    const body = { branchId: N.id, driverId: drivers[1].id, deliveryValue: 20000, orderNumber: "MX-1", idempotencyKey: "dbl-" + d };
    const rs = await Promise.all([api("/sd/orders/manual", "POST", body), api("/sd/orders/manual", "POST", body)]);
    f.status = rs.map(r => r.status); assert.ok(rs.every(r => r.status === 201 || r.status === 200), "algún doble clic falló"); assert.equal(rs[0].body.id, rs[1].body.id, "dos pedidos distintos");
    f.otraClave = (await api("/sd/orders/manual", "POST", { ...body, idempotencyKey: "otra-" + d })).status; assert.equal(f.otraClave, 409);
    L.net[1] += 6000; M(d).orders += 6000;
  });
  at(3, "B-DBL-BASE", "Doble clic en Entregar base (dos peticiones idénticas a la vez, sin clave)", "El servidor registra lo que recibe: 2 bases, caja −2×; el libro y el sistema coinciden (sin corrupción). La protección contra doble clic es de la interfaz (verificada en GUI)", async (d, f) => {
    const rs = await Promise.all([api(`/sd/bases/${drivers[2].id}/give`, "POST", { cashAmount: 4000 }), api(`/sd/bases/${drivers[2].id}/give`, "POST", { cashAmount: 4000 })]);
    f.status = rs.map(r => r.status); const n = rs.filter(r => r.status === 201).length; L.cash -= 4000 * n; L.base[2] += 4000 * n; f.creadas = n;
  });
  at(4, "B-RETRY", "Reintento después de un error de validación", "1.ª petición 400 sin efecto; reintento corregido crea exactamente 1 registro", async (d, f) => {
    await noChange(f, "monto negativo", async () => { f.e1 = (await api(`/sd/drivers/${drivers[0].id}/payment`, "POST", { amount: -5000, medium: "cash" })).status; });
    assert.equal(f.e1, 400);
    await ok(`/sd/bases/${drivers[0].id}/give`, "POST", { cashAmount: 5000 }); L.cash -= 5000; L.base[0] += 5000;
    f.bases = await p.baseTransaction.count({ where: { driverId: drivers[0].id, amount: 5000, type: "entrega", date: { gte: new Date(d + "T00:00:00-05:00") } } }); assert.equal(f.bases, 1);
  });
  at(5, "B-CORTE-RED", "Corte de conexión: el cliente aborta 10 peticiones de gasto (admin) a los 5 ms", "Cada gasto queda completo o no existe (nada a medias); el esperado = libro con los que sí quedaron", async (d, f) => {
    const before = await p.movement.count({ where: { description: { startsWith: "Corte " + d } } });
    await Promise.all(Array.from({ length: 10 }, (_, k) => { const c = new AbortController(); setTimeout(() => c.abort(), 5); return realFetch(origin + "/api/movements", { method: "POST", signal: c.signal, headers: { "Content-Type": "application/json", Authorization: "Bearer " + tokA }, body: JSON.stringify({ date: d, category: 3, type: "egreso", medium: "cash", amount: 1000, description: `Corte ${d} ${k}`, status: "confirmed" }) }).catch(() => null); }));
    await new Promise(r => setTimeout(r, 1500));
    const ms = await p.movement.findMany({ where: { description: { startsWith: "Corte " + d } } });
    f.quedaron = ms.length - before; f.estados = [...new Set(ms.map((m: any) => m.status))];
    assert.ok(ms.every((m: any) => m.status === "confirmed" && m.amount === 1000), "gasto a medias");
    L.cash -= 1000 * f.quedaron; M(d).expenses += 1000 * f.quedaron;
  });
  at(6, "B-SESION-VENCIDA", "Token vencido y token adulterado", "401 en ambos; nada cambia", async (d, f) => {
    const expired = jwt.sign({ sub: oper.id, email: oper.email, name: oper.name, role: "user", tv: (oper as any).tokenVersion, exp: Math.floor(Date.now() / 1000) - 60 }, process.env.JWT_SECRET);
    const forged = jwt.sign({ sub: oper.id, email: oper.email, name: oper.name, role: "admin", tv: (oper as any).tokenVersion }, "otra-clave");
    await noChange(f, "sesión", async () => {
      f.vencido = (await api(`/sd/bases/${drivers[0].id}/give`, "POST", { cashAmount: 1000 }, expired)).status;
      f.adulterado = (await api(`/sd/bases/${drivers[0].id}/give`, "POST", { cashAmount: 1000 }, forged)).status;
    });
    assert.deepEqual([f.vencido, f.adulterado], [401, 401]);
  });
  at(7, "B-CAMBIO-CLAVE", "El admin cambia la contraseña del operador mientras tiene sesión abierta", "El token viejo queda inválido (401); login con la clave vieja falla y con la nueva funciona", async (d, f) => {
    f.cambio = (await api(`/users/${oper.id}`, "PATCH", { password: "Oper-clave-2" }, tokA)).status; assert.equal(f.cambio, 200);
    f.viejo = (await api("/auth/me", "GET", undefined, tokO)).status; assert.equal(f.viejo, 401);
    f.loginViejo = (await api("/auth/login", "POST", { email: oper.email, password: "Oper-clave-1" }, "")).status; assert.ok(f.loginViejo >= 400);
    const ln = await api("/auth/login", "POST", { email: oper.email, password: "Oper-clave-2" }, ""); f.loginNuevo = ln.status;
    assert.ok(ln.status === 200 && ln.body?.token, "login con la clave nueva"); tokO = ln.body.token;
  });
  at(8, "B-PERMISOS", "El operador intenta acciones de admin", "403 en todas; nada cambia", async (d, f) => {
    const g = await ok("/movements", "POST", { date: d, category: 3, type: "egreso", medium: "cash", amount: 1500, description: "Pendiente perm", status: "confirmed" });
    const rq = await ok("/edit-requests", "POST", { requestType: "delete", entityType: "Movement", entityId: g.id, entityLabel: "x", reason: "x" }).catch(() => null);
    await noChange(f, "permisos", async () => {
      f.aprobarGasto = (await api(`/movements/${g.id}/approve`, "POST", {})).status;
      f.revisarSolicitud = rq ? (await api(`/edit-requests/${rq.id}/review`, "POST", { action: "approved" })).status : "sin solicitud";
      f.cierreMes = (await api("/sd/closes", "POST", { month: d.slice(0, 7), initialCash: 1, initialBank: 1 })).status;
      f.crearUsuario = (await api("/users", "POST", { email: "x@x.test", name: "X", password: "Clave-123", role: "admin" })).status;
      f.borrarTrabajador = (await api(`/workers/${worker.id}`, "DELETE")).status;
      f.editarBase = (await api(`/sd/bases/${(await p.baseTransaction.findFirstOrThrow()).id}`, "PATCH", { cashAmount: 1 })).status;
      f.reset = (await api("/admin/reset", "POST", {})).status;
    });
    for (const k of ["aprobarGasto", "revisarSolicitud", "cierreMes", "crearUsuario", "borrarTrabajador", "editarBase", "reset"]) assert.equal(f[k], 403, k);
    await adm(`/movements/${g.id}/reject`, "POST", {}); if (rq) await adm(`/edit-requests/${rq.id}/review`, "POST", { action: "rejected" });
  });
  at(9, "B-DOS-USUARIOS", "Dos operadores y el admin registran 30 operaciones a la vez", "Todas cuentan una sola vez; esperado = libro", async (d, f) => {
    const ops: Promise<any>[] = [];
    for (let k = 0; k < 10; k++) {
      ops.push(ok(`/sd/bases/${drivers[k % 3].id}/give`, "POST", { cashAmount: 1000 }, tokO)); L.cash -= 1000; L.base[k % 3] += 1000;
      ops.push(ok("/bank-transactions", "POST", { type: "ingreso", medium: "bank", amount: 2000, description: `Simultáneo ${k}`, noCounterpart: true }, tokO2)); L.bank += 2000;
      ops.push(ok(`/clients/${client.id}/debt`, "POST", { description: `Fiado sim ${k}`, amount: 500 }, tokA)); L.client += 500;
    }
    f.n = (await Promise.all(ops)).length;
  });
  at(10, "B-DOBLE-CIERRE", "Doble clic en Registrar Cierre (dos a la vez)", "Uno 201 y el otro 409; un solo Cierre", async (d, f) => {
    f.marcar = "se ejecuta en el Cierre del día"; (globalThis as any).__doubleClose = true;
  });
  at(11, "B-FUERA-ORDEN", "Operaciones fuera de orden", "Cerrar mañana → rechazo; dinero con fecha de mañana → 400; dinero directo en día cerrado → 409; cerrar de nuevo ayer → 409; nada cambia", async (d, f) => {
    const tomorrow = addDays(d, 1), yesterday = addDays(d, -1);
    await noChange(f, "fuera de orden", async () => {
      f.cerrarManana = (await api("/shifts", "POST", { date: tomorrow, shift: "close", denominations: denominate(L.cash), bankCounted: L.bank })).status;
      f.dineroManana = (await api("/bank-transactions", "POST", { type: "ingreso", medium: "cash", amount: 1000, description: "x", date: tomorrow, noCounterpart: true })).status;
      f.dineroAyer = (await api("/bank-transactions", "POST", { type: "ingreso", medium: "cash", amount: 1000, description: "x", date: yesterday, noCounterpart: true })).status;
      f.cerrarAyer = (await api("/shifts", "POST", { date: yesterday, shift: "close", denominations: denominate(L.cash), bankCounted: L.bank })).status;
    });
    assert.ok(f.cerrarManana >= 400 && f.cerrarManana < 500, "cerrar mañana"); assert.equal(f.dineroManana, 400); assert.equal(f.dineroAyer, 409); assert.equal(f.cerrarAyer, 409);
  });
  at(12, "B-ANULAR-PAGADO", "Anular (eliminar por solicitud) un pedido cuya comisión YA se pagó", "La comisión se revierte con applyDebtDelta: el domiciliario queda con crédito a favor igual a la comisión; la caja no cambia", async (d, f) => {
    const o = paidOrders.shift(); assert.ok(o, "no hay pedido pagado");
    const rq = await ok("/edit-requests", "POST", { requestType: "delete", entityType: "ShipdayOrder", entityId: o!.id, entityLabel: "Pedido", reason: "Cancelado por el cliente" });
    await adm(`/edit-requests/${rq.id}/review`, "POST", { action: "approved" });
    L.net[o!.drv] -= o!.c; L.month[o!.month].orders -= o!.c; f.comision = o!.c;
  });
  at(13, "B-ESTADOS", "Cambios de estado inesperados", "Aprobar una solicitud ya rechazada → 400; revisar una inexistente → 404; aprobar un gasto ya rechazado → 4xx; borrar dos veces una base → la 2.ª 404; nada cambia", async (d, f) => {
    const g = await ok("/movements", "POST", { date: d, category: 3, type: "egreso", medium: "cash", amount: 1200, description: "Estado", status: "confirmed" });
    await adm(`/movements/${g.id}/reject`, "POST", {});
    const rq = await ok("/edit-requests", "POST", { requestType: "create", entityType: "BankTransaction", entityId: "nuevo", entityLabel: "", changes: { date: addDays(d, -1), type: "egreso", medium: "cash", amount: 1, description: "x" }, reason: "x" });
    await adm(`/edit-requests/${rq.id}/review`, "POST", { action: "rejected" });
    const b = await ok(`/sd/bases/${drivers[1].id}/give`, "POST", { cashAmount: 2500 }); L.cash -= 2500; L.base[1] += 2500;
    await adm(`/sd/bases/${b.id}`, "DELETE"); L.cash += 2500; L.base[1] -= 2500;
    await noChange(f, "estados", async () => {
      f.reaprobar = (await api(`/edit-requests/${rq.id}/review`, "POST", { action: "approved" }, tokA)).status;
      f.inexistente = (await api(`/edit-requests/no-existe/review`, "POST", { action: "approved" }, tokA)).status;
      f.gastoRechazado = (await api(`/movements/${g.id}/approve`, "POST", {}, tokA)).status;
      f.borrarOtraVez = (await api(`/sd/bases/${b.id}`, "DELETE", undefined, tokA)).status;
    });
    assert.equal(f.reaprobar, 400); assert.equal(f.inexistente, 404); assert.ok(f.gastoRechazado >= 400 && f.gastoRechazado < 500); assert.equal(f.borrarOtraVez, 404);
  });
  at(14, "B-INVALIDOS", "Datos inválidos en todos los formularios de dinero (incluye INC-01)", "Todos 4xx (nunca 500) y nada cambia", async (d, f) => {
    const bad: [string, string, any][] = [];
    for (const amt of [0, -5000, 1.5, "abc", null, 1e12, Number.MAX_SAFE_INTEGER]) {
      bad.push([`/sd/bases/${drivers[0].id}/give`, "POST", { cashAmount: amt }]);
      bad.push([`/sd/drivers/${drivers[0].id}/payment`, "POST", { amount: amt, medium: "cash" }]);
      bad.push(["/bank-transactions", "POST", { type: "ingreso", medium: "cash", amount: amt, description: "x", noCounterpart: true }]);
      bad.push(["/movements", "POST", { date: d, category: 3, type: "egreso", medium: "cash", amount: amt, description: "x" }]);
      bad.push([`/clients/${client.id}/debt`, "POST", { description: "x", amount: amt }]);
      bad.push(["/sd/conversions", "POST", { branchId: N.id, amount: amt, type: "efectivo_a_banco" }]);
      bad.push(["/sd/orders/manual", "POST", { branchId: N.id, driverId: drivers[0].id, deliveryValue: amt }]);
    }
    bad.push(["/bank-transactions", "POST", { type: "ingreso", amount: 1000, description: "sin medio" }]);
    bad.push(["/bank-transactions", "POST", { type: "otro", medium: "cash", amount: 1000, description: "x" }]);
    bad.push(["/movements", "POST", { date: "2026-02-30", category: 3, type: "egreso", medium: "cash", amount: 1000, description: "x" }]);
    bad.push(["/sd/conversions", "POST", { branchId: "no-existe", amount: 1000, type: "efectivo_a_banco" }]);
    bad.push([`/hourly-clients/${hc.id}/shifts`, "POST", { driverId: drivers[0].id, startTime: "10:00", endTime: "10:00", medium: "cash" }]);
    bad.push([`/hourly-clients/${hc.id}/shifts`, "POST", { driverId: drivers[0].id, startTime: "25:00", endTime: "26:00", medium: "cash" }]);
    // INC-01: conteo de Cierre con cantidades negativas, billetes inexistentes, fracciones o banco negativo.
    bad.push(["/shifts", "POST", { date: d, shift: "close", denominations: { bills: [{ value: 100000, qty: -3 }], coins: [] }, bankCounted: L.bank }]);
    bad.push(["/shifts", "POST", { date: d, shift: "close", denominations: { bills: [{ value: 999999, qty: 1 }], coins: [] }, bankCounted: L.bank }]);
    bad.push(["/shifts", "POST", { date: d, shift: "close", denominations: { bills: [{ value: 1000, qty: 0.5 }], coins: [] }, bankCounted: L.bank }]);
    bad.push(["/shifts", "POST", { date: d, shift: "AM", denominations: { bills: [], coins: [] }, bankCounted: -1 }]);
    bad.push(["/shifts", "POST", { date: d, shift: "AM", denominations: { bills: [], coins: [] }, bankCounted: 10.5 }]);
    bad.push(["/shifts", "POST", { date: d, shift: "AM", denominations: "x", bankCounted: 0 }]);
    const codes: number[] = [];
    await noChange(f, "inválidos", async () => { for (const [r, m, b] of bad) codes.push((await api(r, m, b)).status); });
    f.total = bad.length; f.codigos = [...new Set(codes)].sort(); f.no4xx = bad.filter((_, k) => codes[k] < 400 || codes[k] >= 500).map((x, k) => [x[0], JSON.stringify(x[2]).slice(0, 80)]);
    assert.equal(f.no4xx.length, 0, "peticiones inválidas aceptadas o con error 500");
    f.cierres = await p.shiftClose.count({ where: { date: d } }); assert.equal(f.cierres, 0, "se registró un Cierre inválido");
    f.jsonRoto = (await api("/movements", "POST", undefined, tokA, "{no es json")).status; assert.ok(f.jsonRoto >= 400 && f.jsonRoto < 500, "JSON roto");
  });
  at(16, "B-MEDIANOCHE", "Operaciones cerca de medianoche", "Instante 23:59:59 del día operativo cuenta en el día; 00:00:00 del siguiente → 400; turno 22:00→01:00 sin confirmar → 409, confirmado → 3 h", async (d, f) => {
    await ok("/bank-transactions", "POST", { type: "ingreso", medium: "cash", amount: 1100, description: "23:59:59", date: `${d}T23:59:59-05:00`, noCounterpart: true }); L.cash += 1100;
    f.siguiente = (await api("/bank-transactions", "POST", { type: "ingreso", medium: "cash", amount: 1100, description: "00:00", date: `${addDays(d, 1)}T00:00:00-05:00`, noCounterpart: true })).status; assert.equal(f.siguiente, 400);
    f.sinConfirmar = (await api(`/hourly-clients/${hc.id}/shifts`, "POST", { driverId: drivers[2].id, startTime: "22:00", endTime: "01:00", medium: "cash" })).status; assert.equal(f.sinConfirmar, 409);
    const sh = await ok(`/hourly-clients/${hc.id}/shifts`, "POST", { driverId: drivers[2].id, startTime: "22:00", endTime: "01:00", medium: "cash", confirmOvernight: true });
    f.minutos = sh.minutes; assert.equal(sh.minutes, 180); L.cash -= 30000; L.hourlyOwed += 45000; M(d).hourly += 15000;
  });
  at(18, "B-DIFERENCIAS", "Cierre con sobrante de efectivo y banco que no cuadra", "Cierre registrado en rojo con difference=+700 y bankDifference=−300; el esperado del día siguiente NO absorbe la diferencia (sigue al libro)", async () => { (globalThis as any).__diffClose = true; });
  at(20, "B-REINICIO", "REINICIO REAL: se mata el proceso del servidor (dist) en plena ráfaga de 40 operaciones y se vuelve a levantar", "Ninguna operación queda a medias: cada base existe completa o no existe; tras reiniciar, esperado y saldos = libro con las que quedaron; el servidor vuelve a responder", async (d, f) => {
    const port = 4300 + Math.floor(Math.random() * 7); // OBS-07: fetch (WHATWG) rechaza el puerto 4190 ("bad port")
    const spawn = () => cp.spawn(process.execPath, ["--require", path.join(__dirname, "block-external.cjs"), path.resolve(__dirname, "../dist/index.js")], { cwd: path.resolve(__dirname, ".."), env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", WEB_DIR: "" }, stdio: ["ignore", fs.openSync(path.join(__dirname, "final-b-child.log"), "a"), fs.openSync(path.join(__dirname, "final-b-child.log"), "a")], windowsHide: true });
    const waitUp = async () => { const t0 = Date.now(); for (let t = 0; t < 360; t++) { try { const r = await realFetch(`http://127.0.0.1:${port}/api/health`); if (r.ok) { (f.arranqueMs ??= []).push(Date.now() - t0); return; } } catch { } await new Promise(r => setTimeout(r, 250)); } throw Error("el servidor no levantó en 90 s"); };
    let child = spawn();
    try {
    await waitUp();
    const ext = (route: string, body: unknown) => realFetch(`http://127.0.0.1:${port}/api${route}`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + tokA }, body: JSON.stringify(body) }).then(r => r.status).catch(() => "cortada");
    const burst = Array.from({ length: 40 }, (_, k) => ext(`/sd/bases/${drivers[k % 3].id}/give`, { cashAmount: 1000, notes: `Ráfaga ${d} ${k}` }));
    // Matar cuando ya hay operaciones guardadas y otras siguen en la cola/en curso.
    for (let t = 0; t < 400; t++) { if (await p.baseTransaction.count({ where: { notes: { startsWith: `Ráfaga ${d}` } } }) >= 5) break; await new Promise(r => setTimeout(r, 10)); }
    child.kill("SIGKILL");
    f.respuestas = (await Promise.all(burst)).reduce((a: any, s: any) => (a[s] = (a[s] || 0) + 1, a), {});
    child = spawn(); await waitUp(); f.reinicio = "ok";
    const made = await p.baseTransaction.findMany({ where: { notes: { startsWith: `Ráfaga ${d}` } } });
    f.quedaron = made.length; assert.ok(made.every((b: any) => b.amount === 1000 && b.type === "entrega"), "base a medias");
    for (const b of made) { const k = drivers.findIndex(x => x.id === b.driverId); L.cash -= 1000; L.base[k] += 1000; }
    f.despues = (await ext(`/sd/bases/${drivers[0].id}/give`, { cashAmount: 1000, notes: "tras reinicio" })); assert.equal(f.despues, 201); L.cash -= 1000; L.base[0] += 1000;
    } finally { child.kill("SIGKILL"); }
  });
  at(22, "B-INTERRUPCION-CIERRE", "Se mata el servidor justo mientras registra el Cierre del día", "O el Cierre quedó completo (bloqueado, con esperado correcto) o no existe y se puede registrar; nunca a medias", async () => { (globalThis as any).__killClose = true; });
  at(25, "B-SOLICITUD-DOBLE", "El admin aprueba la misma solicitud dos veces a la vez", "Un solo efecto (dinero aplicado una vez); la otra respuesta 400", async (d, f) => {
    const rq = await ok("/edit-requests", "POST", { requestType: "create", entityType: "BankTransaction", entityId: "nuevo", entityLabel: "", changes: { date: addDays(d, -1), type: "egreso", medium: "cash", amount: 2200, description: "Olvido doble", noCounterpart: true }, reason: "olvido" });
    const rs = await Promise.all([api(`/edit-requests/${rq.id}/review`, "POST", { action: "approved" }, tokA), api(`/edit-requests/${rq.id}/review`, "POST", { action: "approved" }, tokA)]);
    f.status = rs.map(r => r.status).sort(); assert.deepEqual(f.status, [200, 400]);
    f.creados = await p.bankTransaction.count({ where: { description: "Olvido doble" } }); assert.equal(f.creados, 1); L.cash -= 2200;
  });
  at(30, "B-USUARIO-DESACTIVADO", "El admin desactiva al operador 2 con sesión abierta", "Su token queda inválido (401) y no puede registrar dinero", async (d, f) => {
    f.desactivar = (await api(`/users/${oper2.id}`, "PATCH", { active: false }, tokA)).status;
    await noChange(f, "desactivado", async () => { f.op = (await api("/bank-transactions", "POST", { type: "ingreso", medium: "bank", amount: 1000, description: "x", noCounterpart: true }, tokO2)).status; });
    assert.equal(f.op, 401);
  });
  at(33, "B-DOMI-INACTIVO", "Pedido manual y base a un domiciliario desactivado / sucursal desactivada", "Pedido manual 400; nada cambia", async (d, f) => {
    const dz = await p.driver.create({ data: { name: "Domi inactivo", shipdayDriverId: "8999", branchId: S.id, active: false } as any });
    await noChange(f, "inactivo", async () => { f.pedido = (await api("/sd/orders/manual", "POST", { branchId: S.id, driverId: dz.id, deliveryValue: 10000 })).status; });
    assert.equal(f.pedido, 400);
  });
  at(40, "B-PAGO-EXCESIVO", "Devolver más base de la que el domiciliario tiene y pagar crédito sin crédito", "400 en ambos; nada cambia", async (d, f) => {
    await noChange(f, "excesivo", async () => {
      f.base = (await api(`/sd/bases/${drivers[1].id}/pay`, "POST", { cashAmount: L.base[1] + 99999 })).status;
      f.credito = L.net[1] >= 0 ? (await api(`/sd/drivers/${drivers[1].id}/pay-credit`, "POST", { medium: "cash" })).status : 400;
    });
    assert.equal(f.base, 400); assert.equal(f.credito, 400);
  });
  at(45, "B-CONTRAPARTE", "Contrapartes inválidas: parcial, doble, mismo signo, inexistente", "400/409/404 y nada cambia; la válida cuadra", async (d, f) => {
    const out = await ok("/bank-transactions", "POST", { type: "egreso", medium: "bank", amount: 50000, description: "Salida B" }); L.bank -= 50000;
    await noChange(f, "contraparte", async () => {
      f.parcial = (await api("/bank-transactions", "POST", { type: "ingreso", medium: "cash", amount: 20000, description: "Parcial", pairWith: out.id })).status;
      f.mismoSigno = (await api("/bank-transactions", "POST", { type: "egreso", medium: "cash", amount: 50000, description: "Mismo", pairWith: out.id })).status;
      f.inexistente = (await api("/bank-transactions", "POST", { type: "ingreso", medium: "cash", amount: 50000, description: "x", pairWith: "no-existe" })).status;
    });
    await ok("/bank-transactions", "POST", { type: "ingreso", medium: "cash", amount: 50000, description: "Retorno B", pairWith: out.id }); L.cash += 50000;
    f.doble = (await api("/bank-transactions", "POST", { type: "ingreso", medium: "cash", amount: 50000, description: "Doble", pairWith: out.id })).status;
    assert.equal(f.parcial, 400); assert.ok([400, 409].includes(f.mismoSigno)); assert.equal(f.inexistente, 404); assert.equal(f.doble, 409);
  });

  await check("B-00", `Arranque en ${start} (hoy ${today})`, "Caja abierta en el primer día; cerrar mes con caja atrasada 409", async f => {
    f.cur = (await ok("/shifts/current-date")).date; assert.equal(f.cur, start);
    f.mes = (await api("/sd/closes", "POST", { month: start.slice(0, 7), initialCash: 1, initialBank: 1 }, tokA)).status; assert.equal(f.mes, 409);
  });

  for (const [i, d] of days.entries()) {
    cur = d;
    // Operación base del día (el libro avanza también en los días de escenarios).
    await check(`B-D${String(i + 1).padStart(2, "0")}`, `Día ${d}: operación base`, "esperado y saldos = libro", async f => {
      assert.equal((await ok("/shifts/current-date")).date, d);
      if (L.cashOver) { await adm("/bank-transactions", "POST", { type: "ingreso", medium: "cash", amount: L.cashOver, description: "Sobrante de caja", noCounterpart: true }); L.cash += L.cashOver; L.cashOver = 0; }
      if (L.bankOff) { await adm("/bank-transactions", "POST", { type: "egreso", medium: "bank", amount: L.bankOff, description: "Comisión bancaria no registrada", noCounterpart: true }); L.bank -= L.bankOff; L.bankOff = 0; }
      for (let k = 0; k < 3; k++) {
        const fee = 8000 + 1000 * ((i + k) % 4), id = `xb-${d}-${k}`;
        const r = await hook(branchOf(k).id, { event: "ORDER_COMPLETED", order: { id, order_number: String(++orderSeq), delivery_fee: fee, delivery_time: new Date(`${d}T${10 + k}:30:00-05:00`).getTime() }, carrier: { id: drivers[k].shipdayDriverId } });
        assert.equal(r.status, 200); const c = commission(fee); L.net[k] += c; M(d).orders += c;
        const o = await p.shipdayOrder.findUniqueOrThrow({ where: { shipdayOrderId: id } }); paidOrders.push({ id: o.id, drv: k, c, month: d.slice(0, 7) });
        await ok(`/sd/bases/${drivers[k].id}/give`, "POST", { cashAmount: 6000 }); L.cash -= 6000; L.base[k] += 6000;
        const owe = Math.max(L.net[k], 0), amount = owe + L.base[k];
        await ok(`/sd/drivers/${drivers[k].id}/payment`, "POST", { amount, medium: k === 1 ? "bank" : "cash", baseAmount: L.base[k] });
        if (k === 1) L.bank += amount; else L.cash += amount; L.net[k] -= amount - L.base[k]; L.base[k] = 0;
      }
      if (i % 7 === 4) { await adm("/movements", "POST", { date: d, category: 15, type: "egreso", medium: "cash", amount: 40000, description: "Nómina", workerId: worker.id, status: "confirmed" }); L.cash -= 40000; M(d).payroll += 40000; }
      if (i % 2 === 0) { await adm("/movements", "POST", { date: d, category: 4, type: "egreso", medium: "bank", amount: 3000, description: `Gasto ${i}`, status: "confirmed" }); L.bank -= 3000; M(d).expenses += 3000; }
      if (i % 10 === 9 && L.hourlyOwed) { await ok(`/hourly-clients/${hc.id}/pay`, "POST", { payAll: true, medium: "bank" }); L.bank += L.hourlyOwed; L.hourlyOwed = 0; }
      await assertLedger(f, d);
    });
    if (!results[results.length - 1].ok) break;
    let broke = false;
    for (const s of scenarios[i] ?? []) { await check(s.id, `${s.name} (${d})`, s.esperado, async f => { await s.run(d, f); await assertLedger(f, s.id); }); if (!results[results.length - 1].ok) { broke = true; break; } }
    if (broke) break;

    // Cierre del día (con las variantes de doble clic, diferencias e interrupción).
    await check(`B-C${String(i + 1).padStart(2, "0")}`, `Cierre ${d}`, "Cierre registrado con la diferencia prevista", async f => {
      const g = globalThis as any;
      if (g.__killClose) {
        g.__killClose = false;
        const port = 4197; const child = cp.spawn(process.execPath, ["--require", path.join(__dirname, "block-external.cjs"), path.resolve(__dirname, "../dist/index.js")], { cwd: path.resolve(__dirname, ".."), env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", WEB_DIR: "" }, stdio: ["ignore", fs.openSync(path.join(__dirname, "final-b-child.log"), "a"), fs.openSync(path.join(__dirname, "final-b-child.log"), "a")], windowsHide: true });
        for (let t = 0; t < 360; t++) { try { if ((await realFetch(`http://127.0.0.1:${port}/api/health`)).ok) break; } catch { } await new Promise(r => setTimeout(r, 250)); }
        const pr = realFetch(`http://127.0.0.1:${port}/api/shifts`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + tokA }, body: JSON.stringify({ date: d, shift: "close", denominations: denominate(L.cash), bankCounted: L.bank }) }).then(r => r.status).catch(() => "cortada");
        await new Promise(r => setTimeout(r, 40)); child.kill("SIGKILL"); f.respuesta = await pr;
        const sc = await p.shiftClose.findUnique({ where: { date_shift: { date: d, shift: "close" } } });
        f.quedo = !!sc;
        if (sc) { assert.equal(sc.locked, true); assert.equal(sc.totalExpected, L.cash); assert.equal(sc.difference, 0); return; }
      }
      const body = { date: d, shift: "close", receivedBy: "Op", denominations: denominate(L.cash + (g.__diffClose ? 700 : 0)), bankCounted: L.bank - (g.__diffClose ? 300 : 0) };
      if (g.__doubleClose) {
        g.__doubleClose = false;
        const rs = await Promise.all([api("/shifts", "POST", body), api("/shifts", "POST", body)]); f.status = rs.map(r => r.status).sort();
        assert.deepEqual(f.status, [201, 409]); assert.equal(await p.shiftClose.count({ where: { date: d, shift: "close" } }), 1); return;
      }
      const c = await ok("/shifts", "POST", body); f.dif = [c.difference, c.bankDifference];
      if (g.__diffClose) { g.__diffClose = false; assert.deepEqual(f.dif, [700, -300]); L.cashOver = 700; L.bankOff = 300; return; }
      assert.deepEqual(f.dif, [0, 0]);
    });
    if (!results[results.length - 1].ok) break;
  }

  await check("B-90", "Caja al día y semáforo", "Hoy es el día operativo; el único día rojo es el del escenario de diferencias", async f => {
    f.cur = (await ok("/shifts/current-date")).date; assert.equal(f.cur, today);
    const rojos = await p.shiftClose.findMany({ where: { shift: "close", date: { gte: start }, OR: [{ difference: { not: 0 } }, { bankDifference: { not: 0 } }] }, select: { date: true } });
    f.rojos = rojos.map((x: any) => x.date); assert.deepEqual(f.rojos, [days[18]]);
  });
  const prevMonth = days[days.length - 1].slice(0, 7) === today.slice(0, 7) ? toBogotaDateStr(new Date(new Date(today.slice(0, 7) + "-01T12:00:00-05:00").getTime() - 86400000)).slice(0, 7) : days[days.length - 1].slice(0, 7);
  await check("B-91", `Reporte de ${prevMonth} = libro`, "ventas, gastos, nómina y utilidad iguales al libro", async f => {
    const m = L.month[prevMonth]; const r = await adm(`/sd/report/${prevMonth}`);
    f.r = [r.sales.orders, r.sales.hourly, r.expenses.total, r.payroll.total, r.netProfit]; f.l = [m.orders, m.hourly, m.expenses, m.payroll, m.orders + m.hourly - m.expenses - m.payroll];
    assert.deepEqual(f.r, f.l);
  });
  await check("B-92", `Cierre de ${prevMonth}: doble clic concurrente`, "Uno 201, el otro 409; un solo MonthlyClose", async f => {
    const e = await ok(`/shifts/${today}/expected`);
    const rs = await Promise.all([api("/sd/closes", "POST", { month: prevMonth, initialCash: e.expectedCash, initialBank: e.expectedBank }, tokA), api("/sd/closes", "POST", { month: prevMonth, initialCash: e.expectedCash, initialBank: e.expectedBank }, tokA)]);
    f.status = rs.map(r => r.status).sort(); assert.deepEqual(f.status, [201, 409]);
    assert.equal(await p.monthlyClose.count({ where: { month: prevMonth } }), 1);
  });
  await check("B-93", `Modificar el mes cerrado ${prevMonth}`, "Gasto directo 409; editar/borrar por PATCH/DELETE una base del mes 409; solicitud de borrar un pedido del mes: aprobación rechazada y la solicitud NO queda Aprobada; solicitud de agregar dinero al mes: no se aplica; nada cambia", async f => {
    const base = await p.baseTransaction.findFirstOrThrow({ where: { date: { gte: new Date(prevMonth + "-05T00:00:00-05:00"), lt: new Date(prevMonth + "-20T00:00:00-05:00") } } });
    const ord = await p.shipdayOrder.findFirstOrThrow({ where: { deliveredAt: { gte: new Date(prevMonth + "-05T00:00:00-05:00"), lt: new Date(prevMonth + "-20T00:00:00-05:00") } } });
    let rqDel: any, rqCreate: any;
    await noChange(f, "mes cerrado", async () => {
      f.gasto = (await api("/movements", "POST", { date: `${prevMonth}-15`, category: 3, type: "egreso", medium: "cash", amount: 1000, description: "x", status: "confirmed" }, tokA)).status;
      f.patchBase = (await api(`/sd/bases/${base.id}`, "PATCH", { cashAmount: base.amount + 1 }, tokA)).status;
      f.deleteBase = (await api(`/sd/bases/${base.id}`, "DELETE", undefined, tokA)).status;
      rqDel = await api("/edit-requests", "POST", { requestType: "delete", entityType: "ShipdayOrder", entityId: ord.id, entityLabel: "x", reason: "x" });
      f.crearSolicitudBorrar = rqDel.status;
      if (rqDel.status === 201) f.aprobarBorrar = (await api(`/edit-requests/${rqDel.body.id}/review`, "POST", { action: "approved" }, tokA)).status;
      rqCreate = await api("/edit-requests", "POST", { requestType: "create", entityType: "BankTransaction", entityId: "nuevo", entityLabel: "", changes: { date: `${prevMonth}-15`, type: "egreso", medium: "cash", amount: 1000, description: "x" }, reason: "x" });
      f.crearSolicitudAgregar = rqCreate.status;
      if (rqCreate.status === 201) f.aprobarAgregar = (await api(`/edit-requests/${rqCreate.body.id}/review`, "POST", { action: "approved" }, tokA)).status;
    });
    assert.equal(f.gasto, 409); assert.equal(f.patchBase, 409); assert.equal(f.deleteBase, 409);
    if (f.aprobarBorrar !== undefined) { assert.ok(f.aprobarBorrar >= 400, "borrado aprobado en mes cerrado"); f.estadoBorrar = (await p.editRequest.findUniqueOrThrow({ where: { id: rqDel.body.id } })).status; assert.equal(f.estadoBorrar, "pending"); }
    if (f.aprobarAgregar !== undefined) { assert.ok(f.aprobarAgregar >= 400, "agregar aprobado en mes cerrado"); f.estadoAgregar = (await p.editRequest.findUniqueOrThrow({ where: { id: rqCreate.body.id } })).status; assert.equal(f.estadoAgregar, "pending"); }
    assert.equal(await p.shipdayOrder.count({ where: { id: ord.id } }), 1);
  });

  await new Promise<void>(r => server.close(() => r())); globalThis.fetch = realFetch; await p.$disconnect();
  const fails = results.filter(r => !r.ok).length;
  fs.writeFileSync(path.join(__dirname, "final-2meses-extremos.json"), JSON.stringify({ results, months: L.month, libroFinal: ledgerView() }, null, 2));
  console.log(`TOTAL ${results.length} · OK ${results.length - fails} · FALLAS ${fails}`);
  process.exit(fails ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
