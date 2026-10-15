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

// Nunca puede quedar el sistema sin un administrador activo: nadie podría aprobar
// solicitudes, gestionar usuarios ni corregir cierres (y no hay forma de recuperarlo desde la app).
async function assertKeepsAnActiveAdmin(user: { id: string; role: string; active: boolean }, after: { role: string; active: boolean } | null) {
  const wasActiveAdmin = user.role === "admin" && user.active;
  const staysActiveAdmin = !!after && after.role === "admin" && after.active;
  if (!wasActiveAdmin || staysActiveAdmin) return;
  const others = await prisma.user.count({ where: { role: "admin", active: true, id: { not: user.id } } });
  if (others === 0) throw badRequest("Debe quedar al menos un administrador activo. Crea o activa otro administrador primero.");
}

export async function updateUser(id: string, data: { name?: string; role?: "admin" | "user"; active?: boolean; password?: string }) {
  const user = await prisma.user.findUnique({ where: { id } });
  if (!user) throw notFound("Usuario no encontrado");
  const update: Record<string, unknown> = {};
  if (data.name) update.name = data.name;
  if (data.role) update.role = data.role;
  if (data.active !== undefined) update.active = data.active;
  await assertKeepsAnActiveAdmin(user, { role: data.role ?? user.role, active: data.active ?? user.active });
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
  await assertKeepsAnActiveAdmin(user, null);
  await prisma.user.delete({ where: { id } });
}
