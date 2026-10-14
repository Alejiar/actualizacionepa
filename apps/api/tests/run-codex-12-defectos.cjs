// Ejecuta tests/codex-12-defectos.ts. Requiere DATABASE_URL apuntando a una BD LOCAL temporal
// llamada cashbuddy_claude_12, migrada (npx prisma migrate deploy). Nunca la operativa.
const path = require("node:path"), cp = require("node:child_process"), fs = require("node:fs");
const u = new URL(process.env.DATABASE_URL || "invalid:");
if (u.pathname !== "/cashbuddy_claude_12" || !["localhost", "127.0.0.1"].includes(u.hostname)) throw Error("Solo BD temporal local cashbuddy_claude_12, migrada");
const root = path.resolve(__dirname, "../../..");
const r = cp.spawnSync(process.execPath, [path.join(root, "node_modules/tsx/dist/cli.mjs"), path.join(__dirname, "codex-12-defectos.ts")],
  { env: { ...process.env, WEBHOOK_TOKEN: "defectos-token", NODE_ENV: "test" }, encoding: "utf8", timeout: 600000, maxBuffer: 20e6 });
fs.writeFileSync(path.join(__dirname, "codex-12-defectos.log"), (r.stdout || "") + (r.stderr || ""));
console.log((r.stdout || "").split("\n").filter(l => /^(OK|FALLA|TOTAL|\s{6})/.test(l)).join("\n"));
process.exit(r.status ?? 1);
