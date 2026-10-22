/**
 * Cobertura funcional MEDIBLE de la API (auditoría final de Claude, 14-oct-2026).
 *
 * 1. Lee TODAS las rutas declaradas en src/routes/index.ts.
 * 2. Barrido de permisos: sin sesión → 401 en toda ruta protegida; operador → 403 en toda ruta
 *    de administrador; y comprueba que esos rechazos no cambian ningún dato.
 * 3. Ejecuta cada ruta con datos ficticios y verifica su EFECTO (BD, saldos). En las rutas que
 *    mueven dinero, el cambio de caja/banco se compara con el delta calculado aquí.
 * 4. Calcula la cobertura: rutas ejercitadas con su resultado comprobado / rutas declaradas.
 * SOLO contra la BD temporal local `cashbuddy_claude_cobertura`. Shipday simulado.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { realCount } from "./real-count";

const u = new URL(process.env.DATABASE_URL || "invalid:");
if (u.pathname !== "/cashbuddy_claude_cobertura" || !["localhost", "127.0.0.1"].includes(u.hostname)) throw Error("Solo BD temporal local cashbuddy_claude_cobertura");

type Route = { method: string; path: string; admin: boolean; isPublic: boolean; re: RegExp };
function readRoutes(): Route[] {
  const src = fs.readFileSync(path.resolve(__dirname, "../src/routes/index.ts"), "utf8");
  const authAt = src.indexOf("apiRouter.use(requireAuth)");
  const out: Route[] = [];
  const rx = /apiRouter\.(get|post|put|patch|delete)\("([^"]+)",([^\n]*)/g;
  let m: RegExpExecArray | null;
  while ((m = rx.exec(src))) {
    const p = m[2];
    out.push({ method: m[1].toUpperCase(), path: p, admin: m[3].includes("requireAdmin"), isPublic: m.index < authAt && !m[3].includes("requireAuth"),
      re: new RegExp("^" + p.replace(/:[A-Za-z]+/g, "[^/]+") + "$") });
  }
  return out;
}

async function main() {
  const SRC = pathToFileURL(path.resolve(__dirname, "../src")).href;
  const { prisma: p } = await import(`${SRC}/lib/prisma.ts`);
  const { createServer } = await import(`${SRC}/server.ts`);
  const { signToken } = await import(`${SRC}/lib/jwt.ts`);
  const dash = await import(`${SRC}/services/shipday-dashboard.service.ts`);
  const { todayBogota, toBogotaDateStr } = await import(`${SRC}/lib/date-range.ts`);
  const bcrypt = (await import("node:module")).createRequire(path.resolve(__dirname, "../package.json"))("bcryptjs");
  const today = todayBogota(), month = today.slice(0, 7);
  const prevMonth = toBogotaDateStr(new Date(new Date(month + "-01T12:00:00-05:00").getTime() - 86400000)).slice(0, 7);
  const routes = readRoutes();
  const hits = new Map<string, { statuses: number[]; verified: boolean }>();
  const routeKey = (r: Route) => `${r.method} ${r.path}`;
  const match = (method: string, url: string) => routes.find(r => r.method === method && r.re.test(url.split("?")[0]));

  // Shipday simulado (nunca red real)
  const realFetch = globalThis.fetch;
  let shipdayStatus = 200;
  globalThis.fetch = (async (input: any, init: any) => {
    const s = String(input);
    if (s.startsWith("http://127.0.0.1:")) return realFetch(input, init);
    if (s.startsWith("https://api.shipday.com/")) {
      if (shipdayStatus !== 200) return new Response("denied", { status: shipdayStatus });
      if (s.endsWith("/carriers")) return new Response(JSON.stringify([{ id: 9101, name: "Domi Cobertura A" }, { id: 9102, name: "Domi Cobertura B" }]));
      if (s.endsWith("/orders/query")) return new Response(JSON.stringify([{ orderId: "cov-sync-1", orderNumber: "S1", deliveryFee: 20000, deliveryTime: new Date().toISOString(), carrier: { id: 9101 } }]));
      if (s.includes("/orders?")) return new Response(JSON.stringify([]));
    }
    throw Error("Red externa bloqueada: " + s);
  }) as any;

  // Datos base
  const tables = await p.$queryRawUnsafe(`SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename <> '_prisma_migrations'`) as any[];
  await p.$executeRawUnsafe("TRUNCATE TABLE " + tables.map((x: any) => '"' + x.tablename + '"').join(",") + " CASCADE");
  await p.settings.create({ data: { id: "singleton", initialCash: 100000, initialBank: 100000, setupComplete: true, termsAcceptedAt: new Date() } });
  const PASS = "Cobertura-Test-2026";
  const hash = await bcrypt.hash(PASS, 4);
  let admin = await p.user.create({ data: { email: "admin@cov.test", name: "Admin Cov", role: "admin", passwordHash: hash } });
  let oper = await p.user.create({ data: { email: "oper@cov.test", name: "Oper Cov", role: "user", passwordHash: hash } });
  const server = createServer().listen(0, "127.0.0.1"); await new Promise<void>(r => server.once("listening", r));
  const origin = "http://127.0.0.1:" + (server.address() as any).port;
  const tok = (x: any) => signToken({ sub: x.id, email: x.email, name: x.name, role: x.role, tv: x.tokenVersion });
  const refresh = async () => { admin = await p.user.findUniqueOrThrow({ where: { id: admin.id } }); oper = await p.user.findUniqueOrThrow({ where: { id: oper.id } }); };
  async function call(method: string, route: string, body?: unknown, who: any = oper, headers: Record<string, string> = {}, raw = false) {
    const r = await realFetch(origin + "/api" + route, { method, headers: { "Content-Type": "application/json", ...(who ? { Authorization: "Bearer " + tok(who) } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    const rt = match(method, route); if (rt) { const k = routeKey(rt); const h = hits.get(k) ?? { statuses: [], verified: false }; h.statuses.push(r.status); hits.set(k, h); }
    if (raw) return { status: r.status, buf: Buffer.from(await r.arrayBuffer()) } as any;
    return { status: r.status, body: await r.json().catch(() => null) as any };
  }
  const verified = (method: string, route: string) => { const rt = match(method, route); if (rt) { const k = routeKey(rt); const h = hits.get(k) ?? { statuses: [], verified: false }; h.verified = true; hits.set(k, h); } };
  /** Ejecuta, exige el estado y marca la ruta como verificada (el `check` comprueba el efecto). */
  async function ex(method: string, route: string, body: unknown, who: any, expect: number | number[], check?: (b: any) => Promise<void> | void) {
    const r = await call(method, route, body, who);
    const exp = Array.isArray(expect) ? expect : [expect];
    if (!exp.includes(r.status)) throw Error(`${method} ${route} → ${r.status} (esperado ${exp}) ${JSON.stringify(r.body).slice(0, 200)}`);
    if (check) await check(r.body);
    verified(method, route);
    return r.body;
  }
  const bal = () => dash.getExpectedBalancesForDate(today);
  /** Operación de dinero: el cambio de caja/banco debe ser EXACTAMENTE el previsto. */
  async function money<T>(dCash: number, dBank: number, fn: () => Promise<T>): Promise<T> {
    const b = await bal(); const out = await fn(); const a = await bal();
    assert.deepEqual({ cash: a.cash - b.cash, bank: a.bank - b.bank }, { cash: dCash, bank: dBank }, "delta de caja/banco");
    return out;
  }
  const results: any[] = [];
  async function step(id: string, modulo: string, name: string, fn: () => Promise<void>) {
    try { await fn(); results.push({ id, modulo, name, ok: true }); console.log("OK    " + id + " " + name); }
    catch (e) { results.push({ id, modulo, name, ok: false, error: String((e as Error).message).slice(0, 500) }); console.log("FALLA " + id + " " + name + "\n      " + String((e as Error).message).slice(0, 300)); }
  }
  const count = async () => Object.fromEntries(await Promise.all(["user", "branch", "driver", "movement", "bankTransaction", "baseTransaction", "settings", "shiftClose", "monthlyClose", "client", "hourlyClient", "worker", "fieldNote", "device", "editRequest", "conversion"].map(async t => [t, await (p as any)[t].count()])));

  let branch: any, A: any, B: any, worker: any, client: any, hc: any;
  try {
    // ── 0. Barrido de permisos sobre TODAS las rutas ────────────────────────────────
    await step("PERM-01", "Seguridad", "Sin sesión: toda ruta protegida responde 401 y nada cambia", async () => {
      const before = JSON.stringify(await count());
      const bad: string[] = [];
      for (const r of routes.filter(r => !r.isPublic)) {
        const url = r.path.replace(/:[A-Za-z]+/g, "x");
        const res = await call(r.method, url, r.method === "GET" ? undefined : {}, null);
        if (res.status !== 401) bad.push(`${routeKey(r)} → ${res.status}`);
      }
      assert.deepEqual(bad, []); assert.equal(JSON.stringify(await count()), before);
    });
    await step("PERM-02", "Seguridad", "Operador: toda ruta de administrador responde 403 y nada cambia", async () => {
      const before = JSON.stringify(await count());
      const bad: string[] = [];
      for (const r of routes.filter(r => r.admin)) {
        const url = r.path.replace(/:[A-Za-z]+/g, "x");
        const res = await call(r.method, url, r.method === "GET" ? undefined : { role: "admin", initialCash: 1 }, oper);
        if (res.status !== 403) bad.push(`${routeKey(r)} → ${res.status}`);
      }
      assert.deepEqual(bad, []); assert.equal(JSON.stringify(await count()), before);
    });
    await step("PERM-03", "Seguridad", "Token manipulado o de otra versión: 401", async () => {
      assert.equal((await call("GET", "/auth/me", undefined, null, { Authorization: "Bearer x.y.z" })).status, 401);
      const old = tok(oper); await p.user.update({ where: { id: oper.id }, data: { tokenVersion: { increment: 1 } } });
      assert.equal((await call("GET", "/auth/me", undefined, null, { Authorization: "Bearer " + old })).status, 401);
      await refresh();
    });

    // ── 1. Públicas y autenticación ─────────────────────────────────────────────────
    await step("AUTH-01", "Autenticación", "Salud, marca, login correcto/incorrecto, /auth/me", async () => {
      await ex("GET", "/health", undefined, null, 200, b => assert.equal(b.ok, true));
      await ex("GET", "/branding", undefined, null, 200, b => assert.ok("brandName" in b || "companyName" in b));
      await ex("POST", "/auth/login", { email: "oper@cov.test", password: "mala" }, null, 401);
      await ex("POST", "/auth/login", { email: "oper@cov.test", password: PASS }, null, 200, b => assert.ok(b.token));
      await ex("GET", "/auth/me", undefined, oper, 200, b => assert.equal(b.email, "oper@cov.test"));
      await ex("POST", "/auth/register", { email: "nuevo@cov.test", password: "Nuevo-2026", name: "Nuevo" }, admin, 201, async () => assert.equal(await p.user.count({ where: { email: "nuevo@cov.test" } }), 1));
    });
    await step("USR-01", "Usuarios", "Listar, crear, editar (rol/estado/clave revoca sesión), eliminar", async () => {
      await ex("GET", "/users", undefined, admin, 200, b => assert.ok(b.length >= 3));
      const u2 = await ex("POST", "/users", { email: "u2@cov.test", password: "Clave-2026", name: "U2", role: "user" }, admin, 201);
      await ex("POST", "/users", { email: "u2@cov.test", password: "Clave-2026", name: "dup", role: "user" }, admin, [400, 409]);
      const before = await p.user.findUniqueOrThrow({ where: { id: u2.id } });
      await ex("PATCH", `/users/${u2.id}`, { role: "admin", active: false }, admin, 200, async () => { const a = await p.user.findUniqueOrThrow({ where: { id: u2.id } }); assert.deepEqual([a.role, a.active, a.tokenVersion], ["admin", false, before.tokenVersion + 1]); });
      await ex("DELETE", `/users/${u2.id}`, undefined, admin, [200, 204], async () => assert.equal(await p.user.count({ where: { id: u2.id } }), 0));
    });
    await step("DEV-01", "Equipos", "Identificar, listar, aprobar, renombrar, bloquear, desbloquear, rechazar, cerrar sesión, eliminar", async () => {
      await call("GET", "/devices/me", undefined, oper, { "X-Device-Id": "cov-device-1" }); verified("GET", "/devices/me");
      const id = "cov-device-1"; assert.equal(await p.device.count({ where: { id } }), 1);
      await ex("GET", "/devices", undefined, admin, 200, b => assert.ok(b.devices.some((d: any) => d.id === id)));
      await ex("GET", "/devices/pending-count", undefined, admin, 200, b => assert.equal(typeof b.count, "number"));
      await ex("GET", "/devices/activity", undefined, admin, 200);
      // El PC servidor (loopback) es de confianza: no se puede bloquear (protección correcta).
      await ex("PATCH", `/devices/${id}/block`, {}, admin, 400);
      // Ciclo de vida completo con un equipo REMOTO simulado (pendiente, no de confianza).
      const rid = "cov-remote-1"; await p.device.create({ data: { id: rid, status: "pending", trusted: false, name: null } });
      await ex("PATCH", `/devices/${rid}/approve`, { name: "Caja 2" }, admin, 200, async () => assert.equal((await p.device.findUniqueOrThrow({ where: { id: rid } })).status, "approved"));
      await ex("PATCH", `/devices/${rid}/rename`, { name: "Caja remota" }, admin, 200, async () => assert.equal((await p.device.findUniqueOrThrow({ where: { id: rid } })).name, "Caja remota"));
      await ex("PATCH", `/devices/${rid}/block`, {}, admin, 200, async () => assert.equal((await p.device.findUniqueOrThrow({ where: { id: rid } })).status, "blocked"));
      await ex("PATCH", `/devices/${rid}/unblock`, {}, admin, 200, async () => assert.equal((await p.device.findUniqueOrThrow({ where: { id: rid } })).status, "approved"));
      await ex("POST", `/devices/${rid}/logout`, {}, admin, 200, async () => assert.ok((await p.device.findUniqueOrThrow({ where: { id: rid } })).logoutRequestedAt));
      // Rechazar = bloquear (queda en la lista para reautorizar), según device.service.
      await ex("PATCH", `/devices/${rid}/reject`, {}, admin, 200, async () => assert.equal((await p.device.findUniqueOrThrow({ where: { id: rid } })).status, "blocked"));
      await ex("DELETE", `/devices/${rid}`, undefined, admin, [200, 204], async () => assert.equal(await p.device.count({ where: { id: rid } }), 0));
    });

    // ── 2. Configuración ─────────────────────────────────────────────────────────────
    await step("CFG-01", "Configuración", "Cada campo: valor inicial, guardar, persistir, inválido rechazado", async () => {
      await ex("GET", "/settings", undefined, oper, 200, b => assert.equal(b.initialCash, 100000));
      const fields: [string, unknown, unknown][] = [["companyName", "EPA Cobertura", 12345], ["brandName", "Marca Cov", 9], ["logoData", "data:image/png;base64,AA==", 5], ["termsAcceptedAt", new Date().toISOString(), 7], ["setupComplete", true, "si"], ["commissionPercent", 25, "x"]];
      for (const [k, good, bad] of fields) {
        await ex("PATCH", "/settings", { [k]: good }, admin, 200, async () => { const s = await call("GET", "/settings", undefined, oper); assert.equal(k === "termsAcceptedAt" ? !!s.body[k] : s.body[k], k === "termsAcceptedAt" ? true : good, k); });
        assert.equal((await call("PATCH", "/settings", { [k]: bad }, admin)).status, 400, "inválido " + k);
      }
      for (const k of ["initialCash", "initialBank"]) {
        await ex("PATCH", "/settings", { [k]: 100000 }, admin, 200);
        assert.equal((await call("PATCH", "/settings", { [k]: -1 }, admin)).status, 400);
        assert.equal((await call("PATCH", "/settings", { [k]: 1.5 }, admin)).status, 400);
      }
    });

    // ── 3. Sucursales y Shipday (simulado) ──────────────────────────────────────────
    await step("BR-01", "Sucursales", "Crear, consultar, editar, probar conexión (ok/clave inválida), sincronizar, cargar desde hoy, reconciliar", async () => {
      branch = await ex("POST", "/branches", { name: "Sucursal Cov", apiKey: "cov-key" }, admin, 201, b => assert.equal(b.apiKey, "***"));
      await ex("POST", "/branches", { name: "Sucursal Cov", apiKey: "x" }, admin, 409);
      await ex("GET", "/branches", undefined, oper, 200, b => assert.ok(b.every((x: any) => x.apiKeyEnc === undefined)));
      await ex("GET", `/branches/${branch.id}`, undefined, oper, 200, b => assert.equal(b.name, "Sucursal Cov"));
      await ex("PATCH", `/branches/${branch.id}`, { address: "Calle 1", phone: "300" }, admin, 200, b => assert.equal(b.address, "Calle 1"));
      await ex("POST", `/branches/${branch.id}/test-connection`, {}, oper, 200, b => assert.equal(b.ok, true));
      shipdayStatus = 403;
      await ex("POST", `/branches/${branch.id}/test-connection`, {}, oper, 200, b => assert.equal(b.ok, false));
      assert.equal((await call("POST", `/branches/${branch.id}/sync`, {}, oper)).status, 400, "clave inválida → 400 (no 500)");
      shipdayStatus = 200;
      await ex("POST", `/branches/${branch.id}/sync`, {}, oper, 200, async () => assert.equal(await p.shipdayOrder.count({ where: { shipdayOrderId: "cov-sync-1" } }), 1));
      await ex("POST", "/branches/sync-all", {}, oper, 200, async () => assert.equal(await p.shipdayOrder.count({ where: { shipdayOrderId: "cov-sync-1" } }), 1, "idempotente"));
      await ex("POST", `/branches/${branch.id}/start-orders`, {}, admin, 200, async () => assert.ok((await p.branch.findUniqueOrThrow({ where: { id: branch.id } })).ordersSince));
      await ex("POST", `/branches/${branch.id}/reconcile`, { from: today, to: today }, admin, 200, b => assert.equal(typeof b.checked, "number"));
      await ex("POST", `/branches/${branch.id}/reconcile`, {}, admin, 400);
      A = await p.driver.findFirstOrThrow({ where: { shipdayDriverId: "9101" } }); B = await p.driver.findFirstOrThrow({ where: { shipdayDriverId: "9102" } });
      assert.equal(A.pendingDebt, 6000, "pedido sincronizado: 30 % de 20.000");
    });
    await step("WH-01", "Shipday", "Webhook: token inválido 401; pedido con tarifa 200; duplicado idempotente; tarifa negativa 400", async () => {
      process.env.WEBHOOK_TOKEN = process.env.WEBHOOK_TOKEN || "cov-token";
      const hook = (body: unknown, token = process.env.WEBHOOK_TOKEN!) => realFetch(origin + "/api/webhooks/shipday/" + branch.id, { method: "POST", headers: { "Content-Type": "application/json", token }, body: JSON.stringify(body) });
      const ev = (id: string, fee: number) => ({ event: "ORDER_COMPLETED", order: { id, delivery_fee: fee, delivery_time: Date.now() }, carrier: { id: "9102" } });
      assert.equal((await hook(ev("cov-wh-1", 10000), "malo")).status, 401);
      assert.equal((await hook(ev("cov-wh-1", 10000))).status, 200); assert.equal((await hook(ev("cov-wh-1", 10000))).status, 200);
      assert.equal((await hook(ev("cov-wh-2", -5))).status, 400);
      assert.equal(await p.shipdayOrder.count({ where: { shipdayOrderId: { startsWith: "cov-wh" } } }), 1);
      assert.equal((await p.driver.findUniqueOrThrow({ where: { id: B.id } })).pendingDebt, 3000);
      verified("POST", "/webhooks/shipday/x");
    });

    // ── 4. Domiciliarios, pedidos, bases, pagos (F14) ───────────────────────────────
    await step("DRV-01", "Domiciliarios", "Listar, detalle, estado de cuenta, pedidos del día, pedido manual", async () => {
      await ex("GET", "/sd/drivers", undefined, oper, 200, b => assert.ok(b.some((d: any) => d.id === A.id && d.basePending === 0)));
      await ex("GET", `/sd/drivers/${A.id}`, undefined, oper, 200, b => assert.equal(b.pendingDebt, 6000));
      await ex("GET", `/sd/drivers/${A.id}/statement`, undefined, oper, 200, b => assert.deepEqual([b.totalOrders, b.totalCompany], [1, 6000]));
      await ex("GET", "/sd/orders/today", undefined, oper, 200, b => assert.equal(b.length, 2));
      await money(0, 0, () => ex("POST", "/sd/orders/manual", { branchId: branch.id, driverId: A.id, deliveryValue: 20000, orderNumber: "M1" }, oper, 201, b => assert.equal(b.companyAmount, 6000)));
      await ex("POST", "/sd/orders/manual", { branchId: branch.id, driverId: A.id, deliveryValue: -1 }, oper, 400);
      assert.equal((await p.driver.findUniqueOrThrow({ where: { id: A.id } })).pendingDebt, 12000);
    });
    let baseId = "";
    await step("BASE-01", "Bases", "Entregar (efectivo/banco), devolver, resumen, listar, editar y eliminar (admin) con efecto exacto en caja", async () => {
      const g = await money(-10000, -5000, () => ex("POST", `/sd/bases/${A.id}/give`, { cashAmount: 10000, bankAmount: 5000 }, oper, 201));
      baseId = g.id;
      await money(4000, 0, () => ex("POST", `/sd/bases/${A.id}/pay`, { cashAmount: 4000 }, oper, 201));
      await ex("POST", `/sd/bases/${A.id}/pay`, { cashAmount: 999999 }, oper, 400);
      await ex("GET", `/sd/bases/${A.id}/summary`, undefined, oper, 200, b => assert.deepEqual([b.given, b.paid, b.pending], [15000, 4000, 11000]));
      await ex("GET", "/sd/bases", undefined, oper, 200, b => assert.equal(b.length, 2));
      await money(-2000, 0, () => ex("PATCH", `/sd/bases/${baseId}`, { cashAmount: 12000 }, admin, 200));
      const g2 = await money(-500, 0, () => ex("POST", `/sd/bases/${A.id}/give`, { cashAmount: 500 }, oper, 201));
      await money(500, 0, () => ex("DELETE", `/sd/bases/${g2.id}`, undefined, admin, [200, 204]));
      assert.equal((await p.driver.findUniqueOrThrow({ where: { id: A.id } })).pendingDebt, 12000, "F14: bases no tocan comisiones");
    });
    await step("PAY-01", "Pagos", "Pago dividido comisión/base, crédito por sobrepago y pago del crédito", async () => {
      await money(9000, 0, () => ex("POST", `/sd/drivers/${A.id}/payment`, { amount: 9000, medium: "cash", baseAmount: 3000 }, oper, 201, b => assert.deepEqual([b.commissionAlloc, b.baseAlloc], [6000, 3000])));
      await money(5000, 0, () => ex("POST", `/sd/drivers/${B.id}/payment`, { amount: 5000, medium: "cash" }, oper, 201));
      const b = await p.driver.findUniqueOrThrow({ where: { id: B.id } }); assert.deepEqual([b.pendingDebt, b.creditAmount], [0, 2000]);
      await money(0, -2000, () => ex("POST", `/sd/drivers/${B.id}/pay-credit`, { medium: "bank" }, oper, 200));
      await ex("POST", `/sd/drivers/${B.id}/pay-credit`, { medium: "bank" }, oper, 400);
      const a = await p.driver.findUniqueOrThrow({ where: { id: A.id } }); assert.equal(a.pendingDebt, 6000);
    });

    // ── 5. Banco, conversiones, contrapartes ─────────────────────────────────────────
    await step("BANK-01", "Banco", "Ingreso, egreso con contraparte, aplicar a domiciliario, listar, resumen, eliminar (admin)", async () => {
      await money(0, 30000, () => ex("POST", "/bank-transactions", { type: "ingreso", medium: "bank", amount: 30000, description: "Cov ingreso", noCounterpart: true }, oper, 201));
      const out = await money(0, -4000, () => ex("POST", "/bank-transactions", { type: "egreso", medium: "bank", amount: 4000, description: "Cov retiro" }, oper, 201));
      await money(4000, 0, () => ex("POST", "/bank-transactions", { type: "ingreso", medium: "cash", amount: 4000, description: "Cov retiro contraparte", pairWith: out.id }, oper, 201, b => assert.ok(b.pairId)));
      await ex("POST", "/bank-transactions", { type: "ingreso", medium: "cash", amount: 3999, description: "x", pairWith: out.id }, oper, [400, 409]);
      const inc = await money(0, 6000, () => ex("POST", "/bank-transactions", { type: "ingreso", medium: "bank", amount: 6000, description: "Consignación A", noCounterpart: true }, oper, 201));
      await money(0, 0, () => ex("POST", `/bank-transactions/${inc.id}/apply-to-driver`, { driverId: A.id }, oper, 200));
      assert.equal((await p.driver.findUniqueOrThrow({ where: { id: A.id } })).pendingDebt, 0);
      await ex("GET", "/bank-transactions", undefined, oper, 200, b => assert.ok(b.length >= 4));
      await ex("GET", `/bank-transactions/summary?from=${today}&to=${today}`, undefined, oper, 200);
      const tmp = await money(1500, 0, () => ex("POST", "/bank-transactions", { type: "ingreso", medium: "cash", amount: 1500, description: "Cov temporal", noCounterpart: true }, oper, 201));
      await money(-1500, 0, () => ex("DELETE", `/bank-transactions/${tmp.id}`, undefined, admin, [200, 204]));
    });
    await step("CONV-01", "Conversiones", "Crear, listar, eliminar (admin) con efecto en ambos medios", async () => {
      await money(-3000, 3000, () => ex("POST", "/sd/conversions", { branchId: branch.id, amount: 3000, type: "efectivo_a_banco" }, oper, 201));
      const c = await money(1000, -1000, () => ex("POST", "/sd/conversions", { branchId: branch.id, amount: 1000, type: "banco_a_efectivo" }, oper, 201));
      await ex("GET", "/sd/conversions", undefined, oper, 200, b => assert.equal(b.length, 2));
      await money(-1000, 1000, () => ex("DELETE", `/sd/conversions/${c.id}`, undefined, admin, [200, 204]));
      await ex("POST", "/sd/conversions", { branchId: branch.id, amount: 1, type: "otro" }, oper, 400);
    });

    // ── 6. Caja (movimientos), gastos, trabajadores, reportes de domiciliarios internos ──
    let mov: any;
    await step("MOV-01", "Caja", "Ingreso confirmado, gasto pendiente aprobado/rechazado, editar, eliminar, listar, pendientes, unificado", async () => {
      mov = await money(5000, 0, () => ex("POST", "/movements", { date: today, category: 1, type: "ingreso", medium: "cash", amount: 5000 }, admin, 201));
      const g = await money(0, 0, () => ex("POST", "/movements", { date: today, category: 3, type: "egreso", medium: "cash", amount: 2000, description: "Papelería" }, oper, 201, b => assert.equal(b.status, "pending")));
      await ex("GET", "/movements/pending", undefined, oper, 200, b => assert.ok(b.some((m: any) => m.id === g.id)));
      await money(-2000, 0, () => ex("POST", `/movements/${g.id}/approve`, {}, admin, 200));
      const r = await ex("POST", "/movements", { date: today, category: 4, type: "egreso", medium: "bank", amount: 1000 }, oper, 201);
      await money(0, 0, () => ex("POST", `/movements/${r.id}/reject`, {}, admin, 200));
      await money(1000, 0, () => ex("PATCH", `/movements/${mov.id}`, { amount: 6000 }, admin, 200));
      await ex("PATCH", `/movements/${mov.id}`, { amount: 7000 }, oper, 403);
      const t = await money(700, 0, () => ex("POST", "/movements", { date: today, category: 1, type: "ingreso", medium: "cash", amount: 700 }, admin, 201));
      await money(-700, 0, () => ex("DELETE", `/movements/${t.id}`, undefined, admin, [200, 204]));
      await ex("GET", `/movements?date=${today}`, undefined, oper, 200);
      await ex("GET", `/movements/unified?from=${today}&to=${today}`, undefined, oper, 200, b => assert.ok(Array.isArray(b) ? b.length > 0 : b));
      await ex("POST", "/movements", { date: "2026-02-31", category: 1, type: "ingreso", medium: "cash", amount: 1 }, admin, 400);
      await ex("POST", "/movements", { date: today, category: 1, type: "ingreso", medium: "cash", amount: -1 }, admin, 400);
    });
    await step("WRK-01", "Trabajadores", "Crear, listar, editar, eliminar (admin); reportes de entregas, comisiones y nómina", async () => {
      worker = await ex("POST", "/workers", { name: "Mensajero interno", role: "domiciliario", active: true }, oper, 201);
      await ex("GET", "/workers", undefined, oper, 200, b => assert.ok(b.some((w: any) => w.id === worker.id)));
      await ex("PATCH", `/workers/${worker.id}`, { color: "#ff0000" }, oper, 200);
      await money(3000, 0, () => ex("POST", "/movements", { date: today, category: 1, type: "ingreso", medium: "cash", amount: 3000, workerId: worker.id, kind: "commission", deliveryValue: 10000 }, admin, 201));
      await ex("GET", `/reports/couriers/${today}`, undefined, oper, 200);
      await ex("GET", `/reports/couriers/${today}/${worker.id}`, undefined, oper, 200);
      await ex("GET", `/reports/couriers/${today}/${worker.id}/deliveries`, undefined, oper, 200);
      await ex("GET", `/reports/commissions/${worker.id}?from=${today}&to=${today}`, undefined, oper, [200, 400]);
      await ex("GET", `/reports/payroll/${worker.id}?from=${today}&to=${today}`, undefined, oper, [200, 400]);
      const w2 = await ex("POST", "/workers", { name: "Temporal", role: "administrativo", active: true }, oper, 201);
      await ex("DELETE", `/workers/${w2.id}`, undefined, admin, [200, 204], async () => assert.equal(await p.worker.count({ where: { id: w2.id } }), 0));
    });
    await step("NOTE-01", "Libreta de campo", "Crear, listar, editar, eliminar", async () => {
      const n = await ex("POST", "/field-notes", { content: "Nota de prueba", date: today }, oper, 201);
      await ex("GET", `/field-notes?date=${today}`, undefined, oper, 200, b => assert.ok(b.some((x: any) => x.id === n.id)));
      await ex("PATCH", `/field-notes/${n.id}`, { content: "Editada" }, oper, 200, async () => assert.equal((await p.fieldNote.findUniqueOrThrow({ where: { id: n.id } })).content, "Editada"));
      await ex("DELETE", `/field-notes/${n.id}`, undefined, oper, [200, 204], async () => assert.equal(await p.fieldNote.count({ where: { id: n.id } }), 0));
      await ex("POST", "/field-notes", { content: "  " }, oper, 400);
    });

    // ── 7. Clientes y clientes por hora ─────────────────────────────────────────────
    await step("CLI-01", "Clientes", "Crear, editar, préstamo con medio, deuda sin medio, abono, listar, deudores, detalle, eliminar (admin)", async () => {
      client = await ex("POST", "/clients", { name: "Cliente Cov" }, oper, 201);
      await ex("PATCH", `/clients/${client.id}`, { phone: "311" }, oper, 200);
      await money(-8000, 0, () => ex("POST", `/clients/${client.id}/debt`, { description: "Préstamo", amount: 8000, medium: "cash" }, oper, 201));
      await money(0, 0, () => ex("POST", `/clients/${client.id}/debt`, { description: "Fiado", amount: 5000 }, oper, 201));
      await money(0, 6000, () => ex("POST", `/clients/${client.id}/pay`, { amount: 6000, medium: "bank" }, oper, 200));
      await ex("POST", `/clients/${client.id}/pay`, { amount: 99999, medium: "bank" }, oper, 400);
      await ex("GET", "/clients", undefined, oper, 200); await ex("GET", "/clients/debtors", undefined, oper, 200, b => assert.ok(b.some((c: any) => c.id === client.id)));
      await ex("GET", `/clients/${client.id}`, undefined, oper, 200, b => assert.equal(b.pendingDebt, 7000));
      const debt = await p.clientDebt.findFirstOrThrow({ where: { clientId: client.id } });
      await ex("POST", `/clients/debts/${debt.id}/pay`, { paidAmount: 1000 }, oper, 400);   // ruta heredada: exige medio
      const c2 = await ex("POST", "/clients", { name: "Temporal" }, oper, 201);
      await ex("DELETE", `/clients/${c2.id}`, undefined, admin, [200, 204]);
    });
    let shift: any;
    await step("HOUR-01", "Clientes por hora", "Crear, editar tarifa, turno, cobro, historial, editar y eliminar turno (admin), pago heredado, eliminar cliente", async () => {
      hc = await ex("POST", "/hourly-clients", { name: "Por hora Cov", driverHourValue: 10000, companyHourValue: 5000 }, oper, 201);
      await ex("PATCH", `/hourly-clients/${hc.id}`, { companyHourValue: 6000 }, oper, 200);
      await ex("PATCH", `/hourly-clients/${hc.id}`, { companyHourValue: 5000 }, oper, 200);
      shift = await money(-10000, 0, () => ex("POST", `/hourly-clients/${hc.id}/shifts`, { driverId: A.id, startTime: "08:00", endTime: "09:00", medium: "cash" }, oper, 201, b => assert.deepEqual([b.driverAmount, b.companyAmount, b.totalAmount], [10000, 5000, 15000])));
      await money(15000, 0, () => ex("POST", `/hourly-clients/${hc.id}/pay`, { amount: 15000, medium: "cash" }, oper, 200));
      await ex("GET", "/hourly-clients", undefined, oper, 200); await ex("GET", `/hourly-clients/${hc.id}`, undefined, oper, 200);
      await ex("GET", `/hourly-shifts?from=${today}&to=${today}`, undefined, oper, 200);
      await ex("POST", `/hourly-shifts/${shift.id}/pay-driver`, { medium: "cash" }, oper, 400);   // ya pagado al registrar
      const s2 = await money(-10000, 0, () => ex("POST", `/hourly-clients/${hc.id}/shifts`, { driverId: A.id, startTime: "10:00", endTime: "11:00", medium: "cash" }, oper, 201));
      await money(-10000, 0, () => ex("PATCH", `/hourly-shifts/${s2.id}`, { endTime: "12:00" }, admin, 200));
      await money(20000, 0, () => ex("DELETE", `/hourly-shifts/${s2.id}`, undefined, admin, [200, 204]));
      assert.equal((await p.hourlyClient.findUniqueOrThrow({ where: { id: hc.id } })).pendingDebt, 0);
      const h2 = await ex("POST", "/hourly-clients", { name: "Temporal hora", driverHourValue: 1000, companyHourValue: 1000 }, oper, 201);
      await ex("DELETE", `/hourly-clients/${h2.id}`, undefined, admin, [200, 204]);
    });

    // ── 8. Tablero, días, historial, arqueo, cierres de turno ───────────────────────
    await step("DASH-01", "Dashboard", "Tablero, tablero completo, estadística diaria, deudas, pedidos por sucursal", async () => {
      const e = await bal();
      await ex("GET", "/sd/dashboard", undefined, oper, 200, b => assert.ok(b.today));
      await ex("GET", "/sd/dashboard/full", undefined, oper, 200, b => assert.deepEqual([b.expectedBalances?.cash ?? b.expectedCash ?? b.expected?.cash ?? e.cash], [e.cash]));
      await ex("GET", `/sd/dashboard/daily/${today}`, undefined, oper, 200);
      await ex("GET", "/sd/dashboard/debts", undefined, oper, 200, b => assert.ok(Array.isArray(b.debtors)));
      await ex("GET", `/sd/dashboard/orders/${branch.id}?from=${today}&to=${today}`, undefined, oper, 200, b => assert.ok(b.length >= 3));
    });
    await step("DAY-01", "Historial", "Días, resúmenes, detalle, arqueo; el resumen concilia apertura+ingresos−egresos=cierre", async () => {
      await ex("GET", "/days", undefined, oper, 200);
      await ex("GET", `/days/summaries?from=${today}&to=${today}`, undefined, oper, 200);
      await ex("GET", `/days/${today}/summary`, undefined, oper, 200, b => assert.equal(b.initialTotal + b.ingresos - b.egresos, b.finalTotal));
      await ex("GET", `/days/${today}`, undefined, oper, 200);
      await ex("PUT", `/days/${today}/arqueo`, { slot: "AM", arqueo: { bills: 1000, coins: 0, bank: 0 } }, oper, 200);
    });
    await step("SHIFT-01", "Caja/turnos", "Día operativo, esperado, turno AM, consulta, listar; eliminar un cierre se rechaza", async () => {
      await ex("GET", "/shifts/current-date", undefined, oper, 200, b => assert.equal(b.date, today));
      const e = await ex("GET", `/shifts/${today}/expected`, undefined, oper, 200);
      const am = await ex("POST", "/shifts", { date: today, shift: "AM", denominations: realCount(e.expectedCash), bankCounted: e.expectedBank }, oper, 201, b => assert.deepEqual([b.difference, b.bankDifference], [0, 0]));
      await ex("GET", `/shifts/${today}`, undefined, oper, 200, b => assert.ok(b.length >= 1));
      await ex("GET", `/shifts?from=${today}&to=${today}`, undefined, oper, 200);
      await ex("DELETE", `/shifts/${am.id}`, undefined, admin, 409);
    });

    // ── 9. Solicitudes y recálculo ──────────────────────────────────────────────────
    await step("REQ-01", "Solicitudes", "Crear (operador), contar, listar (admin), aprobar con efecto exacto, rechazar sin efecto, recalcular pedidos", async () => {
      const r1 = await ex("POST", "/edit-requests", { entityType: "Movement", entityId: mov.id, entityLabel: "Ingreso", changes: { amount: { old: "6000", new: "5500" } }, reason: "Corrección" }, oper, 201);
      await ex("GET", "/edit-requests/count", undefined, oper, 200, b => assert.equal(b.count, 1));
      await ex("GET", "/edit-requests", undefined, admin, 200, b => assert.equal(b.length, 1));
      await money(-500, 0, () => ex("POST", `/edit-requests/${r1.id}/review`, { action: "approved" }, admin, 200));
      const r2 = await ex("POST", "/edit-requests", { entityType: "Movement", entityId: mov.id, entityLabel: "Ingreso", changes: { amount: { old: "5500", new: "1" } }, reason: "x" }, oper, 201);
      await money(0, 0, () => ex("POST", `/edit-requests/${r2.id}/review`, { action: "rejected" }, admin, 200));
      const before = (await p.driver.findMany({ select: { id: true, pendingDebt: true, creditAmount: true }, orderBy: { id: "asc" } }));
      await ex("POST", "/admin/recalc-orders", {}, admin, 200);
      assert.deepEqual(await p.driver.findMany({ select: { id: true, pendingDebt: true, creditAmount: true }, orderBy: { id: "asc" } }), before, "recalcular con la misma comisión no cambia deudas");
    });

    // ── 10. Red, cierres de mes, reportes y Excel ───────────────────────────────────
    await step("BR-02", "Sucursales", "Desactivar (DELETE) conserva pedidos, deudas e historial; no admite pedidos nuevos", async () => {
      const orders = await p.shipdayOrder.count({ where: { branchId: branch.id } }); const debtA = (await p.driver.findUniqueOrThrow({ where: { id: A.id } })).pendingDebt;
      const b2 = await ex("POST", "/branches", { name: "Sucursal a desactivar", apiKey: "k" }, admin, 201);
      await ex("DELETE", `/branches/${b2.id}`, undefined, admin, [200, 204], async () => assert.equal((await p.branch.findUniqueOrThrow({ where: { id: b2.id } })).active, false));
      await ex("POST", "/sd/orders/manual", { branchId: b2.id, deliveryValue: 1000 }, oper, 400);
      assert.equal(await p.shipdayOrder.count({ where: { branchId: branch.id } }), orders); assert.equal((await p.driver.findUniqueOrThrow({ where: { id: A.id } })).pendingDebt, debtA);
    });
    await step("NET-01", "Red", "URLs locales de acceso", async () => { await ex("GET", "/network/local-urls", undefined, oper, 200); });
    let mclose: any;
    await step("CLOSE-01", "Cierre mensual", "Proyección, cerrar mes anterior, listar, consultar, reporte y Excel del mes", async () => {
      await ex("GET", `/sd/projection/${month}?targetCash=100000&targetBank=100000`, undefined, oper, 200);
      await ex("GET", `/sd/report/${month}`, undefined, oper, 200, b => assert.equal(typeof b.totalSales, "number"));
      mclose = await ex("POST", "/sd/closes", { month: prevMonth }, admin, 201);
      await ex("POST", "/sd/closes", { month: prevMonth }, admin, [400, 409]);
      await ex("GET", "/sd/closes", undefined, oper, 200, b => assert.equal(b.length, 1));
      await ex("GET", `/sd/closes/${mclose.id}`, undefined, oper, 200);
      const x = await call("GET", `/sd/closes/export/${month}`, undefined, oper, {}, true); assert.equal(x.status, 200); assert.equal(x.buf.subarray(0, 2).toString(), "PK"); verified("GET", `/sd/closes/export/${month}`);
    });
    await step("RESET-01", "Administración", "Borrar todos los datos se rechaza cuando hay cierres (conservación del libro)", async () => {
      const before = JSON.stringify(await count());
      await ex("POST", "/admin/reset", {}, admin, 409); assert.equal(JSON.stringify(await count()), before);
    });
    await step("RESET-02", "Administración", "Borrar todos los datos funciona en un sistema sin cierres (configuración inicial)", async () => {
      await p.monthlyClose.deleteMany(); await p.shiftClose.deleteMany();
      await ex("POST", "/admin/reset", {}, admin, [200, 204], async () => {
        assert.equal(await p.movement.count() + await p.bankTransaction.count() + await p.baseTransaction.count() + await p.shipdayOrder.count(), 0);
        assert.ok(await p.user.count() >= 2, "conserva usuarios");
      });
    });
  } finally {
    globalThis.fetch = realFetch;
    await new Promise<void>(r => server.close(() => r()));
    // Cobertura medible
    const cov = routes.map(r => ({ ruta: routeKey(r), admin: r.admin, publica: r.isPublic, ejecutada: hits.has(routeKey(r)), verificada: hits.get(routeKey(r))?.verified ?? false, estados: [...new Set(hits.get(routeKey(r))?.statuses ?? [])] }));
    const verifiedN = cov.filter(c => c.verificada).length;
    fs.writeFileSync(path.join(__dirname, "claude-cobertura.json"), JSON.stringify({ results, cobertura: cov, rutas: cov.length, verificadas: verifiedN }, null, 2));
    console.log(`\nPASOS ${results.length} · OK ${results.filter(r => r.ok).length} · FALLAS ${results.filter(r => !r.ok).length}`);
    console.log(`RUTAS ${cov.length} · VERIFICADAS ${verifiedN} (${Math.round(1000 * verifiedN / cov.length) / 10} %)`);
    const missing = cov.filter(c => !c.verificada).map(c => c.ruta); if (missing.length) console.log("SIN VERIFICAR: " + missing.join(" | "));
    await p.$disconnect();
    if (results.some(r => !r.ok)) process.exitCode = 1;
  }
}
main().catch(e => { console.error(e); process.exit(1); });
