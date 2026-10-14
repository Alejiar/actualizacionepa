import jwt from "jsonwebtoken";
import type { UserRole } from "@cash-buddy/shared";
import { env } from "../config/env";

export interface JwtPayload {
  sub: string;
  email: string;
  name?: string;
  role: UserRole;
  /** Versión de sesión del usuario al emitir el token (User.tokenVersion). */
  tv?: number;
}

export function signToken(payload: JwtPayload): string {
  const options: jwt.SignOptions = { expiresIn: env.jwtExpiresIn as jwt.SignOptions["expiresIn"] };
  return jwt.sign(payload, env.jwtSecret, options);
}

export function verifyToken(token: string): JwtPayload {
  return jwt.verify(token, env.jwtSecret) as JwtPayload;
}
