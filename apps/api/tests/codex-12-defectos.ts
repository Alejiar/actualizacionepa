/**
 * Regresión permanente de los 12 defectos de CODEX_AUDITORIA_UNICA_FINAL.md (oct-2026).
 * Reproduce los casos I01–I14 de Codex con las mismas entradas y expectativas y añade
 * casos de borde. SOLO contra una BD local temporal llamada cashbuddy_claude_12, migrada.
 * Shipday y cualquier red externa quedan bloqueados.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const u = new URL(process.env.DATABASE_URL || "invalid:");
if (u.pathname !== "/cashbuddy_claude_12" || !["localhost", "127.0.0.1"].includes(u.hostname)) throw Error("Solo BD temporal local cashbuddy_claude_12");
process.env.WEBHOOK_TOKEN = process.env.WEBHOOK_TOKEN || "defectos-token";

async function main() {
  const SRC = pathToFileURL(path.resolve(__dirname, "../src")).href;
  const { prisma: p, moneyTransaction, moneyQueueStatus } = await import(`${SRC}/lib/prisma.ts`);
  const { createServer } = await import(`${SRC}/server.ts`);
  const { signToken } = await import(`${SRC}/lib/jwt.ts`);
  const dash = await import(`${SRC}/services/shipday-dashboard.service.ts`);
  const days = await import(`${SRC}/services/day.service.ts`);
  const closes = await import(`${SRC}/services/close.service.ts`);
  const bases = await import(`${SRC}/services/base.service.ts`);
  const excel = await import(`${SRC}/services/excel.service.ts`);
  const edits = await import(`${SRC}/services/edit-request.service.ts`);
  const ds = await import(`${SRC}/services/driver.service.ts`);
  const branchSvc = await import(`${SRC}/services/branch.service.ts`);
  const unified = await import(`${SRC}/services/unified-movements.service.ts`);
  const { todayBogota, toBogotaDateStr } = await import(`${SRC}/lib/date-range.ts`);
  const { createRequire } = await import("node:module");
  const req = createRequire(path.resolve(__dirname, "../package.json"));
  const ExcelJS = req("exceljs"); const bcrypt = req("bcryptjs");

  const today = todayBogota(), month = today.slice(0, 7);
  const yesterday = toBogotaDateStr(new Date(new Date(today + "T00:00:00-05:00").getTime() - 1));
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any, init: any) => { if (!String(input).startsWith("http://127.0.0.1:")) throw Error("Red externa bloqueada"); return realFetch(input, init); }) as any;
  const server = createServer().listen(0, "127.0.0.1"); await new Promise<void>(r => server.once("listening", r));
  const origin = "http://127.0.0.1:" + (server.address() as any).port;
  let admin: any, user: any, branch: any, driver: any;
  const token = (x: any) => signToken({ sub: x.id, email: x.email, name: x.name, role: x.role, tv: x.tokenVersion });
  async function api(route: string, method = "GET", body?: any, who: any = user, tok?: string) {
    const r = await fetch(origin + "/api" + route, { method, headers: { "Content-Type": "application/json", ...(who ? { Authorization: "Bearer " + (tok || token(who)) } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => null) as any };
  }
  const hook = (body: unknown) => fetch(origin + "/api/webhooks/shipday/" + branch.id, { method: "POST", headers: { "Content-Type": "application/json", token: process.env.WEBHOOK_TOKEN! }, body: JSON.stringify(body) });
  const ev = (id: string, fee: unknown) => ({ event: "ORDER_COMPLETED", order: { id, delivery_fee: fee, delivery_time: Date.now() }, carrier: { id: "9001" } });
  async function reset() {
    const tables = await p.$queryRawUnsafe(`SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename <> '_prisma_migrations'`) as any[];
    await p.$executeRawUnsafe("TRUNCATE TABLE " + tables.map((x: any) => '"' + x.tablename + '"').join(",") + " CASCADE");
    await p.settings.create({ data: { id: "singleton", initialCash: 100000, initialBank: 100000, setupComplete: true, termsAcceptedAt: new Date() } });
    admin = await p.user.create({ data: { id: "t-admin", email: "admin@t.invalid", name: "Admin", role: "admin", passwordHash: await bcrypt.hash("Test-Only-2026", 4) } });
    user = await p.user.create({ data: { id: "t-user", email: "user@t.invalid", name: "User", role: "user", passwordHash: await bcrypt.hash("Test-Only-2026", 4) } });
    branch = await p.branch.create({ data: { name: "Branch", apiKeyEnc: "test-only" } });
    driver = await p.driver.create({ data: { name: "Driver", shipdayDriverId: "9001", branchId: branch.id } });
  }
  const results: any[] = [];
  async function check(id: string, name: string, fn: (f: any) => Promise<void>) {
    await reset(); const f: any = {};
    try { await fn(f); results.push({ id, name, ok: true, f }); console.log("OK    " + id + " " + name); }
    catch (e) { results.push({ id, name, ok: false, f, error: String((e as Error).message).slice(0, 400) }); console.log("FALLA " + id + " " + name + "\n      " + JSON.stringify(f) + " " + String((e as Error).message).slice(0, 300)); }
  }
  const closeDay = (date: string) => p.shiftClose.create({ data: { date, shift: "close", denominations: { bills: [], coins: [] }, totalCounted: 0, totalExpected: 0, difference: 0 } });

  try {
    // ───────────── S01 ─────────────
    await check("S01/I01", "Cambio de contraseña dentro del mismo segundo invalida el token anterior", async f => {
      await new Promise(r => setTimeout(r, 1050 - (Date.now() % 1000)));
      const old = token(user);
      assert.equal((await api("/users/" + user.id, "PATCH", { password: "Updated-Only-2026" }, admin)).status, 200);
      const r = await api("/auth/me", "GET", undefined, user, old); f.oldToken = r.status; assert.equal(r.status, 401);
      const fresh = await p.user.findUniqueOrThrow({ where: { id: user.id } });
      assert.equal((await api("/auth/me", "GET", undefined, fresh)).status, 200, "la sesión nueva debe funcionar");
    });
    await check("S01b", "Degradar por API, desactivar y reactivar revocan sesiones; sin hueco temporal", async f => {
      const old = token(admin);
      const other = await p.user.create({ data: { email: "a2@t.invalid", name: "A2", role: "admin", passwordHash: "x" } });
      assert.equal((await api("/users/" + admin.id, "PATCH", { role: "user" }, other)).status, 200);
      f.trasDegradar = (await api("/settings", "PATCH", { initialCash: 1 }, admin, old)).status; assert.equal(f.trasDegradar, 401);
      const v1 = await p.user.findUniqueOrThrow({ where: { id: admin.id } });
      assert.equal((await api("/settings", "PATCH", { initialCash: 1 }, v1)).status, 403); // sesión nueva con rol nuevo
      const t1 = token(v1);
      assert.equal((await api("/users/" + admin.id, "PATCH", { active: false }, other)).status, 200);
      assert.equal((await api("/auth/me", "GET", undefined, v1, t1)).status, 401);
      assert.equal((await p.settings.findUniqueOrThrow({ where: { id: "singleton" } })).initialCash, 100000);
    });
    await check("S01c", "Login real emite token con versión y funciona; token sin versión tras un cambio se rechaza", async f => {
      const login = await fetch(origin + "/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "user@t.invalid", password: "Test-Only-2026" }) });
      const { token: t } = await login.json() as any; f.login = login.status;
      assert.equal((await api("/auth/me", "GET", undefined, user, t)).status, 200);
      // Compatibilidad: un token emitido ANTES de esta versión (sin `tv`) sigue valiendo mientras la cuenta no cambie.
      const legacy = signToken({ sub: user.id, email: user.email, name: user.name, role: user.role });
      f.legacy = (await api("/auth/me", "GET", undefined, user, legacy)).status; assert.equal(f.legacy, 200);
      await api("/users/" + user.id, "PATCH", { password: "Otra-2026-x" }, admin);
      assert.equal((await api("/auth/me", "GET", undefined, user, legacy)).status, 401);
      assert.equal((await api("/auth/me", "GET", undefined, user, t)).status, 401);
    });

    // ───────────── F01 ─────────────
    await check("F01/I04", "Contraparte de importe diferente se rechaza y no queda conciliada", async f => {
      const a = await api("/bank-transactions", "POST", { type: "egreso", medium: "bank", amount: 75000, description: "Original" });
      const b = await api("/bank-transactions", "POST", { type: "ingreso", medium: "bank", amount: 1, description: "Counterpart", pairWith: a.body.id });
      const rep = await closes.getMonthlyReport(month); Object.assign(f, { status: b.status, diff: rep.transfers.diff });
      assert.equal(b.status, 400); assert.equal(rep.transfers.diff, -75000);
      assert.equal((await p.bankTransaction.findUniqueOrThrow({ where: { id: a.body.id } })).pairId, null);
    });
    await check("F01/I05", "Contraparte del mismo signo se rechaza", async f => {
      const a = await api("/bank-transactions", "POST", { type: "ingreso", medium: "bank", amount: 10000, description: "Original" });
      const b = await api("/bank-transactions", "POST", { type: "ingreso", medium: "bank", amount: 10000, description: "Same", pairWith: a.body.id });
      f.status = b.status; assert.equal(b.status, 400); assert.equal((await closes.getMonthlyReport(month)).transfers.diff, 10000);
    });
    await check("F01b", "Referencia inexistente 404; par válido cuadra; segunda contraparte 409; concurrencia: una sola", async f => {
      assert.equal((await api("/bank-transactions", "POST", { type: "ingreso", medium: "bank", amount: 5, description: "x", pairWith: "no-existe" })).status, 404);
      const a = await api("/bank-transactions", "POST", { type: "egreso", medium: "bank", amount: 75000, description: "Salida" });
      const ok = await api("/bank-transactions", "POST", { type: "ingreso", medium: "cash", amount: 75000, description: "Retorno", pairWith: a.body.id });
      f.valido = ok.status; assert.equal(ok.status, 201); assert.ok(ok.body.pairId);
      assert.equal((await closes.getMonthlyReport(month)).transfers.diff, 0);
      assert.equal((await api("/bank-transactions", "POST", { type: "ingreso", medium: "bank", amount: 75000, description: "Dup", pairWith: a.body.id })).status, 409);
      const c = await api("/bank-transactions", "POST", { type: "egreso", medium: "bank", amount: 30000, description: "Otra salida" });
      const both = await Promise.all([1, 2].map(i => api("/bank-transactions", "POST", { type: "ingreso", medium: "bank", amount: 30000, description: "Conc " + i, pairWith: c.body.id })));
      f.concurrentes = both.map(x => x.status).sort(); assert.deepEqual(f.concurrentes, [201, 409]);
      assert.equal(await p.bankTransaction.count({ where: { pairId: both.find(x => x.status === 201)!.body.pairId } }), 2);
    });
    await check("F01c", "Original mixto: la contraparte debe cubrir el total del grupo", async f => {
      const m = await api("/bank-transactions", "POST", { type: "egreso", cashAmount: 20000, bankAmount: 30000, description: "Mixto" });
      const id = m.body.parts[0].id;
      assert.equal((await api("/bank-transactions", "POST", { type: "ingreso", medium: "bank", amount: 20000, description: "Parcial", pairWith: id })).status, 400);
      const r = await api("/bank-transactions", "POST", { type: "ingreso", medium: "bank", amount: 50000, description: "Total", pairWith: id });
      f.status = r.status; assert.equal(r.status, 201);
      assert.equal((await closes.getMonthlyReport(month)).transfers.diff, 0);
    });
    await check("F01d", "Par histórico que no cuadra reaparece en las diferencias pendientes", async f => {
      await p.bankTransaction.createMany({ data: [
        { type: "egreso", medium: "bank", amount: 75000, description: "Legado A", pairId: "pair_legacy" },
        { type: "ingreso", medium: "bank", amount: 1, description: "Legado B", pairId: "pair_legacy" },
      ] });
      const rep = await closes.getMonthlyReport(month); Object.assign(f, { diff: rep.transfers.diff, ok: rep.transfers.ok });
      assert.equal(rep.transfers.diff, -74999); assert.equal(rep.transfers.ok, false);
    });

    // ───────────── F07 ─────────────
    await check("F07/I10", "Split solo efectivo se registra en efectivo", async f => {
      const r = await api("/bank-transactions", "POST", { type: "ingreso", cashAmount: 5000, bankAmount: 0, amount: 5000, description: "Cash split" });
      Object.assign(f, { status: r.status, medium: r.body?.medium }); assert.equal(r.body.medium, "cash");
    });
    await check("F07b", "Split solo banco = banco; contradicciones y sumas erróneas 400; sin medio ni split 400; mixto = 2 filas", async f => {
      assert.equal((await api("/bank-transactions", "POST", { type: "ingreso", cashAmount: 0, bankAmount: 7000, description: "b" })).body.medium, "bank");
      const bad = [
        { type: "ingreso", cashAmount: 5000, bankAmount: 0, medium: "bank", description: "c" },
        { type: "ingreso", cashAmount: 0, bankAmount: 5000, medium: "cash", description: "c" },
        { type: "ingreso", cashAmount: 5000, bankAmount: 0, amount: 6000, description: "c" },
        { type: "ingreso", amount: 5000, description: "sin medio" },
        { type: "ingreso", medium: "cheque", amount: 5000, description: "x" },
      ];
      f.estados = []; for (const b of bad) f.estados.push((await api("/bank-transactions", "POST", b)).status);
      assert.deepEqual(f.estados, [400, 400, 400, 400, 400]);
      const mix = await api("/bank-transactions", "POST", { type: "ingreso", cashAmount: 3000, bankAmount: 4000, description: "mix" });
      assert.equal(mix.body.parts.length, 2);
      const e0 = await dash.getExpectedBalancesForDate(today);
      assert.deepEqual([e0.cash, e0.bank], [100000 + 3000, 100000 + 7000 + 4000]);
    });

    // ───────────── F02 ─────────────
    await check("F02/I07", "Actualizar tarifa por hora a negativo se rechaza y no hay deuda negativa", async f => {
      const c = await api("/hourly-clients", "POST", { name: "Hourly", driverHourValue: 12000, companyHourValue: 8000 });
      const upd = await api("/hourly-clients/" + c.body.id, "PATCH", { driverHourValue: -12000 });
      const shift = await api("/hourly-clients/" + c.body.id + "/shifts", "POST", { driverId: driver.id, startTime: "08:00", endTime: "09:00", medium: "cash" });
      const after = await p.hourlyClient.findUniqueOrThrow({ where: { id: c.body.id } });
      Object.assign(f, { upd: upd.status, shift: shift.status, total: shift.body?.totalAmount, debt: after.pendingDebt });
      assert.equal(upd.status, 400); assert.equal(after.driverHourValue, 12000); assert.equal(shift.body.totalAmount, 20000); assert.equal(after.pendingDebt, 20000);
    });
    await check("F02b", "Alta y edición: negativos, fracciones, texto, desborde, suma cero y nombre vacío se rechazan", async f => {
      const bads = [{ name: "x", driverHourValue: -1, companyHourValue: 1 }, { name: "x", driverHourValue: 1.5, companyHourValue: 1 }, { name: "x", driverHourValue: "1000", companyHourValue: 1 },
        { name: "x", driverHourValue: 2147483647, companyHourValue: 1 }, { name: "x", driverHourValue: 0, companyHourValue: 0 }, { name: "  ", driverHourValue: 1, companyHourValue: 1 }];
      f.alta = []; for (const b of bads) f.alta.push((await api("/hourly-clients", "POST", b)).status);
      assert.deepEqual(f.alta, [400, 400, 400, 400, 400, 400]);
      const c = await api("/hourly-clients", "POST", { name: "Ok", driverHourValue: 10000, companyHourValue: 0 }); assert.equal(c.status, 201);
      f.edicion = []; for (const b of [{ companyHourValue: -5 }, { driverHourValue: 0 }, { name: "" }, { driverHourValue: null }]) f.edicion.push((await api("/hourly-clients/" + c.body.id, "PATCH", b)).status);
      assert.deepEqual(f.edicion, [400, 400, 400, 400]);
      assert.equal((await api("/hourly-clients/" + c.body.id, "PATCH", { companyHourValue: 5000 })).status, 200);
      assert.equal(await p.hourlyClient.count({ where: { OR: [{ driverHourValue: { lt: 0 } }, { companyHourValue: { lt: 0 } }] } }), 0);
    });

    // ───────────── F03 ─────────────
    await check("F03/I03", "Cerrar el mes no sustituye el capital de fechas anteriores al cierre", async f => {
      const before = await dash.getExpectedBalancesForDate(yesterday);
      const prev = new Date(month + "-01T12:00:00-05:00"); prev.setUTCMonth(prev.getUTCMonth() - 1);
      await closes.closeMonth(toBogotaDateStr(prev).slice(0, 7), undefined, 500000, 200000);
      const after = await dash.getExpectedBalancesForDate(yesterday);
      Object.assign(f, { before, after }); assert.deepEqual(after, before);
      const todayBal = await dash.getExpectedBalancesForDate(today);
      assert.deepEqual([todayBal.cash, todayBal.bank], [500000, 200000]); // desde el cierre manda el capital nuevo
    });
    await check("F03b", "Un segundo cierre no cambia los saldos del período del primero; cierre sin capital conserva el vigente", async f => {
      const prev = new Date(month + "-01T12:00:00-05:00"); prev.setUTCMonth(prev.getUTCMonth() - 2);
      await closes.closeMonth(toBogotaDateStr(prev).slice(0, 7)); // sin capital
      const c1 = await p.monthlyClose.findFirstOrThrow();
      assert.deepEqual([c1.initialCash, c1.initialBank], [100000, 100000]);
      await api("/bank-transactions", "POST", { type: "ingreso", medium: "cash", amount: 1000, description: "x" });
      const mid = await dash.getExpectedBalancesForDate(today);
      await p.settings.update({ where: { id: "singleton" }, data: { initialCash: 999999 } }); // capital posterior en Settings
      const again = await dash.getExpectedBalancesForDate(today);
      Object.assign(f, { mid, again }); assert.deepEqual(again, mid);
    });

    // ───────────── F04 ─────────────
    await check("F04/I08", "El cierre calcula el esperado dentro de la operación serializada", async f => {
      let release!: () => void, entered!: () => void; const ready = new Promise<void>(r => (entered = r)), gate = new Promise<void>(r => (release = r));
      const held = moneyTransaction(async () => { entered(); await gate; await p.bankTransaction.create({ data: { type: "ingreso", medium: "bank", amount: 10000, description: "Concurrent", noCounterpart: true } }); });
      await ready;
      const pending = api("/shifts", "POST", { date: today, shift: "AM", denominations: { bills: [{ value: 100000, qty: 1 }], coins: [] }, bankCounted: 110000 });
      let queued = false; for (let i = 0; i < 100; i++) { if (moneyQueueStatus().waiting > 0) { queued = true; break; } await new Promise(r => setTimeout(r, 10)); }
      release(); await held; const r = await pending; const cur = await dash.getExpectedBalancesForDate(today);
      Object.assign(f, { queued, status: r.status, saved: r.body?.bankExpected, current: cur.bank, diff: r.body?.bankDifference });
      assert.ok(queued); assert.equal(r.body.bankExpected, cur.bank); assert.equal(r.body.bankDifference, 0);
    });
    await check("F04b", "Cierre repetido del mismo turno: uno solo; un fallo durante el registro no deja cierre", async f => {
      const body = { date: today, shift: "PM", denominations: { bills: [{ value: 100000, qty: 1 }], coins: [] }, bankCounted: 100000 };
      const two = await Promise.all([api("/shifts", "POST", body), api("/shifts", "POST", body)]);
      f.estados = two.map(x => x.status).sort(); assert.deepEqual(f.estados, [201, 409]);
      assert.equal((await api("/shifts", "POST", { ...body, shift: "close", bankCounted: "" })).status, 400);
      assert.equal(await p.shiftClose.count({ where: { shift: "close" } }), 0);
    });

    // ───────────── F05 ─────────────
    await check("F05/I02", "Movimiento retroactivo: caja e historial de su fecha coinciden", async f => {
      const before = await dash.getExpectedBalancesForDate(yesterday);
      const r = await api("/movements", "POST", { date: yesterday, category: 1, type: "ingreso", medium: "cash", amount: 10000 });
      assert.equal(r.status, 201);
      const after = await dash.getExpectedBalancesForDate(yesterday), sumY = await days.getDaySummary(yesterday), sumT = await days.getDaySummary(today);
      Object.assign(f, { delta: after.cash - before.cash, ingresosAyer: sumY.ingresos, ingresosHoy: sumT.ingresos, finalHoy: sumT.finalCash });
      assert.equal(after.cash - before.cash, 10000); assert.equal(sumY.ingresos, 10000); assert.equal(sumT.ingresos, 0); assert.equal(sumT.finalCash, 110000);
      const list = await unified.getUnifiedMovements({ from: yesterday, to: yesterday });
      assert.ok(list.some((m: any) => m.amount === 10000), "Movimientos del día debe incluirlo por su fecha operativa");
    });
    await check("F05b", "Día cerrado: no se registra ni se aprueba dinero en él (D7); fecha posterior al día operativo 400", async f => {
      await closeDay(yesterday);
      const before = await dash.getExpectedBalancesForDate(yesterday);
      f.retro = (await api("/movements", "POST", { date: yesterday, category: 1, type: "ingreso", medium: "cash", amount: 10000 })).status;
      await p.day.upsert({ where: { date: yesterday }, update: {}, create: { date: yesterday, initialCash: 0, initialBank: 0 } });
      const pend = await p.movement.create({ data: { date: yesterday, time: "10:00", category: 3, type: "egreso", medium: "cash", amount: 5000, status: "pending" } });
      f.aprobar = (await api("/movements/" + pend.id + "/approve", "POST", {}, admin)).status;
      f.banco = (await api("/bank-transactions", "POST", { type: "ingreso", medium: "cash", amount: 1000, description: "x", date: new Date(yesterday + "T12:00:00-05:00").toISOString() })).status;
      const far = new Date(today + "T12:00:00-05:00"); far.setDate(far.getDate() + 5);
      f.futuro = (await api("/movements", "POST", { date: toBogotaDateStr(far), category: 1, type: "ingreso", medium: "cash", amount: 1 })).status;
      assert.deepEqual([f.retro, f.aprobar, f.banco, f.futuro], [409, 409, 409, 400]);
      assert.deepEqual(await dash.getExpectedBalancesForDate(yesterday), before);
    });
    await check("F05c", "Mes cerrado: un movimiento fechado antes del cierre se rechaza; Historial concilia apertura+ingresos−egresos=cierre", async f => {
      await closes.closeMonth("2020-01", undefined, 100000, 100000);
      f.antes = (await api("/movements", "POST", { date: yesterday, category: 1, type: "ingreso", medium: "cash", amount: 10000 })).status;
      assert.equal(f.antes, 409);
      await p.conversion.create({ data: { branchId: branch.id, amount: 7000, type: "efectivo_a_banco" } });
      await api("/clients", "POST", { name: "C", initialDebt: 3000, initialDebtMedium: "cash" }, admin);
      await api("/bank-transactions", "POST", { type: "egreso", medium: "bank", amount: 2000, description: "x" });
      const s = await days.getDaySummary(today);
      Object.assign(f, { s: { apertura: s.initialTotal, ingresos: s.ingresos, egresos: s.egresos, cierre: s.finalTotal, actividad: s.hasActivity } });
      assert.equal(s.initialTotal + s.ingresos - s.egresos, s.finalTotal, "el desglose del día no concilia con su saldo");
      assert.equal(s.hasActivity, true);
    });

    // ───────────── F06 ─────────────
    await check("F06/I06", "Excel: base solo bancaria conserva efectivo cero (y devoluciones, mixtas, antiguas sin desglose)", async f => {
      await bases.giveBase(driver.id, { bankAmount: 10000, cashAmount: 0 });
      const row = async (n: number) => { const wb = new ExcelJS.Workbook(); await wb.xlsx.load(await excel.buildMonthlyExcel(month) as any); const r = wb.getWorksheet("CIERRE MES")!.getRow(n); return [r.getCell(2).value, r.getCell(3).value]; };
      f.solaBanco = await row(5); assert.deepEqual(f.solaBanco, [0, 10000]);
      await bases.giveBase(driver.id, { cashAmount: 4000, bankAmount: 6000 });
      await p.baseTransaction.create({ data: { branchId: branch.id, driverId: driver.id, amount: 2500, type: "entrega" } }); // antigua sin desglose = efectivo
      f.entregas = await row(5); assert.deepEqual(f.entregas, [6500, 16000]);
      await bases.payBase(driver.id, { bankAmount: 3000 });
      await ds.registerPayment(driver.id, 5000, "bank"); // devolución interna ligada a banco: ya está en Movimientos
      f.devueltas = await row(6); assert.deepEqual(f.devueltas, [0, 3000]);
    });

    // ───────────── S02 ─────────────
    await check("S02/I13", "Webhook rechaza tarifa negativa sin crear pedido", async f => {
      const r = await hook(ev("negative-audit", -10000)); f.status = r.status;
      assert.equal(r.status, 400); assert.equal(await p.shipdayOrder.count(), 0); assert.equal((await closes.getMonthlyReport(month)).totalSales, 0);
    });
    await check("S02b", "Tarifa no numérica 400; lote con un inválido se rechaza completo; $0 sigue siendo provisional válido; idempotencia intacta", async f => {
      assert.equal((await hook(ev("txt", "abc"))).status, 400);
      assert.equal((await hook([ev("lote-ok", 10000), ev("lote-bad", -1)])).status, 400);
      assert.equal(await p.shipdayOrder.count(), 0);
      assert.equal((await hook(ev("stub", 0))).status, 200);
      const st = await Promise.all(Array.from({ length: 10 }, () => hook(ev("rep", 10000)).then(r => r.status)));
      f.estados = [...new Set(st)]; assert.deepEqual(f.estados, [200]);
      assert.equal(await p.shipdayOrder.count(), 2);
      assert.equal((await p.driver.findUniqueOrThrow({ where: { id: driver.id } })).pendingDebt, 3000);
    });
    await check("S02c", "Sondeo: pedido con tarifa negativa se omite y la sincronización queda marcada incompleta", async f => {
      const now = new Date().toISOString();
      globalThis.fetch = (async (input: any, init: any) => {
        const s = String(input);
        if (s.startsWith("http://127.0.0.1:")) return realFetch(input, init);
        if (s === "https://api.shipday.com/carriers") return new Response(JSON.stringify([{ id: 9001, name: "Driver" }]));
        if (s === "https://api.shipday.com/orders/query") return new Response(JSON.stringify([{ orderId: "neg", orderNumber: "1", deliveryFee: -5000, deliveryTime: now, carrier: { id: 9001 } }, { orderId: "pos", orderNumber: "2", deliveryFee: 10000, deliveryTime: now, carrier: { id: 9001 } }]));
        throw Error("Red externa bloqueada");
      }) as any;
      let r: any; try { r = await branchSvc.syncBranch(branch.id, { forceDrivers: true }); } finally { globalThis.fetch = (async (input: any, init: any) => { if (!String(input).startsWith("http://127.0.0.1:")) throw Error("Red externa bloqueada"); return realFetch(input, init); }) as any; }
      Object.assign(f, { partial: r.partial, orders: await p.shipdayOrder.count() });
      assert.equal(r.partial, true); assert.equal(await p.shipdayOrder.count({ where: { shipdayOrderId: "neg" } }), 0); assert.equal(await p.shipdayOrder.count({ where: { shipdayOrderId: "pos" } }), 1);
      assert.equal((await p.branch.findUniqueOrThrow({ where: { id: branch.id } })).syncStatus, "error");
    });

    // ───────────── S03 ─────────────
    await check("S03", "Clave de cifrado: falla cerrado si no puede leerse/crearse; reutiliza la existente; nunca la pública", async f => {
      const cryptoSrc = path.resolve(__dirname, "../src/lib/crypto.ts").replace(/\\/g, "/");
      const tsx = path.resolve(__dirname, "../../../node_modules/tsx/dist/cli.mjs");
      const run = (cwd: string, code: string, env: Record<string, string | undefined> = {}) => {
        const e = { ...process.env, ...env }; delete e.ENCRYPTION_KEY; if (env.ENCRYPTION_KEY) e.ENCRYPTION_KEY = env.ENCRYPTION_KEY;
        return spawnSync(process.execPath, [tsx, "-e", `import("file:///${cryptoSrc}").then(m=>{${code}}).catch(e=>{console.log("ERR:"+e.name);process.exit(3)})`], { cwd, env: e, encoding: "utf8" });
      };
      const dirKey = fs.mkdtempSync(path.join(os.tmpdir(), "s03-")); fs.mkdirSync(path.join(dirKey, ".encryption-key"));
      const a = run(dirKey, `m.encryptApiKey("FAKE");console.log("CIFRO")`); f.directorio = (a.stdout || "").trim();
      assert.match(f.directorio, /ERR:EncryptionKeyError/);
      const empty = fs.mkdtempSync(path.join(os.tmpdir(), "s03-")); fs.writeFileSync(path.join(empty, ".encryption-key"), "");
      assert.match(run(empty, `m.encryptApiKey("FAKE")`).stdout, /ERR:EncryptionKeyError/);
      const fresh = fs.mkdtempSync(path.join(os.tmpdir(), "s03-"));
      const c1 = run(fresh, `console.log("C="+m.encryptApiKey("FAKE"))`).stdout.match(/C=(\S+)/)![1];
      const k1 = fs.readFileSync(path.join(fresh, ".encryption-key"), "utf8");
      const d1 = run(fresh, `console.log("D="+m.decryptApiKey(${JSON.stringify(c1)}))`).stdout;
      assert.match(d1, /D=FAKE/); assert.equal(fs.readFileSync(path.join(fresh, ".encryption-key"), "utf8"), k1, "no debe sobrescribir la clave");
      const { createDecipheriv, createHash } = await import("node:crypto");
      const [iv, ct] = c1.split(":"); let publicWorks = true;
      try { const dc = createDecipheriv("aes-256-cbc", createHash("sha256").update("cash-buddy-default-key-change-me").digest(), Buffer.from(iv, "hex")); Buffer.concat([dc.update(Buffer.from(ct, "hex")), dc.final()]).toString() === "FAKE" || (publicWorks = false); } catch { publicWorks = false; }
      f.clavePublicaDescifra = publicWorks; assert.equal(publicWorks, false);
      assert.match(run(fresh, `console.log("E="+m.encryptApiKey("X").includes(":"))`, { ENCRYPTION_KEY: "env-key-de-prueba" }).stdout, /E=true/);
    });

    // ───────────── M01 ─────────────
    await check("M01/I09", "Eliminar MonthlyClose no puede quedar aprobado sin efecto", async f => {
      const c = await closes.closeMonth("2026-08");
      await assert.rejects(() => edits.createRequest({ requesterId: user.id, entityType: "MonthlyClose", entityId: c.id, entityLabel: "Close", changes: {}, reason: "Audit", requestType: "delete" }), /no está implementada/);
      const legacy = await p.editRequest.create({ data: { requesterId: user.id, entityType: "MonthlyClose", entityId: c.id, entityLabel: "Close", changes: {}, reason: "Legacy", requestType: "delete" } });
      await assert.rejects(() => edits.reviewRequest(legacy.id, admin.id, "approved"));
      f.estado = (await p.editRequest.findUniqueOrThrow({ where: { id: legacy.id } })).status; f.existe = await p.monthlyClose.count({ where: { id: c.id } });
      assert.equal(f.estado, "pending"); assert.equal(f.existe, 1);
      assert.equal((await edits.reviewRequest(legacy.id, admin.id, "rejected")).status, "rejected");
    });
    await check("M01b", "Eliminar un registro que ya no existe no se aprueba; dos aprobaciones del mismo efecto: una sola", async f => {
      const t = await api("/bank-transactions", "POST", { type: "ingreso", medium: "cash", amount: 1000, description: "x", noCounterpart: true });
      const r1 = await edits.createRequest({ requesterId: user.id, entityType: "BankTransaction", entityId: t.body.id, entityLabel: "x", changes: {}, reason: "r", requestType: "delete" });
      const r2 = await edits.createRequest({ requesterId: user.id, entityType: "BankTransaction", entityId: t.body.id, entityLabel: "x", changes: {}, reason: "r", requestType: "delete" });
      const out = await Promise.allSettled([edits.reviewRequest(r1.id, admin.id, "approved"), edits.reviewRequest(r2.id, admin.id, "approved")]);
      f.res = out.map(o => o.status).sort(); assert.deepEqual(f.res, ["fulfilled", "rejected"]);
      const st = await p.editRequest.findMany({ where: { id: { in: [r1.id, r2.id] } }, select: { status: true } });
      assert.deepEqual(st.map((s: any) => s.status).sort(), ["approved", "pending"]);
    });
  } finally {
    globalThis.fetch = realFetch;
    await new Promise<void>(r => server.close(() => r()));
    fs.writeFileSync(path.join(__dirname, "codex-12-defectos.json"), JSON.stringify(results, null, 2));
    console.log(`\nTOTAL ${results.length} · OK ${results.filter(r => r.ok).length} · FALLAS ${results.filter(r => !r.ok).length}`);
    await p.$disconnect();
    if (results.some(r => !r.ok)) process.exitCode = 1;
  }
}
main().catch(e => { console.error(e); process.exit(1); });
