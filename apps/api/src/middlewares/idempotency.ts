import type { NextFunction, Request, Response } from "express";

/**
 * Reintentos seguros de registros de dinero (NEW05, auditoría oct-2026).
 *
 * Si la respuesta de un POST se pierde (corte de red, ventana cerrada a medias) el servidor
 * pudo haberlo registrado igual. El frontend reenvía el MISMO envío con la MISMA cabecera
 * `Idempotency-Key` (solo cuando no recibió respuesta; ver web/lib/retry-key.ts). Aquí, una
 * clave ya resuelta con éxito devuelve el resultado guardado en vez de volver a registrar el
 * dinero; un reintento que llega mientras el original sigue en proceso espera su resultado.
 *
 * Memoria del proceso, sin tabla: cubre el caso real (reintento a los segundos o minutos).
 * Solo se recuerdan respuestas 2xx: un rechazo (validación, período cerrado…) no bloquea que
 * el usuario corrija y vuelva a enviar. La clave va ligada al usuario y a la ruta.
 */
const TTL_MS = 15 * 60_000;
const done = new Map<string, { at: number; status: number; body: unknown; hasBody: boolean }>();
const inflight = new Map<string, Promise<void>>();

function purge(now: number) {
  for (const [k, v] of done) if (now - v.at > TTL_MS) done.delete(k);
}

function replay(res: Response, hit: { status: number; body: unknown; hasBody: boolean }) {
  res.setHeader("Idempotent-Replay", "true");
  if (hit.hasBody) res.status(hit.status).json(hit.body);
  else res.status(hit.status).end();
}

export function idempotency(req: Request, res: Response, next: NextFunction) {
  if (req.method !== "POST") return next();
  const raw = req.header("Idempotency-Key");
  if (!raw || !/^[A-Za-z0-9_-]{8,100}$/.test(raw)) return next();
  const key = `${req.user?.sub ?? "anon"}|${req.originalUrl}|${raw}`;
  purge(Date.now());

  const hit = done.get(key);
  if (hit) return replay(res, hit);

  const pending = inflight.get(key);
  if (pending) {
    pending.then(() => {
      const h = done.get(key);
      if (h) replay(res, h);
      else next(); // el original falló: este reintento se procesa normalmente
    });
    return;
  }

  let finish!: () => void;
  inflight.set(key, new Promise<void>(r => { finish = r; }));
  let captured: { body: unknown; hasBody: boolean } = { body: undefined, hasBody: false };
  const json = res.json.bind(res);
  res.json = (body: unknown) => { captured = { body, hasBody: true }; return json(body); };
  const settle = () => {
    if (!inflight.has(key)) return;
    if (res.statusCode >= 200 && res.statusCode < 300) {
      done.set(key, { at: Date.now(), status: res.statusCode, ...captured });
    }
    inflight.delete(key);
    finish();
  };
  res.on("finish", settle);
  res.on("close", settle);
  next();
}
