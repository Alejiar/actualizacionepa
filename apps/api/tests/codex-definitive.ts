import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import bcrypt from "bcryptjs";
import ExcelJS from "exceljs";
import { PrismaClient } from "@prisma/client";
import { prisma as p, moneyTransaction } from "../src/lib/prisma";
import { createServer } from "../src/server";
import { signToken } from "../src/lib/jwt";
import { todayBogota, toBogotaDateStr } from "../src/lib/date-range";
import { assertCalendarDate, parseFinancialTimestamp } from "../src/lib/period-guard";
import * as bank from "../src/services/bank-transaction.service";
import * as bases from "../src/services/base.service";
import * as clients from "../src/services/client.service";
import * as drivers from "../src/services/driver.service";
import * as hourly from "../src/services/hourly-client.service";
import * as closes from "../src/services/close.service";
import * as shifts from "../src/services/shift-close.service";
import * as edits from "../src/services/edit-request.service";
import * as dashboard from "../src/services/shipday-dashboard.service";
import * as conversions from "../src/services/conversion.service";
import * as settings from "../src/services/settings.service";
import * as days from "../src/services/day.service";
import * as adminSvc from "../src/services/admin.service";
import * as excel from "../src/services/excel.service";
import * as branches from "../src/services/branch.service";

const url = new URL(process.env.DATABASE_URL!);
assert.equal(url.pathname, "/cashbuddy_codex_definitive_20261014");
assert.ok(["localhost", "127.0.0.1"].includes(url.hostname));
const realFetch = globalThis.fetch;
// Ningún caso puede activar una integración externa real.
globalThis.fetch = (async (input: any, init: any) => {
  if (!String(input).startsWith("http://127.0.0.1:")) throw Error("Red externa bloqueada");
  return realFetch(input, init);
}) as any;
const results: any[] = [];
const today = todayBogota(), month = today.slice(0, 7);
let admin: any, user: any, branch: any, driver: any, client: any, hc: any;
let server: ReturnType<ReturnType<typeof createServer>["listen"]>, origin: string;
const hash = bcrypt.hashSync("Ficticio-Only-2026", 4);
async function start() {
  server = createServer({ webDir: path.resolve(__dirname, "../../web/out") }).listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  origin = "http://127.0.0.1:" + (server.address() as any).port;
}
async function stop() { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
const token = (u: any) => signToken({ sub: u.id, email: u.email, name: u.name, role: u.role, tv: u.tokenVersion });
async function api(route: string, method = "GET", body?: any, who: any = user) {
  const response = await fetch(origin + "/api" + route, { method, headers: { "Content-Type": "application/json", ...(who ? { Authorization: "Bearer " + token(who) } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json().catch(() => null) };
}
async function reset() {
  const tables = await p.$queryRawUnsafe<any[]>(`SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename <> '_prisma_migrations'`);
  await p.$executeRawUnsafe("TRUNCATE TABLE " + tables.map(t => '"' + t.tablename + '"').join(",") + " CASCADE");
  await p.settings.create({ data: { id: "singleton", initialCash: 100000, initialBank: 100000, setupComplete: true, termsAcceptedAt: new Date() } });
  admin = await p.user.create({ data: { id: "def-admin", email: "admin@def.invalid", name: "Admin ficticio", role: "admin", passwordHash: hash } });
  user = await p.user.create({ data: { id: "def-user", email: "user@def.invalid", name: "Operador ficticio", role: "user", passwordHash: hash } });
  branch = await p.branch.create({ data: { name: "Sucursal ficticia", apiKeyEnc: "test-only" } });
  driver = await p.driver.create({ data: { branchId: branch.id, shipdayDriverId: "def-driver", name: "Domiciliario ficticio" } });
  client = await clients.createClient({ name: "Cliente ficticio" });
  hc = await hourly.createHourlyClient({ name: "Cliente por hora ficticio", driverHourValue: 12000, companyHourValue: 8000 });
}
async function check(id: string, name: string, work: (facts: any) => Promise<void>) {
  await reset(); const facts: any = {};
  try { await work(facts); results.push({ id, name, ok: true, facts }); console.log("OK " + id); }
  catch (error) { results.push({ id, name, ok: false, facts, error: String(error) }); console.log("FAIL " + id + " " + error); }
}
function code(status: number) { return (error: any) => error.status === status || error.statusCode === status; }
async function closeDay() {
  const expected = await dashboard.getExpectedBalancesForDate(today);
  const r = await api("/shifts", "POST", { date: today, shift: "close", bankCounted: expected.bank, denominations: { bills: [{ value: expected.cash, qty: 1 }], coins: [] } }, admin);
  assert.equal(r.status, 201); return r.body;
}
const income = (amount = 10000) => bank.create({ type: "ingreso", medium: "bank", amount, description: "Ingreso ficticio", noCounterpart: true });
const shiftInput = (date = today) => ({ date, driverId: driver.id, startTime: "08:00", endTime: "09:00", medium: "cash" as const });
async function request(entity: string, id: string, changes: any, type: "edit" | "delete" = "edit") {
  const r = await edits.createRequest({ requesterId: user.id, entityType: entity, entityId: id, entityLabel: entity, reason: "Ensayo ficticio", requestType: type, changes });
  await assert.rejects(() => edits.reviewRequest(r.id, admin.id, "approved"), code(409));
  assert.equal((await p.editRequest.findUniqueOrThrow({ where: { id: r.id } })).status, "pending");
}
async function excelTransfer(expected: number) {
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(await excel.buildMonthlyExcel(month) as any);
  let found = false; wb.getWorksheet("CIERRE MES")!.eachRow(row => {
    if (row.getCell(5).value === "DIFERENCIA TRANSFERENCIAS") { assert.equal(row.getCell(6).value, expected); found = true; }
  }); assert.ok(found);
}

async function main() {
  await start();
  try {
    for (const [id, input] of [["DATE01", "2026-02-31"], ["DATE02", "2026-02-30"], ["DATE03", "2025-02-29"], ["DATE04", "2026-13-01"], ["DATE05", "2026-00-01"], ["DATE06", "2026-01-00"], ["DATE07", "2026-04-31"], ["DATE08", "2026-2-01"], ["DATE09", "2026/02/01"], ["DATE10", ""], ["DATE11", 42], ["DATE12", null]] as const) {
      await check(id, "Fecha imposible/formato inválido sin efectos parciales: " + input, async f => {
        const r = await api("/hourly-clients/" + hc.id + "/shifts", "POST", { ...shiftInput(), date: input });
        f.status = r.status; assert.equal(r.status, 400); assert.equal(await p.hourlyShift.count(), 0); assert.equal(await p.bankTransaction.count(), 0);
        assert.equal((await p.hourlyClient.findUniqueOrThrow({ where: { id: hc.id } })).pendingDebt, 0);
      });
    }
    await check("DATE13", "Bisiestos estrictos y turno válido: servicio pasado, desembolso hoy", async f => {
      assertCalendarDate("2000-02-29"); assert.throws(() => assertCalendarDate("1900-02-29"));
      const s = await hourly.registerShift(hc.id, shiftInput("2024-02-29"));
      const tx = await p.bankTransaction.findFirstOrThrow({ where: { hourlyShiftId: s.id } });
      f.serviceDate = s.date; f.moneyDate = toBogotaDateStr(tx.date); assert.equal(s.date, "2024-02-29"); assert.equal(f.moneyDate, today);
      assert.deepEqual(await dashboard.getExpectedBalancesForDate(today), { cash: 88000, bank: 100000 });
      assert.equal((await closes.getMonthlyReport(month)).clientDebt.hourly, 20000);
    });
    await check("DATE14", "Futuro rechazado, edición inválida revierte turno, dinero y deuda", async () => {
      const future = new Date(today + "T12:00:00-05:00"); future.setUTCDate(future.getUTCDate() + 1);
      const tomorrow = toBogotaDateStr(future);
      await assert.rejects(() => hourly.registerShift(hc.id, shiftInput(tomorrow)), code(400));
      const s = await hourly.registerShift(hc.id, shiftInput());
      await assert.rejects(() => hourly.editShift(s.id, { date: "2026-02-31", endTime: "10:00" }), code(400));
      assert.equal((await p.hourlyShift.findUniqueOrThrow({ where: { id: s.id } })).totalAmount, 20000);
      assert.equal((await p.bankTransaction.findFirstOrThrow()).amount, 12000);
      assert.equal((await p.hourlyClient.findUniqueOrThrow({ where: { id: hc.id } })).pendingDebt, 20000);
    });
    await check("DATE15", "Timestamps bancarios imposibles, futuros y hora 24 rechazados", async () => {
      for (const input of ["2026-02-31T10:00:00-05:00", "2026-01-01T24:00:00Z", "garbage", new Date(Date.now() + 86400000).toISOString()]) {
        assert.throws(() => parseFinancialTimestamp(input));
        assert.equal((await api("/bank-transactions", "POST", { type: "ingreso", medium: "bank", amount: 10000, description: "Inválido", date: input })).status, 400);
      } assert.equal(await p.bankTransaction.count(), 0);
    });
    await check("INPUT01", "Medio y horas por hora inválidos dan 400, sin dinero", async () => {
      for (const input of [{ medium: "card" }, { medium: null }, { startTime: 900 }]) {
        const r = await api("/hourly-clients/" + hc.id + "/shifts", "POST", { ...shiftInput(), ...input }); assert.equal(r.status, 400);
      } assert.equal(await p.bankTransaction.count(), 0);
    });
    await check("INPUT02", "Base fraccionaria no se redondea silenciosamente", async () => {
      const r = await api("/sd/bases/" + driver.id + "/give", "POST", { bankAmount: 10000.4 }); assert.equal(r.status, 400);
      assert.equal(await p.baseTransaction.count(), 0); assert.equal((await p.driver.findUniqueOrThrow({ where: { id: driver.id } })).pendingDebt, 0);
    });
    for (const [id, driverAssigned, mixed] of [["PAIR01", false, false], ["PAIR02", true, false], ["PAIR03", true, true]] as const) {
      await check(id, "Grupo válido completo; reporte, Excel y proyector", async f => {
        const a: any = await bank.create({ type: "egreso", amount: 10000, medium: "bank", ...(mixed ? { cashAmount: 4000, bankAmount: 6000, medium: undefined } : {}), description: "Original" });
        const id = a.mixed ? a.parts[0].id : a.id;
        await bank.create({ type: "ingreso", medium: "bank", amount: 10000, description: "Retorno", pairWith: id, ...(driverAssigned ? { driverId: driver.id } : {}) });
        const report = await closes.getMonthlyReport(month); f.diff = report.transfers.diff; assert.equal(f.diff, 0); assert.ok(report.transfers.ok);
        await excelTransfer(0); const projection = await closes.getMonthCloseProjection(month, 100000, 100000);
        assert.equal(projection.physicalBank, 100000); assert.equal(projection.pending.bankShortfall, 0);
      });
    }
    for (const [id, rows, expected] of [["PAIR04", [["ingreso", 10000], ["ingreso", 10000]], 20000], ["PAIR05", [["egreso", 10000], ["ingreso", 1]], -9999], ["PAIR06", [["egreso", 10000]], -10000]] as const) {
      await check(id, "Grupo histórico realmente roto permanece visible", async () => {
        for (const [type, amount] of rows) await p.bankTransaction.create({ data: { type, amount, medium: "bank", description: "Histórico roto", pairId: "broken-fixture" } });
        const r = await closes.getMonthlyReport(month); assert.equal(r.transfers.diff, expected); assert.ok(!r.transfers.ok);
        assert.ok(r.transfers.pendingItems.some(x => x.name.includes("par que no cuadra"))); await excelTransfer(expected);
        assert.equal((await closes.getMonthCloseProjection(month, 100000, 100000)).physicalBank, 100000 - expected);
      });
    }
    await check("PAIR07", "Dos contrapartes concurrentes: una pareja, un conflicto; reintento no duplica", async f => {
      const a = await bank.create({ type: "egreso", medium: "bank", amount: 10000, description: "Original" });
      const input = { type: "ingreso", medium: "bank", amount: 10000, description: "Retorno", pairWith: (a as any).id };
      const states = await Promise.all([api("/bank-transactions", "POST", input), api("/bank-transactions", "POST", input)]);
      f.statuses = states.map(x => x.status).sort(); assert.deepEqual(f.statuses, [201, 409]);
      assert.equal((await api("/bank-transactions", "POST", input)).status, 409); assert.equal(await p.bankTransaction.count(), 2);
    });
    await check("PAIR08", "Retorno entre meses permitido; borrar la pareja cerrada se rechaza", async () => {
      const previous = new Date(month + "-01T12:00:00-05:00"); previous.setUTCDate(0);
      const a: any = await bank.create({ type: "egreso", medium: "bank", amount: 10000, description: "Mes anterior", date: previous.toISOString() });
      await closes.closeMonth(toBogotaDateStr(previous).slice(0, 7), undefined, 100000, 100000);
      const b: any = await bank.create({ type: "ingreso", medium: "bank", amount: 10000, description: "Retorno", pairWith: a.id });
      assert.equal(toBogotaDateStr(b.date), today); await assert.rejects(() => bank.remove(b.id), code(409));
      assert.equal(await p.bankTransaction.count(), 2); assert.equal((await closes.getMonthlyReport(month)).transfers.diff, 0); await excelTransfer(0);
      assert.equal((await closes.getMonthCloseProjection(month, 100000, 100000)).physicalBank, 100000);
    });
    await check("INPUT03", "Bases con total contradictorio o desborde se rechazan", async () => {
      for (const input of [{ cashAmount: 4000, bankAmount: 6000, amount: 99999 }, { cashAmount: 2147483647, bankAmount: 1 }]) {
        assert.equal((await api("/sd/bases/" + driver.id + "/give", "POST", input)).status, 400);
      } assert.equal(await p.baseTransaction.count(), 0);
    });
    const closedCreates: [string, string, () => Promise<any>][] = [
      ["LOCK01", "Banco implícito hoy", () => income()],
      ["LOCK02", "Entrega de base", () => bases.giveBase(driver.id, { cashAmount: 1000 })],
      ["LOCK03", "Devolución de base", () => bases.payBase(driver.id, { cashAmount: 1000 })],
      ["LOCK04", "Pago del domiciliario", () => drivers.registerPayment(driver.id, 1000, "bank")],
      ["LOCK05", "Préstamo cliente del mismo día", () => clients.addDebt(client.id, "Préstamo", 1000, today, undefined, "cash")],
      ["LOCK06", "Abono cliente", () => clients.registerClientPayment(client.id, 1000, false, "cash")],
      ["LOCK07", "Turno por hora", () => hourly.registerShift(hc.id, shiftInput())],
      ["LOCK08", "Cobro por hora", () => hourly.payClient(hc.id, { amount: 1000, medium: "cash" })],
      ["LOCK09", "Conversión", () => conversions.createConversion({ branchId: branch.id, amount: 1000, type: "efectivo_a_banco" })],
    ];
    for (const [id, name, operation] of closedCreates) await check(id, name + " no entra en día cerrado", async () => {
      await bases.giveBase(driver.id, { cashAmount: 10000 }); await clients.addDebt(client.id, "Deuda", 10000);
      await hourly.registerShift(hc.id, shiftInput()); await closeDay();
      const before = await dashboard.getExpectedBalancesForDate(today), counts = [await p.bankTransaction.count(), await p.baseTransaction.count(), await p.clientDebtPayment.count()];
      await assert.rejects(operation, code(409)); assert.deepEqual(await dashboard.getExpectedBalancesForDate(today), before);
      assert.deepEqual([await p.bankTransaction.count(), await p.baseTransaction.count(), await p.clientDebtPayment.count()], counts);
    });
    await check("LOCK10", "Eliminaciones y ediciones equivalentes quedan bloqueadas", async () => {
      const b = await income(), base = await bases.giveBase(driver.id, { cashAmount: 10000 });
      const conv = await conversions.createConversion({ branchId: branch.id, amount: 1000, type: "efectivo_a_banco" });
      const s = await hourly.registerShift(hc.id, shiftInput()); await clients.addDebt(client.id, "Deuda", 10000);
      await clients.registerClientPayment(client.id, 1000, false, "bank"); const pay = await p.clientDebtPayment.findFirstOrThrow();
      const close = await closeDay();
      for (const operation of [() => bank.remove((b as any).id), () => bank.edit((b as any).id, { amount: 20000 }), () => bases.removeBase(base.id), () => bases.editBase(base.id, { cashAmount: 20000 }), () => conversions.deleteConversion(conv.id), () => hourly.deleteShift(s.id), () => hourly.editShift(s.id, { endTime: "10:00" }), () => clients.reverseClientPayment(pay.id), () => shifts.deleteShift(close.id), () => drivers.applyBankToDriver((b as any).id, driver.id)]) {
        await assert.rejects(operation, code(409));
      }
      assert.equal((await p.bankTransaction.findUniqueOrThrow({ where: { id: (b as any).id } })).amount, 10000);
      assert.equal(await p.shiftClose.count(), 1); assert.equal(await p.hourlyShift.count(), 1);
    });
    await check("LOCK11", "Solicitudes de base/deuda/conversión/pago/cierres conservan pendiente", async () => {
      const b = await bases.giveBase(driver.id, { cashAmount: 10000 }); const d = await clients.addDebt(client.id, "Deuda", 10000);
      const c = await conversions.createConversion({ branchId: branch.id, amount: 1000, type: "efectivo_a_banco" });
      const pay = await p.driverPayment.create({ data: { driverId: driver.id, branchId: branch.id, amount: 1000, medium: "bank" } });
      const close = await closeDay();
      for (const [entity, id] of [["BaseTransaction", b.id], ["ClientDebt", d.id], ["Conversion", c.id], ["DriverPayment", pay.id]]) {
        await request(entity, id, { amount: { old: "1000", new: "2000" } }); await request(entity, id, {}, "delete");
      }
      await request("ShiftClose", close.id, { totalExpected: { old: "100000", new: "200000" } }); await request("ShiftClose", close.id, {}, "delete");
    });
    await check("LOCK12", "Rutas HTTP de ingreso, egreso, nómina, pedido y webhook cerrado", async () => {
      await closeDay();
      for (const [route, input] of [["/movements", { date: today, category: 1, type: "ingreso", medium: "cash", amount: 1000 }], ["/movements", { date: today, category: 5, type: "egreso", medium: "cash", amount: 1000 }], ["/sd/orders/manual", { branchId: branch.id, driverId: driver.id, deliveryValue: 10000 }]]) {
        assert.equal((await api(route as string, "POST", input)).status, 409);
      }
      const hook = await fetch(origin + "/api/webhooks/shipday/" + branch.id, { method: "POST", headers: { token: "independent-test-token", "Content-Type": "application/json" }, body: JSON.stringify({ event: "ORDER_COMPLETED", order: { id: "closed", delivery_fee: 10000, delivery_time: Date.now() }, carrier: { id: "def-driver" } }) });
      assert.equal(hook.status, 409); assert.equal(await p.shipdayOrder.count(), 0); assert.equal(await p.movement.count(), 0);
    });
    await check("LOCK13", "Gasto pendiente se puede rechazar; aprobarlo tras cierre no cambia caja", async () => {
      const expense = await api("/movements", "POST", { date: today, category: 3, type: "egreso", medium: "cash", amount: 1000 });
      await closeDay(); assert.equal((await api("/movements/" + expense.body.id + "/approve", "POST", {}, admin)).status, 409);
      assert.equal((await p.movement.findUniqueOrThrow({ where: { id: expense.body.id } })).status, "pending");
      assert.equal((await api("/movements/" + expense.body.id + "/reject", "POST", {}, admin)).status, 200);
    });
    await check("LOCK14", "Capital inicial, arqueo alterno y reset no reescriben cierres", async () => {
      await closeDay(); await assert.rejects(() => settings.updateSettings({ initialCash: 1 }), code(409));
      await assert.rejects(() => days.updateArqueo(today, "close", {} as any), code(409));
      await assert.rejects(() => adminSvc.resetAll(), code(409)); assert.equal(await p.shiftClose.count(), 1);
      await settings.updateSettings({ companyName: "Nombre corregido" });
    });
    await check("LOCK15", "Validación y escritura se serializan con el cierre concurrente", async f => {
      let release!: () => void, ready!: () => void;
      const hold = new Promise<void>(r => release = r), entered = new Promise<void>(r => ready = r);
      const closing = moneyTransaction(async () => { await shifts.registerShift({ date: today, shift: "close", expectedAmount: 100000, bankExpected: 100000, bankCounted: 100000, denominations: { bills: [{ value: 100000, qty: 1 }], coins: [] } }); ready(); await hold; });
      await entered; const pending = api("/bank-transactions", "POST", { type: "ingreso", medium: "bank", amount: 10000, description: "En cola" });
      release(); await closing; const r = await pending; f.status = r.status; assert.equal(r.status, 409); assert.equal(await p.bankTransaction.count(), 0);
    });
    await check("LOCK16", "Cierre mensual bloquea origen histórico y permite abono nuevo abierto", async () => {
      const previous = new Date(month + "-01T12:00:00-05:00"); previous.setUTCDate(0); const prior = toBogotaDateStr(previous);
      const old = await bank.create({ type: "ingreso", medium: "bank", amount: 10000, description: "Antiguo", date: previous.toISOString(), noCounterpart: true });
      await clients.addDebt(client.id, "Deuda antigua", 10000, prior);
      const close = await closes.closeMonth(prior.slice(0, 7), undefined, 100000, 100000);
      await assert.rejects(() => bank.remove((old as any).id), code(409)); await assert.rejects(() => bank.edit((old as any).id, { amount: 20000 }), code(409));
      await clients.registerClientPayment(client.id, 1000, false, "bank");
      await request("MonthlyClose", close.id, { initialCash: { old: "100000", new: "1" } });
      assert.deepEqual(await dashboard.getExpectedBalancesForDate(today), { cash: 100000, bank: 101000 });
    });
    await check("LOCK17", "Sondeo simulado no sana/importa entregas de día cerrado", async () => {
      await closeDay();
      globalThis.fetch = (async (input: any, init: any) => {
        const u = String(input); if (u.startsWith("http://127.0.0.1:")) return realFetch(input, init);
        if (u === "https://api.shipday.com/carriers") return new Response(JSON.stringify([{ id: "def-driver", name: "Ficticio" }]));
        if (u === "https://api.shipday.com/orders/query") return new Response(JSON.stringify([{ orderId: "late-poll", deliveryFee: 10000, deliveryTime: new Date().toISOString(), carrier: { id: "def-driver" } }]));
        throw Error("Red bloqueada");
      }) as any;
      // Claude (auditoría final): el pedido cerrado se omite y se reporta en lugar de abortar
      // el ciclo completo (abortar impedía cargar los pedidos abiertos de la misma ventana).
      try { const r = await branches.syncBranch(branch.id, { forceDrivers: true }); assert.equal(r.partial, true); assert.match(r.error!, /late-poll/); assert.equal(await p.shipdayOrder.count(), 0); }
      finally { globalThis.fetch = (async (input: any, init: any) => { if (!String(input).startsWith("http://127.0.0.1:")) throw Error("Red bloqueada"); return realFetch(input, init); }) as any; }
    });
    await check("LOCK18", "Cierre de sucursal bloquea solo su mes; nuevas operaciones abiertas siguen válidas", async () => {
      const previous = new Date(month + "-01T12:00:00-05:00"); previous.setUTCDate(0);
      const b = await bases.giveBase(driver.id, { cashAmount: 10000 }); await p.baseTransaction.update({ where: { id: b.id }, data: { date: previous } });
      await closes.closeMonth(toBogotaDateStr(previous).slice(0, 7), branch.id);
      await assert.rejects(() => bases.editBase(b.id, { amount: 20000 }), code(409)); await assert.rejects(() => bases.removeBase(b.id), code(409));
      await request("BaseTransaction", b.id, { amount: { old: "10000", new: "20000" } });
      await bases.giveBase(driver.id, { cashAmount: 1000 }); assert.equal(await p.baseTransaction.count(), 2);
    });
    await check("LOCK19", "Webhook mixto con entrega cerrada revierte el lote; duplicado cerrado es idempotente", async () => {
      const prev = new Date(today + "T12:00:00-05:00"); prev.setUTCDate(prev.getUTCDate() - 1);
      await p.shiftClose.create({ data: { date: toBogotaDateStr(prev), shift: "close", totalExpected: 100000, totalCounted: 100000, difference: 0, denominations: {} } });
      const event = (id: string, at: Date) => ({ event: "ORDER_COMPLETED", order: { id, delivery_fee: 10000, delivery_time: at.getTime() }, carrier: { id: "def-driver" } });
      const hook = (body: any) => fetch(origin + "/api/webhooks/shipday/" + branch.id, { method: "POST", headers: { token: "independent-test-token", "Content-Type": "application/json" }, body: JSON.stringify(body) });
      assert.equal((await hook([event("open-first", new Date()), event("closed-second", prev)])).status, 409); assert.equal(await p.shipdayOrder.count(), 0);
      assert.equal((await hook(event("valid", new Date()))).status, 200); await closeDay();
      assert.equal((await hook(event("valid", new Date()))).status, 200); assert.equal(await p.shipdayOrder.count(), 1);
    });
    await check("INPUT05", "Abono cliente con medio desconocido no se reclasifica como efectivo", async () => {
      await clients.addDebt(client.id, "Deuda", 10000);
      assert.equal((await api("/clients/" + client.id + "/pay", "POST", { amount: 1000, medium: "card" })).status, 400);
      assert.equal(await p.clientDebtPayment.count(), 0); assert.equal((await p.client.findUniqueOrThrow({ where: { id: client.id } })).pendingDebt, 10000);
    });
    await check("HOUR01", "Saldo por hora inconsistente no confirma un cobro sin movimiento real", async () => {
      await p.hourlyClient.update({ where: { id: hc.id }, data: { pendingDebt: 20000 } });
      await assert.rejects(() => hourly.payClient(hc.id, { amount: 10000, medium: "cash" }), code(400));
      assert.equal((await p.hourlyClient.findUniqueOrThrow({ where: { id: hc.id } })).pendingDebt, 20000); assert.equal(await p.bankTransaction.count(), 0);
    });
    await check("HOUR02", "Editar un turno originalmente sin pago crea el egreso faltante", async () => {
      await hourly.updateHourlyClient(hc.id, { driverHourValue: 0 });
      const s = await hourly.registerShift(hc.id, shiftInput()); assert.equal(await p.bankTransaction.count(), 0);
      await hourly.updateHourlyClient(hc.id, { driverHourValue: 12000 });
      await hourly.editShift(s.id, { endTime: "10:00" });
      assert.equal((await p.hourlyClient.findUniqueOrThrow({ where: { id: hc.id } })).pendingDebt, 40000);
      assert.deepEqual(await dashboard.getExpectedBalancesForDate(today), { cash: 76000, bank: 100000 });
      assert.equal((await p.bankTransaction.findFirstOrThrow()).amount, 24000);
    });
    await check("DATE16", "Día explícito de hoy usa el instante de registro, también antes de mediodía", async () => {
      const early = new Date(today + "T08:00:00-05:00"); assert.equal(parseFinancialTimestamp(today, early).getTime(), early.getTime());
      assert.equal((await api("/bank-transactions", "POST", { type: "ingreso", medium: "bank", amount: 1000, description: "Día actual", date: today, noCounterpart: true })).status, 201);
      const d = await clients.addDebt(client.id, "Hoy", 1000, today, undefined, "cash"); assert.ok(d.createdAt.getTime() <= Date.now());
      assert.deepEqual(await dashboard.getExpectedBalancesForDate(today), { cash: 99000, bank: 101000 });
    });
    await check("INPUT04", "Webhook con fecha imposible/futura se rechaza sin filas", async () => {
      for (const date of ["2026-02-31T12:00:00-05:00", "invalid", Date.now() + 86400000]) {
        const r = await fetch(origin + "/api/webhooks/shipday/" + branch.id, { method: "POST", headers: { token: "independent-test-token", "Content-Type": "application/json" }, body: JSON.stringify({ event: "ORDER_COMPLETED", order: { id: "bad-date", delivery_fee: 10000, delivery_time: date }, carrier: { id: "def-driver" } }) });
        assert.equal(r.status, 400);
      } assert.equal(await p.shipdayOrder.count(), 0);
    });
    await check("TZ01", "Límite Bogotá: 00:01 UTC pertenece al día anterior cerrado", async () => {
      const at = new Date(today + "T00:01:00Z"), previousDay = toBogotaDateStr(at); assert.ok(previousDay < today);
      await p.shiftClose.create({ data: { date: previousDay, shift: "close", totalExpected: 100000, totalCounted: 100000, difference: 0, denominations: {} } });
      assert.equal((await api("/bank-transactions", "POST", { type: "ingreso", medium: "bank", amount: 1000, description: "UTC", date: at.toISOString() })).status, 409);
    });
    await check("INTEGRATED", "Aceptación HTTP completa, matemáticas independientes y reinicio", async f => {
      assert.equal((await api("/bank-transactions", "POST", { type: "ingreso", medium: "bank", amount: 30000, description: "Ingreso", noCounterpart: true })).status, 201);
      const expense = await api("/movements", "POST", { date: today, category: 3, type: "egreso", medium: "cash", amount: 10000 });
      assert.equal((await api("/movements/" + expense.body.id + "/approve", "POST", {}, admin)).status, 200);
      assert.equal((await api("/sd/conversions", "POST", { branchId: branch.id, amount: 5000, type: "efectivo_a_banco" })).status, 201);
      assert.equal((await api("/sd/orders/manual", "POST", { branchId: branch.id, driverId: driver.id, deliveryValue: 10000, orderNumber: "FICTICIO-1" })).status, 201);
      assert.equal((await api("/sd/bases/" + driver.id + "/give", "POST", { cashAmount: 20000, bankAmount: 5000 })).status, 201);
      assert.equal((await api("/sd/bases/" + driver.id + "/pay", "POST", { cashAmount: 5000 })).status, 201);
      assert.equal((await api("/sd/drivers/" + driver.id + "/payment", "POST", { amount: 8000, medium: "bank" })).status, 201);
      await clients.addDebt(client.id, "Préstamo", 20000, undefined, undefined, "cash");
      await clients.registerClientPayment(client.id, 7000, false, "bank");
      assert.equal((await api("/hourly-clients/" + hc.id + "/shifts", "POST", shiftInput())).status, 201);
      assert.equal((await api("/hourly-clients/" + hc.id + "/pay", "POST", { amount: 4000, medium: "cash" })).status, 200);
      const a = await api("/bank-transactions", "POST", { type: "egreso", cashAmount: 2000, bankAmount: 3000, amount: 5000, description: "Mixto" });
      assert.equal((await api("/bank-transactions", "POST", { type: "ingreso", medium: "cash", amount: 5000, description: "Retorno", pairWith: a.body.parts[0].id })).status, 201);
      assert.equal((await api("/movements", "POST", { date: today, category: 5, type: "egreso", medium: "cash", amount: 2000 })).status, 201);
      await drivers.registerPayment(driver.id, 18000, "cash"); await drivers.payCredit(driver.id, "bank");
      // 100000 -10000 -5000 -20000 +5000 -20000 -12000 +4000 -2000 +5000 -2000 +18000 = 61000.
      // 100000 +30000 +5000 -5000 +8000 +7000 -3000 -3000 = 139000.
      const expected = { cash: 61000, bank: 139000 };
      f.expected = expected; assert.deepEqual(await dashboard.getExpectedBalancesForDate(today), expected);
      assert.equal((await p.client.findUniqueOrThrow({ where: { id: client.id } })).pendingDebt, 13000);
      assert.equal((await p.hourlyClient.findUniqueOrThrow({ where: { id: hc.id } })).pendingDebt, 16000);
      const d = await p.driver.findUniqueOrThrow({ where: { id: driver.id } }); assert.equal(d.pendingDebt, 0); assert.equal(d.creditAmount, 0);
      const summary = await days.getDaySummary(today); assert.equal(summary.finalCash, 61000); assert.equal(summary.finalBank, 139000);
      const report = await api("/sd/report/" + month); assert.equal(report.status, 200); assert.equal(report.body.totalSales, 3000); assert.equal(report.body.clientDebt.balance, 29000);
      await excelTransfer(0);
      assert.equal((await api("/settings", "PATCH", { initialCash: 1 }, user)).status, 403);
      const close = await closeDay(); assert.equal(close.totalExpected, 61000); assert.equal(close.bankExpected, 139000); assert.equal(close.difference, 0); assert.equal(close.bankDifference, 0);
      assert.equal((await api("/movements/" + expense.body.id, "DELETE", undefined, admin)).status, 400); // ruta de gastos exige solicitud
      await request("Movement", expense.body.id, { amount: { old: "10000", new: "1" } });
      const previous = new Date(month + "-01T12:00:00-05:00"); previous.setUTCDate(0);
      await closes.closeMonth(toBogotaDateStr(previous).slice(0, 7), undefined, 100000, 100000);
      assert.deepEqual(await dashboard.getExpectedBalancesForDate(today), expected);
      const next = (await api("/shifts/current-date")).body.date;
      assert.equal((await api("/movements", "POST", { date: next, category: 1, type: "ingreso", medium: "cash", amount: 2000 })).status, 201);
      assert.deepEqual(await dashboard.getExpectedBalancesForDate(next), { cash: 102000, bank: 100000 });
      await stop(); await p.$disconnect(); await start();
      assert.equal((await api("/auth/login", "POST", { email: user.email, password: "Ficticio-Only-2026" }, null)).status, 200);
      assert.deepEqual(await dashboard.getExpectedBalancesForDate(today), expected);
      assert.equal((await p.client.findUniqueOrThrow({ where: { id: client.id } })).pendingDebt, 13000);
      assert.equal((await p.hourlyClient.findUniqueOrThrow({ where: { id: hc.id } })).pendingDebt, 16000);
      assert.equal(await p.monthlyClose.count(), 1); assert.equal(await p.shiftClose.count(), 1); await excelTransfer(0);
      f.afterRestart = await dashboard.getExpectedBalancesForDate(today);
    });
    await check("LOCK20", "Escritura en otro proceso esperando cierre usa instante posterior al candado", async f => {
      const other = new PrismaClient(); let release!: () => void, ready!: () => void;
      const hold = new Promise<void>(r => release = r), locked = new Promise<void>(r => ready = r);
      const closeWork = other.$transaction(async tx => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(20260928, 1)`; ready(); await hold;
        // Simula otro proceso que termina el cierre mientras el pago espera el mismo candado.
        const at = new Date();
        await tx.monthlyClose.create({ data: { month: "2020-01", initialCash: 100000, initialBank: 100000, closedAt: at, totalOrders: 0, totalValue: 0, companyTotal: 0, basesGiven: 0, basesPaid: 0, basesPending: 0, conversions: {}, snapshot: { capitalAnterior: { cash: 100000, bank: 100000 } } } });
        return at;
      });
      try {
        await locked; const pending = bases.giveBase(driver.id, { cashAmount: 10000 });
        await new Promise(r => setTimeout(r, 150)); release(); const cut = await closeWork; const base = await pending;
        f.closeAt = cut.toISOString(); f.baseAt = base.date.toISOString(); f.actual = await dashboard.getExpectedBalancesForDate(today);
        assert.ok(base.date > cut); assert.deepEqual(f.actual, { cash: 90000, bank: 100000 });
      } finally { release(); await closeWork.catch(() => {}); await other.$disconnect(); }
    });
  } finally {
    fs.writeFileSync(path.join(__dirname, "codex-definitive.json"), JSON.stringify(results, null, 2));
    await stop(); await p.$disconnect(); globalThis.fetch = realFetch;
    console.log("TOTAL " + results.length + " OK " + results.filter(r => r.ok).length + " FAIL " + results.filter(r => !r.ok).length);
    if (results.some(r => !r.ok)) process.exitCode = 1;
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
