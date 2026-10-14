/**
 * Conciliación PESO A PESO (solo lectura). Recorre en orden cronológico cada registro que mueve
 * caja o banco, con la misma regla de inclusión que el saldo esperado de la app, y comprueba que
 * capital + movimientos = saldo esperado. Separa los registros puramente contables (bank-linked,
 * regularización F14, pedidos, deudas sin desembolso) que NO mueven dinero.
 * Uso: DATABASE_URL=<cashbuddy_demo o temporal> node node_modules/tsx/dist/cli.mjs apps/api/tests/conciliacion-demo.ts
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const db = new URL(process.env.DATABASE_URL || "invalid:");
if (!["localhost", "127.0.0.1"].includes(db.hostname) || db.pathname === "/cashbuddy") throw Error("Solo bases locales de prueba/DEMO");

async function main() {
  const SRC = pathToFileURL(path.resolve(__dirname, "../src")).href;
  const { prisma: p } = await import(`${SRC}/lib/prisma.ts`);
  const dash = await import(`${SRC}/services/shipday-dashboard.service.ts`);
  const { todayBogota, toBogotaDateStr } = await import(`${SRC}/lib/date-range.ts`);
  const { isBankLinkedBaseNote, isBankLinkedPaymentNote } = await import(`${SRC}/lib/balance-markers.ts`);
  const { movementEffectiveAt } = await import(`${SRC}/lib/period-guard.ts`);
  const today = todayBogota();
  const s = await p.settings.findUniqueOrThrow({ where: { id: "singleton" } });
  if (await p.monthlyClose.count()) throw Error("Con cierres mensuales el ancla cambia; este guion concilia desde el capital de Configuración.");
  type Row = { at: Date; id: string; fuente: string; detalle: string; persona: string; medio: string; dCash: number; dBank: number };
  const rows: Row[] = []; const contables: any[] = [];
  const drivers = new Map((await p.driver.findMany({ select: { id: true, name: true } })).map((d: any) => [d.id, d.name]));
  for (const m of await p.movement.findMany()) {
    if (m.status !== "confirmed") { contables.push({ id: m.id, fuente: "Movement pendiente/rechazado", monto: m.amount }); continue; }
    const sg = m.type === "ingreso" ? 1 : -1;
    rows.push({ at: movementEffectiveAt(m), id: m.id, fuente: `Caja cat.${m.category}`, detalle: m.description ?? "", persona: "", medio: m.medium, dCash: m.medium === "cash" ? sg * m.amount : 0, dBank: m.medium === "bank" ? sg * m.amount : 0 });
  }
  for (const t of await p.bankTransaction.findMany()) {
    const sg = t.type === "ingreso" ? 1 : -1;
    rows.push({ at: t.date, id: t.id, fuente: `Banco ${t.type}${t.pairId ? " (par)" : ""}${t.debtApplied ? " (aplicado)" : ""}`, detalle: t.description, persona: t.driverName ?? "", medio: t.medium ?? "bank", dCash: t.medium === "cash" ? sg * t.amount : 0, dBank: t.medium !== "cash" ? sg * t.amount : 0 });
  }
  for (const c of await p.conversion.findMany()) rows.push({ at: c.date, id: c.id, fuente: "Conversión " + c.type, detalle: "", persona: "", medio: "ambos", dCash: c.type === "banco_a_efectivo" ? c.amount : -c.amount, dBank: c.type === "banco_a_efectivo" ? -c.amount : c.amount });
  for (const d of await p.driverPayment.findMany()) {
    if (isBankLinkedPaymentNote(d.notes)) { contables.push({ id: d.id, fuente: "DriverPayment interno (ya contado en su movimiento)", monto: d.amount, persona: drivers.get(d.driverId) }); continue; }
    rows.push({ at: d.date, id: d.id, fuente: "Pago domiciliario (directo)", detalle: d.notes ?? "", persona: drivers.get(d.driverId) ?? "", medio: d.medium, dCash: d.medium === "cash" ? d.amount : 0, dBank: d.medium === "bank" ? d.amount : 0 });
  }
  for (const b of await p.baseTransaction.findMany()) {
    if (b.type === "pago" && isBankLinkedBaseNote(b.notes)) { contables.push({ id: b.id, fuente: b.notes?.startsWith("Regularización") ? "Regularización F14 (sin caja)" : "Devolución de base interna (ya contada en su movimiento)", monto: b.amount, persona: drivers.get(b.driverId) }); continue; }
    const cash = b.cashAmount || (b.bankAmount ? 0 : b.amount), sg = b.type === "entrega" ? -1 : 1;
    rows.push({ at: b.date, id: b.id, fuente: b.type === "entrega" ? "Base entregada" : "Base devuelta", detalle: b.notes ?? "", persona: drivers.get(b.driverId) ?? "", medio: b.bankAmount && cash ? "mixto" : b.bankAmount ? "bank" : "cash", dCash: sg * cash, dBank: sg * b.bankAmount });
  }
  for (const cp of await p.clientDebtPayment.findMany()) rows.push({ at: cp.paidAt, id: cp.id, fuente: "Abono cliente", detalle: "", persona: "", medio: cp.paidBank && cp.paidCash ? "mixto" : cp.paidBank ? "bank" : "cash", dCash: cp.paidCash, dBank: cp.paidBank });
  for (const d of await p.clientDebt.findMany()) {
    if (!d.medium) { contables.push({ id: d.id, fuente: "Deuda de cliente sin desembolso", monto: d.amount }); continue; }
    rows.push({ at: d.createdAt, id: d.id, fuente: "Préstamo a cliente", detalle: d.description, persona: "", medio: d.medium, dCash: d.medium === "cash" ? -d.amount : 0, dBank: d.medium === "bank" ? -d.amount : 0 });
  }
  const orders = await p.shipdayOrder.aggregate({ _count: { id: true }, _sum: { deliveryValue: true, companyAmount: true } });
  contables.push({ fuente: "Pedidos (no mueven caja: comisión → deuda del domiciliario)", cantidad: orders._count.id, valor: orders._sum.deliveryValue, comision: orders._sum.companyAmount });
  rows.sort((a, b) => a.at.getTime() - b.at.getTime() || a.id.localeCompare(b.id));
  let cash = s.initialCash, bank = s.initialBank;
  const lines = rows.map((r, i) => { const pc = cash, pb = bank; cash += r.dCash; bank += r.dBank;
    return `| ${i + 1} | ${r.id.slice(-8)} | ${toBogotaDateStr(r.at)} | ${r.fuente} | ${r.detalle.replace(/\|/g, "/").slice(0, 60)} | ${r.persona} | ${r.medio} | ${r.dCash} | ${r.dBank} | ${pc} → ${cash} | ${pb} → ${bank} |`; });
  const exp = await dash.getExpectedBalancesForDate(today);
  const ok = exp.cash === cash && exp.bank === bank;
  const md = [`Capital inicial: efectivo ${s.initialCash} · banco ${s.initialBank}`, "",
    "| # | Id | Fecha | Fuente | Detalle | Domiciliario | Medio | Δ efectivo | Δ banco | Efectivo antes → después | Banco antes → después |", "|---|---|---|---|---|---|---|---:|---:|---|---|", ...lines, "",
    `**Saldo reconstruido:** efectivo ${cash} · banco ${bank}. **Saldo esperado de la app:** efectivo ${exp.cash} · banco ${exp.bank}. **${ok ? "CUADRA" : "DIFERENCIA"}**`].join("\n");
  fs.writeFileSync(path.join(__dirname, "conciliacion-demo.md"), md);
  fs.writeFileSync(path.join(__dirname, "conciliacion-demo.json"), JSON.stringify({ ok, cash, bank, expected: exp, rows: rows.length, contables }, null, 2));
  console.log(JSON.stringify({ ok, reconstruido: { cash, bank }, esperado: exp, registros: rows.length, contables: contables.length }));
  await p.$disconnect();
  if (!ok) process.exitCode = 1;
}
main().catch(e => { console.error(e); process.exit(1); });
