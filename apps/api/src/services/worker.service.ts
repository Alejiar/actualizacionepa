import type { CreateWorkerRequest, UpdateWorkerRequest, Worker } from "@cash-buddy/shared";
import { prisma } from "../lib/prisma";
import { badRequest, conflict, notFound } from "../lib/errors";
import { toWorker } from "./mappers";

const PALETTE = [
  "#00E676", "#00B0FF", "#FFB300", "#FF7043", "#AB47BC",
  "#26C6DA", "#EC407A", "#9CCC65", "#FFCA28", "#5C6BC0",
  "#FF5252", "#66BB6A", "#42A5F5", "#FFA726",
];

/** Nombre limpio, no vacío, razonable y sin repetir el de OTRO trabajador (sin distinguir mayúsculas). */
async function validName(name: unknown, exceptId?: string): Promise<string> {
  if (typeof name !== "string" || !name.trim()) throw badRequest("El nombre del trabajador es obligatorio.");
  const clean = name.trim().replace(/\s+/g, " ");
  if (clean.length > 80) throw badRequest("El nombre es demasiado largo (máximo 80 caracteres).");
  const same = await prisma.worker.findFirst({
    where: { name: { equals: clean, mode: "insensitive" }, ...(exceptId ? { id: { not: exceptId } } : {}) },
    select: { name: true },
  });
  if (same) throw conflict(`Ya existe un trabajador llamado "${same.name}".`);
  return clean;
}

export async function listWorkers(): Promise<Worker[]> {
  const rows = await prisma.worker.findMany({ orderBy: { createdAt: "asc" } });
  return rows.map(toWorker);
}

export async function createWorker(input: CreateWorkerRequest): Promise<Worker> {
  const name = await validName(input.name);
  const count = await prisma.worker.count();
  const color = input.color ?? PALETTE[count % PALETTE.length];
  const row = await prisma.worker.create({
    data: { name, role: input.role, active: input.active, color },
  });
  return toWorker(row);
}

/**
 * Renombrar o desactivar actualiza el MISMO registro (mismo id): sus pagos de nómina siguen
 * enlazados por `workerId` y ningún histórico se pierde ni se duplica.
 */
export async function updateWorker(id: string, patch: UpdateWorkerRequest): Promise<Worker> {
  const exists = await prisma.worker.findUnique({ where: { id } });
  if (!exists) throw notFound("Trabajador no encontrado");
  const data: UpdateWorkerRequest = { ...patch };
  if (patch.name !== undefined) data.name = await validName(patch.name, id);
  const row = await prisma.worker.update({ where: { id }, data });
  return toWorker(row);
}

/**
 * Eliminación física solo para un trabajador SIN historial. Con pagos u otros movimientos
 * asociados se rechaza: borrarlo dejaba esos movimientos sin trabajador (onDelete: SetNull) y
 * se perdía su nómina pagada. En ese caso se desactiva (conserva todo).
 */
export async function deleteWorker(id: string): Promise<void> {
  const exists = await prisma.worker.findUnique({ where: { id } });
  if (!exists) throw notFound("Trabajador no encontrado");
  const history = await prisma.movement.count({ where: { workerId: id } });
  if (history > 0) {
    throw conflict(`"${exists.name}" tiene ${history} movimiento(s) registrados. No se elimina para conservar su historial: desactívalo.`);
  }
  await prisma.worker.delete({ where: { id } });
}
