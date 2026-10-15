"use client";

import { useEffect, useState } from "react";
import {
  Clock, Plus, ChevronDown, ChevronUp, Trash2, CheckCircle2, X,
  Banknote, Landmark, Building2, Bike, History, Search, Pencil,
} from "lucide-react";
import { toast } from "sonner";
import * as api from "@/lib/sd-api";
import { formatCOP, todayBogota } from "@/lib/format";
import { useAuth } from "@/lib/auth";
import { useLive } from "@/lib/use-live";
import { DeleteRequestWizard } from "@/components/wizards/DeleteRequestWizard";

// ─── Cálculo en vivo (mismo criterio que el backend, para la vista previa) ─────
function calcMinutes(start: string, end: string): number {
  const parse = (s: string) => {
    const m = /^(\d{1,2}):(\d{2})$/.exec((s ?? "").trim());
    if (!m) return NaN;
    const h = Number(m[1]), min = Number(m[2]);
    if (h > 23 || min > 59) return NaN;
    return h * 60 + min;
  };
  const a = parse(start), b = parse(end);
  if (Number.isNaN(a) || Number.isNaN(b)) return NaN;
  let diff = b - a;
  if (diff < 0) diff += 24 * 60;
  return diff;
}
function calcAmounts(driverHour: number, companyHour: number, minutes: number) {
  const total = Math.round(((driverHour + companyHour) * minutes) / 60);
  const driver = Math.round((driverHour * minutes) / 60);
  return { driver, company: total - driver, total };
}
/** El turno cruza medianoche cuando la salida es anterior a la entrada (termina al día siguiente). */
function isOvernight(start: string, end: string): boolean {
  const m = calcMinutes(start, end);
  return Number.isFinite(m) && m > 0 && start.padStart(5, "0") > end.padStart(5, "0");
}
function nextDay(day: string): string {
  const d = new Date(day + "T12:00:00-05:00");
  return new Date(d.getTime() + 86_400_000).toLocaleDateString("en-CA", { timeZone: "America/Bogota" });
}
function fmtMinutes(min: number): string {
  if (!Number.isFinite(min) || min <= 0) return "—";
  const h = Math.floor(min / 60), m = min % 60;
  return h > 0 ? (m > 0 ? `${h} h ${m} min` : `${h} h`) : `${m} min`;
}
function fmtDateTime(iso?: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  const date = d.toLocaleDateString("es-CO", { timeZone: "America/Bogota", day: "2-digit", month: "2-digit", year: "numeric" });
  const time = d.toLocaleTimeString("es-CO", { timeZone: "America/Bogota", hour: "2-digit", minute: "2-digit" });
  return `${date} ${time}`;
}
function fmtDay(day: string): string {
  return new Date(day + "T12:00:00").toLocaleDateString("es-CO", { day: "2-digit", month: "2-digit", year: "numeric" });
}

