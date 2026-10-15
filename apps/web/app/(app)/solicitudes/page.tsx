"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth";
import { Check, X, Clock, FileEdit, RefreshCw, Trash2, History } from "lucide-react";
import { toast } from "sonner";
import * as api from "@/lib/sd-api";
import type { EditRequest } from "@/lib/sd-api";
import { useLive } from "@/lib/use-live";

function formatVal(field: string, v: string) {
  // Si parece dinero (campos de valor/monto), formatear
  const moneyFields = ["deliveryValue", "amount", "companyAmount", "paidAmount"];
  if (moneyFields.includes(field)) {
    const n = parseInt(v.replace(/\D/g, "") || "0");
    return "$" + n.toLocaleString("es-CO");
  }
  return v;
}

const ENTITY_LABELS: Record<string, string> = {
  ShipdayOrder: "Pedido",
  Movement: "Movimiento",
  BankTransaction: "Transacción bancaria",
  DriverPayment: "Pago a domiciliario",
  BaseTransaction: "Base",
  ClientDebt: "Deuda de cliente",
  Conversion: "Conversión",
  HourlyShift: "Turno por hora",
};

// Nombres legibles de campos en las solicitudes de edición (si no está, se usa la clave).
const FIELD_LABELS: Record<string, string> = {
  deliveryValue: "Valor del domicilio",
  amount: "Valor",
  startTime: "Hora entrada",
  endTime: "Hora salida",
  date: "Fecha",
  driverName: "Domiciliario",
  confirmOvernight: "Turno que cruza medianoche",
};

