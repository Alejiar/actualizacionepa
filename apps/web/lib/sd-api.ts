/**
 * Cliente fetch para los endpoints Shipday del backend.
 */

// Se reusa el getToken de ./api a propósito: antes este archivo tenía su propia copia
// leyendo localStorage, y al cambiar el almacenamiento del token en un solo lado las
// dos mitades de la app habrían quedado con sesiones distintas.
import { getToken, NETWORK_ERROR, setToken } from "./api";
import { getDeviceId } from "./device-id";
import { forgetKey, rememberUnanswered, retryKeyFor } from "./retry-key";

async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getToken();
  const deviceId = getDeviceId();
  const method = (init.method ?? "GET").toUpperCase();
  // NEW05: un POST reenviado tras un corte sin respuesta reutiliza su clave (ver retry-key.ts).
  const signature = `${method} ${path} ${typeof init.body === "string" ? init.body : ""}`;
  const retryKey = method === "POST" ? retryKeyFor(signature) : null;
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(deviceId ? { "X-Device-Id": deviceId } : {}),
        ...(retryKey ? { "Idempotency-Key": retryKey } : {}),
        ...(init.headers ?? {}),
      },
    });
  } catch {
    if (retryKey) rememberUnanswered(signature, retryKey);
    throw new Error(NETWORK_ERROR);
  }
  if (retryKey) forgetKey(signature);
  // Sesión caída o token vencido: mandar al login, igual que hace ./api. Sin esto, la
  // mitad Shipday de la app se quedaba mostrando errores sueltos con la sesión muerta.
  if (res.status === 401 && typeof window !== "undefined") {
    setToken(null);
    if (!window.location.pathname.startsWith("/login")) {
      window.location.href = "/login";
    }
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((err as { error?: string }).error ?? res.statusText);
  }
  // 204 (eliminar equipo, desactivar sucursal, eliminar conversión): no hay cuerpo que leer;
  // intentar res.json() mostraba un error falso aunque la acción sí se había aplicado.
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

// ─── Libreta de campo ─────────────────────────────────────────────────────────

export interface FieldNote {
  id: string;
  date: string;
  content: string;
  author: string | null;
  createdAt: string;
  updatedAt: string;
}

export const getFieldNotes = (date?: string) =>
  apiFetch<FieldNote[]>(`/field-notes${date ? `?date=${encodeURIComponent(date)}` : ""}`);
export const createFieldNote = (content: string, author?: string, date?: string) =>
  apiFetch<FieldNote>("/field-notes", { method: "POST", body: JSON.stringify({ content, author, date }) });
export const updateFieldNote = (id: string, content: string) =>
  apiFetch<FieldNote>(`/field-notes/${id}`, { method: "PATCH", body: JSON.stringify({ content }) });
export const deleteFieldNote = (id: string) =>
  apiFetch<void>(`/field-notes/${id}`, { method: "DELETE" });

// ─── Branches ────────────────────────────────────────────────────────────────

export const getBranches = () => apiFetch<Branch[]>("/branches");
export const createBranch = (data: BranchInput) =>
  apiFetch<Branch>("/branches", { method: "POST", body: JSON.stringify(data) });
export const updateBranch = (id: string, data: Partial<BranchInput> & { active?: boolean }) =>
  apiFetch<Branch>(`/branches/${id}`, { method: "PATCH", body: JSON.stringify(data) });
export const deleteBranch = (id: string) =>
  apiFetch<void>(`/branches/${id}`, { method: "DELETE" });
export const testConnection = (id: string) =>
  apiFetch<{ ok: boolean; message: string }>(`/branches/${id}/test-connection`, { method: "POST" });
export const syncBranch = (id: string) =>
  apiFetch<{ drivers: number; orders: number }>(`/branches/${id}/sync`, { method: "POST" });
export const syncAll = () =>
  apiFetch<SyncResult[]>("/branches/sync-all", { method: "POST" });
export const startOrdersFromToday = (id: string) =>
  apiFetch<{ ordersSince: string; drivers: number; orders: number }>(`/branches/${id}/start-orders`, { method: "POST" });

// ─── Drivers ─────────────────────────────────────────────────────────────────

export const getDrivers = (branchId?: string) =>
  apiFetch<Driver[]>(`/sd/drivers${branchId ? `?branchId=${branchId}` : ""}`);
export const getDriverDetail = (id: string) => apiFetch<DriverDetail>(`/sd/drivers/${id}`);
export const getDriverStatement = (id: string) => apiFetch<DriverStatement>(`/sd/drivers/${id}/statement`);
// F14: el operador divide el pago: `baseAmount` va a devolver base; el resto, a comisión.
export const registerPayment = (id: string, amount: number, medium: "cash" | "bank", notes?: string, baseAmount = 0) =>
  apiFetch<{ payment: Payment; baseAlloc: number; commissionAlloc: number; basePendingBefore: number; commissionDebt: number; creditAmount: number }>(
    `/sd/drivers/${id}/payment`,
    { method: "POST", body: JSON.stringify({ amount, medium, notes, baseAmount }) },
  );
export const getOrdersToday = (branchId?: string, date?: string) => {
  const q = new URLSearchParams(Object.entries({ branchId, date }).filter(([, v]) => v) as [string, string][]);
  return apiFetch<Order[]>(`/sd/orders/today${q.toString() ? "?" + q : ""}`);
};

