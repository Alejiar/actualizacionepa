/**
 * Ejecuta por API los escenarios E3–E18 de GUIA_MANUAL_PRUEBAS_EPA.md sobre una COPIA de la DEMO
 * (BD temporal `cashbuddy_claude_guia` restaurada de un respaldo) y comprueba cada saldo escrito
 * en la guía. Nunca contra `cashbuddy_demo` ni `cashbuddy`.
 */
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const db = new URL(process.env.DATABASE_URL || "invalid:");
if (db.pathname !== "/cashbuddy_claude_guia" || !["localhost", "127.0.0.1"].includes(db.hostname)) throw Error("Solo la copia temporal cashbuddy_claude_guia");
const BASE = process.env.BASE_URL || "http://127.0.0.1:4918";
const PASS = process.env.DEMO_PASS!;

async function main() {
  const SRC = pathToFileURL(path.resolve(__dirname, "../src")).href;
  const { prisma: p } = await import(`${SRC}/lib/prisma.ts`);
  const { todayBogota } = await import(`${SRC}/lib/date-range.ts`);
  const today = todayBogota(), month = today.slice(0, 7);
  const login = async (email: string) => (await (await fetch(BASE + "/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password: PASS }) })).json() as any).token as string;
  const admin = await login("admin@epa.demo"), oper = await login("operador@epa.demo");
  async function api(route: string, method = "GET", body?: unknown, tok = oper) {
    const r = await fetch(BASE + "/api" + route, { method, headers: { "Content-Type": "application/json", Authorization: "Bearer " + tok }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => null) as any };
  }
  async function ok(route: string, method = "GET", body?: unknown, tok = oper) { const r = await api(route, method, body, tok); if (r.status >= 300) throw Error(`${method} ${route} → ${r.status} ${JSON.stringify(r.body)}`); return r.body; }
  const bal = async () => { const e = await ok(`/shifts/${today}/expected`, "GET", undefined, admin); return [e.expectedCash, e.expectedBank]; };
  const out: string[] = [];
  const expect = async (label: string, cash: number, bank: number) => { assert.deepEqual(await bal(), [cash, bank], label); out.push(`OK ${label}: ${cash} / ${bank}`); };
  const drv = async (name: string) => (await ok("/sd/drivers", "GET", undefined, admin)).find((d: any) => d.name === name);

  await expect("E2 saldos de partida", 118600, 122400);
  let A = await drv("Domiciliario Demo A"); assert.deepEqual([A.pendingDebt, A.basePending], [5400, 9600]); out.push("OK E2 Demo A 5.400 / 9.600");
  await ok("/bank-transactions", "POST", { type: "ingreso", medium: "bank", amount: 30000, description: "E3", noCounterpart: true }); await expect("E3", 118600, 152400);
  const g = await ok("/movements", "POST", { date: today, category: 3, type: "egreso", medium: "cash", amount: 10000, description: "E4" }); await expect("E4 pendiente", 118600, 152400);
  await ok(`/movements/${g.id}/approve`, "POST", {}, admin); await expect("E4 aprobado", 108600, 152400);
  const o = await ok("/bank-transactions", "POST", { type: "egreso", medium: "bank", amount: 20000, description: "E5" });
  assert.notEqual((await api("/bank-transactions", "POST", { type: "ingreso", medium: "cash", amount: 19000, description: "E5 mal", pairWith: o.id })).status, 201);
  await ok("/bank-transactions", "POST", { type: "ingreso", medium: "cash", amount: 20000, description: "E5 contraparte", pairWith: o.id }); await expect("E5", 128600, 132400);
  const c = await ok("/clients", "POST", { name: "Cliente prueba" }); await ok(`/clients/${c.id}/debt`, "POST", { description: "Fiado", amount: 20000 });
  await ok(`/clients/${c.id}/pay`, "POST", { amount: 5000, medium: "cash" }); await expect("E6", 133600, 132400);
  assert.equal((await api(`/clients/${c.id}/pay`, "POST", { amount: 99999, medium: "cash" })).status, 400);
  const fict = (await ok("/branches", "GET", undefined, admin)).find((b: any) => b.name.includes("ficticia"));
  await ok(`/branches/${fict.id}`, "PATCH", { active: true }, admin);
  let B = await drv("Domiciliario Demo B");
  await ok("/sd/orders/manual", "POST", { branchId: fict.id, driverId: B.id, deliveryValue: 10000, orderNumber: "E7" });
  await ok(`/branches/${fict.id}`, "PATCH", { active: false }, admin);
  B = await drv("Domiciliario Demo B"); assert.equal(B.pendingDebt, 3000); await expect("E7", 133600, 132400);
  await ok(`/sd/drivers/${B.id}/payment`, "POST", { amount: 3000, medium: "cash", baseAmount: 0 }); await expect("E8", 136600, 132400);
  assert.equal((await api(`/sd/drivers/${A.id}/payment`, "POST", { amount: 20000, medium: "cash", baseAmount: 15000 })).status, 400);
  await ok(`/sd/drivers/${A.id}/payment`, "POST", { amount: 10000, medium: "cash", baseAmount: 4600 });
  A = await drv("Domiciliario Demo A"); assert.deepEqual([A.pendingDebt, A.basePending], [0, 5000]); await expect("E9", 146600, 132400);
  await ok(`/sd/bases/${B.id}/give`, "POST", { cashAmount: 10000 }); B = await drv("Domiciliario Demo B"); assert.deepEqual([B.pendingDebt, B.basePending], [0, 10000]); await expect("E10 entrega", 136600, 132400);
  await ok(`/sd/bases/${B.id}/pay`, "POST", { cashAmount: 10000 }); await expect("E10 devolución", 146600, 132400);
  const hc = (await ok("/hourly-clients")).find((h: any) => h.name === "Cliente por hora DEMO");
  await ok(`/hourly-clients/${hc.id}/shifts`, "POST", { driverId: B.id, startTime: "08:00", endTime: "09:00", medium: "cash" }); await expect("E11 turno", 136600, 132400);
  await ok(`/hourly-clients/${hc.id}/pay`, "POST", { amount: 15000, medium: "bank" }); await expect("E11 cobro", 136600, 147400);
  const rep = await ok(`/sd/report/${month}`, "GET", undefined, admin);
  assert.deepEqual([rep.totalSales, rep.expenses.total, rep.bases.previous, rep.bases.given, rep.bases.returned, rep.bases.diff, rep.commission.pending, rep.transfers.diff, rep.clientDebt.balance], [96600, 20000, 0, 40000, 35000, 5000, 72600, 0, 30000]);
  out.push("OK E12 reporte: ventas 96.600, gastos 20.000, bases 0+40.000−35.000=5.000, comisiones 72.600, contrapartes 0, clientes 30.000");
  const s = await ok(`/days/${today}/summary`, "GET", undefined, admin); assert.equal(s.finalTotal, 284000); assert.equal(s.initialTotal + s.ingresos - s.egresos, s.finalTotal); out.push("OK E12 Historial 284.000");
  // E13 — tarifas: el turno ya registrado no cambia.
  assert.equal((await api(`/hourly-clients/${hc.id}`, "PATCH", { driverHourValue: 0, companyHourValue: 0 })).status, 400);
  await ok(`/hourly-clients/${hc.id}`, "PATCH", { driverHourValue: 12000, companyHourValue: 6000 });
  const e11 = (await ok("/hourly-shifts")).find((x: any) => x.hourlyClientId === hc.id && x.startTime === "08:00" && x.endTime === "09:00" && x.date === today);
  assert.equal(e11.totalAmount, 15000); await expect("E13 tarifas (caja igual)", 136600, 147400);
  // E14 — turno que cruza medianoche.
  const warn = await api(`/hourly-clients/${hc.id}/shifts`, "POST", { driverId: B.id, startTime: "10:00", endTime: "09:00", medium: "cash" });
  assert.equal(warn.status, 409); assert.match(warn.body.error, /termina mañana .* 23 horas/);
  assert.deepEqual([warn.body.details.driverAmount, warn.body.details.companyAmount, warn.body.details.totalAmount], [276000, 138000, 414000]);
  await expect("E14 aviso 23 h sin guardar", 136600, 147400);
  const w2 = await api(`/hourly-clients/${hc.id}/shifts`, "POST", { driverId: B.id, startTime: "22:00", endTime: "00:00", medium: "cash" });
  assert.deepEqual([w2.body.details.driverAmount, w2.body.details.companyAmount, w2.body.details.totalAmount], [24000, 12000, 36000]);
  await ok(`/hourly-clients/${hc.id}/shifts`, "POST", { driverId: B.id, startTime: "22:00", endTime: "00:00", medium: "cash", confirmOvernight: true });
  assert.equal((await api(`/hourly-clients/${hc.id}/shifts`, "POST", { driverId: B.id, startTime: "11:00", endTime: "11:00", medium: "cash" })).status, 400);
  assert.equal((await api(`/hourly-clients/${hc.id}/shifts`, "POST", { driverId: B.id, startTime: "22:00", endTime: "00:00", medium: "cash", confirmOvernight: true })).status, 409);
  assert.equal((await ok("/hourly-clients")).find((h: any) => h.id === hc.id).pendingDebt, 36000);
  await expect("E14 turno nocturno confirmado", 112600, 147400);
  // E15 — trabajadores.
  const wk = await ok("/workers", "POST", { name: "Auxiliar prueba", role: "administrativo", active: true });
  await ok("/movements", "POST", { date: today, category: 15, type: "egreso", medium: "cash", amount: 5000, workerId: wk.id, description: "E15" });
  await expect("E15 nómina", 107600, 147400);
  await ok(`/workers/${wk.id}`, "PATCH", { name: "Auxiliar renombrado" });
  assert.equal((await api(`/workers/${wk.id}`, "PATCH", { name: "" })).status, 400);
  await ok(`/workers/${wk.id}`, "PATCH", { active: false });
  assert.equal((await api("/movements", "POST", { date: today, category: 15, type: "egreso", medium: "cash", amount: 1000, workerId: wk.id })).status, 400);
  assert.equal((await api(`/workers/${wk.id}`, "DELETE", undefined, oper)).status, 403);
  assert.equal((await api(`/workers/${wk.id}`, "DELETE", undefined, admin)).status, 409);
  await ok(`/workers/${wk.id}`, "PATCH", { active: true });
  assert.equal(await p.movement.count({ where: { workerId: wk.id } }), 1); out.push("OK E15 renombrar/desactivar con historial conservado");
  // E16 — Cierre.
  const close = await ok("/shifts", "POST", { date: today, shift: "close", denominations: { bills: [{ value: 1, qty: 107600 }], coins: [] }, bankCounted: 147400 }, admin);
  assert.deepEqual([close.difference, close.bankDifference], [0, 0]); out.push("OK E16 cierre 107.600 / 147.400, diferencias 0");
  assert.equal((await api("/bank-transactions", "POST", { type: "ingreso", medium: "cash", amount: 1, description: "tras cierre", noCounterpart: true })).status, 409);
  // E17 — D7.
  const req = await ok("/edit-requests", "POST", { requestType: "create", entityType: "BankTransaction", entityId: "nuevo", entityLabel: "", changes: { date: today, type: "egreso", medium: "cash", amount: 1000, description: "Olvido de prueba" }, reason: "Prueba D7" });
  await ok(`/edit-requests/${req.id}/review`, "POST", { action: "approved" }, admin); await expect("E17 corregido", 106600, 147400);
  const sc = await p.shiftClose.findFirstOrThrow({ where: { date: today, shift: "close" } });
  assert.deepEqual([sc.totalCounted, sc.difference, (sc.corrections as any[]).length, (sc.corrections as any[])[0].cashDelta], [107600, 0, 1, -1000]);
  assert.equal((await ok(`/days/${today}/summary`, "GET", undefined, admin)).cajaCuadrada, true); out.push("OK E17 conteo original 107.600 dif 0; corrección −1.000; semáforo verde");
  // E18 — pedido manual después del Cierre.
  await ok(`/branches/${fict.id}`, "PATCH", { active: true }, admin);
  const comBefore = (await ok(`/days/${today}/summary`, "GET", undefined, admin)).comision;
  await ok("/sd/orders/manual", "POST", { branchId: fict.id, driverId: A.id, deliveryValue: 40000, orderNumber: "POST-CIERRE", deliveredAt: today });
  assert.equal((await api("/sd/orders/manual", "POST", { branchId: fict.id, driverId: A.id, deliveryValue: 40000, orderNumber: "POST-CIERRE", deliveredAt: today })).status, 409);
  await ok(`/branches/${fict.id}`, "PATCH", { active: false }, admin);
  A = await drv("Domiciliario Demo A"); assert.deepEqual([A.pendingDebt, A.basePending], [12000, 5000]);
  await expect("E18 pedido tras el Cierre (caja igual)", 106600, 147400);
  const s18 = await ok(`/days/${today}/summary`, "GET", undefined, admin);
  assert.equal(s18.comision, comBefore + 12000); assert.equal(s18.cajaCuadrada, true);
  assert.equal((await p.shiftClose.findFirstOrThrow({ where: { date: today, shift: "close" } })).totalCounted, 107600);
  assert.equal((await ok(`/sd/report/${month}`, "GET", undefined, admin)).totalSales, 108600);
  out.push("OK E18 comisión A 12.000, ventas 108.600, Cierre intacto");
  console.log(out.join("\n")); console.log("GUIA OK");
  await p.$disconnect();
}
main().catch(e => { console.error("FALLA:", e.message); process.exit(1); });
