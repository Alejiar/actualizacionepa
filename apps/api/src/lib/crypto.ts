import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * Clave de cifrado ESTABLE y persistente.
 *
 * Causa raíz del fallo de sincronización tras reiniciar: la API Key de Shipday se
 * guarda cifrada (AES-256) en la BD. Si la clave de cifrado cambia entre arranques
 * (porque venía de una variable de entorno que no siempre se pasa igual), el
 * descifrado falla con "bad decrypt" y la sincronización se cae en silencio.
 *
 * Solución definitiva: la clave se persiste UNA sola vez en un archivo local
 * (`.encryption-key`) y se reutiliza en todos los arranques, sin depender de cómo
 * se lance el servidor. Si existe `ENCRYPTION_KEY` en el entorno, tiene prioridad
 * (para despliegues gestionados), pero ya no es obligatoria.
 */

let cachedKey: Buffer | null = null;

function resolveKeyFile(): string {
  // Junto al working dir del proceso del API (apps/api) — persiste entre reinicios.
  return path.resolve(process.cwd(), ".encryption-key");
}

export class EncryptionKeyError extends Error {
  constructor(detail: string) {
    super(`No hay una clave de cifrado válida (${detail}). Define ENCRYPTION_KEY o restaura el archivo .encryption-key desde el respaldo. No se cifra ni descifra sin ella.`);
    this.name = "EncryptionKeyError";
  }
}

function loadOrCreateSecret(): string {
  // 1) Prioridad: variable de entorno explícita (despliegues gestionados).
  const fromEnv = process.env.ENCRYPTION_KEY?.trim();
  // (Sin exigir longitud mínima: una clave ya en uso debe seguir descifrando las API Keys
  // guardadas. Una clave débil se corrige con una rotación planificada, no al arrancar.)
  if (fromEnv) return fromEnv;
  // 2) Archivo persistente generado UNA vez. Falla CERRADO: ante cualquier error de lectura o
  //    escritura se lanza un error. Antes se usaba una clave fija pública como "último
  //    recurso", con la que cualquiera podía descifrar las API Keys guardadas.
  const file = resolveKeyFile();
  let existing: string | null = null;
  try {
    if (fs.existsSync(file)) existing = fs.readFileSync(file, "utf8").trim();
  } catch (err) {
    throw new EncryptionKeyError(`no se pudo leer ${path.basename(file)}: ${(err as NodeJS.ErrnoException).code ?? "error"}`);
  }
  if (existing) return existing;
  if (existing === "") throw new EncryptionKeyError(`${path.basename(file)} está vacío; restáuralo desde el respaldo`);
  const generated = randomBytes(32).toString("hex");
  try {
    // "wx": nunca sobrescribe un archivo existente (evita perder una clave por una carrera).
    fs.writeFileSync(file, generated, { encoding: "utf8", mode: 0o600, flag: "wx" });
  } catch (err) {
    throw new EncryptionKeyError(`no se pudo crear ${path.basename(file)}: ${(err as NodeJS.ErrnoException).code ?? "error"}`);
  }
  console.log(`[crypto] Clave de cifrado generada y persistida en ${file}. Inclúyela en los respaldos.`);
  return generated;
}

function getKey(): Buffer {
  if (cachedKey) return cachedKey;
  cachedKey = createHash("sha256").update(loadOrCreateSecret()).digest();
  return cachedKey;
}

export function encryptApiKey(plaintext: string): string {
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-256-cbc", getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return iv.toString("hex") + ":" + encrypted.toString("hex");
}

export class DecryptError extends Error {
  constructor() {
    super("No se pudo descifrar la API Key. Vuelve a guardar la API Key de Shipday en la sucursal para reconfigurarla.");
    this.name = "DecryptError";
  }
}

export function decryptApiKey(ciphertext: string): string {
  if (!ciphertext.includes(":")) return ciphertext; // legacy plano
  const key = getKey(); // un problema de CLAVE se informa como tal (EncryptionKeyError)
  try {
    const [ivHex, encHex] = ciphertext.split(":");
    const iv = Buffer.from(ivHex, "hex");
    const encrypted = Buffer.from(encHex, "hex");
    const decipher = createDecipheriv("aes-256-cbc", key, iv);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
  } catch {
    // Error claro y accionable en vez de "bad decrypt" silencioso.
    throw new DecryptError();
  }
}