// ─── Bases ────────────────────────────────────────────────────────────────────

export const getBases = (params?: { branchId?: string; driverId?: string; from?: string; to?: string }) => {
  const q = new URLSearchParams(Object.entries(params ?? {}).filter(([, v]) => v) as [string, string][]);
  return apiFetch<BaseTransaction[]>(`/sd/bases${q.toString() ? "?" + q : ""}`);
};
export interface BaseSplit { cashAmount?: number; bankAmount?: number; notes?: string }
export const giveBase = (driverId: string, data: BaseSplit) =>
  apiFetch(`/sd/bases/${driverId}/give`, { method: "POST", body: JSON.stringify(data) });
export const payBase = (driverId: string, data: BaseSplit) =>
  apiFetch(`/sd/bases/${driverId}/pay`, { method: "POST", body: JSON.stringify(data) });
export const getBaseSummary = (driverId: string) => apiFetch<BaseSummary>(`/sd/bases/${driverId}/summary`);
export const deleteBase = (id: string) => apiFetch<void>(`/sd/bases/${id}`, { method: "DELETE" });
export const editBase = (id: string, data: { cashAmount?: number; bankAmount?: number; amount?: number; notes?: string }) =>
  apiFetch<void>(`/sd/bases/${id}`, { method: "PATCH", body: JSON.stringify(data) });

// ─── Conversions ──────────────────────────────────────────────────────────────

export const getConversions = (params?: { branchId?: string; from?: string; to?: string }) => {
  const q = new URLSearchParams(Object.entries(params ?? {}).filter(([, v]) => v) as [string, string][]);
  return apiFetch<Conversion[]>(`/sd/conversions${q.toString() ? "?" + q : ""}`);
};
export const createConversion = (data: ConversionInput) =>
  apiFetch<Conversion>("/sd/conversions", { method: "POST", body: JSON.stringify(data) });
export const deleteConversion = (id: string) =>
  apiFetch<void>(`/sd/conversions/${id}`, { method: "DELETE" });

// ─── Dashboard ────────────────────────────────────────────────────────────────

export const getDashboard = (branchId?: string) =>
  apiFetch<DashboardData>(`/sd/dashboard${branchId ? `?branchId=${branchId}` : ""}`);
export const getDailyStats = (date: string, branchId?: string) =>
  apiFetch<DailyStat[]>(`/sd/dashboard/daily/${date}${branchId ? `?branchId=${branchId}` : ""}`);
export const getDebtsDashboard = (branchId?: string) =>
  apiFetch<DebtsDashboard>(`/sd/dashboard/debts${branchId ? `?branchId=${branchId}` : ""}`);

export const payDriverCredit = (driverId: string, medium: "cash" | "bank") =>
  apiFetch<{ paid: number; medium: string; driverName: string }>(
    `/sd/drivers/${driverId}/pay-credit`,
    { method: "POST", body: JSON.stringify({ medium }) }
  );

export const applyBankToDriver = (bankTxId: string, driverId: string, baseAmount = 0) =>
  apiFetch<{ applied: number; baseAlloc: number; commissionAlloc: number; previousDebt: number; newDebt: number; creditAmount: number; creditMedium: string | null; basePendingBefore: number }>(
    `/bank-transactions/${bankTxId}/apply-to-driver`,
    { method: "POST", body: JSON.stringify({ driverId, baseAmount }) }
  );
export const getOrdersByBranch = (branchId: string, from?: string, to?: string) => {
  const q = new URLSearchParams(Object.entries({ from, to }).filter(([, v]) => v) as [string, string][]);
  return apiFetch<Order[]>(`/sd/dashboard/orders/${branchId}${q.toString() ? "?" + q : ""}`);
};

// ─── Orders ───────────────────────────────────────────────────────────────────

export const createManualOrder = (data: {
  branchId: string;
  driverId?: string;
  deliveryValue: number;
  orderNumber?: string;
  customerName?: string;
  clientId?: string;
  addToClientDebt?: boolean;
  notes?: string;
  /** "AAAA-MM-DD" o instante con zona: fecha REAL de entrega (puede ser un día ya cerrado). */
  deliveredAt?: string;
  /** Misma clave en un reintento = el mismo pedido (no duplica la comisión). */
  idempotencyKey?: string;
}) => apiFetch<Order>("/sd/orders/manual", { method: "POST", body: JSON.stringify(data) });

// ─── Closes ───────────────────────────────────────────────────────────────────

export const getCloses = (branchId?: string) =>
  apiFetch<MonthlyClose[]>(`/sd/closes${branchId ? `?branchId=${branchId}` : ""}`);
export const createClose = (month: string, branchId?: string, initialCash?: number, initialBank?: number) =>
  apiFetch<MonthlyClose>("/sd/closes", { method: "POST", body: JSON.stringify({ month, branchId, initialCash, initialBank }) });
