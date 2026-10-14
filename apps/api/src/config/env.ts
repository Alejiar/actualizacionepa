import { config as loadDotenv } from "dotenv";
import path from "node:path";
import fs from "node:fs";

// Carga robusta del .env: no depende del directorio de trabajo (cwd).
// El lanzador arranca node desde apps/api, pero el .env vive en la raíz del
// monorepo. Cargamos primero el .env del cwd (compatibilidad) y luego buscamos
// hacia arriba desde este archivo el primer .env (apps/api o la raíz) para que
// DATABASE_URL siempre se encuentre, sin importar desde dónde se ejecute.
loadDotenv(); // cwd/.env si existe
{
  let dir = __dirname;
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(dir, ".env");
    if (fs.existsSync(candidate)) {
      loadDotenv({ path: candidate }); // no sobrescribe variables ya definidas
      break;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break; // raíz del disco
    dir = parent;
  }
}

function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined) {
    throw new Error(`Falta la variable de entorno requerida: ${name}`);
  }
  return value;
}

export const env = {
  nodeEnv: process.env.NODE_ENV ?? "development",
  port: Number(process.env.PORT ?? 4000),
  host: process.env.HOST ?? "0.0.0.0",
  databaseUrl: required("DATABASE_URL"),
  // En producción el secreto es obligatorio: con el valor de desarrollo cualquiera podría
  // firmar tokens de administrador.
  jwtSecret: (process.env.NODE_ENV ?? "development") === "production"
    ? required("JWT_SECRET")
    : required("JWT_SECRET", "dev-insecure-secret-change-me"),
  jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? "7d",
  admin: {
    email: process.env.ADMIN_EMAIL ?? "admin@cashbuddy.local",
    password: process.env.ADMIN_PASSWORD ?? "admin123",
    name: process.env.ADMIN_NAME ?? "Administrador",
  },
  // Carpeta del frontend estático (build de Next.js) a servir. Resuelta en index.ts.
  webDir: process.env.WEB_DIR ?? "",
  isProd: (process.env.NODE_ENV ?? "development") === "production",
};
