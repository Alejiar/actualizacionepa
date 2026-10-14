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
 * Además, cambiar la contraseña, el rol o el estado incrementa `User.tokenVersion` y las
 * sesiones emitidas con una versión anterior dejan de ser válidas de inmediato.
 */
export async function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    return next(unauthorized("Token no proporcionado"));
  }
  const token = header.slice("Bearer ".length).trim();
  let payload: JwtPayload;
  try {
    payload = verifyToken(token);
  } catch {
    return next(unauthorized("Token inválido o expirado"));
  }
  try {
    const user = await prisma.user.findUnique({
      where: { id: payload.sub },
      select: { id: true, email: true, name: true, role: true, active: true, tokenVersion: true },
    });
    if (!user || !user.active) return next(unauthorized("Sesión no válida: usuario inexistente o desactivado"));
    // Revocación por VERSIÓN persistida (sin hueco de precisión de segundos): cambiar
    // contraseña, rol o estado incrementa tokenVersion e invalida los tokens anteriores.
    // Un token sin `tv` (emitido antes de esta versión) equivale a la versión 0.
    if ((payload.tv ?? 0) !== user.tokenVersion) {
      return next(unauthorized("Tu sesión fue cerrada por un cambio en tu cuenta. Inicia sesión de nuevo."));
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
