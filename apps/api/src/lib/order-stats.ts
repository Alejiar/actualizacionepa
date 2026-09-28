import type { Prisma } from "@prisma/client";
import { bogotaDayRange, toBogotaDateStr } from "./date-range";

export async function refreshOrderStats(tx: Prisma.TransactionClient, order: { driverId: string | null; deliveredAt: Date | null; branchId: string }) {
  if (!order.driverId || !order.deliveredAt) return;
  const date = toBogotaDateStr(order.deliveredAt);
  const totals = await tx.shipdayOrder.aggregate({
    where: { driverId: order.driverId, deliveredAt: bogotaDayRange(date), companyAmount: { gt: 0 }, status: { in: ["DELIVERED", "COMPLETED"] } },
    _count: true, _sum: { deliveryValue: true, companyAmount: true },
  });
  const data = { orderCount: totals._count, totalValue: totals._sum.deliveryValue ?? 0, companyTotal: totals._sum.companyAmount ?? 0 };
  await tx.dailyDriverStat.upsert({ where: { date_driverId: { date, driverId: order.driverId } },
    create: { date, driverId: order.driverId, branchId: order.branchId, ...data }, update: data });
}
