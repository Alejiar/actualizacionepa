import type { NextFunction, Request, Response } from "express";
import { verifyToken, type JwtPayload } from "../lib/jwt";
import { forbidden, unauthorized } from "../lib/errors";
import { prisma } from "../lib/prisma";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: JwtPayload;
    }
  }
}

/**
 * Autenticación con verificación EN LA BASE DE DATOS en cada petición. El JWT solo
 * identifica al usuario: el rol y el estado se leen de `User`. Así, degradar o
 * desactivar a un usuario surte efecto de inmediato (antes el rol viajaba en el token y
 * un admin degradado conservaba sus privilegios hasta 7 días).
 *
 * Además, cualquier cambio del usuario (rol, estado, contraseña o nombre) invalida las
 * sesiones emitidas ANTES de ese cambio (`iat` < `updatedAt`): obliga a iniciar sesión de nuevo.
 */
export async function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    return next(unauthorized("Token no proporcionado"));
  }
  const token = header.slice("Bearer ".length).trim();
  let payload: JwtPayload & { iat?: number };
  try {
    payload = verifyToken(token) as JwtPayload & { iat?: number };
  } catch {
    return next(unauthorized("Token inválido o expirado"));
  }
  try {
    const user = await prisma.user.findUnique({
      where: { id: payload.sub },
      select: { id: true, email: true, name: true, role: true, active: true, updatedAt: true },
    });
    if (!user || !user.active) return next(unauthorized("Sesión no válida: usuario inexistente o desactivado"));
    // iat está en segundos; se tolera 1 s de redondeo.
    if (payload.iat != null && payload.iat * 1000 < user.updatedAt.getTime() - 1000) {
      return next(unauthorized("Tu cuenta cambió. Inicia sesión de nuevo."));
    }
    req.user = { sub: user.id, email: user.email, name: user.name, role: user.role };
    next();
  } catch (err) {
    next(err);
  }
}

/** Falta de permisos = 403 (no 401): el frontend solo cierra sesión ante un 401. */
export function requireAdmin(req: Request, _res: Response, next: NextFunction) {
  if (!req.user) return next(unauthorized("Token no proporcionado"));
  if (req.user.role !== "admin") {
    return next(forbidden("Se requieren permisos de administrador"));
  }
  next();
}
