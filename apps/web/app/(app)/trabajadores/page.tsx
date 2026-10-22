"use client";

import { useEffect, useState } from "react";
import { useStore, commissionsForWorker } from "@/lib/store";
import { useDay } from "@/lib/day-context";
import { Avatar } from "@/components/Avatar";
import { formatCOP } from "@/lib/format";
import { Plus, Bike, Building2, ChevronDown, ChevronUp, DollarSign, Loader2, Pencil, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "@/lib/auth";
import type { Worker } from "@cash-buddy/shared";
import * as api from "@/lib/sd-api";
import type { DriverStatement } from "@/lib/sd-api";
import { PayrollWizard } from "@/components/wizards/PayrollWizard";
import { DriverPaymentWizard } from "@/components/wizards/DriverPaymentWizard";

type Tab = "administrativos" | "domiciliarios";

export default function WorkersPage() {
  const { state, addWorker, updateWorker, removeWorker } = useStore();
  const { user } = useAuth();
  // Renombrar y activar/desactivar: cualquier usuario (como antes). Eliminar: solo administrador
  // (el servidor también lo exige y además lo impide si el trabajador tiene historial).
  const isAdmin = user?.role === "admin";
  const [renaming, setRenaming] = useState<Worker | null>(null);

  async function toggleWorker(w: Worker) {
    const msg = w.active
      ? `¿Desactivar a "${w.name}"? Conserva sus pagos e historial, pero no podrá recibir pagos nuevos hasta reactivarlo.`
      : `¿Reactivar a "${w.name}"?`;
    if (!confirm(msg)) return;
    if (await updateWorker(w.id, { active: !w.active })) toast.success(w.active ? `"${w.name}" desactivado` : `"${w.name}" reactivado`);
  }

  async function deleteWorker(w: Worker) {
    if (!confirm(`¿Eliminar a "${w.name}" definitivamente? Solo es posible si no tiene pagos ni movimientos; si los tiene, desactívalo.`)) return;
    if (await removeWorker(w.id)) toast.success(`"${w.name}" eliminado`);
  }
  const [tab, setTab] = useState<Tab>("administrativos");
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [role, setRole] = useState<"domiciliario" | "administrativo">("administrativo");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [payrollTarget, setPayrollTarget] = useState<string | null>(null);
  const [driverPayTarget, setDriverPayTarget] = useState<{ id: string; name: string } | null>(null);
  // NEW02: la nómina se registra en el día operativo (la caja abierta), no en el calendario.
  const { operatingDay: today } = useDay();

  const [drivers, setDrivers] = useState<api.Driver[]>([]);
  const [driverStatements, setDriverStatements] = useState<Record<string, DriverStatement>>({});
  const [loadingStatement, setLoadingStatement] = useState<string | null>(null);

  useEffect(() => {
    api.getDrivers().then(setDrivers).catch(() => {});
  }, []);

  function findDriver(workerName: string) {
    const norm = (s: string) => s.toLowerCase().trim();
    return drivers.find(d => norm(d.name).includes(norm(workerName)) || norm(workerName).includes(norm(d.name)));
  }

  // force: recargar aunque haya caché. Antes el refresco borraba la caché con setState y
  // llamaba aquí en el mismo render: la clausura aún veía la caché vieja, retornaba sin pedir
  // nada y el detalle quedaba en "Cargando" para siempre (AIF07).
  async function loadStatement(driverId: string, force = false) {
    if (!force && driverStatements[driverId]) return;
    setLoadingStatement(driverId);
    try {
      const stmt = await api.getDriverStatement(driverId);
      setDriverStatements(prev => ({ ...prev, [driverId]: stmt }));
    } catch { }
    setLoadingStatement(null);
  }

  function handleExpand(workerId: string, workerName: string, role: string) {
    if (expandedId === workerId) { setExpandedId(null); return; }
    setExpandedId(workerId);
    if (role === "domiciliario") {
      const driver = findDriver(workerName);
      if (driver) loadStatement(driver.id);
    }
  }

  const admins = state.workers.filter(w => w.role === "administrativo");
  const domis = state.workers.filter(w => w.role === "domiciliario");
  const visibleWorkers = tab === "administrativos" ? admins : domis;

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-black">👥 Trabajadores</h1>
          <p className="text-sm text-muted-foreground">Gestión de personal y pagos</p>
        </div>
        <button
          onClick={() => setAdding(true)}
          className="flex items-center gap-2 bg-primary text-primary-foreground font-bold px-4 py-2.5 rounded-xl shadow-cash"
        >
          <Plus className="h-4 w-4" /> Agregar trabajador
        </button>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 p-1 bg-secondary/50 rounded-2xl w-fit">
        <TabBtn active={tab === "administrativos"} onClick={() => { setTab("administrativos"); setExpandedId(null); }}>
          <Building2 className="h-4 w-4" /> Administrativos ({admins.length})
        </TabBtn>
        <TabBtn active={tab === "domiciliarios"} onClick={() => { setTab("domiciliarios"); setExpandedId(null); }}>
          <Bike className="h-4 w-4" /> Domiciliarios ({domis.length})
        </TabBtn>
      </div>

      {/* Workers list */}
      {visibleWorkers.length === 0 ? (
        <div className="glass-strong rounded-3xl p-10 text-center text-muted-foreground">
          <p className="text-4xl mb-3">{tab === "administrativos" ? "🏢" : "🛵"}</p>
          <p className="font-bold">No hay {tab === "administrativos" ? "administrativos" : "domiciliarios"}</p>
          <button onClick={() => setAdding(true)} className="mt-3 px-4 py-2 bg-primary text-primary-foreground rounded-xl text-sm font-bold">+ Agregar</button>
        </div>
      ) : (
        <div className="space-y-3">
          {visibleWorkers.map(w => {
            const driver = tab === "domiciliarios" ? findDriver(w.name) : undefined;
            const stmt = driver ? driverStatements[driver.id] : undefined;
            const isExpanded = expandedId === w.id;
            const isLoadingStmt = driver && loadingStatement === driver.id;
            const pendingCommission = commissionsForWorker(state, w.id).filter(r => r.status === "pending").reduce((s, r) => s + r.commission, 0);

            // Nómina pagada (para administrativos)
            let payrollTotal = 0;
            if (tab === "administrativos") {
              for (const d of Object.keys(state.days)) {
                for (const m of state.days[d].movements) {
                  // Solo lo efectivamente pagado: una comisión pendiente no es nómina pagada.
                  if (m.workerId === w.id && (m.category === 15 || m.category === 18) && m.status === "confirmed") payrollTotal += m.amount;
                }
              }
            }

            return (
              <div key={w.id} className={`glass-strong rounded-3xl overflow-hidden ${!w.active ? "opacity-60" : ""}`}>
                {/* Card header */}
                <div className="p-5 flex items-center justify-between gap-4">
                  <div className="flex items-center gap-3">
                    <Avatar worker={w} size={44} />
                    <div>
                      <div className="font-bold flex items-center gap-2">
                        {w.name}
                        {driver && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-primary/10 text-primary font-bold">Shipday</span>}
                      </div>
                      <div className="text-xs text-muted-foreground capitalize">{w.role}</div>
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    {pendingCommission > 0 && (
                      <div className="text-right mr-2">
                        <div className="text-xs text-muted-foreground">Comisión por pagar</div>
                        <div className="font-black text-sm tnum text-amber-600">{formatCOP(pendingCommission)}</div>
                      </div>
                    )}
                    {/* Quick stat */}
                    {tab === "administrativos" && (
                      <div className="text-right mr-2 hidden sm:block">
                        <div className="text-xs text-muted-foreground">Nómina pagada</div>
                        <div className="font-black text-sm tnum">{formatCOP(payrollTotal)}</div>
                      </div>
                    )}
                    {tab === "domiciliarios" && driver && stmt && (
                      <div className="text-right mr-2 hidden sm:block">
                        <div className="text-xs text-muted-foreground">Deuda</div>
                        <div className={`font-black text-sm tnum ${stmt.pendingDebt > 0 ? "text-red-500" : "text-green-600"}`}>
                          {stmt.pendingDebt > 0 ? formatCOP(stmt.pendingDebt) : "Al día ✓"}
                        </div>
                      </div>
                    )}

                    <button onClick={() => setRenaming(w)} title={`Renombrar ${w.name}`} aria-label={`Renombrar ${w.name}`}
                      className="p-1.5 rounded-lg text-muted-foreground hover:bg-secondary hover:text-primary transition">
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                    <button
                      onClick={() => toggleWorker(w)}
                      title={w.active ? "Desactivar" : "Reactivar"}
                      className={`text-xs px-2.5 py-1 rounded-full font-bold ${w.active ? "bg-cash-soft text-cash" : "bg-secondary text-muted-foreground"}`}
                    >
                      {w.active ? "Activo" : "Inactivo"}
                    </button>
                    <button
                      onClick={() => handleExpand(w.id, w.name, w.role)}
                      className="p-1.5 rounded-lg hover:bg-secondary transition"
                    >
                      {isExpanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                    </button>
                  </div>
                </div>

                {/* Expanded: ADMINISTRATIVO */}
                {isExpanded && <PendingCommissions workerId={w.id} workerName={w.name} />}

                {isExpanded && tab === "administrativos" && (
                  <div className="border-t border-border px-5 pb-5 pt-4 space-y-4">
                    <div className="grid grid-cols-2 gap-3">
                      <StatBox label="Nómina pagada" value={formatCOP(payrollTotal)} />
                      <StatBox label="Pagos registrados" value={String(
                        Object.values(state.days).flatMap(d => d.movements)
                          .filter(m => m.workerId === w.id && (m.category === 15 || m.category === 18) && m.status === "confirmed").length
                      )} />
                    </div>
                    {w.active ? (
                      <button
                        onClick={() => setPayrollTarget(w.id)}
                        className="w-full flex items-center justify-center gap-2 py-3 bg-primary text-primary-foreground rounded-xl font-bold hover:opacity-90 transition"
                      >
                        <DollarSign className="h-4 w-4" /> Registrar pago
                      </button>
                    ) : (
                      <p className="text-xs text-center text-muted-foreground">Trabajador desactivado: conserva su historial; reactívalo para registrarle pagos.</p>
                    )}
                    {isAdmin && (
                      <button onClick={() => deleteWorker(w)}
                        className="w-full flex items-center justify-center gap-1.5 py-2 text-xs font-bold border border-red-500/30 text-red-500 rounded-xl hover:bg-red-500/10 transition">
                        <Trash2 className="h-3.5 w-3.5" /> Eliminar trabajador (solo sin historial)
                      </button>
                    )}
                  </div>
                )}

                {/* Expanded: DOMICILIARIO */}
                {isExpanded && tab === "domiciliarios" && (
                  <div className="border-t border-border px-5 pb-5 pt-4">
                    {isLoadingStmt ? (
                      <div className="flex items-center justify-center py-8 text-muted-foreground gap-2">
                        <Loader2 className="h-4 w-4 animate-spin" />
                        <span className="text-sm">Cargando datos de Shipday…</span>
                      </div>
                    ) : driver && stmt ? (
                      <div className="space-y-4">
                        <div className="grid grid-cols-3 gap-3">
                          <StatBox label="Pedidos" value={String(stmt.totalOrders)} />
                          <StatBox label="Valor total" value={formatCOP(stmt.totalValue)} />
                          <StatBox label="% empresa" value={formatCOP(stmt.totalCompany)} highlight />
                        </div>
                        {/* F14: comisión y base son cuentas separadas; se muestran por separado. */}
                        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                          <StatBox label="Bases recibidas" value={formatCOP(stmt.totalBasesGiven)} />
                          <StatBox label="Bases devueltas" value={formatCOP(stmt.totalBasesPaid)} />
                          <StatBox label="Base sin devolver" value={formatCOP(stmt.basePending ?? 0)} warn={(stmt.basePending ?? 0) > 0} />
                          <StatBox label="Deuda por comisiones" value={formatCOP(stmt.pendingDebt)} warn={stmt.pendingDebt > 0} />
                        </div>

                        {stmt.orders.length > 0 && (
                          <div>
                            <p className="text-xs font-bold text-muted-foreground uppercase tracking-wider mb-2">Últimos pedidos</p>
                            <div className="space-y-1 max-h-32 overflow-y-auto">
                              {stmt.orders.slice(0, 8).map(o => (
                                <div key={o.id} className="flex items-center justify-between px-3 py-1.5 rounded-xl bg-secondary/30 text-sm">
                                  <span className="text-muted-foreground text-xs">{o.deliveredAt ? new Date(o.deliveredAt).toLocaleDateString("es-CO") : "—"}</span>
                                  <span className="font-medium truncate mx-2">{o.customerName ?? `#${o.orderNumber}`}</span>
                                  <span className="font-bold tnum">{formatCOP(o.deliveryValue)}</span>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}

                        <div className="flex gap-2">
                          <button
                            onClick={() => setDriverPayTarget({ id: driver.id, name: w.name })}
                            className="flex-1 flex items-center justify-center gap-2 py-3 bg-primary text-primary-foreground rounded-xl font-bold hover:opacity-90 transition"
                          >
                            <DollarSign className="h-4 w-4" /> Registrar pago
                          </button>
                          <button onClick={() => loadStatement(driver.id, true)} className="px-4 py-3 border border-border rounded-xl text-sm hover:bg-secondary transition">↺</button>
                        </div>
                      </div>
                    ) : (
                      <div className="py-4 text-sm text-muted-foreground text-center">
                        {driver ? "Cargando…" : "Este domiciliario no tiene perfil en Shipday. Los pagos se registran automáticamente desde la API."}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Modal agregar */}
      {adding && (
        <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4" onClick={() => setAdding(false)}>
          <div className="glass-strong rounded-3xl max-h-[92vh] overflow-y-auto p-6 w-full max-w-sm" onClick={e => e.stopPropagation()}>
            <h3 className="text-xl font-bold mb-4">Nuevo trabajador</h3>
            <input autoFocus value={name} onChange={e => setName(e.target.value)} placeholder="Nombre" className="w-full glass rounded-xl px-4 py-3 outline-none mb-3" />
            <div className="grid grid-cols-2 gap-2">
              <button onClick={() => setRole("administrativo")} className={`p-3 rounded-xl border-2 ${role === "administrativo" ? "border-primary bg-cash-soft" : "border-border glass"}`}>🏢 Administrativo</button>
              <button onClick={() => setRole("domiciliario")} className={`p-3 rounded-xl border-2 ${role === "domiciliario" ? "border-accent bg-bank-soft" : "border-border glass"}`}>🛵 Domiciliario</button>
            </div>
            <button
              onClick={() => { if (name.trim()) { void addWorker({ name: name.trim(), role, active: true }); setName(""); setAdding(false); } }}
              className="mt-4 w-full bg-primary text-primary-foreground font-bold py-3 rounded-xl shadow-cash"
            >
              Agregar
            </button>
          </div>
        </div>
      )}

      {renaming && (
        <RenameWorkerModal
          worker={renaming}
          linkedToShipday={renaming.role === "domiciliario" && !!findDriver(renaming.name)}
          onClose={() => setRenaming(null)}
          onSave={async (name) => {
            if (await updateWorker(renaming.id, { name })) { toast.success(`Nombre actualizado: ${name}`); setRenaming(null); }
          }}
        />
      )}

      {payrollTarget && (
        <PayrollWizard open={true} onOpenChange={v => { if (!v) setPayrollTarget(null); }} presetWorkerId={payrollTarget} date={today} />
      )}

      {driverPayTarget && (
        <DriverPaymentWizard
          open={true}
          onOpenChange={v => {
            if (!v) {
              const prev = driverPayTarget;
              setDriverPayTarget(null);
              loadStatement(prev.id, true);
            }
          }}
          driverId={driverPayTarget.id}
          driverName={driverPayTarget.name}
          statement={driverStatements[driverPayTarget.id]}
          onDone={() => loadStatement(driverPayTarget.id, true)}
        />
      )}
    </div>
  );
}

function RenameWorkerModal({ worker, linkedToShipday, onClose, onSave }: {
  worker: Worker; linkedToShipday: boolean; onClose: () => void; onSave: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState(worker.name);
  const [saving, setSaving] = useState(false);
  const clean = name.trim().replace(/\s+/g, " ");
  const invalid = !clean || clean.length > 80 || clean === worker.name;
  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4" onClick={onClose}>
      <div className="glass-strong rounded-3xl max-h-[92vh] overflow-y-auto p-6 w-full max-w-sm space-y-4" onClick={e => e.stopPropagation()}>
        <h3 className="font-black text-lg">Renombrar trabajador</h3>
        <p className="text-xs text-muted-foreground">Nombre actual: <b>{worker.name}</b>. Es el mismo trabajador: sus pagos e historial se conservan.</p>
        <input value={name} onChange={e => setName(e.target.value)} autoFocus maxLength={80} aria-label="Nuevo nombre"
          className="w-full glass rounded-xl px-4 py-3 outline-none focus:ring-2 focus:ring-primary/40" />
        {linkedToShipday && (
          <p className="text-[11px] text-amber-600">Este domiciliario se enlaza con Shipday por nombre. Si el nombre nuevo deja de coincidir con el de Shipday, aquí dejará de verse su estado de cuenta (los pedidos y la deuda no cambian).</p>
        )}
        {!clean && <p className="text-xs text-red-500">El nombre no puede quedar vacío.</p>}
        <div className="grid grid-cols-2 gap-2">
          <button onClick={onClose} className="py-3 rounded-xl border border-border font-bold hover:bg-secondary transition">Cancelar</button>
          <button disabled={invalid || saving}
            onClick={async () => { setSaving(true); await onSave(clean); setSaving(false); }}
            className="py-3 rounded-xl bg-primary text-primary-foreground font-bold disabled:opacity-40">
            {saving ? "Guardando…" : "Guardar nombre"}
          </button>
        </div>
      </div>
    </div>
  );
}

function TabBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-bold transition ${active ? "bg-background shadow text-foreground" : "text-muted-foreground hover:text-foreground"}`}
    >
      {children}
    </button>
  );
}

function StatBox({ label, value, highlight, warn }: { label: string; value: string; highlight?: boolean; warn?: boolean }) {
  return (
    <div className="glass rounded-xl p-3 text-center">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className={`text-sm font-black tnum mt-0.5 ${highlight ? "text-primary" : warn ? "text-red-500" : ""}`}>{value}</div>
    </div>
  );
}

/**
 * Comisiones de domicilios manuales (Configuración → porcentaje) que siguen pendientes.
 * AIF13: la antigua página Nómina las liquidaba; al redirigirla a Trabajadores ese flujo se
 * perdió y la comisión quedaba pendiente para siempre. Pagarla la confirma con el medio elegido
 * y la fecha del día operativo en curso: el dinero sale el día que se paga, no el día que se
 * ganó (ese día puede estar ya cerrado).
 */
function PendingCommissions({ workerId, workerName }: { workerId: string; workerName: string }) {
  const { state, updateMovement, refreshDay } = useStore();
  const { operatingDay } = useDay();
  const [busy, setBusy] = useState(false);
  const rows = commissionsForWorker(state, workerId).filter(r => r.status === "pending");
  if (rows.length === 0) return null;
  const total = rows.reduce((s, r) => s + r.commission, 0);

  async function pay(targets: typeof rows, medium: "cash" | "bank") {
    if (busy) return;
    const amount = targets.reduce((s, r) => s + r.commission, 0);
    if (!confirm(`¿Pagar ${formatCOP(amount)} de comisión a ${workerName} en ${medium === "cash" ? "efectivo" : "banco"}? Sale de la caja del día ${operatingDay}.`)) return;
    setBusy(true);
    let paid = 0;
    try {
      for (const r of targets) {
        await updateMovement(r.date, r.id, {
          status: "confirmed",
          medium,
          category: medium === "cash" ? 15 : 18,
          date: operatingDay,
        });
        paid += r.commission;
      }
      toast.success(`✅ Comisión pagada a ${workerName}: ${formatCOP(paid)}`);
    } catch {
      // El store ya mostró el motivo del rechazo; lo pagado antes del error queda registrado.
      if (paid > 0) toast.warning(`Se pagaron ${formatCOP(paid)}; el resto quedó pendiente.`);
    } finally {
      await refreshDay(operatingDay).catch(() => {});
      setBusy(false);
    }
  }

  return (
    <div className="border-t border-border px-5 pt-4 pb-1 space-y-2">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <p className="text-xs font-bold text-amber-600 uppercase tracking-wider">Comisiones de domicilios por pagar · {formatCOP(total)}</p>
        <div className="flex gap-2">
          <button disabled={busy} onClick={() => pay(rows, "cash")} className="text-xs px-3 py-1.5 rounded-lg bg-primary text-primary-foreground font-bold disabled:opacity-50">💵 Pagar todo en efectivo</button>
          <button disabled={busy} onClick={() => pay(rows, "bank")} className="text-xs px-3 py-1.5 rounded-lg border border-border font-bold disabled:opacity-50">🏦 Pagar todo por banco</button>
        </div>
      </div>
      <div className="space-y-1">
        {rows.map(r => (
          <div key={r.id} className="flex items-center justify-between gap-2 px-3 py-1.5 rounded-xl bg-amber-500/5 text-sm">
            <span className="text-xs text-muted-foreground">{r.date} · domicilio {formatCOP(r.deliveryValue)}</span>
            <span className="font-bold tnum">{formatCOP(r.commission)}</span>
            <span className="flex gap-1">
              <button disabled={busy} onClick={() => pay([r], "cash")} title="Pagar en efectivo" className="text-xs px-2 py-1 rounded-lg border border-border disabled:opacity-50">💵</button>
              <button disabled={busy} onClick={() => pay([r], "bank")} title="Pagar por banco" className="text-xs px-2 py-1 rounded-lg border border-border disabled:opacity-50">🏦</button>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
