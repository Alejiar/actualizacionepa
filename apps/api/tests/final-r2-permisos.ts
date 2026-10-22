/**
 * AUDITORÍA RONDA 2 — Matriz de permisos AUTOMÁTICA: lee TODAS las rutas de routes/index.ts y prueba cada una
 * (1) sin sesión → 401 (salvo las públicas), (2) las marcadas requireAdmin con un operador → 403, y (3) con un
 * token de usuario desactivado → 401. Ninguna de esas peticiones puede cambiar datos (conteo de todas las tablas).
 * Corre sobre una copia del estado final de la Simulación B de la ronda 1. SOLO `cashbuddy_final_perm`.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const u = new URL(process.env.DATABASE_URL || "invalid:");
if (u.pathname !== "/cashbuddy_final_perm" || !["localhost", "127.0.0.1"].includes(u.hostname)) throw Error("Solo BD temporal local cashbuddy_final_perm");

async function main() {
  const SRC = pathToFileURL(path.resolve(__dirname, "../src")).href;
  const { prisma: p } = await import(`${SRC}/lib/prisma.ts`);
  const { createServer } = await import(`${SRC}/server.ts`);
  const { signToken } = await import(`${SRC}/lib/jwt.ts`);
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any, init: any) => { if (!String(input).startsWith("http://127.0.0.1:")) throw Error("Red externa bloqueada: " + String(input)); return realFetch(input, init); }) as any;
  const server = createServer().listen(0, "127.0.0.1"); await new Promise<void>(r => server.once("listening", r));
  const origin = "http://127.0.0.1:" + (server.address() as any).port;

  const src = fs.readFileSync(path.resolve(__dirname, "../src/routes/index.ts"), "utf8");
  const routes = [...src.matchAll(/apiRouter\.(get|post|put|patch|delete)\("([^"]+)",\s*([^\n]*)\);/g)].map(m => ({ method: m[1].toUpperCase(), path: m[2], admin: m[3].includes("requireAdmin") }));
  const PUBLIC = new Set(["GET /health", "GET /branding", "POST /auth/login", "POST /webhooks/shipday/:branchId"]);
  const oper = await p.user.findUniqueOrThrow({ where: { email: "oper@extremos.test" } });
  const oper2 = await p.user.findUniqueOrThrow({ where: { email: "oper2@extremos.test" } }); // desactivado en la ronda 1
  assert.equal(oper2.active, false);
  const tokO = signToken({ sub: oper.id, email: oper.email, name: oper.name, role: "user", tv: oper.tokenVersion });
  const tokDead = signToken({ sub: oper2.id, email: oper2.email, name: oper2.name, role: "admin", tv: oper2.tokenVersion });
  const anyBase = await p.baseTransaction.findFirstOrThrow(); const anyMov = await p.movement.findFirstOrThrow();
  const fill = (r: string) => r.replace(/:date/g, "2026-10-15").replace(/:month/g, "2026-09").replace(/:id/g, r.includes("bases") ? anyBase.id : anyMov.id).replace(/:[A-Za-z]+/g, "x");
  const tables = (await p.$queryRawUnsafe(`SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename NOT IN ('_prisma_migrations','ActivityLog','Device')`) as any[]).map(x => x.tablename);
  const counts = async () => { const o: Record<string, number> = {}; for (const t of tables) o[t] = Number((await p.$queryRawUnsafe(`select count(*)::int c from "${t}"`) as any[])[0].c); return o; };
  const before = await counts();
  const rows: any[] = []; const bad: any[] = [];
  for (const r of routes) {
    const key = `${r.method} ${r.path}`; const url = origin + "/api" + fill(r.path);
    const send = (tok?: string) => realFetch(url, { method: r.method, headers: { "Content-Type": "application/json", ...(tok ? { Authorization: "Bearer " + tok } : {}) }, body: r.method === "GET" ? undefined : JSON.stringify({ amount: 1000, cashAmount: 1000, medium: "cash", month: "2026-09", initialCash: 1, initialBank: 1, password: "Clave-123456", email: "z@z.test", name: "Z", role: "admin", action: "approved", active: true }) }).then(x => x.status);
    const anon = await send();
    const dead = await send(tokDead);
    const op = r.admin ? await send(tokO) : null;
    rows.push({ ruta: key, admin: r.admin, sinSesion: anon, usuarioDesactivado: dead, operador: op });
    if (!PUBLIC.has(key) && anon !== 401) bad.push({ ruta: key, problema: "sin sesión responde " + anon });
    if (!PUBLIC.has(key) && dead !== 401) bad.push({ ruta: key, problema: "usuario desactivado responde " + dead });
    if (r.admin && op !== 403) bad.push({ ruta: key, problema: "operador en ruta de admin responde " + op });
  }
  const after = await counts();
  const changed = tables.filter(t => before[t] !== after[t]).map(t => [t, before[t], after[t]]);
  const out = { rutas: routes.length, admin: routes.filter(r => r.admin).length, publicas: [...PUBLIC], problemas: bad, tablasQueCambiaron: changed, detalle: rows };
  fs.writeFileSync(path.join(__dirname, "final-r2-permisos.json"), JSON.stringify(out, null, 2));
  console.log(`RUTAS ${routes.length} · ADMIN ${out.admin} · PROBLEMAS ${bad.length} · TABLAS CAMBIADAS ${changed.length}`);
  for (const b of bad) console.log("FALLA", JSON.stringify(b)); for (const c of changed) console.log("FALLA cambió", JSON.stringify(c));
  await new Promise<void>(r => server.close(() => r())); await p.$disconnect();
  process.exit(bad.length || changed.length ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
