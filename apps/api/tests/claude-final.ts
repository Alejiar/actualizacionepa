/**
 * Regresión de las correcciones de Claude (entrega final, oct-2026).
 * SOLO contra una BD local temporal llamada cashbuddy_claude_final, migrada y vacía.
 * Shipday se simula con fetch local; nunca hay llamadas reales.
 */
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";

const DB = process.env.DATABASE_URL ?? "";
const u0 = new URL(DB || "invalid:");
if (u0.pathname !== "/cashbuddy_claude_final" || !["localhost", "127.0.0.1"].includes(u0.hostname)) throw Error("Solo BD temporal local cashbuddy_claude_final");
const QUICK = process.env.QUICK === "1"; // omite la prueba de 2 minutos de la cola colgada

async function main() {
  const SRC = pathToFileURL(path.resolve(__dirname, "../src")).href;
  const { prisma: p, moneyTransaction } = await import(`${SRC}/lib/prisma.ts`);
  const { createServer } = await import(`${SRC}/server.ts`);
  const { signToken } = await import(`${SRC}/lib/jwt.ts`);
  const hourly = await import(`${SRC}/services/hourly-client.service.ts`);
  const close = await import(`${SRC}/services/close.service.ts`);
  const branchSvc = await import(`${SRC}/services/branch.service.ts`);
  const bases = await import(`${SRC}/services/base.service.ts`);
  const { todayBogota } = await import(`${SRC}/lib/date-range.ts`);
  await p.settings.create({ data: { id: "singleton", initialCash: 300000, initialBank: 100000, setupComplete: true, termsAcceptedAt: new Date() } });
  const admin = await p.user.create({ data: { email: "admin@final.invalid", name: "Admin", passwordHash: "x", role: "admin" } });
  const user = await p.user.create({ data: { email: "user@final.invalid", name: "Operador", passwordHash: "x", role: "user" } });
  const today = todayBogota(), month = today.slice(0, 7);
  const realFetch = globalThis.fetch;
  const server = createServer().listen(0, "127.0.0.1"); await new Promise<void>(r => server.once("listening", r));
  const origin = "http://127.0.0.1:" + (server.address() as any).port;
  const tok = (x: any) => signToken({ sub: x.id, email: x.email, name: x.name, role: x.role, tv: x.tokenVersion });
  async function api(route: string, method = "GET", body?: unknown, actor: any = admin, token?: string, raw?: string) {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (actor) headers.Authorization = "Bearer " + (token ?? tok(actor));
    const r = await realFetch(origin + "/api" + route, { method, headers, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
    const t = await r.text(); let b: any = null; try { b = t ? JSON.parse(t) : null; } catch { b = t; }
    return { status: r.status, body: b };
  }
  const hook = (branchId: string, id: string, value: number, carrier: string) => realFetch(`${origin}/api/webhooks/shipday/${branchId}`, {
    method: "POST", headers: { "Content-Type": "application/json", token: "final-token" },
    body: JSON.stringify({ event: "ORDER_COMPLETED", order: { id, order_number: id, delivery_fee: value, delivery_time: Date.now() }, carrier: { id: carrier } }) });
  const results: any[] = [];
  async function check(name: string, fn: () => Promise<void>) {
    try { await fn(); results.push({ name, ok: true }); console.log("OK   " + name); }
    catch (e) { results.push({ name, ok: false, error: String((e as Error).message).slice(0, 300) }); console.log("FALLA " + name + "\n      " + String((e as Error).message).slice(0, 300)); }
  }
  let seq = 0; const uid = (s: string) => `${s}-${++seq}`;

  try {
    await check("Permisos: usuario normal recibe 403 (no 401) en rutas administrativas y nada cambia", async () => {
      const b = await p.branch.create({ data: { name: uid("perm"), apiKeyEnc: "test-only" } });
      const before = JSON.stringify([await p.settings.findUnique({ where: { id: "singleton" } }), await p.user.count(), await p.monthlyClose.count(), await p.branch.findUnique({ where: { id: b.id } })]);
      for (const [route, method, body] of [["/sd/closes", "POST", { month: "2026-06", initialCash: 1 }], ["/settings", "PATCH", { initialCash: 1 }], ["/admin/reset", "POST", {}],
        ["/users", "POST", { email: "x@x.invalid", password: "123456", name: "x", role: "admin" }], [`/users/${admin.id}`, "PATCH", { role: "user" }],
        [`/branches/${b.id}`, "DELETE", undefined], [`/branches/${b.id}`, "PATCH", { active: false }], ["/auth/register", "POST", { email: "r@x.invalid", password: "123456", name: "r" }]] as const) {
        const r = await api(route, method, body, user); assert.equal(r.status, 403, route + " " + JSON.stringify(r));
      }
      assert.equal(JSON.stringify([await p.settings.findUnique({ where: { id: "singleton" } }), await p.user.count(), await p.monthlyClose.count(), await p.branch.findUnique({ where: { id: b.id } })]), before);
      assert.equal((await api("/sd/closes", "POST", { month: "2026-06" }, null)).status, 401);
    });
    await check("Permisos: admin degradado y desactivado pierde privilegios de inmediato (token anterior)", async () => {
      const ex = await p.user.create({ data: { email: uid("ex") + "@x.invalid", name: "Ex", passwordHash: "x", role: "admin" } });
      const old = tok(ex); await new Promise(r => setTimeout(r, 1100));
      // Degradación por el camino real (PATCH /users/:id, que incrementa tokenVersion). Un
      // UPDATE directo a la BD no pasa por la aplicación: aun así el rol se lee de la BD en
      // cada petición: el token anterior pierde el privilegio (403) aunque no se revoque.
      const raw = await p.user.create({ data: { email: uid("raw") + "@x.invalid", name: "Raw", passwordHash: "x", role: "admin" } });
      const rawTok = tok(raw); await p.user.update({ where: { id: raw.id }, data: { role: "user" } });
      assert.equal((await api("/settings", "PATCH", { initialCash: 777 }, raw, rawTok)).status, 403);
      assert.equal((await api(`/users/${ex.id}`, "PATCH", { role: "user" })).status, 200);
      const r1 = await api("/settings", "PATCH", { initialCash: 777 }, ex, old);
      assert.equal(r1.status, 401, JSON.stringify(r1));
      const now = await p.user.findUniqueOrThrow({ where: { id: ex.id } });
      const fresh = tok({ ...now, role: "admin" }); // sesión vigente que dice "admin": manda la BD
      assert.equal((await api("/settings", "PATCH", { initialCash: 777 }, ex, fresh)).status, 403);
      await p.user.update({ where: { id: ex.id }, data: { active: false } });
      assert.equal((await api("/sd/dashboard", "GET", undefined, ex, tok(ex))).status, 401);
      assert.equal((await p.settings.findUniqueOrThrow({ where: { id: "singleton" } })).initialCash, 300000);
    });
    await check("Permisos: cambio de contraseña invalida sesiones previas", async () => {
      const x = await p.user.create({ data: { email: uid("pw") + "@x.invalid", name: "Pw", passwordHash: "x", role: "user" } });
      const old = tok(x); await new Promise(r => setTimeout(r, 1100));
      assert.equal((await api(`/users/${x.id}`, "PATCH", { password: "nueva-clave-1" })).status, 200);
      assert.equal((await api("/sd/dashboard", "GET", undefined, x, old)).status, 401);
    });
    await check("Datos sensibles: la lista de sucursales no expone la API key cifrada", async () => {
      const r = await api("/branches", "GET", undefined, user);
      assert.equal(r.status, 200); assert.ok(r.body.length > 0); assert.ok(r.body.every((b: any) => b.apiKeyEnc === undefined && b.apiKey === "***"));
    });
    await check("Movimientos: usuario no corrige un confirmado de ninguna categoría; pendiente de cobro sí", async () => {
      const nom = await api("/movements", "POST", { date: today, category: 15, type: "egreso", medium: "cash", amount: 50000, description: "Nómina" }, admin);
      assert.equal(nom.status, 201);
      assert.equal((await api(`/movements/${nom.body.id}`, "PATCH", { amount: 1 }, user)).status, 403);
      assert.equal((await p.movement.findUniqueOrThrow({ where: { id: nom.body.id } })).amount, 50000);
      const pend = await api("/movements", "POST", { date: today, category: 1, type: "ingreso", medium: "cash", amount: 30000, status: "pending" }, user);
      assert.equal((await api(`/movements/${pend.body.id}`, "PATCH", { status: "confirmed", medium: "bank", category: 2 }, user)).status, 200);
      assert.equal((await api(`/movements/${pend.body.id}`, "PATCH", { amount: 1 }, user)).status, 403);
    });
    await check("Clientes: entradas inválidas de deuda dan 400/404 (nunca 500) y fecha futura se rechaza", async () => {
      const c = await p.client.create({ data: { name: uid("cli") } });
      const fut = new Date(today + "T12:00:00-05:00"); fut.setDate(fut.getDate() + 2);
      const futStr = fut.toLocaleDateString("en-CA", { timeZone: "America/Bogota" });
      const cases: [unknown, number][] = [[{ amount: 1000 }, 400], [{ description: "x", amount: 1000, date: "2026-02-31" }, 400], [{ description: "x", amount: 1000, date: "ayer" }, 400],
        [{ description: "x", amount: 1000, date: futStr, medium: "cash" }, 400], [{ description: "  ", amount: 1000 }, 400]];
      for (const [body, st] of cases) assert.equal((await api(`/clients/${c.id}/debt`, "POST", body, user)).status, st, JSON.stringify(body));
      assert.equal((await api(`/clients/no-existe/debt`, "POST", { description: "x", amount: 1000 }, user)).status, 404);
      assert.equal(await p.clientDebt.count({ where: { clientId: c.id } }), 0);
      const ok = await api(`/clients/${c.id}/debt`, "POST", { description: "Préstamo ayer", amount: 1000, date: "2026-01-15", medium: "cash" }, user);
      assert.equal(ok.status, 201);
      assert.equal((await p.client.findUniqueOrThrow({ where: { id: c.id } })).pendingDebt, 1000);
    });
    await check("Errores: JSON mal formado da 400 y un 500 no expone detalles internos", async () => {
      const r = await api("/clients", "POST", undefined, user, undefined, "{malformado");
      assert.equal(r.status, 400);
      const e = await api("/movements", "POST", { date: "2026-13-99", category: 1, type: "ingreso", medium: "cash", amount: 1000 }, user);
      assert.ok(e.status < 500 || e.body?.error === "Error interno del servidor", JSON.stringify(e));
      assert.ok(!JSON.stringify(e.body).includes("prisma"), JSON.stringify(e.body));
    });
    await check("Clientes por hora: sobrepago rechazado; eliminar con turnos desactiva y conserva todo", async () => {
      const b = await p.branch.create({ data: { name: uid("hb"), apiKeyEnc: "test-only" } });
      const d = await p.driver.create({ data: { name: uid("hd"), shipdayDriverId: uid("s"), branchId: b.id } });
      const hc = await hourly.createHourlyClient({ name: uid("hc"), driverHourValue: 12000, companyHourValue: 8000 });
      const s = await hourly.registerShift(hc.id, { driverId: d.id, startTime: "08:00", endTime: "10:00", medium: "cash" });
      await assert.rejects(() => hourly.payClient(hc.id, { amount: 90000, medium: "cash" }), /sobrepago/);
      await assert.rejects(() => hourly.payClient(hc.id, { amount: 1.5, medium: "cash" }));
      await hourly.payClient(hc.id, { amount: 10000, medium: "bank" });
      const rep0 = (await close.getMonthlyReport(month)).clientDebt.hourly;
      const del = await api(`/hourly-clients/${hc.id}`, "DELETE", undefined, admin);
      assert.ok(del.status < 300, JSON.stringify(del));
      const after = await p.hourlyClient.findUniqueOrThrow({ where: { id: hc.id } });
      assert.equal(after.active, false); assert.equal(after.pendingDebt, 30000);
      assert.equal(await p.hourlyShift.count({ where: { id: s.id } }), 1);
      assert.equal((await close.getMonthlyReport(month)).clientDebt.hourly, rep0);
      const empty = await hourly.createHourlyClient({ name: uid("hc0"), driverHourValue: 1000, companyHourValue: 1000 });
      await api(`/hourly-clients/${empty.id}`, "DELETE", undefined, admin);
      assert.equal(await p.hourlyClient.count({ where: { id: empty.id } }), 0);
    });
    await check("Webhook: 20 entregas válidas simultáneas se procesan todas (sin 503)", async () => {
      const b = await p.branch.create({ data: { name: uid("wb"), apiKeyEnc: "test-only" } });
      const d = await p.driver.create({ data: { name: uid("wd"), shipdayDriverId: "9100", branchId: b.id } });
      const ids = Array.from({ length: 20 }, () => uid("w"));
      const st = await Promise.all(ids.map(id => hook(b.id, id, 10000, "9100").then(r => r.status)));
      assert.deepEqual([...new Set(st)], [200]);
      assert.equal(await p.shipdayOrder.count({ where: { shipdayOrderId: { in: ids } } }), 20);
      assert.equal((await p.driver.findUniqueOrThrow({ where: { id: d.id } })).pendingDebt, 60000);
    });
    await check("Cola: candado retenido por otro proceso da 503 controlado y sin efectos", async () => {
      const b = await p.branch.create({ data: { name: uid("lk"), apiKeyEnc: "test-only" } });
      const d = await p.driver.create({ data: { name: uid("ld"), shipdayDriverId: uid("s"), branchId: b.id } });
      await bases.giveBase(d.id, { cashAmount: 50000 });
      const url = new URL(DB); url.search = "";
      const holder = spawn("C:/Program Files/PostgreSQL/17/bin/psql.exe", [url.toString(), "-c", "select pg_advisory_lock(20260928,1); select pg_sleep(5);"], { stdio: "ignore" });
      const done = new Promise(r => holder.on("exit", r));
      await new Promise(r => setTimeout(r, 1200));
      const r = await api(`/sd/drivers/${d.id}/payment`, "POST", { amount: 10000, medium: "cash" }, user);
      await done;
      assert.equal(r.status, 503, JSON.stringify(r)); assert.ok(!JSON.stringify(r.body).includes("prisma"));
      // F14: la base es otra cuenta; sin efectos = deuda por comisiones 0 y base intacta (sin devolución).
      assert.equal((await p.driver.findUniqueOrThrow({ where: { id: d.id } })).pendingDebt, 0);
      assert.equal(await p.baseTransaction.count({ where: { driverId: d.id, type: "pago" } }), 0);
      assert.equal(await p.bankTransaction.count({ where: { driverId: d.id } }), 0);
    });
    await check("Sucursal desactivada: 'cargar desde hoy' no cambia su fecha de corte", async () => {
      const b = await p.branch.create({ data: { name: uid("in"), apiKeyEnc: "test-only", active: false } });
      await assert.rejects(() => branchSvc.startOrdersFromToday(b.id), /desactivada/);
      assert.equal((await p.branch.findUniqueOrThrow({ where: { id: b.id } })).ordersSince, null);
    });
    await check("Sondeo: pedidos existentes sin cambios no se reescriben", async () => {
      const b = await p.branch.create({ data: { name: uid("sy"), apiKeyEnc: "test-only" } });
      const d = await p.driver.create({ data: { name: uid("sd"), shipdayDriverId: "9200", branchId: b.id } });
      const now = new Date(); const ids = Array.from({ length: 40 }, () => uid("q"));
      await p.shipdayOrder.createMany({ data: ids.map(id => ({ shipdayOrderId: id, branchId: b.id, driverId: d.id, deliveryValue: 10000, companyAmount: 3000, shipdayDeliveryValue: 10000, status: "DELIVERED", deliveredAt: now })) });
      const snap = async () => JSON.stringify(await p.$queryRawUnsafe(`select xmin::text x from "ShipdayOrder" where "branchId"='${b.id}' order by id`));
      const before = await snap();
      globalThis.fetch = (async (input: any, init?: any) => {
        const s = String(input);
        if (s.startsWith("http://127.0.0.1")) return realFetch(input, init);
        if (s === "https://api.shipday.com/carriers") return new Response(JSON.stringify([{ id: 9200, name: "x" }]));
        if (s === "https://api.shipday.com/orders/query") return new Response(JSON.stringify(ids.map(id => ({ orderId: id, orderNumber: id, deliveryFee: 10000, deliveryTime: now.toISOString(), carrier: { id: 9200 } }))));
        throw Error("Red externa bloqueada en pruebas: " + s);
      }) as any;
      try { await branchSvc.syncBranch(b.id, { forceDrivers: true }); } finally { globalThis.fetch = realFetch; }
      assert.equal(await snap(), before, "algún pedido se reescribió (xmin cambió)");
      assert.equal((await p.driver.findUniqueOrThrow({ where: { id: d.id } })).pendingDebt, 0);
    });
    await check("Excel: movimientos separados por medio (efectivo no se suma al banco)", async () => {
      const excel = await import(`${SRC}/services/excel.service.ts`);
      const { createRequire } = await import("node:module");
      const ExcelJS = createRequire(path.resolve(__dirname, "../package.json"))("exceljs");
      const sum = async () => {
        const wb = new ExcelJS.Workbook(); await wb.xlsx.load(await excel.buildMonthlyExcel(month) as any);
        let row: any = null; wb.getWorksheet("CIERRE MES")!.eachRow((r: any) => { if (String(r.getCell(1).value).startsWith("Movimientos Ingreso")) row = r; });
        return [Number(row.getCell(2).value || 0), Number(row.getCell(3).value || 0)];
      };
      const [c0, b0] = await sum();
      await p.bankTransaction.create({ data: { type: "ingreso", medium: "cash", amount: 5000, description: "Excel ef", noCounterpart: true } });
      await p.bankTransaction.create({ data: { type: "ingreso", medium: "bank", amount: 7000, description: "Excel bk", noCounterpart: true } });
      const [c1, b1] = await sum();
      assert.deepEqual([c1 - c0, b1 - b0], [5000, 7000]);
    });
    await check("Salud: /api/health informa el estado de la cola financiera", async () => {
      const r = await api("/health", "GET", undefined, null);
      assert.equal(r.status, 200); assert.equal(r.body.ok, true); assert.equal(typeof r.body.moneyQueue.busyMs, "number");
    });
    if (!QUICK) await check("Cola: una operación colgada libera la caja al vencer el tiempo máximo (~125 s)", async () => {
      const t0 = Date.now();
      const hung = moneyTransaction(() => new Promise(() => {})).catch((e: Error) => e.message);
      await new Promise(r => setTimeout(r, 1000));
      assert.ok((await api("/health", "GET", undefined, null)).body.moneyQueue.busyMs > 0);
      const msg = await hung;
      assert.match(String(msg), /tiempo máximo/);
      assert.ok(Date.now() - t0 < 135000);
      assert.equal(await moneyTransaction(async () => p.settings.count()), 1);
      assert.equal((await api("/health", "GET", undefined, null)).body.moneyQueue.busyMs, 0);
    });
  } finally {
    globalThis.fetch = realFetch;
    await new Promise<void>(r => server.close(() => r()));
    await writeFile(path.join(__dirname, "claude-final.json"), JSON.stringify(results, null, 2));
    console.log(`\nTOTAL ${results.length} · OK ${results.filter(r => r.ok).length} · FALLAS ${results.filter(r => !r.ok).length}`);
    await p.$disconnect();
    if (results.some(r => !r.ok)) process.exitCode = 1;
  }
}
main().catch(e => { console.error(e); process.exit(1); });
