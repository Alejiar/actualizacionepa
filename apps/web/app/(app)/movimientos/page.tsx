"use client";

import { useEffect, useState } from "react";
import { formatCOP, prettyDate } from "@/lib/format";
import { Search, TrendingUp, TrendingDown, RefreshCw, Pencil, Trash2 } from "lucide-react";
import { toast } from "sonner";
import * as api from "@/lib/sd-api";
import type { UnifiedMovement } from "@/lib/sd-api";
import { EditRequestWizard, type EditableField } from "@/components/wizards/EditRequestWizard";
import { DeleteRequestWizard } from "@/components/wizards/DeleteRequestWizard";
import { useLive } from "@/lib/use-live";
import { useDay } from "@/lib/day-context";

type Filter = "all" | "ingreso" | "egreso" | "cash" | "bank";
type SourceFilter = "all" | "Caja" | "Banco" | "Domiciliarios" | "Bases" | "Clientes" | "Conversión";

const SOURCE_COLORS: Record<string, string> = {
  "Caja":          "bg-gray-500/20 text-gray-700 dark:text-gray-300",
  "Banco":         "bg-blue-500/20 text-blue-700 dark:text-blue-300",
  "Domiciliarios": "bg-purple-500/20 text-purple-700 dark:text-purple-300",
  "Bases":         "bg-amber-500/20 text-amber-700 dark:text-amber-300",
  "Clientes":      "bg-green-500/20 text-green-700 dark:text-green-300",
  "Conversión":    "bg-orange-500/20 text-orange-700 dark:text-orange-300",
};