export const exportExcel = async (month: string, branchId?: string) => {
  const token = getToken();
  const deviceId = getDeviceId();
  const q = branchId ? `?branchId=${branchId}` : "";
  // Este endpoint es binario (xlsx), por eso NO pasa por apiFetch y arma el fetch a mano. Pero
  // debe mandar los MISMOS headers de identidad que apiFetch: el token Y el X-Device-Id que exige
  // la puerta de Equipos (requireAuthorizedDevice). Sin el device id, un acceso remoto (no
  // loopback, p. ej. por Tailscale) recibía 403 y el Excel "no se dejaba descargar", aunque el
  // reporte en pantalla sí cargaba (ese sí va por apiFetch, con el header). Loopback lo dejaba
  // pasar igual, por eso solo fallaba en remoto.
  const res = await fetch(`/api/sd/closes/export/${month}${q}`, {
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(deviceId ? { "X-Device-Id": deviceId } : {}),
    },
  });
  if (!res.ok) throw new Error("Error al generar Excel");
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `cashbuddy-${month}.xlsx`;
  a.click();
  URL.revokeObjectURL(url);
};

// ─── Dashboard Full ───────────────────────────────────────────────────────────

export interface DashboardFull extends DashboardData {
  caja: {
    shifts: ShiftClose[];
    shiftsStatus: { AM: boolean; PM: boolean; close: boolean };
    bankToday: BankSummary;
    expectedCash: number;
    expectedBank: number;
  };
  topClientDebtors: { id: string; name: string; phone?: string; pendingDebt: number }[];
}

export const getDashboardFull = (branchId?: string, date?: string) => {
  const q = new URLSearchParams(Object.entries({ branchId, date }).filter(([, v]) => v) as [string, string][]);
  return apiFetch<DashboardFull>(`/sd/dashboard/full${q.toString() ? "?" + q : ""}`);
};

// ─── Unified bank movements ───────────────────────────────────────────────────

export type BankMovementType = "ingreso" | "egreso" | "consignacion" | "retiro";

export interface UnifiedBankMovement {
  id: string;
  type: BankMovementType;
  medium?: "cash" | "bank";
  amount: number;
  description: string;
  reference?: string;
  branchId?: string;
  branchName?: string;
  driverName?: string;
  createdByName?: string | null;
  deviceName?: string | null; // PC desde el que se registró
  groupId?: string | null;
  pairId?: string | null;
  noCounterpart?: boolean;
  // Para movimientos mixtos consolidados:
  cashPart?: number;
  bankPart?: number;
  date: string;
  source: "bank" | "conversion";
}

export async function getUnifiedBankMovements(params?: { from?: string; to?: string; branchId?: string }): Promise<UnifiedBankMovement[]> {
  const q = new URLSearchParams(Object.entries(params ?? {}).filter(([, v]) => v) as [string, string][]);
  const [txs, convs] = await Promise.all([
    apiFetch<BankTransaction[]>(`/bank-transactions${q.toString() ? "?" + q : ""}`),
    apiFetch<Conversion[]>(`/sd/conversions${q.toString() ? "?" + q : ""}`),
  ]);

  // Consolidar mixtos: dos filas con el mismo groupId = UN movimiento (efectivo+transferencia).
  const mixedGroups = new Map<string, BankTransaction[]>();
  const singles: BankTransaction[] = [];
  for (const t of txs) {
    if (t.groupId) {
      const g = mixedGroups.get(t.groupId) ?? [];
      g.push(t);
      mixedGroups.set(t.groupId, g);
    } else {
      singles.push(t);
    }
  }

  const fromTxs: UnifiedBankMovement[] = singles.map(t => ({
    id: t.id,
    type: t.type as BankMovementType,
    medium: t.medium ?? "bank",
    amount: t.amount,
    description: t.description,
    reference: t.reference,
    driverName: t.driverName,
    createdByName: t.createdByName,
    deviceName: t.deviceName,
    pairId: t.pairId,
    noCounterpart: t.noCounterpart,
    date: t.date,
    source: "bank" as const,
  }));

  // Un movimiento consolidado por cada grupo mixto.
  for (const [groupId, parts] of mixedGroups) {
    if (parts.length === 1) {
      // Mitad huérfana (no debería pasar): tratarla como simple.
      const t = parts[0];
      fromTxs.push({ id: t.id, type: t.type as BankMovementType, medium: t.medium ?? "bank", amount: t.amount, description: t.description, reference: t.reference, driverName: t.driverName, createdByName: t.createdByName, deviceName: t.deviceName, groupId, pairId: t.pairId, noCounterpart: t.noCounterpart, date: t.date, source: "bank" });
      continue;
    }
    const cashPart = parts.find(p => p.medium === "cash")?.amount ?? 0;
    const bankPart = parts.find(p => p.medium === "bank")?.amount ?? 0;
    const head = parts[0];
    fromTxs.push({
      id: head.id, // id de una mitad; al eliminar, el backend borra ambas por groupId
      type: head.type as BankMovementType,
      amount: cashPart + bankPart,
      description: head.description,
      reference: head.reference,
      driverName: head.driverName,
      createdByName: head.createdByName,
      deviceName: head.deviceName,
      groupId,
      pairId: head.pairId,
      noCounterpart: head.noCounterpart,
      cashPart,
      bankPart,
      date: head.date,
      source: "bank" as const,
    });
  }

  const fromConvs: UnifiedBankMovement[] = convs.map(c => ({
    id: c.id,
    type: c.type === "efectivo_a_banco" ? "consignacion" : "retiro",
    // Igual que el backend (saldo esperado, resumen del día, Excel): efectivo_a_banco = sale
    // efectivo y entra al banco (consignación); banco_a_efectivo = sale del banco y entra efectivo.
    medium: "bank",
    amount: c.amount,
    description: c.notes || (c.type === "efectivo_a_banco" ? "Consignación: salió efectivo, entró al banco" : "Retiro: salió del banco, entró efectivo"),
    reference: undefined,
    branchId: c.branchId,
    branchName: c.branch?.name,
    driverName: c.driverName,
    deviceName: c.deviceName,
    date: c.date,
    source: "conversion" as const,
  }));

  return [...fromTxs, ...fromConvs].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
}

