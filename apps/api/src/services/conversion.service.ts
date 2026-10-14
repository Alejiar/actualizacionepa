import { assertMoney } from "../lib/money-validation";
import { prisma, moneyTransaction } from "../lib/prisma";
import { assertOpenPeriod } from "../lib/period-guard";
import { notFound, badRequest } from "../lib/errors";
import { bogotaOpenRange, toBogotaDateStr } from "../lib/date-range";

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
  // Serializada con el resto de la caja: una conversión mueve efectivo y banco esperados.
  return moneyTransaction(async () => {
  const branch = await prisma.branch.findUnique({ where: { id: input.branchId } });
  if (!branch) throw notFound("Sucursal no encontrada");
  assertMoney(input.amount);
  if (input.type !== "banco_a_efectivo" && input.type !== "efectivo_a_banco") throw badRequest("Tipo de conversión inválido.");
  const now = new Date();
  const when = input.date ? new Date(input.date) : now;
  if (Number.isNaN(when.getTime()) || when.getTime() > now.getTime()) throw badRequest("Fecha de conversión inválida o futura.");
  if (toBogotaDateStr(when) < toBogotaDateStr(now)) await assertOpenPeriod(toBogotaDateStr(when), when, "La conversión");

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
      date: when,
    },
    include: { branch: { select: { id: true, name: true } } },
  });
  });
}

export async function deleteConversion(id: string) {
  return moneyTransaction(async () => {
    const exists = await prisma.conversion.findUnique({ where: { id } });
    if (!exists) throw notFound("Conversión no encontrada");
    await prisma.conversion.delete({ where: { id } });
  });
}
