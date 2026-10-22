// Auditoría ronda 2 — continuación PROLONGADA de las simulaciones de la ronda 1.
// Restaura el estado final de la ronda 1 (dump verificado) en una BD temporal NUEVA, la migra (no-op)
// y ejecuta el script con el reloj simulado (fake-clock.cjs). Nunca toca cashbuddy ni cashbuddy_demo.
// Uso: node run-r2.cjs ap|bp|perm|sondas
const cp = require("node:child_process"), fs = require("node:fs"), path = require("node:path");
const E = require("../../../auditoria_integral/claude_tools/env.cjs");
const which = process.argv[2];
const CFG = {
  ap: { script: "final-r2-prolongado-a.ts", dump: "cashbuddy_final_a-fin-ronda1.dump" },
  bp: { script: "final-r2-prolongado-b.ts", dump: "cashbuddy_final_b-fin-ronda1.dump" },
  perm: { script: "final-r2-permisos.ts", dump: "cashbuddy_final_b-fin-ronda1.dump" },
  sondas: { script: "final-r2-sondas.ts", dump: "cashbuddy_final_b-fin-ronda1.dump" },
}[which];
if (!CFG) throw Error("uso: node run-r2.cjs ap|bp|perm|sondas");
const root = path.resolve(__dirname, "../../..");
const dump = path.join(root, "auditoria-final-preproduccion/ronda2/bases-ronda1", CFG.dump);
const db = "cashbuddy_final_" + which;
const lab = E.load("lab"); const base = new URL(lab.url);
const env0 = { ...process.env, PGPASSWORD: decodeURIComponent(base.password) };
const conn = ["-h", base.hostname, "-p", base.port || "5432", "-U", decodeURIComponent(base.username)];
const pg = (bin, args) => cp.spawnSync(`${E.PGBIN}/${bin}.exe`, [...conn, ...args], { env: env0, encoding: "utf8" });
if (pg("psql", ["-d", "postgres", "-At", "-c", `select 1 from pg_database where datname='${db}'`]).stdout.trim() === "1") pg("dropdb", [db]);
let c = pg("createdb", [db]); if (c.status) throw Error(c.stderr);
c = pg("pg_restore", ["--no-owner", "-d", db, dump]); if (c.status) throw Error(c.stderr);
const u = new URL(lab.url); u.pathname = "/" + db;
const env = { ...process.env, ...lab.env, DATABASE_URL: u.toString(), WEBHOOK_TOKEN: "final-token", NODE_ENV: "test", TZ: "America/Bogota" };
const mig = cp.spawnSync(process.execPath, [root + "/node_modules/prisma/build/index.js", "migrate", "deploy", "--schema", root + "/apps/api/prisma/schema.prisma"], { env, encoding: "utf8" });
if (mig.status) throw Error(mig.stdout + mig.stderr);
const t0 = Date.now();
env.NODE_OPTIONS = "--require " + path.join(__dirname, "fake-clock.cjs").split(path.sep).join("/"); // también llega a los procesos hijos de tsx
const r = cp.spawnSync(process.execPath, [root + "/node_modules/tsx/dist/cli.mjs", path.join(__dirname, CFG.script)], { cwd: path.resolve(__dirname, ".."), env, encoding: "utf8", timeout: 3600000, maxBuffer: 200e6 });
const out = (r.stdout || "") + (r.stderr || "");
fs.writeFileSync(path.join(__dirname, CFG.script.replace(".ts", ".log")), out);
console.log(out.split("\n").filter(l => /^(FALLA|TOTAL)|^\s{6}/.test(l) || /Error/.test(l)).slice(0, 80).join("\n"));
console.log(`segundos=${Math.round((Date.now() - t0) / 1000)} status=${r.status}`);
process.exit(r.status ?? 1);
