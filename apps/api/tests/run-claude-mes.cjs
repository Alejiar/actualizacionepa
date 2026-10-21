// Ejecuta tests/claude-mes-simulado.ts. Requiere DATABASE_URL apuntando a una BD LOCAL temporal
// llamada cashbuddy_claude_mes, vacía y migrada (npx prisma migrate deploy). Nunca la operativa.
const path = require("node:path"), cp = require("node:child_process"), fs = require("node:fs");
const u = new URL(process.env.DATABASE_URL || "invalid:");
if (u.pathname !== "/cashbuddy_claude_mes" || !["localhost", "127.0.0.1"].includes(u.hostname)) throw Error("Solo BD temporal local cashbuddy_claude_mes, vacía y migrada");
const root = path.resolve(__dirname, "../../..");
const r = cp.spawnSync(process.execPath, [path.join(root, "node_modules/tsx/dist/cli.mjs"), path.join(__dirname, "claude-mes-simulado.ts")],
  { env: { ...process.env, WEBHOOK_TOKEN: "mes-token", NODE_ENV: "test" }, encoding: "utf8", timeout: 600000, maxBuffer: 20e6 });
fs.writeFileSync(path.join(__dirname, "claude-mes-simulado.log"), (r.stdout || "") + (r.stderr || ""));
console.log((r.stdout || "").split("\n").filter(l => /^(OK|FALLA|TOTAL)/.test(l)).join("\n"));
process.exit(r.status ?? 1);
