// Migración F14 (20261015090000) + D7 (20261015091000) sobre datos HEREDADOS (esquema 34).
// Crea y elimina su propia BD temporal `cashbuddy_claude_mig_f14`; requiere DATABASE_URL local
// (solo se usan host/credenciales; nunca se toca la base de esa URL).
const fs = require("node:fs"), cp = require("node:child_process"), path = require("node:path"), os = require("node:os"), assert = require("node:assert/strict");
const u = new URL(process.env.DATABASE_URL || "invalid:");
if (!["localhost", "127.0.0.1"].includes(u.hostname)) throw Error("Solo PostgreSQL local");
const NAME = "cashbuddy_claude_mig_f14";
const root = path.resolve(__dirname, "../../.."), api = root + "/apps/api";
const NEW = ["20261015090000_f14_separate_base_commission", "20261015091000_d7_closed_day_corrections"];
const pg = { ...process.env, PGHOST: u.hostname, PGPORT: u.port || "5432", PGUSER: decodeURIComponent(u.username), PGPASSWORD: decodeURIComponent(u.password) };
function sql(s, db = "postgres") { const r = cp.spawnSync("C:/Program Files/PostgreSQL/17/bin/psql.exe", ["-X", "-v", "ON_ERROR_STOP=1", "-At", "-F", "|", "-c", s], { env: { ...pg, PGDATABASE: db }, encoding: "utf8" }); if (r.status) throw Error(r.stderr); return r.stdout.split(String.fromCharCode(13)).join("").trim(); }
const test = new URL(u); test.pathname = "/" + NAME;
const env = { ...process.env, DATABASE_URL: test.toString() };
function migrate(schemaDir) { const r = cp.spawnSync(process.execPath, [root + "/node_modules/prisma/build/index.js", "migrate", "deploy", "--schema", schemaDir + "/schema.prisma"], { cwd: api, env, encoding: "utf8" }); if (r.status) throw Error(r.stdout + r.stderr); }
assert.equal(sql(`SELECT count(*) FROM pg_database WHERE datname='${NAME}'`), "0", "la BD de prueba no debe existir de antemano");
const old = fs.mkdtempSync(path.join(os.tmpdir(), "f14-old-"));
fs.mkdirSync(old + "/migrations", { recursive: true });
fs.copyFileSync(api + "/prisma/schema.prisma", old + "/schema.prisma");
for (const f of fs.readdirSync(api + "/prisma/migrations")) if (!NEW.includes(f)) fs.cpSync(api + "/prisma/migrations/" + f, old + "/migrations/" + f, { recursive: true });
const results = {};
sql(`CREATE DATABASE ${NAME}`);
try {
  migrate(old);
  results.before = Number(sql(`SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL`, NAME));
  // Datos heredados (modelo anterior: pendingDebt = base + comisiones; base mostrada = min(libro, deuda)).
  sql(`INSERT INTO "Settings" (id,"initialCash","initialBank","setupComplete","updatedAt") VALUES ('singleton',100000,100000,true,now());
  INSERT INTO "Branch" (id,name,"apiKeyEnc","updatedAt") VALUES ('b','B','x',now());
  INSERT INTO "Driver" (id,"shipdayDriverId","branchId",name,"pendingDebt","creditAmount","updatedAt") VALUES
   ('L1','1','b','Base y comision',70000,0,now()),
   ('L2','2','b','Residuo compensado',0,0,now()),
   ('L3','3','b','Solo credito',0,5000,now()),
   ('L4','4','b','Base parcialmente saldada',10000,0,now()),
   ('L5','5','b','Sin base',8000,0,now());
  INSERT INTO "BaseTransaction" (id,"branchId","driverId",amount,"cashAmount","bankAmount",type,date) VALUES
   ('e1','b','L1',50000,50000,0,'entrega',now()),
   ('e2','b','L2',50000,50000,0,'entrega',now()),
   ('p2','b','L2',40000,40000,0,'pago',now()),
   ('e4','b','L4',30000,30000,0,'entrega',now());`, NAME);
  const before = sql(`SELECT id,"pendingDebt","creditAmount" FROM "Driver" ORDER BY id`, NAME);
  migrate(api + "/prisma");
  results.after = Number(sql(`SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL`, NAME));
  const rows = Object.fromEntries(sql(`SELECT d.id, d."pendingDebt", d."creditAmount", GREATEST(0, COALESCE(SUM(CASE WHEN b.type='entrega' THEN b.amount ELSE -b.amount END),0)) FROM "Driver" d LEFT JOIN "BaseTransaction" b ON b."driverId"=d.id GROUP BY d.id ORDER BY d.id`, NAME)
    .split("\n").map(l => { const [id, pd, cr, base] = l.split("|"); return [id, { comision: +pd, credito: +cr, base: +base }]; }));
  results.drivers = rows; results.beforeRaw = before;
  // Esperado, calculado aparte:
  assert.deepEqual(rows.L1, { comision: 20000, credito: 0, base: 50000 }, "L1: 70.000 = 50.000 base + 20.000 comisión");
  assert.deepEqual(rows.L2, { comision: 0, credito: 0, base: 0 }, "L2: residuo de 10.000 ya compensado → regularizado, sin crédito fantasma");
  assert.deepEqual(rows.L3, { comision: 0, credito: 5000, base: 0 }, "L3: crédito intacto");
  assert.deepEqual(rows.L4, { comision: 0, credito: 0, base: 10000 }, "L4: total 10.000 se conserva como base");
  assert.deepEqual(rows.L5, { comision: 8000, credito: 0, base: 0 }, "L5: sin base, intacto");
  for (const [id, before] of [["L1", 70000], ["L2", 0], ["L3", -5000], ["L4", 10000], ["L5", 8000]]) {
    const r = rows[id]; assert.equal(r.comision - r.credito + r.base, before, `${id}: el total informativo conserva la posición anterior`);
  }
  const regs = sql(`SELECT "driverId", amount, "cashAmount", "bankAmount", left(notes, 18) FROM "BaseTransaction" WHERE id LIKE 'f14_%' ORDER BY "driverId"`, NAME);
  results.regularizations = regs; assert.equal(regs, "L2|10000|0|0|Regularización F14\nL4|20000|0|0|Regularización F14");
  const log = sql(`SELECT "driverId","pendingDebtBefore","creditAmountBefore","baseLedger","baseShown","residueRegularized","pendingDebtAfter","creditAmountAfter" FROM "F14DriverMigration" ORDER BY "driverId"`, NAME);
  results.audit = log; assert.equal(log.split("\n").length, 3, "auditoría: un registro por domiciliario con libro de base");
  assert.equal(sql(`SELECT count(*) FROM "ShiftClose"`, NAME), "0");
  assert.equal(sql(`SELECT column_default FROM information_schema.columns WHERE table_name='ShiftClose' AND column_name='corrections'`, NAME), "'[]'::jsonb");
  // La regularización NO mueve caja: saldo esperado con el código actual = 100.000 − 50.000 − 50.000 + 40.000 − 30.000.
  const r = cp.spawnSync(process.execPath, [root + "/node_modules/tsx/dist/cli.mjs", "-e", `import("file:///${api.replace(/\\/g, "/")}/src/services/shipday-dashboard.service.ts").then(async m=>{const {todayBogota}=await import("file:///${api.replace(/\\/g, "/")}/src/lib/date-range.ts");console.log("EXP="+JSON.stringify(await m.getExpectedBalancesForDate(todayBogota())));process.exit(0)})`], { cwd: api, env: { ...env, TZ: "America/Bogota" }, encoding: "utf8" });
  const exp = JSON.parse((r.stdout.match(/EXP=(.*)/) || [])[1] || "null");
  results.expected = exp; assert.deepEqual(exp, { cash: 10000, bank: 100000 }, "la migración no cambia la caja esperada");
  results.ok = true;
} finally {
  sql(`DROP DATABASE IF EXISTS ${NAME} WITH (FORCE)`);
  fs.writeFileSync(__dirname + "/claude-migration-f14.json", JSON.stringify(results, null, 2));
}
console.log(JSON.stringify({ ok: results.ok === true, before: results.before, after: results.after, drivers: results.drivers, expected: results.expected }));
