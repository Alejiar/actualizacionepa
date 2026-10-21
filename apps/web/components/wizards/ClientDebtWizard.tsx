"use client";
import { useState } from "react";
import { WizardShell } from "./WizardShell";
import { MoneyInput } from "../MoneyInput";
import { toast } from "sonner";
import * as api from "@/lib/sd-api";
import { useDay } from "@/lib/day-context";

type Mode = "new_client" | "add_debt" | "pay_debt";

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  mode: Mode;
  client?: api.Client;
  debt?: api.ClientDebt;
  onDone?: () => void;
}

export function ClientDebtWizard({ open, onOpenChange, mode, client, debt, onDone }: Props) {
  const [step, setStep] = useState(1);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [description, setDescription] = useState("");
  const [amount, setAmount] = useState(0);
  // NEW02: la deuda es del día operativo (la caja abierta), no del calendario.
  const { operatingDay } = useDay();
  const [debtDate, setDebtDate] = useState(() => operatingDay);
  const [payMedium, setPayMedium] = useState<"cash" | "bank">("cash");
  // De dónde sale el dinero de la deuda: préstamo en efectivo/banco, o "none" = fiado (no sale
  // dinero; p. ej. un domicilio que quedó debiendo). Sin valor por defecto: el operador debe
  // elegir, porque un préstamo descuenta caja y un fiado no.
  const [debtMedium, setDebtMedium] = useState<"cash" | "bank" | "none" | null>(null);
  const mediumParam = (m: typeof debtMedium) => (m === "cash" || m === "bank" ? m : undefined);
  const mediumLabel = (m: typeof debtMedium) => m === "cash" ? "💵 Efectivo" : m === "bank" ? "🏦 Transferencia" : "📝 No sale dinero (fiado)";
  const [saving, setSaving] = useState(false);

  function reset() { setStep(1); setName(""); setPhone(""); setDescription(""); setAmount(0); setPayMedium("cash"); setDebtMedium(null); setDebtDate(operatingDay); }
  function close() { onOpenChange(false); setTimeout(reset, 250); }

  const totalSteps = mode === "new_client" ? 3 : mode === "add_debt" ? 3 : 2;

  const titles: Record<Mode, string[]> = {
    new_client: ["Datos del nuevo cliente", "Deuda inicial (opcional)", "Confirmar registro"],
    add_debt: ["¿Qué debe el cliente?", "¿Cuánto es la deuda?", "Confirmar deuda"],
    pay_debt: ["¿Cuánto abona el cliente?", "Confirmar abono"],
  };

  const clientPending = client?.pendingDebt ?? 0;

  async function submitNewClient() {
    setSaving(true);
    try {
      // La deuda inicial la registra el backend y actualiza el saldo automáticamente
      await api.createClient({
        name,
        phone: phone || undefined,
        initialDebt: amount > 0 ? amount : undefined,
        initialDebtDescription: description.trim() || undefined,
        initialDebtMedium: amount > 0 ? mediumParam(debtMedium) : undefined,
      });
      toast.success(`✅ Cliente "${name}" registrado${amount > 0 ? ` con deuda de $${amount.toLocaleString("es-CO")}` : ""}`);
      onDone?.(); close();
    } catch (err) { toast.error(String(err)); }
    setSaving(false);
  }

  async function submitAddDebt() {
    if (!client) return;
    setSaving(true);
    try {
      await api.addClientDebt(client.id, description, amount, debtDate, mediumParam(debtMedium));
      toast.success(`✅ Deuda de $${amount.toLocaleString("es-CO")} añadida a ${client.name}`);
      onDone?.(); close();
    } catch (err) { toast.error(String(err)); }
    setSaving(false);
  }

  async function submitPayClient(payAll: boolean) {
    if (!client) return;
    setSaving(true);
    try {
      const res = await api.payClient(client.id, amount, payAll, payMedium);
      toast.success(`✅ Abono de $${res.applied.toLocaleString("es-CO")} registrado · Saldo restante: $${res.remaining.toLocaleString("es-CO")}`);
      onDone?.(); close();
    } catch (err) { toast.error(String(err)); }
    setSaving(false);
  }

  return (
    <WizardShell
      open={open}
      onOpenChange={(v) => { if (!v) close(); }}
      step={step}
      total={totalSteps}
      title={titles[mode][step - 1]}
      subtitle={client ? `Cliente: ${client.name}` : debt ? `Deuda: ${debt.description}` : undefined}
      onBack={step > 1 ? () => setStep(step - 1) : undefined}
    >
      {/* NEW CLIENT */}
      {mode === "new_client" && step === 1 && (
        <div className="space-y-3">
          <input autoFocus value={name} onChange={e => setName(e.target.value)}
            placeholder="Nombre completo del cliente"
            className="w-full glass-strong rounded-2xl px-5 py-4 text-lg outline-none focus:ring-2 focus:ring-primary/40" />
          <input value={phone} onChange={e => setPhone(e.target.value)}
            placeholder="Teléfono (opcional)"
            className="w-full glass rounded-2xl px-5 py-3 text-base outline-none focus:ring-2 focus:ring-primary/30" />
          <button disabled={!name.trim()} onClick={() => setStep(2)}
            className="w-full bg-primary text-primary-foreground font-bold py-4 rounded-2xl shadow-cash disabled:opacity-40">
            Siguiente →
          </button>
        </div>
      )}
      {mode === "new_client" && step === 2 && (
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">¿El cliente tiene una deuda inicial? (puedes dejarlo en $0)</p>
          <input value={description} onChange={e => setDescription(e.target.value)}
            placeholder="Concepto de la deuda (ej: Domicilio del lunes)"
            className="w-full glass-strong rounded-2xl px-5 py-3 text-base outline-none focus:ring-2 focus:ring-primary/40" />
          <MoneyInput value={amount} onChange={setAmount} />
          {amount > 0 && (
            <div>
              <label className="text-xs text-muted-foreground font-medium">¿Sale dinero de la caja? (préstamo o fiado)</label>
              <div className="grid grid-cols-3 gap-2 mt-1">
                <button type="button" onClick={() => setDebtMedium("cash")}
                  className={`p-3 rounded-xl border-2 text-sm font-bold transition ${debtMedium === "cash" ? "border-primary bg-primary/10" : "border-border bg-secondary/40"}`}>
                  💵 Efectivo
                </button>
                <button type="button" onClick={() => setDebtMedium("bank")}
                  className={`p-3 rounded-xl border-2 text-sm font-bold transition ${debtMedium === "bank" ? "border-blue-500 bg-blue-500/10 text-blue-600" : "border-border bg-secondary/40"}`}>
                  🏦 Transferencia
                </button>
                <button type="button" onClick={() => setDebtMedium("none")}
                  className={`p-3 rounded-xl border-2 text-sm font-bold transition ${debtMedium === "none" ? "border-amber-500 bg-amber-500/10 text-amber-700" : "border-border bg-secondary/40"}`}>
                  📝 No sale dinero (fiado)
                </button>
              </div>
            </div>
          )}
          <button disabled={amount > 0 && !debtMedium} onClick={() => setStep(3)}
            className="w-full bg-primary text-primary-foreground font-bold py-4 rounded-2xl shadow-cash">
            {amount > 0 ? "Siguiente →" : "Sin deuda inicial →"}
          </button>
        </div>
      )}
      {mode === "new_client" && step === 3 && (
        <div className="space-y-4">
          <div className="glass-strong rounded-2xl p-5 space-y-3">
            <Row label="Nombre" value={name} />
            {phone && <Row label="Teléfono" value={phone} />}
            {amount > 0 && description && <>
              <hr className="border-border" />
              <Row label="Primera deuda" value={description} />
              <Row label="Monto" value={`$${amount.toLocaleString("es-CO")}`} highlight />
              <Row label="Sale de" value={mediumLabel(debtMedium)} />
            </>}
          </div>
          <button disabled={saving} onClick={submitNewClient}
            className="w-full bg-primary text-primary-foreground font-bold py-4 rounded-2xl shadow-cash disabled:opacity-50">
            {saving ? "Guardando…" : "Registrar cliente"}
          </button>
        </div>
      )}

      {/* ADD DEBT */}
      {mode === "add_debt" && step === 1 && (
        <div className="space-y-3">
          <input autoFocus value={description} onChange={e => setDescription(e.target.value)}
            placeholder="Ej: Domicilio del martes, pedido #123…"
            className="w-full glass-strong rounded-2xl px-5 py-4 text-lg outline-none focus:ring-2 focus:ring-primary/40" />
          <button disabled={!description.trim()} onClick={() => setStep(2)}
            className="w-full bg-primary text-primary-foreground font-bold py-4 rounded-2xl shadow-cash disabled:opacity-40">
            Siguiente →
          </button>
        </div>
      )}
      {mode === "add_debt" && step === 2 && (
        <div className="space-y-4">
          <MoneyInput value={amount} onChange={setAmount} autoFocus />
          {/* Medio del que sale el dinero prestado */}
          <div>
            <label className="text-xs text-muted-foreground font-medium">¿Sale dinero de la caja? (préstamo o fiado)</label>
            <div className="grid grid-cols-3 gap-2 mt-1">
              <button type="button" onClick={() => setDebtMedium("cash")}
                className={`p-3 rounded-xl border-2 text-sm font-bold transition ${debtMedium === "cash" ? "border-primary bg-primary/10" : "border-border bg-secondary/40"}`}>
                💵 Efectivo
              </button>
              <button type="button" onClick={() => setDebtMedium("bank")}
                className={`p-3 rounded-xl border-2 text-sm font-bold transition ${debtMedium === "bank" ? "border-blue-500 bg-blue-500/10 text-blue-600" : "border-border bg-secondary/40"}`}>
                🏦 Transferencia
              </button>
              <button type="button" onClick={() => setDebtMedium("none")}
                className={`p-3 rounded-xl border-2 text-sm font-bold transition ${debtMedium === "none" ? "border-amber-500 bg-amber-500/10 text-amber-700" : "border-border bg-secondary/40"}`}>
                📝 No sale dinero (fiado)
              </button>
            </div>
            <p className="text-xs text-muted-foreground mt-1">{debtMedium === "none" ? "Fiado: no cambia la caja; solo queda la deuda del cliente." : debtMedium ? `Préstamo: se descontará del ${debtMedium === "cash" ? "efectivo" : "banco"} al registrar la deuda.` : "Elige una opción."}</p>
          </div>
          <div>
            <label className="text-xs text-muted-foreground font-medium">Fecha de la deuda</label>
            <input type="date" value={debtDate} max={operatingDay}
              onChange={e => setDebtDate(e.target.value)}
              className="w-full mt-1 glass rounded-2xl px-5 py-3 text-sm outline-none focus:ring-2 focus:ring-primary/30" />
          </div>
          <button disabled={amount <= 0 || !debtMedium} onClick={() => setStep(3)}
            className="w-full bg-primary text-primary-foreground font-bold py-4 rounded-2xl shadow-cash disabled:opacity-40">
            Siguiente →
          </button>
        </div>
      )}
      {mode === "add_debt" && step === 3 && (
        <div className="space-y-4">
          <div className="glass-strong rounded-2xl p-5 space-y-3">
            <Row label="Cliente" value={client?.name ?? ""} />
            <Row label="Concepto" value={description} />
            <Row label="Monto" value={`$${amount.toLocaleString("es-CO")}`} highlight />
            <Row label="Sale de" value={mediumLabel(debtMedium)} />
            <Row label="Deuda actual" value={`$${(client?.pendingDebt ?? 0).toLocaleString("es-CO")}`} />
            <Row label="Nueva deuda total" value={`$${((client?.pendingDebt ?? 0) + amount).toLocaleString("es-CO")}`} highlight />
          </div>
          <button disabled={saving} onClick={submitAddDebt}
            className="w-full bg-primary text-primary-foreground font-bold py-4 rounded-2xl shadow-cash disabled:opacity-50">
            {saving ? "Guardando…" : "Confirmar deuda"}
          </button>
        </div>
      )}

      {/* PAY CLIENT — abono parcial o pago total sobre el saldo */}
      {mode === "pay_debt" && step === 1 && (
        <div className="space-y-4">
          <div className="glass rounded-2xl p-4 text-center">
            <p className="text-xs text-muted-foreground">Saldo pendiente de {client?.name}</p>
            <p className="font-black text-2xl text-red-500 tnum mt-1">${clientPending.toLocaleString("es-CO")}</p>
          </div>
          <p className="text-sm text-muted-foreground">Ingresa el valor que abona el cliente. Se descontará del saldo total.</p>
          <MoneyInput value={amount} onChange={setAmount} autoFocus />
          {/* Medio de pago */}
          <div className="grid grid-cols-2 gap-2">
            <button onClick={() => setPayMedium("cash")}
              className={`p-3 rounded-xl border-2 text-sm font-bold transition ${payMedium === "cash" ? "border-primary bg-primary/10" : "border-border bg-secondary/40"}`}>
              💵 Efectivo
            </button>
            <button onClick={() => setPayMedium("bank")}
              className={`p-3 rounded-xl border-2 text-sm font-bold transition ${payMedium === "bank" ? "border-blue-500 bg-blue-500/10 text-blue-600" : "border-border bg-secondary/40"}`}>
              🏦 Transferencia
            </button>
          </div>
          <div className="flex gap-2">
            <button
              disabled={amount <= 0}
              onClick={() => setStep(2)}
              className="flex-1 bg-primary text-primary-foreground font-bold py-3.5 rounded-2xl shadow-cash disabled:opacity-40"
            >
              Abonar →
            </button>
            <button
              onClick={() => { setAmount(clientPending); setStep(2); }}
              className="flex-1 border-2 border-primary text-primary font-bold py-3.5 rounded-2xl hover:bg-primary/10 transition"
            >
              Pagar deuda completa
            </button>
          </div>
        </div>
      )}
      {mode === "pay_debt" && step === 2 && (
        <div className="space-y-4">
          <div className="glass-strong rounded-2xl p-5 space-y-3">
            <Row label="Cliente" value={client?.name ?? ""} />
            <Row label="Saldo actual" value={`$${clientPending.toLocaleString("es-CO")}`} />
            <Row label="Abono" value={`$${Math.min(amount, clientPending).toLocaleString("es-CO")}`} highlight />
            <Row label="Entra a" value={payMedium === "cash" ? "💵 Efectivo" : "🏦 Transferencia"} />
            <hr className="border-border" />
            <Row label="Saldo restante" value={`$${Math.max(0, clientPending - amount).toLocaleString("es-CO")}`} highlight />
          </div>
          {amount >= clientPending && (
            <div className="glass rounded-xl px-4 py-3 border border-green-500/30 bg-green-500/5 text-xs text-green-700 dark:text-green-400">
              ✅ Este abono liquida toda la deuda del cliente.
            </div>
          )}
          <button disabled={saving} onClick={() => submitPayClient(amount >= clientPending)}
            className="w-full bg-primary text-primary-foreground font-bold py-4 rounded-2xl shadow-cash disabled:opacity-50">
            {saving ? "Guardando…" : amount >= clientPending ? "Confirmar pago total" : "Confirmar abono"}
          </button>
        </div>
      )}
    </WizardShell>
  );
}

function Row({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className="flex items-center justify-between text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className={`font-bold ${highlight ? "text-primary" : ""}`}>{value}</span>
    </div>
  );
}
