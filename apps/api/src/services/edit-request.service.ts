import { MAX_MONEY } from "../lib/money-validation";
import { refreshOrderStats } from "../lib/order-stats";
import * as bankSvc from "./bank-transaction.service";
import { reverseClientPayment } from "./client.service";
import { prisma, moneyTransaction } from "../lib/prisma";
import { notFound, badRequest, conflict } from "../lib/errors";
import { toBogotaDateStr } from "../lib/date-range";
import { BANK_LINKED_PAYMENT_NOTE, BANK_LINKED_BASE_PREFIX } from "../lib/balance-markers";
import { applyDebtDelta } from "./driver.service";
import { getBaseLedger } from "../lib/base-balance";
import { assertOpenPeriod, assertOpenInstant, assertOrderPeriodOpen, movementEffectiveAt, runAsApprovedCorrection, assertCalendarDate } from "../lib/period-guard";
import { getRawExpectedEndOfDay } from "./shipday-dashboard.service";
import { addMovement } from "./movement.service";
import { assertMoney } from "../lib/money-validation";
import { deleteShift as deleteHourlyShift, editShift as editHourlyShift, deleteHourlyBankTx, assertShiftTimes } from "./hourly-client.service";

type ChangeMap = Record<string, { old: string; new: string }>;

const editable: Record<string, string[]> = {
  ShipdayOrder: ["deliveryValue","orderNumber","customerName","customerAddress"],
  BankTransaction: ["amount","description"], Movement: ["amount","description"],
  BaseTransaction: ["amount","cashAmount","bankAmount","notes"],
  DriverPayment: ["amount","notes"], ClientDebt: ["amount","description"],
  ClientDebtPayment: [], Conversion: ["amount","notes"],
  ShiftClose: ["totalExpected","totalCounted","bankExpected","bankCounted","receivedBy","handedBy","notes"],
  MonthlyClose: ["initialCash","initialBank"],
  // confirmOvernight: quien pide el cambio confirmó un turno que cruza medianoche (solo "true").
  HourlyShift: ["driverId","driverName","startTime","endTime","date","confirmOvernight"],
};
const numericFields = new Set(["amount","deliveryValue","cashAmount","bankAmount","totalExpected","totalCounted","bankExpected","bankCounted","initialCash","initialBank"]);
// Tipos cuya ELIMINACIÓN está implementada (con reversión íntegra de sus efectos). Cualquier
// otro (p. ej. MonthlyClose) se rechaza al crear o revisar la solicitud: antes la solicitud
// quedaba "Aprobada" sin que nada ocurriera.
const deletable = new Set(["ShipdayOrder","Movement","BankTransaction","DriverPayment","BaseTransaction","ClientDebt","ClientDebtPayment","Conversion","ShiftClose","HourlyShift"]);
function validateChanges(entity: string, changes: ChangeMap, deleting = false) {
  if (!editable[entity]) throw badRequest("Tipo de registro no permitido");
  if (deleting) {
    if (!deletable.has(entity)) throw badRequest(`La eliminación de ${entity} no está implementada.`);
    return;
  }
  for (const [field, change] of Object.entries(changes)) {
    if (!editable[entity].includes(field)) throw badRequest("Campo no editable: " + field);
    if (typeof change.new !== "string") throw badRequest("Valor inválido");
    if (numericFields.has(field)) {
      const n = Number(change.new);
      if (!change.new.trim() || !Number.isSafeInteger(n) || n > MAX_MONEY || n < 0 || (field === "amount" && n === 0)) throw badRequest("Monto inválido");
    }
  }
}


/** Un turno que pasa a cruzar medianoche exige la confirmación explícita desde la solicitud. */
async function validateHourlyShiftRequest(entityId: string, changes: ChangeMap) {
  const confirm = changes.confirmOvernight;
  if (confirm && confirm.new !== "true") throw badRequest("Valor inválido para confirmOvernight.");
  if (!changes.startTime && !changes.endTime) return;
  const shift = await prisma.hourlyShift.findUnique({ where: { id: entityId }, include: { hourlyClient: true } });
  if (!shift) throw badRequest("Turno no encontrado");
  const rates = shift.driverHourValue != null && shift.companyHourValue != null
    ? { driverHourValue: shift.driverHourValue, companyHourValue: shift.companyHourValue } : shift.hourlyClient;
  assertShiftTimes(changes.startTime?.new ?? shift.startTime, changes.endTime?.new ?? shift.endTime,
    changes.date?.new ?? shift.date, rates, confirm?.new === "true");
}