// ─── Movimientos unificados ───────────────────────────────────────────────────

export interface UnifiedMovement {
  id: string;
  date: string;
  time: string;
  type: "ingreso" | "egreso";
  medium: "cash" | "bank";
  amount: number;
  description: string;
  category: string;
  source: string;
  relatedName?: string;
  createdByName?: string | null;
  deviceName?: string | null; // PC desde el que se registró
  entityType: string;
  entityId: string;
  editableDescription: boolean;
  /** Desglose por medio si el registro mueve efectivo y banco (base mixta, cobro dividido, conversión). */
  parts?: { type: "ingreso" | "egreso"; medium: "cash" | "bank"; amount: number }[];
  /** "pending": registro de Caja sin confirmar; se muestra pero no suma a los totales (AIF15). */
  status?: "pending";
}

export const getUnifiedMovements = (params?: { from?: string; to?: string; limit?: number }) => {
  const q = new URLSearchParams(
    Object.entries(params ?? {}).filter(([, v]) => v != null).map(([k, v]) => [k, String(v)])
  );
  return apiFetch<UnifiedMovement[]>(`/movements/unified${q.toString() ? "?" + q : ""}`);
};

// ─── Equipos (PCs): identificación y autorización ─────────────────────────────

export type DeviceStatus = "pending" | "approved" | "blocked";

// Estado del propio equipo (para el "gate" del frontend).
export interface MyDevice {
  id: string | null;
  status: DeviceStatus;
  name: string | null;
  trusted: boolean;
  allowed: boolean;
  code: string | null;
  logoutRequestedAt: string | null;
}

// Equipo tal como lo ve el admin en la página "Equipos".
export interface Device {
  id: string;
  name: string | null;
  status: DeviceStatus;
  trusted: boolean;
  firstUserName: string | null;
  lastUserName: string | null;
  firstSeenIp: string | null;
  lastSeenIp: string | null;
  approvedByName: string | null;
  approvedAt: string | null;
  logoutRequestedAt: string | null;
  lastSeenAt: string;
  createdAt: string;
}

export interface DeviceActivity {
  id: string;
  deviceId: string | null;
  deviceName: string | null;
  userName: string | null;
  method: string;
  path: string;
  statusCode: number | null;
  createdAt: string;
}

export const getMyDevice = () => apiFetch<MyDevice>("/devices/me");
export const getDevices = () => apiFetch<{ devices: Device[]; pendingCount: number }>("/devices");
export const getDevicePendingCount = () => apiFetch<{ count: number }>("/devices/pending-count");
export const getDeviceActivity = (deviceId?: string, limit?: number) => {
  const q = new URLSearchParams();
  if (deviceId) q.set("deviceId", deviceId);
  if (limit) q.set("limit", String(limit));
  return apiFetch<DeviceActivity[]>(`/devices/activity${q.toString() ? "?" + q : ""}`);
};
export const approveDevice = (id: string, name: string) =>
  apiFetch<Device>(`/devices/${id}/approve`, { method: "PATCH", body: JSON.stringify({ name }) });
export const renameDevice = (id: string, name: string) =>
  apiFetch<Device>(`/devices/${id}/rename`, { method: "PATCH", body: JSON.stringify({ name }) });
export const blockDevice = (id: string) => apiFetch<Device>(`/devices/${id}/block`, { method: "PATCH" });
export const unblockDevice = (id: string, name?: string) =>
  apiFetch<Device>(`/devices/${id}/unblock`, { method: "PATCH", body: JSON.stringify(name ? { name } : {}) });
export const rejectDevice = (id: string) => apiFetch<Device>(`/devices/${id}/reject`, { method: "PATCH" });
export const requestDeviceLogout = (id: string) => apiFetch<Device>(`/devices/${id}/logout`, { method: "POST" });
export const deleteDevice = (id: string) => apiFetch<void>(`/devices/${id}`, { method: "DELETE" });

// ─── URL de acceso local ──────────────────────────────────────────────────────

export interface LocalUrls {
  port: number;
  primary: string;
  local: string | null;
  tailscale: string | null;
  urls: { name: string; ip: string; url: string }[];
}

export const getLocalUrls = () => apiFetch<LocalUrls>("/network/local-urls");

// ─── Usuarios ─────────────────────────────────────────────────────────────────

export interface SystemUser {
  id: string;
  email: string;
  name: string;
  role: "admin" | "user";
  active: boolean;
  createdAt: string;
}

export const getUsers = () => apiFetch<SystemUser[]>("/users");
export const createUser = (data: { email: string; name: string; password: string; role: "admin" | "user" }) =>
  apiFetch<SystemUser>("/users", { method: "POST", body: JSON.stringify(data) });
export const updateUser = (id: string, data: { name?: string; role?: "admin" | "user"; active?: boolean; password?: string }) =>
  apiFetch<SystemUser>(`/users/${id}`, { method: "PATCH", body: JSON.stringify(data) });
