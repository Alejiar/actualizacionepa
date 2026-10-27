import type { Request, Response } from "express";
import os from "node:os";
import { execFile } from "node:child_process";
import { env } from "../config/env";

/**
 * Obtiene la IP de Tailscale ejecutando el CLI `tailscale ip -4`.
 *
 * En Windows, os.networkInterfaces() suele reportar la IP link-local (169.254.x)
 * del adaptador de Tailscale en vez de la IP real 100.x, por lo que la única
 * fuente fiable es el propio CLI de Tailscale. Se cachea unos segundos para no
 * lanzar el proceso en cada consulta (el dashboard pregunta cada 20s).
 */
const TS_CANDIDATES = [
  "C:\\Program Files\\Tailscale\\tailscale.exe",
  "C:\\Program Files (x86)\\Tailscale IPN\\tailscale.exe",
  "tailscale", // PATH (Linux/Mac/Windows si está en PATH)
];

let tsCache: { ip: string | null; at: number } = { ip: null, at: 0 };
const TS_TTL_MS = 5000;
// El CLI tarda ~1,7 s aun sin conexión (medido en el PC de pruebas, oct-2026): con 2,5 s de
// límite, un PC ocupado lo cortaba y el Dashboard decía "Tailscale no detectado" aunque el acceso
// remoto funcionara. Más margen, y una falla pasajera conserva la última IP buena unos minutos.
const TS_TIMEOUT_MS = 8000;
const TS_KEEP_LAST_MS = 3 * 60_000;
let tsLastGood: { ip: string; at: number } | null = null;
let tsInflight: Promise<string | null> | null = null;

function execTailscale(bin: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(bin, ["ip", "-4"], { timeout: TS_TIMEOUT_MS, windowsHide: true }, (err, stdout) => {
      if (err) return resolve(null);
      const ip = stdout.split(/\r?\n/).map(s => s.trim()).find(s => /^\d+\.\d+\.\d+\.\d+$/.test(s));
      resolve(ip ?? null);
    });
  });
}

async function getTailscaleIp(): Promise<string | null> {
  const now = Date.now();
  if (now - tsCache.at < TS_TTL_MS) return tsCache.ip;
  // Un solo CLI a la vez: varias pantallas abiertas consultan en paralelo.
  tsInflight ??= (async () => {
    let ip: string | null = null;
    for (const bin of TS_CANDIDATES) {
      ip = await execTailscale(bin);
      if (ip) break;
    }
    const at = Date.now();
    if (ip) tsLastGood = { ip, at };
    else if (tsLastGood && at - tsLastGood.at < TS_KEEP_LAST_MS) ip = tsLastGood.ip;
    tsCache = { ip, at };
    return ip;
  })().finally(() => { tsInflight = null; });
  return tsInflight;
}

/**
 * Devuelve las URLs de acceso: local (LAN/WiFi) y remota (Tailscale).
 * Si la red o la IP de Tailscale cambian, la nueva se refleja en la siguiente consulta.
 */
export async function localUrls(_req: Request, res: Response) {
  const port = env.port;
  const interfaces = os.networkInterfaces();
  const urls: { name: string; ip: string; url: string }[] = [];

  for (const [name, addrs] of Object.entries(interfaces)) {
    if (!addrs) continue;
    for (const addr of addrs) {
      // Solo IPv4, no internas (descarta 127.0.0.1) y descarta link-local 169.254.x
      if (addr.family === "IPv4" && !addr.internal && !addr.address.startsWith("169.254.")) {
        urls.push({ name, ip: addr.address, url: `http://${addr.address}:${port}` });
      }
    }
  }

  urls.sort((a, b) => rank(a.ip) - rank(b.ip));

  // IP de Tailscale: fuente fiable = CLI. Fallback: alguna interfaz en rango CGNAT.
  const tsIp = (await getTailscaleIp()) ?? urls.find(u => isTailscale(u.ip))?.ip ?? null;
  const tailscaleUrl = tsIp ? `http://${tsIp}:${port}` : null;

  // URL local (LAN/WiFi): la primera que NO sea la de Tailscale.
  const local = urls.find(u => u.ip !== tsIp && !isTailscale(u.ip)) ?? urls[0];

  res.json({
    port,
    primary: local?.url ?? `http://localhost:${port}`,
    local: local?.url ?? null,
    tailscale: tailscaleUrl,
    urls,
  });
}

// Tailscale usa el rango CGNAT 100.64.0.0/10.
function isTailscale(ip: string): boolean {
  if (!ip.startsWith("100.")) return false;
  const second = Number(ip.split(".")[1]);
  return second >= 64 && second <= 127;
}

function rank(ip: string): number {
  if (ip.startsWith("192.168.")) return 0; // WiFi/LAN doméstica — más probable
  if (ip.startsWith("10.")) return 1;       // LAN corporativa
  if (ip.startsWith("172.")) return 2;      // LAN privada
  if (ip.startsWith("100.")) return 3;      // Tailscale
  return 4;
}