export async function listRequests(status?: "pending" | "approved" | "rejected") {
  return prisma.editRequest.findMany({
    where: status ? { status } : undefined,
    include: {
      requester: { select: { id: true, name: true, email: true } },
      reviewer: { select: { id: true, name: true } },
    },
    orderBy: { createdAt: "desc" },
  });
}

export async function countPending() {
  return prisma.editRequest.count({ where: { status: "pending" } });
}

/**
 * D7: solicitud para AGREGAR dinero olvidado a un día que ya tiene Cierre (mes abierto). Solo
 * movimientos de Caja (Movement) o de Banco/efectivo (BankTransaction). Se valida aquí lo que no
 * depende del momento de aprobación; la regla de período se vuelve a verificar al aplicar.
 */
const creatable = new Set(["Movement", "BankTransaction"]);
type CreatePayload = { date: string; type: "ingreso" | "egreso"; medium: "cash" | "bank"; amount: number; description: string; category?: number };
async function validateCreate(entityType: string, raw: unknown): Promise<CreatePayload> {
  if (!creatable.has(entityType)) throw badRequest("Solo se pueden agregar movimientos de Caja o de Banco por solicitud.");
  const c = (raw ?? {}) as Record<string, unknown>;
  assertCalendarDate(c.date, "La fecha");
  if (c.type !== "ingreso" && c.type !== "egreso") throw badRequest("Tipo inválido (ingreso o egreso).");
  if (c.medium !== "cash" && c.medium !== "bank") throw badRequest("Medio inválido (cash o bank).");
  assertMoney(c.amount);
  if (typeof c.description !== "string" || !c.description.trim()) throw badRequest("Describe el movimiento.");
  if (entityType === "Movement" && (typeof c.category !== "number" || !Number.isSafeInteger(c.category))) throw badRequest("Indica la categoría del movimiento de Caja.");
  const closed = await prisma.shiftClose.findUnique({ where: { date_shift: { date: c.date as string, shift: "close" } }, select: { id: true } });
  if (!closed) throw badRequest("Ese día no tiene Cierre: registra el movimiento directamente.");
  return { date: c.date as string, type: c.type, medium: c.medium, amount: c.amount as number, description: (c.description as string).trim(), ...(entityType === "Movement" ? { category: c.category as number } : {}) };
}

export async function createRequest(data: {
  requesterId: string;
  entityType: string;
  entityId: string;
  entityLabel: string;
  changes: ChangeMap;
  reason: string;
  requestType?: "edit" | "delete" | "create";
}) {
  if (data.requestType === "create") {
    if (!data.reason?.trim()) throw badRequest("Debes indicar el motivo");
    const payload = await validateCreate(data.entityType, data.changes);
    return prisma.editRequest.create({
      data: {
        requesterId: data.requesterId, requestType: "create", entityType: data.entityType, entityId: "nuevo",
        entityLabel: data.entityLabel || `Agregar ${payload.type} ${payload.medium === "cash" ? "efectivo" : "banco"} $${payload.amount.toLocaleString("es-CO")} al ${payload.date}`,
        changes: payload, reason: data.reason,
      },
      include: { requester: { select: { id: true, name: true } } },
    });
  }
  validateChanges(data.entityType,data.changes,data.requestType === "delete");
  if (!data.reason.trim()) throw badRequest("Debes indicar el motivo");
  if (data.entityType === "HourlyShift" && data.requestType !== "delete") await validateHourlyShiftRequest(data.entityId, data.changes);
  const requestType = data.requestType ?? "edit";
  if (requestType === "edit" && Object.keys(data.changes).length === 0) {
    throw badRequest("Debes especificar al menos un campo a cambiar");
  }
  // NEW17 (auditoría 3, 22-oct-2026): eliminar el pago al domiciliario de un turno por hora borra el
  // TURNO completo (deleteHourlyBankTx), incluidos los cobros al cliente. El admin solo veía
  // "Salida banco · $20.000" y el banco bajaba también por el cobro. Se avisa en la solicitud.
  let entityLabel = data.entityLabel;
  if (requestType === "delete" && data.entityType === "BankTransaction") {
    const tx = await prisma.bankTransaction.findUnique({ where: { id: data.entityId }, select: { type: true, hourlyShiftId: true } });
    if (tx?.hourlyShiftId && tx.type === "egreso") {
      const cobros = await prisma.bankTransaction.aggregate({ where: { hourlyShiftId: tx.hourlyShiftId, type: "ingreso" }, _sum: { amount: true } });
      const cobrado = cobros._sum.amount ?? 0;
      entityLabel += ` — ⚠️ borra el TURNO por hora completo: su pago al domiciliario y ${cobrado ? `los cobros al cliente ($${cobrado.toLocaleString("es-CO")})` : "su deuda al cliente"}`;
    }
  }
  return prisma.editRequest.create({
    data: {
      requesterId: data.requesterId,
      requestType,
      entityType: data.entityType,
      entityId: data.entityId,
      entityLabel,
      changes: data.changes,
      reason: data.reason,
    },
    include: {
      requester: { select: { id: true, name: true } },
    },
  });
}

