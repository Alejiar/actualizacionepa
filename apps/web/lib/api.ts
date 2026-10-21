// Cliente HTTP del frontend. En el modelo host (un solo puerto) usa rutas
// relativas (/api). En desarrollo, NEXT_PUBLIC_API_URL apunta a http://localhost:4000.

import { getDeviceId } from "./device-id";
import { forgetKey, rememberUnanswered, retryKeyFor } from "./retry-key";

/** Mensaje ante un corte de red (antes se mostraba "TypeError: Failed to fetch"). */
export const NETWORK_ERROR =
  "No hubo respuesta del servidor (red o servidor caído). Revisa la conexión y vuelve a intentar: el reintento no duplica el registro.";

const BASE = process.env.NEXT_PUBLIC_API_URL ?? "";

const TOKEN_KEY = "cashbuddy.token";

// El token vive en sessionStorage, NO en localStorage: debe morir al cerrar la app
// o el navegador, para que al volver a abrir SIEMPRE pida usuario y contraseña.
//
// Con localStorage el token quedaba en disco (hasta 7 días, lo que dure el JWT) y la
// sesión reaparecía sola al reabrir. Además localStorage es por ORIGEN, así que cerrar
// sesión en la app (localhost:4000) no tocaba la sesión abierta desde otro PC
// (192.168.x.x:4000): quedaba viva sin que nadie se enterara.
//
// sessionStorage se conserva al recargar la página (el watchdog de CashBuddy.exe
// recarga cuando reinicia el backend, y eso NO debe desloguear), pero se borra al
// cerrar la ventana.

/** Borra restos del esquema viejo en localStorage (sesiones que quedaron persistidas). */
function purgeLegacyToken() {
  try {
    if (localStorage.getItem(TOKEN_KEY) !== null) localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* almacenamiento bloqueado */
  }
}

export function getToken(): string | null {
  if (typeof window === "undefined") return null;
  purgeLegacyToken();
  return sessionStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string | null) {
  if (typeof window === "undefined") return;
  purgeLegacyToken();
  if (token) sessionStorage.setItem(TOKEN_KEY, token);
  else sessionStorage.removeItem(TOKEN_KEY);
}

export class ApiError extends Error {
  status: number;
  details?: unknown;
  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

type Options = {
  method?: string;
  body?: unknown;
  auth?: boolean;
};

export async function api<T>(path: string, opts: Options = {}): Promise<T> {
  const { method = "GET", body, auth = true } = opts;
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (auth) {
    const token = getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
  }
  // Identificador de equipo (PC) para trazabilidad y autorización de equipos.
  const deviceId = getDeviceId();
  if (deviceId) headers["X-Device-Id"] = deviceId;

  const payload = body !== undefined ? JSON.stringify(body) : undefined;
  // NEW05: un POST reenviado tras un corte sin respuesta reutiliza su clave (ver retry-key.ts).
  const signature = `${method} ${path} ${payload ?? ""}`;
  const retryKey = method === "POST" ? retryKeyFor(signature) : null;
  if (retryKey) headers["Idempotency-Key"] = retryKey;

  let res: Response;
  try {
    res = await fetch(`${BASE}/api${path}`, { method, headers, body: payload });
  } catch {
    if (retryKey) rememberUnanswered(signature, retryKey);
    throw new ApiError(0, NETWORK_ERROR);
  }
  if (retryKey) forgetKey(signature);

  if (res.status === 401 && typeof window !== "undefined") {
    setToken(null);
    if (!window.location.pathname.startsWith("/login")) {
      window.location.href = "/login";
    }
  }

  if (!res.ok) {
    let message = `Error ${res.status}`;
    let details: unknown;
    try {
      const data = await res.json();
      message = data.error ?? message;
      details = data.details;
    } catch {
      /* respuesta sin cuerpo JSON */
    }
    throw new ApiError(res.status, message, details);
  }

  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}
