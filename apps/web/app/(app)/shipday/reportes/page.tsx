"use client";

import { useEffect, useState } from "react";
import { Download, FileSpreadsheet, Lock } from "lucide-react";
import Link from "next/link";
import { toast } from "sonner";
import * as api from "@/lib/sd-api";
import type { Branch, MonthlyClose, MonthlyReport } from "@/lib/sd-api";
import { formatCOP, todayBogota } from "@/lib/format";
import { MonthlyCloseWizard } from "@/components/wizards/MonthlyCloseWizard";
import { useLive } from "@/lib/use-live";
import { useAuth } from "@/lib/auth";

export default function ReportesPage() {
  const [closes, setCloses] = useState<MonthlyClose[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [branchId, setBranchId] = useState("");
  const [loading, setLoading] = useState(true);
  const [showClose, setShowClose] = useState(false);
  // Cerrar el mes fija el capital de arranque: solo administradores (el servidor también lo exige).
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const [downloading, setDownloading] = useState<string | null>(null);
  // Mes por defecto en zona Bogotá (NO UTC): en la noche del último día del mes, el UTC ya
  // marca el mes siguiente (vacío) y el Excel salía en ceros aunque el mes en curso tuviera datos.
  const [reportMonth, setReportMonth] = useState(() => todayBogota().slice(0, 7));
  const [report, setReport] = useState<MonthlyReport | null>(null);

  const load = async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const [c, b] = await Promise.all([api.getCloses(branchId || undefined), api.getBranches()]);
      setCloses(prev => JSON.stringify(prev) === JSON.stringify(c) ? prev : c);
      setBranches(prev => JSON.stringify(prev) === JSON.stringify(b) ? prev : b);
    } catch { if (!silent) toast.error("Error al cargar cierres"); }
    if (!silent) setLoading(false);
  };

  const loadReport = async () => {
    try {
      const r = await api.getMonthlyReport(reportMonth, branchId || undefined);
      setReport(prev => JSON.stringify(prev) === JSON.stringify(r) ? prev : r);
    } catch { setReport(null); }
  };

  useEffect(() => { load(); }, [branchId]);
  useEffect(() => { loadReport(); }, [reportMonth, branchId]);
  useLive(() => { load(true); loadReport(); }, 6000);

  const handleExport = async (month: string, bid?: string) => {
    const key = month + (bid ?? "global");
    setDownloading(key);
    try {
      await api.exportExcel(month, bid || undefined);
      toast.success("Excel descargado");
    } catch (err) { toast.error(String(err)); }
    setDownloading(null);
  };

  return (
    <div className="space-y-6 max-w-3xl mx-auto w-full">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-black">Reportes y Cierres Mensuales</h1>
          <p className="text-sm text-muted-foreground">Genera cierres y exporta reportes en Excel</p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => handleExport(reportMonth, branchId || undefined)}
            disabled={downloading === reportMonth + (branchId || "global")}
            className="flex items-center gap-2 px-3 py-2 border border-border rounded-xl text-sm font-bold hover:bg-secondary transition disabled:opacity-50"
          >
            {/* Exporta el MES SELECCIONADO abajo (no un "mes actual" recalculado): así el Excel
                coincide siempre con el reporte que se ve en pantalla. */}
            <Download className="h-4 w-4" /> {downloading === reportMonth + (branchId || "global") ? "Generando..." : `Excel de ${reportMonth}`}
          </button>
          {isAdmin && (
          <button
            onClick={() => setShowClose(true)}
            className="flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-xl font-bold hover:opacity-90 transition"
          >
            <Lock className="h-4 w-4" /> Cerrar mes
          </button>
          )}
        </div>
      </div>

      <div className="flex gap-3 flex-wrap items-center">
        <select value={branchId} onChange={e => setBranchId(e.target.value)} className="px-3 py-2 rounded-xl border border-border bg-background text-sm">
          <option value="">Todas las sucursales</option>
          {branches.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
        </select>
        <input type="month" value={reportMonth} onChange={e => setReportMonth(e.target.value)}
          className="px-3 py-2 rounded-xl border border-border bg-background text-sm" />
      </div>
      {/* Auditoría 3 (22-oct-2026): sumar las utilidades por sucursal no da la global, porque estos
          conceptos no tienen sucursal y se repiten completos en cada vista. */}
      {branchId && (
        <p className="text-xs text-amber-600 dark:text-amber-400">
          Vista por sucursal: solo los domicilios y las bases son de esta sucursal. Gastos, nómina, clientes por hora y
          deudas de clientes son de toda la empresa y aparecen completos en cada sucursal; no sumes las utilidades de
          las sucursales, usa la vista &quot;Todas las sucursales&quot;.
        </p>
      )}

      {/* Reporte mensual estilo Excel */}
      {report && <MonthlyReportPanel report={report} monthClosed={closes.some(c => c.month === reportMonth)} />}

      {loading ? (
        <div className="text-center py-20 text-muted-foreground">Cargando...</div>
      ) : closes.length === 0 ? (
        <div className="glass-strong rounded-3xl p-12 text-center">
          <FileSpreadsheet className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
          <p className="font-bold text-lg">Sin cierres aún</p>
          <p className="text-sm text-muted-foreground mt-1">Genera el primer cierre mensual para ver reportes</p>
        </div>
      ) : (
        <div className="space-y-3">
          {closes.map(c => (
            <div key={c.id} className="glass-strong rounded-3xl p-5 flex items-center justify-between flex-wrap gap-4">
              <div>
                <div className="flex items-center gap-3">
                  <h3 className="font-black text-lg">{c.month}</h3>
                  {c.branch ? (
                    <span className="text-xs px-2 py-0.5 rounded-full bg-secondary font-medium">{c.branch.name}</span>
                  ) : (
                    <span className="text-xs px-2 py-0.5 rounded-full bg-primary/10 text-primary font-bold">Global</span>
                  )}
                </div>
                <p className="text-xs text-muted-foreground mt-1">
                  Cerrado el {new Date(c.closedAt).toLocaleDateString("es-CO", { day: "2-digit", month: "long", year: "numeric" })}
                </p>
                {(c.initialCash != null || c.initialBank != null) && (
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Inicio: efectivo {formatCOP(c.initialCash ?? 0)} · banco {formatCOP(c.initialBank ?? 0)}
                  </p>
                )}
              </div>

              <div className="grid grid-cols-3 md:grid-cols-6 gap-3 text-center">
                <CloseMetric label="Pedidos" value={String(c.totalOrders)} />
                <CloseMetric label="Valor total" value={formatCOP(c.totalValue)} />
                <CloseMetric label="% empresa" value={formatCOP(c.companyTotal)} highlight />
                <CloseMetric label="Bases dadas" value={formatCOP(c.basesGiven)} />
                {/* Devueltas/saldadas = entregadas − sin devolver (incluye base saldada con crédito),
                    para que cuadre con "Base sin devolver" conciliada. Ver módulo de Bases. */}
                <CloseMetric label="Bases devueltas/saldadas" value={formatCOP(c.basesGiven - c.basesPending)} />
                <CloseMetric label="Base sin devolver" value={formatCOP(c.basesPending)} warn={c.basesPending > 0} />
              </div>

              <button
                onClick={() => handleExport(c.month, c.branchId ?? undefined)}
                disabled={downloading === c.month + (c.branchId ?? "global")}
                className="flex items-center gap-2 px-3 py-2 border border-border rounded-xl text-sm hover:bg-secondary transition disabled:opacity-50"
              >
                <Download className="h-4 w-4" />
                {downloading === c.month + (c.branchId ?? "global") ? "Generando..." : "Exportar Excel"}
              </button>
            </div>
          ))}
        </div>
      )}

      <MonthlyCloseWizard
        open={showClose}
        onOpenChange={setShowClose}
        branches={branches}
        onDone={load}
      />
    </div>
  );
}

