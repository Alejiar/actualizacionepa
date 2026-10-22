"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import * as api from "@/lib/sd-api";
import type { DriverDebt, Branch } from "@/lib/sd-api";
import { formatCOP } from "@/lib/format";
import { DriverStatementModal } from "@/components/DriverStatementModal";
import { LiveBadge } from "@/components/LiveBadge";

export default function DeudasPage() {
  const [debtors, setDebtors] = useState<DriverDebt[]>([]);
  const [creditors, setCreditors] = useState<DriverDebt[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [branchId, setBranchId] = useState("");
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<DriverDebt | null>(null);
  const [paying, setPaying] = useState<DriverDebt | null>(null);
  const [search, setSearch] = useState("");
  const [sortBy, setSortBy] = useState<"debt" | "alpha">("debt");

  function parseResponse(raw: unknown) {
    if (!raw || typeof raw !== "object") return { debtors: [], creditors: [] };
    if (Array.isArray(raw)) return { debtors: raw as DriverDebt[], creditors: [] };
    const r = raw as { debtors?: DriverDebt[]; creditors?: DriverDebt[] };
    return { debtors: r.debtors ?? [], creditors: r.creditors ?? [] };
  }

  const load = async () => {
    setLoading(true);
    try {
      const [raw, b] = await Promise.all([api.getDebtsDashboard(branchId || undefined), api.getBranches()]);
      const { debtors: d, creditors: c } = parseResponse(raw);
      setDebtors(d);
      setCreditors(c);
      setBranches(b);
    } catch { toast.error("Error al cargar deudas"); }
    setLoading(false);
  };

  useEffect(() => { load(); // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [branchId]);

  useEffect(() => {
    const t = setInterval(() => {
      api.getDebtsDashboard(branchId || undefined).then(raw => {
        const { debtors: d, creditors: c } = parseResponse(raw);
        setDebtors(d); setCreditors(c);
      }).catch(() => {});
    }, 12_000);
    return () => clearInterval(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [branchId]);

  // F14: comisiones y base son cuentas separadas (no se compensan con el crédito).
  const owed = (d: DriverDebt) => (d.pendingDebt ?? 0) + (d.basePending ?? 0);
  const totalDebt = (debtors ?? []).reduce((s, d) => s + (d.pendingDebt ?? 0), 0);
  const totalBase = (debtors ?? []).reduce((s, d) => s + (d.basePending ?? 0), 0);
  const totalCredit = (creditors ?? []).reduce((s, d) => s + (d.creditAmount ?? 0), 0);
  const highDebt = (debtors ?? []).filter(d => owed(d) > 100000);

  // Búsqueda + orden de la lista de deudores.
  const q = search.trim().toLowerCase();
  const viewDebtors = (debtors ?? [])
    .filter(d => !q || d.name.toLowerCase().includes(q))
    .sort((a, b) => sortBy === "alpha"
      ? a.name.localeCompare(b.name, "es", { sensitivity: "base" })
      : owed(b) - owed(a));

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-black">Dashboard de Deudas</h1>
            <LiveBadge />
          </div>
          <p className="text-sm text-muted-foreground">{debtors.length} domiciliarios deben · comisiones {formatCOP(totalDebt)} · base sin devolver {formatCOP(totalBase)}</p>
        </div>
        <div className="flex gap-2">
          <select value={branchId} onChange={e => setBranchId(e.target.value)} className="px-3 py-2 rounded-xl border border-border bg-background text-sm">
            <option value="">Todas las sucursales</option>
            {branches.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
          <button onClick={load} className="p-2 rounded-xl border border-border hover:bg-secondary transition"><RefreshCw className="h-4 w-4" /></button>
        </div>
      </div>

      {highDebt.length > 0 && (
        <div className="bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 rounded-2xl p-4">
          <div className="flex items-center gap-2 mb-2">
            <AlertTriangle className="h-5 w-5 text-red-500" />
            <span className="font-bold text-red-700 dark:text-red-400">Deudas altas (más de $100.000)</span>
          </div>
          <div className="flex flex-wrap gap-2">
            {highDebt.map(d => (
              <span key={d.id} className="px-3 py-1.5 bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-300 rounded-xl text-sm font-bold">
                {d.name} · {formatCOP(owed(d))}
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="glass-strong rounded-2xl p-4">
          <p className="text-xs text-muted-foreground">Deuda por comisiones</p>
          <p className="font-black text-2xl tnum text-red-500 mt-1">{formatCOP(totalDebt)}</p>
        </div>
        <div className="glass-strong rounded-2xl p-4">
          <p className="text-xs text-muted-foreground">Base sin devolver</p>
          <p className="font-black text-2xl tnum text-amber-600 mt-1">{formatCOP(totalBase)}</p>
          <p className="text-xs text-muted-foreground">{debtors.length} domiciliarios deben</p>
        </div>
        <div className="glass-strong rounded-2xl p-4">
          <p className="text-xs text-muted-foreground">Total crédito (empresa debe)</p>
          <p className="font-black text-2xl tnum text-amber-500 mt-1">{formatCOP(totalCredit)}</p>
        </div>
        <div className="glass-strong rounded-2xl p-4">
          <p className="text-xs text-muted-foreground">Deuda alta (&gt;$100k)</p>
          <p className={`font-black text-2xl tnum mt-1 ${highDebt.length > 0 ? "text-red-500" : ""}`}>{highDebt.length}</p>
        </div>
      </div>

      {loading ? (
        <div className="text-center py-20 text-muted-foreground">Cargando...</div>
      ) : (
        <div className="space-y-6">
          {/* Buscador + orden */}
          {debtors.length > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative flex-1 min-w-[200px]">
                <input
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  autoComplete="off" spellCheck={false}
                  placeholder="Buscar domiciliario…"
                  className="w-full glass rounded-xl pl-9 pr-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-primary/40 bg-background border border-border"
                />
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">🔍</span>
              </div>
              <div className="flex gap-1 rounded-xl border border-border p-1 bg-background">
                <button onClick={() => setSortBy("debt")}
                  className={`px-3 py-1.5 rounded-lg text-xs font-bold transition ${sortBy === "debt" ? "bg-primary text-primary-foreground" : "hover:bg-secondary"}`}>
                  Mayor deuda
                </button>
                <button onClick={() => setSortBy("alpha")}
                  className={`px-3 py-1.5 rounded-lg text-xs font-bold transition ${sortBy === "alpha" ? "bg-primary text-primary-foreground" : "hover:bg-secondary"}`}>
                  A–Z
                </button>
              </div>
            </div>
          )}

          {/* Domiciliarios que deben a la empresa — ROJO */}
          {debtors.length > 0 && (
            <div className="glass-strong rounded-3xl overflow-hidden">
              <div className="px-5 py-3 border-b border-border bg-red-500/5 flex items-center gap-2">
                <span className="w-3 h-3 rounded-full bg-red-500 shrink-0" />
                <span className="font-bold text-sm">Domiciliarios que deben a la empresa</span>
                <span className="text-xs text-muted-foreground ml-auto">{viewDebtors.length} de {debtors.length}</span>
              </div>
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-muted-foreground text-xs uppercase">
                    <th className="text-left px-5 py-3">Pos.</th>
                    <th className="text-left px-5 py-3">Domiciliario</th>
                    <th className="text-left px-5 py-3">Sucursal</th>
                    <th className="text-right px-5 py-3">Comisiones</th>
                    <th className="text-right px-5 py-3">Base</th>
                    <th className="text-right px-5 py-3" title="Solo informativo: comisión + base − crédito">Total inf.</th>
                    <th className="text-center px-5 py-3">Nivel</th>
                    <th className="px-5 py-3" />
                  </tr>
                </thead>
                <tbody>
                  {viewDebtors.length === 0 && (
                    <tr><td colSpan={8} className="px-5 py-6 text-center text-sm text-muted-foreground">Sin resultados para “{search}”</td></tr>
                  )}
                  {viewDebtors.map((d, i) => {
                    const level = owed(d) > 200000 ? "crítico" : owed(d) > 100000 ? "alto" : owed(d) > 50000 ? "medio" : "bajo";
                    const levelStyle = { crítico: "bg-red-200 text-red-800", alto: "bg-red-100 text-red-700", medio: "bg-orange-100 text-orange-700", bajo: "bg-yellow-100 text-yellow-700" }[level];
                    return (
                      <tr key={d.id} className="border-b border-border/50 hover:bg-secondary/30 transition">
                        <td className="px-5 py-3 font-bold text-muted-foreground">#{i + 1}</td>
                        <td className="px-5 py-3 font-bold">{d.name}</td>
                        <td className="px-5 py-3 text-muted-foreground">{d.branch.name}</td>
                        <td className="px-5 py-3 text-right font-black tnum text-red-600 text-base">{formatCOP(d.pendingDebt)}</td>
                        <td className="px-5 py-3 text-right font-bold tnum text-amber-600">{formatCOP(d.basePending ?? 0)}</td>
                        <td className="px-5 py-3 text-right tnum text-muted-foreground">{formatCOP(d.pendingDebt + (d.basePending ?? 0) - (d.creditAmount ?? 0))}</td>
                        <td className="px-5 py-3 text-center">
                          <span className={`text-xs px-2 py-0.5 rounded-full font-bold capitalize ${levelStyle}`}>{level}</span>
                        </td>
                        <td className="px-5 py-3 text-right">
                          <button onClick={() => setSelected(d)} className="px-3 py-1.5 bg-primary text-primary-foreground rounded-lg text-xs font-bold hover:opacity-90 transition">
                            Registrar pago
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {/* Domiciliarios a quienes la empresa debe — AMARILLO */}
          {creditors.length > 0 && (
            <div className="glass-strong rounded-3xl overflow-hidden">
              <div className="px-5 py-3 border-b border-border bg-amber-500/5 flex items-center gap-2">
                <span className="w-3 h-3 rounded-full bg-amber-500 shrink-0" />
                <span className="font-bold text-sm">La empresa debe a estos domiciliarios</span>
              </div>
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-muted-foreground text-xs uppercase">
                    <th className="text-left px-5 py-3">Domiciliario</th>
                    <th className="text-left px-5 py-3">Sucursal</th>
                    <th className="text-right px-5 py-3">A pagar</th>
                    <th className="text-center px-5 py-3">Medio de pago</th>
                    <th className="px-5 py-3" />
                  </tr>
                </thead>
                <tbody>
                  {creditors.map(d => (
                    <tr key={d.id} className="border-b border-border/50 hover:bg-secondary/30 transition">
                      <td className="px-5 py-3 font-bold">{d.name}</td>
                      <td className="px-5 py-3 text-muted-foreground">{d.branch.name}</td>
                      <td className="px-5 py-3 text-right font-black tnum text-amber-600 text-base">{formatCOP(d.creditAmount)}</td>
                      <td className="px-5 py-3 text-center">
                        <span className={`text-xs px-2 py-1 rounded-full font-bold ${d.creditMedium === "cash" ? "bg-amber-100 text-amber-800" : "bg-blue-100 text-blue-800"}`}>
                          {d.creditMedium === "cash" ? "💵 Efectivo" : "🏦 Transferencia"}
                        </span>
                      </td>
                      <td className="px-5 py-3 text-right">
                        <button onClick={() => setPaying(d)} className="px-3 py-1.5 bg-amber-500 text-white rounded-lg text-xs font-bold hover:opacity-90 transition">
                          Pagar a domiciliario
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {debtors.length === 0 && creditors.length === 0 && (
            <div className="glass-strong rounded-3xl p-12 text-center">
              <p className="font-bold text-lg text-green-600">¡Sin deudas pendientes!</p>
              <p className="text-sm text-muted-foreground mt-1">Todos los domiciliarios están al día</p>
            </div>
          )}
        </div>
      )}

      {selected && (
        <DriverStatementModal
          driver={{ id: selected.id, name: selected.name, branch: selected.branch }}
          onClose={() => setSelected(null)}
          onRefresh={load}
          debtCycle
        />
      )}

      {paying && (
        <PayCreditModal
          driver={paying}
          onClose={() => setPaying(null)}
          onDone={() => { setPaying(null); load(); }}
        />
      )}
    </div>
  );
}

function PayCreditModal({ driver, onClose, onDone }: { driver: DriverDebt; onClose: () => void; onDone: () => void }) {
  const [loading, setLoading] = useState(false);
  const suggestedMedium = (driver.creditMedium === "cash" ? "cash" : "bank") as "cash" | "bank";
  const [medium, setMedium] = useState<"cash" | "bank">(suggestedMedium);

  async function pay() {
    setLoading(true);
    try {
      await api.payDriverCredit(driver.id, medium);
      toast.success(`Pago registrado a ${driver.name}`);
      onDone();
    } catch (e) { toast.error(String(e)); }
    setLoading(false);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="glass-strong rounded-3xl max-h-[92vh] overflow-y-auto p-6 w-full max-w-sm space-y-5 shadow-2xl">
        <div className="flex items-center justify-between">
          <h2 className="font-black text-lg">Pagar a domiciliario</h2>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-secondary transition text-muted-foreground">✕</button>
        </div>

        <div className="bg-amber-500/10 rounded-2xl p-4 border border-amber-500/20 text-center">
          <p className="font-bold text-amber-700 dark:text-amber-400">{driver.name}</p>
          <p className="text-3xl font-black tnum mt-1">{formatCOP(driver.creditAmount)}</p>
          <p className="text-xs text-muted-foreground mt-1">La empresa le debe este valor</p>
        </div>

        <div className="space-y-2">
          <p className="text-sm font-bold">¿Cómo sale el dinero de la empresa?</p>
          <div className="grid grid-cols-2 gap-2">
            <button
              onClick={() => setMedium("cash")}
              className={`py-3 rounded-xl font-bold text-sm border-2 transition ${medium === "cash" ? "border-amber-500 bg-amber-500/10 text-amber-700 dark:text-amber-400" : "border-border hover:bg-secondary"}`}
            >
              💵 Efectivo
            </button>
            <button
              onClick={() => setMedium("bank")}
              className={`py-3 rounded-xl font-bold text-sm border-2 transition ${medium === "bank" ? "border-blue-500 bg-blue-500/10 text-blue-700 dark:text-blue-400" : "border-border hover:bg-secondary"}`}
            >
              🏦 Transferencia
            </button>
          </div>
          {medium !== suggestedMedium && (
            <p className="text-xs text-amber-600 dark:text-amber-400">
              ⚠️ El ingreso original entró por {suggestedMedium === "cash" ? "efectivo" : "transferencia"}
            </p>
          )}
        </div>

        <div className="flex gap-2">
          <button onClick={onClose} className="flex-1 py-2.5 rounded-xl border border-border text-sm font-bold hover:bg-secondary transition">Cancelar</button>
          <button
            onClick={pay}
            disabled={loading}
            className="flex-1 py-2.5 rounded-xl bg-amber-500 text-white text-sm font-bold hover:opacity-90 transition disabled:opacity-50"
          >
            {loading ? "Registrando…" : `Pagar ${formatCOP(driver.creditAmount)}`}
          </button>
        </div>
      </div>
    </div>
  );
}