export async function reviewRequest(id: string, reviewerId: string, action: "approved" | "rejected", notes?: string) {
  return moneyTransaction(async () => {
  const req = await prisma.editRequest.findUnique({ where: { id } });
  if (!req) throw notFound("Solicitud no encontrada");
  if (req.status !== "pending") throw badRequest("Esta solicitud ya fue procesada");

  // Aplicar el efecto ANTES de marcar la solicitud. Si el borrado/edición falla, la
  // solicitud queda "pending" y el error sube al admin (puede reintentar) — nunca queda
  // "Aprobada" en el historial sin haber tocado nada. Antes se marcaba aprobada primero
  // y luego se aplicaba el efecto: un fallo dejaba un falso "Aprobada" (parte del bug del
  // Pedido #35). El propio efecto de cada entidad ya es transaccional.
  let createdId: string | null = null;
  if (action === "approved") {
    const reviewer = await prisma.user.findUnique({ where: { id: reviewerId }, select: { name: true } });
    // D7: la aplicación de una solicitud aprobada puede tocar un día con Cierre (mes abierto).
    // Se mide el efecto en el flujo de cada día cerrado ANTES y DESPUÉS y se deja constancia
    // en su Cierre, sin alterar el conteo original.
    await runAsApprovedCorrection(req.id, async () => {
      const before = await closedDayFlows();
      if (req.requestType === "delete") {
        await deleteEntity(req.entityType, req.entityId, reviewerId);
      } else if (req.requestType === "create") {
        createdId = await createEntity(req.entityType, req.changes, req.requesterId);
      } else {
        await applyChanges(req.entityType, req.entityId, req.changes as ChangeMap, { id: reviewerId, name: reviewer?.name ?? null });
      }
      await recordClosedDayCorrections(before, {
        requestId: req.id, requestType: req.requestType, entityType: req.entityType, entityId: createdId ?? req.entityId,
        description: req.entityLabel, approvedBy: reviewerId, approvedByName: reviewer?.name ?? null,
      });
    });
  }

  // Marcar el estado de la solicitud solo si el efecto anterior no lanzó.
  const updated = await prisma.editRequest.update({
    where: { id },
    data: {
      ...(createdId ? { entityId: createdId } : {}),
      status: action,
      reviewerId,
      reviewNotes: notes ?? null,
      reviewedAt: new Date(),
    },
    include: {
      requester: { select: { id: true, name: true, email: true } },
    },
  });

  return updated;

  });
}

// ── Eliminar entidad revirtiendo sus efectos en deudas/saldos ─────────────────
/** D7: flujo neto (efectivo, banco) de cada día con Cierre del período abierto. */
async function closedDayFlows(): Promise<Map<string, { cash: number; bank: number }>> {
  const lastMonth = await prisma.monthlyClose.findFirst({ where: { branchId: null }, orderBy: { closedAt: "desc" }, select: { month: true } });
  const closes = await prisma.shiftClose.findMany({
    where: { shift: "close", ...(lastMonth ? { date: { gt: lastMonth.month + "-31" } } : {}) },
    select: { date: true }, orderBy: { date: "asc" },
  });
  const out = new Map<string, { cash: number; bank: number }>();
  for (const { date } of closes) {
    const prev = toBogotaDateStr(new Date(new Date(date + "T00:00:00-05:00").getTime() - 1));
    const [end, start] = await Promise.all([getRawExpectedEndOfDay(date), getRawExpectedEndOfDay(prev)]);
    out.set(date, { cash: end.cash - start.cash, bank: end.bank - start.bank });
  }
  return out;
}

