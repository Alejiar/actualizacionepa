import { prisma } from "../lib/prisma";
import bcrypt from "bcryptjs";
import { notFound, conflict, badRequest } from "../lib/errors";

export async function listUsers() {
  return prisma.user.findMany({
    select: { id: true, email: true, name: true, role: true, active: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });
}

export async function createUser(data: { email: string; name: string; password: string; role: "admin" | "user" }) {
  if (data.password.length < 6) throw badRequest("La contraseña debe tener al menos 6 caracteres");
  const exists = await prisma.user.findUnique({ where: { email: data.email } });
  if (exists) throw conflict("Ya existe un usuario con ese correo");
  const passwordHash = await bcrypt.hash(data.password, 10);
  return prisma.user.create({
    data: { email: data.email, name: data.name, passwordHash, role: data.role },
    select: { id: true, email: true, name: true, role: true, active: true, createdAt: true },
  });
}

export async function updateUser(id: string, data: { name?: string; role?: "admin" | "user"; active?: boolean; password?: string }) {
  const user = await prisma.user.findUnique({ where: { id } });
  if (!user) throw notFound("Usuario no encontrado");
  const update: Record<string, unknown> = {};
  if (data.name) update.name = data.name;
  if (data.role) update.role = data.role;
  if (data.active !== undefined) update.active = data.active;
  if (data.password) {
    if (data.password.length < 6) throw badRequest("La contraseña debe tener al menos 6 caracteres");
    update.passwordHash = await bcrypt.hash(data.password, 10);
  }
  // Cambios de seguridad revocan TODAS las sesiones previas del usuario.
  if (data.password || (data.role && data.role !== user.role) || (data.active !== undefined && data.active !== user.active)) {
    update.tokenVersion = { increment: 1 };
  }
  return prisma.user.update({
    where: { id },
    data: update,
    select: { id: true, email: true, name: true, role: true, active: true, createdAt: true },
  });
}

export async function deleteUser(id: string) {
  const user = await prisma.user.findUnique({ where: { id } });
  if (!user) throw notFound("Usuario no encontrado");
  // No se puede eliminar si tiene solicitudes pendientes
  const pending = await prisma.editRequest.count({ where: { requesterId: id, status: "pending" } });
  if (pending > 0) throw badRequest("El usuario tiene solicitudes pendientes. Resuelve primero esas solicitudes.");
  await prisma.user.delete({ where: { id } });
}
