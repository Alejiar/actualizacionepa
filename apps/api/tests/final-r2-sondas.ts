/**
 * AUDITORÍA RONDA 2 — Sondas dirigidas a fallas ocultas (cada una con su ESPERADO escrito antes).
 * Corre sobre una copia del estado final de la Simulación B de la ronda 1 (septiembre cerrado el 22-oct de madrugada,
 * día operativo 22-oct). SOLO `cashbuddy_final_sondas`.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const u = new URL(process.env.DATABASE_URL || "invalid:");
if (u.pathname !== "/cashbuddy_final_sondas" || !["localhost", "127.0.0.1"].includes(u.hostname)) throw Error("Solo BD temporal local cashbuddy_final_sondas");
const clock = (globalThis as any).__fakeClock; const RealDate = clock.Real as DateConstructor;

async function main() {
  clock.set(new RealDate("2026-10-22T21:00:00-05:00").getTime());
  const SRC = pathToFileURL(path.resolve(__dirname, "../src")).href;
  const { prisma: p } = await import(`${SRC}/lib/prisma.ts`);
  const { createServer } = await import(`${SRC}/server.ts`);
  const { signToken } = await import(`${SRC}/lib/jwt.ts`);
  const { toBogotaDateStr } = await import(`${SRC}/lib/date-range.ts`);
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any, init: any) => { if (!String(input).startsWith("http://127.0.0.1:")) throw Error("Red externa bloqueada: " + String(input)); return realFetch(input, init); }) as any;
  const server = createServer().listen(0, "127.0.0.1"); await new Promise<void>(r => server.once("listening", r));
  const origin = "http://127.0.0.1:" + (server.address() as any).port;
  const results: any[] = [];
  const check = async (id: string, name: string, esperado: string, fn: (f: any) => Promise<void>) => {
    const f: any = {};
    try { await fn(f); results.push({ id, name, esperado, ok: true, facts: f }); console.log(`OK    ${id} ${name}`); }
    catch (e: any) { results.push({ id, name, esperado, ok: false, facts: f, error: String(e?.stack || e).slice(0, 1500) }); console.log(`FALLA ${id} ${name}\n      esperado: ${esperado}\n      ${JSON.stringify(f).slice(0, 900)} ${String(e?.message || e).slice(0, 600)}`); }
  };
  const admin = await p.user.findUniqueOrThrow({ where: { email: "admin@extremos.test" } });
  const oper = await p.user.findUniqueOrThrow({ where: { email: "oper@extremos.test" } });
  const tokA = signToken({ sub: admin.id, email: admin.email, name: admin.name, role: "admin", tv: admin.tokenVersion });
  const tokO = signToken({ sub: oper.id, email: oper.email, name: oper.name, role: "user", tv: oper.tokenVersion });
  const api = async (route: string, method = "GET", body?: unknown, tok = tokA, headers: Record<string, string> = {}) => { const r = await realFetch(origin + "/api" + route, { method, headers: { "Content-Type": "application/json", Authorization: "Bearer " + tok, ...headers }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => null) as any, headers: r.headers }; };
  const hook = async (branchId: string, body: unknown) => { const r = await realFetch(origin + "/api/webhooks/shipday/" + branchId, { method: "POST", headers: { "Content-Type": "application/json", token: process.env.WEBHOOK_TOKEN! }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => null) }; };
  const N = await p.branch.findFirstOrThrow({ where: { name: "Norte B" } });
  const d1 = await p.driver.findFirstOrThrow({ where: { shipdayDriverId: "8101" } });
  const client = await p.client.findFirstOrThrow({ where: { name: "Cliente B" } });
  const exp = async () => { const e = (await api("/shifts/2026-10-22/expected")).body; const dr = (await api(`/sd/drivers/${d1.id}`)).body; return { cash: e.expectedCash, bank: e.expectedBank, deuda: dr.pendingDebt ?? dr.driver?.pendingDebt, credito: dr.creditAmount ?? dr.driver?.creditAmount }; };

  // ── Webhook: formatos de hora de entrega ─────────────────────────────────────────
  const secs = Math.floor(new RealDate("2026-10-22T15:00:00-05:00").getTime() / 1000);
  for (const [id, val, label] of [["s-ms", secs * 1000, "milisegundos (número)"], ["s-ms-txt", String(secs * 1000), "milisegundos (texto)"], ["s-seg-txt", String(secs), "SEGUNDOS (texto de 10 dígitos)"], ["s-seg-num", secs, "SEGUNDOS (número)"], ["s-iso-z", "2026-10-22T20:00:00Z", "ISO con Z"], ["s-iso-sin", "2026-10-22T15:00:00", "ISO sin zona"]] as [string, any, string][]) {
    await check(`S-HORA-${id}`, `Webhook con hora de entrega en ${label}`, "Se guarda el 22-oct 15:00 Bogotá con 200 (INC-R2-04: también en segundos); NUNCA una fecha de 1970 ni otro día", async f => {
      const r = await hook(N.id, { event: "ORDER_COMPLETED", order: { id, order_number: id, delivery_fee: 5000, delivery_time: val }, carrier: { id: "8101" } });
      f.status = r.status; f.body = r.body;
      const o = await p.shipdayOrder.findUnique({ where: { shipdayOrderId: id } });
      f.guardado = o ? o.deliveredAt.toISOString() : null; f.diaBogota = o ? toBogotaDateStr(o.deliveredAt) : null;
      assert.equal(r.status, 200, "rechazado: " + JSON.stringify(r.body));
      assert.equal(f.guardado, "2026-10-22T20:00:00.000Z");
      assert.ok(o, "200 sin pedido guardado: el pedido se perdió en silencio (" + JSON.stringify(r.body) + ")");
      assert.equal(f.diaBogota, "2026-10-22", "día equivocado");
    });
  }

  // ── Webhook: lote con un pedido de un mes cerrado y uno válido ───────────────────
  await check("S-LOTE-MES-CERRADO", "Lote de 2 eventos: uno de septiembre (cerrado) y uno válido de hoy", "Documentar: o se carga el válido y se omite el cerrado, o se rechaza el lote completo (y el válido llega en el reintento de Shipday). Nunca se carga el de septiembre", async f => {
    const r = await hook(N.id, [{ event: "ORDER_COMPLETED", order: { id: "lote-sep", order_number: "LS", delivery_fee: 5000, delivery_time: new RealDate("2026-09-20T12:00:00-05:00").getTime() }, carrier: { id: "8101" } }, { event: "ORDER_COMPLETED", order: { id: "lote-hoy", order_number: "LH", delivery_fee: 5000, delivery_time: new RealDate("2026-10-22T12:00:00-05:00").getTime() }, carrier: { id: "8101" } }]);
    f.status = r.status; f.cargadoSep = await p.shipdayOrder.count({ where: { shipdayOrderId: "lote-sep" } }); f.cargadoHoy = await p.shipdayOrder.count({ where: { shipdayOrderId: "lote-hoy" } });
    assert.equal(f.cargadoSep, 0);
  });

  // ── Idempotency-Key reutilizada con OTRO cuerpo ──────────────────────────────────
  await check("S-IDEM-OTRO-CUERPO", "La misma Idempotency-Key con un cuerpo distinto (otro monto)", "Documentar: el servidor devuelve el resultado guardado del primero (no registra el segundo). La interfaz genera una clave por envío (web/lib/retry-key.ts)", async f => {
    const before = await exp(); const key = "idem-sonda-otro-1";
    const a = await api(`/sd/bases/${d1.id}/give`, "POST", { cashAmount: 2000 }, tokO, { "Idempotency-Key": key });
    const b = await api(`/sd/bases/${d1.id}/give`, "POST", { cashAmount: 9000 }, tokO, { "Idempotency-Key": key });
    const after = await exp(); f.status = [a.status, b.status]; f.replay = b.headers.get("Idempotent-Replay"); f.caja = [before.cash, after.cash];
    assert.equal(after.cash, before.cash - 2000);
    await api(`/sd/bases/${a.body.id}`, "DELETE");
  });

  // ── OBS-R2-01: pedido del mes ABIERTO anterior al instante del cierre de mes ─────
  await check("S-ANCLA-PEDIDO", "Solicitudes aprobadas para CORREGIR el valor y luego ELIMINAR un pedido del 15-oct (mes abierto) cuando septiembre se cerró el 22-oct", "INC-R2-05: ambas se aplican (200); la comisión del domiciliario baja 300 y luego el resto; caja y banco no cambian", async f => {
    const o = await p.shipdayOrder.findFirstOrThrow({ where: { driverId: d1.id, deliveredAt: { gte: new RealDate("2026-10-15T00:00:00-05:00"), lt: new RealDate("2026-10-16T00:00:00-05:00") } } });
    const before = await exp();
    const rq2 = await api("/edit-requests", "POST", { requestType: "edit", entityType: "ShipdayOrder", entityId: o.id, entityLabel: "Pedido", changes: { deliveryValue: { old: String(o.deliveryValue), new: String(o.deliveryValue - 1000) } }, reason: "Valor equivocado" }, tokO);
    const rv2 = await api(`/edit-requests/${rq2.body.id}/review`, "POST", { action: "approved" }); f.aprobarEditar = [rv2.status, rv2.body?.error];
    const mid = await exp();
    const rq = await api("/edit-requests", "POST", { requestType: "delete", entityType: "ShipdayOrder", entityId: o.id, entityLabel: "Pedido", reason: "Pedido equivocado" }, tokO);
    const rv = await api(`/edit-requests/${rq.body.id}/review`, "POST", { action: "approved" }); f.aprobarEliminar = [rv.status, rv.body?.error];
    const after = await exp(); f.antes = before; f.medio = mid; f.despues = after;
    assert.equal(rv2.status, 200); assert.equal(rv.status, 200);
    const net = (x: any) => x.deuda - x.credito;
    assert.equal(net(mid), net(before) - 300, "comisión tras corregir");
    assert.equal(net(after), net(before) - o.companyAmount, "comisión tras eliminar");
    assert.deepEqual([after.cash, after.bank], [before.cash, before.bank], "un pedido movió caja/banco");
    f.sigue = await p.shipdayOrder.count({ where: { id: o.id } }); assert.equal(f.sigue, 0);
  });

  // ── Pedido fiado con abono: eliminar el pedido ───────────────────────────────────
  await check("S-FIADO-ABONADO", "Pedido manual fiado a un cliente que ya abonó una parte; luego solicitud para eliminar el pedido", "Eliminar se rechaza (4xx) pidiendo revertir los abonos; deuda del cliente, caja y comisión intactas", async f => {
    const o = await api("/sd/orders/manual", "POST", { branchId: N.id, driverId: d1.id, deliveryValue: 10000, clientId: client.id, addToClientDebt: true, orderNumber: "FIA-1" }, tokO);
    assert.equal(o.status, 201);
    const pay = await api(`/clients/${client.id}/pay`, "POST", { amount: Math.min(4000, (await p.client.findUniqueOrThrow({ where: { id: client.id } })).pendingDebt), medium: "cash" }, tokO); f.abono = pay.status;
    const before = { ...(await exp()), cliente: (await p.client.findUniqueOrThrow({ where: { id: client.id } })).pendingDebt };
    const rq = await api("/edit-requests", "POST", { requestType: "delete", entityType: "ShipdayOrder", entityId: o.body.id, entityLabel: "Pedido", reason: "x" }, tokO);
    const rv = await api(`/edit-requests/${rq.body.id}/review`, "POST", { action: "approved" }); f.aprobar = [rv.status, rv.body?.error];
    const after = { ...(await exp()), cliente: (await p.client.findUniqueOrThrow({ where: { id: client.id } })).pendingDebt };
    f.antes = before; f.despues = after;
    // El abono FIFO pudo caer en deudas más viejas del cliente; si el pedido quedó sin abonos se puede borrar.
    const linked = await p.clientDebt.findUnique({ where: { sourceOrderId: o.body.id } });
    if (rv.status === 200) { assert.ok(!linked, "aprobado pero la deuda enlazada sigue"); assert.equal(after.cliente, before.cliente - 10000); }
    else { assert.ok(rv.status >= 400 && rv.status < 500); assert.deepEqual(after, before); }
  });

  // ── Turno por hora: cambio de tarifa por el OPERADOR ─────────────────────────────
  await check("S-TARIFA-OPERADOR", "El operador (no admin) cambia la tarifa del cliente por hora", "Documentar si se permite (la ruta no exige admin)", async f => {
    const hc = await p.hourlyClient.findFirstOrThrow({ where: { name: "Por hora B" } });
    const r = await api(`/hourly-clients/${hc.id}`, "PATCH", { driverHourValue: hc.driverHourValue + 1000 }, tokO); f.status = r.status;
    if (r.status === 200) await api(`/hourly-clients/${hc.id}`, "PATCH", { driverHourValue: hc.driverHourValue });
  });
  await check("S-NOMINA-OPERADOR", "El operador registra Nómina (categoría 15) confirmada en efectivo", "Documentar si queda confirmada sin aprobación (los gastos 3/4 quedan pendientes)", async f => {
    const w = await p.worker.findFirstOrThrow({ where: { name: "Auxiliar B" } });
    const before = await exp();
    const r = await api("/movements", "POST", { date: "2026-10-22", category: 15, type: "egreso", medium: "cash", amount: 50000, description: "Nómina sonda", workerId: w.id, status: "confirmed" }, tokO);
    f.status = r.status; f.estado = r.body?.status; f.caja = [before.cash, (await exp()).cash];
    if (r.status === 201) await p.movement.delete({ where: { id: r.body.id } });
  });
  await check("S-INGRESO-OPERADOR", "El operador registra un movimiento de categoría 1 (Domicilios efectivo) INGRESO confirmado de $1.000.000", "Documentar si el operador puede crear ingresos confirmados arbitrarios en Caja", async f => {
    const before = await exp();
    const r = await api("/movements", "POST", { date: "2026-10-22", category: 1, type: "ingreso", medium: "cash", amount: 1000000, description: "Ingreso sonda", status: "confirmed" }, tokO);
    f.status = r.status; f.estado = r.body?.status; f.caja = [before.cash, (await exp()).cash];
    if (r.status === 201) await p.movement.delete({ where: { id: r.body.id } });
  });

  await new Promise<void>(r => server.close(() => r())); globalThis.fetch = realFetch; await p.$disconnect();
  const fails = results.filter(r => !r.ok).length;
  fs.writeFileSync(path.join(__dirname, "final-r2-sondas.json"), JSON.stringify({ results }, null, 2));
  console.log(`TOTAL ${results.length} · OK ${results.length - fails} · FALLAS ${fails}`);
  process.exit(fails ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
