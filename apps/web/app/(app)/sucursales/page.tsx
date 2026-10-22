"use client";

import { useEffect, useState } from "react";
import { Plus, Pencil, Trash2, Wifi, WifiOff, RefreshCw, CheckCircle, XCircle, Clock, PackageCheck } from "lucide-react";
import { toast } from "sonner";
import * as api from "@/lib/sd-api";
import type { Branch } from "@/lib/sd-api";
import { useAuth } from "@/lib/auth";

export default function SucursalesPage() {
  const [branches, setBranches] = useState<Branch[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<Branch | null>(null);
  const [syncing, setSyncing] = useState<string | null>(null);
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";

  const load = async () => {
    setLoading(true);
    try { setBranches(await api.getBranches()); } catch { toast.error("Error al cargar sucursales"); }
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  const handleSync = async (id: string, name: string) => {
    setSyncing(id);
    try {
      const r = await api.syncBranch(id);
      toast.success(`${name}: ${r.drivers} domiciliarios, ${r.orders} pedidos sincronizados`);
      load();
    } catch (err) {
      toast.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    } finally { setSyncing(null); }
  };

  const handleStartOrders = async (id: string, name: string) => {
    if (!confirm(
      `¿Importar pedidos desde hoy conservando el historial y los saldos existentes?\n\n` +
      "• Cargará TODOS los pedidos de hoy (desde la primera hora del día).\n" +
      "• Conservará los pedidos anteriores, los pagos y las deudas existentes.\n" +
      "• Las futuras importaciones se limitarán a entregas desde hoy."
    )) return;
    setSyncing(id);
    try {
      const r = await api.startOrdersFromToday(id);
      toast.success(`${name}: contando desde hoy · ${r.orders} pedidos de hoy cargados`);
      load();
    } catch (err) {
      toast.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    } finally { setSyncing(null); }
  };

  const handleTest = async (id: string) => {
    setSyncing(id);
    try {
      const r = await api.testConnection(id);
      if (r.ok) toast.success(r.message);
      else toast.error(r.message);
      load();
    } catch (err) {
      toast.error(String(err));
    } finally { setSyncing(null); }
  };

  const handleDelete = async (id: string, name: string) => {
    if (!confirm(`¿Desactivar sucursal "${name}"? Se detendrá su sincronización y se conservará todo el historial.`)) return;
    try {
      await api.deleteBranch(id);
      toast.success("Sucursal desactivada");
      load();
    } catch (err) { toast.error(String(err)); }
  };

  const statusIcon = (s: Branch["syncStatus"]) => ({
    ok: <CheckCircle className="h-4 w-4 text-green-500" />,
    error: <XCircle className="h-4 w-4 text-red-500" />,
    never: <Clock className="h-4 w-4 text-muted-foreground" />,
  }[s]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-black">Sucursales</h1>
          <p className="text-sm text-muted-foreground">Gestiona tus cuentas de Shipday por sucursal</p>
        </div>
        {isAdmin && (
        <button
          onClick={() => { setEditing(null); setShowForm(true); }}
          className="flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-xl font-bold hover:opacity-90 transition"
        >
          <Plus className="h-4 w-4" /> Nueva sucursal
        </button>
        )}
      </div>

      {loading ? (
        <div className="text-center py-20 text-muted-foreground">Cargando...</div>
      ) : branches.length === 0 ? (
        <div className="glass-strong rounded-3xl p-12 text-center">
          <Wifi className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
          <p className="text-lg font-bold">Sin sucursales aún</p>
          <p className="text-muted-foreground text-sm mt-1">Crea tu primera sucursal y conecta tu cuenta de Shipday</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {branches.map(b => (
            <div key={b.id} className="glass-strong rounded-3xl p-5 space-y-3">
              <div className="flex items-start justify-between">
                <div>
                  <h3 className="font-bold text-lg">{b.name}</h3>
                  {b.address && <p className="text-xs text-muted-foreground">{b.address}</p>}
                  {b.phone && <p className="text-xs text-muted-foreground">{b.phone}</p>}
                </div>
                <span className={`text-xs px-2 py-1 rounded-full font-bold ${b.active ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700"}`}>
                  {b.active ? "Activa" : "Inactiva"}
                </span>
              </div>

              <div className="flex items-center gap-2 text-sm">
                {statusIcon(b.syncStatus)}
                <span className="text-muted-foreground">
                  {b.syncStatus === "ok" ? "Conectado" : b.syncStatus === "error" ? "Error de conexión" : "Sin sincronizar"}
                </span>
                {b.lastSyncAt && (
                  <span className="text-xs text-muted-foreground ml-auto">
                    {new Date(b.lastSyncAt).toLocaleString("es-CO", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}
                  </span>
                )}
              </div>

              {b.syncMessage && b.syncStatus === "error" && (
                <p className="text-xs text-red-600 bg-red-50 rounded-lg px-3 py-2">{b.syncMessage}</p>
              )}

              {/* Día de arranque de pedidos */}
              <p className="text-xs px-3 py-2 rounded-lg bg-secondary/40 text-muted-foreground">
                📦 {b.ordersSince
                  ? <>Cargando pedidos desde <strong className="text-foreground">{new Date(b.ordersSince).toLocaleDateString("es-CO", { day: "2-digit", month: "long", year: "numeric" })}</strong></>
                  : "Aún no se ha definido el día de arranque de pedidos"}
              </p>

              {/* Botón "Cargar pedidos desde hoy" — SOLO admin */}
              {isAdmin && (
                <button
                  onClick={() => handleStartOrders(b.id, b.name)}
                  disabled={syncing === b.id}
                  className="w-full flex items-center justify-center gap-2 text-sm py-2.5 rounded-xl bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 font-bold hover:bg-emerald-500/20 transition disabled:opacity-50 border border-emerald-500/30"
                >
                  <PackageCheck className="h-4 w-4" /> Cargar pedidos desde hoy
                </button>
              )}

              <div className="flex gap-2 pt-1">
                <button
                  onClick={() => handleTest(b.id)}
                  disabled={syncing === b.id}
                  className="flex-1 flex items-center justify-center gap-1 text-xs py-2 rounded-xl border border-border hover:bg-secondary transition disabled:opacity-50"
                >
                  <WifiOff className="h-3.5 w-3.5" /> Probar
                </button>
                <button
                  onClick={() => handleSync(b.id, b.name)}
                  disabled={syncing === b.id}
                  className="flex-1 flex items-center justify-center gap-1 text-xs py-2 rounded-xl bg-primary/10 text-primary font-bold hover:bg-primary/20 transition disabled:opacity-50"
                >
                  <RefreshCw className={`h-3.5 w-3.5 ${syncing === b.id ? "animate-spin" : ""}`} /> Sincronizar
                </button>
                {isAdmin && (<>
                <button onClick={() => { setEditing(b); setShowForm(true); }} aria-label={`Editar ${b.name}`} className="p-2 rounded-xl border border-border hover:bg-secondary transition">
                  <Pencil className="h-3.5 w-3.5" />
                </button>
                <button onClick={() => handleDelete(b.id, b.name)} disabled={!b.active} title="Desactivar conservando historial" aria-label={`Desactivar ${b.name}`} className="p-2 rounded-xl border border-red-200 text-red-500 hover:bg-red-50 transition disabled:opacity-40">
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
                </>)}
              </div>
            </div>
          ))}
        </div>
      )}

      {showForm && (
        <BranchForm
          initial={editing}
          onClose={() => setShowForm(false)}
          onSaved={() => { setShowForm(false); load(); }}
        />
      )}
    </div>
  );
}

function BranchForm({ initial, onClose, onSaved }: { initial: Branch | null; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState({
    name: initial?.name ?? "",
    address: initial?.address ?? "",
    phone: initial?.phone ?? "",
    apiKey: "",
    active: initial?.active ?? true,
  });
  const [saving, setSaving] = useState(false);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      if (initial) {
        const data: Record<string, unknown> = { name: form.name, address: form.address, phone: form.phone, active: form.active };
        if (form.apiKey) data.apiKey = form.apiKey;
        await api.updateBranch(initial.id, data as Parameters<typeof api.updateBranch>[1]);
      } else {
        if (!form.apiKey) { toast.error("La API Key es requerida"); setSaving(false); return; }
        await api.createBranch({ name: form.name, address: form.address, phone: form.phone, apiKey: form.apiKey });
      }
      toast.success(initial ? "Sucursal actualizada" : "Sucursal creada");
      onSaved();
    } catch (err) { toast.error(String(err)); }
    setSaving(false);
  };

  return (
    <div className="fixed inset-0 bg-background/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="glass-strong rounded-3xl max-h-[92vh] overflow-y-auto p-6 w-full max-w-md space-y-4">
        <h2 className="text-lg font-black">{initial ? "Editar sucursal" : "Nueva sucursal"}</h2>
        <form onSubmit={save} className="space-y-3">
          <Field label="Nombre *" value={form.name} onChange={v => setForm(f => ({ ...f, name: v }))} required />
          <Field label="Dirección" value={form.address} onChange={v => setForm(f => ({ ...f, address: v }))} />
          <Field label="Teléfono" value={form.phone} onChange={v => setForm(f => ({ ...f, phone: v }))} />
          <Field
            label={initial ? "API Key Shipday (dejar vacío para no cambiar)" : "API Key Shipday *"}
            value={form.apiKey}
            onChange={v => setForm(f => ({ ...f, apiKey: v }))}
            type="password"
            required={!initial}
          />
          {initial && (
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <input type="checkbox" checked={form.active} onChange={e => setForm(f => ({ ...f, active: e.target.checked }))} className="rounded" />
              Sucursal activa
            </label>
          )}
          <div className="flex gap-3 pt-2">
            <button type="button" onClick={onClose} className="flex-1 py-2.5 rounded-xl border border-border hover:bg-secondary transition">Cancelar</button>
            <button type="submit" disabled={saving} className="flex-1 py-2.5 rounded-xl bg-primary text-primary-foreground font-bold hover:opacity-90 transition disabled:opacity-50">
              {saving ? "Guardando..." : "Guardar"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function Field({ label, value, onChange, type = "text", required }: {
  label: string; value: string; onChange: (v: string) => void; type?: string; required?: boolean;
}) {
  return (
    <div className="space-y-1">
      <label className="text-xs font-medium text-muted-foreground">{label}</label>
      <input
        type={type}
        value={value}
        onChange={e => onChange(e.target.value)}
        required={required}
        className="w-full px-3 py-2.5 rounded-xl border border-border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
      />
    </div>
  );
}
