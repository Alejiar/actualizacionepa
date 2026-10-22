/**
 * AUDITORÍA RONDA 2 (22-oct-2026) — Simulación B CONTINUADA: casos extremos durante uso PROLONGADO.
 * Retoma el estado final verificado de la Simulación B de la ronda 1 (dump de cashbuddy_final_b; septiembre
 * cerrado, contraseña del operador ya cambiada, operador 2 desactivado) y la continúa día por día hasta FIN
 * (por defecto 2027-04-30) con el reloj SIMULADO de este proceso (fake-clock.cjs). Los escenarios extremos de
 * la ronda 1 se REPITEN cada ~30 días sobre datos cada vez más grandes, y se agregan los propios del uso
 * prolongado (cambio de año, pendientes que cruzan un cierre de mes, tarifas que cambian, sesiones de días,
 * deudas acumuladas, sucursal pausada, ráfagas, reinicios). Cada escenario tiene su ESPERADO escrito antes.
 * SOLO contra la BD temporal local `cashbuddy_final_bp`.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import cp from "node:child_process";
import { pathToFileURL } from "node:url";

const u = new URL(process.env.DATABASE_URL || "invalid:");
if (u.pathname !== "/cashbuddy_final_bp" || !["localhost", "127.0.0.1"].includes(u.hostname)) throw Error("Solo BD temporal local cashbuddy_final_bp");
const clock = (globalThis as any).__fakeClock; if (!clock) throw Error("Falta el reloj simulado (fake-clock.cjs)");
const RealDate = clock.Real as DateConstructor;
const FIN = process.env.FIN || "2027-04-30";
const CHILD_LOG = path.join(__dirname, "final-r2-b-child.log");

async function main() {
  const setNow = (iso: string) => clock.set(new RealDate(iso).getTime());
  setNow("2026-10-22T22:00:00-05:00");
  const SRC = pathToFileURL(path.resolve(__dirname, "../src")).href;
  const { prisma: p } = await import(`${SRC}/lib/prisma.ts`);
  const { createServer } = await import(`${SRC}/server.ts`);
  const { signToken } = await import(`${SRC}/lib/jwt.ts`);
  const { toBogotaDateStr } = await import(`${SRC}/lib/date-range.ts`);
  const req = (await import("node:module")).createRequire(path.resolve(__dirname, "../package.json"));
  const jwt = req("jsonwebtoken");
  const R1 = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../../auditoria-final-preproduccion/ronda2/bases-ronda1/simB-ronda1.json"), "utf8"));

  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any, init: any) => { if (!String(input).startsWith("http://127.0.0.1:")) throw Error("Red externa bloqueada: " + String(input)); return realFetch(input, init); }) as any;
  const server = createServer().listen(0, "127.0.0.1"); await new Promise<void>(r => server.once("listening", r));
  const origin = "http://127.0.0.1:" + (server.address() as any).port;
  const results: any[] = [];
  const check = async (id: string, name: string, esperado: string, fn: (f: any) => Promise<void>) => {
    const f: any = {};
    try { await fn(f); results.push({ id, name, esperado, ok: true, facts: f }); console.log(`OK    ${id} ${name}`); }
    catch (e: any) { results.push({ id, name, esperado, ok: false, facts: f, error: String(e?.stack || e).slice(0, 1500) }); console.log(`FALLA ${id} ${name}\n      esperado: ${esperado}\n      ${JSON.stringify(f).slice(0, 900)} ${String(e?.message || e).slice(0, 900)}`); }
  };
  const addDays = (d: string, n: number) => toBogotaDateStr(new Date(new Date(d + "T12:00:00-05:00").getTime() + n * 86400000));

  // ── Entidades de la ronda 1 ───────────────────────────────────────────────────────
  const userBy = (email: string) => p.user.findUniqueOrThrow({ where: { email } });
  const N = await p.branch.findFirstOrThrow({ where: { name: "Norte B" } });
  const S = await p.branch.findFirstOrThrow({ where: { name: "Sur B" } });
  const drivers = [];
  for (const sd of ["8101", "8102", "8201"]) drivers.push(await p.driver.findFirstOrThrow({ where: { shipdayDriverId: sd } }));
  const branchOf = (k: number) => (k < 2 ? N : S);
  const worker = await p.worker.findFirstOrThrow({ where: { name: "Auxiliar B" } });
  const hc = await p.hourlyClient.findFirstOrThrow({ where: { name: "Por hora B" } });
  const client = await p.client.findFirstOrThrow({ where: { name: "Cliente B" } });

  let tokA = "", tokO = "", tokO2 = "";
  let admin: any, oper: any, oper2: any;
  const sign = (x: any) => signToken({ sub: x.id, email: x.email, name: x.name, role: x.role, tv: x.tokenVersion });
  const resign = async () => { admin = await userBy("admin@extremos.test"); oper = await userBy("oper@extremos.test"); oper2 = await userBy("oper2@extremos.test"); tokA = sign(admin); tokO = sign(oper); tokO2 = sign(oper2); };
  await resign();
  async function api(route: string, method = "GET", body?: unknown, tok = tokO, rawBody?: string, headers: Record<string, string> = {}) {
    const r = await realFetch(origin + "/api" + route, { method, headers: { "Content-Type": "application/json", Authorization: "Bearer " + tok, ...headers }, body: rawBody ?? (body === undefined ? undefined : JSON.stringify(body)) });
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

  // ── Libro: continúa el libro final de la ronda 1 ─────────────────────────────────
  const lf = R1.libroFinal;
  const L = { cash: lf.cash, bank: lf.bank, net: lf.drivers.map((x: number[]) => x[0]), base: lf.drivers.map((x: number[]) => x[1]), client: lf.client, hourlyOwed: lf.hourly, cashOver: 0, bankOff: 0, month: JSON.parse(JSON.stringify(R1.months)) as Record<string, { orders: number; hourly: number; expenses: number; payroll: number; byBranch?: Record<string, number> }> };
  const M = (d: string) => (L.month[d.slice(0, 7)] ??= { orders: 0, hourly: 0, expenses: 0, payroll: 0 });
  const addOrder = (d: string, k: number, c: number) => { L.net[k] += c; const m = M(d); m.orders += c; (m.byBranch ??= {})[branchOf(k).id] = (m.byBranch[branchOf(k).id] ?? 0) + c; };
  let cur = "", orderSeq = 500000;
  const closedMonths = new Set<string>((await p.monthlyClose.findMany({ select: { month: true } })).map((m: any) => m.month));
  let anchor = (await p.monthlyClose.findFirstOrThrow({ where: { branchId: null }, orderBy: { closedAt: "desc" } })).closedAt.getTime();
  const openOrders: { id: string; drv: number; c: number; month: string }[] = [];
  const snapshot = async () => {
    const e = await ok(`/shifts/${cur}/expected`, "GET", undefined, tokA); const ds = await ok("/sd/drivers", "GET", undefined, tokA); const cl = await ok("/clients", "GET", undefined, tokA); const h = await ok(`/hourly-clients/${hc.id}`, "GET", undefined, tokA);
    return { cash: e.expectedCash, bank: e.expectedBank, drivers: drivers.map(dr => { const x = ds.find((y: any) => y.id === dr.id); return [x.pendingDebt - x.creditAmount, x.basePending]; }), client: cl.find((y: any) => y.id === client.id).pendingDebt, hourly: h.pendingDebt };
  };
  const ledgerView = () => ({ cash: L.cash, bank: L.bank, drivers: drivers.map((_, k) => [L.net[k], L.base[k]]), client: L.client, hourly: L.hourlyOwed });
  const assertLedger = async (f: any, label: string) => { f.sistema = await snapshot(); f.libro = ledgerView(); assert.deepEqual(f.sistema, f.libro, label + ": sistema ≠ libro independiente"); };
  const noChange = async (f: any, label: string, fn: () => Promise<void>) => { const a = await snapshot(); await fn(); const b = await snapshot(); assert.deepEqual(b, a, label + ": una petición rechazada cambió saldos"); };

  await check("BP-00", "Continuidad con la ronda 1", "Día operativo 2026-10-22; esperado, domiciliarios, cliente y cliente por hora = libro final de la ronda 1; septiembre cerrado", async f => {
    cur = (await ok("/shifts/current-date", "GET", undefined, tokA)).date; f.dia = cur; assert.equal(cur, "2026-10-22");
    await assertLedger(f, "continuidad"); f.cerrados = [...closedMonths].sort(); assert.ok(closedMonths.has("2026-09"));
  });

  const days: string[] = []; for (let d = cur; d <= FIN; d = addDays(d, 1)) days.push(d);

  // ── Escenarios (repetidos cada CYCLE días, con su esperado) ───────────────────────
  type Sc = { id: string; name: string; esperado: string; run: (d: string, f: any, n: number) => Promise<void> };
  const CYCLE = 30;
  const recurring: Record<number, Sc[]> = {};
  const rec = (off: number, id: string, name: string, esperado: string, run: Sc["run"]) => (recurring[off] ??= []).push({ id, name, esperado, run });
  const flags: Record<string, boolean> = {};

  rec(1, "DUP-WEBHOOK", "Shipday reenvía el mismo pedido 5 veces A LA VEZ", "1 pedido, comisión una vez", async (d, f, n) => {
    const id = `bp-dup-${d}`; const ev = { event: "ORDER_COMPLETED", order: { id, order_number: "D" + n, delivery_fee: 10000, delivery_time: new Date(d + "T13:00:00-05:00").getTime() }, carrier: { id: "8101" } };
    f.status = (await Promise.all([1, 2, 3, 4, 5].map(() => hook(N.id, ev)))).map(r => r.status);
    f.pedidos = await p.shipdayOrder.count({ where: { shipdayOrderId: id } }); assert.equal(f.pedidos, 1); addOrder(d, 0, 3000);
  });
  rec(2, "DUP-MANUAL", "Pedido manual: doble clic con la misma clave y luego el mismo número con otra clave", "1 pedido; mismo número+sucursal+día con otra clave → 409", async (d, f) => {
    const body = { branchId: N.id, driverId: drivers[1].id, deliveryValue: 20000, orderNumber: "MX-" + d, idempotencyKey: "dbl-" + d };
    const rs = await Promise.all([api("/sd/orders/manual", "POST", body), api("/sd/orders/manual", "POST", body)]);
    f.status = rs.map(r => r.status); assert.ok(rs.every(r => r.status === 201 || r.status === 200)); assert.equal(rs[0].body.id, rs[1].body.id);
    f.otraClave = (await api("/sd/orders/manual", "POST", { ...body, idempotencyKey: "otra-" + d })).status; assert.equal(f.otraClave, 409);
    addOrder(d, 1, 6000); openOrders.push({ id: rs[0].body.id, drv: 1, c: 6000, month: d.slice(0, 7) });
  });
  rec(3, "IDEMPOTENCIA", "Reintento de Entregar base con la misma Idempotency-Key (respuesta perdida)", "El reintento devuelve el resultado guardado (Idempotent-Replay) y no crea una segunda base", async (d, f) => {
    const key = "idem-" + d.replace(/-/g, "") + "-x";
    const a = await realFetch(`${origin}/api/sd/bases/${drivers[2].id}/give`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + tokO, "Idempotency-Key": key }, body: JSON.stringify({ cashAmount: 4000 }) });
    const b = await realFetch(`${origin}/api/sd/bases/${drivers[2].id}/give`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + tokO, "Idempotency-Key": key }, body: JSON.stringify({ cashAmount: 4000 }) });
    f.status = [a.status, b.status]; f.replay = b.headers.get("Idempotent-Replay"); assert.equal(a.status, 201); assert.equal(f.replay, "true");
    L.cash -= 4000; L.base[2] += 4000;
  });
  rec(4, "RETRY", "Reintento después de un error de validación", "1.ª petición 400 sin efecto; la corregida crea 1 registro", async (d, f) => {
    await noChange(f, "monto negativo", async () => { f.e1 = (await api(`/sd/drivers/${drivers[0].id}/payment`, "POST", { amount: -5000, medium: "cash" })).status; });
    assert.equal(f.e1, 400); await ok(`/sd/bases/${drivers[0].id}/give`, "POST", { cashAmount: 5000, notes: "retry " + d }); L.cash -= 5000; L.base[0] += 5000;
    f.bases = await p.baseTransaction.count({ where: { notes: "retry " + d } }); assert.equal(f.bases, 1);
  });
  rec(5, "CORTE-RED", "Corte de conexión: 10 gastos (admin) abortados a los 5 ms", "Cada gasto completo o inexistente; esperado = libro", async (d, f) => {
    await Promise.all(Array.from({ length: 10 }, (_, k) => { const c = new AbortController(); setTimeout(() => c.abort(), 5); return realFetch(origin + "/api/movements", { method: "POST", signal: c.signal, headers: { "Content-Type": "application/json", Authorization: "Bearer " + tokA }, body: JSON.stringify({ date: d, category: 3, type: "egreso", medium: "cash", amount: 1000, description: `Corte ${d} ${k}`, status: "confirmed" }) }).catch(() => null); }));
    await new Promise(r => setTimeout(r, 1500));
    const ms = await p.movement.findMany({ where: { description: { startsWith: "Corte " + d } } });
    f.quedaron = ms.length; assert.ok(ms.every((m: any) => m.status === "confirmed" && m.amount === 1000)); L.cash -= 1000 * ms.length; M(d).expenses += 1000 * ms.length;
  });
  rec(6, "SESION-LARGA", "Sesiones a lo largo de los días: token vencido (7 d+), token de hace 6 días, token adulterado", "Vencido 401, de 6 días 200, adulterado 401; nada cambia", async (d, f) => {
    const now = Math.floor(Date.now() / 1000);
    const old8 = jwt.sign({ sub: oper.id, email: oper.email, name: oper.name, role: "user", tv: oper.tokenVersion, iat: now - 8 * 86400, exp: now - 86400 }, process.env.JWT_SECRET);
    const old6 = jwt.sign({ sub: oper.id, email: oper.email, name: oper.name, role: "user", tv: oper.tokenVersion, iat: now - 6 * 86400, exp: now + 86400 }, process.env.JWT_SECRET);
    const forged = jwt.sign({ sub: oper.id, email: oper.email, name: oper.name, role: "admin", tv: oper.tokenVersion }, "otra-clave");
    await noChange(f, "sesión", async () => {
      f.vencido = (await api(`/sd/bases/${drivers[0].id}/give`, "POST", { cashAmount: 1000 }, old8)).status;
      f.adulterado = (await api(`/sd/bases/${drivers[0].id}/give`, "POST", { cashAmount: 1000 }, forged)).status;
    });
    f.seisDias = (await api("/auth/me", "GET", undefined, old6)).status;
    assert.deepEqual([f.vencido, f.adulterado, f.seisDias], [401, 401, 200]);
  });
  rec(7, "CAMBIO-CLAVE", "El admin cambia la contraseña del operador con sesión abierta", "Token viejo 401; clave vieja falla; nueva funciona", async (d, f, n) => {
    const old = n === 0 ? "Oper-clave-2" : `Oper-r2-${n - 1}x`, nueva = `Oper-r2-${n}x`;
    const prevTok = tokO;
    f.cambio = (await api(`/users/${oper.id}`, "PATCH", { password: nueva }, tokA)).status; assert.equal(f.cambio, 200);
    f.viejo = (await api("/auth/me", "GET", undefined, prevTok)).status; assert.equal(f.viejo, 401);
    f.loginViejo = (await api("/auth/login", "POST", { email: oper.email, password: old }, "")).status; assert.ok(f.loginViejo >= 400);
    const ln = await api("/auth/login", "POST", { email: oper.email, password: nueva }, ""); f.loginNuevo = ln.status; assert.ok(ln.status === 200 && ln.body?.token);
    await resign();
  });
  rec(8, "PERMISOS", "El operador intenta acciones de admin", "403 en todas; nada cambia", async (d, f) => {
    const g = await ok("/movements", "POST", { date: d, category: 3, type: "egreso", medium: "cash", amount: 1500, description: "Pendiente perm", status: "confirmed" });
    await noChange(f, "permisos", async () => {
      f.aprobarGasto = (await api(`/movements/${g.id}/approve`, "POST", {})).status;
      f.cierreMes = (await api("/sd/closes", "POST", { month: d.slice(0, 7), initialCash: 1, initialBank: 1 })).status;
      f.crearUsuario = (await api("/users", "POST", { email: `x${d}@x.test`, name: "X", password: "Clave-123", role: "admin" })).status;
      f.borrarTrabajador = (await api(`/workers/${worker.id}`, "DELETE")).status;
      f.editarBase = (await api(`/sd/bases/${(await p.baseTransaction.findFirstOrThrow({ orderBy: { date: "desc" } })).id}`, "PATCH", { cashAmount: 1 })).status;
      f.reset = (await api("/admin/reset", "POST", {})).status;
      f.borrarBanco = (await api(`/bank-transactions/${(await p.bankTransaction.findFirstOrThrow({ orderBy: { date: "desc" } })).id}`, "DELETE")).status;
      f.borrarCierre = (await api(`/shifts/${(await p.shiftClose.findFirstOrThrow({ orderBy: { date: "desc" } })).id}`, "DELETE")).status;
    });
    for (const k of ["aprobarGasto", "cierreMes", "crearUsuario", "borrarTrabajador", "editarBase", "reset", "borrarBanco", "borrarCierre"]) assert.equal(f[k], 403, k);
    await adm(`/movements/${g.id}/reject`, "POST", {});
  });
  rec(9, "DOS-USUARIOS", "Operador, operador 2 (reactivado) y admin registran 30 operaciones a la vez", "Todas cuentan una vez; esperado = libro", async (d, f) => {
    if (!oper2.active) { f.reactivar = (await api(`/users/${oper2.id}`, "PATCH", { active: true }, tokA)).status; await resign(); }
    const ops: Promise<any>[] = [];
    for (let k = 0; k < 10; k++) {
      ops.push(ok(`/sd/bases/${drivers[k % 3].id}/give`, "POST", { cashAmount: 1000 }, tokO)); L.cash -= 1000; L.base[k % 3] += 1000;
      ops.push(ok("/bank-transactions", "POST", { type: "ingreso", medium: "bank", amount: 2000, description: `Simultáneo ${d} ${k}`, noCounterpart: true }, tokO2)); L.bank += 2000;
      ops.push(ok(`/clients/${client.id}/debt`, "POST", { description: `Fiado sim ${d} ${k}`, amount: 500 }, tokA)); L.client += 500;
    }
    f.n = (await Promise.all(ops)).length;
  });
  rec(10, "DOBLE-CIERRE", "Doble clic en Registrar Cierre", "Uno 201, otro 409; un solo Cierre", async (d, f) => { flags.doubleClose = true; f.marcar = "en el Cierre del día"; });
  rec(11, "FUERA-ORDEN", "Operaciones fuera de orden", "Cerrar mañana 4xx; dinero mañana 400; dinero en día cerrado 409; cerrar ayer otra vez 409; nada cambia", async (d, f) => {
    const tomorrow = addDays(d, 1), yesterday = addDays(d, -1);
    await noChange(f, "fuera de orden", async () => {
      f.cerrarManana = (await api("/shifts", "POST", { date: tomorrow, shift: "close", denominations: denominate(L.cash), bankCounted: L.bank })).status;
      f.dineroManana = (await api("/bank-transactions", "POST", { type: "ingreso", medium: "cash", amount: 1000, description: "x", date: tomorrow, noCounterpart: true })).status;
      f.dineroAyer = (await api("/bank-transactions", "POST", { type: "ingreso", medium: "cash", amount: 1000, description: "x", date: yesterday, noCounterpart: true })).status;
      f.cerrarAyer = (await api("/shifts", "POST", { date: yesterday, shift: "close", denominations: denominate(L.cash), bankCounted: L.bank })).status;
    });
    assert.ok(f.cerrarManana >= 400 && f.cerrarManana < 500); assert.equal(f.dineroManana, 400); assert.equal(f.dineroAyer, 409); assert.equal(f.cerrarAyer, 409);
  });
  rec(12, "ANULAR-PAGADO", "Anular por solicitud un pedido (mes abierto) cuya comisión ya se pagó", "Comisión revertida: crédito a favor = comisión; caja igual", async (d, f) => {
    const o = openOrders.find(x => !closedMonths.has(x.month)); assert.ok(o, "no hay pedido del mes abierto"); openOrders.splice(openOrders.indexOf(o!), 1);
    const rq = await ok("/edit-requests", "POST", { requestType: "delete", entityType: "ShipdayOrder", entityId: o!.id, entityLabel: "Pedido", reason: "Cancelado" });
    await adm(`/edit-requests/${rq.id}/review`, "POST", { action: "approved" });
    L.net[o!.drv] -= o!.c; L.month[o!.month].orders -= o!.c; const bb = L.month[o!.month].byBranch; if (bb) bb[branchOf(o!.drv).id] -= o!.c; f.comision = o!.c;
  });
  rec(13, "ESTADOS", "Cambios de estado inesperados", "Reaprobar rechazada 400; inexistente 404; aprobar gasto rechazado 4xx; borrar base dos veces 404; nada cambia", async (d, f) => {
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
  rec(14, "INVALIDOS-AMPLIO", "Datos inválidos en todos los formularios de dinero (ronda 1 + campos nuevos: fechas, medios, desgloses, tipos)", "Todos 4xx (nunca 500 ni 2xx) y nada cambia; ningún Cierre registrado", async (d, f) => {
    const bad: [string, string, any][] = [];
    for (const amt of [0, -5000, 1.5, "abc", null, 1e12, Number.MAX_SAFE_INTEGER, [], {}, true, "", -0.5, [5000], "5000abc"]) {
      bad.push([`/sd/bases/${drivers[0].id}/give`, "POST", { cashAmount: amt }]);
      if (amt !== null) bad.push([`/sd/bases/${drivers[0].id}/give`, "POST", { cashAmount: 1000, bankAmount: amt === 0 ? -1 : amt }]);
      bad.push([`/sd/bases/${drivers[0].id}/pay`, "POST", { cashAmount: amt }]);
      bad.push([`/sd/drivers/${drivers[0].id}/payment`, "POST", { amount: amt, medium: "cash" }]);
      bad.push(["/bank-transactions", "POST", { type: "ingreso", medium: "cash", amount: amt, description: "x", noCounterpart: true }]);
      if (amt !== null && amt !== 0) bad.push(["/bank-transactions", "POST", { type: "ingreso", cashAmount: amt, bankAmount: 1000, description: "x", noCounterpart: true }]);
      bad.push(["/movements", "POST", { date: d, category: 3, type: "egreso", medium: "cash", amount: amt, description: "x" }]);
      bad.push([`/clients/${client.id}/debt`, "POST", { description: "x", amount: amt }]);
      bad.push([`/clients/${client.id}/pay`, "POST", { amount: amt, medium: "cash" }]);
      bad.push(["/sd/conversions", "POST", { branchId: N.id, amount: amt, type: "efectivo_a_banco" }]);
      bad.push(["/sd/orders/manual", "POST", { branchId: N.id, driverId: drivers[0].id, deliveryValue: amt }]);
      bad.push([`/hourly-clients/${hc.id}/pay`, "POST", { amount: amt, medium: "cash" }]);
    }
    for (const dt of ["2026-02-30", "2026-13-01", "abc", "2026-1-5", 20261022, addDays(d, 1), "2099-01-01", `${d}T25:00:00-05:00`, `${d}T10:00:00`]) {
      bad.push(["/bank-transactions", "POST", { type: "ingreso", medium: "cash", amount: 1000, description: "x", date: dt, noCounterpart: true }]);
      bad.push(["/movements", "POST", { date: dt, category: 3, type: "egreso", medium: "cash", amount: 1000, description: "x" }]);
      bad.push([`/clients/${client.id}/debt`, "POST", { description: "x", amount: 1000, date: dt }]);
      bad.push(["/sd/orders/manual", "POST", { branchId: N.id, driverId: drivers[0].id, deliveryValue: 10000, deliveredAt: dt }]);
      bad.push([`/hourly-clients/${hc.id}/shifts`, "POST", { driverId: drivers[0].id, startTime: "10:00", endTime: "12:00", medium: "cash", date: dt }]);
    }
    for (const med of ["CASH", "", "crypto", 1, null]) {
      bad.push([`/sd/drivers/${drivers[0].id}/payment`, "POST", { amount: 1000, medium: med }]);
      bad.push(["/bank-transactions", "POST", { type: "ingreso", medium: med, amount: 1000, description: "x", noCounterpart: true }]);
      bad.push([`/clients/${client.id}/pay`, "POST", { amount: 1000, medium: med === null ? "x" : med }]);
      bad.push([`/hourly-clients/${hc.id}/shifts`, "POST", { driverId: drivers[0].id, startTime: "10:00", endTime: "12:00", medium: med }]);
    }
    bad.push([`/sd/drivers/${drivers[0].id}/payment`, "POST", { amount: 1000, medium: "cash", baseAmount: 2000 }]);
    bad.push([`/sd/drivers/${drivers[0].id}/payment`, "POST", { amount: 1000, medium: "cash", baseAmount: -1 }]);
    bad.push([`/sd/drivers/no-existe/payment`, "POST", { amount: 1000, medium: "cash" }]);
    bad.push([`/sd/bases/no-existe/give`, "POST", { cashAmount: 1000 }]);
    bad.push(["/sd/conversions", "POST", { branchId: N.id, amount: 1000, type: "otro" }]);
    bad.push(["/sd/conversions", "POST", { branchId: "no-existe", amount: 1000, type: "efectivo_a_banco" }]);
    bad.push(["/bank-transactions", "POST", { type: "ingreso", amount: 1000, description: "sin medio" }]);
    bad.push(["/bank-transactions", "POST", { type: "otro", medium: "cash", amount: 1000, description: "x" }]);
    bad.push(["/bank-transactions", "POST", { type: "ingreso", medium: "cash", amount: 1000, description: { a: 1 }, noCounterpart: true }]);
    bad.push(["/bank-transactions", "POST", { type: "ingreso", medium: "cash", amount: 1000, description: "x", pairWith: "x", noCounterpart: true }]);
    bad.push(["/movements", "POST", { date: d, category: 99, type: "egreso", medium: "cash", amount: 1000, description: "x" }]);
    bad.push(["/movements", "POST", { date: d, category: 3, type: "egreso", medium: "bank", amount: 1000, description: "gasto efectivo por banco" }]);
    bad.push([`/hourly-clients/${hc.id}/shifts`, "POST", { driverId: drivers[0].id, startTime: "10:00", endTime: "10:00", medium: "cash" }]);
    bad.push([`/hourly-clients/${hc.id}/shifts`, "POST", { driverId: drivers[0].id, startTime: "25:00", endTime: "26:00", medium: "cash" }]);
    bad.push([`/hourly-clients/${hc.id}/shifts`, "POST", { driverId: "no-existe", startTime: "10:00", endTime: "12:00", medium: "cash" }]);
    bad.push(["/edit-requests", "POST", { requestType: "create", entityType: "BankTransaction", entityId: "nuevo", entityLabel: "", changes: { date: addDays(d, -1), type: "egreso", medium: "cash", amount: -1000, description: "x" }, reason: "x" }]);
    bad.push(["/edit-requests", "POST", { requestType: "create", entityType: "BankTransaction", entityId: "nuevo", entityLabel: "", changes: { date: "2026-02-30", type: "egreso", medium: "cash", amount: 1000, description: "x" }, reason: "x" }]);
    bad.push(["/edit-requests", "POST", { requestType: "borrar-todo", entityType: "X", entityId: "y", reason: "x" }]);
    for (const den of [{ bills: [{ value: 100000, qty: -3 }], coins: [] }, { bills: [{ value: 999999, qty: 1 }], coins: [] }, { bills: [{ value: 1000, qty: 0.5 }], coins: [] }, "x", { bills: [{ value: 50000, qty: 1e15 }], coins: [] }, { bills: [{ value: "1000", qty: 1 }], coins: [] }, { bills: null, coins: [{ value: 7, qty: 1 }] }]) bad.push(["/shifts", "POST", { date: d, shift: "close", denominations: den, bankCounted: L.bank }]);
    for (const bc of [-1, 10.5, "x", 1e12, null, true, [1000], {}]) bad.push(["/shifts", "POST", { date: d, shift: "close", denominations: denominate(L.cash), bankCounted: bc }]);
    bad.push(["/shifts", "POST", { date: d, shift: "NOCHE", denominations: denominate(L.cash), bankCounted: L.bank }]);
    // Un gasto PENDIENTE del operador editado con fecha imposible/futura o monto inválido (INC-03 / INC-R2-03).
    const pend = await ok("/movements", "POST", { date: d, category: 3, type: "egreso", medium: "cash", amount: 1000, description: "pendiente a editar", status: "confirmed" });
    for (const patch of [{ date: "2026-02-30" }, { date: addDays(d, 1) }, { date: "2099-01-01" }, { amount: -5 }, { amount: 0 }, { amount: true }, { category: 4 }]) bad.push([`/movements/${pend.id}`, "PATCH", patch]);
    const codes: number[] = [];
    await noChange(f, "inválidos", async () => { for (const [r, m, b] of bad) codes.push((await api(r, m, b)).status); });
    f.total = bad.length; f.codigos = [...new Set(codes)].sort();
    f.no4xx = bad.map((x, k) => [codes[k], x[0], JSON.stringify(x[2]).slice(0, 120)]).filter((x: any) => x[0] < 400 || x[0] >= 500);
    assert.equal(f.no4xx.length, 0, "peticiones inválidas aceptadas o con error 500");
    f.cierres = await p.shiftClose.count({ where: { date: d } }); assert.equal(f.cierres, 0);
    f.diasInvalidos = await p.day.count({ where: { OR: [{ date: { gt: d } }, { date: "2026-02-30" }] } }); assert.equal(f.diasInvalidos, 0, "se creó un Day futuro o inexistente");
    await adm(`/movements/${pend.id}/reject`, "POST", {});
    f.jsonRoto = (await api("/movements", "POST", undefined, tokA, "{no es json")).status; assert.ok(f.jsonRoto >= 400 && f.jsonRoto < 500);
  });
  rec(16, "MEDIANOCHE", "Medianoche real: operación a las 23:59:50, otra a las 00:00:10 del día siguiente con la caja aún abierta, y el Cierre después de medianoche", "Ambas cuentan en el día operativo (NEW02); con fecha del día siguiente → 400; turno nocturno sin confirmar 409, confirmado 3 h; el Cierre de después de medianoche cuadra", async (d, f) => {
    setNow(`${d}T23:59:50-05:00`);
    await ok("/bank-transactions", "POST", { type: "ingreso", medium: "cash", amount: 1100, description: "23:59:50 " + d, noCounterpart: true }); L.cash += 1100;
    setNow(`${addDays(d, 1)}T00:00:10-05:00`); await resign();
    f.diaOperativo = (await ok("/shifts/current-date")).date; assert.equal(f.diaOperativo, d, "a medianoche el día operativo cambió solo");
    await ok("/bank-transactions", "POST", { type: "ingreso", medium: "cash", amount: 1200, description: "00:00:10 " + d, noCounterpart: true }); L.cash += 1200;
    const tx = await p.bankTransaction.findFirstOrThrow({ where: { description: "00:00:10 " + d } }); f.fechaContable = toBogotaDateStr(tx.date); assert.equal(f.fechaContable, d);
    f.conFechaSiguiente = (await api("/bank-transactions", "POST", { type: "ingreso", medium: "cash", amount: 1100, description: "x", date: addDays(d, 1), noCounterpart: true })).status; assert.equal(f.conFechaSiguiente, 400);
    f.sinConfirmar = (await api(`/hourly-clients/${hc.id}/shifts`, "POST", { driverId: drivers[2].id, startTime: "22:00", endTime: "01:00", medium: "cash", date: d })).status; assert.equal(f.sinConfirmar, 409);
    const h = await p.hourlyClient.findUniqueOrThrow({ where: { id: hc.id } });
    const sh = await ok(`/hourly-clients/${hc.id}/shifts`, "POST", { driverId: drivers[2].id, startTime: "22:00", endTime: "01:00", medium: "cash", confirmOvernight: true, date: d });
    f.minutos = sh.minutes; assert.equal(sh.minutes, 180); L.cash -= 3 * h.driverHourValue; L.hourlyOwed += 3 * (h.driverHourValue + h.companyHourValue); M(d).hourly += 3 * h.companyHourValue;
  });
  rec(18, "DIFERENCIAS", "Cierre con sobrante de efectivo y banco que no cuadra", "Cierre en rojo +700/−300; el esperado siguiente sigue al libro", async () => { flags.diffClose = true; });
  rec(20, "REINICIO", "REINICIO REAL con reloj simulado: se mata el servidor (dist) en una ráfaga de 40 bases y se relanza", "Nada a medias; tras reiniciar esperado y saldos = libro; el servidor responde", async (d, f) => {
    const port = 4300 + Math.floor(Math.random() * 7); // OBS-07: fetch (WHATWG) rechaza el puerto 4190 ("bad port")
    const spawn = () => cp.spawn(process.execPath, ["--require", path.join(__dirname, "block-external.cjs"), path.resolve(__dirname, "../dist/index.js")], { cwd: path.resolve(__dirname, ".."), env: { ...process.env, FAKE_NOW_MS: String(Date.now()), PORT: String(port), HOST: "127.0.0.1", WEB_DIR: "" }, stdio: ["ignore", fs.openSync(CHILD_LOG, "a"), fs.openSync(CHILD_LOG, "a")], windowsHide: true });
    const waitUp = async () => { const t0 = RealDate.now(); for (let t = 0; t < 360; t++) { try { const r = await realFetch(`http://127.0.0.1:${port}/api/health`); if (r.ok) { (f.arranqueMs ??= []).push(RealDate.now() - t0); return; } } catch { } await new Promise(r => setTimeout(r, 250)); } throw Error("el servidor no levantó en 90 s"); };
    let child = spawn();
    try {
      await waitUp();
      const ext = (route: string, body: unknown) => realFetch(`http://127.0.0.1:${port}/api${route}`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + tokA }, body: JSON.stringify(body) }).then(r => r.status).catch(() => "cortada");
      const burst = Array.from({ length: 40 }, (_, k) => ext(`/sd/bases/${drivers[k % 3].id}/give`, { cashAmount: 1000, notes: `Ráfaga ${d} ${k}` }));
      for (let t = 0; t < 400; t++) { if (await p.baseTransaction.count({ where: { notes: { startsWith: `Ráfaga ${d}` } } }) >= 5) break; await new Promise(r => setTimeout(r, 10)); }
      child.kill("SIGKILL");
      f.respuestas = (await Promise.all(burst)).reduce((a: any, s: any) => (a[s] = (a[s] || 0) + 1, a), {});
      child = spawn(); await waitUp();
      const made = await p.baseTransaction.findMany({ where: { notes: { startsWith: `Ráfaga ${d}` } } });
      f.quedaron = made.length; assert.ok(made.every((b: any) => b.amount === 1000 && b.type === "entrega"));
      for (const b of made) { const k = drivers.findIndex(x => x.id === b.driverId); L.cash -= 1000; L.base[k] += 1000; }
      f.despues = await ext(`/sd/bases/${drivers[0].id}/give`, { cashAmount: 1000, notes: "tras reinicio " + d }); assert.equal(f.despues, 201); L.cash -= 1000; L.base[0] += 1000;
    } finally { child.kill("SIGKILL"); }
  });
  rec(22, "INTERRUPCION-CIERRE", "Se mata el servidor mientras registra el Cierre del día", "Cierre completo (bloqueado, esperado correcto) o inexistente y registrable; nunca a medias", async () => { flags.killClose = true; });
  rec(23, "RAFAGA-SHIPDAY", "Ráfaga de 120 webhooks distintos a la vez (Shipday entrega muchos pedidos juntos); los 503 se reintentan", "Cada pedido queda exactamente una vez; comisión total = Σ 30 %", async (d, f) => {
    const evs = Array.from({ length: 120 }, (_, k) => ({ b: branchOf(k % 3).id, k: k % 3, ev: { event: "ORDER_COMPLETED", order: { id: `bp-raf-${d}-${k}`, order_number: `R${k}`, delivery_fee: 7000, delivery_time: new Date(`${d}T${String(9 + (k % 10)).padStart(2, "0")}:00:00-05:00`).getTime() }, carrier: { id: drivers[k % 3].shipdayDriverId } } }));
    let pend = evs, rondas = 0, e503 = 0;
    while (pend.length && rondas < 10) { const st = await Promise.all(pend.map(x => hook(x.b, x.ev).then(r => r.status))); e503 += st.filter(s => s === 503).length; assert.ok(st.every(s => s === 200 || s === 503), "estado inesperado " + [...new Set(st)]); pend = pend.filter((_, i) => st[i] === 503); rondas++; }
    f.rondas = rondas; f.reintentos503 = e503; assert.equal(pend.length, 0);
    f.pedidos = await p.shipdayOrder.count({ where: { shipdayOrderId: { startsWith: `bp-raf-${d}-` } } }); assert.equal(f.pedidos, 120);
    for (const x of evs) addOrder(d, x.k, commission(7000));
  });
  rec(25, "SOLICITUD-DOBLE", "El admin aprueba la misma solicitud dos veces a la vez", "Un solo efecto; la otra 400", async (d, f) => {
    const rq = await ok("/edit-requests", "POST", { requestType: "create", entityType: "BankTransaction", entityId: "nuevo", entityLabel: "", changes: { date: addDays(d, -1), type: "egreso", medium: "cash", amount: 2200, description: "Olvido doble " + d, noCounterpart: true }, reason: "olvido" });
    const rs = await Promise.all([api(`/edit-requests/${rq.id}/review`, "POST", { action: "approved" }, tokA), api(`/edit-requests/${rq.id}/review`, "POST", { action: "approved" }, tokA)]);
    f.status = rs.map(r => r.status).sort(); assert.deepEqual(f.status, [200, 400]);
    f.creados = await p.bankTransaction.count({ where: { description: "Olvido doble " + d } }); assert.equal(f.creados, 1); L.cash -= 2200;
  });
  rec(27, "SUCURSAL-PAUSA", "La sucursal Sur se desactiva: webhooks y pedidos manuales; luego se reactiva", "Desactivada: webhook 200 ignorado (no cuenta), manual 400; reactivada: vuelve a contar", async (d, f) => {
    await adm(`/branches/${S.id}`, "PATCH", { active: false });
    await noChange(f, "sucursal pausada", async () => {
      const r = await hook(S.id, { event: "ORDER_COMPLETED", order: { id: `bp-pausa-${d}`, order_number: "P1", delivery_fee: 9000, delivery_time: new Date(`${d}T12:00:00-05:00`).getTime() }, carrier: { id: "8201" } });
      f.webhook = [r.status, await r.json()];
      f.manual = (await api("/sd/orders/manual", "POST", { branchId: S.id, driverId: drivers[2].id, deliveryValue: 9000 })).status;
    });
    assert.equal(f.webhook[0], 200); assert.equal(f.webhook[1].processed, 0); assert.equal(f.manual, 400);
    await adm(`/branches/${S.id}`, "PATCH", { active: true });
    const r2 = await hook(S.id, { event: "ORDER_COMPLETED", order: { id: `bp-pausa2-${d}`, order_number: "P2", delivery_fee: 9000, delivery_time: new Date(`${d}T12:30:00-05:00`).getTime() }, carrier: { id: "8201" } });
    f.reactivada = (await r2.json()).processed; assert.equal(f.reactivada, 1); addOrder(d, 2, 2700);
  });
  rec(28, "CONTRAPARTE", "Contrapartes inválidas: parcial, mismo signo, inexistente, doble", "400/409/404 y nada cambia; la válida cuadra", async (d, f) => {
    const out = await ok("/bank-transactions", "POST", { type: "egreso", medium: "bank", amount: 50000, description: "Salida " + d }); L.bank -= 50000;
    await noChange(f, "contraparte", async () => {
      f.parcial = (await api("/bank-transactions", "POST", { type: "ingreso", medium: "cash", amount: 20000, description: "Parcial", pairWith: out.id })).status;
      f.mismoSigno = (await api("/bank-transactions", "POST", { type: "egreso", medium: "cash", amount: 50000, description: "Mismo", pairWith: out.id })).status;
      f.inexistente = (await api("/bank-transactions", "POST", { type: "ingreso", medium: "cash", amount: 50000, description: "x", pairWith: "no-existe" })).status;
    });
    await ok("/bank-transactions", "POST", { type: "ingreso", medium: "cash", amount: 50000, description: "Retorno " + d, pairWith: out.id }); L.cash += 50000;
    f.doble = (await api("/bank-transactions", "POST", { type: "ingreso", medium: "cash", amount: 50000, description: "Doble", pairWith: out.id })).status;
    assert.equal(f.parcial, 400); assert.ok([400, 409].includes(f.mismoSigno)); assert.equal(f.inexistente, 404); assert.equal(f.doble, 409);
  });
  rec(29, "PAGO-EXCESIVO", "Devolver más base de la que tiene y pagar crédito sin crédito", "400 en ambos; nada cambia", async (d, f) => {
    await noChange(f, "excesivo", async () => {
      f.base = (await api(`/sd/bases/${drivers[1].id}/pay`, "POST", { cashAmount: L.base[1] + 99999 })).status;
      f.credito = L.net[1] >= 0 ? (await api(`/sd/drivers/${drivers[1].id}/pay-credit`, "POST", { medium: "cash" })).status : 400;
    });
    assert.equal(f.base, 400); assert.equal(f.credito, 400);
  });

  // Escenarios de una sola vez (uso prolongado).
  const once: Record<string, Sc[]> = {};
  const one = (day: string, id: string, name: string, esperado: string, run: Sc["run"]) => (once[day] ??= []).push({ id, name, esperado, run });
  one("2026-11-10", "TARIFA-CAMBIA", "El admin sube la tarifa del cliente por hora a mitad de período", "Los turnos viejos conservan su tarifa (deuda y reportes previos intactos); los nuevos usan la nueva", async (d, f) => {
    const before = await adm(`/hourly-clients/${hc.id}`); const repOct = await adm("/sd/report/2026-10");
    await adm(`/hourly-clients/${hc.id}`, "PATCH", { driverHourValue: 12000, companyHourValue: 6000 });
    const after = await adm(`/hourly-clients/${hc.id}`); f.deuda = [before.pendingDebt, after.pendingDebt]; assert.equal(after.pendingDebt, before.pendingDebt);
    const repOct2 = await adm("/sd/report/2026-10"); assert.equal(repOct2.sales.hourly, repOct.sales.hourly);
    const sh = await ok(`/hourly-clients/${hc.id}/shifts`, "POST", { driverId: drivers[2].id, startTime: "10:00", endTime: "12:00", medium: "cash" });
    f.turnoNuevo = [sh.driverAmount ?? sh.driverPay, sh.companyAmount]; L.cash -= 24000; L.hourlyOwed += 36000; M(d).hourly += 12000;
  });
  one("2026-11-30", "PENDIENTES-ULTIMO-DIA", "Último día del mes: queda un gasto PENDIENTE de ese día y una solicitud D7 sin revisar sobre el día anterior", "Se crean pendientes; no cambian la caja", async (d, f) => {
    const g = await ok("/movements", "POST", { date: d, category: 3, type: "egreso", medium: "cash", amount: 3300, description: "Pendiente fin de mes", status: "confirmed" }); assert.equal(g.status, "pending");
    const rq = await ok("/edit-requests", "POST", { requestType: "create", entityType: "BankTransaction", entityId: "nuevo", entityLabel: "", changes: { date: addDays(d, -1), type: "egreso", medium: "cash", amount: 4400, description: "D7 fin de mes", noCounterpart: true }, reason: "olvido" });
    (globalThis as any).__pend = { g: g.id, rq: rq.id }; f.gasto = g.id; f.solicitud = rq.id;
  });
  one("2026-12-01", "PENDIENTES-CRUZAN-MES", "Después de cerrar noviembre: aprobar el gasto pendiente del 30-nov y la solicitud D7 del 29-nov", "Ambas aprobaciones rechazadas (4xx) y siguen pendientes; nada cambia; rechazarlas funciona", async (d, f) => {
    const { g, rq } = (globalThis as any).__pend;
    await noChange(f, "pendientes de un mes cerrado", async () => {
      f.aprobarGasto = (await api(`/movements/${g}/approve`, "POST", {}, tokA)).status;
      f.aprobarD7 = (await api(`/edit-requests/${rq}/review`, "POST", { action: "approved" }, tokA)).status;
    });
    assert.ok(f.aprobarGasto >= 400 && f.aprobarGasto < 500); assert.ok(f.aprobarD7 >= 400 && f.aprobarD7 < 500);
    f.estadoD7 = (await p.editRequest.findUniqueOrThrow({ where: { id: rq } })).status; assert.equal(f.estadoD7, "pending");
    f.estadoGasto = (await p.movement.findUniqueOrThrow({ where: { id: g } })).status; assert.equal(f.estadoGasto, "pending");
    await adm(`/movements/${g}/reject`, "POST", {}); await adm(`/edit-requests/${rq}/review`, "POST", { action: "rejected" });
  });
  one("2026-12-05", "DEUDA-LARGA-INICIO", "Domi X2 deja de pagar (pedidos siguen llegando) durante 6 semanas", "La deuda crece exactamente con cada comisión", async (d, f) => { (globalThis as any).__noPay = true; f.desde = d; });
  one("2027-01-16", "DEUDA-LARGA-PAGO", "Domi X2 paga 6 semanas acumuladas en dos pagos (efectivo y banco)", "Deuda 0 después; caja/banco suben exactamente; los reportes de meses cerrados no cambian", async (d, f) => {
    (globalThis as any).__noPay = false;
    const repDic = await adm("/sd/report/2026-12");
    const owe = L.net[1] + L.base[1]; f.acumulado = owe; assert.ok(owe > 0);
    const half = Math.floor(owe / 2000) * 1000;
    await ok(`/sd/drivers/${drivers[1].id}/payment`, "POST", { amount: half, medium: "cash", baseAmount: Math.min(L.base[1], half) });
    L.cash += half; const b1 = Math.min(L.base[1], half); L.base[1] -= b1; L.net[1] -= half - b1;
    const rest = L.net[1] + L.base[1];
    await ok(`/sd/drivers/${drivers[1].id}/payment`, "POST", { amount: rest, medium: "bank", baseAmount: L.base[1] });
    L.bank += rest; L.net[1] -= rest - L.base[1]; L.base[1] = 0;
    const repDic2 = await adm("/sd/report/2026-12"); assert.equal(repDic2.netProfit, repDic.netProfit);
  });
  one("2027-02-14", "SESION-DESACTIVADO", "El admin desactiva al operador 2 con sesión abierta (repetición tras meses)", "Token 401; no registra dinero", async (d, f) => {
    if (!oper2.active) { await api(`/users/${oper2.id}`, "PATCH", { active: true }, tokA); await resign(); }
    const t2 = tokO2;
    f.desactivar = (await api(`/users/${oper2.id}`, "PATCH", { active: false }, tokA)).status;
    await noChange(f, "desactivado", async () => { f.op = (await api("/bank-transactions", "POST", { type: "ingreso", medium: "bank", amount: 1000, description: "x", noCounterpart: true }, t2)).status; });
    assert.equal(f.op, 401); await resign();
  });

  // ── Cierre de mes del día 1 (con escenarios de cambio de año) ─────────────────────
  async function monthCloseDay(d: string) {
    const mo = addDays(d, -1).slice(0, 7);
    if (d === "2027-01-01") {
      setNow("2027-01-01T00:05:00-05:00"); await resign(); cur = d;
      await check("BP-ANIO-NUEVO", "Cambio de año: pedido entregado el 31-dic 23:59:30 y otro el 1-ene 00:00:30, recibidos a las 00:05", "El de las 23:59:30 cuenta en diciembre de 2026 y el de las 00:00:30 en enero de 2027 (reportes y Excel de cada año)", async f => {
        for (const [id, at, k] of [["bp-31dic", "2026-12-31T23:59:30-05:00", 0], ["bp-1ene", "2027-01-01T00:00:30-05:00", 2]] as [string, string, number][]) {
          const r = await hook(branchOf(k).id, { event: "ORDER_COMPLETED", order: { id, order_number: id, delivery_fee: 10000, delivery_time: new Date(at).getTime() }, carrier: { id: drivers[k].shipdayDriverId } });
          assert.equal(r.status, 200); f[id] = (await r.json()).processed; addOrder(at.slice(0, 10), k, 3000);
        }
        assert.deepEqual([f["bp-31dic"], f["bp-1ene"]], [1, 1]);
        await assertLedger(f, "año nuevo");
      });
    }
    setNow(`${d}T08:00:00-05:00`); await resign(); cur = d;
    await check(`BP-MES-${mo}`, `Día 1 (${d}): reporte de ${mo} = libro; cierre con doble clic concurrente; modificar el mes cerrado`, "Reporte = libro; uno 201 y otro 409; gasto directo 409, PATCH/DELETE de base 409, borrar pedido del mes y agregar dinero al mes no se aplican; nada cambia", async f => {
      const m = L.month[mo]; const r = await adm(`/sd/report/${mo}`);
      f.r = [r.sales.orders, r.sales.hourly, r.expenses.total, r.payroll.total, r.netProfit]; f.l = [m.orders, m.hourly, m.expenses, m.payroll, m.orders + m.hourly - m.expenses - m.payroll];
      assert.deepEqual(f.r, f.l);
      if (m.byBranch && mo !== "2026-10") for (const b of [N, S]) { const rb = await adm(`/sd/report/${mo}?branchId=${b.id}`); assert.equal(rb.sales.orders, m.byBranch[b.id] ?? 0, "por sucursal " + b.name); }
      const e = await ok(`/shifts/${d}/expected`, "GET", undefined, tokA); assert.deepEqual([e.expectedCash, e.expectedBank], [L.cash, L.bank]);
      const rs = await Promise.all([api("/sd/closes", "POST", { month: mo, initialCash: e.expectedCash, initialBank: e.expectedBank }, tokA), api("/sd/closes", "POST", { month: mo, initialCash: e.expectedCash, initialBank: e.expectedBank }, tokA)]);
      f.status = rs.map(x => x.status).sort(); assert.deepEqual(f.status, [201, 409]);
      assert.equal(await p.monthlyClose.count({ where: { month: mo } }), 1);
      closedMonths.add(mo); anchor = (await p.monthlyClose.findFirstOrThrow({ where: { month: mo } })).closedAt.getTime();
      const base = await p.baseTransaction.findFirstOrThrow({ where: { date: { gte: new Date(mo + "-05T00:00:00-05:00"), lt: new Date(mo + "-20T00:00:00-05:00") } } });
      const ord = await p.shipdayOrder.findFirstOrThrow({ where: { deliveredAt: { gte: new Date(mo + "-05T00:00:00-05:00"), lt: new Date(mo + "-20T00:00:00-05:00") } } });
      let rqDel: any, rqCreate: any;
      await noChange(f, "mes cerrado", async () => {
        f.gasto = (await api("/movements", "POST", { date: `${mo}-15`, category: 3, type: "egreso", medium: "cash", amount: 1000, description: "x", status: "confirmed" }, tokA)).status;
        f.patchBase = (await api(`/sd/bases/${base.id}`, "PATCH", { cashAmount: base.amount + 1 }, tokA)).status;
        f.deleteBase = (await api(`/sd/bases/${base.id}`, "DELETE", undefined, tokA)).status;
        rqDel = await api("/edit-requests", "POST", { requestType: "delete", entityType: "ShipdayOrder", entityId: ord.id, entityLabel: "x", reason: "x" });
        if (rqDel.status === 201) f.aprobarBorrar = (await api(`/edit-requests/${rqDel.body.id}/review`, "POST", { action: "approved" }, tokA)).status;
        rqCreate = await api("/edit-requests", "POST", { requestType: "create", entityType: "BankTransaction", entityId: "nuevo", entityLabel: "", changes: { date: `${mo}-15`, type: "egreso", medium: "cash", amount: 1000, description: "x" }, reason: "x" });
        if (rqCreate.status === 201) f.aprobarAgregar = (await api(`/edit-requests/${rqCreate.body.id}/review`, "POST", { action: "approved" }, tokA)).status;
        // Shipday entrega TARDE un pedido del mes cerrado (rezagado): no debe contar.
        const late = await hook(N.id, { event: "ORDER_COMPLETED", order: { id: `bp-tarde-${mo}`, order_number: "T", delivery_fee: 9000, delivery_time: new Date(`${mo}-20T15:00:00-05:00`).getTime() }, carrier: { id: "8101" } });
        f.webhookTardio = late.status;
      });
      assert.equal(f.gasto, 409); assert.equal(f.patchBase, 409); assert.equal(f.deleteBase, 409); assert.equal(f.webhookTardio, 409);
      if (f.aprobarBorrar !== undefined) { assert.ok(f.aprobarBorrar >= 400); assert.equal((await p.editRequest.findUniqueOrThrow({ where: { id: rqDel.body.id } })).status, "pending"); await adm(`/edit-requests/${rqDel.body.id}/review`, "POST", { action: "rejected" }); }
      if (f.aprobarAgregar !== undefined) { assert.ok(f.aprobarAgregar >= 400); assert.equal((await p.editRequest.findUniqueOrThrow({ where: { id: rqCreate.body.id } })).status, "pending"); await adm(`/edit-requests/${rqCreate.body.id}/review`, "POST", { action: "rejected" }); }
      assert.equal(await p.shipdayOrder.count({ where: { id: ord.id } }), 1);
      assert.equal(await p.shipdayOrder.count({ where: { shipdayOrderId: `bp-tarde-${mo}` } }), 0);
    });
  }

  for (const [j, d] of days.entries()) {
    const i = 61 + j;
    if (d.endsWith("-01")) { await monthCloseDay(d); if (!results[results.length - 1].ok) break; }
    setNow(`${d}T22:00:00-05:00`); await resign(); cur = d;
    await check(`BP-D${String(j + 1).padStart(3, "0")}`, `Día ${d}: operación base`, "esperado y saldos = libro", async f => {
      assert.equal((await ok("/shifts/current-date")).date, d);
      if (L.cashOver) { await adm("/bank-transactions", "POST", { type: "ingreso", medium: "cash", amount: L.cashOver, description: "Sobrante de caja", noCounterpart: true }); L.cash += L.cashOver; L.cashOver = 0; }
      if (L.bankOff) { await adm("/bank-transactions", "POST", { type: "egreso", medium: "bank", amount: L.bankOff, description: "Comisión bancaria no registrada", noCounterpart: true }); L.bank -= L.bankOff; L.bankOff = 0; }
      const noPay = (globalThis as any).__noPay;
      for (let k = 0; k < 3; k++) {
        const fee = 8000 + 1000 * ((i + k) % 4), id = `bp-${d}-${k}`;
        const r = await hook(branchOf(k).id, { event: "ORDER_COMPLETED", order: { id, order_number: String(++orderSeq), delivery_fee: fee, delivery_time: new Date(`${d}T${10 + k}:30:00-05:00`).getTime() }, carrier: { id: drivers[k].shipdayDriverId } });
        assert.equal(r.status, 200); const c = commission(fee); addOrder(d, k, c);
        const o = await p.shipdayOrder.findUniqueOrThrow({ where: { shipdayOrderId: id } }); openOrders.push({ id: o.id, drv: k, c, month: d.slice(0, 7) });
        if (noPay && k === 1) continue;
        await ok(`/sd/bases/${drivers[k].id}/give`, "POST", { cashAmount: 6000 }); L.cash -= 6000; L.base[k] += 6000;
        const owe = Math.max(L.net[k], 0), amount = owe + L.base[k];
        await ok(`/sd/drivers/${drivers[k].id}/payment`, "POST", { amount, medium: k === 1 ? "bank" : "cash", baseAmount: L.base[k] });
        if (k === 1) L.bank += amount; else L.cash += amount; L.net[k] -= amount - L.base[k]; L.base[k] = 0;
      }
      if (i % 7 === 4) { await adm("/movements", "POST", { date: d, category: 15, type: "egreso", medium: "cash", amount: 40000, description: "Nómina", workerId: worker.id, status: "confirmed" }); L.cash -= 40000; M(d).payroll += 40000; }
      if (i % 2 === 0) { await adm("/movements", "POST", { date: d, category: 4, type: "egreso", medium: "bank", amount: 3000, description: `Gasto ${i}`, status: "confirmed" }); L.bank -= 3000; M(d).expenses += 3000; }
      if (i % 10 === 9 && L.hourlyOwed) { await ok(`/hourly-clients/${hc.id}/pay`, "POST", { payAll: true, medium: "bank" }); L.bank += L.hourlyOwed; L.hourlyOwed = 0; }
      if (L.cash > 3000000) { const x = Math.floor((L.cash - 2500000) / 1000) * 1000; await adm("/sd/conversions", "POST", { branchId: N.id, amount: x, type: "efectivo_a_banco" }); L.cash -= x; L.bank += x; }
      if (L.cash < 600000) { await adm("/sd/conversions", "POST", { branchId: N.id, amount: 500000, type: "banco_a_efectivo" }); L.cash += 500000; L.bank -= 500000; }
      await assertLedger(f, d);
    });
    if (!results[results.length - 1].ok) break;
    let broke = false;
    const todays = [...(recurring[j % CYCLE] ?? []).map(s => ({ ...s, n: Math.floor(j / CYCLE) })), ...(once[d] ?? []).map(s => ({ ...s, n: 0 }))];
    for (const s of todays) {
      await check(`BP-${s.id}-${d}`, `${s.name} (${d})`, s.esperado, async f => { await s.run(d, f, s.n); await assertLedger(f, s.id); });
      if (!results[results.length - 1].ok) { broke = true; break; }
    }
    if (broke) break;

    await check(`BP-C${String(j + 1).padStart(3, "0")}`, `Cierre ${d}`, "Cierre con la diferencia prevista", async f => {
      if (flags.killClose) {
        flags.killClose = false;
        const port = 4197; const child = cp.spawn(process.execPath, ["--require", path.join(__dirname, "block-external.cjs"), path.resolve(__dirname, "../dist/index.js")], { cwd: path.resolve(__dirname, ".."), env: { ...process.env, FAKE_NOW_MS: String(Date.now()), PORT: String(port), HOST: "127.0.0.1", WEB_DIR: "" }, stdio: ["ignore", fs.openSync(CHILD_LOG, "a"), fs.openSync(CHILD_LOG, "a")], windowsHide: true });
        try {
          let up = false; for (let t = 0; t < 360 && !up; t++) { try { up = (await realFetch(`http://127.0.0.1:${port}/api/health`)).ok; } catch { } if (!up) await new Promise(r => setTimeout(r, 250)); }
          assert.ok(up, "el servidor hijo no levantó");
          const pr = realFetch(`http://127.0.0.1:${port}/api/shifts`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + tokA }, body: JSON.stringify({ date: d, shift: "close", denominations: denominate(L.cash), bankCounted: L.bank }) }).then(r => r.status).catch(() => "cortada");
          await new Promise(r => setTimeout(r, 40)); child.kill("SIGKILL"); f.respuesta = await pr;
        } finally { child.kill("SIGKILL"); }
        const sc = await p.shiftClose.findUnique({ where: { date_shift: { date: d, shift: "close" } } });
        f.quedo = !!sc;
        if (sc) { assert.equal(sc.locked, true); assert.equal(sc.totalExpected, L.cash); assert.equal(sc.difference, 0); return; }
      }
      const body = { date: d, shift: "close", receivedBy: "Op", denominations: denominate(L.cash + (flags.diffClose ? 700 : 0)), bankCounted: L.bank - (flags.diffClose ? 300 : 0) };
      if (flags.doubleClose) {
        flags.doubleClose = false;
        const rs = await Promise.all([api("/shifts", "POST", body), api("/shifts", "POST", body)]); f.status = rs.map(r => r.status).sort();
        assert.deepEqual(f.status, [201, 409]); assert.equal(await p.shiftClose.count({ where: { date: d, shift: "close" } }), 1); return;
      }
      const c = await ok("/shifts", "POST", body); f.dif = [c.difference, c.bankDifference];
      if (flags.diffClose) { flags.diffClose = false; assert.deepEqual(f.dif, [700, -300]); L.cashOver = 700; L.bankOff = 300; return; }
      assert.deepEqual(f.dif, [0, 0]);
    });
    if (!results[results.length - 1].ok) break;
  }

  const lastDay = cur;
  setNow(`${addDays(lastDay, 1)}T09:00:00-05:00`); await resign(); cur = addDays(lastDay, 1);
  await check("BP-90", "Fin del período: caja al día, saldos = libro, reportes de todos los meses cerrados = libro", "Día operativo = siguiente; reportes de oct-2026 en adelante iguales al libro; ninguna diferencia inexplicada", async f => {
    f.cur = (await ok("/shifts/current-date")).date; assert.equal(f.cur, cur);
    await assertLedger(f, "final");
    const diffs: any[] = [];
    for (const mo of [...closedMonths].filter(m => m >= "2026-10").sort()) { const m = L.month[mo]; const r = await adm(`/sd/report/${mo}`); const a = [r.sales.orders, r.sales.hourly, r.expenses.total, r.payroll.total], b = [m.orders, m.hourly, m.expenses, m.payroll]; if (JSON.stringify(a) !== JSON.stringify(b)) diffs.push({ mo, sistema: a, libro: b }); }
    f.meses = [...closedMonths].sort(); f.diferencias = diffs; assert.equal(diffs.length, 0);
  });

  await new Promise<void>(r => server.close(() => r())); globalThis.fetch = realFetch; await p.$disconnect();
  const fails = results.filter(r => !r.ok).length;
  fs.writeFileSync(path.join(__dirname, "final-r2-prolongado-b.json"), JSON.stringify({ results, months: L.month, libroFinal: ledgerView() }, null, 2));
  console.log(`TOTAL ${results.length} · OK ${results.length - fails} · FALLAS ${fails}`);
  process.exit(fails ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
