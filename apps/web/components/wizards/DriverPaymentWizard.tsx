"use client";
import { useState } from "react";
import { WizardShell } from "./WizardShell";
import { MoneyInput } from "../MoneyInput";
import { toast } from "sonner";
import * as api from "@/lib/sd-api";
import type { DriverStatement } from "@/lib/sd-api";

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  driverId: string;
  driverName: string;
  statement?: DriverStatement;
  onDone?: () => void;
}

function formatCOP(n: number) { return "$" + n.toLocaleString("es-CO"); }

export function DriverPaymentWizard({ open, onOpenChange, driverId, driverName, statement, onDone }: Props) {
  const [step, setStep] = useState(1);
  // F14: el operador divide el pago entre comisión y devolución de base (cuentas separadas).
  const [commissionPart, setCommissionPart] = useState(0);
  const [basePart, setBasePart] = useState(0);
  const amount = commissionPart + basePart;
  const [medium, setMedium] = useState<"cash" | "bank" | null>(null);
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);

  const pendingDebt = statement?.pendingDebt ?? 0;
  const credit = statement?.creditAmount ?? 0;
  const basePending = statement?.basePending ?? Math.max(0, (statement?.totalBasesGiven ?? 0) - (statement?.totalBasesPaid ?? 0));
  const baseTooHigh = basePart > basePending;

  function reset() {
    setStep(1); setCommissionPart(0); setBasePart(0); setMedium(null); setNotes("");
  }
  function close() { onOpenChange(false); setTimeout(reset, 250); }

  async function submit(m: "cash" | "bank") {
    if (amount <= 0) return;
    setSaving(true);
    try {
      await api.registerPayment(driverId, amount, m, notes || undefined, basePart);
      toast.success(`✅ Pago de ${formatCOP(amount)} registrado para ${driverName} (comisión ${formatCOP(commissionPart)} · base ${formatCOP(basePart)})`);
      onDone?.();
      close();
    } catch (err) {
      toast.error(String(err));
    } finally {
      setSaving(false);
    }
  }

  const titles = [
    `¿Cuánto le vas a pagar a ${driverName}?`,
    "¿Cómo se entrega el pago?",
    "Confirmar pago",
  ];

  return (
    <WizardShell
      open={open}
      onOpenChange={(v) => { if (!v) close(); }}
      step={step}
      total={3}
      title={titles[step - 1]}
      subtitle={`Comisión: ${formatCOP(pendingDebt)} · Base: ${formatCOP(basePending)}`}
      onBack={step > 1 ? () => setStep(s => s - 1) : undefined}
    >
      {/* Paso 1 — Monto */}
      {step === 1 && (
        <div className="space-y-4">
          {/* F14: comisión y base son cuentas separadas; el total es solo informativo. */}
          {statement && (
            <div className="glass rounded-2xl p-4 space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Deuda por comisiones</span>
                <span className={`font-bold tnum ${pendingDebt > 0 ? "text-red-500" : "text-green-600"}`}>{pendingDebt > 0 ? formatCOP(pendingDebt) : "Al día ✓"}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Base sin devolver</span>
                <span className={`font-bold tnum ${basePending > 0 ? "text-amber-500" : "text-green-600"}`}>{basePending > 0 ? formatCOP(basePending) : "Al día ✓"}</span>
              </div>
              {credit > 0 && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Crédito a su favor (no se compensa con la base)</span>
                  <span className="font-bold tnum text-blue-600">{formatCOP(credit)}</span>
                </div>
              )}
              <div className="flex justify-between text-xs text-muted-foreground border-t border-border pt-2">
                <span>Total informativo (comisión + base − crédito)</span>
                <span className="tnum">{formatCOP(pendingDebt + basePending - credit)}</span>
              </div>
            </div>
          )}

          <label className="block text-xs font-bold text-muted-foreground">A comisión</label>
          <MoneyInput value={commissionPart} onChange={setCommissionPart} autoFocus />
          {pendingDebt > 0 && (
            <button onClick={() => setCommissionPart(pendingDebt)} className="w-full text-xs py-2 rounded-xl bg-primary/10 text-primary font-bold hover:bg-primary/20 transition">
              Pagar toda la comisión ({formatCOP(pendingDebt)})
            </button>
          )}

          <label className="block text-xs font-bold text-muted-foreground">A devolver base</label>
          <MoneyInput value={basePart} onChange={setBasePart} />
          {basePending > 0 && (
            <button onClick={() => setBasePart(basePending)} className="w-full text-xs py-2 rounded-xl bg-amber-500/10 text-amber-600 font-bold hover:bg-amber-500/20 transition">
              Devolver toda la base ({formatCOP(basePending)})
            </button>
          )}
          {baseTooHigh && <div className="text-xs text-red-600">La parte a base no puede superar la base sin devolver ({formatCOP(basePending)}).</div>}
          <div className="text-sm font-bold text-right">Total del pago: {formatCOP(amount)}</div>

          <input
            value={notes}
            onChange={e => setNotes(e.target.value)}
            placeholder="Observaciones (opcional)"
            className="w-full glass rounded-2xl px-5 py-3 text-sm outline-none focus:ring-2 focus:ring-primary/30"
          />

          <button
            disabled={amount <= 0 || baseTooHigh}
            onClick={() => setStep(2)}
            className="w-full bg-primary text-primary-foreground font-bold py-4 rounded-2xl shadow-cash disabled:opacity-40"
          >
            Siguiente →
          </button>
        </div>
      )}

      {/* Paso 2 — Medio de pago */}
      {step === 2 && (
        <div className="grid grid-cols-2 gap-3">
          <button
            onClick={() => { setMedium("cash"); setStep(3); }}
            className={`p-6 rounded-2xl border-2 text-center transition ${medium === "cash" ? "border-primary bg-primary/10" : "border-border bg-secondary/60"} hover:border-primary`}
          >
            <div className="text-4xl">💵</div>
            <div className="font-bold mt-2">Efectivo</div>
            <div className="text-xs text-muted-foreground mt-1">Pago en mano</div>
          </button>
          <button
            onClick={() => { setMedium("bank"); setStep(3); }}
            className={`p-6 rounded-2xl border-2 text-center transition ${medium === "bank" ? "border-blue-500 bg-blue-500/10" : "border-border bg-secondary/60"} hover:border-blue-400`}
          >
            <div className="text-4xl">🏦</div>
            <div className="font-bold mt-2 text-blue-600 dark:text-blue-400">Banco</div>
            <div className="text-xs text-muted-foreground mt-1">Transferencia</div>
          </button>
        </div>
      )}

      {/* Paso 3 — Confirmar */}
      {step === 3 && medium && (
        <div className="space-y-4">
          <div className="glass-strong rounded-2xl p-5 space-y-3">
            <Row label="Domiciliario" value={driverName} />
            <Row label="Medio" value={medium === "cash" ? "💵 Efectivo" : "🏦 Banco"} />
            {notes && <Row label="Notas" value={notes} />}
            <hr className="border-border" />
            <Row label="Total a recibir" value={formatCOP(amount)} highlight positive />
            <Row label="A comisión" value={formatCOP(commissionPart)} />
            <Row label="A devolver base" value={formatCOP(basePart)} />
            <hr className="border-border" />
            <Row label="Comisión restante" value={formatCOP(Math.max(0, pendingDebt - commissionPart))} warn={pendingDebt - commissionPart > 0} />
            {commissionPart > pendingDebt && <Row label="Queda a su favor (crédito)" value={formatCOP(credit + commissionPart - pendingDebt)} />}
            <Row label="Base restante" value={formatCOP(Math.max(0, basePending - basePart))} warn={basePending - basePart > 0} />
          </div>

          <button
            disabled={saving}
            onClick={() => submit(medium)}
            className="w-full bg-primary text-primary-foreground font-bold py-4 rounded-2xl shadow-cash disabled:opacity-50"
          >
            {saving ? "Registrando…" : `Confirmar pago de ${formatCOP(amount)}`}
          </button>
        </div>
      )}
    </WizardShell>
  );
}

function Row({ label, value, highlight, positive, warn }: { label: string; value: string; highlight?: boolean; positive?: boolean; warn?: boolean }) {
  return (
    <div className="flex items-center justify-between text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className={`font-bold ${highlight ? (positive ? "text-green-600" : "text-red-500") : warn ? "text-amber-600" : ""}`}>
        {value}
      </span>
    </div>
  );
}