async function recordClosedDayCorrections(
  before: Map<string, { cash: number; bank: number }>,
  meta: { requestId: string; requestType: string; entityType: string; entityId: string; description: string; approvedBy: string; approvedByName: string | null },
) {
  const after = await closedDayFlows();
  const approvedAt = new Date().toISOString();
  for (const [date, a] of after) {
    const b = before.get(date) ?? { cash: 0, bank: 0 };
    const cashDelta = a.cash - b.cash, bankDelta = a.bank - b.bank;
    if (!cashDelta && !bankDelta) continue;
    const close = await prisma.shiftClose.findUniqueOrThrow({ where: { date_shift: { date, shift: "close" } }, select: { id: true, corrections: true } });
    const list = Array.isArray(close.corrections) ? (close.corrections as object[]) : [];
    await prisma.shiftClose.update({
      where: { id: close.id },
      data: { corrections: [...list, { ...meta, cashDelta, bankDelta, approvedAt }] },
    });
  }
}

/** D7: aplica una solicitud aprobada de AGREGAR un movimiento a un día cerrado. */
async function createEntity(entityType: string, raw: unknown, requesterId: string): Promise<string> {
  const c = await validateCreate(entityType, raw);
  const requester = await prisma.user.findUnique({ where: { id: requesterId }, select: { name: true } });
  if (entityType === "Movement") {
    const m = await addMovement({ date: c.date, category: c.category!, type: c.type, medium: c.medium, amount: c.amount, description: c.description, status: "confirmed", createdBy: requesterId, createdByName: requester?.name ?? undefined } as Parameters<typeof addMovement>[0]);
    return m.id;
  }
  const t = await bankSvc.create({ type: c.type, medium: c.medium, amount: c.amount, description: c.description, date: c.date, noCounterpart: true, createdBy: requesterId, createdByName: requester?.name ?? null });
  return (t as { id?: string; parts?: { id: string }[] }).id ?? (t as { parts: { id: string }[] }).parts[0].id;
}

