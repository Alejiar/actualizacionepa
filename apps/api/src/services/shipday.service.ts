/**
 * Cliente HTTP para la API oficial de Shipday.
 * Auth: Authorization: Basic <apiKey>  (la key va cruda, sin base64)
 *
 * IMPORTANTE: La API requiere al menos ?pageSize=N para devolver pedidos.
 * Sin parámetros de paginación, siempre devuelve [].
 */

const BASE_URL = "https://api.shipday.com";

// ─── Limitador de tasa global para la API de Shipday ──────────────────────────
// Shipday permite como máximo 5 solicitudes por minuto por cuenta. Superarlo
// devuelve HTTP 400 "rate limit exceeded" y la sincronización falla por completo
// (los pedidos dejan de cargarse y hay que meterlos a mano). Para cargar pedidos
// de forma CONSTANTE sin saturar la API, TODA solicitud a Shipday —de cualquier
// sucursal, sea sync periódico, reconciliación o carga manual— pasa por esta cola,
// que garantiza como mucho MAX_PER_WINDOW solicitudes por ventana deslizante de 60 s.
const RATE_WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 4; // margen por debajo del límite real (5/min) de Shipday
const callTimestamps: number[] = [];

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Las adquisiciones se encadenan para evitar condiciones de carrera entre
// solicitudes concurrentes (p. ej. paginación + reconciliación a la vez).
let acquireChain: Promise<void> = Promise.resolve();

function acquireSlot(): Promise<void> {
  const run = async () => {
    for (;;) {
      const now = Date.now();
      while (callTimestamps.length && now - callTimestamps[0] >= RATE_WINDOW_MS) {
        callTimestamps.shift();
      }
      if (callTimestamps.length < MAX_PER_WINDOW) {
        callTimestamps.push(now);
        return;
      }
      // No hay hueco: espera hasta que la solicitud más antigua salga de la ventana.
      await sleep(RATE_WINDOW_MS - (now - callTimestamps[0]) + 50);
    }
  };
  acquireChain = acquireChain.then(run, run);
  return acquireChain;
}

export interface ShipdayDriver {
  id: number;
  name: string;
  phoneNumber?: string;
  email?: string;
  isActive?: boolean;
}

export interface ShipdayOrder {
  orderId: number | string;
  orderNumber?: string;
  orderStatus?: {
    incomplete?: boolean;
    accepted?: boolean;
    orderState?: string;  // "STARTED" | "DELIVERED" | "COMPLETED" | "FAILED" | ...
  };
  assignedCarrierId?: number;
  assignedCarrier?: {
    id?: number;
    name?: string;
    phoneNumber?: string;
  };
  customer?: {
    name?: string;
    address?: string;
    phoneNumber?: string;
  };
  costing?: {
    totalCost?: number;
    deliveryFee?: number;
    tip?: number;
  };
  activityLog?: {
    placementTime?: string;
    deliveryTime?: string;        // fecha real de entrega
    expectedDeliveryTime?: string;
  };
  restaurant?: {
    name?: string;
    address?: string;
  };
  deliveryInstruction?: string;
}

const DELIVERED_STATES = new Set(["DELIVERED", "COMPLETED", "delivered", "completed"]);

// Reintentos ante errores TRANSITORIOS de Shipday (rate limit / caídas momentáneas).
// El "rate limit exceeded" de Shipday llega como HTTP 400 con ese texto, o como 429;
// los 5xx y los errores de red también son pasajeros. Reintentar aquí evita que una
// sola respuesta transitoria tumbe toda una sincronización (antes: un 400 de rate limit
// en cualquier página abortaba el barrido completo y dejaba pedidos sin cargar).
const MAX_ATTEMPTS = 3;

function isRetriable(status: number, body: string): boolean {
  return status === 429 || status >= 500 || (status === 400 && /rate limit/i.test(body));
}

async function shipdayFetch<T>(apiKey: string, path: string): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    await acquireSlot();
    let res: Response;
    try {
      res = await fetch(`${BASE_URL}${path}`, {
        headers: {
          Authorization: `Basic ${apiKey}`,
          "Content-Type": "application/json",
        },
      });
    } catch (netErr) {
      // Error de red → transitorio: reintentar.
      lastErr = netErr;
      if (attempt === MAX_ATTEMPTS) break;
      await sleep(1200 * attempt);
      continue;
    }
    if (res.ok) return res.json() as Promise<T>;
    const text = await res.text().catch(() => "");
    if (res.status === 401 || res.status === 403) {
      throw new Error(`API Key de Shipday inválida o sin permisos (${res.status}).`);
    }
    lastErr = new Error(`Shipday API error ${res.status}: ${text}`);
    if (!isRetriable(res.status, text)) throw lastErr; // error definitivo → propagar ya
    if (attempt === MAX_ATTEMPTS) break;
    await sleep(1200 * attempt); // backoff; acquireSlot además espaciará por el limitador
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export async function getDrivers(apiKey: string): Promise<ShipdayDriver[]> {
  const data = await shipdayFetch<ShipdayDriver[] | { carriers?: ShipdayDriver[] }>(apiKey, "/carriers");
  if (Array.isArray(data)) return data;
  return (data as { carriers?: ShipdayDriver[] }).carriers ?? [];
}

