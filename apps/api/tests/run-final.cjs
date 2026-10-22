// Auditoría final preproducción: crea (o recrea con respaldo) la BD temporal cashbuddy_final_<x>, la migra
// y ejecuta tests/final-*.ts. Uso: node run-final.cjs a|b   (nunca toca cashbuddy ni cashbuddy_demo)
const cp = require("node:child_process"), fs = require("node:fs"), path = require("node:path");
const E = require("../../../auditoria_integral/claude_tools/env.cjs");
const which = process.argv[2]; const SCRIPT = { a: "final-2meses-normal.ts", b: "final-2meses-extremos.ts" }[which];
if (!SCRIPT) throw Error("uso: node run-final.cjs a|b");
const db = "cashbuddy_final_" + which;
const lab = E.load("lab"); const base = new URL(lab.url);
const env0 = { ...process.env, PGPASSWORD: decodeURIComponent(base.password) };
const conn = ["-h", base.hostname, "-p", base.port || "5432", "-U", decodeURIComponent(base.username)];
const pg = (bin, args) => cp.spawnSync(`${E.PGBIN}/${bin}.exe`, [...conn, ...args], { env: env0, encoding: "utf8" });
if (pg("psql", ["-d", "postgres", "-At", "-c", `select 1 from pg_database where datname='${db}'`]).stdout.trim() === "1") pg("dropdb", [db]);
const c = pg("createdb", [db]); if (c.status) throw Error(c.stderr);
const u = new URL(lab.url); u.pathname = "/" + db;
const env = { ...process.env, ...lab.env, DATABASE_URL: u.toString(), WEBHOOK_TOKEN: "final-token", NODE_ENV: "test" };
const root = path.resolve(__dirname, "../../..");
const mig = cp.spawnSync(process.execPath, [root + "/node_modules/prisma/build/index.js", "migrate", "deploy", "--schema", root + "/apps/api/prisma/schema.prisma"], { env, encoding: "utf8" });
if (mig.status) throw Error(mig.stdout + mig.stderr);
const t0 = Date.now();
const r = cp.spawnSync(process.execPath, [root + "/node_modules/tsx/dist/cli.mjs", path.join(__dirname, SCRIPT)], { cwd: path.resolve(__dirname, ".."), env, encoding: "utf8", timeout: 1800000, maxBuffer: 80e6 });
const out = (r.stdout || "") + (r.stderr || "");
fs.writeFileSync(path.join(__dirname, SCRIPT.replace(".ts", ".log")), out);
console.log(out.split("\n").filter(l => /^(FALLA|TOTAL)|^\s{6}/.test(l) || /Error/.test(l)).slice(0, 80).join("\n"));
console.log(`segundos=${Math.round((Date.now() - t0) / 1000)} status=${r.status}`);
process.exit(r.status ?? 1);