async function deleteEntity(entityType: string, entityId: string, deletedBy?: string) {
  validateChanges(entityType, {}, true);
  // El registro debe existir: aprobar la eliminación de algo que ya no existe no aplica
  // ningún efecto y no puede quedar como "Aprobada" (la solicitud sigue pendiente y el admin
  // puede rechazarla).
  const delegate = (prisma as unknown as Record<string, { findUnique: (a: unknown) => Promise<unknown> }>)[entityType[0].toLowerCase() + entityType.slice(1)];
  if (!(await delegate.findUnique({ where: { id: entityId } }))) {
    throw notFound("El registro ya no existe; rechaza esta solicitud.");
  }
  await assertEntityPeriod(entityType, entityId);
  switch (entityType) {
    case "ShipdayOrder": {
      const order = await prisma.shipdayOrder.findUnique({ where: { id: entityId } });
      if (!order) return;
      await prisma.$transaction(async (tx) => {
        // Revertir la comisión de la deuda del domiciliario. Vía applyDebtDelta (NUNCA un
        // decrement crudo): netea contra el crédito a favor y topa en 0, así no deja
        // pendingDebt negativo (regla de dinero, ver CLAUDE.md).
        if (order.driverId && order.companyAmount > 0) {
          await applyDebtDelta(tx, order.driverId, -order.companyAmount);
        }
        const linked = await tx.clientDebt.findUnique({where:{sourceOrderId:order.id}});
        if (linked) {
          if ((linked.paidAmount ?? 0)>0 || await tx.clientDebtPayment.count({where:{debtId:linked.id}})) throw badRequest("Revierte los abonos del cliente antes de eliminar este pedido.");
          await tx.client.update({where:{id:linked.clientId},data:{pendingDebt:{decrement:linked.amount}}});
          await tx.clientDebt.delete({where:{id:linked.id}});
        } else if (order.addToClientDebt) {
          throw badRequest("Este pedido histórico no tiene su deuda enlazada. Requiere conciliación antes de eliminarlo.");
        }
        await tx.shipdayOrder.delete({ where: { id: entityId } });
        await refreshOrderStats(tx,order);
        // Lápida: impide que el polling/webhook de Shipday resucite este pedido (sigue
        // reportándose como entregado allá). upsert, no create, por si alguna vez se
        // reintenta el borrado del mismo shipdayOrderId. Ver modelo DeletedShipdayOrder.
        await tx.deletedShipdayOrder.upsert({
          where: { shipdayOrderId: order.shipdayOrderId },
          create: {
            shipdayOrderId: order.shipdayOrderId,
            branchId: order.branchId,
            orderNumber: order.orderNumber,
            deliveredAt: order.deliveredAt,
            deletedBy: deletedBy ?? null,
          },
          update: { deletedAt: new Date(), deletedBy: deletedBy ?? null },
        });
      });
      break;
    }
    case "Movement": {
      const m = await prisma.movement.findUniqueOrThrow({ where: { id: entityId } });
      // Quitar un movimiento confirmado cambia la caja de SU día: debe estar abierto (D7).
      if (m.status === "confirmed") await assertOpenPeriod(m.date, movementEffectiveAt(m));
      await prisma.movement.delete({ where: { id: entityId } });
      break;
    }
    case "BankTransaction":
      await bankSvc.remove(entityId);
      break;
    case "DriverPayment": {
      const payment = await prisma.driverPayment.findUnique({ where: { id: entityId } });
      if (!payment) return;
      if (payment.bankTransactionId) throw badRequest("Corrige el cobro original en Movimientos.");
      await prisma.$transaction(async (tx) => {
        // El pago reducía la deuda → al eliminarlo, la deuda vuelve a subir
        await applyDebtDelta(tx,payment.driverId,payment.amount);
        await tx.driverPayment.delete({ where: { id: entityId } });
      });
      break;
    }
    case "BaseTransaction": {
      const base = await prisma.baseTransaction.findUnique({ where: { id: entityId } });
      if (!base) return;
      if (base.bankTransactionId) throw badRequest("Corrige el cobro original en Movimientos.");
      // F14: la base es una cuenta propia; borrarla no toca la deuda por comisiones. El libro
      // de base nunca puede quedar con más devuelto que entregado.
      if (base.type === "entrega") {
        const l = await getBaseLedger(prisma, base.driverId);
        if (l.given - base.amount < l.returned) throw conflict("La base ya tiene devoluciones registradas. Elimina primero la devolución.");
      }
      await prisma.baseTransaction.delete({ where: { id: entityId } });
      break;
    }
    case "ClientDebt": {
      const debt = await prisma.clientDebt.findUnique({ where: { id: entityId } });
      if (!debt) return;
      if (debt.sourceOrderId) throw badRequest("Corrige el pedido que generó esta deuda.");
      if ((debt.paidAmount ?? 0)>0 || await prisma.clientDebtPayment.count({where:{debtId:debt.id}})) throw badRequest("Revierte los abonos antes de eliminar esta deuda.");
      await prisma.$transaction(async (tx) => {
        // Restar del saldo del cliente SOLO lo que aún quedaba pendiente de esta deuda
        // (monto menos lo ya abonado). Si estaba 100% pagada, no resta nada. Antes se
        // restaba el monto completo salvo que estuviera pagada, lo que descuadraba las
        // deudas con abonos parciales.
        const stillOwed = debt.amount - (debt.paidAmount ?? 0);
        if (stillOwed > 0) {
          await tx.client.update({
            where: { id: debt.clientId },
            data: { pendingDebt: { decrement: stillOwed } },
          });
        }
        await tx.clientDebt.delete({ where: { id: entityId } });
      });
      break;
    }
    case "ClientDebtPayment":
      await reverseClientPayment(entityId);
      break;
    case "Conversion":
      await prisma.conversion.delete({ where: { id: entityId } });
      break;
    case "ShiftClose":
      // Cierre de turno: es solo un registro de conteo, no afecta deudas/saldos.
      await prisma.shiftClose.delete({ where: { id: entityId } });
      break;
    case "HourlyShift":
      // Turno por hora: revierte el pago al domiciliario y el cobro del cliente (ver
      // deleteShift en hourly-client.service.ts).
      await deleteHourlyShift(entityId);
      break;
    default:
      throw badRequest(`La eliminación de ${entityType} no está implementada.`);
  }
}

