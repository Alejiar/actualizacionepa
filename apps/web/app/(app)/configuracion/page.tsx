"use client";

import { useEffect, useState } from "react";
import { useStore } from "@/lib/store";
import { useAuth } from "@/lib/auth";
import { MoneyInput } from "@/components/MoneyInput";
import { formatCOP } from "@/lib/format";
import { Trash2, AlertTriangle, Percent, Users, Plus, Shield, UserCog } from "lucide-react";
import { toast } from "sonner";
import * as api from "@/lib/sd-api";
import type { SystemUser } from "@/lib/sd-api";

export default function SettingsPage() {
  const { state, updateSettings, resetAll } = useStore();
  const { user: currentUser } = useAuth();
  const isAdmin = currentUser?.role === "admin";
  const [name, setName] = useState(state.settings.companyName);
  const [brandName, setBrandName] = useState(state.settings.brandName ?? "Cash Buddy");
  const [logoData, setLogoData] = useState<string | null | undefined>(state.settings.logoData);
  const [cash, setCash] = useState(state.settings.initialCash);
  const [bank, setBank] = useState(state.settings.initialBank);
  const [pct, setPct] = useState(state.settings.commissionPercent ?? 0);
  const [confirm, setConfirm] = useState(0);

  const [savingSettings, setSavingSettings] = useState(false);
  async function save() {
    if (!isAdmin || savingSettings) return;
    setSavingSettings(true);
    try {
      await updateSettings({ companyName: name, brandName, logoData, initialCash: cash, initialBank: bank, commissionPercent: pct });
      // Solo tras la confirmación del servidor.
      toast.success("✅ Configuración guardada");
    } catch (e) {
      toast.error((e as Error)?.message || "No se pudo guardar la configuración");
    } finally {
      setSavingSettings(false);
    }
  }

  function onLogoFile(file: File) {
    if (file.size > 1.5 * 1024 * 1024) { toast.error("La imagen es muy grande (máx 1.5MB)"); return; }
    const reader = new FileReader();
    reader.onload = () => { setLogoData(reader.result as string); toast.success("Logo cargado — recuerda Guardar"); };
    reader.readAsDataURL(file);
  }

  const example = Math.round(10000 * (pct / 100));

  return (
    <div className="space-y-5 max-w-2xl">
      <h1 className="text-2xl font-bold">⚙️ Configuración</h1>
      {!isAdmin && (
        <div className="rounded-2xl border p-4 text-sm text-muted-foreground">
          🔒 Solo lectura: únicamente un administrador puede cambiar la configuración.
        </div>
      )}
      {/* Para usuarios sin permisos el formulario queda deshabilitado (solo lectura). */}
      <fieldset disabled={!isAdmin || savingSettings} className="space-y-5 disabled:opacity-80">

      {/* Marca del sistema */}
      <div className="glass-strong rounded-3xl p-6 space-y-4">
        <h2 className="font-bold text-lg">🎨 Marca del sistema</h2>
        <div>
          <div className="text-xs uppercase tracking-wider text-muted-foreground mb-2">Nombre del sistema (aparece en el menú y login)</div>
          <input value={brandName} onChange={(e) => setBrandName(e.target.value)} placeholder="Ej: ZENBYTE" className="w-full glass rounded-xl px-4 py-3 outline-none text-lg font-bold" />
        </div>
        <div>
          <div className="text-xs uppercase tracking-wider text-muted-foreground mb-2">Logo / Ícono de la empresa</div>
          <div className="flex items-center gap-4">
            <div className="w-20 h-20 rounded-2xl bg-secondary/50 border border-border flex items-center justify-center overflow-hidden shrink-0">
              {logoData
                ? <img src={logoData} alt="logo" className="w-full h-full object-contain" />
                : <span className="text-2xl font-black text-muted-foreground">{brandName.charAt(0).toUpperCase()}</span>}
            </div>
            <div className="space-y-2">
              <label className="inline-block px-4 py-2 bg-primary text-primary-foreground rounded-xl text-sm font-bold cursor-pointer hover:opacity-90 transition">
                Subir logo
                <input type="file" accept="image/*" className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) onLogoFile(f); }} />
              </label>
              {logoData && (
                <button onClick={() => { setLogoData(null); toast.message("Logo quitado — recuerda Guardar"); }} className="block text-xs text-red-500 hover:underline">Quitar logo</button>
              )}
              <p className="text-[11px] text-muted-foreground">PNG/JPG, se adapta solo. Máx 1.5MB.</p>
            </div>
          </div>
        </div>
        <button onClick={save} className="w-full bg-primary text-primary-foreground font-bold py-3 rounded-xl shadow-cash">Guardar marca</button>
      </div>

      <div className="glass-strong rounded-3xl p-6 space-y-4">
        <div>
          <div className="text-xs uppercase tracking-wider text-muted-foreground mb-2">Nombre de la empresa</div>
          <input value={name} onChange={(e) => setName(e.target.value)} className="w-full glass rounded-xl px-4 py-3 outline-none text-lg font-bold" />
        </div>
        <div>
          <div className="text-xs uppercase tracking-wider text-muted-foreground mb-2">Saldo inicial efectivo</div>
          <MoneyInput value={cash} onChange={setCash} />
        </div>
        <div>
          <div className="text-xs uppercase tracking-wider text-muted-foreground mb-2">Saldo inicial banco</div>
          <MoneyInput value={bank} onChange={setBank} />
        </div>
        <button onClick={save} className="w-full bg-primary text-primary-foreground font-bold py-3 rounded-xl shadow-cash">Guardar cambios</button>
      </div>

      <div className="glass-strong rounded-3xl p-6 space-y-4">
        <div className="flex items-center gap-2">
          <Percent className="h-5 w-5 text-primary" />
          <h2 className="font-bold text-lg">💰 Comisión a domiciliarios</h2>
        </div>
        <p className="text-sm text-muted-foreground">
          Este es el porcentaje del valor de cada domicilio que la empresa le paga al domiciliario como su parte.
          Se suma automáticamente a la nómina pendiente de cada trabajador.
        </p>
        <div>
          <div className="text-xs uppercase tracking-wider text-muted-foreground mb-2">Porcentaje por domicilio (%)</div>
          <div className="flex items-center gap-2">
            <input
              type="number"
              min={0}
              max={100}
              value={pct}
              onChange={(e) => setPct(Math.max(0, Math.min(100, Number(e.target.value) || 0)))}
              className="flex-1 glass rounded-xl px-4 py-3 outline-none text-2xl font-black tnum"
            />
            <span className="text-2xl font-black text-muted-foreground">%</span>
          </div>
        </div>
        <div className="p-4 rounded-2xl bg-cash-soft text-cash text-sm">
          💡 Si un domicilio vale <b>$10.000</b>, el domiciliario recibe <b className="tnum">{formatCOP(example)}</b> ({pct}%)
        </div>
        <button onClick={save} className="w-full bg-primary text-primary-foreground font-bold py-3 rounded-xl shadow-cash">Guardar porcentaje</button>
      </div>

      </fieldset>

      {/* Gestión de usuarios — solo admin */}
      {isAdmin && <UserManagement />}

      {/* Zona peligrosa — solo admin */}
      {isAdmin && (
        <div className="glass-strong rounded-3xl p-6 border border-danger/30">
          <div className="flex items-center gap-2 text-danger mb-2">
            <AlertTriangle className="h-5 w-5" />
            <h2 className="font-bold">Zona peligrosa</h2>
          </div>
          <p className="text-sm text-muted-foreground mb-4">Esto borra absolutamente toda la información: días, movimientos, arqueos, clientes, banco, pedidos, deudas, cierres y bases.</p>
          {confirm === 0 && (
            <button onClick={() => setConfirm(1)} className="flex items-center gap-2 bg-danger-soft text-danger font-bold px-4 py-2.5 rounded-xl">
              <Trash2 className="h-4 w-4" /> Borrar todos los datos
            </button>
          )}
          {confirm === 1 && (
            <button onClick={() => setConfirm(2)} className="bg-danger text-destructive-foreground font-bold px-4 py-2.5 rounded-xl">
              ¿Seguro? Toca otra vez
            </button>
          )}
          {confirm === 2 && (
            <button onClick={async () => { try { await resetAll(); toast.success("Todo borrado. Te llevará al asistente."); } catch (e) { toast.error((e as Error)?.message || "No se pudo borrar"); } finally { setConfirm(0); } }} className="bg-danger text-destructive-foreground font-bold px-4 py-2.5 rounded-xl animate-pulse-warn">
              💥 SÍ, borrar todo definitivamente
            </button>
          )}
        </div>
      )}

      {/* Créditos del desarrollador — ZENBYTE */}
      <DeveloperCredits />
    </div>
  );
}

