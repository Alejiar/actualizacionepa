import type { NextFunction, Request, Response } from "express";
import { HttpError } from "../lib/errors";

export function notFoundHandler(req: Request, res: Response, next: NextFunction) {
  if (req.path.startsWith("/api")) {
    return res.status(404).json({ error: "Ruta no encontrada" });
  }
  next();
}

// Traduce errores conocidos de Prisma/PostgreSQL a respuestas controladas. Nunca envía
// al navegador mensajes internos (rutas de archivos, SQL): solo se registran en el log.
function mapKnownError(err: unknown): HttpError | null {
  const e = err as { code?: string; meta?: { code?: string } } | null;
  const code = e?.code, pgCode = e?.meta?.code;
  // 55P03 = lock_timeout (otro proceso retiene la caja); P2034 = conflicto de transacción.
  if (pgCode === "55P03" || code === "P2034") return new HttpError(503, "Caja ocupada; reintenta la operación.");
  if (code === "P2028") return new HttpError(503, "La operación tardó demasiado; reintenta.");
  if (code === "P2025") return new HttpError(404, "Registro no encontrado");
  if (code === "P2003") return new HttpError(409, "El registro está relacionado con otros datos y no se puede modificar así.");
  if (code === "P2002") return new HttpError(409, "Ya existe un registro con esos datos.");
  if (code === "P2000" || code === "P2006" || code === "P2007" || code === "P2009" || code === "P2012" || code === "P2033") return new HttpError(400, "Datos inválidos.");
  if (err instanceof Error && err.name === "PrismaClientValidationError") return new HttpError(400, "Datos inválidos.");
  return null;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: err.message, details: err.details });
  }
  // Errores de body-parser (JSON mal formado, cuerpo demasiado grande): traen su propio 4xx.
  const bp = err as { status?: number; expose?: boolean } | null;
  if (bp && typeof bp.status === "number" && bp.status >= 400 && bp.status < 500 && bp.expose) {
    return res.status(bp.status).json({ error: bp.status === 413 ? "Solicitud demasiado grande" : "Solicitud mal formada" });
  }
  const known = mapKnownError(err);
  if (known) {
    if (known.status >= 500) console.error("[error]", err);
    return res.status(known.status).json({ error: known.message });
  }
  console.error("[error]", err);
  res.status(500).json({ error: "Error interno del servidor" });
}

// Envuelve handlers async para propagar errores al errorHandler.
export function asyncHandler<T extends (req: Request, res: Response, next: NextFunction) => Promise<unknown>>(
  fn: T,
) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}
