"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { toast } from "sonner";
import type {
  Arqueo,
  CommissionRow,
  DayData,
  Movement,
  MovementStatus,
  PayrollPayment,
  Settings,
  Worker,
} from "@cash-buddy/shared";
import { api, ApiError } from "./api";
import { useAuth } from "./auth";

// Re-exporta tipos y cálculo compartido para compatibilidad con el código portado.
export type {
  Role,
  Worker,
  Movement,
  Arqueo,
  DayData,
  Settings,
  CategoryCode,
  Medium,
  MovementType,
  MovementStatus,
  CourierStatus,
  DeliveryEntry,
  CommissionRow,
} from "@cash-buddy/shared";
export { dayBalances, courierStatusForDay, deliveriesForDay, CATEGORY_LABEL } from "@cash-buddy/shared";

export interface AppState {
  settings: Settings;
  workers: Worker[];
  days: Record<string, DayData>;
}

const DEFAULT_SETTINGS: Settings = {
  companyName: "Epa",
  initialCash: 300000,
  initialBank: 103130,
  setupComplete: false,
  commissionPercent: 0,
};

interface Ctx {
  state: AppState;
  loading: boolean;
  getDay: (date: string) => DayData;
  ensureDay: (date: string) => Promise<void>;
  addMovement: (
    date: string,
    m: Omit<Movement, "id" | "date" | "time" | "status"> & { status?: MovementStatus; time?: string },
  ) => Promise<Movement>;
  updateMovement: (date: string, id: string, patch: Partial<Movement>) => Promise<void>;
  deleteMovement: (date: string, id: string) => Promise<void>;
  refreshDay: (date: string) => Promise<void>;
  /** true si el servidor aceptó el cambio (el error ya se mostró como aviso). */
  addWorker: (w: Omit<Worker, "id" | "color"> & { color?: string }) => Promise<boolean>;
  updateWorker: (id: string, patch: Partial<Worker>) => Promise<boolean>;
  removeWorker: (id: string) => Promise<boolean>;
  updateSettings: (patch: Partial<Settings>) => Promise<void>;
  setArqueo: (date: string, slot: "AM" | "PM" | "close", arqueo: Arqueo) => Promise<void>;
  resetAll: () => Promise<void>;
}

const StoreCtx = createContext<Ctx | null>(null);

