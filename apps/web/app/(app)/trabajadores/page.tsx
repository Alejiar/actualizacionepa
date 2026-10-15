"use client";

import { useEffect, useState } from "react";
import { useStore } from "@/lib/store";
import { Avatar } from "@/components/Avatar";
import { formatCOP, todayBogota } from "@/lib/format";
import { Plus, Bike, Building2, ChevronDown, ChevronUp, DollarSign, Loader2 } from "lucide-react";
import * as api from "@/lib/sd-api";
import type { DriverStatement } from "@/lib/sd-api";
import { PayrollWizard } from "@/components/wizards/PayrollWizard";
import { DriverPaymentWizard } from "@/components/wizards/DriverPaymentWizard";

type Tab = "administrativos" | "domiciliarios";

export default function WorkersPage() {
  const { state, addWorker, updateWorker } = useStore();
  const [tab, setTab] = useState<Tab>("administrativos");
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [role, setRole] = useState<"domiciliario" | "administrativo">("administrativo");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [payrollTarget, setPayrollTarget] = useState<string | null>(null);
  const [driverPayTarget, setDriverPayTarget] = useState<{ id: string; name: string } | null>(null);
  // Bogotá, no UTC: pasadas las 7pm hora Bogotá, el UTC ya cayó en el día
  // siguiente y una nómina registrada esa noche quedaba fechada un día después.
  const today = todayBogota();

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

  async function loadStatement(driverId: string) {
    if (driverStatements[driverId]) return;
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

            // Nómina pagada (para administrativos)
            let payrollTotal = 0;
            if (tab === "administrativos") {
              for (const d of Object.keys(state.days)) {
                for (const m of state.days[d].movements) {
                  if (m.workerId === w.id && (m.category === 15 || m.category === 18)) payrollTotal += m.amount;
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

                    <button
                      onClick={() => updateWorker(w.id, { active: !w.active })}
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
                {isExpanded && tab === "administrativos" && (
                  <div className="border-t border-border px-5 pb-5 pt-4 space-y-4">
                    <div className="grid grid-cols-2 gap-3">
                      <StatBox label="Nómina pagada" value={formatCOP(payrollTotal)} />
                      <StatBox label="Pagos registrados" value={String(
                        Object.values(state.days).flatMap(d => d.movements)
                          .filter(m => m.workerId === w.id && (m.category === 15 || m.category === 18)).length
                      )} />
                    </div>
                    <button
                      onClick={() => setPayrollTarget(w.id)}
                      className="w-full flex items-center justify-center gap-2 py-3 bg-primary text-primary-foreground rounded-xl font-bold hover:opacity-90 transition"
                    >
                      <DollarSign className="h-4 w-4" /> Registrar pago
                    </button>
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
                          <button onClick={() => { setDriverStatements(p => { const n = { ...p }; delete n[driver.id]; return n; }); loadStatement(driver.id); }} className="px-4 py-3 border border-border rounded-xl text-sm hover:bg-secondary transition">↺</button>
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
          <div className="glass-strong rounded-3xl p-6 w-full max-w-sm" onClick={e => e.stopPropagation()}>
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
              setDriverStatements(p => { const n = { ...p }; delete n[prev.id]; return n; });
              loadStatement(prev.id);
            }
          }}
          driverId={driverPayTarget.id}
          driverName={driverPayTarget.name}
          statement={driverStatements[driverPayTarget.id]}
          onDone={() => {
            setDriverStatements(p => { const n = { ...p }; delete n[driverPayTarget.id]; return n; });
            loadStatement(driverPayTarget.id);
          }}
        />
      )}
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
