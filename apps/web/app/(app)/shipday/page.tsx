"use client";

import { useEffect, useState } from "react";
import { RefreshCw, AlertTriangle, Clock, TrendingUp, Bell, Truck, Wifi, Copy, Check, Globe } from "lucide-react";
import { toast } from "sonner";
import Link from "next/link";
import * as api from "@/lib/sd-api";
import type { DashboardFull, LocalUrls } from "@/lib/sd-api";
import { formatCOP, prettyDate } from "@/lib/format";
import { useStore } from "@/lib/store";
import { useDay } from "@/lib/day-context";
import { ShieldCheck } from "lucide-react";

export default function DashboardPage() {
  const [data, setData] = useState<DashboardFull | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const { date, operatingDay } = useDay();
  const isToday = date === operatingDay;

  const load = async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const d = await api.getDashboardFull(undefined, date);
      setData(d);
      setLastUpdated(new Date());
    } catch { if (!silent) toast.error("Error al cargar dashboard"); }
    if (!silent) setLoading(false);
  };

  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [date]);
  useEffect(() => {
    const t = setInterval(() => { if (document.visibilityState === "visible") load(true); }, 8_000);
    return () => clearInterval(t);
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [date]);

  if (loading) {
    return <div className="flex items-center justify-center h-64 text-muted-foreground">Cargando dashboard…</div>;
  }

  if (!data) {
    return (
      <div className="text-center py-16">
        <p className="text-muted-foreground">No se pudo cargar el dashboard</p>
        <button onClick={() => load()} className="mt-3 px-4 py-2 bg-primary text-primary-foreground rounded-xl text-sm font-bold">Reintentar</button>
      </div>
    );
  }

  const { today, month, drivers, debts, caja, topClientDebtors, branches } = data;
  const shiftsStatus = caja.shiftsStatus;
  const allShiftsDone = shiftsStatus.AM && shiftsStatus.PM && shiftsStatus.close;
  const pendingShifts = (["AM", "PM", "close"] as const).filter(s => !shiftsStatus[s]);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-black">Dashboard</h1>
          <p className="text-sm text-muted-foreground">
            {lastUpdated
              ? `Actualizado: ${lastUpdated.toLocaleTimeString("es-CO", { hour: "2-digit", minute: "2-digit" })}`
              : "Cargando…"}
          </p>
        </div>
        <button onClick={() => load()} className="flex items-center gap-2 px-3 py-2 border border-border rounded-xl text-sm hover:bg-secondary transition">
          <RefreshCw className="h-4 w-4" /> Actualizar
        </button>
      </div>

      {/* Garantía (cuenta regresiva de 2 meses) — desaparece al vencer */}
      <WarrantyCard />

      {/* URL de acceso local */}
      <LocalAccessCard />

      {/* Aviso de día seleccionado — igual que en Pedidos */}
      <div className="flex">
        <span className="text-xs text-muted-foreground flex items-center gap-1.5 px-3 py-2 rounded-xl bg-secondary/40">
          📅 Mostrando el día <strong className="capitalize text-foreground">{isToday ? "de hoy" : prettyDate(date)}</strong> — usa las flechas de fecha (arriba) para cambiar de día.
        </span>
      </div>

      {/* Pedidos del día */}
      <section>
        <h2 className="text-xs font-bold uppercase tracking-wider text-muted-foreground mb-3">
          Pedidos {isToday ? "de hoy" : `del ${prettyDate(date)}`}
        </h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <MetricCard icon="📦" label="Pedidos" value={String(today.orders)} sub={isToday ? "entregados hoy" : "entregados ese día"} />
          <MetricCard icon="💰" label="Valor total" value={formatCOP(today.value)} sub={isToday ? "domicilios hoy" : "domicilios ese día"} />
          <MetricCard icon="🏢" label="% empresa" value={formatCOP(today.company)} sub={isToday ? "comisiones hoy" : "comisiones ese día"} accent />
          <MetricCard icon="⚠️" label="Deuda comisiones" value={formatCOP(debts.totalAmount)} sub={`${debts.driverCount} dom. · base sin devolver ${formatCOP(debts.basesPending ?? 0)}`} warn={debts.totalAmount > 0} />
        </div>
      </section>

      {/* Estado de caja */}
      <section>
        <h2 className="text-xs font-bold uppercase tracking-wider text-muted-foreground mb-3">
          Estado de caja {isToday ? "hoy" : `del ${prettyDate(date)}`}
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* Turnos */}
          <div className="glass-strong rounded-2xl p-4">
            <div className="flex items-center justify-between mb-3">
              <span className="font-bold text-sm">Turnos de caja</span>
              {allShiftsDone
                ? <span className="text-xs px-2 py-0.5 rounded-full bg-green-500/10 text-green-600 font-bold">✅ Completos</span>
                : <span className="text-xs px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-600 font-bold">⏳ {pendingShifts.length} pendiente(s)</span>
              }
            </div>
            <div className="grid grid-cols-3 gap-2">
              {(["AM", "PM", "close"] as const).map(slot => {
                const s = caja.shifts.find(sh => sh.shift === slot);
                const done = shiftsStatus[slot];
                return (
                  <div key={slot} className={`rounded-xl p-3 text-center ${done ? (s?.difference === 0 ? "bg-green-500/10" : "bg-amber-500/10") : "bg-secondary/40"}`}>
                    <div className="text-lg">{slot === "AM" ? "☀️" : slot === "PM" ? "🌙" : "🔒"}</div>
                    <div className="text-xs font-bold mt-1">{slot === "close" ? "Cierre" : slot}</div>
                    {done && s ? (
                      <div className={`text-[10px] font-bold mt-0.5 ${s.difference === 0 ? "text-green-600" : "text-amber-600"}`}>
                        {s.difference === 0 ? "✓" : `${s.difference > 0 ? "+" : ""}${formatCOP(s.difference)}`}
                      </div>
                    ) : (
                      <div className="text-[10px] text-muted-foreground mt-0.5">pendiente</div>
                    )}
                  </div>
                );
              })}
            </div>
            {isToday && pendingShifts.length > 0 && (
              <Link href="/caja" className="mt-3 flex items-center justify-center gap-2 w-full py-2.5 bg-primary/10 text-primary rounded-xl text-xs font-bold hover:bg-primary/20 transition">
                <Clock className="h-3.5 w-3.5" /> Registrar turno pendiente →
              </Link>
            )}
          </div>

          {/* Saldos esperados + Banco hoy */}
          <div className="glass-strong rounded-2xl p-4 space-y-4">
            {/* Efectivo y banco esperados */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <span className="font-bold text-sm">Saldos esperados {isToday ? "hoy" : "a ese día"}</span>
                <Link href="/movimientos" className="text-xs text-primary font-bold hover:underline">Ver movimientos →</Link>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div className="rounded-xl p-3 bg-secondary/60 text-center">
                  <div className="text-xs text-muted-foreground">💵 Efectivo en caja</div>
                  <div className={`font-black text-base tnum mt-0.5 ${caja.expectedCash < 0 ? "text-red-500" : "text-foreground"}`}>
                    {formatCOP(caja.expectedCash)}
                  </div>
                </div>
                <div className="rounded-xl p-3 bg-secondary/60 text-center">
                  <div className="text-xs text-muted-foreground">🏦 Saldo bancario</div>
                  <div className={`font-black text-base tnum mt-0.5 ${caja.expectedBank < 0 ? "text-red-500" : "text-foreground"}`}>
                    {formatCOP(caja.expectedBank)}
                  </div>
                </div>
              </div>
            </div>

            {/* Movimientos bancarios de hoy */}
            <div className="border-t border-border pt-3">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-bold text-muted-foreground uppercase tracking-wider">
                  Banco {isToday ? "hoy" : "ese día"}
                </span>
                <Link href="/banco" className="text-xs text-primary font-bold hover:underline">Ver todo →</Link>
              </div>
              <div className="space-y-1.5">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground flex items-center gap-1.5"><TrendingUp className="h-3.5 w-3.5 text-green-600" /> Ingresos</span>
                  <span className="font-bold text-green-600 tnum">{formatCOP(caja.bankToday.ingresos)}</span>
                </div>
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground flex items-center gap-1.5"><TrendingUp className="h-3.5 w-3.5 text-red-500 rotate-180" /> Egresos</span>
                  <span className="font-bold text-red-500 tnum">{formatCOP(caja.bankToday.egresos)}</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Mes actual */}
      <section>
        <h2 className="text-xs font-bold uppercase tracking-wider text-muted-foreground mb-3">Mes actual</h2>
        <div className="grid grid-cols-3 gap-3">
          <MetricCard icon="📋" label="Pedidos mes" value={String(month.orders)} sub="este período" />
          <MetricCard icon="💵" label="Valor mes" value={formatCOP(month.value)} sub="total entregado" />
          <MetricCard icon="🏢" label="% empresa mes" value={formatCOP(month.company)} sub="comisiones" accent />
        </div>
      </section>

      {/* Alertas */}
      {(debts.driverCount > 0 || topClientDebtors.length > 0) && (
        <section>
          <h2 className="text-xs font-bold uppercase tracking-wider text-muted-foreground mb-3">Alertas</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {debts.driverCount > 0 && (
              <div className="glass-strong rounded-2xl p-4">
                <div className="flex items-center justify-between mb-3">
                  <span className="flex items-center gap-2 font-bold text-sm text-red-600">
                    <AlertTriangle className="h-4 w-4" /> Domiciliarios con deuda
                    <span className="text-xs font-bold bg-red-500/10 px-1.5 py-0.5 rounded-full">{debts.driverCount}</span>
                  </span>
                  <Link href="/shipday/domiciliarios" className="text-xs text-primary font-bold hover:underline">Ver todos →</Link>
                </div>
                <p className="text-sm text-muted-foreground">
                  Comisiones: <span className="font-black text-red-500">{formatCOP(debts.totalAmount)}</span>
                  {" · "}Base sin devolver: <span className="font-black text-amber-600">{formatCOP(debts.basesPending ?? 0)}</span>
                </p>
                <Link href="/shipday/domiciliarios" className="mt-3 flex items-center gap-2 text-xs font-bold text-primary hover:underline">
                  <Truck className="h-3.5 w-3.5" /> Ir a Domiciliarios para cobrar
                </Link>
              </div>
            )}
            {topClientDebtors.length > 0 && (
              <div className="glass-strong rounded-2xl p-4">
                <div className="flex items-center justify-between mb-3">
                  <span className="flex items-center gap-2 font-bold text-sm text-amber-600">
                    <Bell className="h-4 w-4" /> Clientes con saldo pendiente
                    <span className="text-xs font-bold bg-amber-500/10 px-1.5 py-0.5 rounded-full">{topClientDebtors.length}</span>
                  </span>
                  <Link href="/clientes" className="text-xs text-primary font-bold hover:underline">Ver todos →</Link>
                </div>
                <div className="space-y-2">
                  {topClientDebtors.map(c => (
                    <div key={c.id} className="flex items-center justify-between text-sm py-1.5 border-b border-border last:border-0">
                      <span className="font-medium">{c.name}</span>
                      <span className="font-black text-red-500 tnum">{formatCOP(c.pendingDebt)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </section>
      )}

      {/* Sucursales */}
      <section>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Sucursales</h2>
          <div className="flex gap-3 text-xs">
            <Link href="/sucursales" className="text-primary font-bold hover:underline">Gestionar →</Link>
            <Link href="/shipday/bases" className="text-muted-foreground hover:text-foreground">Bases</Link>
            <Link href="/shipday/deudas" className="text-muted-foreground hover:text-foreground">Deudas detalle</Link>
          </div>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {branches.map(b => (
            <div key={b.id} className="glass-strong rounded-2xl p-4 flex items-center justify-between">
              <div>
                <div className="font-bold">{b.name}</div>
                <div className="text-xs text-muted-foreground">
                  {b.lastSyncAt
                    ? `Última sync: ${new Date(b.lastSyncAt).toLocaleTimeString("es-CO", { hour: "2-digit", minute: "2-digit" })}`
                    : "Sin sync"}
                </div>
              </div>
              <span className={`flex items-center gap-1.5 text-xs font-bold ${b.syncStatus === "ok" ? "text-green-600" : b.syncStatus === "error" ? "text-red-500" : "text-muted-foreground"}`}>
                <span className={`w-2 h-2 rounded-full ${b.syncStatus === "ok" ? "bg-green-500" : b.syncStatus === "error" ? "bg-red-500" : "bg-gray-400"}`} />
                {b.syncStatus === "ok" ? "Conectada" : b.syncStatus === "error" ? "Error" : "Sin datos"}
              </span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function MetricCard({ icon, label, value, sub, accent, warn }: {
  icon: string; label: string; value: string; sub: string; accent?: boolean; warn?: boolean;
}) {
  return (
    <div className="glass-strong rounded-2xl p-4">
      <div className="text-2xl">{icon}</div>
      <div className="text-xs text-muted-foreground mt-2">{label}</div>
      <div className={`font-black text-xl tnum mt-0.5 ${accent ? "text-primary" : warn ? "text-red-500" : ""}`}>{value}</div>
      <div className="text-xs text-muted-foreground mt-1">{sub}</div>
    </div>
  );
}

function WarrantyCard() {
  const { state } = useStore();
  const accepted = state.settings.termsAcceptedAt;
  const [, setTick] = useState(0);
  // Refrescar el contador cada minuto
  useEffect(() => {
    const t = setInterval(() => setTick(x => x + 1), 60_000);
    return () => clearInterval(t);
  }, []);

  if (!accepted) return null;
  const start = new Date(accepted).getTime();
  const end = start + 60 * 24 * 60 * 60 * 1000; // 2 meses (60 días)
  const remaining = end - Date.now();
  if (remaining <= 0) return null; // garantía vencida → no se muestra

  const days = Math.floor(remaining / (24 * 60 * 60 * 1000));
  const hours = Math.floor((remaining % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000));
  const pct = Math.max(0, Math.min(100, (remaining / (60 * 24 * 60 * 60 * 1000)) * 100));
  const low = days <= 7;

  return (
    <div className={`glass-strong rounded-2xl p-4 border ${low ? "border-amber-500/40" : "border-green-500/30"}`}>
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <div className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${low ? "bg-amber-500/15" : "bg-green-500/15"}`}>
            <ShieldCheck className={`h-5 w-5 ${low ? "text-amber-500" : "text-green-600"}`} />
          </div>
          <div>
            <div className="font-bold text-sm">Garantía del sistema</div>
            <div className="text-xs text-muted-foreground">
              Vence el {new Date(end).toLocaleDateString("es-CO", { day: "2-digit", month: "long", year: "numeric" })}
            </div>
          </div>
        </div>
        <div className="text-right">
          <div className={`font-black text-xl tnum ${low ? "text-amber-500" : "text-green-600"}`}>
            {days} día{days !== 1 ? "s" : ""} {hours}h
          </div>
          <div className="text-[11px] text-muted-foreground">restantes de cobertura</div>
        </div>
      </div>
      <div className="mt-3 h-1.5 rounded-full bg-secondary overflow-hidden">
        <div className={`h-full ${low ? "bg-amber-500" : "bg-green-500"}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function LocalAccessCard() {
  const [info, setInfo] = useState<LocalUrls | null>(null);
  const [copied, setCopied] = useState(false);

  const load = () => api.getLocalUrls().then(setInfo).catch(() => {});

  useEffect(() => {
    load();
    // Re-detectar la IP cada 20s — si cambia la red WiFi, se actualiza solo
    const t = setInterval(load, 20_000);
    return () => clearInterval(t);
  }, []);

  // Combina la IP de red detectada por el servidor con el puerto que el
  // navegador está usando AHORA. Así el enlace apunta al frontend (no a la API),
  // tanto en desarrollo (puerto del front) como en producción (mismo puerto).
  const browserPort = typeof window !== "undefined" ? window.location.port : "";
  // IP local (LAN/WiFi): la primera que NO sea Tailscale.
  const localIp = info?.local ? info.local.replace(/^https?:\/\//, "").split(":")[0] : info?.urls?.[0]?.ip;
  const browserUrl = typeof window !== "undefined" ? window.location.origin : "";
  let shareUrl = browserUrl;
  if (localIp && typeof window !== "undefined") {
    shareUrl = `http://${localIp}${browserPort ? ":" + browserPort : ""}`;
  }
  // URL de Tailscale (acceso remoto fuera de la red local).
  const tailscaleIp = info?.tailscale ? info.tailscale.replace(/^https?:\/\//, "").split(":")[0] : null;
  const tailscaleUrl = tailscaleIp ? `http://${tailscaleIp}${browserPort ? ":" + browserPort : ""}` : null;

  async function copy(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      toast.success("📋 Enlace copiado — compártelo con otros dispositivos");
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("No se pudo copiar");
    }
  }

  return (
    <div className="glass-strong rounded-2xl p-4 border border-primary/20">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
            <Wifi className="h-5 w-5 text-primary" />
          </div>
          <div className="min-w-0">
            <div className="text-sm font-bold">Acceso desde otros dispositivos</div>
            <div className="text-xs text-muted-foreground">Conéctate a la misma red WiFi y abre este enlace</div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <code className="px-3 py-2 rounded-xl bg-secondary text-sm font-mono font-bold tnum select-all">
            {shareUrl}
          </code>
          <button
            onClick={() => copy(shareUrl)}
            className="flex items-center gap-2 px-3 py-2 bg-primary text-primary-foreground rounded-xl text-sm font-bold hover:opacity-90 transition shrink-0"
          >
            {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
            {copied ? "Copiado" : "Copiar"}
          </button>
        </div>
      </div>

      {/* URL de Tailscale — acceso remoto desde fuera de la red local */}
      <div className="mt-3 pt-3 border-t border-border flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-10 h-10 rounded-xl bg-blue-500/10 flex items-center justify-center shrink-0">
            <Globe className="h-5 w-5 text-blue-500" />
          </div>
          <div className="min-w-0">
            <div className="text-sm font-bold">Acceso remoto (Tailscale)</div>
            <div className="text-xs text-muted-foreground">Desde otra red: ambos equipos con Tailscale conectado</div>
          </div>
        </div>
        {tailscaleUrl ? (
          <div className="flex items-center gap-2">
            <code className="px-3 py-2 rounded-xl bg-secondary text-sm font-mono font-bold tnum select-all">
              {tailscaleUrl}
            </code>
            <button
              onClick={() => copy(tailscaleUrl)}
              className="flex items-center gap-2 px-3 py-2 bg-blue-500 text-white rounded-xl text-sm font-bold hover:opacity-90 transition shrink-0"
            >
              <Copy className="h-4 w-4" /> Copiar
            </button>
          </div>
        ) : (
          <span className="text-xs text-muted-foreground italic px-3 py-2">
            Tailscale no detectado (verifica que esté conectado en este equipo)
          </span>
        )}
      </div>

      {/* Otras IPs disponibles (excluyendo local y Tailscale ya mostradas) */}
      {info && info.urls.filter(u => u.ip !== localIp && u.ip !== tailscaleIp).length > 0 && (
        <div className="mt-3 pt-3 border-t border-border flex flex-wrap gap-2 items-center">
          <span className="text-xs text-muted-foreground">Otras redes:</span>
          {info.urls.filter(u => u.ip !== localIp && u.ip !== tailscaleIp).map(u => {
            const altUrl = `http://${u.ip}${browserPort ? ":" + browserPort : ""}`;
            return (
              <button
                key={u.ip}
                onClick={() => copy(altUrl)}
                title={`Copiar (${u.name})`}
                className="text-xs px-2 py-1 rounded-lg bg-secondary/60 hover:bg-secondary font-mono transition"
              >
                {altUrl}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
