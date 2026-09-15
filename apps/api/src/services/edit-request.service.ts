import { prisma } from "../lib/prisma";
import { notFound, badRequest } from "../lib/errors";
import { toBogotaDateStr } from "../lib/date-range";
import { BANK_LINKED_PAYMENT_NOTE, BANK_LINKED_BASE_PREFIX } from "../lib/balance-markers";
import { applyDebtDelta } from "./driver.service";
import { deleteShift as deleteHourlyShift, editShift as editHourlyShift, deleteHourlyBankTx } from "./hourly-client.service";

type ChangeMap = Record<string, { old: string; new: string }>;

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

export async function createRequest(data: {
  requesterId: string;
  entityType: string;
  entityId: string;
  entityLabel: string;
  changes: ChangeMap;
  reason: string;
  requestType?: "edit" | "delete";
}) {
  if (!data.reason.trim()) throw badRequest("Debes indicar el motivo");
  const requestType = data.requestType ?? "edit";
  if (requestType === "edit" && Object.keys(data.changes).length === 0) {
    throw badRequest("Debes especificar al menos un campo a cambiar");
  }
  return prisma.editRequest.create({
    data: {
      requesterId: data.requesterId,
      requestType,
      entityType: data.entityType,
      entityId: data.entityId,
      entityLabel: data.entityLabel,
      changes: data.changes,
      reason: data.reason,
    },
    include: {
      requester: { select: { id: true, name: true } },
    },
  });
}

