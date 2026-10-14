import bcrypt from "bcryptjs";
import type { AuthResponse, AuthUser, LoginRequest, RegisterRequest } from "@cash-buddy/shared";
import { prisma } from "../lib/prisma";
import { signToken } from "../lib/jwt";
import { conflict, unauthorized } from "../lib/errors";

function toAuthUser(u: { id: string; email: string; name: string; role: "admin" | "user" }): AuthUser {
  return { id: u.id, email: u.email, name: u.name, role: u.role };
}

export async function login(input: LoginRequest): Promise<AuthResponse> {
  const user = await prisma.user.findUnique({ where: { email: input.email.toLowerCase() } });
  if (!user) throw unauthorized("Credenciales inválidas");
  if (!user.active) throw unauthorized("Tu cuenta está desactivada. Contacta al administrador.");
  const ok = await bcrypt.compare(input.password, user.passwordHash);
  if (!ok) throw unauthorized("Credenciales inválidas");
  const token = signToken({ sub: user.id, email: user.email, name: user.name, role: user.role, tv: user.tokenVersion });
  return { token, user: toAuthUser(user) };
}

export async function register(input: RegisterRequest): Promise<AuthResponse> {
  const email = input.email.toLowerCase();
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) throw conflict("Ya existe un usuario con ese correo");
  const passwordHash = await bcrypt.hash(input.password, 10);
  // El primer usuario registrado es admin.
  const count = await prisma.user.count();
  const role = count === 0 ? "admin" : "user";
  const user = await prisma.user.create({
    data: { email, name: input.name, passwordHash, role },
  });
  const token = signToken({ sub: user.id, email: user.email, name: user.name, role: user.role, tv: user.tokenVersion });
  return { token, user: toAuthUser(user) };
}

export async function getCurrentUser(userId: string): Promise<AuthUser> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw unauthorized("Usuario no encontrado");
  return toAuthUser(user);
}