export const deleteUser = (id: string) =>
  apiFetch<{ ok: boolean }>(`/users/${id}`, { method: "DELETE" });

// ─── Solicitudes de edición ───────────────────────────────────────────────────

export interface EditRequestChange { old: string; new: string }

export interface EditRequest {
  id: string;
  requesterId: string;
  requestType: "edit" | "delete" | "create";
  entityType: string;
  entityId: string;
  entityLabel: string;
  changes: Record<string, EditRequestChange>;
  reason: string;
  status: "pending" | "approved" | "rejected";
  reviewerId?: string;
  reviewNotes?: string;
  reviewedAt?: string;
  createdAt: string;
  requester?: { id: string; name: string; email: string };
  reviewer?: { id: string; name: string };
}

export const getEditRequests = (status?: "pending" | "approved" | "rejected") =>
  apiFetch<EditRequest[]>(`/edit-requests${status ? `?status=${status}` : ""}`);
export const getEditRequestCount = () =>
  apiFetch<{ count: number }>("/edit-requests/count");
export const createEditRequest = (data: {
  entityType: string;
  entityId: string;
  entityLabel: string;
  changes: Record<string, EditRequestChange> | Record<string, unknown>;
  reason: string;
  requestType?: "edit" | "delete" | "create";
}) => apiFetch<EditRequest>("/edit-requests", { method: "POST", body: JSON.stringify(data) });
export const reviewEditRequest = (id: string, action: "approved" | "rejected", notes?: string) =>
  apiFetch<EditRequest>(`/edit-requests/${id}/review`, { method: "POST", body: JSON.stringify({ action, notes }) });
export const recalcOrders = () =>
  apiFetch<{ total: number; fixed: number }>("/admin/recalc-orders", { method: "POST" });

// ─── Types ────────────────────────────────────────────────────────────────────

export interface Branch {
  id: string;
  name: string;
  address?: string;
  phone?: string;
  active: boolean;
  syncStatus: "ok" | "error" | "never";
  syncMessage?: string;
  lastSyncAt?: string;
  ordersSince?: string | null;
  createdAt: string;
}

export interface BranchInput {
  name: string;
  address?: string;
  phone?: string;
  apiKey: string;
}

export interface SyncResult {
  branchId: string;
  name: string;
  ok: boolean;
  drivers?: number;
  orders?: number;
  error?: string;
}

export interface Driver {
  id: string;
  shipdayDriverId: string;
  branchId: string;
  name: string;
  phone?: string;
  active: boolean;
  /** F14: deuda SOLO por comisiones. */
  pendingDebt: number;
  /** F14: crédito a favor del domiciliario (por comisiones). No se compensa con la base. */
  creditAmount: number;
  creditMedium?: string | null;
  /** F14: base sin devolver = entregadas − devueltas (cuenta propia). */
  basePending?: number;
  /** Solo informativo: base + comisión − crédito. No es otra deuda. */
  totalInformativo?: number;
  branch: { id: string; name: string };
  createdAt: string;
}

export interface DriverDetail extends Driver {
  orders: Order[];
  bases: BaseTransaction[];
  payments: Payment[];
  dailyStats: DailyStat[];
}

export interface DriverStatement {
  driver: Driver;
  totalOrders: number;
  totalValue: number;
  totalCompany: number;
  totalBasesGiven: number;
  totalBasesPaid: number;
  totalPaid: number;
  debtCycleStart?: string | null;
  pendingDebt: number;
  creditAmount: number;
  creditMedium?: string | null;
  basePending: number;
  totalInformativo: number;
  orders: Order[];
  bases: BaseTransaction[];
  payments: Payment[];
  stats: DailyStat[];
}

export interface Order {
  id: string;
  shipdayOrderId: string;
  branchId: string;
  driverId?: string;
  orderNumber?: string;
  deliveryValue: number;
  companyAmount: number;
  customerName?: string;
  customerAddress?: string;
  status: string;
  deliveredAt?: string;
  driver?: { id: string; name: string };
  branch?: { id: string; name: string };
}

export interface BaseTransaction {
  id: string;
  branchId: string;
  driverId: string;
  amount: number;
  cashAmount?: number;
  bankAmount?: number;
  type: "entrega" | "pago";
  notes?: string;
  date: string;
  driver?: { id: string; name: string };
  branch?: { id: string; name: string };
}

export interface Payment {
  id: string;
  driverId: string;
  amount: number;
  medium: "cash" | "bank";
  notes?: string;
  date: string;
}

export interface BaseSummary {
  given: number;
  paid: number;
  pending: number;
  history: BaseTransaction[];
}

export interface ConversionInput {
  branchId: string;
  amount: number;
  type: "banco_a_efectivo" | "efectivo_a_banco";
  notes?: string;
  driverId?: string;
  date?: string;
}

export interface Conversion {
  id: string;
  branchId: string;
  amount: number;
  type: "banco_a_efectivo" | "efectivo_a_banco";
  notes?: string;
  driverId?: string;
  driverName?: string;
  deviceName?: string | null; // PC desde el que se registró
  date: string;
  branch?: { id: string; name: string };
}

