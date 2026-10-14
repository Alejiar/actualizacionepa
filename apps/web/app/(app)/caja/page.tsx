"use client";

import { useEffect, useState } from "react";
import { Plus, CheckCircle2, AlertTriangle, Clock } from "lucide-react";
import { toast } from "sonner";
import * as api from "@/lib/sd-api";
import type { ShiftClose } from "@/lib/sd-api";
import { ShiftCloseWizard } from "@/components/wizards/ShiftCloseWizard";
import { EditRequestWizard, type EditableField } from "@/components/wizards/EditRequestWizard";
import { DeleteRequestWizard } from "@/components/wizards/DeleteRequestWizard";
import { useLive } from "@/lib/use-live";
import { useAuth } from "@/lib/auth";
import { todayBogota, shiftDate } from "@/lib/format";
import { Pencil, Trash2 } from "lucide-react";

function formatCOP(n: number) { return "$" + n.toLocaleString("es-CO"); }
// "Hoy" SIEMPRE en hora de Bogotá. Con UTC, un cierre hecho de noche se archivaba
// en el día siguiente y aparecían turnos "pendientes" que no correspondían.
function todayStr() { return todayBogota(); }

function fmtDay(date: string) {
  return new Date(date + "T12:00:00").toLocaleDateString("es-CO", { weekday: "long", day: "2-digit", month: "long" });
}

const SHIFT_LABELS = { AM: "☀️ Recibo AM", PM: "🌙 Recibo PM (verificación)", close: "🔒 Cierre" };