function CloseMetric({ label, value, highlight, warn }: { label: string; value: string; highlight?: boolean; warn?: boolean }) {
  return (
    <div className="bg-secondary/30 rounded-xl p-2.5 min-w-[90px]">
      <p className="text-xs text-muted-foreground leading-tight">{label}</p>
      <p className={`font-black text-sm tnum mt-0.5 ${highlight ? "text-primary" : warn ? "text-red-500" : ""}`}>{value}</p>
    </div>
  );
}

function MonthlyReportPanel({ report, monthClosed }: { report: MonthlyReport; monthClosed?: boolean }) {
  const fmt = (n: number) => formatCOP(n);
  // Comisiones y deuda de clientes son saldos VIVOS (no tienen "mes"): la deuda de cada
  // domiciliario/cliente es una sola posición neta actual, y el sistema no reconstruye deuda
  // histórica por mes. En un mes ya CERRADO eso confunde (parece que el mes quedó "sucio"), así
  // que se etiqueta como saldo actual. "Diferencia Bases" sí es del mes (ver close.service), no se etiqueta.
  const liveNote = monthClosed ? "Saldo actual (no del mes ya cerrado)" : undefined;
  return (
    <div className="glass-strong rounded-3xl p-5 space-y-4">
      <h2 className="font-black text-lg">📊 Reporte del mes — {report.month}</h2>

      {/* Bloque de resultados */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <RepCard label="Total Ventas" value={fmt(report.totalSales)} sub={report.sales ? `🛵 Domicilios ${fmt(report.sales.orders)} · ⏱️ Por hora ${fmt(report.sales.hourly)}` : undefined} accent />
        <RepCard label="Total Gastos" value={fmt(report.expenses.total)} sub={`💵 ${fmt(report.expenses.cash)} · 🏦 ${fmt(report.expenses.bank)}`} />
        <RepCard label="Total Nómina" value={fmt(report.payroll.total)} sub={`💵 ${fmt(report.payroll.cash)} · 🏦 ${fmt(report.payroll.bank)}`} />
      </div>

      <div className="rounded-xl border bg-card p-4 space-y-2">
        {/* F14: base y comisiones son cuentas separadas; el total es solo informativo. */}
        <p className="font-bold">Domiciliarios hoy — comisiones: {fmt(report.debtReconciliation.commission)} · base sin devolver: {fmt(report.debtReconciliation.basesAllTime)}{(report.debtReconciliation.credit ?? 0) > 0 ? ` · crédito a su favor: ${fmt(report.debtReconciliation.credit ?? 0)}` : ""}</p>
        <p className="text-sm text-muted-foreground">Bases del mes: saldo anterior {fmt(report.bases.previous ?? report.debtReconciliation.basesPrevious)} + entregadas {fmt(report.bases.given)} − devueltas {fmt(report.bases.returned)} = pendiente al cierre del mes {fmt(report.bases.diff)}</p>
        <p className="text-xs text-muted-foreground">Total informativo (comisión + base − crédito): {fmt(report.debtReconciliation.total)}. No es otra deuda: la base y las comisiones se cobran por separado.</p>
      </div>
      {/* Indicadores que deben cuadrar — con enlaces directos al descuadre */}
      <div className="space-y-2">
        <BalanceRow
          label="Diferencia Bases"
          ok={report.bases.ok}
          value={report.bases.diff}
          detail={!report.bases.ok ? `Base aún en poder de domiciliarios al cierre del mes. Saldo anterior ${fmt(report.bases.previous ?? 0)} + entregadas ${fmt(report.bases.given)} − devueltas ${fmt(report.bases.returned)}` : undefined}
          items={report.bases.pendingDrivers.map(d => ({ id: d.id, label: d.name, amount: d.pendingDebt }))}
          linkHref="/shipday/bases"
          linkLabel="Ir a Bases →"
          itemHint="Domiciliarios que aún no devuelven la base:"
        />
        <BalanceRow
          label="Comisiones pendientes"
          ok={report.commission.ok}
          value={report.commission.pending}
          subnote={liveNote}
          detail={!report.commission.ok ? "Domiciliarios que aún deben comisión de sus domicilios" : undefined}
          items={report.commission.pendingDrivers.map(d => ({ id: d.id, label: d.name, amount: d.pendingDebt }))}
          linkHref="/shipday/deudas"
          linkLabel="Ir a Deudas →"
          itemHint="Domiciliarios que deben comisión:"
        />
        <BalanceRow
          label="Movimientos sin cuadrar (contraparte)"
          ok={report.transfers.ok}
          value={report.transfers.diff}
          detail={!report.transfers.ok ? "Estos movimientos se marcaron 'con contraparte' pero aún les falta su movimiento espejo para cuadrar." : undefined}
          items={report.transfers.pendingItems?.map(m => ({ id: m.id, label: m.name, amount: m.pendingDebt }))}
          linkHref="/banco"
          linkLabel="Ir a Banco a cuadrar →"
          itemHint="Movimientos que necesitan contraparte:"
        />
        <BalanceRow
          label="Saldo Deudas Clientes"
          ok={report.clientDebt.ok}
          value={report.clientDebt.balance}
          subnote={liveNote}
          detail={!report.clientDebt.ok ? `Saldo vivo que aún deben — normal ${fmt(report.clientDebt.normal)} + por hora ${fmt(report.clientDebt.hourly)}` : undefined}
          items={report.clientDebt.pendingClients.map(c => ({ id: c.id, label: c.name, amount: c.pendingDebt }))}
          linkHref="/clientes"
          linkLabel="Ir a Clientes →"
          itemHint="Clientes con saldo pendiente:"
        />
      </div>

      {/* Utilidad y rentabilidad */}
      <div className="grid grid-cols-2 gap-3 pt-2 border-t border-border">
        <div className="rounded-2xl p-4 bg-primary/10">
          <p className="text-xs text-muted-foreground">Utilidad Neta</p>
          <p className={`font-black text-2xl tnum mt-1 ${report.netProfit >= 0 ? "text-green-600" : "text-red-500"}`}>{fmt(report.netProfit)}</p>
          <p className="text-[11px] text-muted-foreground mt-1">Ventas − Gastos − Nómina</p>
        </div>
        <div className="rounded-2xl p-4 bg-secondary/40">
          <p className="text-xs text-muted-foreground">Rentabilidad</p>
          <p className={`font-black text-2xl tnum mt-1 ${report.profitability >= 0 ? "text-primary" : "text-red-500"}`}>{report.profitability.toFixed(1)}%</p>
          <p className="text-[11px] text-muted-foreground mt-1">(Utilidad / Ventas) × 100</p>
        </div>
      </div>
    </div>
  );
}

function RepCard({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent?: boolean }) {
  return (
    <div className="rounded-2xl p-4 bg-secondary/40">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={`font-black text-xl tnum mt-1 ${accent ? "text-primary" : ""}`}>{value}</p>
      {sub && <p className="text-[11px] text-muted-foreground mt-1">{sub}</p>}
    </div>
  );
}

function BalanceRow({ label, ok, value, detail, items, linkHref, linkLabel, itemHint, subnote }: {
  label: string; ok: boolean; value: number; detail?: string;
  items?: { id: string; label: string; amount: number }[];
  linkHref?: string; linkLabel?: string; itemHint?: string; subnote?: string;
}) {
  return (
    <div className={`rounded-2xl p-3 ${ok ? "bg-green-500/10 border border-green-500/20" : "bg-red-500/10 border border-red-500/20"}`}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium">{label}</span>
        <div className="flex items-center gap-2">
          {!ok && linkHref && (
            <Link href={linkHref} className="text-xs font-bold text-primary hover:underline whitespace-nowrap">
              {linkLabel}
            </Link>
          )}
          <span className={`font-black tnum ${ok ? "text-green-600" : "text-red-500"}`}>
            {ok ? "✅ $0" : `❌ ${formatCOP(value)}`}
          </span>
        </div>
      </div>
      {/* Aclaración para meses cerrados: este saldo es el ACTUAL (vivo), no el del mes cerrado. */}
      {subnote && <p className="text-[11px] text-muted-foreground italic mt-1">ⓘ {subnote}</p>}
      {!ok && detail && <p className="text-xs text-red-600/80 dark:text-red-400/80 mt-1.5">{detail}</p>}
      {/* Lista de dónde está el dinero faltante — cada item enlaza a su origen */}
      {!ok && items && items.length > 0 && (
        <div className="mt-2 space-y-1">
          {itemHint && <p className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">{itemHint}</p>}
          {items.slice(0, 8).map(it => (
            <Link key={it.id} href={linkHref ?? "#"}
              className="flex items-center justify-between text-xs px-3 py-1.5 rounded-lg bg-background/60 hover:bg-background transition">
              <span className="font-medium">{it.label}</span>
              <span className="font-black text-red-500 tnum">{formatCOP(it.amount)}</span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
