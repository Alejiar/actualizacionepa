"use client";

import { useEffect, useMemo, useState } from "react";
import { RefreshCw, AlertCircle, Wallet, Banknote, Package, ChevronDown, ChevronUp } from "lucide-react";
import { toast } from "sonner";
import * as api from "@/lib/sd-api";
import type { Driver, Branch, Order } from "@/lib/sd-api";
import { formatCOP, prettyDate } from "@/lib/format";
import { useDay } from "@/lib/day-context";
import { DriverStatementModal } from "@/components/DriverStatementModal";
import { LiveBadge } from "@/components/LiveBadge";

export default function DomiciliariosShipdayPage() {
  const [drivers, setDrivers] = useState<Driver[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [todayOrders, setTodayOrders] = useState<Order[]>([]);
  const [branchId, setBranchId] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Driver | null>(null);
  const [showTodayList, setShowTodayList] = useState(true);
  const [search, setSearch] = useState("");
  // Día seleccionado en el sistema (flechas de fecha de la cabecera) — igual que Pedidos.
  const { date, operatingDay } = useDay();
  const isToday = date === operatingDay;

  // Carga completa (con spinner) — incluye sucursales
  const load = async () => {
    setLoading(true);
    try {
      const [d, b, t] = await Promise.all([
        api.getDrivers(branchId || undefined),
        api.getBranches(),
        api.getOrdersToday(branchId || undefined, date),
      ]);
      setDrivers(d);
      setBranches(b);
      setTodayOrders(t);
    } catch {
      toast.error("Error al cargar");
    }
    setLoading(false);
  };

  // Refresco silencioso — solo datos en vivo (sin sucursales ni spinner)
  const refreshLive = async () => {
    try {
      const [d, t] = await Promise.all([
        api.getDrivers(branchId || undefined),
        api.getOrdersToday(branchId || undefined, date),
      ]);
      setDrivers(d);
      setTodayOrders(t);
    } catch { /* silencioso */ }
  };

  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [branchId, date]);

  // Auto-refresh cada 10s (refresco silencioso de datos en vivo)
  useEffect(() => {
    const t = setInterval(refreshLive, 10_000);
    return () => clearInterval(t);
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [branchId, date]);

  // Resumen por domiciliario para hoy
  const todayByDriver = useMemo(() => {
    const map = new Map<string, { driverId: string; name: string; count: number; total: number; company: number; orders: Order[] }>();
    for (const o of todayOrders) {
      const key = o.driver?.id ?? "sin-asignar";
      // Con la sucursal: dos domiciliarios homónimos de sucursales distintas se veían iguales (como AIF04).
      const branchName = branches.find(b => b.id === o.branchId)?.name;
      const name = o.driver?.name ? (branchName ? `${o.driver.name} · ${branchName}` : o.driver.name) : "Sin asignar";
      const cur = map.get(key) ?? { driverId: key, name, count: 0, total: 0, company: 0, orders: [] };
      cur.count++;
      cur.total += o.deliveryValue;
      cur.company += o.companyAmount;
      cur.orders.push(o);
      map.set(key, cur);
    }
    return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name, "es"));
  }, [todayOrders, branches]);

  // F14: comisiones y base sin devolver son cuentas separadas.
  const totalDebt = drivers.reduce((s, d) => s + d.pendingDebt, 0);
  const totalBase = drivers.reduce((s, d) => s + (d.basePending ?? 0), 0);
  const withDebt = drivers.filter(d => d.pendingDebt > 0 || (d.basePending ?? 0) > 0);
  const todayTotal = todayOrders.reduce((s, o) => s + o.deliveryValue, 0);
  const todayCompany = todayOrders.reduce((s, o) => s + o.companyAmount, 0);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-black">Domiciliarios</h1>
            <LiveBadge />
          </div>
          <p className="text-sm text-muted-foreground">
            {drivers.length} domiciliarios · {withDebt.length} con deuda
          </p>
        </div>
        <div className="flex gap-2">
          <select
            value={branchId}
            onChange={e => setBranchId(e.target.value)}
            className="px-3 py-2 rounded-xl border border-border bg-background text-sm"
          >
            <option value="">Todas las sucursales</option>
            {branches.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
          <button onClick={load} className="p-2 rounded-xl border border-border hover:bg-secondary transition" title="Refrescar">
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
          </button>
        </div>
      </div>

      {/* Aviso de día seleccionado — igual que en Pedidos */}
      <span className="inline-flex text-xs text-muted-foreground items-center gap-1.5 px-3 py-2 rounded-xl bg-secondary/40">
        📅 Mostrando el día <strong className="capitalize text-foreground">{isToday ? "de hoy" : prettyDate(date)}</strong> — usa las flechas de fecha (arriba) para cambiar de día.
      </span>

      {/* Top KPIs */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <KPI label={`Deuda comisiones · base ${formatCOP(totalBase)}`} value={formatCOP(totalDebt)} icon={<AlertCircle className="h-4 w-4" />} highlight={totalDebt > 0} />
        <KPI label={`Pedidos ${isToday ? "hoy" : "ese día"}`} value={String(todayOrders.length)} icon={<Package className="h-4 w-4" />} />
        <KPI label={`Valor entregado ${isToday ? "hoy" : "ese día"}`} value={formatCOP(todayTotal)} icon={<Banknote className="h-4 w-4" />} />
        <KPI label={`% empresa ${isToday ? "hoy" : "ese día"}`} value={formatCOP(todayCompany)} icon={<Wallet className="h-4 w-4" />} />
      </div>

      {/* Pedidos del día — todos los domiciliarios */}
      <div className="glass-strong rounded-3xl overflow-hidden">
        <button
          onClick={() => setShowTodayList(v => !v)}
          className="w-full flex items-center justify-between px-5 py-4 hover:bg-secondary/30 transition"
        >
          <div className="text-left">
            <h2 className="font-black">Pedidos {isToday ? "de hoy" : `del ${prettyDate(date)}`} — todos los domiciliarios</h2>
            <p className="text-xs text-muted-foreground">
              {todayOrders.length} pedidos · {todayByDriver.length} domiciliarios activos {isToday ? "hoy" : "ese día"}
            </p>
          </div>
          {showTodayList ? <ChevronUp className="h-5 w-5" /> : <ChevronDown className="h-5 w-5" />}
        </button>

        {showTodayList && (
          <div className="border-t border-border">
            {todayByDriver.length === 0 ? (
              <p className="text-center py-10 text-sm text-muted-foreground">
                {isToday ? "Aún no hay pedidos entregados hoy." : "No hubo pedidos entregados ese día."}
              </p>
            ) : (
              <div className="divide-y divide-border">
                {todayByDriver.map(grp => (
                  <DriverDayGroup key={grp.driverId} group={grp} />
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Lista de domiciliarios */}
      <div className="glass-strong rounded-3xl overflow-hidden">
        <div className="px-5 py-4 border-b border-border flex items-center justify-between gap-3 flex-wrap">
          <div>
            <h2 className="font-black">Domiciliarios</h2>
            <p className="text-xs text-muted-foreground">Click en un domiciliario para ver estado de cuenta y registrar pago</p>
          </div>
          <div className="relative">
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="🔍 Buscar domiciliario…"
              className="px-4 py-2 rounded-xl border border-border bg-background text-sm w-56 outline-none focus:ring-2 focus:ring-primary/30"
            />
          </div>
        </div>
        {loading && drivers.length === 0 ? (
          <p className="text-center py-12 text-muted-foreground">Cargando...</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-muted-foreground text-xs uppercase border-b border-border">
                  <th className="text-left px-5 py-3">Domiciliario</th>
                  <th className="text-left px-5 py-3 hidden md:table-cell">Sucursal</th>
                  <th className="text-right px-5 py-3">Pedidos {isToday ? "hoy" : "ese día"}</th>
                  <th className="text-right px-5 py-3 hidden sm:table-cell">$ entregado {isToday ? "hoy" : "ese día"}</th>
                  <th className="text-right px-5 py-3">Comisiones</th>
                  <th className="text-right px-5 py-3">Base</th>
                  <th className="px-5 py-3" />
                </tr>
              </thead>
              <tbody>
                {drivers.filter(d => !search.trim() || d.name.toLowerCase().includes(search.toLowerCase())).map(d => {
                  const stat = todayByDriver.find(g => g.driverId === d.id);
                  return (
                    <tr key={d.id} className="border-b border-border/50 hover:bg-secondary/30 transition cursor-pointer" onClick={() => setSelected(d)}>
                      <td className="px-5 py-3">
                        <div className="flex items-center gap-3">
                          <div className="h-9 w-9 rounded-full bg-primary/15 text-primary flex items-center justify-center font-black text-sm">
                            {d.name.charAt(0).toUpperCase()}
                          </div>
                          <div>
                            <p className="font-bold">{d.name}</p>
                            <p className="text-xs text-muted-foreground">{d.phone ?? "Sin teléfono"} · {d.active ? "Activo" : "Inactivo"}</p>
                          </div>
                        </div>
                      </td>
                      <td className="px-5 py-3 text-muted-foreground hidden md:table-cell">{d.branch.name}</td>
                      <td className="px-5 py-3 text-right font-bold tnum">{stat?.count ?? 0}</td>
                      <td className="px-5 py-3 text-right tnum hidden sm:table-cell">{formatCOP(stat?.total ?? 0)}</td>
                      <td className={`px-5 py-3 text-right font-black tnum ${d.pendingDebt > 0 ? "text-red-500" : "text-muted-foreground"}`}>
                        {d.pendingDebt > 0 ? formatCOP(d.pendingDebt) : "—"}
                      </td>
                      <td className={`px-5 py-3 text-right font-bold tnum ${(d.basePending ?? 0) > 0 ? "text-amber-600" : "text-muted-foreground"}`}>
                        {(d.basePending ?? 0) > 0 ? formatCOP(d.basePending ?? 0) : "—"}
                      </td>
                      <td className="px-5 py-3 text-right">
                        <span className="text-xs text-primary font-bold">Ver / Pagar →</span>
                      </td>
                    </tr>
                  );
                })}
                {drivers.length === 0 && (
                  <tr>
                    <td colSpan={7} className="text-center py-12 text-muted-foreground">
                      No hay domiciliarios. Sincroniza una sucursal primero.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {selected && (
        <DriverStatementModal driver={selected} onClose={() => setSelected(null)} onRefresh={load} />
      )}
    </div>
  );
}

function KPI({ label, value, icon, highlight }: { label: string; value: string; icon: React.ReactNode; highlight?: boolean }) {
  return (
    <div className={`glass-strong rounded-2xl p-4 ${highlight ? "ring-2 ring-red-500/30" : ""}`}>
      <div className="flex items-center gap-2 text-xs text-muted-foreground">{icon}<span>{label}</span></div>
      <p className={`mt-1 font-black text-xl tnum ${highlight ? "text-red-600" : ""}`}>{value}</p>
    </div>
  );
}

function DriverDayGroup({ group }: { group: { driverId: string; name: string; count: number; total: number; company: number; orders: Order[] } }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button onClick={() => setOpen(v => !v)} className="w-full flex items-center justify-between px-5 py-3 hover:bg-secondary/30 transition">
        <div className="flex items-center gap-3">
          <div className="h-8 w-8 rounded-full bg-primary/15 text-primary flex items-center justify-center font-black text-sm">
            {group.name.charAt(0).toUpperCase()}
          </div>
          <div className="text-left">
            <p className="font-bold">{group.name}</p>
            <p className="text-xs text-muted-foreground">{group.count} pedidos · {formatCOP(group.total)} · empresa {formatCOP(group.company)}</p>
          </div>
        </div>
        {open ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
      </button>
      {open && (
        <div className="bg-secondary/20 px-5 py-2 space-y-1">
          {[...group.orders].sort((a, b) => {
            const ai = parseInt(a.orderNumber ?? "", 10);
            const bi = parseInt(b.orderNumber ?? "", 10);
            if (!Number.isNaN(ai) && !Number.isNaN(bi)) return ai - bi;
            return (a.orderNumber ?? "").localeCompare(b.orderNumber ?? "");
          }).map(o => (
            <div key={o.id} className="flex items-center justify-between text-xs py-1.5">
              <div className="flex gap-3 items-center">
                <span className="text-muted-foreground tnum">
                  {o.deliveredAt ? new Date(o.deliveredAt).toLocaleTimeString("es-CO", { hour: "2-digit", minute: "2-digit" }) : "—"}
                </span>
                <span>#{o.orderNumber ?? "—"}</span>
                <span className="text-muted-foreground truncate max-w-[200px]">{o.customerName ?? ""}</span>
              </div>
              <div className="flex gap-4 tnum font-bold">
                <span>{formatCOP(o.deliveryValue)}</span>
                <span className="text-primary">+{formatCOP(o.companyAmount)}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