// ── Recalcular companyAmount de TODOS los pedidos según la comisión actual ────
// Corrige descuadres heredados y ajusta la deuda de los domiciliarios.
export async function recalcAllOrders() {
  return moneyTransaction(async () => {
  const settings = await prisma.settings.findUnique({ where: { id: "singleton" } });
  const commissionPercent = settings?.shipdayCommission ?? 30;
  const orders = await prisma.shipdayOrder.findMany();
  let fixed = 0;

  for (const order of orders) {
    const correct = Math.round(order.deliveryValue * (commissionPercent / 100));
    if (correct !== order.companyAmount) {
      await assertOpenInstant(order.deliveredAt ?? order.createdAt, "El pedido", order.branchId);
      const delta = correct - order.companyAmount;
      await prisma.$transaction(async (tx) => {
        await tx.shipdayOrder.update({ where: { id: order.id }, data: { companyAmount: correct } });
        if (order.driverId && delta !== 0) {
          await applyDebtDelta(tx,order.driverId,delta);
          await refreshOrderStats(tx,order);
        }
      });
      fixed++;
    }
  }
  return { total: orders.length, fixed };

  });
}

async function applyChanges(entityType: string, entityId: string, changes: ChangeMap, reviewer?: { id: string; name: string | null }) {
  validateChanges(entityType,changes);
  // Solo los campos monetarios se convierten a número; conservar números de pedido como texto.
  const newValues: Record<string, unknown> = {};
  for (const [field, val] of Object.entries(changes)) {
    const raw = val.new;
    const num = Number(raw);
    newValues[field] = numericFields.has(field) ? num : raw;
  }
  if (Object.keys(newValues).some(field => numericFields.has(field))) {
    await assertEntityPeriod(entityType, entityId);
  }

  switch (entityType) {
    case "ShiftClose": {
      // #2 — Edición de cierre de turno autorizada por el admin.
      const sc = await prisma.shiftClose.findUnique({ where: { id: entityId } });
      if (!sc) throw notFound("El registro ya no existe; rechaza esta solicitud.");
      {
        const data: Record<string, unknown> = { ...newValues };
        // Recalcular diferencia si cambió el total esperado o contado.
        const totalExpected = (newValues.totalExpected as number) ?? sc.totalExpected;
        const totalCounted = (newValues.totalCounted as number) ?? sc.totalCounted;
        data.difference = totalCounted - totalExpected;
        const bankCounted = (newValues.bankCounted as number | undefined) ?? sc.bankCounted;
        const bankExpected = (newValues.bankExpected as number | undefined) ?? sc.bankExpected;
        data.bankDifference = bankCounted == null ? null : bankCounted - (bankExpected ?? 0);
        data.editedBy = reviewer?.id ?? null;
        data.editedByName = reviewer?.name ?? null;
        data.editedAt = new Date();
        await prisma.shiftClose.update({ where: { id: entityId }, data });
      }
      break;
    }
    case "MonthlyClose": {
      // #9 — Edición de cierre mensual autorizada por el admin (campos del snapshot).
      await prisma.monthlyClose.update({ where: { id: entityId }, data: newValues });
      break;
    }
    case "ShipdayOrder":
      await applyShipdayOrderChange(entityId, newValues, reviewer);
      break;
    case "Movement": {
      const m = await prisma.movement.findUnique({ where: { id: entityId } });
      if (!m) throw notFound("El registro ya no existe; rechaza esta solicitud.");
      // Corregir un movimiento confirmado cambia la caja de SU día: debe estar abierto (D7).
      if (m.status === "confirmed") await assertOpenPeriod(m.date, movementEffectiveAt(m));
      await prisma.movement.update({ where: { id: entityId }, data: newValues });
      break;
    }
    case "BankTransaction":
      // El balance de banco se recalcula on-read, solo actualizar
      await bankSvc.edit(entityId, newValues);
      break;
    case "DriverPayment":
      await applyDriverPaymentChange(entityId, newValues);
      break;
    case "BaseTransaction":
      await applyBaseTransactionChange(entityId, newValues);
      break;
    case "ClientDebt":
      await applyClientDebtChange(entityId, newValues);
      break;
    case "Conversion":
      await prisma.conversion.update({ where: { id: entityId }, data: newValues });
      break;
    case "HourlyShift":
      // Turno por hora: recalcula montos y ajusta dinero (ver editShift). Solo se pasan
      // los campos editables; driverName va solo para mostrar en la solicitud y se ignora.
      await editHourlyShift(entityId, {
        driverId: newValues.driverId != null ? String(newValues.driverId) : undefined,
        startTime: newValues.startTime != null ? String(newValues.startTime) : undefined,
        endTime: newValues.endTime != null ? String(newValues.endTime) : undefined,
        date: newValues.date != null ? String(newValues.date) : undefined,
        confirmOvernight: String(newValues.confirmOvernight) === "true",
      });
      break;
    default:
      throw badRequest(`La edición de ${entityType} no está implementada.`);
  }
}

