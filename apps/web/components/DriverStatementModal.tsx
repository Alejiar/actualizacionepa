"use client";

import { useEffect, useState } from "react";
import { Banknote, Wallet } from "lucide-react";
import { toast } from "sonner";
import * as api from "@/lib/sd-api";
import { formatCOP } from "@/lib/format";

interface DriverLite {
  id: string;
  name: string;
  branch: { id: string; name: string };
}

interface Props {
  driver: DriverLite;
  onClose: () => void;
  onRefresh: () => void;
  // Solo visualización: en la pantalla de Deudas, mostrar únicamente los domicilios
  // de la deuda ACTUAL (los entregados después del último pago), sin acumular los ya
  // saldados. En Domiciliarios queda en falso → muestra el histórico completo.
  debtCycle?: boolean;
}

export function DriverStatementModal({ driver, onClose, onRefresh, debtCycle }: Props) {
  const [statement, setStatement] = useState<api.DriverStatement | null>(null);
  // F14: el operador divide el pago entre comisión y devolución de base.
  const [payAmount, setPayAmount] = useState("");
  const [payBase, setPayBase] = useState("");
  const [payMedium, setPayMedium] = useState<"cash" | "bank">("cash");
  const [paying, setPaying] = useState(false);

  const reload = () => api.getDriverStatement(driver.id).then(setStatement).catch(() => toast.error("Error al cargar estado de cuenta"));

  useEffect(() => { reload(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [driver.id]);

  // F14: `totalOwed` es la deuda SOLO por comisiones; la base es una cuenta aparte (entregadas −
  // devueltas, del backend) y no se compensa con el crédito. El total es solo informativo.
  const totalOwed = statement?.pendingDebt ?? 0;
  const basePending = statement?.basePending ?? 0;
  const companyOwes = statement?.creditAmount ?? 0;

  // En modo Deudas: solo los domicilios de la deuda actual (entregados DESPUÉS del último
  // pago). En modo normal (Domiciliarios): todos. Es solo cómo se muestra; el saldo real
  // (pendingDebt) no cambia.
  const displayOrders = statement
    ? (debtCycle && statement.debtCycleStart
        ? statement.orders.filter(o => o.deliveredAt && new Date(o.deliveredAt) > new Date(statement.debtCycleStart as string))
        : statement.orders)
    : [];
  const shownCount = displayOrders.length;
  const shownValue = displayOrders.reduce((s, o) => s + o.deliveryValue, 0);
  const shownCompany = displayOrders.reduce((s, o) => s + o.companyAmount, 0);

  const handlePay = async () => {
    const commission = parseInt(payAmount.replace(/\D/g, "") || "0");
    const base = parseInt(payBase.replace(/\D/g, "") || "0");
    const amount = commission + base;
    if (!amount || amount <= 0) { toast.error("Ingresa un monto válido"); return; }
    if (base > basePending) { toast.error(`La parte a base supera la base sin devolver (${formatCOP(basePending)}).`); return; }
    if (statement && commission > statement.pendingDebt) {
      if (!confirm(`La parte a comisión (${formatCOP(commission)}) supera la deuda por comisiones (${formatCOP(statement.pendingDebt)}). El exceso quedará a favor del domiciliario. ¿Continuar?`)) return;
    }
    setPaying(true);
    try {
      const r = await api.registerPayment(driver.id, amount, payMedium, undefined, base);
      const parts: string[] = [];
      if (r?.commissionAlloc) parts.push(`${formatCOP(r.commissionAlloc)} a comisión`);
      if (r?.baseAlloc) parts.push(`${formatCOP(r.baseAlloc)} a base`);
      if (r?.creditAmount && r.creditAmount > 0) parts.push(`crédito a su favor ${formatCOP(r.creditAmount)}`);
      toast.success(`Pago ${formatCOP(amount)} (${payMedium === "cash" ? "efectivo" : "transferencia"})${parts.length ? ` · ${parts.join(" · ")}` : ""}`);
      setPayAmount(""); setPayBase("");
      onRefresh();
      await reload();
    } catch (err) { toast.error(String(err)); }
    setPaying(false);
  };

  const quick = (n: number) => setPayAmount(String(n));

  return (
    <div className="fixed inset-0 bg-background/80 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="glass-strong rounded-3xl p-6 w-full max-w-2xl max-h-[90vh] overflow-y-auto space-y-4" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-black">Estado de cuenta</h2>
            <p className="text-sm text-muted-foreground">{driver.name} · {driver.branch.name}</p>
          </div>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground text-xl">✕</button>
        </div>

        {!statement ? (
          <div className="text-center py-8 text-muted-foreground">Cargando...</div>
        ) : (
          <>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <Stat label="Pedidos entregados" value={String(shownCount)} />
              <Stat label="Valor entregado" value={formatCOP(shownValue)} />
              <Stat label="% empresa acumulado" value={formatCOP(shownCompany)} />
              <Stat label="Deuda por comisiones" value={formatCOP(totalOwed)} highlight={totalOwed > 0} />
              {companyOwes > 0 && <Stat label="Empresa le debe (crédito)" value={formatCOP(companyOwes)} credit />}
            </div>

            {/* Desglose de deuda */}
            <div className="grid grid-cols-3 gap-3">
              <Stat label="Base entregada" value={formatCOP(statement.totalBasesGiven)} />
              <Stat label="Base devuelta" value={formatCOP(statement.totalBasesPaid)} />
              <Stat label="Base sin devolver" value={formatCOP(basePending)} highlight={basePending > 0} />
            </div>
            <p className="text-xs text-muted-foreground">
              Total informativo (comisión + base − crédito): <strong className="tnum">{formatCOP(statement.totalInformativo ?? totalOwed + basePending - companyOwes)}</strong>. No es otra deuda: comisión y base se cobran por separado y el crédito no descuenta la base.
            </p>

            {/* Pago */}
            <div className={`rounded-2xl p-4 space-y-3 ${totalOwed > 0 ? "bg-red-500/10 border border-red-500/20" : companyOwes > 0 ? "bg-amber-500/10 border border-amber-500/20" : "bg-secondary/40"}`}>
              <div className="flex items-center justify-between">
                <p className={`font-bold ${totalOwed > 0 ? "text-red-700" : companyOwes > 0 ? "text-amber-700 dark:text-amber-400" : ""}`}>
                  {totalOwed > 0 || basePending > 0 ? "Registrar pago (indica cuánto va a comisión y cuánto a base)" : companyOwes > 0 ? "La empresa le debe — pago anticipado" : "Sin deuda pendiente"}
                </p>
                {totalOwed > 0 && <span className="text-xs font-bold tnum text-red-700">Debe: {formatCOP(totalOwed)}</span>}
                {companyOwes > 0 && <span className="text-xs font-bold tnum text-amber-700">Empresa debe: {formatCOP(companyOwes)}</span>}
              </div>
              <p className="text-xs text-muted-foreground">
                La parte a comisión reduce solo la deuda por comisiones (si la supera, el exceso queda a su favor). La parte a base reduce solo la base sin devolver y no puede superarla.
              </p>

              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => setPayMedium("cash")}
                  className={`flex items-center justify-center gap-2 py-2.5 rounded-xl border-2 font-bold text-sm transition ${
                    payMedium === "cash"
                      ? "bg-emerald-500 text-white border-emerald-500"
                      : "border-border bg-secondary/60 text-foreground hover:border-emerald-500 hover:bg-emerald-500/10"
                  }`}
                >
                  <Banknote className="h-4 w-4" /> Efectivo
                </button>
                <button
                  type="button"
                  onClick={() => setPayMedium("bank")}
                  className={`flex items-center justify-center gap-2 py-2.5 rounded-xl border-2 font-bold text-sm transition ${
                    payMedium === "bank"
                      ? "bg-sky-500 text-white border-sky-500"
                      : "border-border bg-secondary/60 text-foreground hover:border-sky-400 hover:bg-sky-500/10"
                  }`}
                >
                  <Wallet className="h-4 w-4" /> Transferencia
                </button>
              </div>

              <div className="flex gap-2">
                <input
                  type="text"
                  inputMode="numeric"
                  placeholder="A comisión (COP)"
                  aria-label="Monto a comisión"
                  value={payAmount}
                  onChange={e => setPayAmount(e.target.value.replace(/\D/g, ""))}
                  className="flex-1 px-3 py-2.5 rounded-xl border border-border bg-background text-sm tnum"
                />
                <input
                  type="text"
                  inputMode="numeric"
                  placeholder="A base (COP)"
                  aria-label="Monto a devolver base"
                  value={payBase}
                  onChange={e => setPayBase(e.target.value.replace(/\D/g, ""))}
                  className="flex-1 px-3 py-2.5 rounded-xl border border-border bg-background text-sm tnum"
                />
                <button
                  onClick={handlePay}
                  disabled={paying}
                  className="px-4 py-2.5 bg-primary text-primary-foreground rounded-xl font-bold hover:opacity-90 disabled:opacity-50 transition"
                >
                  {paying ? "..." : "Registrar"}
                </button>
              </div>

              {(totalOwed > 0 || basePending > 0) && (
                <div className="flex gap-2 flex-wrap">
                  {totalOwed > 0 && (
                    <button onClick={() => quick(totalOwed)} className="text-xs px-2.5 py-1 rounded-lg bg-background border border-border hover:bg-secondary transition">
                      Toda la comisión ({formatCOP(totalOwed)})
                    </button>
                  )}
                  {basePending > 0 && (
                    <button onClick={() => setPayBase(String(basePending))} className="text-xs px-2.5 py-1 rounded-lg bg-background border border-border hover:bg-secondary transition">
                      Toda la base ({formatCOP(basePending)})
                    </button>
                  )}
                  <button onClick={() => quick(Math.round(totalOwed / 2))} className="text-xs px-2.5 py-1 rounded-lg bg-background border border-border hover:bg-secondary transition">
                    Mitad
                  </button>
                  <button onClick={() => quick(10000)} className="text-xs px-2.5 py-1 rounded-lg bg-background border border-border hover:bg-secondary transition">+10k</button>
                  <button onClick={() => quick(20000)} className="text-xs px-2.5 py-1 rounded-lg bg-background border border-border hover:bg-secondary transition">+20k</button>
                  <button onClick={() => quick(50000)} className="text-xs px-2.5 py-1 rounded-lg bg-background border border-border hover:bg-secondary transition">+50k</button>
                </div>
              )}
            </div>

            {statement.payments.length > 0 && (
              <div className="space-y-2">
                <h3 className="font-bold text-sm text-muted-foreground uppercase tracking-wide">Pagos recientes</h3>
                <div className="space-y-1">
                  {statement.payments.slice(0, 10).map(p => (
                    <div key={p.id} className="flex justify-between text-sm py-1.5 px-3 rounded-lg bg-secondary/30">
                      <span className="text-muted-foreground">
                        {new Date(p.date).toLocaleString("es-CO", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}
                        {" · "}
                        <span className={`font-bold ${p.medium === "cash" ? "text-emerald-600" : "text-sky-600"}`}>
                          {p.medium === "cash" ? "Efectivo" : "Transferencia"}
                        </span>
                      </span>
                      <span className="font-bold tnum text-emerald-700">-{formatCOP(p.amount)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="space-y-2">
              <h3 className="font-bold text-sm text-muted-foreground uppercase tracking-wide">Pedidos entregados ({shownCount})</h3>
              <div className="space-y-1">
                {displayOrders.map(o => (
                  <div key={o.id} className="flex justify-between text-sm py-1.5 px-3 rounded-lg bg-secondary/30">
                    <span className="text-muted-foreground">
                      {o.deliveredAt ? new Date(o.deliveredAt).toLocaleString("es-CO", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—"} · #{o.orderNumber ?? "—"}
                    </span>
                    <div className="flex gap-4 tnum">
                      <span>{formatCOP(o.deliveryValue)}</span>
                      <span className="text-red-600 font-bold">+{formatCOP(o.companyAmount)}</span>
                    </div>
                  </div>
                ))}
                {displayOrders.length === 0 && (
                  <p className="text-center py-4 text-xs text-muted-foreground">Sin pedidos entregados aún.</p>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value, highlight, credit }: { label: string; value: string; highlight?: boolean; credit?: boolean }) {
  return (
    <div className={`rounded-2xl p-3 ${highlight ? "bg-red-500/10 border border-red-500/20" : credit ? "bg-amber-500/10 border border-amber-500/20" : "bg-secondary/40"}`}>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={`font-black text-lg tnum ${highlight ? "text-red-500" : credit ? "text-amber-500" : ""}`}>{value}</p>
    </div>
  );
}