export default function SolicitudesPage() {
  const { user } = useAuth();
  const router = useRouter();
  // "pending" = solicitudes por revisar · "history" = historial de aprobadas + rechazadas
  const [view, setView] = useState<"pending" | "history">("pending");
  // Filtro dentro del historial (solo visualización)
  const [histFilter, setHistFilter] = useState<"all" | "approved" | "rejected">("all");
  const [requests, setRequests] = useState<EditRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [reviewing, setReviewing] = useState<string | null>(null);
  const [rejectNotes, setRejectNotes] = useState<Record<string, string>>({});

  useEffect(() => {
    if (user && user.role !== "admin") router.replace("/shipday");
  }, [user, router]);

  const load = async (silent = false) => {
    // Solo el admin consulta solicitudes (el operador es redirigido): evita un 403 y un aviso de error.
    if (user?.role !== "admin") return;
    if (!silent) setLoading(true);
    try {
      let data: EditRequest[];
      if (view === "pending") {
        data = await api.getEditRequests("pending");
      } else {
        // Historial: todo lo ya revisado (aprobado o rechazado), más reciente primero
        const all = await api.getEditRequests();
        data = all.filter(r => r.status !== "pending");
      }
      setRequests(prev => JSON.stringify(prev) === JSON.stringify(data) ? prev : data);
    } catch { if (!silent) toast.error("Error al cargar solicitudes"); }
    if (!silent) setLoading(false);
  };

  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [view, user?.role]);
  useLive(() => load(true), 5000);

  // Lista visible: en historial aplica el filtro aprobadas/rechazadas
  const visible = view === "history" && histFilter !== "all"
    ? requests.filter(r => r.status === histFilter)
    : requests;

  async function review(id: string, action: "approved" | "rejected") {
    setReviewing(id);
    try {
      await api.reviewEditRequest(id, action, rejectNotes[id] || undefined);
      toast.success(action === "approved" ? "✅ Cambio aprobado y aplicado" : "Solicitud rechazada");
      load();
    } catch (err) { toast.error(String(err)); }
    setReviewing(null);
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-black">📨 Solicitudes de cambio</h1>
          <p className="text-sm text-muted-foreground">Aprueba o rechaza cambios solicitados por el personal administrativo</p>
        </div>
        <button onClick={() => load()} className="flex items-center gap-2 px-3 py-2 border border-border rounded-xl text-sm hover:bg-secondary transition">
          <RefreshCw className="h-4 w-4" /> Actualizar
        </button>
      </div>

      {/* Vista: Pendientes vs Historial movimientos */}
      <div className="flex gap-1 p-1 bg-secondary/50 rounded-2xl w-fit">
        <button onClick={() => setView("pending")}
          className={`flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-bold transition ${view === "pending" ? "bg-background shadow text-foreground" : "text-muted-foreground hover:text-foreground"}`}>
          <Clock className="h-4 w-4" /> Pendientes
        </button>
        <button onClick={() => setView("history")}
          className={`flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-bold transition ${view === "history" ? "bg-background shadow text-foreground" : "text-muted-foreground hover:text-foreground"}`}>
          <History className="h-4 w-4" /> Historial movimientos
        </button>
      </div>

      {/* Filtro dentro del historial (aprobadas / rechazadas) */}
      {view === "history" && (
        <div className="flex gap-1 flex-wrap">
          {([["all", "Todas"], ["approved", "Aprobadas"], ["rejected", "Rechazadas"]] as const).map(([k, label]) => (
            <button key={k} onClick={() => setHistFilter(k)}
              className={`px-3 py-1.5 rounded-full text-xs font-bold transition border ${histFilter === k ? "bg-primary/10 border-primary/30 text-primary" : "border-border text-muted-foreground hover:text-foreground"}`}>
              {label}
            </button>
          ))}
        </div>
      )}

      {loading ? (
        <div className="text-center py-16 text-muted-foreground">Cargando…</div>
      ) : visible.length === 0 ? (
        <div className="glass-strong rounded-3xl p-12 text-center">
          <FileEdit className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
          <p className="font-bold text-lg">
            {view === "pending"
              ? "Sin solicitudes pendientes"
              : histFilter === "approved"
                ? "Sin movimientos aprobados"
                : histFilter === "rejected"
                  ? "Sin movimientos rechazados"
                  : "Sin movimientos en el historial"}
          </p>
          <p className="text-sm text-muted-foreground mt-1">
            {view === "pending"
              ? "Cuando el personal pida un cambio, aparecerá aquí."
              : "Aquí quedan registrados los cambios aprobados y rechazados."}
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {visible.map(r => (
            <div key={r.id} className="glass-strong rounded-3xl p-5 space-y-4">
              {/* Header */}
              <div className="flex items-start justify-between gap-3 flex-wrap">
                <div>
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-xs px-2 py-0.5 rounded-full bg-primary/10 text-primary font-bold">
                      {ENTITY_LABELS[r.entityType] ?? r.entityType}
                    </span>
                    {r.requestType === "delete" && (
                      <span className="text-xs px-2 py-0.5 rounded-full bg-red-500/15 text-red-600 font-bold flex items-center gap-1">
                        <Trash2 className="h-3 w-3" /> Eliminar
                      </span>
                    )}
                    {r.requestType === "create" && (
                      <span className="text-xs px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-700 font-bold">
                        Agregar a día cerrado
                      </span>
                    )}
                    <h3 className="font-bold">{r.entityLabel}</h3>
                  </div>
                  <p className="text-xs text-muted-foreground mt-1">
                    Solicitado por <strong>{r.requester?.name ?? "—"}</strong> · {new Date(r.createdAt).toLocaleString("es-CO", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}
                  </p>
                </div>
                {r.status === "pending" ? (
                  <span className="flex items-center gap-1 text-xs font-bold text-amber-600 bg-amber-500/10 px-2 py-1 rounded-full">
                    <Clock className="h-3 w-3" /> Pendiente
                  </span>
                ) : r.status === "approved" ? (
                  <span className="flex items-center gap-1 text-xs font-bold text-green-600 bg-green-500/10 px-2 py-1 rounded-full">
                    <Check className="h-3 w-3" /> Aprobada
                  </span>
                ) : (
                  <span className="flex items-center gap-1 text-xs font-bold text-red-500 bg-red-500/10 px-2 py-1 rounded-full">
                    <X className="h-3 w-3" /> Rechazada
                  </span>
                )}
              </div>

              {/* Eliminación o cambios */}
              {r.requestType === "create" ? (
                <div className="glass rounded-2xl p-4 border border-emerald-500/20 bg-emerald-500/5 space-y-1 text-sm">
                  {(() => {
                    const c = r.changes as unknown as { date: string; type: string; medium: string; amount: number; description: string; category?: number };
                    return (
                      <>
                        <div className="font-bold text-emerald-700">Agregar al día cerrado {c.date}</div>
                        <div>{c.type === "ingreso" ? "Ingreso" : "Egreso"} · {c.medium === "cash" ? "💵 Efectivo" : "🏦 Banco"} · <strong className="tnum">${Number(c.amount).toLocaleString("es-CO")}</strong></div>
                        <div className="text-muted-foreground">{c.description}{c.category != null ? ` · categoría ${c.category}` : ""}</div>
                        <div className="text-xs text-muted-foreground">Al aprobar, se registra con la fecha de ese día y su Cierre conserva el conteo original y muestra la corrección.</div>
                      </>
                    );
                  })()}
                </div>
              ) : r.requestType === "delete" ? (
                <div className="glass rounded-2xl p-4 border border-red-500/20 bg-red-500/5 flex items-center gap-3">
                  <Trash2 className="h-5 w-5 text-red-500 shrink-0" />
                  <span className="text-sm font-medium text-red-600 dark:text-red-400">
                    Se solicita ELIMINAR este movimiento. Al aprobar, se borra y se ajustan deudas/saldos.
                  </span>
                </div>
              ) : (
              <div className="glass rounded-2xl p-4 space-y-2">
                <div className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Cambios solicitados</div>
                {Object.entries(r.changes).filter(([field]) => !field.endsWith("Id")).map(([field, ch]) => field === "confirmOvernight" ? (
                  <div key={field} className="text-xs rounded-lg bg-amber-500/10 text-amber-700 dark:text-amber-400 px-2 py-1">
                    🌙 Quien solicitó confirmó que el turno termina al día siguiente.
                  </div>
                ) : (
                  <div key={field} className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground capitalize">{FIELD_LABELS[field] ?? field}</span>
                    <span className="flex items-center gap-2">
                      <span className="line-through text-red-400">{formatVal(field, ch.old)}</span>
                      <span className="text-muted-foreground">→</span>
                      <span className="font-bold text-green-600">{formatVal(field, ch.new)}</span>
                    </span>
                  </div>
                ))}
              </div>
              )}

              {/* Motivo */}
              <div>
                <div className="text-xs font-bold uppercase tracking-wider text-muted-foreground mb-1">Motivo</div>
                <p className="text-sm">{r.reason}</p>
              </div>

              {/* Notas de revisión (si ya fue revisada) */}
              {r.status !== "pending" && r.reviewNotes && (
                <div className="text-xs text-muted-foreground border-t border-border pt-2">
                  Nota del admin: {r.reviewNotes}
                </div>
              )}
              {r.status !== "pending" && r.reviewer && (
                <div className="text-xs text-muted-foreground">
                  Revisado por {r.reviewer.name} · {r.reviewedAt ? new Date(r.reviewedAt).toLocaleString("es-CO", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : ""}
                </div>
              )}

              {/* Acciones (solo pendientes) */}
              {r.status === "pending" && (
                <div className="space-y-2 border-t border-border pt-3">
                  <input
                    value={rejectNotes[r.id] ?? ""}
                    onChange={e => setRejectNotes(p => ({ ...p, [r.id]: e.target.value }))}
                    placeholder="Nota opcional (visible al solicitante)"
                    className="w-full glass rounded-xl px-3 py-2 text-sm outline-none"
                  />
                  <div className="flex gap-2">
                    <button
                      disabled={reviewing === r.id}
                      onClick={() => review(r.id, "rejected")}
                      className="flex-1 flex items-center justify-center gap-2 py-3 rounded-xl border-2 border-red-500/30 text-red-500 font-bold hover:bg-red-500/10 transition disabled:opacity-50"
                    >
                      <X className="h-4 w-4" /> Rechazar
                    </button>
                    <button
                      disabled={reviewing === r.id}
                      onClick={() => review(r.id, "approved")}
                      className={`flex-1 flex items-center justify-center gap-2 py-3 rounded-xl text-white font-bold transition disabled:opacity-50 ${r.requestType === "delete" ? "bg-red-600 hover:bg-red-700" : "bg-green-600 hover:bg-green-700"}`}
                    >
                      {r.requestType === "delete" ? <Trash2 className="h-4 w-4" /> : <Check className="h-4 w-4" />}
                      {reviewing === r.id ? "Aplicando…" : r.requestType === "delete" ? "Aprobar y eliminar" : "Aprobar y aplicar"}
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