/** Guardia compartida por aprobaciones y reversiones; corre dentro de moneyTransaction. */
async function assertEntityPeriod(entity: string, id: string) {
  if (entity === "ShiftClose" || entity === "MonthlyClose") {
    throw conflict("Un Cierre conserva su conteo original: no se elimina ni se reescribe. Para corregir el dinero de ese día, solicita editar, eliminar o agregar el movimiento (D7).");
  }
  if (entity === "DriverPayment") {
    const row = await prisma.driverPayment.findUniqueOrThrow({ where: { id } });
    await assertOpenInstant(row.date, "El pago", row.branchId);
  } else if (entity === "BaseTransaction") {
    const row = await prisma.baseTransaction.findUniqueOrThrow({ where: { id } });
    await assertOpenInstant(row.date, "La base", row.branchId);
  } else if (entity === "ClientDebt") {
    const row = await prisma.clientDebt.findUniqueOrThrow({ where: { id } });
    await assertOpenInstant(row.createdAt, "La deuda");
  } else if (entity === "Conversion") {
    const row = await prisma.conversion.findUniqueOrThrow({ where: { id } });
    await assertOpenInstant(row.date, "La conversión", row.branchId);
  } else if (entity === "ShipdayOrder") {
    const row = await prisma.shipdayOrder.findUniqueOrThrow({ where: { id } });
    // INC-R2-05: un pedido no mueve caja ni banco (decisión del 14-oct): corregirlo o eliminarlo solo lo bloquea
    // un MES cerrado, igual que cargarlo. Antes se exigía el instante del último cierre de mes y un pedido del mes
    // abierto anterior a ese instante (p. ej. del día 1, si el mes anterior se cerró el día 2) quedaba sin corrección.
    await assertOrderPeriodOpen(row.deliveredAt ?? row.createdAt, "El pedido", row.branchId);
  }
}

// ── ShipdayOrder: recalcular % empresa, deuda del driver y stats diarias ──────
async function applyShipdayOrderChange(orderId: string, newValues: Record<string, unknown>, reviewer?: {id:string;name:string|null}) {
  const order = await prisma.shipdayOrder.findUnique({where:{id:orderId}});
  if (!order) throw notFound("Pedido no encontrado");
  const value = newValues.deliveryValue == null ? order.deliveryValue : Number(newValues.deliveryValue);
  if (!Number.isSafeInteger(value) || value < 0) throw badRequest("Tarifa inválida");
  const settings = await prisma.settings.findUnique({where:{id:"singleton"}});
  const companyAmount = newValues.deliveryValue == null ? order.companyAmount : Math.round(value*(settings?.shipdayCommission ?? 30)/100);
  const linked = await prisma.clientDebt.findUnique({where:{sourceOrderId:orderId}});
  if (order.addToClientDebt && !linked && value !== order.deliveryValue) throw badRequest("La deuda de este pedido histórico requiere conciliación antes de editar su tarifa.");
  if (linked && value < (linked.paidAmount ?? 0)) throw badRequest("Revierte los abonos que superan el nuevo valor antes de editar el pedido.");
  await prisma.shipdayOrder.update({where:{id:orderId},data:{...newValues,deliveryValue:value,companyAmount,
    ...(newValues.deliveryValue == null ? {} : {manualOverride:true,manualOriginalValue:order.manualOriginalValue ?? order.deliveryValue,manualOverrideBy:reviewer?.id ?? null,manualOverrideAt:new Date()})}});
  if(order.driverId) await applyDebtDelta(prisma,order.driverId,companyAmount-order.companyAmount);
  if(linked && value!==linked.amount){
    await prisma.clientDebt.update({where:{id:linked.id},data:{amount:value,paid:(linked.paidAmount ?? 0)>=value}});
    await prisma.client.update({where:{id:linked.clientId},data:{pendingDebt:{increment:value-linked.amount}}});
  }
  await refreshOrderStats(prisma,order);
}

