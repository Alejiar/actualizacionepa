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
  branches: api.Branch[];
  onDone?: () => void;
}

function formatCOP(n: number) {
  return "$" + n.toLocaleString("es-CO");
}

/** Dado "2026-06" retorna "2026-07" (siguiente mes) */
function nextMonth(ym: string): string {
  // Aritmética pura: no depende de la zona horaria del equipo.
  const [y, m] = ym.split("-").map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
}

/** "2026-06" → "junio 2026" */
function labelMonth(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString("es-CO", { month: "long", year: "numeric" });
}

export function MonthlyCloseWizard({ open, onOpenChange, branches, onDone }: Props) {
  const [step, setStep] = useState(1);
  // Mes por defecto en zona Bogotá (NO UTC). Con new Date().toISOString() el mes se tomaba en
  // UTC: la noche del último día del mes (después de las 7pm Bogotá) el UTC ya marcaba el mes
  // SIGUIENTE, así que al cerrar "agosto" el 31 en la noche el wizard defaulteaba a septiembre y
  // el cierre quedaba guardado con el mes equivocado (y sin sale en Reportes). Mismo criterio que
  // reportes/page.tsx y la regla de zona horaria de CLAUDE.md.
  const [month, setMonth] = useState(() => todayBogota().slice(0, 7));
  const [branchId, setBranchId] = useState("");
  const [targetTotal, setTargetTotal] = useState(0); // capital total objetivo
  const [leaveCash, setLeaveCash] = useState(0);      // cuánto dejar en efectivo
  const [leaveBank, setLeaveBank] = useState(0);      // cuánto dejar en banco
  const [confirmed, setConfirmed] = useState(false);
  const [closing, setClosing] = useState(false);
  const [projection, setProjection] = useState<api.MonthCloseProjection | null>(null);
  const [loadingProj, setLoadingProj] = useState(false);

  // Calcula el capital físico ajustado (objetivo − pendientes) y precarga el reparto.
  async function loadProjection() {
    setLoadingProj(true);
    try {
      const p = await api.getMonthCloseProjection(month, targetTotal, 0, branchId || undefined);
      setProjection(p);
      // Por defecto, todo el físico en efectivo; el usuario lo reparte como quiera.
      setLeaveCash(p.physicalToLeave);
      setLeaveBank(0);
    } catch {
      setProjection(null);
      setLeaveCash(targetTotal);
      setLeaveBank(0);
    } finally {
      setLoadingProj(false);
    }
  }

  function resetForm() {
    setStep(1); setMonth(todayBogota().slice(0, 7)); // Bogotá, no UTC (ver arriba)
    setBranchId(""); setTargetTotal(0); setLeaveCash(0); setLeaveBank(0);
    setConfirmed(false); setProjection(null);
  }

  function close() { onOpenChange(false); setTimeout(resetForm, 250); }

  // El capital físico real a repartir (objetivo − deudas/diferencias pendientes).
  const physicalToLeave = projection ? projection.physicalToLeave : targetTotal;
  const assigned = leaveCash + leaveBank;
  const remaining = physicalToLeave - assigned;
  const splitOk = remaining === 0;

  async function submit() {
    if (!splitOk) { toast.error("El reparto debe sumar exactamente el capital a dejar"); return; }
    setClosing(true);
    try {
      await api.createClose(month, branchId || undefined, leaveCash, leaveBank);
      toast.success(`✅ Cierre de ${labelMonth(month)} — ${labelMonth(nextMonth(month))} inicia con ${formatCOP(leaveCash)} efectivo + ${formatCOP(leaveBank)} banco`);
      onDone?.();
      close();
    } catch (err) {
      toast.error(String(err));
    } finally {
      setClosing(false);
    }
  }

  const selectedBranch = branches.find(b => b.id === branchId);
  const siguiente = nextMonth(month);

  return (
    <WizardShell
      open={open}
      onOpenChange={(v) => { if (!v) close(); }}
      step={step}
      total={4}
      title={
        step === 1 ? "¿Qué mes vas a cerrar?" :
        step === 2 ? `¿Con cuánto capital total quieres iniciar ${labelMonth(siguiente)}?` :
        step === 3 ? "Reparte el capital a dejar" :
        "Confirmar cierre mensual"
      }
      subtitle={
        step === 1 ? undefined
          : `Cerrando: ${labelMonth(month)}${selectedBranch ? ` · ${selectedBranch.name}` : " · Global"}`
      }
      onBack={step > 1 ? () => setStep(step - 1) : undefined}
    >
      {/* Paso 1 — Mes a cerrar */}
      {step === 1 && (
        <div className="space-y-4">
          <div className="space-y-2">
            <label className="text-sm font-medium text-muted-foreground">Período a cerrar</label>
            <input
              type="month"
              value={month}
              onChange={e => setMonth(e.target.value)}
              className="w-full glass-strong rounded-2xl px-5 py-4 text-lg outline-none focus:ring-2 focus:ring-primary/40"
            />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium text-muted-foreground">Sucursal (vacío = global)</label>
            <select
              value={branchId}
              onChange={e => setBranchId(e.target.value)}
              className="w-full glass-strong rounded-2xl px-5 py-3 text-base outline-none focus:ring-2 focus:ring-primary/40"
            >
              <option value="">Global (todas las sucursales)</option>
              {branches.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </div>
          <button
            disabled={!month}
            onClick={() => setStep(2)}
            className="w-full bg-primary text-primary-foreground font-bold py-4 rounded-2xl shadow-cash disabled:opacity-40"
          >
            Siguiente →
          </button>
        </div>
      )}

      {/* Paso 2 — Capital total objetivo */}
      {step === 2 && (
        <div className="space-y-4">
          <div className="glass rounded-2xl px-4 py-3 text-sm text-muted-foreground">
            ¿Con cuánto capital total deseas que arranque <strong>{labelMonth(siguiente)}</strong>? El sistema descontará las deudas/diferencias pendientes y luego tú decides cuánto dejar en efectivo y cuánto en banco.
          </div>
          <MoneyInput value={targetTotal} onChange={setTargetTotal} autoFocus />
          <button
            disabled={targetTotal <= 0 || loadingProj}
            onClick={() => { loadProjection(); setStep(3); }}
            className="w-full bg-primary text-primary-foreground font-bold py-4 rounded-2xl shadow-cash disabled:opacity-40"
          >
            Siguiente →
          </button>
        </div>
      )}

      {/* Paso 3 — Repartir el capital físico entre efectivo y banco */}
      {step === 3 && (
        <div className="space-y-4">
          {loadingProj ? (
            <div className="glass rounded-2xl p-4 text-center text-sm text-muted-foreground">Calculando capital ajustado…</div>
          ) : (
            <>
              {/* Resumen del ajuste por deudas */}
              {projection && projection.pending.total !== 0 && (
                <div className="glass rounded-2xl p-4 space-y-1.5 border border-primary/20">
                  <Row label="Capital objetivo" value={formatCOP(targetTotal)} />
                  <Row label="− Deudas / diferencias pendientes" value={formatCOP(projection.pending.total)} />
                  {/* Desglose de qué compone ese descuento — así se VE que las deudas de clientes
                      (normal y por hora) sí se están restando del capital objetivo. */}
                  <div className="pl-3 space-y-1 border-l-2 border-border/60">
                    {projection.pending.basesDiff !== 0 && <SubRow label="Bases sin devolver" amount={projection.pending.basesDiff} />}
                    {projection.pending.commissionPending !== 0 && <SubRow label="Comisiones domiciliarios" amount={projection.pending.commissionPending} />}
                    {projection.pending.transferDiff !== 0 && <SubRow label="Transferencias sin cuadrar" amount={projection.pending.transferDiff} />}
                    {projection.pending.clientDebtsNormal !== 0 && <SubRow label="Deudas clientes" amount={projection.pending.clientDebtsNormal} />}
                    {projection.pending.clientDebtsHourly !== 0 && <SubRow label="Deudas clientes por hora" amount={projection.pending.clientDebtsHourly} />}
                  </div>
                  <hr className="border-border" />
                  <Row label="Capital físico a dejar" value={formatCOP(physicalToLeave)} highlight />
                  <p className="text-[11px] text-muted-foreground leading-relaxed pt-1">
                    Cuando se paguen esas deudas, el dinero entrará al sistema y se sumará al nuevo mes.
                  </p>
                </div>
              )}

              <p className="text-sm text-muted-foreground">
                Reparte los <strong className="text-foreground">{formatCOP(physicalToLeave)}</strong> entre efectivo y banco como quieras:
              </p>

              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground flex items-center gap-1">💵 Efectivo</label>
                <MoneyInput
                  value={leaveCash}
                  onChange={(v) => {
                    // Al escribir el efectivo, el banco se llena solo con el restante.
                    const cash = Math.min(Math.max(0, v), physicalToLeave);
                    setLeaveCash(cash);
                    setLeaveBank(physicalToLeave - cash);
                  }}
                  autoFocus
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground flex items-center gap-1">🏦 Banco (transferencia)</label>
                <MoneyInput
                  value={leaveBank}
                  onChange={(v) => {
                    // Al escribir el banco, el efectivo se llena solo con el restante.
                    const bank = Math.min(Math.max(0, v), physicalToLeave);
                    setLeaveBank(bank);
                    setLeaveCash(physicalToLeave - bank);
                  }}
                />
              </div>

              {/* Indicador de cuadre del reparto */}
              <div className={`rounded-2xl p-3 flex items-center justify-between text-sm font-bold ${
                splitOk ? "bg-green-500/10 text-green-600" : "bg-amber-500/10 text-amber-600"
              }`}>
                <span>{splitOk ? "✅ Reparto cuadrado" : remaining > 0 ? "Falta por asignar" : "Te pasaste por"}</span>
                <span className="tnum">{splitOk ? formatCOP(physicalToLeave) : formatCOP(Math.abs(remaining))}</span>
              </div>
              {/* Atajos rápidos */}
              <div className="flex gap-2">
                <button onClick={() => { setLeaveCash(physicalToLeave); setLeaveBank(0); }}
                  className="flex-1 text-xs py-2 rounded-xl bg-secondary/60 hover:bg-secondary font-medium transition">Todo efectivo</button>
                <button onClick={() => { setLeaveBank(physicalToLeave); setLeaveCash(0); }}
                  className="flex-1 text-xs py-2 rounded-xl bg-secondary/60 hover:bg-secondary font-medium transition">Todo banco</button>
                <button onClick={() => { const h = Math.round(physicalToLeave / 2); setLeaveCash(physicalToLeave - h); setLeaveBank(h); }}
                  className="flex-1 text-xs py-2 rounded-xl bg-secondary/60 hover:bg-secondary font-medium transition">Mitad y mitad</button>
              </div>

              <button
                disabled={!splitOk}
                onClick={() => setStep(4)}
                className="w-full bg-primary text-primary-foreground font-bold py-4 rounded-2xl shadow-cash disabled:opacity-40"
              >
                {splitOk ? "Ver resumen →" : "Ajusta el reparto para continuar"}
              </button>
            </>
          )}
        </div>
      )}

      {/* Paso 4 — Confirmar */}
      {step === 4 && (
        <div className="space-y-4">
          <div className="glass-strong rounded-2xl p-5 space-y-3">
            <Row label="Mes cerrado" value={labelMonth(month)} />
            <Row label="Sucursal" value={selectedBranch?.name ?? "Global"} />
            <hr className="border-border" />
            <div className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Apertura de {labelMonth(siguiente)}</div>
            <Row label="💵 Efectivo" value={formatCOP(leaveCash)} />
            <Row label="🏦 Banco" value={formatCOP(leaveBank)} />
            <Row label="Total a dejar" value={formatCOP(leaveCash + leaveBank)} highlight />
            {projection && projection.pending.total !== 0 && (
              <p className="text-[11px] text-muted-foreground">
                (Objetivo {formatCOP(targetTotal)} − pendientes {formatCOP(projection.pending.total)})
              </p>
            )}
          </div>

          <div className="glass rounded-2xl p-4 border border-amber-500/30 bg-amber-500/5">
            <p className="text-sm font-medium text-amber-700 dark:text-amber-400">
              ⚠️ Esta acción cierra {labelMonth(month)} y no puede deshacerse.
            </p>
          </div>

          <label className="flex items-center gap-3 cursor-pointer">
            <input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} className="w-5 h-5 rounded" />
            <span className="text-sm font-medium">Confirmo que los datos son correctos</span>
          </label>

          <button
            disabled={!confirmed || closing}
            onClick={submit}
            className="w-full bg-primary text-primary-foreground font-bold py-4 rounded-2xl shadow-cash disabled:opacity-50"
          >
            {closing ? "Generando cierre…" : `Cerrar ${labelMonth(month)}`}
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

// Línea de detalle (indentada) de un componente del descuento. Un componente positivo RESTA
// del objetivo (muestra "−"); uno negativo (p. ej. transferencias con más egresos) SUMA ("+").
function SubRow({ label, amount }: { label: string; amount: number }) {
  const sign = amount >= 0 ? "−" : "+";
  return (
    <div className="flex items-center justify-between text-xs text-muted-foreground">
      <span>· {label}</span>
      <span className="tnum">{sign} {formatCOP(Math.abs(amount))}</span>
    </div>
  );
}
