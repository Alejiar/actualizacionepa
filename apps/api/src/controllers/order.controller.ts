import { randomUUID } from "node:crypto";
import { applyDebtDelta } from "../services/driver.service";
import type { Request, Response } from "express";
import { prisma, moneyTransaction } from "../lib/prisma";
import { badRequest, conflict, notFound } from "../lib/errors";
import { bogotaDayRange, toBogotaDateStr } from "../lib/date-range";
import { assertMoney } from "../lib/money-validation";
import { assertOrderPeriodOpen, operatingClock, parseFinancialTimestamp } from "../lib/period-guard";

/**
 * Pedido manual (decisión del dueño, 15-oct-2026): se registra con su fecha REAL de entrega,
 * aunque ese día ya tenga Cierre, igual que un pedido de Shipday (`assertOrderPeriodOpen`):
 * un pedido no mueve efectivo ni banco (solo comisión/deuda del domiciliario y, si se pide,
 * una deuda FIADA del cliente), así que no altera el conteo del Cierre. Solo lo bloquea que
 * su MES esté cerrado. Las operaciones que sí mueven dinero siguen con la guardia D7.
 *
 * `idempotencyKey` (opcional, la manda el asistente): un reintento con la misma clave devuelve
 * el pedido ya creado sin volver a sumar comisión. Además se rechaza un segundo pedido con el
 * mismo número, en la misma sucursal y el mismo día.
 */
export async function manualCreate(req: Request, res: Response) {
  const { branchId, driverId, deliveryValue, orderNumber, customerName, clientId, addToClientDebt, notes, deliveredAt, idempotencyKey } = req.body ?? {};
  if (!branchId || typeof branchId !== "string") throw badRequest("Selecciona la sucursal del pedido.");
  if (!Number.isSafeInteger(deliveryValue) || deliveryValue <= 0) throw badRequest("El valor del domicilio debe ser un número entero mayor a 0.");
  assertMoney(deliveryValue);
  if (orderNumber != null && (typeof orderNumber !== "string" || orderNumber.trim().length > 40)) throw badRequest("Número de pedido inválido.");
  if (idempotencyKey != null && (typeof idempotencyKey !== "string" || !/^[A-Za-z0-9_-]{8,64}$/.test(idempotencyKey))) {
    throw badRequest("Clave de reintento inválida.");
  }
  const number = typeof orderNumber === "string" && orderNumber.trim() ? orderNumber.trim() : null;

  const { result, replay } = await moneyTransaction(async () => {
    const shipdayOrderId = `manual-${idempotencyKey ?? randomUUID()}`;
    if (idempotencyKey) {
      const existing = await prisma.shipdayOrder.findUnique({ where: { shipdayOrderId }, include: { client: { select: { id: true, name: true } } } });
      if (existing) return { result: existing, replay: true };
    }

    // NEW02: sin fecha, o con la del día operativo, el pedido cuenta en el día operativo (la caja
    // abierta); una fecha anterior conserva su día real (decisión del 15-oct).
    const op = await operatingClock();
    const at = deliveredAt === undefined || deliveredAt === null || deliveredAt === ""
      ? op.at
      : parseFinancialTimestamp(deliveredAt, new Date(), "La fecha de entrega", op);
    const day = toBogotaDateStr(at);

    const branch = await prisma.branch.findUnique({ where: { id: branchId } });
    if (!branch) throw notFound("Sucursal no encontrada");
    if (!branch.active) throw badRequest("La sucursal está desactivada");
    await assertOrderPeriodOpen(at, "El pedido manual", branch.id);

    if (driverId) {
      const driver = await prisma.driver.findUnique({ where: { id: driverId } });
      if (!driver || driver.branchId !== branchId) throw badRequest("El domiciliario no pertenece a esta sucursal");
      if (!driver.active) throw badRequest("El domiciliario está desactivado. Reactívalo antes de registrarle pedidos.");
    }
    if (clientId) {
      const client = await prisma.client.findUnique({ where: { id: clientId } });
      if (!client) throw notFound("Cliente no encontrado");
    }
    if (number) {
      const dup = await prisma.shipdayOrder.findFirst({
        where: { branchId, orderNumber: number, deliveredAt: bogotaDayRange(day) },
        select: { id: true },
      });
      if (dup) throw conflict(`Ya existe el pedido #${number} en esta sucursal el ${day}. No se registró de nuevo.`);
    }

    const settings = await prisma.settings.findUnique({ where: { id: "singleton" } });
    const commissionPercent = settings?.shipdayCommission ?? 30;
    const companyAmount = Math.round(deliveryValue * (commissionPercent / 100));
    const createdAt = op.at; // NEW02: registro (y deuda fiada vinculada) en el día operativo

    const created = await prisma.$transaction(async (tx) => {
      const order = await tx.shipdayOrder.create({
        data: {
          shipdayOrderId,
          branchId,
          driverId: driverId || null,
          orderNumber: number,
          deliveryValue,
          companyAmount,
          customerName: customerName || null,
          clientId: clientId || null,
          addToClientDebt: addToClientDebt === true,
          status: "DELIVERED",
          deliveredAt: at,
          createdAt,
          rawData: { manual: true, notes, registeredAt: createdAt.toISOString(), deliveredDay: day },
        },
        include: { client: { select: { id: true, name: true } } },
      });

      if (driverId && companyAmount > 0) {
        await applyDebtDelta(tx, driverId, companyAmount);
        // La estadística va al día REAL de entrega (antes usaba "hoy" aunque el pedido fuera de otro día).
        await tx.dailyDriverStat.upsert({
          where: { date_driverId: { date: day, driverId } },
          create: { date: day, branchId, driverId, orderCount: 1, totalValue: deliveryValue, companyTotal: companyAmount },
          update: { orderCount: { increment: 1 }, totalValue: { increment: deliveryValue }, companyTotal: { increment: companyAmount } },
        });
      }

      // Deuda FIADA del cliente (sin medio): no sale dinero de la caja.
      if (clientId && addToClientDebt) {
        const [y, m, d] = day.split("-");
        await tx.clientDebt.create({
          data: { sourceOrderId: order.id, clientId, description: `Domicilio${number ? ` #${number}` : ""} — ${d}/${m}/${y}`, amount: deliveryValue, createdAt: at },
        });
        await tx.client.update({ where: { id: clientId }, data: { pendingDebt: { increment: deliveryValue } } });
      }
      return order;
    });
    return { result: created, replay: false };
  });

  res.status(replay ? 200 : 201).json({ ...result, companyAmount: result.companyAmount, replay });
}