export async function reviewRequest(id: string, reviewerId: string, action: "approved" | "rejected", notes?: string) {
  const req = await prisma.editRequest.findUnique({ where: { id } });
  if (!req) throw notFound("Solicitud no encontrada");
  if (req.status !== "pending") throw badRequest("Esta solicitud ya fue procesada");

  // Aplicar el efecto ANTES de marcar la solicitud. Si el borrado/edición falla, la
  // solicitud queda "pending" y el error sube al admin (puede reintentar) — nunca queda
  // "Aprobada" en el historial sin haber tocado nada. Antes se marcaba aprobada primero
  // y luego se aplicaba el efecto: un fallo dejaba un falso "Aprobada" (parte del bug del
  // Pedido #35). El propio efecto de cada entidad ya es transaccional.
  if (action === "approved") {
    if (req.requestType === "delete") {
      await deleteEntity(req.entityType, req.entityId, reviewerId);
    } else {
      const reviewer = await prisma.user.findUnique({ where: { id: reviewerId }, select: { name: true } });
      await applyChanges(req.entityType, req.entityId, req.changes as ChangeMap, { id: reviewerId, name: reviewer?.name ?? null });
    }
  }

  // Marcar el estado de la solicitud solo si el efecto anterior no lanzó.
  const updated = await prisma.editRequest.update({
    where: { id },
    data: {
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
}

// ── Eliminar entidad revirtiendo sus efectos en deudas/saldos ─────────────────
async function deleteEntity(entityType: string, entityId: string, deletedBy?: string) {
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
        // Revertir stats diarias
        if (order.driverId && order.deliveredAt) {
          const dateStr = toBogotaDateStr(order.deliveredAt);
          const stat = await tx.dailyDriverStat.findUnique({
            where: { date_driverId: { date: dateStr, driverId: order.driverId } },
          });
          if (stat) {
            await tx.dailyDriverStat.update({
              where: { date_driverId: { date: dateStr, driverId: order.driverId } },
              data: {
                orderCount: { decrement: 1 },
                totalValue: { decrement: order.deliveryValue },
                companyTotal: { decrement: order.companyAmount },
              },
            });
          }
        }
        await tx.shipdayOrder.delete({ where: { id: entityId } });
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
    case "Movement":
      await prisma.movement.delete({ where: { id: entityId } });
      break;
    case "BankTransaction": {
      const bankTx = await prisma.bankTransaction.findUnique({ where: { id: entityId } });
      if (!bankTx) break;
      // Movimiento de un turno por hora: delegar al módulo por-hora, que borra el turno
      // (egreso = pago al domi) o revierte el cobro (ingreso) y sincroniza la deuda del
      // cliente. Así, borrar desde Movimientos también lo borra de Clientes por hora.
      if (bankTx.hourlyShiftId) {
        await deleteHourlyBankTx(entityId);
        break;
      }
      await prisma.$transaction(async (tx) => {
        // Si este movimiento redujo la deuda de un domiciliario, revertirla y limpiar
        // los registros contables subsidiarios (BaseTransaction + DriverPayment
        // bank-linked) que se crearon junto a este bankTransaction.
        //
        // La condición es debtApplied != 0 (marca explícita), NO (noCounterpart && type=="ingreso").
        // Debe quedar SINCRONIZADO con bank-transaction.service.ts::remove(). Ver esa nota y schema.prisma.
        //   debtApplied > 0 → ingreso que descontó deuda.  debtApplied < 0 → egreso que pagó crédito (payCredit).
        if (bankTx.driverId && bankTx.debtApplied !== 0) {
          // Revertir por POSICIÓN NETA (deuda − crédito): `net + debtApplied` restaura pendingDebt o
          // creditAmount para AMBOS signos, sin dejar saldo fantasma ("la empresa le debe" que no
          // desaparecía, o deuda que no volvía).
          const drv = await tx.driver.findUnique({ where: { id: bankTx.driverId } });
          if (drv) {
            const net = (drv.pendingDebt - (drv.creditAmount ?? 0)) + bankTx.debtApplied;
            await tx.driver.update({
              where: { id: bankTx.driverId },
              data: {
                pendingDebt: net > 0 ? net : 0,
                creditAmount: net < 0 ? -net : 0,
                creditMedium: net < 0 ? drv.creditMedium : null,
              },
            });
          }
          // Registros contables subsidiarios SOLO existen para pagos-INGRESO (debtApplied > 0);
          // payCredit (debtApplied < 0) no crea ninguno. Búsqueda por ID; respaldo por ventana ±5s
          // solo para registros viejos sin enlace directo. Ver bank-transaction.service.ts::remove().
          if (bankTx.debtApplied > 0) {
            const window = { gte: new Date(bankTx.date.getTime() - 5000), lte: new Date(bankTx.date.getTime() + 5000) };
            await tx.baseTransaction.deleteMany({
              where: {
                driverId: bankTx.driverId,
                type: "pago",
                notes: { startsWith: BANK_LINKED_BASE_PREFIX },
                OR: [{ bankTransactionId: bankTx.id }, { bankTransactionId: null, date: window }],
              },
            });
            await tx.driverPayment.deleteMany({
              where: {
                driverId: bankTx.driverId,
                notes: { startsWith: BANK_LINKED_PAYMENT_NOTE },
                OR: [{ bankTransactionId: bankTx.id }, { bankTransactionId: null, date: window }],
              },
            });
          }
        }
        await tx.bankTransaction.delete({ where: { id: entityId } });
      });
      break;
    }
    case "DriverPayment": {
      const payment = await prisma.driverPayment.findUnique({ where: { id: entityId } });
      if (!payment) return;
      await prisma.$transaction(async (tx) => {
        // El pago reducía la deuda → al eliminarlo, la deuda vuelve a subir
        await tx.driver.update({
          where: { id: payment.driverId },
          data: { pendingDebt: { increment: payment.amount } },
        });
        await tx.driverPayment.delete({ where: { id: entityId } });
      });
      break;
    }
    case "BaseTransaction": {
      const base = await prisma.baseTransaction.findUnique({ where: { id: entityId } });
      if (!base) return;
      await prisma.$transaction(async (tx) => {
        // Netear contra el crédito (applyDebtDelta) en vez de un increment/decrement
        // crudo: así borrar una base nunca deja pendingDebt negativo ni desincroniza el
        // crédito (mismo criterio que base.service.ts). entrega subía deuda (al borrar
        // baja), pago la bajaba (al borrar sube).
        const delta = base.type === "entrega" ? -base.amount : base.amount;
        await tx.baseTransaction.delete({ where: { id: entityId } });
        await applyDebtDelta(tx, base.driverId, delta);
      });
      break;
    }
    case "ClientDebt": {
      const debt = await prisma.clientDebt.findUnique({ where: { id: entityId } });
      if (!debt) return;
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
    case "ClientDebtPayment": {
      // Eliminar el COBRO de una deuda (registrado por error): NO borra la deuda, sino
      // que revierte el pago. Lo abonado vuelve a quedar pendiente, se limpian los
      // campos de pago y así el saldo esperado deja de contar ese ingreso y la deuda
      // del cliente regresa a su valor real.
      const debt = await prisma.clientDebt.findUnique({ where: { id: entityId } });
      if (!debt) return;
      const collected = debt.paidAmount ?? 0;
      if (collected <= 0) return;
      await prisma.$transaction(async (tx) => {
        await tx.client.update({
          where: { id: debt.clientId },
          data: { pendingDebt: { increment: collected } },
        });
        await tx.clientDebt.update({
          where: { id: entityId },
          data: {
            paid: false,
            paidAt: null,
            paidAmount: 0,
            paidCash: 0,
            paidBank: 0,
            paidBy: null,
            paidByName: null,
          },
        });
      });
      break;
    }
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
      console.warn(`[delete-request] entityType desconocido: ${entityType}`);
  }
}

// ── Recalcular companyAmount de TODOS los pedidos según la comisión actual ────
// Corrige descuadres heredados y ajusta la deuda de los domiciliarios.
export async function recalcAllOrders() {
  const settings = await prisma.settings.findUnique({ where: { id: "singleton" } });
  const commissionPercent = settings?.shipdayCommission ?? 30;
  const orders = await prisma.shipdayOrder.findMany();
  let fixed = 0;

  for (const order of orders) {
    const correct = Math.round(order.deliveryValue * (commissionPercent / 100));
    if (correct !== order.companyAmount) {
      const delta = correct - order.companyAmount;
      await prisma.$transaction(async (tx) => {
        await tx.shipdayOrder.update({ where: { id: order.id }, data: { companyAmount: correct } });
        if (order.driverId && delta !== 0) {
          await tx.driver.update({
            where: { id: order.driverId },
            data: { pendingDebt: { increment: delta } },
          });
        }
      });
      fixed++;
    }
  }
  return { total: orders.length, fixed };
}

async function applyChanges(entityType: string, entityId: string, changes: ChangeMap, reviewer?: { id: string; name: string | null }) {
  // Extraer solo los valores nuevos como objeto, con tipos correctos
  const newValues: Record<string, unknown> = {};
  for (const [field, val] of Object.entries(changes)) {
    const raw = val.new;
    const num = Number(raw);
    newValues[field] = !isNaN(num) && raw.trim() !== "" ? num : raw;
  }

  switch (entityType) {
    case "ShiftClose": {
      // #2 — Edición de cierre de turno autorizada por el admin.
      const sc = await prisma.shiftClose.findUnique({ where: { id: entityId } });
      if (sc) {
        const data: Record<string, unknown> = { ...newValues };
        // Recalcular diferencia si cambió el total esperado o contado.
        const totalExpected = (newValues.totalExpected as number) ?? sc.totalExpected;
        const totalCounted = (newValues.totalCounted as number) ?? sc.totalCounted;
        data.difference = totalCounted - totalExpected;
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
      await applyShipdayOrderChange(entityId, newValues);
      break;
    case "Movement":
      // El balance de caja se recalcula on-read desde los movimientos, así que solo actualizar
      await prisma.movement.update({ where: { id: entityId }, data: newValues });
      break;
    case "BankTransaction":
      // El balance de banco se recalcula on-read, solo actualizar
      await prisma.bankTransaction.update({ where: { id: entityId }, data: newValues });
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
      });
      break;
    default:
      console.warn(`[edit-request] entityType desconocido: ${entityType}`);
  }
}

// ── ShipdayOrder: recalcular % empresa, deuda del driver y stats diarias ──────
async function applyShipdayOrderChange(orderId: string, newValues: Record<string, unknown>) {
  const order = await prisma.shipdayOrder.findUnique({ where: { id: orderId } });
  if (!order) throw new Error("Pedido no encontrado");

  const newDeliveryValue = newValues.deliveryValue != null ? Number(newValues.deliveryValue) : order.deliveryValue;

  // Recalcular companyAmount con el % de comisión actual
  const settings = await prisma.settings.findUnique({ where: { id: "singleton" } });
  const commissionPercent = settings?.shipdayCommission ?? 30;
  const newCompanyAmount = Math.round(newDeliveryValue * (commissionPercent / 100));

  const deltaCompany = newCompanyAmount - order.companyAmount;
  const deltaValue = newDeliveryValue - order.deliveryValue;

  await prisma.$transaction(async (tx) => {
    // Actualizar el pedido con el valor nuevo + companyAmount recalculado
    await tx.shipdayOrder.update({
      where: { id: orderId },
      data: { ...newValues, deliveryValue: newDeliveryValue, companyAmount: newCompanyAmount },
    });

    if (order.driverId && deltaCompany !== 0) {
      // Ajustar la deuda del domiciliario por la diferencia de comisión
      await tx.driver.update({
        where: { id: order.driverId },
        data: { pendingDebt: { increment: deltaCompany } },
      });
    }

    // Ajustar las estadísticas diarias del domiciliario
    if (order.driverId && order.deliveredAt) {
      const dateStr = order.deliveredAt.toISOString().slice(0, 10);
      const stat = await tx.dailyDriverStat.findUnique({
        where: { date_driverId: { date: dateStr, driverId: order.driverId } },
      });
      if (stat) {
        await tx.dailyDriverStat.update({
          where: { date_driverId: { date: dateStr, driverId: order.driverId } },
          data: {
            totalValue: { increment: deltaValue },
            companyTotal: { increment: deltaCompany },
          },
        });
      }
    }
  });
}

// ── DriverPayment: ajustar deuda del driver por la diferencia ─────────────────
async function applyDriverPaymentChange(paymentId: string, newValues: Record<string, unknown>) {
  const payment = await prisma.driverPayment.findUnique({ where: { id: paymentId } });
  if (!payment) throw new Error("Pago no encontrado");

  const newAmount = newValues.amount != null ? Number(newValues.amount) : payment.amount;
  const delta = newAmount - payment.amount;

  await prisma.$transaction(async (tx) => {
    await tx.driverPayment.update({ where: { id: paymentId }, data: { ...newValues, amount: newAmount } });
    if (delta !== 0) {
      // Un pago mayor reduce más la deuda → pendingDebt -= delta
      await tx.driver.update({
        where: { id: payment.driverId },
        data: { pendingDebt: { decrement: delta } },
      });
    }
  });
}

// ── BaseTransaction: ajustar deuda del driver por la diferencia ───────────────
async function applyBaseTransactionChange(baseId: string, newValues: Record<string, unknown>) {
  const base = await prisma.baseTransaction.findUnique({ where: { id: baseId } });
  if (!base) throw new Error("Base no encontrada");

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

  const delta = newAmount - base.amount;

  await prisma.$transaction(async (tx) => {
    await tx.baseTransaction.update({ where: { id: baseId }, data: { ...newValues, cashAmount: newCash, bankAmount: newBank, amount: newAmount } });
    if (delta !== 0) {
      // entrega aumenta deuda, pago la reduce
      const sign = base.type === "entrega" ? 1 : -1;
      await tx.driver.update({
        where: { id: base.driverId },
        data: { pendingDebt: { increment: sign * delta } },
      });
    }
  });
}

// ── ClientDebt: ajustar pendingDebt del cliente por la diferencia ─────────────
async function applyClientDebtChange(debtId: string, newValues: Record<string, unknown>) {
  const debt = await prisma.clientDebt.findUnique({ where: { id: debtId } });
  if (!debt) throw new Error("Deuda no encontrada");

  const newAmount = newValues.amount != null ? Number(newValues.amount) : debt.amount;
  const delta = newAmount - debt.amount;

  await prisma.$transaction(async (tx) => {
    await tx.clientDebt.update({ where: { id: debtId }, data: { ...newValues, amount: newAmount } });
    // Solo afecta la deuda del cliente si la deuda sigue pendiente (no pagada)
    if (delta !== 0 && !debt.paid) {
      await tx.client.update({
        where: { id: debt.clientId },
        data: { pendingDebt: { increment: delta } },
      });
    }
  });
}
