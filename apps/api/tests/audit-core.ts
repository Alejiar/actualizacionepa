import { pathToFileURL } from "node:url";
import path from "node:path";
/**
 * Reproducción de hallazgos de auditoría. SOLO contra la BD aislada cashbuddy_audit.
 * Ejecuta el código REAL de servicios/controladores y compara contra el valor contable correcto.
 */
const DB = process.env.DATABASE_URL ?? "";
if (new URL(DB).pathname !== "/cashbuddy_codex_test_fixes") {
  console.error("ABORTADO: DATABASE_URL no apunta a cashbuddy_audit");
  process.exit(2);
}
process.env.WEBHOOK_TOKEN = "audit-token"; // antes de importar el webhook (se lee al cargar el módulo)
// Reproducciones futuras: nunca contactar la API externa, ni con claves ficticias.
globalThis.fetch = async () => new Response('API externa simulada por auditoría', { status: 401 });

const SRC = pathToFileURL(path.resolve(__dirname,"../src")).href;

async function main() {
  const { prisma } = await import(`${SRC}/lib/prisma.ts`);
  const driverSvc = await import(`${SRC}/services/driver.service.ts`);
  const baseSvc = await import(`${SRC}/services/base.service.ts`);
  const bankSvc = await import(`${SRC}/services/bank-transaction.service.ts`);
  const editSvc = await import(`${SRC}/services/edit-request.service.ts`);
  const closeSvc = await import(`${SRC}/services/close.service.ts`);
  const branchSvc = await import(`${SRC}/services/branch.service.ts`);
  const dashSvc = await import(`${SRC}/services/shipday-dashboard.service.ts`);
  const { shipdayWebhook } = await import(`${SRC}/controllers/webhook.controller.ts`);
  const { manualCreate } = await import(`${SRC}/controllers/order.controller.ts`);

  await prisma.settings.create({data:{id:"singleton",shipdayCommission:30}}); const admin = await prisma.user.create({data:{email:"audit@example.invalid",name:"Audit",passwordHash:"not-a-login",role:"admin"}});
  const settings = await prisma.settings.findUnique({ where: { id: "singleton" } });
  const results: { id: string; titulo: string; obtenido: unknown; correcto: unknown; reproduce: boolean }[] = [];
  const report = (id: string, titulo: string, obtenido: unknown, correcto: unknown) => {
    const reproduce = JSON.stringify(obtenido) !== JSON.stringify(correcto);
    results.push({ id, titulo, obtenido, correcto, reproduce });
  };

  const branch = await prisma.branch.create({ data: { name: "AUD-branch", apiKeyEnc: "no-valida" } });
  let seq = 0;
  const newDriver = (tag: string, b = branch.id) =>
    prisma.driver.create({ data: { shipdayDriverId: `aud-${tag}-${++seq}`, branchId: b, name: `AUD ${tag}` } });
  const state = async (id: string) => {
    const d = await prisma.driver.findUniqueOrThrow({ where: { id } });
    return { pendingDebt: d.pendingDebt, creditAmount: d.creditAmount };
  };
  const mockRes = () => {
    const r: { code: number; body: unknown; status: (c: number) => typeof r; json: (b: unknown) => typeof r } = {
      code: 200, body: null,
      status(c) { this.code = c; return this; },
      json(b) { this.body = b; return this; },
    };
    return r;
  };
  // Pedido por el WEBHOOK real (mismo camino que producción).
  const webhookOrder = async (d: { shipdayDriverId: string }, value: number, deliveredAt = new Date(), b = branch.id) => {
    const orderId = `aud-order-${++seq}`;
    const res = mockRes();
    await shipdayWebhook(
      { params: { branchId: b }, headers: { token: "audit-token" }, query: {}, body: {
        event: "ORDER_COMPLETED", order_status: "ALREADY_DELIVERED",
        order: { id: orderId, order_number: String(seq), delivery_fee: value, delivery_time: deliveredAt.getTime() },
        carrier: { id: d.shipdayDriverId, name: "x" },
      } } as never,
      res as never,
    );
    return prisma.shipdayOrder.findUniqueOrThrow({ where: { shipdayOrderId: orderId } });
  };
  const approveEdit = async (entityType: string, entityId: string, changes: Record<string, { old: string; new: string }>) => {
    const r = await editSvc.createRequest({ requesterId: admin.id, entityType, entityId, entityLabel: "aud", changes, reason: "auditoría" });
    await editSvc.reviewRequest(r.id, admin.id, "approved");
  };
  const approveDelete = async (entityType: string, entityId: string) => {
    const r = await editSvc.createRequest({ requesterId: admin.id, entityType, entityId, entityLabel: "aud", changes: {}, reason: "auditoría", requestType: "delete" });
    await editSvc.reviewRequest(r.id, admin.id, "approved");
  };
  const pct = settings?.shipdayCommission ?? 30;
  console.log(`Comisión configurada: ${pct}%`);

  // R1 — Editar valor de pedido (aprobado) con crédito a favor: incremento crudo, no netea.
  {
    const d = await newDriver("R1");
    const o = await webhookOrder(d, 50000);                 // debe 15.000
    await driverSvc.registerPayment(d.id, 25000, "cash");   // paga 25.000 → crédito 10.000
    await approveEdit("ShipdayOrder", o.id, { deliveryValue: { old: "50000", new: "60000" } }); // +3.000 comisión
    report("R1", "Editar valor de pedido con crédito a favor deja deuda y crédito positivos a la vez",
      await state(d.id), { pendingDebt: 0, creditAmount: 7000 });
  }
  // R2 — Bajar el valor de un pedido ya pagado deja pendingDebt NEGATIVO.
  {
    const d = await newDriver("R2");
    const o = await webhookOrder(d, 100000);                // debe 30.000
    await driverSvc.registerPayment(d.id, 30000, "cash");   // saldado
    await approveEdit("ShipdayOrder", o.id, { deliveryValue: { old: "100000", new: "50000" } }); // −15.000
    const st = await state(d.id);
    const debts = await dashSvc.getDebtsDashboard(branch.id);
    const visible = [...debts.debtors, ...debts.creditors].some((x: { id: string }) => x.id === d.id);
    report("R2", "Bajar valor de pedido ya pagado deja pendingDebt negativo e invisible en Deudas",
      { ...st, visibleEnDeudas: visible }, { pendingDebt: 0, creditAmount: 15000, visibleEnDeudas: true });
  }
  // R3 — Editar pedido entregado de noche: DailyDriverStat se busca con fecha UTC y no se ajusta.
  {
    const d = await newDriver("R3");
    const when = new Date("2026-09-10T21:30:00-05:00");
    const o = await webhookOrder(d, 10000, when);
    await approveEdit("ShipdayOrder", o.id, { deliveryValue: { old: "10000", new: "20000" } });
    const stat = await prisma.dailyDriverStat.findUnique({ where: { date_driverId: { date: "2026-09-10", driverId: d.id } } });
    report("R3", "Editar pedido entregado después de 7pm no ajusta la estadística diaria (llave UTC)",
      { totalValue: stat?.totalValue, companyTotal: stat?.companyTotal }, { totalValue: 20000, companyTotal: Math.round(20000 * pct / 100) });
  }
  // R4 — Editar el VALOR de un cobro a domiciliario (BankTransaction) no ajusta la deuda ni debtApplied.
  {
    const d = await newDriver("R4");
    await webhookOrder(d, 100000);                          // debe 30.000
    await driverSvc.registerPayment(d.id, 20000, "cash");   // debe 10.000
    const tx = await prisma.bankTransaction.findFirstOrThrow({ where: { driverId: d.id } });
    await approveEdit("BankTransaction", tx.id, { amount: { old: "20000", new: "15000" } });
    const tx2 = await prisma.bankTransaction.findUniqueOrThrow({ where: { id: tx.id } });
    const linked = await prisma.driverPayment.aggregate({ where: { bankTransactionId: tx.id }, _sum: { amount: true } });
    report("R4", "Corregir el valor de un cobro (Movimientos → editar) no corrige la deuda",
      { cobroRegistrado: tx2.amount, debtApplied: tx2.debtApplied, pagoContableVinculado: linked._sum.amount, ...(await state(d.id)) },
      { cobroRegistrado: 15000, debtApplied: 15000, pagoContableVinculado: 15000, pendingDebt: 15000, creditAmount: 0 });
  }
  // R5 — Editar una base (aprobado) con crédito a favor: incremento crudo → pendingDebt negativo.
  {
    const d = await newDriver("R5");
    const b = await baseSvc.giveBase(d.id, { cashAmount: 50000 });   // debe 50.000
    await driverSvc.registerPayment(d.id, 60000, "cash");             // crédito 10.000
    await approveEdit("BaseTransaction", b.id, { amount: { old: "50000", new: "40000" } }); // −10.000
    report("R5", "Editar monto de base (vía solicitud) con crédito a favor deja pendingDebt negativo",
      await state(d.id), { pendingDebt: 0, creditAmount: 20000 });
  }
  // R6 — Pedido manual con crédito a favor: incremento crudo, no netea.
  {
    const d = await newDriver("R6");
    await driverSvc.registerPayment(d.id, 10000, "cash");   // crédito 10.000
    await manualCreate({ body: { branchId: branch.id, driverId: d.id, deliveryValue: 20000 } } as never, mockRes() as never);
    report("R6", "Pedido manual con crédito a favor deja deuda y crédito positivos a la vez",
      await state(d.id), { pendingDebt: 0, creditAmount: 10000 - Math.round(20000 * pct / 100) });
  }
  // R7 — Reporte mensual: base entregada en un mes anterior no aparece en ningún indicador del panel del mes.
  {
    const reportBranch = await prisma.branch.create({data:{name:"AUD reporte aislado",apiKeyEnc:"invalid"}});
    const d = await newDriver("R7",reportBranch.id);
    const b = await baseSvc.giveBase(d.id, { cashAmount: 50000 });
    await prisma.baseTransaction.update({ where: { id: b.id }, data: { date: new Date("2026-08-15T12:00:00-05:00") } });
    await webhookOrder(d, 100000, new Date("2026-09-20T12:00:00-05:00"),reportBranch.id);
    const rep = await closeSvc.getMonthlyReport("2026-09", reportBranch.id);
    const baseMes = rep.debtReconciliation.basesPrevious;
    if(rep.bases.diff !== 0 || rep.debtReconciliation.basesCurrentMonth !== 0) throw Error("Se cambió el alcance del indicador mensual");
    if(rep.debtReconciliation.total !== rep.debtReconciliation.basesAllTime + rep.debtReconciliation.commission) throw Error("Reporte no concilia");
    const comision = rep.commission.pendingDrivers.find((x: { id: string }) => x.id === d.id)?.pendingDebt ?? 0;
    const st = await state(d.id);
    report("R7", "Panel de Reportes (sept) no muestra la base de agosto: base+comisión ≠ deuda en Deudas",
      { deudaEnDeudas: st.pendingDebt, baseEnPanelMes: baseMes, comisionEnPanel: comision, sumaPanel: baseMes + comision },
      { deudaEnDeudas: 80000, baseEnPanelMes: 50000, comisionEnPanel: 30000, sumaPanel: 80000 });
  }
  // R8 — "Cargar pedidos desde hoy": recalcula por fórmula y crea crédito fantasma con pagos previos.
  {
    const b2 = await prisma.branch.create({ data: { name: "AUD-branch-2", apiKeyEnc: "no-valida" } });
    const d = await newDriver("R8", b2.id);
    await webhookOrder(d, 100000, new Date(Date.now() - 36 * 3600 * 1000), b2.id); // pedido de antier/ayer
    await driverSvc.registerPayment(d.id, 30000, "cash");                           // saldado
    let syncErr = "";
    try { await branchSvc.startOrdersFromToday(b2.id); } catch (e) { syncErr = (e as Error).message.slice(0, 60); }
    report("R8", "'Cargar pedidos desde hoy' deja crédito fantasma a quien ya había pagado pedidos anteriores",
      { ...(await state(d.id)), nota: syncErr ? "sync falló después del recálculo (esperado, API key falsa)" : "" },
      { pendingDebt: 0, creditAmount: 0, nota: syncErr ? "sync falló después del recálculo (esperado, API key falsa)" : "" });
  }
  // C1 — Control (arreglo del 15-sep): borrar pago de crédito y luego el ingreso original restaura bien.
  {
    const d = await newDriver("C1");
    await webhookOrder(d, 100000);                                    // debe 30.000
    const ing = await bankSvc.create({ type: "ingreso", medium: "bank", amount: 40000, description: "AUD ingreso", noCounterpart: true }) as { id: string };
    await driverSvc.applyBankToDriver(ing.id, d.id);                  // crédito 10.000
    await driverSvc.payCredit(d.id, "cash");                          // crédito 0
    const eg = await prisma.bankTransaction.findFirstOrThrow({ where: { driverId: d.id, type: "egreso" } });
    await bankSvc.remove(eg.id);
    const trasBorrarPago = await state(d.id);
    await bankSvc.remove(ing.id);
    report("C1", "CONTROL: revertir pago de crédito y luego el ingreso vuelve a la deuda original",
      { trasBorrarPago, final: await state(d.id) },
      { trasBorrarPago: { pendingDebt: 0, creditAmount: 10000 }, final: { pendingDebt: 30000, creditAmount: 0 } });
  }
  // C2 — Control (arreglo del 19-ago): pedido eliminado por solicitud no resucita con el webhook.
  {
    const d = await newDriver("C2");
    const o = await webhookOrder(d, 100000);
    await approveDelete("ShipdayOrder", o.id);
    const res = mockRes();
    await shipdayWebhook({ params: { branchId: branch.id }, headers: { token: "audit-token" }, query: {}, body: {
      event: "ORDER_COMPLETED", order: { id: o.shipdayOrderId, delivery_fee: 100000, delivery_time: Date.now() }, carrier: { id: d.shipdayDriverId } } } as never, res as never);
    const alive = await prisma.shipdayOrder.count({ where: { shipdayOrderId: o.shipdayOrderId } });
    report("C2", "CONTROL: pedido eliminado (lápida) no se recrea al reenviar el webhook",
      { pedidoRecreado: alive > 0, ...(await state(d.id)) }, { pedidoRecreado: false, pendingDebt: 0, creditAmount: 0 });
  }
  // C3 — Control: webhook con tarifa 0 (stub) no suma deuda; queda en $0 hasta que el polling lo sane.
  {
    const d = await newDriver("C3");
    const o = await webhookOrder(d, 0);
    report("C3", "CONTROL: stub del webhook con tarifa 0 no suma deuda (se sana solo vía polling)",
      { deliveryValue: o.deliveryValue, ...(await state(d.id)) }, { deliveryValue: 0, pendingDebt: 0, creditAmount: 0 });
  }

  console.log("\n=== RESULTADOS ===");
  for (const r of results) {
    const tag = r.id.startsWith("C") ? (r.reproduce ? "❌ CONTROL FALLÓ" : "✅ CONTROL OK") : (r.reproduce ? "🔴 REPRODUCIDO" : "⚪ NO reproducido");
    console.log(`\n[${r.id}] ${tag} — ${r.titulo}\n   obtenido: ${JSON.stringify(r.obtenido)}\n   correcto: ${JSON.stringify(r.correcto)}`);
  }
  await (await import("node:fs/promises")).writeFile(path.join(__dirname,"reproduccion.json"), JSON.stringify(results, null, 2)); await prisma.$disconnect();
  if(results.some(r=>r.reproduce)) throw Error("Regresión de auditoría");
}

main().catch((e) => { console.error(e); process.exit(1); });