function DeveloperCredits() {
  return (
    <div className="rounded-3xl p-6 text-center" style={{ background: "linear-gradient(135deg,#0b1220,#0e1b2e)" }}>
      <div className="flex flex-col items-center gap-3">
        {/* Logo ZENBYTE (cubo isométrico azul→cian) */}
        <svg width="72" height="72" viewBox="0 0 100 100" aria-label="ZENBYTE">
          <defs>
            <linearGradient id="zbTop" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor="#3aa0ff" /><stop offset="100%" stopColor="#1e6fd9" />
            </linearGradient>
            <linearGradient id="zbLeft" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#1e6fd9" /><stop offset="100%" stopColor="#114b9c" />
            </linearGradient>
            <linearGradient id="zbRight" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#36e2ff" /><stop offset="100%" stopColor="#19a8d6" />
            </linearGradient>
          </defs>
          {/* cara superior */}
          <polygon points="50,8 90,30 50,52 10,30" fill="url(#zbTop)" />
          {/* cara izquierda */}
          <polygon points="10,30 50,52 50,94 10,72" fill="url(#zbLeft)" />
          {/* cara derecha */}
          <polygon points="90,30 50,52 50,94 90,72" fill="url(#zbRight)" />
          {/* Z estilizada */}
          <path d="M34,34 L62,34 L40,58 L66,58" fill="none" stroke="#ffffff" strokeWidth="5" strokeLinejoin="round" strokeLinecap="round" opacity="0.92" />
        </svg>
        <div className="text-2xl font-black tracking-[0.3em] text-white">ZENBYTE</div>
        <div className="text-sm text-blue-200/80">Desarrollado por <span className="font-bold text-white">Alejandro Jiménez Arbeláez</span></div>
        <a
          href="https://wa.me/573234750914"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-2 mt-1 px-4 py-2 rounded-xl bg-blue-500/20 text-blue-200 hover:bg-blue-500/30 transition text-sm font-bold"
        >
          📞 +57 323 475 0914
        </a>
        <div className="text-[11px] text-blue-200/40 mt-1">© {new Date().getFullYear()} ZENBYTE · Todos los derechos reservados</div>
      </div>
    </div>
  );
}

