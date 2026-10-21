"use client";
import { useEffect, useState } from "react";
import { WizardShell } from "./WizardShell";
import { MoneyInput } from "../MoneyInput";
import { toast } from "sonner";
import * as api from "@/lib/sd-api";
import type { Branch, Driver, Client } from "@/lib/sd-api";
import { todayBogota } from "@/lib/format";
import { useDay } from "@/lib/day-context";

const newKey = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2, 12)}`);

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onDone?: () => void;
}

function formatCOP(n: number) { return "$" + n.toLocaleString("es-CO"); }

export function ManualOrderWizard({ open, onOpenChange, onDone }: Props) {
  const [step, setStep] = useState(1);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [drivers, setDrivers] = useState<Driver[]>([]);
  const [debtors, setDebtors] = useState<Client[]>([]);

  const [branchId, setBranchId] = useState("");
  const [driverId, setDriverId] = useState("");
  const [deliveryValue, setDeliveryValue] = useState(0);
  const [orderNumber, setOrderNumber] = useState("");
  const [customerName, setCustomerName] = useState("");
  const [clientId, setClientId] = useState("");
  const [addToDebt, setAddToDebt] = useState(false);
  const [saving, setSaving] = useState(false);
  // Fecha REAL de entrega (decisión del dueño, 15-oct-2026): puede ser un día ya cerrado.
  // NEW02: por defecto el pedido es del día operativo (la caja abierta); ese es el máximo.
  const { operatingDay } = useDay();
  const [deliveryDate, setDeliveryDate] = useState(operatingDay);
  const [deliveryTime, setDeliveryTime] = useState("");
  const [dayClosed, setDayClosed] = useState(false);
  // Una clave por pedido: si la red falla y se reintenta, el servidor no lo duplica.
  const [idemKey, setIdemKey] = useState(newKey);

  useEffect(() => {
    if (!open) return;
    Promise.all([api.getBranches(), api.getDebtors()]).then(([b, d]) => {
      setBranches(b);
      setDebtors(d);
      if (b.length === 1) setBranchId(b[0].id);
    }).catch(() => {});
  }, [open]);

  useEffect(() => {
    if (!branchId) return;
    // Solo domiciliarios activos: a uno desactivado no se le registran pedidos nuevos.
    api.getDrivers(branchId).then(ds => setDrivers(ds.filter(d => d.active))).catch(() => {});
  }, [branchId]);

  useEffect(() => {
    if (!open || !/^\d{4}-\d{2}-\d{2}$/.test(deliveryDate)) return;
    api.getShiftsForDate(deliveryDate).then(s => setDayClosed(s.some(x => x.shift === "close"))).catch(() => setDayClosed(false));
  }, [open, deliveryDate]);

  function reset() {
    setStep(1); setBranchId(""); setDriverId(""); setDeliveryValue(0);
    setOrderNumber(""); setCustomerName(""); setClientId(""); setAddToDebt(false);
    setDeliveryDate(operatingDay); setDeliveryTime(""); setIdemKey(newKey());
  }
  function close() { onOpenChange(false); setTimeout(reset, 250); }

  // Una entrega no puede ser futura (el servidor también lo valida).
  const nowHM = new Date().toLocaleTimeString("en-GB", { timeZone: "America/Bogota", hour: "2-digit", minute: "2-digit" });
  const futureTime = !!deliveryTime && deliveryDate === todayBogota() && deliveryTime > nowHM;
  const selectedBranch = branches.find(b => b.id === branchId);
  const selectedDriver = drivers.find(d => d.id === driverId);
  const selectedClient = debtors.find(c => c.id === clientId);

  async function submit() {
    if (!branchId || deliveryValue <= 0) return;
    setSaving(true);
    try {
      await api.createManualOrder({
        deliveredAt: deliveryTime ? `${deliveryDate}T${deliveryTime}:00-05:00` : deliveryDate,
        idempotencyKey: idemKey,
        branchId,
        driverId: driverId || undefined,
        deliveryValue,
        orderNumber: orderNumber || undefined,
        customerName: customerName || selectedClient?.name || undefined,
        clientId: clientId || undefined,
        addToClientDebt: addToDebt,
      });
      toast.success(`✅ Pedido registrado — ${formatCOP(deliveryValue)}${selectedClient && addToDebt ? ` (deuda agregada a ${selectedClient.name})` : ""}`);
      onDone?.();
      close();
    } catch (err) {
      toast.error(String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <WizardShell
      open={open}
      onOpenChange={(v) => { if (!v) close(); }}
      step={step}
      total={4}
      title={
        step === 1 ? "Sucursal y domiciliario" :
        step === 2 ? "Valor y número del pedido" :
        step === 3 ? "¿Es para un cliente con deuda?" :
        "Confirmar pedido"
      }
      onBack={step > 1 ? () => setStep(s => s - 1) : undefined}
    >
      {/* Paso 1 — Sucursal + Domiciliario */}
      {step === 1 && (
        <div className="space-y-4">
          <div className="space-y-2">
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Sucursal</label>
            {branches.length === 0 ? (
              <p className="text-sm text-muted-foreground">Cargando…</p>
            ) : (
              <div className="space-y-2">
                {branches.map(b => (
                  <button
                    key={b.id}
                    onClick={() => setBranchId(b.id)}
                    className={`w-full p-3 rounded-xl border-2 text-left transition ${branchId === b.id ? "border-primary bg-primary/10" : "border-border glass hover:border-primary/40"}`}
                  >
                    <span className="font-bold text-sm">{b.name}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          {branchId && (
            <div className="space-y-2">
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Domiciliario (opcional)</label>
              <DriverPicker drivers={drivers} value={driverId} onChange={setDriverId} />
            </div>
          )}
          <button
            disabled={!branchId}
            onClick={() => setStep(2)}
            className="w-full bg-primary text-primary-foreground font-bold py-4 rounded-2xl shadow-cash disabled:opacity-40"
          >
            Siguiente →
          </button>
        </div>
      )}

      {/* Paso 2 — Valor + Número */}
      {step === 2 && (
        <div className="space-y-4">
          <MoneyInput value={deliveryValue} onChange={setDeliveryValue} autoFocus />
          <input
            value={orderNumber}
            onChange={e => setOrderNumber(e.target.value)}
            placeholder="Número de pedido (opcional)"
            className="w-full glass rounded-2xl px-5 py-3 text-sm outline-none focus:ring-2 focus:ring-primary/30"
          />
          <input
            value={customerName}
            onChange={e => setCustomerName(e.target.value)}
            placeholder="Nombre del cliente (opcional si no tiene cuenta)"
            className="w-full glass rounded-2xl px-5 py-3 text-sm outline-none focus:ring-2 focus:ring-primary/30"
          />
          <div className="grid grid-cols-2 gap-3">
            <label className="space-y-1">
              <span className="text-xs font-medium text-muted-foreground">Fecha de entrega</span>
              <input type="date" aria-label="Fecha de entrega" value={deliveryDate} max={operatingDay}
                onChange={e => setDeliveryDate(e.target.value)}
                className="w-full glass rounded-2xl px-4 py-3 text-sm outline-none focus:ring-2 focus:ring-primary/30" />
            </label>
            <label className="space-y-1">
              <span className="text-xs font-medium text-muted-foreground">Hora (opcional)</span>
              <input type="time" aria-label="Hora de entrega" value={deliveryTime}
                onChange={e => setDeliveryTime(e.target.value)}
                className="w-full glass rounded-2xl px-4 py-3 text-sm outline-none focus:ring-2 focus:ring-primary/30" />
            </label>
          </div>
          {futureTime && <p className="text-xs text-red-500 px-1">La hora de entrega no puede ser posterior a la hora actual ({nowHM}).</p>}
          {dayClosed && (
            <p className="text-xs rounded-xl bg-amber-500/10 text-amber-700 dark:text-amber-400 px-3 py-2">
              🔒 Ese día ya tiene Cierre. El pedido se carga en su fecha real: suma la comisión y aparece en los reportes, pero no cambia el efectivo, el banco ni el conteo del Cierre.
            </p>
          )}
          <button
            disabled={deliveryValue <= 0 || !deliveryDate || deliveryDate > operatingDay || futureTime}
            onClick={() => setStep(3)}
            className="w-full bg-primary text-primary-foreground font-bold py-4 rounded-2xl shadow-cash disabled:opacity-40"
          >
            Siguiente →
          </button>
        </div>
      )}

      {/* Paso 3 — Cliente deudor */}
      {step === 3 && (
        <div className="space-y-4">
          {debtors.length === 0 ? (
            <div className="glass rounded-2xl p-5 text-center text-sm text-muted-foreground">
              <p className="text-2xl mb-2">✅</p>
              <p>No hay clientes con saldo pendiente</p>
              <p className="text-xs mt-1">El pedido se registrará sin vincular a ningún cliente</p>
            </div>
          ) : (
            <>
              <p className="text-sm text-muted-foreground">
                ¿Este pedido es para un cliente con saldo pendiente? Selecciónalo para vincularlo.
              </p>
              <div className="space-y-2 max-h-48 overflow-y-auto">
                <button
                  onClick={() => { setClientId(""); setAddToDebt(false); }}
                  className={`w-full p-3 rounded-xl border-2 text-left transition ${!clientId ? "border-primary bg-primary/10" : "border-border glass"}`}
                >
                  <div className="text-sm font-medium">Sin cliente vinculado</div>
                  <div className="text-xs text-muted-foreground">Pedido normal, sin deuda</div>
                </button>
                {debtors.map(c => (
                  <button
                    key={c.id}
                    onClick={() => setClientId(c.id)}
                    className={`w-full p-3 rounded-xl border-2 text-left transition ${clientId === c.id ? "border-red-500 bg-red-500/10" : "border-border glass hover:border-red-400/40"}`}
                  >
                    <div className="flex items-center justify-between">
                      <div>
                        <div className="text-sm font-bold">{c.name}</div>
                        {c.phone && <div className="text-xs text-muted-foreground">{c.phone}</div>}
                      </div>
                      <div className="text-right">
                        <div className="text-xs text-muted-foreground">Deuda actual</div>
                        <div className="font-black text-red-600 text-sm tnum">{formatCOP(c.pendingDebt)}</div>
                      </div>
                    </div>
                  </button>
                ))}
              </div>
              {clientId && (
                <label className="flex items-start gap-3 cursor-pointer p-3 rounded-xl glass">
                  <input
                    type="checkbox"
                    checked={addToDebt}
                    onChange={e => setAddToDebt(e.target.checked)}
                    className="mt-0.5 w-4 h-4"
                  />
                  <div>
                    <div className="text-sm font-medium">Agregar este domicilio al saldo del cliente</div>
                    <div className="text-xs text-muted-foreground">
                      Se creará una deuda de {formatCOP(deliveryValue)} a nombre de {selectedClient?.name}
                    </div>
                  </div>
                </label>
              )}
            </>
          )}
          <button
            onClick={() => setStep(4)}
            className="w-full bg-primary text-primary-foreground font-bold py-4 rounded-2xl shadow-cash"
          >
            Siguiente →
          </button>
        </div>
      )}

      {/* Paso 4 — Confirmar */}
      {step === 4 && (
        <div className="space-y-4">
          <div className="glass-strong rounded-2xl p-5 space-y-3">
            <Row label="Sucursal" value={selectedBranch?.name ?? "—"} />
            {selectedDriver && <Row label="Domiciliario" value={selectedDriver.name} />}
            {orderNumber && <Row label="Pedido #" value={orderNumber} />}
            <Row label="Entregado" value={`${deliveryDate.split("-").reverse().join("/")}${deliveryTime ? ` ${deliveryTime}` : ""}${dayClosed ? " (día cerrado)" : ""}`} />
            <hr className="border-border" />
            <Row label="Valor domicilio" value={formatCOP(deliveryValue)} highlight positive />
            {selectedClient ? (
              <>
                <Row label="Cliente vinculado" value={selectedClient.name} />
                {addToDebt && (
                  <div className="flex items-center justify-between text-sm bg-red-500/10 rounded-xl px-3 py-2">
                    <span className="text-red-600 font-medium">⚠️ Se sumará a su deuda</span>
                    <span className="font-black text-red-600 tnum">{formatCOP(deliveryValue)}</span>
                  </div>
                )}
              </>
            ) : (
              <Row label="Cliente" value={customerName || "Sin cliente registrado"} />
            )}
          </div>
          <button
            disabled={saving}
            onClick={submit}
            className="w-full bg-primary text-primary-foreground font-bold py-4 rounded-2xl shadow-cash disabled:opacity-50"
          >
            {saving ? "Registrando…" : "Confirmar pedido"}
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

// Selector interactivo de domiciliario con búsqueda (reemplaza el <select> nativo)
function DriverPicker({ drivers, value, onChange }: { drivers: Driver[]; value: string; onChange: (id: string) => void }) {
  const [search, setSearch] = useState("");
  const selected = drivers.find(d => d.id === value);
  const filtered = search.trim()
    ? drivers.filter(d => d.name.toLowerCase().includes(search.toLowerCase()))
    : drivers;

  return (
    <div className="space-y-2">
      {/* Buscador */}
      <input
        value={search}
        onChange={e => setSearch(e.target.value)}
        placeholder="🔍 Buscar domiciliario…"
        className="w-full glass rounded-xl px-4 py-2.5 text-sm outline-none focus:ring-2 focus:ring-primary/30"
      />
      {/* Lista de opciones con scroll */}
      <div className="max-h-44 overflow-y-auto space-y-1 rounded-xl">
        <button
          onClick={() => onChange("")}
          className={`w-full px-3 py-2.5 rounded-xl text-left text-sm font-medium transition flex items-center gap-2 ${
            value === "" ? "bg-primary/15 text-primary border-2 border-primary" : "bg-secondary/40 border-2 border-transparent hover:bg-secondary"
          }`}
        >
          <span className="w-7 h-7 rounded-full bg-muted flex items-center justify-center text-xs">—</span>
          Sin asignar
        </button>
        {filtered.map(d => (
          <button
            key={d.id}
            onClick={() => onChange(d.id)}
            className={`w-full px-3 py-2.5 rounded-xl text-left text-sm font-medium transition flex items-center gap-2 ${
              value === d.id ? "bg-primary/15 text-primary border-2 border-primary" : "bg-secondary/40 border-2 border-transparent hover:bg-secondary"
            }`}
          >
            <span className="w-7 h-7 rounded-full bg-primary/15 text-primary flex items-center justify-center text-xs font-black">
              {d.name.charAt(0).toUpperCase()}
            </span>
            {d.name}
          </button>
        ))}
        {filtered.length === 0 && (
          <p className="text-center py-3 text-xs text-muted-foreground">Sin resultados para "{search}"</p>
        )}
      </div>
      {selected && (
        <p className="text-xs text-primary font-medium px-1">✓ Seleccionado: {selected.name}</p>
      )}
    </div>
  );
}