export interface DashboardData {
  today: { orders: number; value: number; company: number };
  month: { orders: number; value: number; company: number };
  drivers: { total: number; active: number };
  /** F14: totalAmount = solo comisiones; basesPending aparte; combined es informativo. */
  debts: { totalAmount: number; driverCount: number; commission?: number; basesPending?: number; baseDriverCount?: number; combined?: number };
  recentOrders: Order[];
  branches: { id: string; name: string; syncStatus: string; lastSyncAt?: string }[];
}

export interface DailyStat {
  id: string;
  date: string;
  branchId: string;
  driverId: string;
  orderCount: number;
  totalValue: number;
  companyTotal: number;
  driver?: { id: string; name: string };
  branch?: { id: string; name: string };
}

export interface DriverDebt {
  id: string;
  name: string;
  /** F14: deuda solo por comisiones. */
  pendingDebt: number;
  creditAmount: number;
  /** F14: base sin devolver (cuenta aparte). */
  basePending?: number;
  /** Solo informativo: comisión + base − crédito. */
  totalInformativo?: number;
  creditMedium?: string | null;
  branch: { id: string; name: string };
}

export interface DebtsDashboard {
  debtors: DriverDebt[];
  creditors: DriverDebt[];
}

export interface MonthlyClose {
  id: string;
  branchId?: string;
  month: string;
  totalOrders: number;
  totalValue: number;
  companyTotal: number;
  basesGiven: number;
  basesPaid: number;
  basesPending: number;
  conversions: unknown;
  initialCash?: number;
  initialBank?: number;
  closedAt: string;
  branch?: { id: string; name: string };
}

// ─── Clients ──────────────────────────────────────────────────────────────────

export interface Client {
  id: string;
  name: string;
  phone?: string;
  email?: string;
  address?: string;
  notes?: string;
  pendingDebt: number;
  active: boolean;
  createdAt: string;
  debts: ClientDebt[];
}

export interface ClientDebt {
  id: string;
  clientId: string;
  description: string;
  amount: number;
  medium?: "cash" | "bank" | null;
  paid: boolean;
  paidAt?: string;
  paidAmount?: number;
  createdByName?: string | null; // quién registró la deuda
  paidByName?: string | null;    // quién registró el cobro
  createdAt: string;
}

export const getClients = (active?: boolean) =>
  apiFetch<Client[]>(`/clients${active ? "?active=true" : ""}`);
export const getClient = (id: string) => apiFetch<Client>(`/clients/${id}`);
export const getDebtors = () => apiFetch<Client[]>("/clients/debtors");
export const createClient = (data: Partial<Client> & { initialDebt?: number; initialDebtDescription?: string; initialDebtMedium?: "cash" | "bank" }) =>
  apiFetch<Client>("/clients", { method: "POST", body: JSON.stringify(data) });
export const updateClient = (id: string, data: Partial<Client>) =>
  apiFetch<Client>(`/clients/${id}`, { method: "PATCH", body: JSON.stringify(data) });
export const deleteClient = (id: string) =>
  apiFetch<void>(`/clients/${id}`, { method: "DELETE" });
export const addClientDebt = (clientId: string, description: string, amount: number, date?: string, medium?: "cash" | "bank") =>
  apiFetch<ClientDebt>(`/clients/${clientId}/debt`, {
    method: "POST", body: JSON.stringify({ description, amount, date, medium }),
  });
export const payClientDebt = (debtId: string, paidAmount?: number) =>
  apiFetch<{ ok: boolean }>(`/clients/debts/${debtId}/pay`, {
    method: "POST", body: JSON.stringify({ paidAmount }),
  });
export const payClient = (clientId: string, amount: number, payAll = false, medium: "cash" | "bank" = "cash") =>
  apiFetch<{ applied: number; remaining: number }>(`/clients/${clientId}/pay`, {
    method: "POST", body: JSON.stringify({ amount, payAll, medium }),
  });

// ─── Clientes por hora (alquiler de domiciliarios) ────────────────────────────

export interface HourlyShift {
  id: string;
  hourlyClientId: string;
  /** Tarifa congelada con la que se valoró el turno (null en turnos viejos no reconstruibles). */
  driverHourValue?: number | null;
  companyHourValue?: number | null;
  driverId?: string | null;
  driverName: string;
  date: string;
  startTime: string;
  endTime: string;
  minutes: number;
  driverAmount: number;
  companyAmount: number;
  totalAmount: number;
  driverPaid: boolean;
  driverPaidMedium?: "cash" | "bank" | null;
  driverPaidAt?: string | null;
  driverPaidByName?: string | null;
  paid: boolean;
  paidAmount: number;
  paidAt?: string | null;
  paidCash?: number;
  paidBank?: number;
  paidByName?: string | null;
  createdByName?: string | null;
  createdAt: string;
  // Presente solo en el historial global (incluye el cliente al que pertenece el turno).
  hourlyClient?: { id: string; name: string };
}

export interface HourlyClient {
  id: string;
  name: string;
  driverHourValue: number;
  companyHourValue: number;
  pendingDebt: number;
  active: boolean;
  createdAt: string;
  shifts: HourlyShift[];
  // Calculados por el backend:
  pendingDriverPay: number;   // lo que falta pagarle a domiciliarios (turnos sin pagar)
  driverOutstanding: number;  // parte domiciliario de la deuda viva del cliente
  companyOutstanding: number; // parte empresa (ganancia) de la deuda viva
}