export function StoreProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [state, setState] = useState<AppState>({
    settings: DEFAULT_SETTINGS,
    workers: [],
    days: {},
  });
  const [loading, setLoading] = useState(true);
  const loadedRef = useRef(false);

  const reloadAll = useCallback(async () => {
    const [settings, workers, days] = await Promise.all([
      api<Settings>("/settings"),
      api<Worker[]>("/workers"),
      api<DayData[]>("/days"),
    ]);
    const daysMap: Record<string, DayData> = {};
    for (const d of days) daysMap[d.date] = d;
    setState({ settings, workers, days: daysMap });
  }, []);

  useEffect(() => {
    if (!user) {
      setLoading(false);
      loadedRef.current = false;
      return;
    }
    if (loadedRef.current) return;
    loadedRef.current = true;
    setLoading(true);
    reloadAll()
      // Un 403 al arrancar = equipo pendiente/bloqueado; lo maneja DeviceGate con su pantalla.
      // No mostramos toast rojo encima de "esperando autorización".
      .catch((e) => { if (!(e instanceof ApiError && e.status === 403)) toast.error(e?.message ?? "Error al cargar datos"); })
      .finally(() => setLoading(false));
  }, [user, reloadAll]);

  // Refresco en vivo silencioso: antes este estado se cargaba una sola vez al
  // montar y nunca se volvía a pedir, así que dos sesiones (ej. un PC local y
  // otro remoto por Tailscale) veían snapshots distintos del mismo backend.
  // Mismo patrón que ya usan pedidos/banco/dashboard (poll cada pocos segundos).
  useEffect(() => {
    if (!user) return;
    const tick = () => {
      if (typeof document === "undefined" || document.visibilityState === "visible") {
        reloadAll().catch(() => {});
      }
    };
    const id = setInterval(tick, 8000);
    document.addEventListener("visibilitychange", tick);
    return () => { clearInterval(id); document.removeEventListener("visibilitychange", tick); };
  }, [user, reloadAll]);

  const refreshDay = useCallback(async (date: string) => {
    const day = await api<DayData>(`/days/${date}`);
    setState((s) => ({ ...s, days: { ...s.days, [date]: day } }));
  }, []);

  const getDay = useCallback(
    (date: string): DayData =>
      state.days[date] ?? {
        date,
        initialCash: state.settings.initialCash,
        initialBank: state.settings.initialBank,
        movements: [],
      },
    [state.days, state.settings],
  );

  const ensureDay = useCallback(
    async (date: string) => {
      if (state.days[date]) return;
      await refreshDay(date);
    },
    [state.days, refreshDay],
  );

  const addMovement: Ctx["addMovement"] = useCallback(
    async (date, m) => {
      try {
        const created = await api<Movement>("/movements", {
          method: "POST",
          body: { ...m, date },
        });
        await refreshDay(date);
        return created;
      } catch (e) {
        toast.error((e as Error)?.message ?? "Error al crear movimiento");
        throw e;
      }
    },
    [refreshDay],
  );

  const updateMovement: Ctx["updateMovement"] = useCallback(
    async (date, id, patch) => {
      try {
        await api(`/movements/${id}`, { method: "PATCH", body: patch });
        await refreshDay(date);
      } catch (e) {
        toast.error((e as Error)?.message ?? "Error al actualizar movimiento");
        throw e;
      }
    },
    [refreshDay],
  );

  const deleteMovement: Ctx["deleteMovement"] = useCallback(
    async (date, id) => {
      try {
        await api(`/movements/${id}`, { method: "DELETE" });
        await refreshDay(date);
      } catch (e) {
        toast.error((e as Error)?.message ?? "Error al eliminar movimiento");
        throw e;
      }
    },
    [refreshDay],
  );

  const refreshWorkers = useCallback(async () => {
    const workers = await api<Worker[]>("/workers");
    setState((s) => ({ ...s, workers }));
  }, []);

  const addWorker: Ctx["addWorker"] = useCallback(
    async (w) => {
      try {
        await api("/workers", { method: "POST", body: w });
        await refreshWorkers();
        return true;
      } catch (e) {
        toast.error((e as Error)?.message ?? "Error al crear trabajador");
        return false;
      }
    },
    [refreshWorkers],
  );

  const updateWorker: Ctx["updateWorker"] = useCallback(
    async (id, patch) => {
      try {
        await api(`/workers/${id}`, { method: "PATCH", body: patch });
        await refreshWorkers();
        return true;
      } catch (e) {
        toast.error((e as Error)?.message ?? "Error al actualizar trabajador");
        return false;
      }
    },
    [refreshWorkers],
  );

  const removeWorker: Ctx["removeWorker"] = useCallback(
    async (id) => {
      try {
        await api(`/workers/${id}`, { method: "DELETE" });
        await refreshWorkers();
        return true;
      } catch (e) {
        toast.error((e as Error)?.message ?? "Error al eliminar trabajador");
        return false;
      }
    },
    [refreshWorkers],
  );

  // Propaga el error: quien llama decide qué mostrar. Antes se capturaba aquí y la promesa
  // se resolvía igual, así que la pantalla mostraba "guardado" aunque el servidor lo rechazara.
  const updateSettings: Ctx["updateSettings"] = useCallback(async (patch) => {
    const settings = await api<Settings>("/settings", { method: "PATCH", body: patch });
    setState((s) => ({ ...s, settings }));
  }, []);

  const setArqueo: Ctx["setArqueo"] = useCallback(
    async (date, slot, arqueo) => {
      try {
        const day = await api<DayData>(`/days/${date}/arqueo`, {
          method: "PUT",
          body: { slot, arqueo },
        });
        setState((s) => ({ ...s, days: { ...s.days, [date]: day } }));
      } catch (e) {
        toast.error((e as Error)?.message ?? "Error al guardar arqueo");
      }
    },
    [],
  );

  // También propaga el error (antes la pantalla anunciaba "Todo borrado" aunque fallara).
  const resetAll: Ctx["resetAll"] = useCallback(async () => {
    await api("/admin/reset", { method: "POST" });
    await reloadAll();
  }, [reloadAll]);

  const value = useMemo<Ctx>(
    () => ({
      state,
      loading,
      getDay,
      ensureDay,
      addMovement,
      updateMovement,
      deleteMovement,
      refreshDay,
      addWorker,
      updateWorker,
      removeWorker,
      updateSettings,
      setArqueo,
      resetAll,
    }),
    [state, loading, getDay, ensureDay, addMovement, updateMovement, deleteMovement, refreshDay, addWorker, updateWorker, removeWorker, updateSettings, setArqueo, resetAll],
  );

  return <StoreCtx.Provider value={value}>{children}</StoreCtx.Provider>;
}

export function useStore() {
  const ctx = useContext(StoreCtx);
  if (!ctx) throw new Error("useStore must be used inside StoreProvider");
  return ctx;
}

// ====== Helpers derivados que operan sobre el estado cargado ======
// (Reflejan exactamente la lógica del backend, porque los datos provienen de él.)

export function commissionsForWorker(
  state: AppState,
  workerId: string,
  monthPrefix?: string,
): CommissionRow[] {
  const out: CommissionRow[] = [];
  for (const date of Object.keys(state.days)) {
    if (monthPrefix && !date.startsWith(monthPrefix)) continue;
    for (const m of state.days[date].movements) {
      if (m.kind === "commission" && m.workerId === workerId) {
        out.push({
          id: m.id,
          date,
          deliveryValue: m.deliveryValue ?? 0,
          commission: m.amount,
          status: m.status,
          medium: m.medium,
        });
      }
    }
  }
  out.sort((a, b) => (a.date < b.date ? 1 : -1));
  return out;
}

export function fixedPayrollForWorker(state: AppState, workerId: string, monthPrefix: string) {
  const payments: PayrollPayment[] = [];
  let pending = 0;
  let paid = 0;
  for (const date of Object.keys(state.days)) {
    if (!date.startsWith(monthPrefix)) continue;
    for (const m of state.days[date].movements) {
      if ((m.category === 15 || m.category === 18) && m.workerId === workerId && m.kind !== "commission") {
        payments.push({ id: m.id, date, amount: m.amount, medium: m.medium, status: m.status, concept: m.description });
        if (m.status === "confirmed") paid += m.amount;
        else pending += m.amount;
      }
    }
  }
  return { payments, pending, paid };
}