export async function getAllOrders(apiKey: string, pageSize = 200): Promise<ShipdayOrder[]> {
  // La API de Shipday REQUIERE parámetros de paginación para retornar pedidos del dashboard.
  // Sin parámetros siempre devuelve [].
  //
  // IMPORTANTE: antes esto solo pedía la página 0 (200 pedidos) y nunca avanzaba. Si la
  // cuenta acumula más de 200 pedidos históricos, los pedidos nuevos pueden quedar fuera
  // de esa primera página (según el orden que devuelva Shipday) y nunca se sincronizan:
  // ni aparecen en /pedidos ni afectan la deuda del domiciliario. Por eso ahora se pagina
  // hasta agotar el feed, con un tope de seguridad para no quedar en loop si la API
  // tuviera un comportamiento inesperado.
  const MAX_PAGES = 50; // tope de seguridad: hasta 10,000 pedidos
  const all: ShipdayOrder[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const data = await shipdayFetch<ShipdayOrder[]>(apiKey, `/orders?pageSize=${pageSize}&page=${page}`);
    const batch = Array.isArray(data) ? data : [];
    if (batch.length === 0) break;
    all.push(...batch);
    if (batch.length < pageSize) break; // última página parcial
  }
  return all;
}

/**
 * Recorre el historial completo paginado de Shipday y devuelve solo los pedidos
 * entregados/completados cuya fecha de entrega cae en [from, to] (YYYY-MM-DD).
 * Usado por la reconciliación administrativa para recuperar pedidos que el feed de
 * "activos" nunca mostró (ver getAllOrders).
 */
export async function getDeliveredOrdersInRange(
  apiKey: string,
  from: string,
  to: string,
  pageSize = 200,
): Promise<ShipdayOrder[]> {
  const fromTime = new Date(from + "T00:00:00.000-05:00").getTime();
  const toTime = new Date(to + "T23:59:59.999-05:00").getTime();
  const MAX_PAGES = 200; // tope de seguridad para reconciliación histórica
  const matched: ShipdayOrder[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const data = await shipdayFetch<ShipdayOrder[]>(apiKey, `/orders?pageSize=${pageSize}&page=${page}`);
    const batch = Array.isArray(data) ? data : [];
    if (batch.length === 0) break;
    for (const o of batch) {
      const state = o.orderStatus?.orderState ?? "";
      if (!DELIVERED_STATES.has(state)) continue;
      const deliveredAt = o.activityLog?.deliveryTime ? new Date(o.activityLog.deliveryTime).getTime() : null;
      if (deliveredAt != null && deliveredAt >= fromTime && deliveredAt <= toTime) matched.push(o);
    }
    if (batch.length < pageSize) break;
  }
  return matched;
}

export async function getDeliveredOrders(apiKey: string): Promise<ShipdayOrder[]> {
  const all = await getAllOrders(apiKey);
  return all.filter(o => {
    const state = o.orderStatus?.orderState ?? "";
    return DELIVERED_STATES.has(state);
  });
}

export function getOrderDeliveryValue(order: ShipdayOrder): number {
  return Math.round(order.costing?.deliveryFee ?? order.costing?.totalCost ?? 0);
}

export function getOrderCarrierId(order: ShipdayOrder): string | null {
  const id = order.assignedCarrierId ?? order.assignedCarrier?.id;
  return id ? String(id) : null;
}

export function getOrderDeliveredAt(order: ShipdayOrder): Date {
  const t = order.activityLog?.deliveryTime;
  return t ? new Date(t) : new Date();
}

// ─── Pedidos COMPLETADOS (fuente confiable) ───────────────────────────────────
// El endpoint POST /orders/query con orderStatus=ALREADY_DELIVERED devuelve los
// pedidos REALMENTE entregados (la sección "Completados" de Shipday). A diferencia
// del feed de activos, los cancelados/eliminados NUNCA aparecen aquí, así que no
// se pueden contar como entregados por error. La estructura es PLANA (distinta del
// feed de activos), por eso tiene sus propios getters.
export interface ShipdayCompletedOrder {
  orderId: number;
  orderNumber?: string;
  deliveryFee?: number;
  orderTotal?: number;
  incomplete?: boolean;
  status?: string;
  deliveryTime?: string | null;
  carrier?: { id?: number; name?: string } | null;
  delivery?: { name?: string; address?: string } | null;
}