export const getHourlyClients = (active?: boolean) =>
  apiFetch<HourlyClient[]>(`/hourly-clients${active ? "?active=true" : ""}`);
export const getHourlyClient = (id: string) => apiFetch<HourlyClient>(`/hourly-clients/${id}`);
export const createHourlyClient = (data: { name: string; driverHourValue: number; companyHourValue: number }) =>
  apiFetch<HourlyClient>("/hourly-clients", { method: "POST", body: JSON.stringify(data) });
export const updateHourlyClient = (
  id: string,
  data: Partial<{ name: string; driverHourValue: number; companyHourValue: number; active: boolean }>,
) => apiFetch<HourlyClient>(`/hourly-clients/${id}`, { method: "PATCH", body: JSON.stringify(data) });
export const deleteHourlyClient = (id: string) =>
  apiFetch<{ ok: boolean; deleted?: boolean; deactivated?: boolean }>(`/hourly-clients/${id}`, { method: "DELETE" });
export const registerHourlyShift = (
  clientId: string,
  data: { driverId: string; startTime: string; endTime: string; date?: string; medium: "cash" | "bank"; confirmOvernight?: boolean },
) => apiFetch<HourlyShift>(`/hourly-clients/${clientId}/shifts`, { method: "POST", body: JSON.stringify(data) });
export const payHourlyClient = (clientId: string, amount: number, payAll = false, medium: "cash" | "bank" = "cash") =>
  apiFetch<{ applied: number; remaining: number }>(`/hourly-clients/${clientId}/pay`, {
    method: "POST", body: JSON.stringify({ amount, payAll, medium }),
  });
export const payHourlyDriver = (shiftId: string, medium: "cash" | "bank") =>
  apiFetch<{ ok: boolean }>(`/hourly-shifts/${shiftId}/pay-driver`, {
    method: "POST", body: JSON.stringify({ medium }),
  });
export const editHourlyShift = (shiftId: string, data: { driverId?: string; startTime?: string; endTime?: string; date?: string; confirmOvernight?: boolean }) =>
  apiFetch<{ ok: boolean }>(`/hourly-shifts/${shiftId}`, { method: "PATCH", body: JSON.stringify(data) });
export const deleteHourlyShift = (shiftId: string) =>
  apiFetch<void>(`/hourly-shifts/${shiftId}`, { method: "DELETE" });
export const getHourlyShiftsHistory = () => apiFetch<HourlyShift[]>("/hourly-shifts");

// ─── Bank Transactions ────────────────────────────────────────────────────────

export interface BankTransaction {
  id: string;
  type: "ingreso" | "egreso";
  medium?: "cash" | "bank";
  amount: number;
  description: string;
  reference?: string;
  driverId?: string;
  driverName?: string;
  createdByName?: string | null;
  deviceName?: string | null; // PC desde el que se registró
  groupId?: string | null;
  pairId?: string | null;
  noCounterpart?: boolean;
  date: string;
  createdAt: string;
}

// ─── Reporte mensual ──────────────────────────────────────────────────────────
export interface MonthlyReport {
  debtReconciliation: { total: number; basesCurrentMonth: number; basesPrevious: number; basesAllTime: number; commission: number; credit?: number };
  month: string;
  totalSales: number;
  /** NEW03: desglose de las ventas (comisión de domicilios + ganancia de clientes por hora). */
  sales?: { orders: number; hourly: number };
  expenses: { cash: number; bank: number; total: number };
  payroll: { cash: number; bank: number; total: number };
  bases: { previous?: number; given: number; returned: number; diff: number; ok: boolean; pendingDrivers: { id: string; name: string; pendingDebt: number }[] };
  commission: { pending: number; credit?: number; ok: boolean; pendingDrivers: { id: string; name: string; pendingDebt: number }[]; frozen?: boolean };
  transfers: { ingresos: number; egresos: number; diff: number; ok: boolean; pendingItems?: { id: string; name: string; pendingDebt: number }[] };
  clientDebt: { generated: number; paid: number; balance: number; normal: number; hourly: number; ok: boolean; pendingClients: { id: string; name: string; pendingDebt: number }[] };
  netProfit: number;
  profitability: number;
}
export const getMonthlyReport = (month: string, branchId?: string) =>
  apiFetch<MonthlyReport>(`/sd/report/${month}${branchId ? `?branchId=${branchId}` : ""}`);

export interface MonthCloseProjection {
  month: string;
  targetCash: number;
  targetBank: number;
  targetCapital: number;
  pending: {
    basesDiff: number;
    transferDiff: number;
    commissionPending: number;
    totalDiffs: number;
    clientDebts: number;
    clientDebtsNormal: number;
    clientDebtsHourly: number;
    cashShortfall: number;
    bankShortfall: number;
    total: number;
  };
  physicalCash: number;
  physicalBank: number;
  physicalToLeave: number;
  explanation: string;
}
export const getMonthCloseProjection = (month: string, targetCash: number, targetBank: number, branchId?: string) =>
  apiFetch<MonthCloseProjection>(`/sd/projection/${month}?targetCash=${targetCash}&targetBank=${targetBank}${branchId ? `&branchId=${branchId}` : ""}`);

