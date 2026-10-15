"use client";

import { useEffect, useState } from "react";
import { Plus, RefreshCw, CheckCircle2, AlertTriangle, Pencil, Trash2 } from "lucide-react";
import { useLive } from "@/lib/use-live";
import { toast } from "sonner";
import * as api from "@/lib/sd-api";
import type { Driver, Branch, BaseTransaction } from "@/lib/sd-api";
import { formatCOP, prettyDate } from "@/lib/format";
import { useDay } from "@/lib/day-context";
import { useAuth } from "@/lib/auth";
import { EditRequestWizard, type EditableField } from "@/components/wizards/EditRequestWizard";
import { DeleteRequestWizard } from "@/components/wizards/DeleteRequestWizard";

export default function BasesPage() {
  const [bases, setBases] = useState<BaseTransaction[]>([]);
  const [drivers, setDrivers] = useState<Driver[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [branchId, setBranchId] = useState("");
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState<"give" | "pay" | null>(null);
  const [formDriver, setFormDriver] = useState("");
  const [formCash, setFormCash] = useState("");
  const [formBank, setFormBank] = useState("");
  const [formNotes, setFormNotes] = useState("");
  const [search, setSearch] = useState("");
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const [editBaseReq, setEditBaseReq] = useState<BaseTransaction | null>(null);
  const [deleteBaseReq, setDeleteBaseReq] = useState<BaseTransaction | null>(null);
  const [saving, setSaving] = useState(false);
  // Día seleccionado en el sistema (flechas de fecha de la cabecera) — igual que Pedidos.
  const { date, operatingDay } = useDay();
  const isToday = date === operatingDay;

  const load = async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const [b, d, br] = await Promise.all([
        api.getBases({ branchId: branchId || undefined, from: date, to: date }),
        api.getDrivers(branchId || undefined),
        api.getBranches(),
      ]);
      setBases(prev => JSON.stringify(prev) === JSON.stringify(b) ? prev : b);
      setDrivers(prev => JSON.stringify(prev) === JSON.stringify(d) ? prev : d);
      setBranches(prev => JSON.stringify(prev) === JSON.stringify(br) ? prev : br);
    } catch { if (!silent) toast.error("Error al cargar"); }
    if (!silent) setLoading(false);
  };

  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [branchId, date]);
  useLive(() => load(true), 5000);

  async function handleDeleteBase(b: BaseTransaction) {
    if (!isAdmin) { setDeleteBaseReq(b); return; } // no admin → solicitud
    const tipo = b.type === "entrega" ? "entrega de base" : "devolución de base";
    if (!confirm(`¿Eliminar esta ${tipo} de ${formatCOP(b.amount)}?`)) return;
    try { await api.deleteBase(b.id); toast.success("Movimiento eliminado"); load(); }
    catch (err) { toast.error(String(err)); }
  }
  async function handleEditBase(b: BaseTransaction) {
    if (!isAdmin) { setEditBaseReq(b); return; } // no admin → solicitud al administrador
    // admin → edición directa
    const curCash = b.cashAmount ?? b.amount;
    const curBank = b.bankAmount ?? 0;
    const cashStr = prompt(`Efectivo (actual ${formatCOP(curCash)}):`, String(curCash));
    if (cashStr === null) return;
    const bankStr = prompt(`Transferencia (actual ${formatCOP(curBank)}):`, String(curBank));
    if (bankStr === null) return;
    const cashAmount = parseInt(cashStr.replace(/\D/g, "") || "0");
    const bankAmount = parseInt(bankStr.replace(/\D/g, "") || "0");
    if (cashAmount + bankAmount <= 0) { toast.error("El monto debe ser mayor a cero"); return; }
    try {
      await api.editBase(b.id, { cashAmount, bankAmount, amount: cashAmount + bankAmount });
      toast.success("Movimiento actualizado"); load();
    } catch (err) { toast.error(String(err)); }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const cashAmount = parseInt(formCash.replace(/\D/g, "")) || 0;
    const bankAmount = parseInt(formBank.replace(/\D/g, "")) || 0;
    if (!formDriver || (cashAmount + bankAmount) <= 0) { toast.error("Selecciona domiciliario e ingresa al menos un monto"); return; }
    setSaving(true);
    try {
      const data = { cashAmount, bankAmount, notes: formNotes || undefined };
      if (showForm === "give") await api.giveBase(formDriver, data);
      else await api.payBase(formDriver, data);
      toast.success(showForm === "give" ? "Base entregada registrada" : "Devolución de base registrada");
      setShowForm(null);
      setFormDriver(""); setFormCash(""); setFormBank(""); setFormNotes("");
      load();
    } catch (err) { toast.error(String(err)); }
    setSaving(false);
  };

  const totalGiven = bases.filter(b => b.type === "entrega").reduce((s, b) => s + b.amount, 0);
  const totalPaid = bases.filter(b => b.type === "pago").reduce((s, b) => s + b.amount, 0);

  // Agrupar bases por domiciliario con su saldo y split efectivo/transferencia
  const groupMap = new Map<string, {
    driverId: string; name: string;
    given: number; givenCash: number; givenBank: number;
    paid: number; paidCash: number; paidBank: number; balance: number;
  }>();
  for (const b of bases) {
    const g = groupMap.get(b.driverId) ?? {
      driverId: b.driverId, name: b.driver?.name ?? "—",
      given: 0, givenCash: 0, givenBank: 0, paid: 0, paidCash: 0, paidBank: 0, balance: 0,
    };
    const cash = b.cashAmount ?? (b.bankAmount ? 0 : b.amount);
    const bank = b.bankAmount ?? 0;
    if (b.type === "entrega") { g.given += b.amount; g.givenCash += cash; g.givenBank += bank; }
    else { g.paid += b.amount; g.paidCash += cash; g.paidBank += bank; }
    groupMap.set(b.driverId, g);
  }
  // F14 (14-oct-2026): ESTADO de base por domiciliario = base sin devolver PURA del backend
  // (listDrivers.basePending = entregadas − devueltas, todo el historial). La base ya no se
  // concilia con la deuda por comisiones ni se "salda" con crédito: lo devuelto es lo devuelto.
  const basePendingByDriver = new Map(drivers.map(d => [d.id, d.basePending ?? 0]));
  const settledOf = (_given: number, paid: number) => paid;
  const driverGroups = [...groupMap.values()]
    .map(g => {
      const balance = basePendingByDriver.get(g.driverId) ?? 0;
      const settled = settledOf(g.given, g.paid);
      return { ...g, balance, settled, creditSettled: Math.max(0, settled - g.paid) };
    })
    .filter(g => !search.trim() || g.name.toLowerCase().includes(search.toLowerCase()))
    // Primero los que deben (rojo), luego cuadrados; dentro, mayor saldo primero y alfabético como criterio final
    .sort((a, b) => (b.balance - a.balance) || a.name.localeCompare(b.name, "es"));

  // Totales del día para las tarjetas de arriba, con el mismo criterio conciliado.
  const totalSettled = [...groupMap.values()].reduce((s, g) => s + settledOf(g.given, g.paid), 0);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-black">Bases</h1>
          <p className="text-sm text-muted-foreground">Control de dinero base entregado a domiciliarios</p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => setShowForm("give")} className="flex items-center gap-2 px-3 py-2 bg-orange-500 text-white rounded-xl text-sm font-bold hover:opacity-90 transition">
            <Plus className="h-4 w-4" /> Entregar base
          </button>
          <button onClick={() => setShowForm("pay")} className="flex items-center gap-2 px-3 py-2 bg-green-600 text-white rounded-xl text-sm font-bold hover:opacity-90 transition">
            <Plus className="h-4 w-4" /> Registrar devolución de base
          </button>
        </div>
      </div>

      <div className="flex gap-3 flex-wrap items-center">
        <select value={branchId} onChange={e => setBranchId(e.target.value)} className="px-3 py-2 rounded-xl border border-border bg-background text-sm">
          <option value="">Todas las sucursales</option>
          {branches.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
        </select>
        <button onClick={() => load()} className="p-2 rounded-xl border border-border hover:bg-secondary transition"><RefreshCw className="h-4 w-4" /></button>
        <span className="text-xs text-muted-foreground flex items-center gap-1.5 px-3 py-2 rounded-xl bg-secondary/40">
          📅 Mostrando el día <strong className="capitalize text-foreground">{isToday ? "de hoy" : prettyDate(date)}</strong> — usa las flechas de fecha (arriba) para cambiar de día.
        </span>
      </div>

      <div className="grid grid-cols-3 gap-4">
        <div className="glass-strong rounded-2xl p-4">
          <p className="text-xs text-muted-foreground">Entregado {isToday ? "hoy" : "ese día"}</p>
          <p className="font-black text-xl tnum text-orange-500 mt-1">{formatCOP(totalGiven)}</p>
        </div>
        <div className="glass-strong rounded-2xl p-4">
          <p className="text-xs text-muted-foreground">Devuelto / saldado {isToday ? "hoy" : "ese día"}</p>
          <p className="font-black text-xl tnum text-green-600 mt-1">{formatCOP(totalSettled)}</p>
          {totalSettled > totalPaid && (
            <p className="text-[11px] text-muted-foreground mt-0.5">Devuelto {formatCOP(totalPaid)} + {formatCOP(totalSettled - totalPaid)} con saldo a favor</p>
          )}
        </div>
        <div className="glass-strong rounded-2xl p-4">
          <p className="text-xs text-muted-foreground">Base sin devolver (conciliada)</p>
          <p className={`font-black text-xl tnum mt-1 ${totalGiven - totalSettled > 0 ? "text-red-500" : "text-muted-foreground"}`}>{formatCOP(totalGiven - totalSettled)}</p>
        </div>
      </div>

      {/* Buscador */}
      <input
        value={search}
        onChange={e => setSearch(e.target.value)}
        placeholder="🔍 Buscar domiciliario…"
        className="w-full sm:w-72 px-4 py-2 rounded-xl border border-border bg-background text-sm outline-none focus:ring-2 focus:ring-primary/30"
      />

      {/* Agrupado por domiciliario: verde si cuadró, rojo si aún debe base */}
      {loading ? (
        <div className="text-center py-12 text-muted-foreground">Cargando...</div>
      ) : driverGroups.length === 0 ? (
        <div className="glass-strong rounded-3xl p-12 text-center text-muted-foreground">
          {isToday ? "Sin registros de bases hoy" : "Sin registros de bases ese día"}
        </div>
      ) : (
        <div className="space-y-3">
          {driverGroups.map(g => {
            const debe = g.balance > 0;
            return (
              <div key={g.driverId} className={`glass-strong rounded-2xl p-4 ${debe ? "border-2 border-red-500 bg-red-500/10" : "border border-green-500/30 bg-green-500/[0.05]"}`}>
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <div className="flex items-center gap-2">
                    <span className="font-bold">{g.name}</span>
                    {debe
                      ? <span className="flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded-full font-bold bg-red-500 text-white"><AlertTriangle className="h-3 w-3" /> Debe base</span>
                      : <span className="flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded-full font-bold bg-green-500/20 text-green-700"><CheckCircle2 className="h-3 w-3" /> Cuadrado</span>}
                  </div>
                  <div className="flex items-center gap-2">
                    {debe && (
                      <button onClick={() => { setShowForm("pay"); setFormDriver(g.driverId); }}
                        className="text-xs px-3 py-1.5 rounded-lg bg-green-600 text-white font-bold hover:bg-green-700 transition">
                        Registrar devolución
                      </button>
                    )}
                    <span className={`font-black text-lg tnum ${debe ? "text-red-500" : "text-green-600"}`}>
                      {debe ? `Debe ${formatCOP(g.balance)}` : "Base al día"}
                    </span>
                  </div>
                </div>
                {/* Estado (Debe/Al día) = base TOTAL conciliada con su deuda (fuente única), no la
                    resta cruda del día. Los recuadros muestran el movimiento del día ya conciliado:
                    "Devuelto / saldado" incluye lo devuelto en efectivo/banco MÁS lo saldado con su
                    saldo a favor, para que Entregado − Devuelto = lo que realmente debe. */}
                <div className="grid grid-cols-2 gap-2 mt-3">
                  <div className="rounded-xl bg-background/50 px-3 py-2">
                    <div className="text-xs font-bold text-orange-600">📤 Entregado {isToday ? "hoy" : "ese día"}</div>
                    <div className="font-black tnum text-orange-600 mt-0.5">−{formatCOP(g.given)}</div>
                    <div className="text-[11px] text-muted-foreground">💵 {formatCOP(g.givenCash)} · 🏦 {formatCOP(g.givenBank)}</div>
                  </div>
                  <div className="rounded-xl bg-background/50 px-3 py-2">
                    <div className="text-xs font-bold text-green-600">📥 Devuelto / saldado {isToday ? "hoy" : "ese día"}</div>
                    <div className="font-black tnum text-green-600 mt-0.5">+{formatCOP(g.settled)}</div>
                    {g.creditSettled > 0
                      ? <div className="text-[11px] text-muted-foreground">Devuelto {formatCOP(g.paid)} + {formatCOP(g.creditSettled)} con saldo a favor</div>
                      : <div className="text-[11px] text-muted-foreground">💵 {formatCOP(g.paidCash)} · 🏦 {formatCOP(g.paidBank)}</div>}
                  </div>
                </div>
                {/* Movimientos individuales con editar / eliminar */}
                <div className="mt-3 space-y-1.5">
                  {bases.filter(b => b.driverId === g.driverId)
                    .sort((a, b) => b.date.localeCompare(a.date))
                    .map(b => (
                      <div key={b.id} className="flex items-center justify-between gap-2 rounded-lg bg-background/40 px-3 py-1.5 text-xs">
                        <div className="min-w-0">
                          <span className={`font-bold ${b.type === "entrega" ? "text-orange-600" : "text-green-600"}`}>
                            {b.type === "entrega" ? "📤 Entrega" : "📥 Devolución"} {formatCOP(b.amount)}
                          </span>
                          <span className="text-muted-foreground ml-2">
                            💵 {formatCOP(b.cashAmount ?? b.amount)} · 🏦 {formatCOP(b.bankAmount ?? 0)}
                          </span>
                          <span className="text-muted-foreground ml-2">{new Date(b.date + "T12:00:00").toLocaleDateString("es-CO", { day: "2-digit", month: "short" })}</span>
                          {b.notes && <span className="text-muted-foreground ml-2 truncate">· {b.notes}</span>}
                        </div>
                        <div className="flex items-center gap-1 shrink-0">
                          <button
                            onClick={() => handleEditBase(b)}
                            title={isAdmin ? "Editar" : "Solicitar edición (requiere aprobación del administrador)"}
                            className="p-1.5 rounded-lg hover:bg-secondary transition text-muted-foreground hover:text-foreground"
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </button>
                          <button
                            onClick={() => handleDeleteBase(b)}
                            title={isAdmin ? "Eliminar" : "Solicitar eliminación (requiere aprobación del administrador)"}
                            className="p-1.5 rounded-lg hover:bg-red-500/10 transition text-muted-foreground hover:text-red-500"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </div>
                    ))}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {showForm && (
        <div className="fixed inset-0 bg-background/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="glass-strong rounded-3xl p-6 w-full max-w-sm space-y-4">
            <h2 className="font-black text-lg">{showForm === "give" ? "Entregar base" : "Registrar devolución de base"}</h2>
            <form onSubmit={handleSubmit} className="space-y-3">
              <div>
                <label className="text-xs text-muted-foreground font-medium">Domiciliario</label>
                <select value={formDriver} onChange={e => setFormDriver(e.target.value)} required
                  className="w-full mt-1 px-3 py-2.5 rounded-xl border border-border bg-background text-sm">
                  <option value="">Seleccionar...</option>
                  {drivers.map(d => <option key={d.id} value={d.id}>{d.name} ({d.branch.name})</option>)}
                </select>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-xs text-muted-foreground font-medium">💵 Efectivo</label>
                  <input type="text" inputMode="numeric" value={formCash} onChange={e => setFormCash(e.target.value.replace(/\D/g, ""))} placeholder="0"
                    className="w-full mt-1 px-3 py-2.5 rounded-xl border border-border bg-background text-sm tnum" />
                </div>
                <div>
                  <label className="text-xs text-muted-foreground font-medium">🏦 Transferencia</label>
                  <input type="text" inputMode="numeric" value={formBank} onChange={e => setFormBank(e.target.value.replace(/\D/g, ""))} placeholder="0"
                    className="w-full mt-1 px-3 py-2.5 rounded-xl border border-border bg-background text-sm tnum" />
                </div>
              </div>
              <div className="text-xs text-muted-foreground text-right">
                Total: <span className="font-bold text-foreground">{formatCOP((parseInt(formCash.replace(/\D/g,""))||0)+(parseInt(formBank.replace(/\D/g,""))||0))}</span>
              </div>
              <div>
                <label className="text-xs text-muted-foreground font-medium">Notas (opcional)</label>
                <input type="text" value={formNotes} onChange={e => setFormNotes(e.target.value)} placeholder="Observaciones..."
                  className="w-full mt-1 px-3 py-2.5 rounded-xl border border-border bg-background text-sm" />
              </div>
              <div className="flex gap-3 pt-2">
                <button type="button" onClick={() => setShowForm(null)} className="flex-1 py-2.5 rounded-xl border border-border hover:bg-secondary transition">Cancelar</button>
                <button type="submit" disabled={saving}
                  className={`flex-1 py-2.5 rounded-xl font-bold text-white transition disabled:opacity-50 ${showForm === "give" ? "bg-orange-500 hover:bg-orange-600" : "bg-green-600 hover:bg-green-700"}`}>
                  {saving ? "..." : showForm === "give" ? "Entregar" : "Registrar devolución"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* No admin: solicitud de edición de base */}
      {editBaseReq && (
        <EditRequestWizard
          open={!!editBaseReq}
          onOpenChange={(v) => { if (!v) setEditBaseReq(null); }}
          entityType="BaseTransaction"
          entityId={editBaseReq.id}
          entityLabel={`${editBaseReq.type === "entrega" ? "Entrega" : "Devolución"} de base — ${formatCOP(editBaseReq.amount)}`}
          fields={[
            { field: "cashAmount", label: "💵 Efectivo", currentValue: String(editBaseReq.cashAmount ?? editBaseReq.amount), type: "money" },
            { field: "bankAmount", label: "🏦 Transferencia", currentValue: String(editBaseReq.bankAmount ?? 0), type: "money" },
            { field: "notes", label: "Notas", currentValue: editBaseReq.notes ?? "", type: "text" },
          ] satisfies EditableField[]}
          onDone={load}
        />
      )}

      {/* No admin: solicitud de eliminación de base */}
      {deleteBaseReq && (
        <DeleteRequestWizard
          open={!!deleteBaseReq}
          onOpenChange={(v) => { if (!v) setDeleteBaseReq(null); }}
          entityType="BaseTransaction"
          entityId={deleteBaseReq.id}
          entityLabel={`${deleteBaseReq.type === "entrega" ? "Entrega" : "Devolución"} de base — ${formatCOP(deleteBaseReq.amount)}`}
          onDone={load}
        />
      )}
    </div>
  );
}
