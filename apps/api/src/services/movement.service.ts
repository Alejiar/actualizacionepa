import { assertMoney } from "../lib/money-validation";
import type { CreateMovementRequest, Movement, UpdateMovementRequest } from "@cash-buddy/shared";
import { prisma, moneyTransaction } from "../lib/prisma";
import { notFound, badRequest, unauthorized } from "../lib/errors";
import { ensureDay } from "./day.service";
import { toMovement } from "./mappers";

function nowTime(): string {
  return new Date().toLocaleTimeString("es-CO", { timeZone: "America/Bogota", hour: "2-digit", minute: "2-digit" });
}

function isExpense(category: number | undefined) { return category === 3 || category === 4; }
function validateExpense(input: {category:number;type:string;medium:string}) {
  if (isExpense(input.category) && (input.type !== "egreso" || input.medium !== (input.category === 3 ? "cash" : "bank"))) {
    throw badRequest("El gasto debe ser un egreso del medio indicado por su categoría.");
  }
}

export async function addMovement(input: CreateMovementRequest): Promise<Movement> {
  return moneyTransaction(async () => {
  assertMoney(input.amount);
  validateExpense(input);
  await ensureDay(input.date);
  const row = await prisma.movement.create({
    data: {
      date: input.date,
      time: input.time ?? nowTime(),
      category: input.category,
      type: input.type,
      medium: input.medium,
      amount: input.amount,
      status: input.status ?? "confirmed",
      workerId: input.workerId ?? null,
      description: input.description ?? null,
      group: input.group ?? null,
      kind: input.kind ?? null,
      deliveryId: input.deliveryId ?? null,
      deliveryValue: input.deliveryValue ?? null,
      taxAmount: (input as unknown as { taxAmount?: number }).taxAmount ?? null,
      createdBy: (input as unknown as { createdBy?: string }).createdBy ?? null,
      createdByName: (input as unknown as { createdByName?: string }).createdByName ?? null,
      deviceId: (input as unknown as { deviceId?: string }).deviceId ?? null,
      deviceName: (input as unknown as { deviceName?: string }).deviceName ?? null,
    },
  });
  return toMovement(row);
  });
}

export async function updateMovement(
  id: string,
  patch: UpdateMovementRequest,
  isAdmin = false,
): Promise<Movement> {
  return moneyTransaction(async () => {
  if (patch.amount !== undefined) assertMoney(patch.amount);
  const exists = await prisma.movement.findUnique({ where: { id } });
  if (!exists) throw notFound("Movimiento no encontrado");
  if (isExpense(exists.category) || isExpense(patch.category)) {
    if (!isAdmin) throw unauthorized("Se requieren permisos de administrador para editar gastos");
    if (patch.status !== undefined) throw badRequest("Usa la aprobación de gastos para cambiar su estado.");
    if (exists.status === "confirmed") throw badRequest("Un gasto confirmado se corrige mediante una solicitud aprobada por un administrador.");
  }
  validateExpense({...exists,...patch});
  const row = await prisma.movement.update({ where: { id }, data: patch });
  return toMovement(row);
  });
}

export async function deleteMovement(id: string): Promise<void> {
  return moneyTransaction(async () => {
  const exists = await prisma.movement.findUnique({ where: { id } });
  if (!exists) throw notFound("Movimiento no encontrado");
  if (isExpense(exists.category) && exists.status === "confirmed") throw badRequest("Solicita la eliminación y su aprobación para revertir un gasto confirmado.");
  await prisma.movement.delete({ where: { id } });
  });
}

export async function listMovements(date?: string): Promise<Movement[]> {
  const rows = await prisma.movement.findMany({
    where: date ? { date } : undefined,
    orderBy: [{ date: "asc" }, { createdAt: "asc" }],
  });
  return rows.map(toMovement);
}

// ── Aprobación de gastos ──────────────────────────────────────────────────────
export async function listPendingMovements() {
  const rows = await prisma.movement.findMany({
    where: { status: "pending" },
    orderBy: { createdAt: "desc" },
    include: { worker: { select: { name: true } } },
  });
  return rows;
}

export async function approveMovement(id: string, approverId: string, approverName?: string | null) {
  return moneyTransaction(async () => {
  const m = await prisma.movement.findUnique({ where: { id } });
  if (!m) throw notFound("Movimiento no encontrado");
  if (m.status !== "pending") throw badRequest("Este gasto ya fue procesado");
  assertMoney(m.amount);
  return prisma.movement.update({
    where: { id },
    data: { status: "confirmed", approvedBy: approverId, approvedByName: approverName ?? null, approvedAt: new Date() },
  });
  });
}

export async function rejectMovement(id: string) {
  return moneyTransaction(async () => {
  const m = await prisma.movement.findUnique({ where: { id } });
  if (!m) throw notFound("Movimiento no encontrado");
  if (m.status !== "pending") throw badRequest("Un gasto confirmado requiere una solicitud de eliminación.");
  await prisma.movement.delete({ where: { id } });
  return { ok: true };
  });
}
