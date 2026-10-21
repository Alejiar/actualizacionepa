import { useState } from "react";
import { WizardShell } from "./WizardShell";
import { MoneyInput } from "../MoneyInput";
import { useStore } from "@/lib/store";
import { Avatar } from "../Avatar";
import { toast } from "sonner";

interface Props { open: boolean; onOpenChange: (v: boolean) => void; date: string; presetWorkerId?: string; }

export function PayrollWizard({ open, onOpenChange, date, presetWorkerId }: Props) {
  const { state, addMovement } = useStore();
  const [step, setStep] = useState<1 | 2>(presetWorkerId ? 2 : 1);
  const [workerId, setWorkerId] = useState<string | undefined>(presetWorkerId);
  const [amount, setAmount] = useState(0);
  const [medium, setMedium] = useState<"cash" | "bank">("cash");
  const [concept, setConcept] = useState("");
  const [saving, setSaving] = useState(false);

  function close() { onOpenChange(false); setTimeout(() => { setStep(presetWorkerId ? 2 : 1); setWorkerId(presetWorkerId); setAmount(0); setMedium("cash"); setConcept(""); }, 250); }

  async function submit() {
    if (!workerId || amount <= 0 || saving) return;
    const w = state.workers.find(x => x.id === workerId);
    setSaving(true);
    try {
      // Solo se anuncia el pago si el servidor lo aceptó; ante un rechazo el store ya
      // muestra el error y el formulario conserva los datos.
      await addMovement(date, {
        category: medium === "cash" ? 15 : 18, type: "egreso", medium, amount, workerId,
        description: concept || `Nómina ${w?.name ?? ""}`,
      });
    } catch {
      return;
    } finally {
      setSaving(false);
    }
    toast.success(`✅ Nómina pagada a ${w?.name}`);
    close();
  }

  return (
    <WizardShell open={open} onOpenChange={(v) => { if (!v) close(); }} step={step} total={2}
      title={step === 1 ? "¿A quién le pagas?" : "Detalles del pago"}
      onBack={step === 2 && !presetWorkerId ? () => setStep(1) : undefined}
    >
      {step === 1 && (
        <div className="grid grid-cols-2 gap-2 max-h-80 overflow-auto">
          {state.workers.filter(w => w.active).map(w => (
            <button key={w.id} onClick={() => { setWorkerId(w.id); setStep(2); }} className="flex items-center gap-2 p-3 rounded-xl glass hover:ring-cash text-left">
              <Avatar worker={w} size={32} />
              <span className="font-medium">{w.name}</span>
            </button>
          ))}
        </div>
      )}
      {step === 2 && (
        <div className="space-y-4">
          <MoneyInput value={amount} onChange={setAmount} autoFocus />
          <div className="grid grid-cols-2 gap-3">
            <button onClick={() => setMedium("cash")} className={`p-4 rounded-2xl border-2 ${medium === "cash" ? "border-primary bg-cash-soft" : "border-border glass"}`}>💵 Efectivo</button>
            <button onClick={() => setMedium("bank")} className={`p-4 rounded-2xl border-2 ${medium === "bank" ? "border-accent bg-bank-soft" : "border-border glass"}`}>🏦 Banco</button>
          </div>
          <input value={concept} onChange={(e) => setConcept(e.target.value)} placeholder="Concepto (opcional)" className="w-full glass rounded-xl px-4 py-3 outline-none focus:ring-2 focus:ring-primary/40" />
          <button disabled={amount <= 0 || saving} onClick={submit} className="w-full bg-primary text-primary-foreground font-bold py-4 rounded-2xl shadow-cash disabled:opacity-40">✅ Pagar nómina</button>
        </div>
      )}
    </WizardShell>
  );
}