// ── DriverPayment: ajustar deuda del driver por la diferencia ─────────────────
async function applyDriverPaymentChange(paymentId: string, newValues: Record<string, unknown>) {
  const payment = await prisma.driverPayment.findUnique({ where: { id: paymentId } });
  if (!payment) throw new Error("Pago no encontrado");
  if (payment.bankTransactionId) throw badRequest("Corrige el cobro original en Movimientos.");

  const newAmount = newValues.amount != null ? Number(newValues.amount) : payment.amount;
  const delta = newAmount - payment.amount;

  await prisma.$transaction(async (tx) => {
    await tx.driverPayment.update({ where: { id: paymentId }, data: { ...newValues, amount: newAmount } });
    if (delta !== 0) {
      // Un pago mayor reduce más la deuda → pendingDebt -= delta
      await applyDebtDelta(tx,payment.driverId,-delta);
    }
  });
}

// ── BaseTransaction: ajustar deuda del driver por la diferencia ───────────────
async function applyBaseTransactionChange(baseId: string, newValues: Record<string, unknown>) {
  const base = await prisma.baseTransaction.findUnique({ where: { id: baseId } });
  if (!base) throw new Error("Base no encontrada");
  if (base.bankTransactionId) throw badRequest("Corrige el cobro original en Movimientos.");

  let newCash: number;
  let newBank: number;
  let newAmount: number;

  if (newValues.cashAmount != null || newValues.bankAmount != null) {
    // Se editó el split efectivo/banco directamente: el total se recalcula a partir de él.
    newCash = newValues.cashAmount != null ? Number(newValues.cashAmount) : base.cashAmount;
    newBank = newValues.bankAmount != null ? Number(newValues.bankAmount) : base.bankAmount;
    newAmount = newCash + newBank;
  } else if (newValues.amount != null) {
    // Se editó solo el total (campo genérico "Valor" del formulario de edición). Hay
    // que reescalar cashAmount/bankAmount proporcionalmente al nuevo total — si se
    // dejan como estaban, el saldo de banco/efectivo (que usa cashAmount/bankAmount,
    // NO amount) queda descuadrado con el valor ya corregido. Bug real: una entrega
    // de $1.000.000 corregida a $100.000 dejó bankAmount en $1.000.000, y el saldo
    // de banco seguía reflejando el monto viejo aunque la deuda ya estaba bien.
    newAmount = Number(newValues.amount);
    const oldTotal = base.cashAmount + base.bankAmount;
    if (oldTotal > 0) {
      newBank = Math.round(base.bankAmount * (newAmount / oldTotal));
      newCash = newAmount - newBank;
    } else {
      newCash = newAmount;
      newBank = 0;
    }
  } else {
    newCash = base.cashAmount;
    newBank = base.bankAmount;
    newAmount = base.amount;
  }

  if (!Number.isSafeInteger(newAmount) || newAmount <= 0 || newCash < 0 || newBank < 0) throw badRequest("Monto inválido");
  const delta = newAmount - base.amount;
  // F14: solo cambia el libro de base (y la caja); nunca la deuda por comisiones.
  const l = await getBaseLedger(prisma, base.driverId);
  if (l.given + (base.type === "entrega" ? delta : 0) < l.returned + (base.type === "pago" ? delta : 0)) {
    throw conflict("La base quedaría con más devoluciones que entregas.");
  }
  await prisma.baseTransaction.update({ where: { id: baseId }, data: { ...newValues, cashAmount: newCash, bankAmount: newBank, amount: newAmount } });
}

// ── ClientDebt: ajustar pendingDebt del cliente por la diferencia ─────────────
async function applyClientDebtChange(debtId: string, newValues: Record<string, unknown>) {
  const debt = await prisma.clientDebt.findUnique({where:{id:debtId}});
  if (!debt) throw notFound("Deuda no encontrada");
  if(debt.sourceOrderId) throw badRequest("Corrige el pedido que generó esta deuda.");
  const amount = newValues.amount == null ? debt.amount : Number(newValues.amount);
  if(!Number.isSafeInteger(amount) || amount <= 0 || amount < (debt.paidAmount ?? 0)) throw badRequest("El valor no puede ser inferior a lo ya cobrado.");
  await prisma.clientDebt.update({where:{id:debtId},data:{...newValues,amount,paid:(debt.paidAmount ?? 0)>=amount}});
  await prisma.client.update({where:{id:debt.clientId},data:{pendingDebt:{increment:amount-debt.amount}}});
}
