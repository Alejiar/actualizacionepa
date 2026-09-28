import { randomUUID } from "node:crypto";
import { applyDebtDelta } from "../services/driver.service";
import type { Request, Response } from "express";
import { prisma, moneyTransaction } from "../lib/prisma";
import { badRequest, notFound } from "../lib/errors";
import { toBogotaDateStr } from "../lib/date-range";

export async function manualCreate(req: Request, res: Response) {
  const result = await moneyTransaction(async () => {
  const { branchId, driverId, deliveryValue, orderNumber, customerName, clientId, addToClientDebt, notes } = req.body;
  if (!branchId || !Number.isSafeInteger(deliveryValue) || deliveryValue <= 0) throw badRequest("branchId y deliveryValue son requeridos");

  const branch = await prisma.branch.findUnique({ where: { id: branchId } });
  if (!branch) throw notFound("Sucursal no encontrada");
  if (!branch.active) throw badRequest("La sucursal está desactivada");
  if (driverId) {
    const driver = await prisma.driver.findUnique({where:{id:driverId}});
    if (!driver || driver.branchId !== branchId) throw badRequest("El domiciliario no pertenece a esta sucursal");
  }

  if (clientId) {
    const client = await prisma.client.findUnique({ where: { id: clientId } });
    if (!client) throw notFound("Cliente no encontrado");
  }

  const settings = await prisma.settings.findUnique({ where: { id: "singleton" } });
  const commissionPercent = settings?.shipdayCommission ?? 30;
  const companyAmount = Math.round(deliveryValue * (commissionPercent / 100));

  const order = await prisma.$transaction(async (tx) => {
    const created = await tx.shipdayOrder.create({
      data: {
        shipdayOrderId: `manual-${randomUUID()}`,
        branchId,
        driverId: driverId || null,
        orderNumber: orderNumber || null,
        deliveryValue: Math.round(deliveryValue),
        companyAmount,
        customerName: customerName || null,
        clientId: clientId || null,
        addToClientDebt: addToClientDebt === true,
        status: "DELIVERED",
        deliveredAt: new Date(),
        rawData: { manual: true, notes },
      },
      include: { client: { select: { id: true, name: true } } },
    });

    if (driverId && companyAmount > 0) {
      await applyDebtDelta(tx, driverId, companyAmount);
      const dateStr = toBogotaDateStr(new Date());
      await tx.dailyDriverStat.upsert({
        where: { date_driverId: { date: dateStr, driverId } },
        create: { date: dateStr, branchId, driverId, orderCount: 1, totalValue: Math.round(deliveryValue), companyTotal: companyAmount },
        update: { orderCount: { increment: 1 }, totalValue: { increment: Math.round(deliveryValue) }, companyTotal: { increment: companyAmount } },
      });
    }

    // Si se solicitó agregar al saldo del cliente, crear deuda automáticamente
    if (clientId && addToClientDebt) {
      const desc = `Domicilio${orderNumber ? ` #${orderNumber}` : ""} — ${new Date().toLocaleDateString("es-CO")}`;
      await tx.clientDebt.create({
        data: { sourceOrderId: created.id, clientId, description: desc, amount: Math.round(deliveryValue) },
      });
      await tx.client.update({
        where: { id: clientId },
        data: { pendingDebt: { increment: Math.round(deliveryValue) } },
      });
    }

    return created;
  });

  return { ...order, companyAmount };

  });
  res.status(201).json(result);
}