export async function getCompletedOrders(apiKey: string, from: string, to: string): Promise<ShipdayCompletedOrder[] & { partialError?: string }> {
  // IMPORTANTE: Shipday interpreta startTime/endTime como UTC (sin zona horaria).
  // Si se usa un "23:59:59" fijo del día local, en Colombia (UTC-5) ese límite es
  // las 6:59pm y se pierden los pedidos entregados en la noche. Por eso:
  //  - startTime: inicio del día `from` (UTC; cubre de sobra el día en Bogotá).
  //  - endTime: el FIN del día `to` en Bogotá expresado en UTC, pero TOPADO al
  //    momento actual (Shipday rechaza endTime en el futuro).
  const startTime = `${from}T00:00:00`;
  const nowIso = new Date().toISOString().slice(0, 19);
  const toEndBogotaUtc = new Date(`${to}T23:59:59.999-05:00`).toISOString().slice(0, 19);
  const endTime = nowIso < toEndBogotaUtc ? nowIso : toEndBogotaUtc;
  console.log("[shipday/query] from=%s to=%s startTime=%s endTime=%s", from, to, startTime, endTime);

  // La consulta devuelve máximo 100 por página → se pagina con cursores.
  const PAGE = 100;
  const MAX_PAGES = 100; // tope de seguridad (hasta 10.000 pedidos en el rango)
  const all: ShipdayCompletedOrder[] = [];
  let partialError: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    let batch: ShipdayCompletedOrder[];
    try {
      batch = await fetchCompletedPage(apiKey, {
        startTime,
        endTime,
        orderStatus: "ALREADY_DELIVERED",
        startCursor: page * PAGE,
        endCursor: (page + 1) * PAGE,
      });
    } catch (err) {
      // Una página falló tras los reintentos. CLAVE: no descartar lo ya recolectado.
      // Los pedidos vienen del más nuevo al más viejo, así que los más viejos del día
      // (p. ej. entregados al mediodía) caen en las páginas profundas; si un rate limit
      // corta ahí y tiráramos todo, ESE pedido no se cargaría nunca y habría que meterlo
      // a mano (bug real). En su lugar: si ya trajimos algo, devolvemos lo parcial y el
      // próximo barrido reintenta el resto (persistDeliveredOrder es idempotente). Solo
      // si falla la PRIMERA página propagamos el error (no hay nada que salvar y el sync
      // debe quedar marcado en error).
      if (all.length === 0) throw err;
      partialError = `Sincronización incompleta: ${err instanceof Error ? err.message : String(err)}`;
      console.warn(
        `[shipday/query] página ${page} falló tras reintentos; se continúa con ${all.length} pedidos parciales (el próximo barrido traerá el resto):`,
        err instanceof Error ? err.message : err,
      );
      break;
    }
    if (batch.length === 0) break;
    all.push(...batch);
    if (batch.length < PAGE) break; // última página parcial
  }
  // Solo los realmente entregados y NO marcados como incompletos.
  return Object.assign(all.filter(o => !o.incomplete && o.deliveryTime), { partialError });
}

// Trae UNA página de /orders/query reintentando ante errores transitorios (rate limit,
// 5xx, red). Devuelve el arreglo de pedidos (plano). Lanza solo si agota los reintentos
// o ante un error definitivo (auth, etc.).
async function fetchCompletedPage(apiKey: string, body: object): Promise<ShipdayCompletedOrder[]> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    await acquireSlot();
    let res: Response;
    try {
      res = await fetch(`${BASE_URL}/orders/query`, {
        method: "POST",
        headers: { Authorization: `Basic ${apiKey}`, "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(body),
      });
    } catch (netErr) {
      lastErr = netErr;
      if (attempt === MAX_ATTEMPTS) break;
      await sleep(1200 * attempt);
      continue;
    }
    if (res.ok) {
      const data = (await res.json()) as ShipdayCompletedOrder[] | { orders?: ShipdayCompletedOrder[] };
      return Array.isArray(data) ? data : (data.orders ?? []);
    }
    const text = await res.text().catch(() => "");
    lastErr = new Error(`Shipday /orders/query devolvió ${res.status}: ${text}`);
    if (!isRetriable(res.status, text)) throw lastErr; // error definitivo → propagar ya
    if (attempt === MAX_ATTEMPTS) break;
    await sleep(1200 * attempt); // backoff; acquireSlot además espaciará por el limitador
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export function getCompletedDeliveryValue(o: ShipdayCompletedOrder): number {
  return Math.round(o.deliveryFee ?? o.orderTotal ?? 0);
}
export function getCompletedCarrierId(o: ShipdayCompletedOrder): string | null {
  return o.carrier?.id ? String(o.carrier.id) : null;
}
export function getCompletedDeliveredAt(o: ShipdayCompletedOrder): Date {
  return o.deliveryTime ? new Date(o.deliveryTime) : new Date();
}

export async function testConnection(apiKey: string): Promise<{ ok: boolean; message: string; driverCount?: number }> {
  try {
    const drivers = await getDrivers(apiKey);
    return {
      ok: true,
      message: `Conexión exitosa con Shipday (${drivers.length} domiciliarios)`,
      driverCount: drivers.length,
    };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}