export default function MovimientosPage() {
  const [movements, setMovements] = useState<UnifiedMovement[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<Filter>("all");
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>("all");
  const [q, setQ] = useState("");
  const [editMov, setEditMov] = useState<UnifiedMovement | null>(null);
  const [deleteMov, setDeleteMov] = useState<UnifiedMovement | null>(null);
  // Día seleccionado en el sistema (flechas de fecha de la cabecera) — igual que Pedidos.
  const { date, operatingDay } = useDay();
  const isToday = date === operatingDay;

  const load = async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const data = await api.getUnifiedMovements({ from: date, to: date });
      setMovements(data);
    } catch { if (!silent) toast.error("Error al cargar movimientos"); }
    if (!silent) setLoading(false);
  };

  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [date]);
  useLive(() => load(true), 5000);

  // Un registro puede mover efectivo y banco a la vez (base mixta, cobro dividido,
  // conversión): filtros y totales van por PARTE, para que cuadren con la caja real.
  const partsOf = (m: UnifiedMovement) => m.parts ?? [{ type: m.type, medium: m.medium, amount: m.amount }];
  const partMatches = (p: { type: string; medium: string }) =>
    (filter !== "ingreso" || p.type === "ingreso") && (filter !== "egreso" || p.type === "egreso") &&
    (filter !== "cash" || p.medium === "cash") && (filter !== "bank" || p.medium === "bank");

  const filtered = movements.filter(m => {
    if (!partsOf(m).some(partMatches)) return false;
    if (sourceFilter !== "all" && m.source !== sourceFilter) return false;
    if (q) {
      const sq = q.toLowerCase();
      if (!m.description.toLowerCase().includes(sq) &&
          !m.category.toLowerCase().includes(sq) &&
          !(m.relatedName ?? "").toLowerCase().includes(sq)) return false;
    }
    return true;
  });

  const matchedParts = filtered.flatMap(m => partsOf(m).filter(partMatches));
  const totalIngresos = matchedParts.filter(p => p.type === "ingreso").reduce((s, p) => s + p.amount, 0);
  const totalEgresos  = matchedParts.filter(p => p.type === "egreso").reduce((s, p) => s + p.amount, 0);
  const balance = totalIngresos - totalEgresos;

  const sources = [...new Set(movements.map(m => m.source))].filter(Boolean);

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-black">📋 Movimientos</h1>
          <p className="text-sm text-muted-foreground capitalize">
            {isToday ? "Hoy" : prettyDate(date)} · movimientos de dinero del sistema
          </p>
        </div>
        <button onClick={() => load()} className="flex items-center gap-2 px-3 py-2 border border-border rounded-xl text-sm hover:bg-secondary transition">
          <RefreshCw className="h-4 w-4" /> Actualizar
        </button>
      </div>

      <span className="inline-flex text-xs text-muted-foreground items-center gap-1.5 px-3 py-2 rounded-xl bg-secondary/40">
        📅 Mostrando el día <strong className="capitalize text-foreground">{isToday ? "de hoy" : prettyDate(date)}</strong> — usa las flechas de fecha (arriba) para cambiar de día.
      </span>

      {/* Resumen */}
      <div className="grid grid-cols-3 gap-3">
        <div className="glass-strong rounded-2xl p-4">
          <div className="flex items-center gap-2 text-xs text-muted-foreground"><TrendingUp className="h-3.5 w-3.5 text-green-600" /> Ingresos</div>
          <div className="font-black text-xl text-green-600 tnum mt-1">{formatCOP(totalIngresos)}</div>
        </div>
        <div className="glass-strong rounded-2xl p-4">
          <div className="flex items-center gap-2 text-xs text-muted-foreground"><TrendingDown className="h-3.5 w-3.5 text-red-500" /> Egresos</div>
          <div className="font-black text-xl text-red-500 tnum mt-1">{formatCOP(totalEgresos)}</div>
        </div>
        <div className="glass-strong rounded-2xl p-4">
          <div className="text-xs text-muted-foreground">Balance</div>
          <div className={`font-black text-xl tnum mt-1 ${balance >= 0 ? "text-primary" : "text-red-500"}`}>{formatCOP(balance)}</div>
        </div>
      </div>

      {/* Filtros */}
      <div className="space-y-2">
        {/* Tipo + medio */}
        <div className="flex flex-wrap gap-2 items-center">
          {(["all", "ingreso", "egreso", "cash", "bank"] as Filter[]).map(f => (
            <button key={f} onClick={() => setFilter(f)}
              className={`px-3 py-1.5 rounded-xl text-sm font-medium transition ${filter === f ? "bg-primary text-primary-foreground" : "border border-border hover:bg-secondary"}`}>
              {f === "all" ? "Todos" : f === "ingreso" ? "↑ Ingresos" : f === "egreso" ? "↓ Egresos" : f === "cash" ? "💵 Efectivo" : "🏦 Banco"}
            </button>
          ))}
          <div className="relative ml-auto">
            <Search className="h-4 w-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <input value={q} onChange={e => setQ(e.target.value)} placeholder="Buscar…"
              className="pl-9 pr-4 py-2 glass rounded-xl outline-none text-sm w-56" />
          </div>
        </div>

        {/* Por origen */}
        <div className="flex flex-wrap gap-2 items-center">
          <span className="text-xs text-muted-foreground font-medium">Origen:</span>
          {(["all", ...sources] as (SourceFilter | string)[]).map(s => (
            <button key={s} onClick={() => setSourceFilter(s as SourceFilter)}
              className={`px-3 py-1 rounded-xl text-xs font-medium transition ${sourceFilter === s ? "bg-primary text-primary-foreground" : "border border-border hover:bg-secondary"}`}>
              {s === "all" ? "Todos" : s}
            </button>
          ))}
        </div>
      </div>

      {/* Lista */}
      {loading ? (
        <div className="text-center py-16 text-muted-foreground">Cargando movimientos…</div>
      ) : filtered.length === 0 ? (
        <div className="glass-strong rounded-3xl p-10 text-center text-muted-foreground">
          <p className="text-3xl mb-3">📭</p>
          <p className="font-bold">Sin movimientos que coincidan</p>
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map(m => (
            <div key={m.id} className="glass-strong rounded-2xl px-4 py-3 flex items-center gap-4">
              {/* Indicador tipo */}
              <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${m.type === "ingreso" ? "bg-green-500/10" : "bg-red-500/10"}`}>
                {m.type === "ingreso"
                  ? <TrendingUp className="h-4 w-4 text-green-600" />
                  : <TrendingDown className="h-4 w-4 text-red-500" />}
              </div>

              {/* Info */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <p className="font-medium text-sm truncate">{m.description}</p>
                  <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-bold shrink-0 ${SOURCE_COLORS[m.source] ?? "bg-secondary text-muted-foreground"}`}>
                    {m.source}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground">
                  {m.date} {m.time}
                  {m.relatedName ? ` · ${m.relatedName}` : ""}
                  {" · "}{m.category}
                  {" · "}{m.parts
                    ? m.parts.map(p => `${p.medium === "cash" ? "💵 Efectivo" : "🏦 Banco"} ${p.type === "ingreso" ? "+" : "−"}${formatCOP(p.amount)}`).join(" / ")
                    : m.medium === "cash" ? "💵 Efectivo" : "🏦 Banco"}
                </p>
                <p className="text-[11px] text-muted-foreground/80">
                  👤 Realizado por: <span className="font-semibold">{m.createdByName ?? "—"}</span>
                  {m.deviceName ? <> {"·"} 🖥️ <span className="font-semibold">{m.deviceName}</span></> : ""}
                </p>
              </div>

              {/* Monto */}
              <span className={`font-black text-base tnum shrink-0 ${m.type === "ingreso" ? "text-green-600" : "text-red-500"}`}>
                {m.type === "ingreso" ? "+" : "−"}{formatCOP(m.amount)}
              </span>

              {/* Botones de solicitud: corregir o eliminar */}
              <div className="flex items-center gap-0.5 shrink-0">
                <button
                  onClick={() => setEditMov(m)}
                  title="Solicitar corrección de este movimiento"
                  className="p-1.5 rounded-lg hover:bg-secondary transition text-muted-foreground hover:text-primary"
                >
                  <Pencil className="h-3.5 w-3.5" />
                </button>
                <button
                  onClick={() => setDeleteMov(m)}
                  title="Solicitar eliminación de este movimiento"
                  className="p-1.5 rounded-lg hover:bg-secondary transition text-muted-foreground hover:text-red-500"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          ))}
          <p className="text-xs text-muted-foreground text-center pt-2">{filtered.length} movimientos · mostrando los más recientes</p>
        </div>
      )}

      {/* Wizard de solicitud de cambio para cualquier movimiento */}
      {editMov && (
        <EditRequestWizard
          open={true}
          onOpenChange={(v) => { if (!v) setEditMov(null); }}
          entityType={editMov.entityType}
          entityId={editMov.entityId}
          entityLabel={`${editMov.category} · ${formatCOP(editMov.amount)}${editMov.relatedName ? ` · ${editMov.relatedName}` : ""}`}
          fields={[
            { field: "amount", label: "Valor", currentValue: String(editMov.amount), type: "money" },
            ...(editMov.editableDescription
              ? [{ field: "description", label: "Descripción", currentValue: editMov.description, type: "text" as const }]
              : []),
          ] as EditableField[]}
          onDone={() => load()}
        />
      )}

      {/* Wizard de solicitud de eliminación */}
      {deleteMov && (
        <DeleteRequestWizard
          open={true}
          onOpenChange={(v) => { if (!v) setDeleteMov(null); }}
          entityType={deleteMov.entityType}
          entityId={deleteMov.entityId}
          entityLabel={`${deleteMov.category} · ${formatCOP(deleteMov.amount)}${deleteMov.relatedName ? ` · ${deleteMov.relatedName}` : ""}`}
          onDone={() => load()}
        />
      )}
    </div>
  );
}