function UserManagement() {
  const [users, setUsers] = useState<SystemUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ name: "", email: "", password: "", role: "user" as "admin" | "user" });
  const [saving, setSaving] = useState(false);

  const load = () => {
    setLoading(true);
    api.getUsers().then(setUsers).catch(() => toast.error("Error al cargar usuarios")).finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, []);

  async function createUser() {
    if (!form.name.trim() || !form.email.trim() || form.password.length < 6) {
      toast.error("Completa todos los campos (contraseña mínimo 6 caracteres)");
      return;
    }
    setSaving(true);
    try {
      await api.createUser(form);
      toast.success(`✅ Usuario ${form.name} creado`);
      setForm({ name: "", email: "", password: "", role: "user" });
      setShowForm(false);
      load();
    } catch (err) { toast.error(String(err)); }
    setSaving(false);
  }

  async function toggleActive(u: SystemUser) {
    try {
      await api.updateUser(u.id, { active: !u.active });
      toast.success(u.active ? "Usuario desactivado" : "Usuario reactivado");
      load();
    } catch (err) { toast.error(String(err)); }
  }

  async function changeRole(u: SystemUser) {
    const newRole = u.role === "admin" ? "user" : "admin";
    if (!confirm(`¿Cambiar a ${u.name} a rol "${newRole === "admin" ? "Administrador" : "Administrativo"}"?`)) return;
    try {
      await api.updateUser(u.id, { role: newRole });
      toast.success("Rol actualizado");
      load();
    } catch (err) { toast.error(String(err)); }
  }

  async function removeUser(u: SystemUser) {
    if (!confirm(`¿Eliminar al usuario ${u.name}? Esta acción no se puede deshacer.`)) return;
    try {
      await api.deleteUser(u.id);
      toast.success("Usuario eliminado");
      load();
    } catch (err) { toast.error(String(err)); }
  }

  return (
    <div className="glass-strong rounded-3xl p-6 space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Users className="h-5 w-5 text-primary" />
          <h2 className="font-bold text-lg">Usuarios del sistema</h2>
        </div>
        <button onClick={() => setShowForm(v => !v)} className="flex items-center gap-2 px-3 py-2 bg-primary text-primary-foreground rounded-xl text-sm font-bold hover:opacity-90 transition">
          <Plus className="h-4 w-4" /> Nuevo usuario
        </button>
      </div>

      {/* Formulario de creación */}
      {showForm && (
        <div className="glass rounded-2xl p-4 space-y-3 border border-primary/20">
          <div className="grid grid-cols-2 gap-3">
            <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="Nombre completo"
              className="glass rounded-xl px-3 py-2.5 text-sm outline-none" />
            <input value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} placeholder="Correo (usuario)" type="email"
              className="glass rounded-xl px-3 py-2.5 text-sm outline-none" />
          </div>
          <input value={form.password} onChange={e => setForm(f => ({ ...f, password: e.target.value }))} placeholder="Contraseña (mín. 6 caracteres)" type="password"
            className="w-full glass rounded-xl px-3 py-2.5 text-sm outline-none" />
          <div className="grid grid-cols-2 gap-2">
            <button onClick={() => setForm(f => ({ ...f, role: "user" }))}
              className={`flex items-center justify-center gap-2 p-3 rounded-xl border-2 text-sm font-bold transition ${form.role === "user" ? "border-primary bg-primary/10" : "border-border bg-secondary/40"}`}>
              <UserCog className="h-4 w-4" /> Administrativo
            </button>
            <button onClick={() => setForm(f => ({ ...f, role: "admin" }))}
              className={`flex items-center justify-center gap-2 p-3 rounded-xl border-2 text-sm font-bold transition ${form.role === "admin" ? "border-amber-500 bg-amber-500/10" : "border-border bg-secondary/40"}`}>
              <Shield className="h-4 w-4" /> Administrador
            </button>
          </div>
          <p className="text-xs text-muted-foreground">
            {form.role === "user"
              ? "⚠️ Administrativo: NO puede borrar datos. Debe pedir permiso al admin para editar."
              : "👑 Administrador: control total, aprueba solicitudes de cambio."}
          </p>
          <button disabled={saving} onClick={createUser}
            className="w-full bg-primary text-primary-foreground font-bold py-2.5 rounded-xl disabled:opacity-50">
            {saving ? "Creando…" : "Crear usuario"}
          </button>
        </div>
      )}

      {/* Lista de usuarios */}
      {loading ? (
        <p className="text-center py-4 text-sm text-muted-foreground">Cargando…</p>
      ) : (
        <div className="space-y-2">
          {users.map(u => (
            <div key={u.id} className={`flex items-center justify-between p-3 rounded-xl bg-secondary/30 ${!u.active ? "opacity-50" : ""}`}>
              <div className="flex items-center gap-3 min-w-0">
                <div className={`w-9 h-9 shrink-0 rounded-full flex items-center justify-center font-black text-sm ${u.role === "admin" ? "bg-amber-500/20 text-amber-600" : "bg-primary/15 text-primary"}`}>
                  {u.name.charAt(0).toUpperCase()}
                </div>
                <div className="min-w-0">
                  <div className="font-bold text-sm flex items-center gap-2">
                    {u.name}
                    <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-bold ${u.role === "admin" ? "bg-amber-500/20 text-amber-600" : "bg-primary/15 text-primary"}`}>
                      {u.role === "admin" ? "Admin" : "Administrativo"}
                    </span>
                    {!u.active && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-secondary text-muted-foreground">Inactivo</span>}
                  </div>
                  <div className="text-xs text-muted-foreground">{u.email}</div>
                </div>
              </div>
              <div className="flex items-center gap-1">
                <button onClick={() => changeRole(u)} title="Cambiar rol" className="p-1.5 rounded-lg hover:bg-secondary transition text-muted-foreground hover:text-foreground">
                  <Shield className="h-4 w-4" />
                </button>
                <button onClick={() => toggleActive(u)} className="text-xs px-2.5 py-1 rounded-full font-bold bg-secondary hover:bg-muted transition">
                  {u.active ? "Desactivar" : "Activar"}
                </button>
                <button onClick={() => removeUser(u)} title="Eliminar" className="p-1.5 rounded-lg hover:bg-secondary transition text-muted-foreground hover:text-destructive">
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
