// Reintentos seguros de registros de dinero (NEW05). Si un POST se corta sin respuesta, el
// servidor pudo haberlo guardado: el reenvío del MISMO contenido debe llevar la MISMA
// Idempotency-Key para que el servidor devuelva lo ya registrado en vez de duplicarlo.
// En cuanto llega cualquier respuesta la clave se descarta, así dos operaciones iguales y
// legítimas (p. ej. dos gastos idénticos seguidos) nunca comparten clave.

const TTL_MS = 15 * 60_000;
const unanswered = new Map<string, { key: string; at: number }>();

function newKey(): string {
  // crypto.randomUUID solo existe en contextos seguros; por la red local (http://192.168…) no.
  const c = typeof crypto !== "undefined" ? crypto : undefined;
  if (c && "randomUUID" in c) return c.randomUUID();
  return `k${Date.now().toString(36)}${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
}

/** Clave para este envío: la del intento anterior sin respuesta, o una nueva. */
export function retryKeyFor(signature: string): string {
  const now = Date.now();
  for (const [s, v] of unanswered) if (now - v.at > TTL_MS) unanswered.delete(s);
  return unanswered.get(signature)?.key ?? newKey();
}

/** El envío no obtuvo respuesta: un reintento idéntico debe reutilizar la clave. */
export function rememberUnanswered(signature: string, key: string) {
  unanswered.set(signature, { key, at: Date.now() });
}

/** Llegó una respuesta (éxito o rechazo): la clave ya no aplica. */
export function forgetKey(signature: string) {
  unanswered.delete(signature);
}