export function HourlyClientsTab() {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const [clients, setClients] = useState<api.HourlyClient[]>([]);
  const [loading, setLoading] = useState(true);
  const [drivers, setDrivers] = useState<api.Driver[]>([]);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<api.HourlyClient | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const [showCreate, setShowCreate] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [shiftFor, setShiftFor] = useState<api.HourlyClient | null>(null);
  const [payFor, setPayFor] = useState<api.HourlyClient | null>(null);
  const [editTarget, setEditTarget] = useState<{ shift: api.HourlyShift; client: api.HourlyClient | null } | null>(null);
  const [deleteReq, setDeleteReq] = useState<{ shift: api.HourlyShift; label: string } | null>(null);
  const [ratesFor, setRatesFor] = useState<api.HourlyClient | null>(null);
  // Se incrementa tras cada edición/borrado para que el modal de Historial recargue.
  const [historyKey, setHistoryKey] = useState(0);

  const load = async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const data = await api.getHourlyClients();
      setClients(prev => (JSON.stringify(prev) === JSON.stringify(data) ? prev : data));
    } catch { if (!silent) toast.error("Error al cargar clientes por hora"); }
    if (!silent) setLoading(false);
  };

  const loadDetail = async (id: string) => {
    setDetailLoading(true);
    try { setDetail(await api.getHourlyClient(id)); }
    catch { toast.error("Error al cargar el detalle del cliente"); }
    finally { setDetailLoading(false); }
  };

  useEffect(() => {
    load();
    api.getDrivers().then(ds => setDrivers(ds.filter(d => d.active).sort((a, b) => a.name.localeCompare(b.name)))).catch(() => {});
  }, []);
  useLive(() => { load(true); if (expandedId) loadDetail(expandedId); }, 5000);

  function toggleExpand(c: api.HourlyClient) {
    if (expandedId === c.id) { setExpandedId(null); setDetail(null); return; }
    setExpandedId(c.id);
    setDetail(null);
    loadDetail(c.id);
  }

  const refresh = () => { load(); if (expandedId) loadDetail(expandedId); setHistoryKey(k => k + 1); };

  const totalDebt = clients.reduce((s, c) => s + c.pendingDebt, 0);
  const totalCompany = clients.reduce((s, c) => s + c.companyOutstanding, 0);

  async function toggleActive(c: api.HourlyClient) {
    try {
      await api.updateHourlyClient(c.id, { active: !c.active });
      toast.success(c.active ? "Cliente desactivado" : "Cliente reactivado");
      load();
    } catch (err) { toast.error(String(err)); }
  }

  async function removeClient(c: api.HourlyClient) {
    if (!confirm(`¿Eliminar el cliente por hora "${c.name}"? Se borran sus turnos. Los movimientos de dinero ya registrados en el banco/caja se conservan.`)) return;
    try {
      await api.deleteHourlyClient(c.id);
      toast.success(`Cliente "${c.name}" eliminado`);
      if (expandedId === c.id) { setExpandedId(null); setDetail(null); }
      load();
    } catch (err) { toast.error(String(err)); }
  }

  // Borrado directo (admin). Revierte el dinero en el backend.
  async function removeShift(s: api.HourlyShift) {
    const msg = s.driverPaid
      ? "¿Eliminar este turno? Se revierte el pago al domiciliario (el dinero vuelve a caja/banco) y se reversa lo ya cobrado al cliente."
      : "¿Eliminar este turno pendiente?";
    if (!confirm(msg)) return;
    try {
      await api.deleteHourlyShift(s.id);
      toast.success("Turno eliminado");
      refresh();
    } catch (err) { toast.error(String(err)); }
  }

  function shiftLabel(s: api.HourlyShift, clientName?: string) {
    const cn = s.hourlyClient?.name ?? clientName ?? "";
    return `Turno ${s.driverName}${cn ? ` · ${cn}` : ""} · ${fmtDay(s.date)} · ${formatCOP(s.totalAmount)}`;
  }

  // Eliminar: admin borra directo; el resto genera una solicitud para el admin.
  function onDeleteShift(s: api.HourlyShift, clientName?: string) {
    if (isAdmin) removeShift(s);
    else setDeleteReq({ shift: s, label: shiftLabel(s, clientName) });
  }

  // Editar: admin edita directo; el resto genera una solicitud. Bloqueado si el cliente
  // ya cobró (habría que borrarlo y recrearlo — el backend también lo rechaza).
  function onEditShift(s: api.HourlyShift) {
    if (s.paidAmount > 0) { toast.error("Este turno ya tiene cobros del cliente. Para cambiarlo, elimínalo y créalo de nuevo."); return; }
    setEditTarget({ shift: s, client: clients.find(c => c.id === s.hourlyClientId) ?? null });
  }

  return (
    <div className="space-y-6">
      {/* Barra de acción de la pestaña */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <p className="text-sm text-muted-foreground">
          Alquiler de domiciliarios por hora: registra turnos, paga al domiciliario y cóbrale a la empresa.
        </p>
        <div className="flex gap-2">
          <button
            onClick={() => setShowHistory(true)}
            className="flex items-center gap-2 px-3 py-2 border border-border rounded-xl text-sm font-bold hover:bg-secondary transition"
          >
            <History className="h-4 w-4" /> Historial
          </button>
          <button
            onClick={() => setShowCreate(true)}
            className="flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-xl font-bold hover:opacity-90 transition"
          >
            <Plus className="h-4 w-4" /> Crear cliente
          </button>
        </div>
      </div>

      {/* Resumen */}
      {clients.length > 0 && (
        <div className="grid grid-cols-3 gap-3">
          <SummaryCard icon="🏢" label="Clientes" value={String(clients.length)} />
          <SummaryCard icon="💰" label="Ganancia empresa" value={formatCOP(totalCompany)} good />
          <SummaryCard icon="💸" label="Deuda clientes" value={formatCOP(totalDebt)} warn={totalDebt > 0} />
        </div>
      )}

      {loading ? (
        <div className="text-center py-20 text-muted-foreground">Cargando…</div>
      ) : clients.length === 0 ? (
        <div className="glass-strong rounded-3xl p-12 text-center">
          <Clock className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
          <p className="font-bold text-lg">Sin clientes por hora aún</p>
          <p className="text-sm text-muted-foreground mt-1">Crea una empresa/tienda para empezar a registrar turnos</p>
          <button onClick={() => setShowCreate(true)} className="mt-4 px-6 py-3 bg-primary text-primary-foreground rounded-xl font-bold hover:opacity-90 transition">
            Crear cliente
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          {clients.map(c => {
            const expanded = expandedId === c.id;
            const totalHour = c.driverHourValue + c.companyHourValue;
            const debtShifts = (expanded && detail?.id === c.id ? detail.shifts : c.shifts).filter(s => s.driverPaid && !s.paid);
            return (
              <div key={c.id} className={`glass-strong rounded-3xl overflow-hidden ${!c.active ? "opacity-60" : ""}`}>
                <div className="p-5 flex items-center justify-between gap-4 flex-wrap">
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="w-10 h-10 rounded-xl flex items-center justify-center bg-primary/10 text-primary shrink-0">
                      <Building2 className="h-5 w-5" />
                    </div>
                    <div className="min-w-0">
                      <div className="font-bold flex items-center gap-2 flex-wrap">
                        {c.name}
                        {!c.active && <span className="text-xs px-2 py-0.5 rounded-full bg-secondary">Inactivo</span>}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        Domi {formatCOP(c.driverHourValue)}/h · Empresa {formatCOP(c.companyHourValue)}/h · Total <span className="font-semibold">{formatCOP(totalHour)}/h</span>
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    {c.pendingDebt > 0 ? (
                      <div className="text-right">
                        <div className="text-[11px] text-red-500 font-medium">Deuda cliente</div>
                        <div className="font-black text-red-600 tnum">{formatCOP(c.pendingDebt)}</div>
                      </div>
                    ) : (
                      <div className="flex items-center gap-1 text-green-600 text-sm font-medium">
                        <CheckCircle2 className="h-4 w-4" /> Al día
                      </div>
                    )}
                    <button onClick={() => toggleExpand(c)} className="p-1.5 rounded-lg hover:bg-secondary transition">
                      {expanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                    </button>
                  </div>
                </div>

                {expanded && (
                  <div className="border-t border-border px-5 pb-5 pt-4 space-y-4">
                    {c.active ? (
                      <button
                        onClick={() => setShiftFor(c)}
                        className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-xl bg-primary/10 text-primary font-bold hover:bg-primary/20 transition"
                      >
                        <Plus className="h-4 w-4" /> Registrar turno
                      </button>
                    ) : (
                      <p className="text-xs text-center text-muted-foreground">Cliente desactivado: reactívalo para registrar turnos.</p>
                    )}

                    {/* Turnos registrados (ya pagados al domi, pendientes de cobro al cliente) */}
                    {debtShifts.length > 0 && (
                      <div className="space-y-2">
                        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Turnos registrados</p>
                        {debtShifts.map(s => (
                          <div key={s.id} className="flex items-center justify-between gap-3 p-3 rounded-xl bg-secondary/40 border border-border/60">
                            <div className="min-w-0">
                              <p className="text-sm font-medium flex items-center gap-1.5"><Bike className="h-3.5 w-3.5 shrink-0" /> {s.driverName}</p>
                              <p className="text-[11px] text-muted-foreground">
                                {fmtDay(s.date)} · {s.startTime}–{s.endTime} · {fmtMinutes(s.minutes)} · {s.driverPaidMedium === "bank" ? "transf." : "efectivo"}
                              </p>
                              {s.paidAmount > 0 && <p className="text-[11px] text-green-600">Abonado {formatCOP(s.paidAmount)} de {formatCOP(s.totalAmount)}</p>}
                            </div>
                            <div className="flex items-center gap-2 shrink-0">
                              <div className="text-right">
                                <div className="text-[10px] text-muted-foreground">Total</div>
                                <div className="font-bold tnum">{formatCOP(s.totalAmount)}</div>
                              </div>
                              {s.paidAmount === 0 && (
                                <button onClick={() => onEditShift(s)} title="Editar turno" className="p-1.5 rounded-lg text-muted-foreground hover:bg-secondary hover:text-primary transition">
                                  <Pencil className="h-3.5 w-3.5" />
                                </button>
                              )}
                              <button onClick={() => onDeleteShift(s, c.name)} title={isAdmin ? "Eliminar turno" : "Solicitar eliminación"} className="p-1.5 rounded-lg text-muted-foreground hover:bg-secondary hover:text-red-500 transition">
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}

                    {/* Deuda del cliente */}
                    <div className="rounded-2xl border border-border/60 p-4 space-y-3">
                      <div className="grid grid-cols-3 gap-2 text-center">
                        <MiniStat label="Valor domiciliarios" value={formatCOP(c.driverOutstanding)} />
                        <MiniStat label="Ganancia empresa" value={formatCOP(c.companyOutstanding)} good />
                        <MiniStat label="Deuda total cliente" value={formatCOP(c.pendingDebt)} warn />
                      </div>
                      {c.pendingDebt > 0 ? (
                        <button
                          onClick={() => setPayFor(c)}
                          className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-xl bg-green-500/10 border border-green-500/20 text-green-700 dark:text-green-400 font-bold hover:bg-green-500/20 transition"
                        >
                          💵 Abonar / Pagar deuda del cliente
                        </button>
                      ) : (
                        <p className="text-sm text-muted-foreground text-center">Sin deuda pendiente del cliente</p>
                      )}
                    </div>

                    {/* Historial */}
                    {detailLoading && !detail ? (
                      <p className="text-sm text-muted-foreground text-center py-2">Cargando historial…</p>
                    ) : detail && detail.id === c.id ? (
                      <ShiftHistory shifts={detail.shifts} isAdmin={isAdmin} onDelete={(s) => onDeleteShift(s, c.name)} />
                    ) : null}

                    {/* Acciones de cliente */}
                    <div className="flex gap-2 pt-1">
                      <button onClick={() => toggleActive(c)} className="flex-1 py-2 text-xs font-bold border border-border rounded-xl hover:bg-secondary transition">
                        {c.active ? "Desactivar" : "Reactivar"}
                      </button>
                      <button onClick={() => setRatesFor(c)}
                        className="flex items-center justify-center gap-1.5 px-4 py-2 text-xs font-bold border border-border rounded-xl hover:bg-secondary transition">
                        <Pencil className="h-3.5 w-3.5" /> Editar tarifas
                      </button>
                      {isAdmin && (
                        <button onClick={() => removeClient(c)}
                          className="flex items-center justify-center gap-1.5 px-4 py-2 text-xs font-bold border border-red-500/30 text-red-500 rounded-xl hover:bg-red-500/10 transition">
                          <Trash2 className="h-3.5 w-3.5" /> Eliminar
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {ratesFor && <RatesModal client={ratesFor} onClose={() => setRatesFor(null)} onDone={() => { setRatesFor(null); refresh(); }} />}
      {showCreate && <CreateClientModal onClose={() => setShowCreate(false)} onDone={() => { setShowCreate(false); load(); }} />}
      {showHistory && (
        <HistoryModal
          isAdmin={isAdmin}
          reloadKey={historyKey}
          onEdit={onEditShift}
          onDelete={(s) => onDeleteShift(s)}
          onClose={() => setShowHistory(false)}
        />
      )}
      {editTarget && (
        <EditShiftModal
          shift={editTarget.shift}
          client={editTarget.client}
          drivers={drivers}
          isAdmin={isAdmin}
          onClose={() => setEditTarget(null)}
          onDone={() => { setEditTarget(null); refresh(); }}
        />
      )}
      {deleteReq && (
        <DeleteRequestWizard
          open={true}
          onOpenChange={(v) => { if (!v) setDeleteReq(null); }}
          entityType="HourlyShift"
          entityId={deleteReq.shift.id}
          entityLabel={deleteReq.label}
          onDone={() => { setDeleteReq(null); refresh(); }}
        />
      )}
      {shiftFor && (
        <ShiftModal
          client={shiftFor}
          drivers={drivers}
          onClose={() => setShiftFor(null)}
          onDone={() => { setShiftFor(null); refresh(); }}
        />
      )}
      {payFor && (
        <PayClientModal
          client={payFor}
          onClose={() => setPayFor(null)}
          onDone={() => { setPayFor(null); refresh(); }}
        />
      )}
    </div>
  );
}

// ─── Subcomponentes de presentación ───────────────────────────────────────────

function SummaryCard({ icon, label, value, warn, good }: { icon: string; label: string; value: string; warn?: boolean; good?: boolean }) {
  return (
    <div className="glass-strong rounded-2xl p-4">
      <div className="text-2xl">{icon}</div>
      <div className="text-xs text-muted-foreground mt-2">{label}</div>
      <div className={`font-black text-xl tnum mt-0.5 ${warn ? "text-red-500" : good ? "text-green-600" : ""}`}>{value}</div>
    </div>
  );
}

function MiniStat({ label, value, warn, good }: { label: string; value: string; warn?: boolean; good?: boolean }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground leading-tight">{label}</div>
      <div className={`text-sm font-black tnum mt-0.5 ${warn ? "text-red-600" : good ? "text-green-600" : ""}`}>{value}</div>
    </div>
  );
}

function ShiftHistory({ shifts, isAdmin, onDelete }: { shifts: api.HourlyShift[]; isAdmin: boolean; onDelete: (s: api.HourlyShift) => void }) {
  const settled = shifts.filter(s => s.paid).sort((a, b) => (a.paidAt && b.paidAt ? (a.paidAt < b.paidAt ? 1 : -1) : 0));
  if (settled.length === 0) return null;
  return (
    <div className="space-y-2">
      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Historial saldado · {settled.length} turno(s)</p>
      <div className="space-y-2 max-h-80 overflow-y-auto pr-1">
        {settled.map(s => (
          <div key={s.id} className="flex items-center justify-between gap-3 p-3 rounded-xl bg-green-500/5 border border-green-500/10">
            <div className="min-w-0">
              <p className="text-sm font-medium flex items-center gap-1.5"><Bike className="h-3.5 w-3.5 shrink-0" /> {s.driverName}</p>
              <p className="text-[11px] text-muted-foreground">{fmtDay(s.date)} · {s.startTime}–{s.endTime} · {fmtMinutes(s.minutes)}</p>
              <p className="text-[11px] text-muted-foreground">✅ cobrado {fmtDateTime(s.paidAt)}</p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <span className="text-sm font-bold text-green-600 tnum">{formatCOP(s.totalAmount)}</span>
              <button onClick={() => onDelete(s)} title={isAdmin ? "Eliminar turno" : "Solicitar eliminación"} className="p-1.5 rounded-lg text-muted-foreground hover:bg-secondary hover:text-red-500 transition">
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Historial global ──────────────────────────────────────────────────────────

function statusOf(s: api.HourlyShift): { label: string; cls: string } {
  if (!s.driverPaid) return { label: "Pendiente", cls: "bg-amber-500/15 text-amber-700 dark:text-amber-400" };
  if (s.paid) return { label: "Cobrado", cls: "bg-green-500/15 text-green-700 dark:text-green-400" };
  if (s.paidAmount > 0) return { label: "Abono parcial", cls: "bg-blue-500/15 text-blue-700 dark:text-blue-400" };
  return { label: "Por cobrar", cls: "bg-red-500/15 text-red-700 dark:text-red-400" };
}

function HistoryModal({ isAdmin, reloadKey, onEdit, onDelete, onClose }: {
  isAdmin: boolean;
  reloadKey: number;
  onEdit: (s: api.HourlyShift) => void;
  onDelete: (s: api.HourlyShift) => void;
  onClose: () => void;
}) {
  const [rows, setRows] = useState<api.HourlyShift[]>([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<"todos" | "pendiente" | "porcobrar" | "cobrado">("todos");

  const load = async () => {
    setLoading(true);
    try { setRows(await api.getHourlyShiftsHistory()); }
    catch { toast.error("Error al cargar el historial"); }
    finally { setLoading(false); }
  };
  // Recarga al abrir y cada vez que el padre aplica una edición/borrado (reloadKey).
  useEffect(() => { load(); }, [reloadKey]);

  const term = q.trim().toLowerCase();
  const filtered = rows.filter(s => {
    if (term && !`${s.driverName} ${s.hourlyClient?.name ?? ""}`.toLowerCase().includes(term)) return false;
    if (filter === "pendiente") return !s.driverPaid;
    if (filter === "porcobrar") return s.driverPaid && !s.paid;
    if (filter === "cobrado") return s.paid;
    return true;
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm" onClick={onClose}>
      <div className="glass-strong rounded-3xl w-full max-w-3xl max-h-[92vh] flex flex-col p-5" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-lg font-black flex items-center gap-2"><History className="h-5 w-5" /> Historial de turnos</h3>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-secondary transition"><X className="h-4 w-4" /></button>
        </div>

        <div className="space-y-2 mb-3">
          <div className="relative">
            <Search className="h-4 w-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <input value={q} onChange={e => setQ(e.target.value)} placeholder="Buscar por empresa o domiciliario…"
              className="w-full pl-9 pr-3 py-2 rounded-xl bg-secondary/50 border border-border outline-none focus:ring-2 ring-primary/40" />
          </div>
          <div className="flex gap-1.5 flex-wrap">
            {([["todos", "Todos"], ["porcobrar", "Por cobrar"], ["cobrado", "Cobrados"]] as const).map(([k, label]) => (
              <button key={k} onClick={() => setFilter(k)}
                className={`px-3 py-1.5 rounded-lg text-xs font-bold transition ${filter === k ? "bg-primary text-primary-foreground" : "bg-secondary/60 text-muted-foreground hover:text-foreground"}`}>
                {label}
              </button>
            ))}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto -mx-1 px-1 space-y-2">
          {loading ? (
            <p className="text-center py-10 text-muted-foreground">Cargando…</p>
          ) : filtered.length === 0 ? (
            <p className="text-center py-10 text-muted-foreground">Sin turnos {term || filter !== "todos" ? "para este filtro" : "todavía"}</p>
          ) : filtered.map(s => {
            const st = statusOf(s);
            return (
              <div key={s.id} className="rounded-xl border border-border/60 p-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-bold text-sm flex items-center gap-1.5"><Building2 className="h-3.5 w-3.5 shrink-0" />{s.hourlyClient?.name ?? "—"}</span>
                      <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${st.cls}`}>{st.label}</span>
                    </div>
                    <p className="text-xs text-muted-foreground flex items-center gap-1.5 mt-0.5"><Bike className="h-3 w-3 shrink-0" />{s.driverName} · {fmtDay(s.date)} · {s.startTime}–{s.endTime} · {fmtMinutes(s.minutes)}</p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <div className="text-right">
                      <div className="font-black tnum">{formatCOP(s.totalAmount)}</div>
                      <div className="text-[10px] text-muted-foreground">domi {formatCOP(s.driverAmount)} · emp {formatCOP(s.companyAmount)}</div>
                    </div>
                    {s.paidAmount === 0 && (
                      <button onClick={() => onEdit(s)} title="Editar turno"
                        className="p-2 rounded-lg text-muted-foreground hover:bg-secondary hover:text-primary transition">
                        <Pencil className="h-4 w-4" />
                      </button>
                    )}
                    <button onClick={() => onDelete(s)} title={isAdmin ? "Eliminar turno" : "Solicitar eliminación"}
                      className="p-2 rounded-lg text-muted-foreground hover:bg-red-500/10 hover:text-red-500 transition">
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </div>
                <div className="mt-2 pt-2 border-t border-border/40 grid sm:grid-cols-3 gap-1.5 text-[11px]">
                  <div>
                    <span className="text-muted-foreground">Creó:</span> <span className="font-semibold">{s.createdByName ?? "—"}</span>
                    <div className="text-muted-foreground">{fmtDateTime(s.createdAt)}</div>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Pagó domi:</span>{" "}
                    {s.driverPaid ? (<><span className="font-semibold">{s.driverPaidByName ?? "—"}</span><div className="text-muted-foreground">{fmtDateTime(s.driverPaidAt)} · {s.driverPaidMedium === "bank" ? "transf." : "efectivo"}</div></>) : <span className="text-muted-foreground">—</span>}
                  </div>
                  <div>
                    <span className="text-muted-foreground">Cobró cliente:</span>{" "}
                    {s.paidAmount > 0 ? (<><span className="font-semibold">{s.paidByName ?? "—"}</span><div className="text-muted-foreground">{fmtDateTime(s.paidAt)}{s.paid ? "" : ` · abono ${formatCOP(s.paidAmount)}`}</div></>) : <span className="text-muted-foreground">—</span>}
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {!loading && (
          <div className="pt-3 mt-1 border-t border-border/60 text-xs text-muted-foreground text-center">
            {filtered.length} turno(s){rows.length !== filtered.length ? ` de ${rows.length}` : ""}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Modales ──────────────────────────────────────────────────────────────────

function ModalShell({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm" onClick={onClose}>
      <div className="glass-strong rounded-3xl w-full max-w-md max-h-[90vh] overflow-y-auto p-6 space-y-4" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-black">{title}</h3>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-secondary transition"><X className="h-4 w-4" /></button>
        </div>
        {children}
      </div>
    </div>
  );
}

function MediumButtons({ value, onChange }: { value: "cash" | "bank"; onChange: (m: "cash" | "bank") => void }) {
  return (
    <div className="grid grid-cols-2 gap-2">
      <button
        type="button"
        onClick={() => onChange("cash")}
        className={`flex items-center justify-center gap-2 px-4 py-3 rounded-xl font-bold text-sm border transition ${value === "cash" ? "bg-primary text-primary-foreground border-primary" : "border-border hover:bg-secondary"}`}
      >
        <Banknote className="h-4 w-4" /> Efectivo
      </button>
      <button
        type="button"
        onClick={() => onChange("bank")}
        className={`flex items-center justify-center gap-2 px-4 py-3 rounded-xl font-bold text-sm border transition ${value === "bank" ? "bg-primary text-primary-foreground border-primary" : "border-border hover:bg-secondary"}`}
      >
        <Landmark className="h-4 w-4" /> Transferencia
      </button>
    </div>
  );
}

function OvernightConfirm({ date, start, end, minutes, amounts, saving, confirmLabel, onCancel, onConfirm }: {
  date: string; start: string; end: string; minutes: number;
  amounts: { driver: number; company: number; total: number };
  saving: boolean; confirmLabel: string; onCancel: () => void; onConfirm: () => void;
}) {
  const hours = Math.floor(minutes / 60), rest = minutes % 60;
  const duration = `${hours} hora${hours === 1 ? "" : "s"}${rest ? ` y ${rest} min` : ""}`;
  return (
    <div className="space-y-3" role="alertdialog" aria-label="Confirmar turno nocturno">
      <div className="rounded-xl bg-amber-500/10 border border-amber-500/30 p-3 text-sm font-bold text-amber-700 dark:text-amber-400">
        🌙 Este turno termina mañana y tiene una duración de {duration}. ¿Deseas registrarlo?
      </div>
      <div className="rounded-xl bg-secondary/40 p-3 space-y-2 text-sm">
        <div className="flex justify-between"><span className="text-muted-foreground">Inicio</span><span className="font-bold">{fmtDay(date)} {start}</span></div>
        <div className="flex justify-between"><span className="text-muted-foreground">Fin</span><span className="font-bold">{fmtDay(nextDay(date))} {end}</span></div>
        <div className="flex justify-between"><span className="text-muted-foreground">Horas totales</span><span className="font-bold">{fmtMinutes(minutes)}</span></div>
        <div className="flex justify-between"><span className="text-muted-foreground">Para el domiciliario</span><span className="font-bold text-amber-600 tnum">{formatCOP(amounts.driver)}</span></div>
        <div className="flex justify-between"><span className="text-muted-foreground">Para la empresa</span><span className="font-bold text-green-600 tnum">{formatCOP(amounts.company)}</span></div>
        <div className="flex justify-between border-t border-border/60 pt-2"><span className="text-muted-foreground">Total</span><span className="font-black tnum">{formatCOP(amounts.total)}</span></div>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <button onClick={onCancel} disabled={saving} className="py-3 rounded-xl border border-border font-bold hover:bg-secondary transition">Cancelar</button>
        <button onClick={onConfirm} disabled={saving} className="py-3 rounded-xl bg-primary text-primary-foreground font-bold hover:opacity-90 transition disabled:opacity-50">
          {saving ? "Guardando…" : confirmLabel}
        </button>
      </div>
    </div>
  );
}

/** Editar tarifas. Los turnos ya registrados conservan la tarifa con la que se valoraron. */
function RatesModal({ client, onClose, onDone }: { client: api.HourlyClient; onClose: () => void; onDone: () => void }) {
  const [driver, setDriver] = useState(String(client.driverHourValue));
  const [company, setCompany] = useState(String(client.companyHourValue));
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);
  const dV = Number(driver) || 0, cV = Number(company) || 0;
  const unchanged = dV === client.driverHourValue && cV === client.companyHourValue;

  function review() {
    if (driver === "" || company === "") { toast.error("Escribe las dos tarifas (pueden ser 0, pero no ambas)"); return; }
    if (dV + cV <= 0) { toast.error("Define al menos un valor por hora mayor a 0"); return; }
    if (unchanged) { toast.error("No cambiaste ninguna tarifa"); return; }
    setConfirming(true);
  }
  async function save() {
    setSaving(true);
    try {
      await api.updateHourlyClient(client.id, { driverHourValue: dV, companyHourValue: cV });
      toast.success(`Tarifas de ${client.name} actualizadas`);
      onDone();
    } catch (err) { toast.error(String(err)); setSaving(false); }
  }

  return (
    <ModalShell title={`Tarifas · ${client.name}`} onClose={onClose}>
      <div className="rounded-xl bg-secondary/40 p-3 text-xs text-muted-foreground">
        Actual: Domi {formatCOP(client.driverHourValue)}/h · Empresa {formatCOP(client.companyHourValue)}/h · Total {formatCOP(client.driverHourValue + client.companyHourValue)}/h
      </div>
      {!confirming ? (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Nuevo valor hora domiciliario"><MoneyInput value={driver} onChange={setDriver} autoFocus /></Field>
            <Field label="Nueva ganancia empresa / hora"><MoneyInput value={company} onChange={setCompany} /></Field>
          </div>
          <div className="rounded-xl bg-secondary/40 p-3 text-center">
            <div className="text-[11px] uppercase tracking-wider text-muted-foreground">Nuevo total a cobrar por hora</div>
            <div className="text-2xl font-black tnum">{formatCOP(dV + cV)}</div>
          </div>
          <button onClick={review} className="w-full py-3 bg-primary text-primary-foreground rounded-xl font-bold hover:opacity-90 transition">Revisar cambio</button>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="rounded-xl bg-secondary/40 p-3 space-y-1 text-sm">
            <div className="flex justify-between"><span className="text-muted-foreground">Domiciliario / hora</span><span className="font-bold">{formatCOP(client.driverHourValue)} → {formatCOP(dV)}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">Empresa / hora</span><span className="font-bold">{formatCOP(client.companyHourValue)} → {formatCOP(cV)}</span></div>
            <div className="flex justify-between border-t border-border/60 pt-1"><span className="text-muted-foreground">Total / hora</span><span className="font-black">{formatCOP(client.driverHourValue + client.companyHourValue)} → {formatCOP(dV + cV)}</span></div>
          </div>
          <p className="text-xs text-muted-foreground">Los turnos ya registrados y la deuda actual del cliente <b>no cambian</b>: conservan la tarifa con que se registraron. Solo los turnos nuevos usarán la tarifa nueva.</p>
          <div className="grid grid-cols-2 gap-2">
            <button onClick={() => setConfirming(false)} disabled={saving} className="py-3 rounded-xl border border-border font-bold hover:bg-secondary transition">Volver</button>
            <button onClick={save} disabled={saving} className="py-3 rounded-xl bg-primary text-primary-foreground font-bold hover:opacity-90 transition disabled:opacity-50">{saving ? "Guardando…" : "Confirmar tarifas"}</button>
          </div>
        </div>
      )}
    </ModalShell>
  );
}

function CreateClientModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState("");
  const [driver, setDriver] = useState("");
  const [company, setCompany] = useState("");
  const [saving, setSaving] = useState(false);
  const dV = Number(driver) || 0;
  const cV = Number(company) || 0;

  async function submit() {
    if (!name.trim()) { toast.error("Escribe el nombre del cliente"); return; }
    if (dV + cV <= 0) { toast.error("Define al menos un valor por hora"); return; }
    setSaving(true);
    try {
      await api.createHourlyClient({ name: name.trim(), driverHourValue: dV, companyHourValue: cV });
      toast.success("Cliente creado");
      onDone();
    } catch (err) { toast.error(String(err)); setSaving(false); }
  }

  return (
    <ModalShell title="Crear cliente por hora" onClose={onClose}>
      <div className="space-y-3">
        <Field label="Nombre de la empresa o tienda">
          <input value={name} onChange={e => setName(e.target.value)} autoFocus
            className="w-full px-3 py-2 rounded-xl bg-secondary/50 border border-border outline-none focus:ring-2 ring-primary/40"
            placeholder="Ej: Tienda La 80" />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Valor hora domiciliario">
            <MoneyInput value={driver} onChange={setDriver} placeholder="15000" />
          </Field>
          <Field label="Ganancia empresa / hora">
            <MoneyInput value={company} onChange={setCompany} placeholder="5000" />
          </Field>
        </div>
        <div className="rounded-xl bg-secondary/40 p-3 text-center">
          <div className="text-[11px] uppercase tracking-wider text-muted-foreground">Total a cobrar por hora</div>
          <div className="text-2xl font-black tnum">{formatCOP(dV + cV)}</div>
        </div>
        <button onClick={submit} disabled={saving}
          className="w-full py-3 bg-primary text-primary-foreground rounded-xl font-bold hover:opacity-90 transition disabled:opacity-50">
          {saving ? "Guardando…" : "Crear cliente"}
        </button>
      </div>
    </ModalShell>
  );
}

function ShiftModal({ client, drivers, onClose, onDone }: { client: api.HourlyClient; drivers: api.Driver[]; onClose: () => void; onDone: () => void }) {
  const [driverId, setDriverId] = useState("");
  const [date, setDate] = useState(todayBogota());
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [medium, setMedium] = useState<"cash" | "bank">("cash");
  const [saving, setSaving] = useState(false);
  // Turno que cruza medianoche: se muestra un resumen y se exige confirmar (decisión del dueño).
  const [confirming, setConfirming] = useState(false);

  const minutes = calcMinutes(start, end);
  const preview = Number.isFinite(minutes) && minutes > 0 ? calcAmounts(client.driverHourValue, client.companyHourValue, minutes) : null;
  const overnight = isOvernight(start, end);

  async function submit(confirmOvernight = false) {
    if (!driverId) { toast.error("Selecciona un domiciliario"); return; }
    if (!start || !end) { toast.error("Ingresa hora de entrada y salida"); return; }
    if (!preview) { toast.error("La hora de salida no puede ser igual a la de entrada"); return; }
    if (overnight && !confirmOvernight) { setConfirming(true); return; }
    setSaving(true);
    try {
      await api.registerHourlyShift(client.id, { driverId, startTime: start, endTime: end, date, medium, ...(overnight ? { confirmOvernight: true } : {}) });
      toast.success("Turno registrado y pagado al domiciliario");
      onDone();
    } catch (err) { toast.error(String(err)); setSaving(false); }
  }

  return (
    <ModalShell title={`Registrar turno · ${client.name}`} onClose={onClose}>
      {confirming && preview ? (
        <OvernightConfirm date={date} start={start} end={end} minutes={minutes} amounts={preview}
          saving={saving} confirmLabel="Sí, registrar turno"
          onCancel={() => setConfirming(false)} onConfirm={() => submit(true)} />
      ) : (
      <div className="space-y-3">
        <Field label="Domiciliario">
          <select value={driverId} onChange={e => setDriverId(e.target.value)}
            className="w-full px-3 py-2 rounded-xl bg-secondary/50 border border-border outline-none focus:ring-2 ring-primary/40">
            <option value="">Selecciona…</option>
            {drivers.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
          {drivers.length === 0 && <p className="text-[11px] text-amber-500 mt-1">No hay domiciliarios activos registrados.</p>}
        </Field>
        <Field label="Fecha del turno">
          <input type="date" value={date} onChange={e => setDate(e.target.value)}
            className="w-full px-3 py-2 rounded-xl bg-secondary/50 border border-border outline-none focus:ring-2 ring-primary/40" />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Hora entrada">
            <input type="time" value={start} onChange={e => setStart(e.target.value)}
              className="w-full px-3 py-2 rounded-xl bg-secondary/50 border border-border outline-none focus:ring-2 ring-primary/40" />
          </Field>
          <Field label="Hora salida">
            <input type="time" value={end} onChange={e => setEnd(e.target.value)}
              className="w-full px-3 py-2 rounded-xl bg-secondary/50 border border-border outline-none focus:ring-2 ring-primary/40" />
          </Field>
        </div>

        <div>
          <p className="text-xs font-medium text-muted-foreground mb-2">¿De dónde sale el pago al domiciliario?</p>
          <MediumButtons value={medium} onChange={setMedium} />
        </div>

        <div className="rounded-xl bg-secondary/40 p-3 space-y-2">
          <div className="flex justify-between text-xs">
            <span className="text-muted-foreground">Tiempo trabajado</span>
            <span className="font-bold">{fmtMinutes(minutes)}</span>
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-muted-foreground">A pagar al domiciliario</span>
            <span className="font-bold text-amber-600 tnum">{preview ? formatCOP(preview.driver) : "—"}</span>
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-muted-foreground">Ganancia empresa</span>
            <span className="font-bold text-green-600 tnum">{preview ? formatCOP(preview.company) : "—"}</span>
          </div>
          <div className="flex justify-between text-sm border-t border-border/60 pt-2">
            <span className="text-muted-foreground">Total a cobrar al cliente</span>
            <span className="font-black tnum">{preview ? formatCOP(preview.total) : "—"}</span>
          </div>
        </div>
        <p className="text-[11px] text-muted-foreground">
          Al registrar se descuenta {preview ? formatCOP(preview.driver) : "el pago al domiciliario"} del {medium === "cash" ? "efectivo" : "banco"} y se suma {preview ? formatCOP(preview.total) : "el total"} a la deuda del cliente.
        </p>
        {overnight && (
          <p className="text-[11px] text-amber-600">🌙 La salida es anterior a la entrada: el turno termina el día siguiente ({fmtDay(nextDay(date))}). Te pediremos confirmarlo.</p>
        )}
        <button onClick={() => submit()} disabled={saving}
          className="w-full py-3 bg-primary text-primary-foreground rounded-xl font-bold hover:opacity-90 transition disabled:opacity-50">
          {saving ? "Guardando…" : "Registrar turno"}
        </button>
      </div>
      )}
    </ModalShell>
  );
}

function EditShiftModal({ shift, client, drivers, isAdmin, onClose, onDone }: {
  shift: api.HourlyShift;
  client: api.HourlyClient | null;
  drivers: api.Driver[];
  isAdmin: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const [driverId, setDriverId] = useState(shift.driverId ?? "");
  const [date, setDate] = useState(shift.date);
  const [start, setStart] = useState(shift.startTime);
  const [end, setEnd] = useState(shift.endTime);
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [confirming, setConfirming] = useState(false);

  // Vista previa con la tarifa CONGELADA del turno (la del cliente pudo cambiar después).
  const rates = shift.driverHourValue != null && shift.companyHourValue != null
    ? { d: shift.driverHourValue, c: shift.companyHourValue }
    : client ? { d: client.driverHourValue, c: client.companyHourValue } : null;
  const minutes = calcMinutes(start, end);
  const preview = rates && Number.isFinite(minutes) && minutes > 0 ? calcAmounts(rates.d, rates.c, minutes) : null;
  const timesChanged = start !== shift.startTime || end !== shift.endTime;
  const overnight = isOvernight(start, end);

  const changedDriver = !!driverId && driverId !== (shift.driverId ?? "");
  const changed = changedDriver || start !== shift.startTime || end !== shift.endTime || date !== shift.date;

  async function submit(confirmOvernight = false) {
    if (!driverId) { toast.error("Selecciona un domiciliario"); return; }
    if (!start || !end) { toast.error("Ingresa hora de entrada y salida"); return; }
    if (!Number.isFinite(minutes) || minutes <= 0) { toast.error("La hora de salida no puede ser igual a la de entrada"); return; }
    if (!changed) { toast.error("No cambiaste nada"); return; }
    if (!isAdmin && !reason.trim()) { toast.error("Indica el motivo del cambio"); return; }
    const needsConfirm = overnight && timesChanged;
    if (needsConfirm && !confirmOvernight) { setConfirming(true); return; }

    setSaving(true);
    try {
      if (isAdmin) {
        await api.editHourlyShift(shift.id, { driverId, startTime: start, endTime: end, date, ...(needsConfirm ? { confirmOvernight: true } : {}) });
        toast.success("Turno actualizado");
      } else {
        const changes: Record<string, api.EditRequestChange> = {};
        if (changedDriver) {
          const newName = drivers.find(d => d.id === driverId)?.name ?? "";
          changes.driverName = { old: shift.driverName, new: newName };
          changes.driverId = { old: shift.driverId ?? "", new: driverId };
        }
        if (start !== shift.startTime) changes.startTime = { old: shift.startTime, new: start };
        if (end !== shift.endTime) changes.endTime = { old: shift.endTime, new: end };
        if (date !== shift.date) changes.date = { old: shift.date, new: date };
        if (needsConfirm) changes.confirmOvernight = { old: "", new: "true" };
        await api.createEditRequest({
          entityType: "HourlyShift",
          entityId: shift.id,
          entityLabel: `Turno ${shift.driverName}${shift.hourlyClient ? ` · ${shift.hourlyClient.name}` : client ? ` · ${client.name}` : ""} · ${fmtDay(shift.date)}`,
          changes,
          reason,
        });
        toast.success("✅ Solicitud enviada al administrador");
      }
      onDone();
    } catch (err) { toast.error(String(err)); setSaving(false); }
  }

  return (
    <ModalShell title={`Editar turno${shift.hourlyClient ? ` · ${shift.hourlyClient.name}` : ""}`} onClose={onClose}>
      {confirming && preview ? (
        <OvernightConfirm date={date} start={start} end={end} minutes={minutes} amounts={preview}
          saving={saving} confirmLabel={isAdmin ? "Sí, guardar cambios" : "Sí, enviar solicitud"}
          onCancel={() => setConfirming(false)} onConfirm={() => submit(true)} />
      ) : (
      <div className="space-y-3">
        {!isAdmin && (
          <div className="rounded-xl bg-secondary/40 px-3 py-2 text-xs text-muted-foreground">
            🔒 No puedes editar directo. Se enviará una solicitud al administrador para aprobación.
          </div>
        )}
        <Field label="Domiciliario">
          <select value={driverId} onChange={e => setDriverId(e.target.value)}
            className="w-full px-3 py-2 rounded-xl bg-secondary/50 border border-border outline-none focus:ring-2 ring-primary/40">
            <option value="">Selecciona…</option>
            {drivers.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
            {shift.driverId && !drivers.some(d => d.id === shift.driverId) && (
              <option value={shift.driverId}>{shift.driverName} (actual)</option>
            )}
          </select>
        </Field>
        <Field label="Fecha del turno">
          <input type="date" value={date} onChange={e => setDate(e.target.value)}
            className="w-full px-3 py-2 rounded-xl bg-secondary/50 border border-border outline-none focus:ring-2 ring-primary/40" />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Hora entrada">
            <input type="time" value={start} onChange={e => setStart(e.target.value)}
              className="w-full px-3 py-2 rounded-xl bg-secondary/50 border border-border outline-none focus:ring-2 ring-primary/40" />
          </Field>
          <Field label="Hora salida">
            <input type="time" value={end} onChange={e => setEnd(e.target.value)}
              className="w-full px-3 py-2 rounded-xl bg-secondary/50 border border-border outline-none focus:ring-2 ring-primary/40" />
          </Field>
        </div>
        <div className="rounded-xl bg-secondary/40 p-3 space-y-2">
          <div className="flex justify-between text-xs"><span className="text-muted-foreground">Tiempo trabajado</span><span className="font-bold">{fmtMinutes(minutes)}</span></div>
          <div className="flex justify-between text-sm"><span className="text-muted-foreground">A pagar al domiciliario</span><span className="font-bold text-amber-600 tnum">{preview ? formatCOP(preview.driver) : "—"}</span></div>
          <div className="flex justify-between text-sm"><span className="text-muted-foreground">Ganancia empresa</span><span className="font-bold text-green-600 tnum">{preview ? formatCOP(preview.company) : "—"}</span></div>
          <div className="flex justify-between text-sm border-t border-border/60 pt-2"><span className="text-muted-foreground">Total a cobrar al cliente</span><span className="font-black tnum">{preview ? formatCOP(preview.total) : "—"}</span></div>
        </div>
        {shift.driverPaid && (
          <p className="text-[11px] text-amber-600">Ya se pagó al domiciliario: al aplicarse, se corrige ese pago en caja/banco y la deuda del cliente por la diferencia.</p>
        )}
        {!isAdmin && (
          <Field label="Motivo del cambio">
            <textarea value={reason} onChange={e => setReason(e.target.value)} rows={2}
              placeholder="Ej: me equivoqué en la hora de salida / era otro domiciliario"
              className="w-full px-3 py-2 rounded-xl bg-secondary/50 border border-border outline-none focus:ring-2 ring-primary/40 resize-none" />
          </Field>
        )}
        {overnight && timesChanged && (
          <p className="text-[11px] text-amber-600">🌙 La salida es anterior a la entrada: el turno termina el día siguiente. Te pediremos confirmarlo.</p>
        )}
        <button onClick={() => submit()} disabled={saving || !changed}
          className="w-full py-3 bg-primary text-primary-foreground rounded-xl font-bold hover:opacity-90 transition disabled:opacity-50">
          {saving ? "Guardando…" : isAdmin ? "Guardar cambios" : "Enviar solicitud"}
        </button>
      </div>
      )}
    </ModalShell>
  );
}

function PayClientModal({ client, onClose, onDone }: { client: api.HourlyClient; onClose: () => void; onDone: () => void }) {
  const [payAll, setPayAll] = useState(true);
  const [amount, setAmount] = useState("");
  const [medium, setMedium] = useState<"cash" | "bank">("cash");
  const [saving, setSaving] = useState(false);
  const amt = payAll ? client.pendingDebt : (Number(amount) || 0);

  async function submit() {
    if (!payAll && amt <= 0) { toast.error("Ingresa el monto del abono"); return; }
    setSaving(true);
    try {
      await api.payHourlyClient(client.id, amt, payAll, medium);
      toast.success(payAll ? "Deuda saldada" : "Abono registrado");
      onDone();
    } catch (err) { toast.error(String(err)); setSaving(false); }
  }

  return (
    <ModalShell title={`Cobrar a ${client.name}`} onClose={onClose}>
      <div className="space-y-4">
        <div className="text-center rounded-xl bg-secondary/40 p-3">
          <div className="text-xs text-muted-foreground">Deuda actual del cliente</div>
          <div className="text-2xl font-black tnum text-red-600">{formatCOP(client.pendingDebt)}</div>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <button type="button" onClick={() => setPayAll(true)}
            className={`px-4 py-2.5 rounded-xl font-bold text-sm border transition ${payAll ? "bg-primary text-primary-foreground border-primary" : "border-border hover:bg-secondary"}`}>
            Pagar todo
          </button>
          <button type="button" onClick={() => setPayAll(false)}
            className={`px-4 py-2.5 rounded-xl font-bold text-sm border transition ${!payAll ? "bg-primary text-primary-foreground border-primary" : "border-border hover:bg-secondary"}`}>
            Abono parcial
          </button>
        </div>
        {!payAll && (
          <Field label="Monto del abono">
            <MoneyInput value={amount} onChange={setAmount} placeholder="0" autoFocus />
          </Field>
        )}
        <div>
          <p className="text-xs font-medium text-muted-foreground mb-2">¿A dónde entra el dinero?</p>
          <MediumButtons value={medium} onChange={setMedium} />
        </div>
        {!payAll && amt > 0 && (
          <p className="text-[11px] text-muted-foreground text-center">
            Quedará debiendo {formatCOP(Math.max(0, client.pendingDebt - amt))}.
          </p>
        )}
        <button onClick={submit} disabled={saving || amt <= 0}
          className="w-full py-3 bg-green-600 text-white rounded-xl font-bold hover:opacity-90 transition disabled:opacity-50">
          {saving ? "Registrando…" : `Cobrar ${formatCOP(amt)}`}
        </button>
      </div>
    </ModalShell>
  );
}

// ─── Inputs auxiliares ─────────────────────────────────────────────────────────

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <div className="mt-1">{children}</div>
    </label>
  );
}

function MoneyInput({ value, onChange, placeholder, autoFocus }: { value: string; onChange: (v: string) => void; placeholder?: string; autoFocus?: boolean }) {
  return (
    <input
      inputMode="numeric"
      value={value}
      autoFocus={autoFocus}
      onChange={e => onChange(e.target.value.replace(/[^\d]/g, ""))}
      placeholder={placeholder}
      className="w-full px-3 py-2 rounded-xl bg-secondary/50 border border-border outline-none focus:ring-2 ring-primary/40 tnum"
    />
  );
}
