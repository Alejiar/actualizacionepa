// Auto-inicialización del backend al primer arranque del .exe en un PC nuevo:
// 1) Verifica que TODAS las migraciones estén aplicadas; si faltan, aborta sin escribir.
// 2) Si no hay settings, los crea con valores por defecto.
// 3) Si no hay usuarios, crea el admin con ADMIN_EMAIL/ADMIN_PASSWORD del .env.
// (Ya NO se siembran trabajadores por defecto: los domiciliarios vienen de Shipday.)
// Idempotente: seguro de ejecutar en cada arranque.

import fs from "node:fs";
import path from "node:path";
import bcrypt from "bcryptjs";
import { prisma } from "../lib/prisma";
import { env } from "../config/env";

/** Nunca aplica SQL parcial. La instalación debe ejecutar todas las migraciones
 * con db:deploy ANTES de arrancar; falla cerrado sin sembrar ni modificar datos. */
async function assertMigrationsApplied() {
  const candidates = [path.resolve(__dirname,"../../prisma/migrations"),path.resolve(__dirname,"../prisma/migrations"),path.resolve(process.cwd(),"prisma/migrations")];
  const dir = candidates.find(p => fs.existsSync(p));
  if (!dir) throw new Error("Faltan los archivos de migración. Reinstala el paquete completo.");
  const expected = fs.readdirSync(dir).filter(n => fs.existsSync(path.join(dir,n,"migration.sql")));
  let rows: {migration_name:string;finished_at:Date|null;rolled_back_at:Date|null}[];
  try { rows = await prisma.$queryRawUnsafe('SELECT migration_name, finished_at, rolled_back_at FROM "_prisma_migrations"'); }
  catch { throw new Error("Base sin migraciones. Ejecuta npm run db:deploy -w @cash-buddy/api antes de iniciar."); }
  const done = new Set(rows.filter(r=>r.finished_at && !r.rolled_back_at).map(r=>r.migration_name));
  if (!expected.length || expected.some(n=>!done.has(n)) || rows.some(r=>!r.finished_at && !r.rolled_back_at)) {
    throw new Error("Migraciones pendientes o fallidas. Ejecuta npm run db:deploy -w @cash-buddy/api antes de iniciar.");
  }
}

export async function autoInit(): Promise<void> {
  try {
    await assertMigrationsApplied();

    // Settings singleton
    await prisma.settings.upsert({
      where: { id: "singleton" },
      update: {},
      create: { id: "singleton" },
    });

    // Admin
    const userCount = await prisma.user.count();
    if (userCount === 0) {
      const passwordHash = await bcrypt.hash(env.admin.password, 10);
      await prisma.user.create({
        data: {
          email: env.admin.email.toLowerCase(),
          name: env.admin.name,
          passwordHash,
          role: "admin",
        },
      });
      console.log(`[init] ✓ Admin creado: ${env.admin.email}`);
    }

    // NOTA: ya NO se siembran trabajadores por defecto. Los domiciliarios reales
    // se cargan desde Shipday (modelo Driver, apartado "Domiciliarios"). La tabla
    // Worker ("Trabajadores") queda vacía y solo se llena con lo que cree la sede.
  } catch (err) {
    console.error("[init] Error en auto-inicialización:", err);
    throw err;
  }
}