// ─── Aprobación de gastos ─────────────────────────────────────────────────────
export interface PendingMovement {
  id: string; date: string; time: string; category: number; amount: number;
  medium: "cash" | "bank"; description?: string; createdBy?: string;
  worker?: { name: string }; createdAt: string;
}
export const getPendingMovements = () => apiFetch<PendingMovement[]>("/movements/pending");
export const approveMovement = (id: string) => apiFetch(`/movements/${id}/approve`, { method: "POST" });
export const rejectMovement = (id: string) => apiFetch(`/movements/${id}/reject`, { method: "POST" });

export interface BankSummary {
  ingresos: number;
  egresos: number;
  balance: number;
  count: number;
}

export const getBankTransactions = (params?: { type?: string; from?: string; to?: string }) => {
  const q = new URLSearchParams(Object.entries(params ?? {}).filter(([, v]) => v) as [string, string][]);
  return apiFetch<BankTransaction[]>(`/bank-transactions${q.toString() ? "?" + q : ""}`);
};
export const getBankSummary = (from?: string, to?: string) => {
  const q = new URLSearchParams(Object.entries({ from, to }).filter(([, v]) => v) as [string, string][]);
  return apiFetch<BankSummary>(`/bank-transactions/summary${q.toString() ? "?" + q : ""}`);
};
export const createBankTransaction = (
  data: Omit<BankTransaction, "id" | "createdAt"> & { cashAmount?: number; bankAmount?: number; pairWith?: string },
) =>
  apiFetch<BankTransaction>("/bank-transactions", { method: "POST", body: JSON.stringify(data) });
export const deleteBankTransaction = (id: string) =>
  apiFetch<void>(`/bank-transactions/${id}`, { method: "DELETE" });

// ─── Shift Closes ─────────────────────────────────────────────────────────────

export interface ShiftClose {
  id: string;
  date: string;
  shift: "AM" | "PM" | "close";
  receivedBy?: string;
  handedBy?: string;
  denominations: { bills: { value: number; qty: number }[]; coins: { value: number; qty: number }[] };
  totalCounted: number;
  totalExpected: number;
  difference: number;
  // Conciliación de banco (null en turnos donde no se verificó banco)
  bankCounted?: number | null;
  bankExpected?: number | null;
  bankDifference?: number | null;
  notes?: string;
  createdByName?: string | null;
  closedAt: string;
}

export const getShifts = (params?: { from?: string; to?: string }) => {
  const q = new URLSearchParams(Object.entries(params ?? {}).filter(([, v]) => v) as [string, string][]);
  return apiFetch<ShiftClose[]>(`/shifts${q.toString() ? "?" + q : ""}`);
};
export const getShiftsForDate = (date: string) => apiFetch<ShiftClose[]>(`/shifts/${date}`);

export interface DaySummary {
  date: string;
  /** false = día sin ninguna actividad (movimientos/cierre/pedidos/deudas): se muestra vacío. */
  hasActivity: boolean;
  initialCash: number;
  initialBank: number;
  initialTotal: number;
  ingresos: number;
  egresos: number;
  comision: number;
  /** NEW03: ganancia de la empresa en turnos por hora del día (ya incluida en netProfit). */
  gananciaPorHora?: number;
  deudasGeneradas: number;
  deudasCobradas: number;
  finalCash: number;
  finalBank: number;
  finalTotal: number;
  netProfit: number;
  hasClose: boolean;
  cajaCuadrada: boolean;
  /** D7: conteo ORIGINAL del Cierre y correcciones aprobadas después. */
  close?: {
    totalCounted: number; totalExpected: number; difference: number;
    bankCounted: number | null; bankExpected: number | null; bankDifference: number | null;
    closedAt: string; corrections: ShiftCorrection[];
  } | null;
}
/** Resumen detallado de un día (Historial): junta Caja, Banco, domiciliarios, bases y deudas. */
export const getDaySummary = (date: string) => apiFetch<DaySummary>(`/days/${date}/summary`);
/** Resúmenes de un rango de días (calendario/tabla del Historial), con saldos reales por día. */
export const getDaySummaries = (from: string, to: string) =>
  apiFetch<DaySummary[]>(`/days/summaries?from=${from}&to=${to}`);
/** Día operativo actual: no avanza al siguiente hasta que se registre el Cierre del día. */
export const getCurrentOperatingDate = () => apiFetch<{ date: string }>(`/shifts/current-date`);
export const deleteShift = (id: string) => apiFetch<void>(`/shifts/${id}`, { method: "DELETE" });

/** #6 — efectivo y banco esperados calculados automáticamente para la fecha. */
export const getExpectedForDate = (date: string) =>
  apiFetch<{ date: string; expectedCash: number; expectedBank: number }>(`/shifts/${date}/expected`);
export const registerShift = (data: {
  date: string;
  shift: "AM" | "PM" | "close";
  receivedBy?: string;
  handedBy?: string;
  denominations: ShiftClose["denominations"];
  expectedAmount: number;
  // Saldo real del banco que ingresa el operador (para conciliar banco). Opcional.
  bankCounted?: number | null;
  notes?: string;
}) => apiFetch<ShiftClose>("/shifts", { method: "POST", body: JSON.stringify(data) });

// ─── D7: correcciones de días cerrados ───────────────────────────────────────
export interface ShiftCorrection {
  requestId: string; requestType: string; entityType: string; entityId: string; description: string;
  cashDelta: number; bankDelta: number; approvedBy: string; approvedByName: string | null; approvedAt: string;
}
