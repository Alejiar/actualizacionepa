"use client";
import { useState } from "react";
import { WizardShell } from "./WizardShell";
import { MoneyInput } from "../MoneyInput";
import { toast } from "sonner";
import * as api from "@/lib/sd-api";
import { todayBogota } from "@/lib/format";

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onDone?: () => void;
  defaultType?: "ingreso" | "egreso";
}

export function BankTransactionWizard({ open, onOpenChange, onDone, defaultType }: Props) {
  const [step, setStep] = useState(1);
  const [type, setType] = useState<"ingreso" | "egreso">(defaultType ?? "ingreso");
  const [description, setDescription] = useState("");
  const [amount, setAmount] = useState(0);
  const [reference, setReference] = useState("");
  const [txDate, setTxDate] = useState(() => todayBogota());
  const [saving, setSaving] = useState(false);

  function reset() {
    setStep(1);
    setType(defaultType ?? "ingreso");
    setDescription("");
    setAmount(0);
    setReference("");
    setTxDate(todayBogota());
  }

  function close() {
    onOpenChange(false);
    setTimeout(reset, 250);
  }

  async function submit() {
    setSaving(true);
    try {
      // Medio explícito (el backend ya no asume banco) y fecha anclada a Bogotá (-05:00).
      await api.createBankTransaction({ type, medium: "bank", amount, description, reference: reference || undefined, date: new Date(txDate + "T12:00:00-05:00").toISOString() });
      const label = type === "ingreso" ? "Ingreso bancario" : "Salida bancaria";
      toast.success(`✅ ${label} registrado: ${description}`);
      onDone?.();
      close();
    } catch (err) {
      toast.error(String(err));
    } finally {
      setSaving(false);
    }
  }

  const titles = [
    "¿Es entrada o salida de banco?",
    "¿Qué concepto es este movimiento?",
    "¿Cuánto fue el monto?",
    "Resumen — confirmar",
  ];

  return (
    <WizardShell
      open={open}
      onOpenChange={(v) => { if (!v) close(); }}
      step={step}
      total={4}
      title={titles[step - 1]}
      onBack={step > 1 ? () => setStep(step - 1) : undefined}
    >
      {step === 1 && (
        <div className="grid grid-cols-2 gap-3">
          <button
            onClick={() => { setType("ingreso"); setStep(2); }}
            className={`p-6 rounded-2xl border-2 transition text-center ${type === "ingreso" ? "border-primary bg-primary/10" : "border-border glass"} hover:border-primary`}
          >
            <div className="text-4xl">📥</div>
            <div className="font-bold mt-2 text-green-600">Ingreso</div>
            <div className="text-xs text-muted-foreground mt-1">Dinero que entra al banco</div>
          </button>
          <button
            onClick={() => { setType("egreso"); setStep(2); }}
            className={`p-6 rounded-2xl border-2 transition text-center ${type === "egreso" ? "border-destructive bg-destructive/10" : "border-border glass"} hover:border-destructive`}
          >
            <div className="text-4xl">📤</div>
            <div className="font-bold mt-2 text-red-600">Salida</div>
            <div className="text-xs text-muted-foreground mt-1">Dinero que sale del banco</div>
          </button>
        </div>
      )}

      {step === 2 && (
        <div className="space-y-3">
          <input
            autoFocus
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && description.trim()) setStep(3); }}
            placeholder="Ej: Pago proveedor, consignación cliente…"
            className="w-full glass-strong rounded-2xl px-5 py-4 text-lg outline-none focus:ring-2 focus:ring-primary/40"
          />
          <input
            value={reference}
            onChange={(e) => setReference(e.target.value)}
            placeholder="Referencia / No. transferencia (opcional)"
            className="w-full glass rounded-2xl px-5 py-3 text-sm outline-none focus:ring-2 focus:ring-primary/30"
          />
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground font-medium">Fecha de la transacción</label>
            <input
              type="date"
              value={txDate}
              onChange={(e) => setTxDate(e.target.value)}
              max={todayBogota()}
              className="w-full glass rounded-2xl px-5 py-3 text-sm outline-none focus:ring-2 focus:ring-primary/30"
            />
          </div>
          <button
            disabled={!description.trim()}
            onClick={() => setStep(3)}
            className="w-full bg-primary text-primary-foreground font-bold py-4 rounded-2xl shadow-cash disabled:opacity-40"
          >
            Siguiente →
          </button>
        </div>
      )}

      {step === 3 && (
        <div className="space-y-4">
          <MoneyInput value={amount} onChange={setAmount} autoFocus />
          <button
            disabled={amount <= 0}
            onClick={() => setStep(4)}
            className="w-full bg-primary text-primary-foreground font-bold py-4 rounded-2xl shadow-cash disabled:opacity-40"
          >
            Siguiente →
          </button>
        </div>
      )}

      {step === 4 && (
        <div className="space-y-4">
          <div className="glass-strong rounded-2xl p-5 space-y-3">
            <Row label="Tipo" value={type === "ingreso" ? "📥 Ingreso bancario" : "📤 Salida bancaria"} />
            <Row label="Concepto" value={description} />
            {reference && <Row label="Referencia" value={reference} />}
            <Row label="Fecha" value={new Date(txDate + "T12:00:00").toLocaleDateString("es-CO", { day: "2-digit", month: "long", year: "numeric" })} />
            <Row
              label="Monto"
              value={`$${amount.toLocaleString("es-CO")}`}
              highlight
              positive={type === "ingreso"}
            />
          </div>
          <button
            disabled={saving}
            onClick={submit}
            className="w-full bg-primary text-primary-foreground font-bold py-4 rounded-2xl shadow-cash disabled:opacity-50"
          >
            {saving ? "Guardando…" : "Confirmar y guardar"}
          </button>
        </div>
      )}
    </WizardShell>
  );
}

function Row({ label, value, highlight, positive }: { label: string; value: string; highlight?: boolean; positive?: boolean }) {
  return (
    <div className="flex items-center justify-between text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className={`font-bold ${highlight ? (positive ? "text-green-600" : "text-red-500") : ""}`}>{value}</span>
    </div>
  );
}
