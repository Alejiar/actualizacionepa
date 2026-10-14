import { assertMoney } from "../lib/money-validation";
import { prisma } from "../lib/prisma";
import { notFound, badRequest } from "../lib/errors";
import { bogotaOpenRange } from "../lib/date-range";

export async function listConversions(branchId?: string, from?: string, to?: string) {
  const where: Record<string, unknown> = {};
  if (branchId) where.branchId = branchId;
  const dateRange = bogotaOpenRange(from, to);
  if (dateRange) where.date = dateRange;
  return prisma.conversion.findMany({
    where,
    include: { branch: { select: { id: true, name: true } } },
    orderBy: { date: "desc" },
  });
}

export async function createConversion(input: {
  branchId: string;
  amount: number;
  type: "banco_a_efectivo" | "efectivo_a_banco";
  notes?: string;
  userId?: string;
  userName?: string;
  deviceId?: string | null;
  deviceName?: string | null;
  driverId?: string;
  date?: string;
}) {
  const branch = await prisma.branch.findUnique({ where: { id: input.branchId } });
  if (!branch) throw notFound("Sucursal no encontrada");
  assertMoney(input.amount);

  // El domiciliario es solo informativo: NO altera su deuda.
  let driverName: string | undefined;
  if (input.driverId) {
    const driver = await prisma.driver.findUnique({ where: { id: input.driverId } });
    driverName = driver?.name;
  }

  return prisma.conversion.create({
    data: {
      branchId: input.branchId,
      amount: input.amount,
      type: input.type,
      notes: input.notes,
      userId: input.userId,
      userName: input.userName,
      deviceId: input.deviceId ?? null,
      deviceName: input.deviceName ?? null,
      driverId: input.driverId,
      driverName,
      date: input.date ? new Date(input.date) : new Date(),
    },
    include: { branch: { select: { id: true, name: true } } },
  });
}

export async function deleteConversion(id: string) {
  const exists = await prisma.conversion.findUnique({ where: { id } });
  if (!exists) throw notFound("Conversión no encontrada");
  await prisma.conversion.delete({ where: { id } });
}