export default function CajaPage() {
  const [shifts, setShifts] = useState<ShiftClose[]>([]);
  const [loading, setLoading] = useState(true);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [editShift, setEditShift] = useState<ShiftClose | null>(null);
  const [deleteShiftReq, setDeleteShiftReq] = useState<ShiftClose | null>(null);
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";

  const SHIFT_NAME = (sh: string) => sh === "AM" ? "Mañana" : sh === "PM" ? "Tarde" : "Cierre";
  async function handleDeleteShift(s: ShiftClose) {
    if (!isAdmin) { setDeleteShiftReq(s); return; } // no admin → solicitud
    if (!confirm(`¿Eliminar el cierre de ${SHIFT_NAME(s.shift)}?`)) return;
    try { await api.deleteShift(s.id); toast.success("Cierre eliminado"); load(); }
    catch (err) { toast.error(String(err)); }
  }
  // Día OPERATIVO (no la fecha calendario): el sistema no avanza al día siguiente
  // hasta que se registre el Cierre del día actual. Así un cierre hecho pasada la
  // medianoche sigue encontrando el día anterior disponible para cerrarlo.
  const [today, setToday] = useState(todayStr());

  const load = async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const [data] = await Promise.all([
        api.getShifts({ from: shiftDate(todayBogota(), -30) }),
        api.getCurrentOperatingDate().then(r => setToday(r.date)).catch(() => {}),
      ]);
      setShifts(prev => JSON.stringify(prev) === JSON.stringify(data) ? prev : data);
    } catch { if (!silent) toast.error("Error al cargar cierres de caja"); }
    if (!silent) setLoading(false);
  };

  useEffect(() => { load(); }, []);
  useLive(() => load(true), 6000);

  const todayShifts = shifts.filter(s => s.date === today);
  const registeredSlots = new Set(todayShifts.map(s => s.shift));
  const pendingSlots = (["AM", "PM", "close"] as const).filter(s => !registeredSlots.has(s));
  const allDone = pendingSlots.length === 0;
  // Un turno está descuadrado si falla el efectivo O el banco (cuando se verificó).
  const shiftOff = (s: ShiftClose) => s.difference !== 0 || (s.bankDifference != null && s.bankDifference !== 0);
  const hasDiscrepancy = todayShifts.some(shiftOff);

  const groupedByDate = shifts.reduce((acc, s) => {
    if (!acc[s.date]) acc[s.date] = [];
    acc[s.date].push(s);
    return acc;
  }, {} as Record<string, ShiftClose[]>);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-black">Caja</h1>
          <p className="text-sm text-muted-foreground">Recibo AM y Recibo PM (el PM verifica lo que dejó el AM)</p>
        </div>
        <button
          onClick={() => setWizardOpen(true)}
          className="flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-xl font-bold hover:opacity-90 transition"
        >
          <Plus className="h-4 w-4" /> Registrar cierre de turno
        </button>
      </div>

      {/* Estado del día actual */}
      <div className={`glass-strong rounded-3xl p-5 border-2 ${allDone && !hasDiscrepancy ? "border-green-500/30" : hasDiscrepancy ? "border-amber-500/30" : "border-border"}`}>
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-bold">Estado de hoy — {fmtDay(today)}</h2>
          {allDone ? (
            hasDiscrepancy
              ? <span className="text-xs px-2.5 py-1 rounded-full bg-amber-500/10 text-amber-600 font-bold">⚠️ Hay descuadres</span>
              : <span className="text-xs px-2.5 py-1 rounded-full bg-green-500/10 text-green-600 font-bold">✅ Todo cuadrado</span>
          ) : (
            <span className="text-xs px-2.5 py-1 rounded-full bg-secondary text-muted-foreground font-medium">⏳ {pendingSlots.length} pendiente(s)</span>
          )}
        </div>

        <div className="grid grid-cols-3 gap-3">
          {(["AM", "PM", "close"] as const).map(slot => {
            const s = todayShifts.find(t => t.shift === slot);
            const isVerif = slot === "PM";
            return (
              <div
                key={slot}
                className={`rounded-2xl p-4 text-center cursor-pointer transition hover:opacity-80 ${
                  s
                    ? !shiftOff(s)
                      ? "bg-green-500/10 border border-green-500/20"
                      : "bg-red-500/10 border border-red-500/30"
                    : "bg-secondary/40 border border-dashed border-border"
                }`}
                onClick={!s ? () => setWizardOpen(true) : undefined}
              >
                <div className="text-2xl">{slot === "AM" ? "☀️" : slot === "PM" ? "🌙" : "🔒"}</div>
                <div className="font-bold text-sm mt-1">{slot === "AM" ? "Mañana" : slot === "PM" ? "Tarde" : "Cierre"}</div>
                {s ? (
                  <>
                    <div className={`text-xs mt-1 font-bold ${s.difference === 0 ? "text-green-600" : "text-red-500"}`}>
                      {isVerif
                        ? (s.difference === 0 ? "✓ Caja completa" : "⚠️ Rectificar caja")
                        : (s.difference === 0 ? "✓ Efectivo" : `💵 ${s.difference > 0 ? "+" : ""}${formatCOP(s.difference)}`)}
                    </div>
                    {s.bankDifference != null && (
                      <div className={`text-xs font-bold ${s.bankDifference === 0 ? "text-green-600" : "text-red-500"}`}>
                        {s.bankDifference === 0 ? "✓ Banco" : `🏦 ${s.bankDifference > 0 ? "+" : ""}${formatCOP(s.bankDifference)}`}
                      </div>
                    )}
                    <div className="text-xs text-muted-foreground mt-0.5 font-bold tnum">{formatCOP(s.totalCounted)}</div>
                    {s.createdByName && <div className="text-[10px] text-muted-foreground truncate mt-0.5">por {s.createdByName}</div>}
                    {isVerif && s.handedBy && <div className="text-[10px] text-muted-foreground truncate">verifica a {s.handedBy}</div>}
                  </>
                ) : (
                  <div className="text-xs text-muted-foreground/70 mt-1">
                    {isVerif ? "Verificar la mañana · clic" : "Pendiente · clic"}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {pendingSlots.length > 0 && (
          <button
            onClick={() => setWizardOpen(true)}
            className="mt-4 w-full py-3 bg-primary/10 text-primary rounded-xl text-sm font-bold hover:bg-primary/20 transition flex items-center justify-center gap-2"
          >
            <Clock className="h-4 w-4" />
            Registrar {pendingSlots.map(s => s === "AM" ? "Mañana" : s === "PM" ? "Tarde" : "Cierre").join(" · ")}
          </button>
        )}
      </div>

      {/* Historial */}
      {loading ? (
        <div className="text-center py-10 text-muted-foreground">Cargando…</div>
      ) : (
        <div className="space-y-4">
          <h2 className="font-bold text-lg">Historial de cierres</h2>
          {Object.entries(groupedByDate)
            .sort(([a], [b]) => b.localeCompare(a))
            .slice(0, 15)
            .map(([date, dayShifts]) => (
              <div key={date} className="glass-strong rounded-3xl p-5">
                <h3 className="font-bold text-sm text-muted-foreground mb-3 capitalize">{fmtDay(date)}</h3>
                <div className="space-y-2">
                  {dayShifts.map(s => (
                    <div key={s.id} className="flex items-center justify-between p-3 rounded-xl bg-secondary/30">
                      <div className="flex items-center gap-3">
                        {!shiftOff(s)
                          ? <CheckCircle2 className="h-4 w-4 text-green-600" />
                          : <AlertTriangle className="h-4 w-4 text-amber-500" />}
                        <div>
                          <p className="font-medium text-sm">{SHIFT_LABELS[s.shift]}</p>
                          <p className="text-xs text-muted-foreground">
                            {s.receivedBy && `Recibe: ${s.receivedBy}`}
                            {s.handedBy && ` · Entrega: ${s.handedBy}`}
                            {s.createdByName && ` · Registró: ${s.createdByName}`}
                          </p>
                        </div>
                      </div>
                      <div className="flex items-center gap-3">
                        <div className="text-right">
                          <p className="font-bold tnum">{formatCOP(s.totalCounted)}</p>
                          {s.difference !== 0 && (
                            <p className={`text-xs font-bold ${s.difference > 0 ? "text-green-600" : "text-red-500"}`}>
                              💵 {s.difference > 0 ? "+" : ""}{formatCOP(s.difference)}
                            </p>
                          )}
                          {s.bankDifference != null && s.bankDifference !== 0 && (
                            <p className={`text-xs font-bold ${s.bankDifference > 0 ? "text-green-600" : "text-red-500"}`}>
                              🏦 {s.bankDifference > 0 ? "+" : ""}{formatCOP(s.bankDifference)}
                            </p>
                          )}
                          {!shiftOff(s) && <p className="text-xs text-green-600">cuadrado</p>}
                        </div>
                        <button
                          onClick={() => setEditShift(s)}
                          title={isAdmin ? "Editar cierre" : "Solicitar edición (requiere aprobación del administrador)"}
                          className="p-2 rounded-lg hover:bg-secondary transition text-muted-foreground hover:text-foreground"
                        >
                          <Pencil className="h-4 w-4" />
                        </button>
                        <button
                          onClick={() => handleDeleteShift(s)}
                          title={isAdmin ? "Eliminar cierre" : "Solicitar eliminación (requiere aprobación del administrador)"}
                          className="p-2 rounded-lg hover:bg-red-500/10 transition text-muted-foreground hover:text-red-500"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
        </div>
      )}

      <ShiftCloseWizard
        open={wizardOpen}
        onOpenChange={setWizardOpen}
        date={today}
        onDone={load}
      />

      {/* #2 — Solicitud de edición de cierre (requiere aprobación del admin) */}
      {editShift && (
        <EditRequestWizard
          open={!!editShift}
          onOpenChange={(v) => { if (!v) setEditShift(null); }}
          entityType="ShiftClose"
          entityId={editShift.id}
          entityLabel={`${SHIFT_LABELS[editShift.shift]} — ${fmtDay(editShift.date)}`}
          fields={[
            { field: "totalCounted", label: "Total contado", currentValue: String(editShift.totalCounted), type: "money" },
            { field: "totalExpected", label: "Monto esperado", currentValue: String(editShift.totalExpected), type: "money" },
            { field: "receivedBy", label: "Recibe", currentValue: editShift.receivedBy ?? "", type: "text" },
            { field: "handedBy", label: "Entrega", currentValue: editShift.handedBy ?? "", type: "text" },
            { field: "notes", label: "Observaciones", currentValue: editShift.notes ?? "", type: "text" },
          ] satisfies EditableField[]}
          onDone={load}
        />
      )}

      {/* No admin: solicitud de eliminación de cierre de turno */}
      {deleteShiftReq && (
        <DeleteRequestWizard
          open={!!deleteShiftReq}
          onOpenChange={(v) => { if (!v) setDeleteShiftReq(null); }}
          entityType="ShiftClose"
          entityId={deleteShiftReq.id}
          entityLabel={`${SHIFT_LABELS[deleteShiftReq.shift]} — ${fmtDay(deleteShiftReq.date)}`}
          onDone={load}
        />
      )}
    </div>
  );
}
