"use client";

import { useEffect, useState, Fragment } from "react";
import { RefreshCw, Plus, Copy, Webhook, Info, Pencil, Trash2 } from "lucide-react";
import { ManualOrderWizard } from "@/components/wizards/ManualOrderWizard";
import { EditRequestWizard, type EditableField } from "@/components/wizards/EditRequestWizard";
import { DeleteRequestWizard } from "@/components/wizards/DeleteRequestWizard";
import { toast } from "sonner";
import * as api from "@/lib/sd-api";
import type { Order, Branch, Driver } from "@/lib/sd-api";
import { formatCOP, prettyDate } from "@/lib/format";
import { LiveBadge } from "@/components/LiveBadge";
import { useAuth } from "@/lib/auth";
import { useDay } from "@/lib/day-context";

export default function PedidosPage() {
  const [orders, setOrders] = useState<Order[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [drivers, setDrivers] = useState<Driver[]>([]);
  const [branchId, setBranchId] = useState("");
  const [loading, setLoading] = useState(true);
  const [showManual, setShowManual] = useState(false);
  const [editOrder, setEditOrder] = useState<Order | null>(null);
  const [deleteOrder, setDeleteOrder] = useState<Order | null>(null);
  const { user } = useAuth();
  const [showWebhook, setShowWebhook] = useState(false);
  // Día seleccionado en el sistema (flechas de fecha de la cabecera).
  const { date, operatingDay } = useDay();
  const isToday = date === operatingDay;

  // Trae SOLO los pedidos del día seleccionado (no se sobrecarga).
  const fetchOrders = (silent = false) => {
    if (!branchId) return;
    if (!silent) setLoading(true);
    api.getOrdersByBranch(branchId, date, date)
      .then(data => setOrders(prev => JSON.stringify(prev) === JSON.stringify(data) ? prev : data))
      .catch(() => { if (!silent) toast.error("Error al cargar pedidos"); })
      .finally(() => { if (!silent) setLoading(false); });
  };

  const load = async () => {
    const [b, d] = await Promise.all([api.getBranches(), api.getDrivers()]);
    setBranches(b);
    setDrivers(d);
    if (!branchId && b.length > 0) { setBranchId(b[0].id); return; }
    if (!branchId) { setLoading(false); return; }
    // Retroalimentar desde Shipday y luego mostrar el día seleccionado.
    try { await api.syncAll(); } catch { /* el scheduler ya sincroniza */ }
    fetchOrders();
  };

  useEffect(() => { load(); }, []);
  // Al cambiar de día o de sucursal, recargar SOLO ese día.
  useEffect(() => { fetchOrders(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [branchId, date]);
  useEffect(() => { if (branchId) { api.getDrivers(branchId).then(setDrivers); } }, [branchId]);

  // Refresco en vivo cada 10s del día seleccionado (silencioso).
  useEffect(() => {
    if (!branchId) return;
    const t = setInterval(() => fetchOrders(true), 10_000);
    return () => clearInterval(t);
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [branchId, date]);

  const totalValue = orders.reduce((s, o) => s + o.deliveryValue, 0);
  const totalCompany = orders.reduce((s, o) => s + o.companyAmount, 0);
  const currentBranch = branches.find(b => b.id === branchId);

  // Fecha (día de Bogotá) a la que pertenece el pedido — Shipday reinicia el número
  // de pedido cada día, así que hay que agrupar por fecha y ordenar por número dentro.
  const bogotaDay = (iso?: string | null) =>
    iso ? new Date(iso).toLocaleDateString("en-CA", { timeZone: "America/Bogota" }) : "0000-00-00";
  const orderNum = (n?: string | null) => { const i = parseInt(n ?? "", 10); return Number.isNaN(i) ? -1 : i; };

  // Día más reciente primero (hoy arriba); dentro de cada día, por número de pedido ascendente.
  const sortedOrders = [...orders].sort((a, b) => {
    const da = bogotaDay(a.deliveredAt), db = bogotaDay(b.deliveredAt);
    if (da !== db) return db.localeCompare(da); // fecha descendente
    return orderNum(a.orderNumber) - orderNum(b.orderNumber); // número ascendente
  });

  const webhookUrl = typeof window !== "undefined"
    ? `${window.location.protocol}//${window.location.hostname}:4000/api/webhooks/shipday/${branchId}`
    : "";

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-black">Pedidos entregados</h1>
            <LiveBadge />
          </div>
          <p className="text-sm text-muted-foreground capitalize">
            {isToday ? "Hoy" : prettyDate(date)} · {orders.length} pedidos · {formatCOP(totalValue)} total · {formatCOP(totalCompany)} empresa
          </p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => setShowWebhook(true)} className="flex items-center gap-2 px-3 py-2 border border-border rounded-xl text-sm hover:bg-secondary transition">
            <Webhook className="h-4 w-4" /> Webhook
          </button>
          <button onClick={() => setShowManual(true)} className="flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-xl font-bold hover:opacity-90 transition">
            <Plus className="h-4 w-4" /> Registrar pedido
          </button>
          <button onClick={load} className="p-2 rounded-xl border border-border hover:bg-secondary transition">
            <RefreshCw className="h-4 w-4" />
          </button>
        </div>
      </div>

      <div className="flex gap-3 flex-wrap items-center">
        <select value={branchId} onChange={e => setBranchId(e.target.value)} className="px-3 py-2 rounded-xl border border-border bg-background text-sm">
          {branches.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
        </select>
        <span className="text-xs text-muted-foreground flex items-center gap-1.5 px-3 py-2 rounded-xl bg-secondary/40">
          📅 Mostrando el día <strong className="capitalize text-foreground">{isToday ? "de hoy" : prettyDate(date)}</strong> — usa las flechas de fecha (arriba) para cambiar de día.
        </span>
      </div>

      {/* Banner informativo sobre webhooks si no hay pedidos */}
      {!loading && orders.length === 0 && (
        <div className="bg-blue-50 border border-blue-200 rounded-2xl p-4 flex gap-3">
          <Info className="h-5 w-5 text-blue-500 shrink-0 mt-0.5" />
          <div className="text-sm text-blue-800">
            <p className="font-bold">¿No ves tus pedidos de Shipday?</p>
            <p className="mt-1">La API de Shipday solo devuelve pedidos creados por API. Para recibir <strong>todos los pedidos</strong> del dashboard de Shipday en tiempo real, configura el <strong>Webhook</strong> (botón arriba). También puedes registrarlos manualmente con <strong>"Registrar pedido"</strong>.</p>
          </div>
        </div>
      )}

      {/* Desplazamiento horizontal: en ventana estrecha las acciones (Editar/Eliminar) quedaban
          recortadas y sin forma de alcanzarlas (AIF17). */}
      <div className="glass-strong rounded-3xl overflow-x-auto">
        <table className="w-full min-w-[820px] text-sm">
          <thead>
            <tr className="border-b border-border text-muted-foreground text-xs uppercase">
              <th className="text-left px-4 py-3"># Pedido</th>
              <th className="text-left px-4 py-3">Fecha</th>
              <th className="text-left px-4 py-3">Domiciliario</th>
              <th className="text-left px-4 py-3">Cliente</th>
              <th className="text-right px-4 py-3">Valor</th>
              <th className="text-right px-4 py-3">% empresa</th>
              <th className="text-center px-4 py-3">Tipo</th>
              <th className="text-center px-4 py-3">Editar</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={8} className="text-center py-12 text-muted-foreground">Cargando...</td></tr>
            ) : sortedOrders.length === 0 ? (
              <tr><td colSpan={8} className="text-center py-12 text-muted-foreground">Sin pedidos — registra uno manualmente o configura el webhook</td></tr>
            ) : sortedOrders.map((o, idx) => {
              const day = bogotaDay(o.deliveredAt);
              const prevDay = idx > 0 ? bogotaDay(sortedOrders[idx - 1].deliveredAt) : null;
              const showHeader = day !== prevDay;
              const dayLabel = o.deliveredAt
                ? new Date(o.deliveredAt).toLocaleDateString("es-CO", { timeZone: "America/Bogota", weekday: "long", day: "2-digit", month: "long" })
                : "Sin fecha";
              const dayCount = sortedOrders.filter(x => bogotaDay(x.deliveredAt) === day).length;
              return (
              <Fragment key={o.id}>
              {showHeader && (
                <tr className="bg-secondary/50">
                  <td colSpan={8} className="px-4 py-2 text-xs font-bold uppercase tracking-wider text-primary capitalize">
                    {dayLabel} · {dayCount} pedido{dayCount !== 1 ? "s" : ""}
                  </td>
                </tr>
              )}
              <tr className="border-b border-border/50 hover:bg-secondary/30 transition">
                <td className="px-4 py-2.5 font-bold tnum">#{o.orderNumber ?? "—"}</td>
                <td className="px-4 py-2.5 text-muted-foreground">
                  {o.deliveredAt ? new Date(o.deliveredAt).toLocaleString("es-CO", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—"}
                </td>
                <td className="px-4 py-2.5 font-medium">{o.driver?.name ?? <span className="text-muted-foreground italic">Sin asignar</span>}</td>
                <td className="px-4 py-2.5 text-muted-foreground">{o.customerName ?? "—"}</td>
                <td className="px-4 py-2.5 text-right font-bold tnum">{formatCOP(o.deliveryValue)}</td>
                <td className="px-4 py-2.5 text-right font-bold tnum text-primary">{formatCOP(o.companyAmount)}</td>
                <td className="px-4 py-2.5 text-center">
                  <span className={`text-xs px-2 py-0.5 rounded-full font-bold ${o.shipdayOrderId?.startsWith("manual-") ? "bg-orange-100 text-orange-700" : "bg-green-100 text-green-700"}`}>
                    {o.shipdayOrderId?.startsWith("manual-") ? "Manual" : "Shipday"}
                  </span>
                </td>
                <td className="px-4 py-2.5">
                  <div className="flex items-center justify-center gap-0.5">
                    <button
                      onClick={() => setEditOrder(o)}
                      title="Solicitar corrección de este pedido"
                      className="p-1.5 rounded-lg hover:bg-secondary transition text-muted-foreground hover:text-primary"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                    <button
                      onClick={() => setDeleteOrder(o)}
                      title="Solicitar eliminación de este pedido"
                      className="p-1.5 rounded-lg hover:bg-secondary transition text-muted-foreground hover:text-red-500"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </td>
              </tr>
              </Fragment>
            );})}
          </tbody>
        </table>
      </div>

      {/* Wizard interactivo para registro manual */}
      <ManualOrderWizard
        open={showManual}
        onOpenChange={setShowManual}
        onDone={load}
      />

      {/* Modal webhook */}
      {showWebhook && currentBranch && (
        <WebhookModal branch={currentBranch} webhookUrl={webhookUrl} onClose={() => setShowWebhook(false)} />
      )}

      {/* Wizard de solicitud de edición de pedido */}
      {editOrder && (
        <EditRequestWizard
          open={true}
          onOpenChange={(v) => { if (!v) setEditOrder(null); }}
          entityType="ShipdayOrder"
          entityId={editOrder.id}
          entityLabel={`Pedido #${editOrder.orderNumber ?? "—"} · ${formatCOP(editOrder.deliveryValue)}`}
          fields={[
            { field: "deliveryValue", label: "Valor del domicilio", currentValue: String(editOrder.deliveryValue), type: "money" },
            { field: "customerName", label: "Cliente", currentValue: editOrder.customerName ?? "", type: "text" },
            { field: "orderNumber", label: "N° de pedido", currentValue: editOrder.orderNumber ?? "", type: "text" },
          ] as EditableField[]}
          onDone={load}
        />
      )}

      {/* Wizard de solicitud de eliminación de pedido */}
      {deleteOrder && (
        <DeleteRequestWizard
          open={true}
          onOpenChange={(v) => { if (!v) setDeleteOrder(null); }}
          entityType="ShipdayOrder"
          entityId={deleteOrder.id}
          entityLabel={`Pedido #${deleteOrder.orderNumber ?? "—"} · ${formatCOP(deleteOrder.deliveryValue)}${deleteOrder.driver ? ` · ${deleteOrder.driver.name}` : ""}`}
          onDone={load}
        />
      )}
    </div>
  );
}

function ManualOrderModal({ branches, drivers, defaultBranchId, onClose, onSaved }: {
  branches: Branch[]; drivers: Driver[]; defaultBranchId: string;
  onClose: () => void; onSaved: () => void;
}) {
  const [form, setForm] = useState({ branchId: defaultBranchId, driverId: "", deliveryValue: "", orderNumber: "", customerName: "" });
  const [saving, setSaving] = useState(false);
  const commission = form.deliveryValue ? Math.round(parseInt(form.deliveryValue.replace(/\D/g, "") || "0") * 0.3) : 0;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const deliveryValue = parseInt(form.deliveryValue.replace(/\D/g, ""));
    if (!form.branchId || !deliveryValue) { toast.error("Sucursal y valor son requeridos"); return; }
    setSaving(true);
    try {
      await api.createManualOrder({
        branchId: form.branchId,
        driverId: form.driverId || undefined,
        deliveryValue,
        orderNumber: form.orderNumber || undefined,
        customerName: form.customerName || undefined,
      });
      toast.success("Pedido registrado correctamente");
      onSaved();
    } catch (err) { toast.error(String(err)); }
    setSaving(false);
  };

  return (
    <div className="fixed inset-0 bg-background/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="glass-strong rounded-3xl max-h-[92vh] overflow-y-auto p-6 w-full max-w-md space-y-4">
        <h2 className="font-black text-lg">Registrar pedido manualmente</h2>
        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
            <label className="text-xs text-muted-foreground font-medium">Sucursal *</label>
            <select value={form.branchId} onChange={e => setForm(f => ({ ...f, branchId: e.target.value }))} required
              className="w-full mt-1 px-3 py-2.5 rounded-xl border border-border bg-background text-sm">
              {branches.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </div>
          <div>
            <label className="text-xs text-muted-foreground font-medium">Domiciliario</label>
            <select value={form.driverId} onChange={e => setForm(f => ({ ...f, driverId: e.target.value }))}
              className="w-full mt-1 px-3 py-2.5 rounded-xl border border-border bg-background text-sm">
              <option value="">Sin asignar</option>
              {drivers.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </div>
          <div>
            <label className="text-xs text-muted-foreground font-medium">Valor del domicilio *</label>
            <input type="text" value={form.deliveryValue} onChange={e => setForm(f => ({ ...f, deliveryValue: e.target.value }))} required
              placeholder="Ej: 15000" className="w-full mt-1 px-3 py-2.5 rounded-xl border border-border bg-background text-sm" />
            {commission > 0 && (
              <p className="text-xs text-primary mt-1 font-bold">→ 30% empresa: {formatCOP(commission)}</p>
            )}
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-xs text-muted-foreground font-medium"># Pedido</label>
              <input type="text" value={form.orderNumber} onChange={e => setForm(f => ({ ...f, orderNumber: e.target.value }))}
                placeholder="Opcional" className="w-full mt-1 px-3 py-2.5 rounded-xl border border-border bg-background text-sm" />
            </div>
            <div>
              <label className="text-xs text-muted-foreground font-medium">Cliente</label>
              <input type="text" value={form.customerName} onChange={e => setForm(f => ({ ...f, customerName: e.target.value }))}
                placeholder="Opcional" className="w-full mt-1 px-3 py-2.5 rounded-xl border border-border bg-background text-sm" />
            </div>
          </div>
          <div className="flex gap-3 pt-2">
            <button type="button" onClick={onClose} className="flex-1 py-2.5 rounded-xl border border-border hover:bg-secondary transition">Cancelar</button>
            <button type="submit" disabled={saving} className="flex-1 py-2.5 rounded-xl bg-primary text-primary-foreground font-bold hover:opacity-90 disabled:opacity-50 transition">
              {saving ? "Guardando..." : "Registrar"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function WebhookModal({ branch, webhookUrl, onClose }: { branch: Branch; webhookUrl: string; onClose: () => void }) {
  const copy = () => { navigator.clipboard.writeText(webhookUrl); toast.success("URL copiada"); };
  return (
    <div className="fixed inset-0 bg-background/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="glass-strong rounded-3xl max-h-[92vh] overflow-y-auto p-6 w-full max-w-lg space-y-4">
        <h2 className="font-black text-lg">Configurar Webhook — {branch.name}</h2>
        <p className="text-sm text-muted-foreground">
          Configura esta URL en Shipday para recibir pedidos en tiempo real cuando cambien a estado <strong>DELIVERED</strong>.
        </p>

        <div className="space-y-2">
          <label className="text-xs font-bold text-muted-foreground uppercase tracking-wide">URL del webhook</label>
          <div className="flex gap-2">
            <code className="flex-1 px-3 py-2.5 rounded-xl bg-secondary text-xs font-mono break-all">{webhookUrl}</code>
            <button onClick={copy} className="p-2.5 rounded-xl border border-border hover:bg-secondary transition shrink-0">
              <Copy className="h-4 w-4" />
            </button>
          </div>
        </div>

        <div className="bg-blue-50 rounded-2xl p-4 space-y-2 text-sm text-blue-900">
          <p className="font-bold">Cómo configurarlo en Shipday:</p>
          <ol className="list-decimal list-inside space-y-1 text-blue-800">
            <li>Entra a <strong>app.shipday.com</strong></li>
            <li>Ve a <strong>Settings → Integrations → Webhooks</strong></li>
            <li>Agrega la URL del webhook de arriba</li>
            <li>Selecciona el evento <strong>"Order Delivered"</strong></li>
            <li>Guarda los cambios</li>
          </ol>
        </div>

        <div className="bg-orange-50 rounded-2xl p-4 text-sm text-orange-900">
          <p className="font-bold">⚠ El servidor debe ser accesible desde internet</p>
          <p className="mt-1">Si usas Tailscale, reemplaza <code className="bg-orange-100 px-1 rounded">192.168.x.x</code> por tu IP de Tailscale (<code className="bg-orange-100 px-1 rounded">100.x.x.x</code>). El puerto debe ser <strong>4000</strong> o el que configures.</p>
        </div>

        <button onClick={onClose} className="w-full py-2.5 rounded-xl border border-border hover:bg-secondary transition">Cerrar</button>
      </div>
    </div>
  );
}

