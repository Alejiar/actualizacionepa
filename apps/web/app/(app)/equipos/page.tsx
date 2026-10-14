"use client";

import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  Monitor, ShieldCheck, ShieldAlert, Clock3, LogOut, Pencil, Ban, Check, Trash2, RotateCcw, Server, Activity,
} from "lucide-react";
import * as api from "@/lib/sd-api";
import type { Device, DeviceActivity } from "@/lib/sd-api";
import { useAuth } from "@/lib/auth";
import { useLive } from "@/lib/use-live";

function fmtDateTime(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("es-CO", {
      timeZone: "America/Bogota", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit",
    });
  } catch { return "—"; }
}

// ¿Cuándo se vio por última vez? Texto relativo simple ("hace 2 min", "en línea").
function lastSeen(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 45_000) return "en línea";
  const min = Math.round(diff / 60_000);
  if (min < 60) return `hace ${min} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `hace ${h} h`;
  return fmtDateTime(iso);
}

// Traducción legible de una fila de la bitácora (método + ruta → acción en español).
function actionLabel(a: DeviceActivity): string {
  const p = a.path.replace(/^\/api/, "");
  const rules: [RegExp, string][] = [
    [/^\/bank-transactions/, "Movimiento de banco"],
    [/^\/movements/, "Movimiento de caja"],
    [/^\/sd\/bases\/[^/]+\/give/, "Entrega de base"],
    [/^\/sd\/bases\/[^/]+\/pay/, "Cobro de base"],
    [/^\/sd\/bases/, "Base"],
    [/^\/sd\/drivers\/[^/]+\/payment/, "Pago de domiciliario"],
    [/^\/sd\/drivers\/[^/]+\/pay-credit/, "Pago de crédito a domiciliario"],
    [/^\/clients\/[^/]+\/pay/, "Cobro a cliente"],
    [/^\/clients\/debts\/[^/]+\/pay/, "Cobro de deuda de cliente"],
    [/^\/clients\/[^/]+\/debt/, "Deuda de cliente"],
    [/^\/clients/, "Cliente"],
    [/^\/hourly-/, "Clientes por hora"],
    [/^\/shifts/, "Cierre de caja / turno"],
    [/^\/sd\/closes/, "Cierre mensual"],
    [/^\/sd\/conversions/, "Conversión efectivo/banco"],
    [/^\/devices/, "Gestión de equipos"],
    [/^\/edit-requests/, "Solicitud de cambio"],
    [/^\/workers/, "Trabajador"],
    [/^\/field-notes/, "Libreta de campo"],
  ];
  const verb = a.method === "DELETE" ? "Eliminó" : a.method === "PATCH" || a.method === "PUT" ? "Editó" : "Registró";
  for (const [re, label] of rules) if (re.test(p)) return `${verb}: ${label}`;
  return `${a.method} ${p}`;
}

export default function EquiposPage() {
  const { user } = useAuth();
  const [devices, setDevices] = useState<Device[]>([]);
  const [activity, setActivity] = useState<DeviceActivity[]>([]);
  const [loading, setLoading] = useState(true);
  const [names, setNames] = useState<Record<string, string>>({});
  const [renaming, setRenaming] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const isAdmin = user?.role === "admin";

  const load = async (silent = false) => {
    // Solo el admin consulta equipos: el operador vería un 403 (y un aviso de error cada carga).
    if (!isAdmin) { setLoading(false); return; }
    if (!silent) setLoading(true);
    try {
      const [d, a] = await Promise.all([api.getDevices(), api.getDeviceActivity(undefined, 150)]);
      setDevices(prev => JSON.stringify(prev) === JSON.stringify(d.devices) ? prev : d.devices);
      setActivity(prev => JSON.stringify(prev) === JSON.stringify(a) ? prev : a);
    } catch { if (!silent) toast.error("Error al cargar equipos"); }
    if (!silent) setLoading(false);
  };

  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [isAdmin]);
  useLive(() => load(true), 5000);

  const pending = useMemo(() => devices.filter(d => d.status === "pending"), [devices]);
  const approved = useMemo(() => devices.filter(d => d.status === "approved"), [devices]);
  const blocked = useMemo(() => devices.filter(d => d.status === "blocked"), [devices]);

  const nameFor = (id: string, fallback: string) => (names[id] ?? fallback);
  const setName = (id: string, v: string) => setNames(prev => ({ ...prev, [id]: v }));

  async function run(id: string, fn: () => Promise<unknown>, okMsg: string) {
    setBusy(id);
    try { await fn(); toast.success(okMsg); await load(true); }
    catch (e) { toast.error(String(e instanceof Error ? e.message : e)); }
    finally { setBusy(null); }
  }

  async function approve(d: Device, suggested: string) {
    const name = (names[d.id] ?? suggested).trim();
    if (!name) { toast.error("Ponle un nombre al equipo"); return; }
    await run(d.id, () => api.approveDevice(d.id, name), `Equipo autorizado como "${name}"`);
  }
  async function rename(d: Device) {
    const name = (names[d.id] ?? d.name ?? "").trim();
    if (!name) { toast.error("El nombre no puede quedar vacío"); return; }
    await run(d.id, () => api.renameDevice(d.id, name), "Nombre actualizado");
    setRenaming(null);
  }
  async function block(d: Device) {
    if (!confirm(`¿Bloquear "${d.name ?? "este equipo"}"? No podrá usar el sistema hasta que lo reautorices.`)) return;
    await run(d.id, () => api.blockDevice(d.id), "Equipo bloqueado");
  }
  async function reject(d: Device) {
    if (!confirm("¿Rechazar este equipo? Quedará bloqueado (podrás reautorizarlo después).")) return;
    await run(d.id, () => api.rejectDevice(d.id), "Equipo rechazado");
  }
  async function unblock(d: Device) {
    await run(d.id, () => api.unblockDevice(d.id), "Equipo reautorizado");
  }
  async function closeSystem(d: Device) {
    if (!confirm(`¿Cerrar el sistema en "${d.name ?? "este equipo"}"? Volverá al login (sirve para identificar cuál es).`)) return;
    await run(d.id, () => api.requestDeviceLogout(d.id), "Señal enviada: el equipo volverá al login");
  }
  async function remove(d: Device) {
    if (!confirm("¿Eliminar este equipo de la lista? Si se vuelve a conectar, aparecerá como pendiente.")) return;
    await run(d.id, () => api.deleteDevice(d.id), "Equipo eliminado");
  }

  if (!isAdmin) {
    return <div className="text-center py-20 text-muted-foreground">Solo el administrador puede ver los equipos.</div>;
  }

  return (
    <div className="space-y-6 max-w-4xl mx-auto w-full">
      <div>
        <h1 className="text-2xl font-black flex items-center gap-2"><Monitor className="h-6 w-6" /> Equipos (PCs)</h1>
        <p className="text-sm text-muted-foreground">
          Autoriza qué computadores pueden usar el sistema, ponles nombre y mira desde cuál se hace cada movimiento.
        </p>
      </div>

      {loading ? (
        <div className="text-center py-20 text-muted-foreground">Cargando...</div>
      ) : (
        <>
          {/* PENDIENTES — necesitan tu autorización */}
          {pending.length > 0 && (
            <section className="space-y-2">
              <h2 className="text-sm font-black uppercase tracking-wider text-amber-600 flex items-center gap-2">
                <Clock3 className="h-4 w-4" /> Pendientes de autorización ({pending.length})
              </h2>
              {pending.map((d, i) => {
                const suggested = `PC ${approved.length + i + 1}`;
                return (
                  <div key={d.id} className="glass-strong rounded-2xl p-4 border border-amber-500/30 bg-amber-500/5 space-y-3">
                    <DeviceMeta d={d} />
                    <div className="flex flex-wrap items-center gap-2">
                      <input
                        value={nameFor(d.id, suggested)}
                        onChange={e => setName(d.id, e.target.value)}
                        placeholder="Nombre del equipo (p. ej. PC 1)"
                        className="flex-1 min-w-[160px] px-3 py-2 rounded-xl border border-border bg-background text-sm"
                      />
                      <button disabled={busy === d.id} onClick={() => approve(d, suggested)}
                        className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl bg-primary text-primary-foreground text-sm font-bold hover:opacity-90 transition disabled:opacity-50">
                        <Check className="h-4 w-4" /> Autorizar
                      </button>
                      <button disabled={busy === d.id} onClick={() => reject(d)}
                        className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl border border-border text-sm font-bold hover:bg-secondary transition disabled:opacity-50">
                        <Ban className="h-4 w-4" /> Rechazar
                      </button>
                    </div>
                  </div>
                );
              })}
            </section>
          )}

          {/* AUTORIZADOS */}
          <section className="space-y-2">
            <h2 className="text-sm font-black uppercase tracking-wider text-green-600 flex items-center gap-2">
              <ShieldCheck className="h-4 w-4" /> Autorizados ({approved.length})
            </h2>
            {approved.length === 0 && <p className="text-sm text-muted-foreground">Aún no hay equipos autorizados.</p>}
            {approved.map(d => (
              <div key={d.id} className="glass-strong rounded-2xl p-4 space-y-3">
                <DeviceMeta d={d} />
                {renaming === d.id ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <input
                      value={nameFor(d.id, d.name ?? "")}
                      onChange={e => setName(d.id, e.target.value)}
                      autoFocus
                      className="flex-1 min-w-[160px] px-3 py-2 rounded-xl border border-border bg-background text-sm"
                    />
                    <button disabled={busy === d.id} onClick={() => rename(d)}
                      className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl bg-primary text-primary-foreground text-sm font-bold hover:opacity-90 transition disabled:opacity-50">
                      <Check className="h-4 w-4" /> Guardar
                    </button>
                    <button onClick={() => setRenaming(null)}
                      className="px-3 py-2 rounded-xl border border-border text-sm font-bold hover:bg-secondary transition">Cancelar</button>
                  </div>
                ) : (
                  <div className="flex flex-wrap items-center gap-2">
                    <button onClick={() => { setName(d.id, d.name ?? ""); setRenaming(d.id); }}
                      className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl border border-border text-sm font-medium hover:bg-secondary transition">
                      <Pencil className="h-4 w-4" /> Renombrar
                    </button>
                    <button disabled={busy === d.id} onClick={() => closeSystem(d)}
                      className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl border border-border text-sm font-medium hover:bg-secondary transition disabled:opacity-50">
                      <LogOut className="h-4 w-4" /> Cerrar sistema
                    </button>
                    {!d.trusted && (
                      <button disabled={busy === d.id} onClick={() => block(d)}
                        className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl border border-red-500/30 text-red-500 text-sm font-medium hover:bg-red-500/10 transition disabled:opacity-50">
                        <Ban className="h-4 w-4" /> Bloquear
                      </button>
                    )}
                  </div>
                )}
              </div>
            ))}
          </section>

          {/* BLOQUEADOS */}
          {blocked.length > 0 && (
            <section className="space-y-2">
              <h2 className="text-sm font-black uppercase tracking-wider text-red-500 flex items-center gap-2">
                <ShieldAlert className="h-4 w-4" /> Bloqueados ({blocked.length})
              </h2>
              {blocked.map(d => (
                <div key={d.id} className="glass-strong rounded-2xl p-4 border border-red-500/20 bg-red-500/5 space-y-3">
                  <DeviceMeta d={d} />
                  <div className="flex flex-wrap items-center gap-2">
                    <button disabled={busy === d.id} onClick={() => unblock(d)}
                      className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl bg-primary text-primary-foreground text-sm font-bold hover:opacity-90 transition disabled:opacity-50">
                      <RotateCcw className="h-4 w-4" /> Reautorizar
                    </button>
                    <button disabled={busy === d.id} onClick={() => remove(d)}
                      className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl border border-border text-sm font-medium hover:bg-secondary transition disabled:opacity-50">
                      <Trash2 className="h-4 w-4" /> Eliminar
                    </button>
                  </div>
                </div>
              ))}
            </section>
          )}

          {/* BITÁCORA — qué hizo cada PC */}
          <section className="space-y-2">
            <h2 className="text-sm font-black uppercase tracking-wider text-muted-foreground flex items-center gap-2">
              <Activity className="h-4 w-4" /> Actividad por equipo
            </h2>
            <div className="glass-strong rounded-2xl overflow-hidden divide-y divide-border">
              {activity.length === 0 && <p className="p-4 text-sm text-muted-foreground">Sin actividad registrada todavía.</p>}
              {activity.map(a => (
                <div key={a.id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                  <span className="shrink-0 inline-flex items-center gap-1 text-xs font-bold px-2 py-0.5 rounded-full bg-secondary">
                    <Monitor className="h-3 w-3" /> {a.deviceName ?? "—"}
                  </span>
                  <span className="flex-1 min-w-0 truncate">{actionLabel(a)}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">{a.userName ?? "—"}</span>
                  <span className="shrink-0 text-xs text-muted-foreground/70 w-24 text-right">{fmtDateTime(a.createdAt)}</span>
                </div>
              ))}
            </div>
          </section>
        </>
      )}
    </div>
  );
}

function DeviceMeta({ d }: { d: Device }) {
  return (
    <div className="flex items-start gap-3">
      <div className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${d.trusted ? "bg-primary/15 text-primary" : "bg-secondary text-muted-foreground"}`}>
        {d.trusted ? <Server className="h-5 w-5" /> : <Monitor className="h-5 w-5" />}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-black">{d.name ?? "Sin nombre"}</span>
          {d.trusted && <span className="text-[10px] px-2 py-0.5 rounded-full bg-primary/10 text-primary font-bold">Este PC (servidor)</span>}
          {d.status === "approved" && (
            <span className={`text-[10px] px-2 py-0.5 rounded-full font-bold ${lastSeen(d.lastSeenAt) === "en línea" ? "bg-green-500/15 text-green-600" : "bg-secondary text-muted-foreground"}`}>
              {lastSeen(d.lastSeenAt)}
            </span>
          )}
        </div>
        <p className="text-xs text-muted-foreground mt-0.5">
          IP {d.lastSeenIp ?? d.firstSeenIp ?? "—"}
          {d.lastUserName ? <> · último usuario: <span className="font-medium">{d.lastUserName}</span></> : null}
        </p>
        <p className="text-[11px] text-muted-foreground/70 font-mono mt-0.5">
          {d.id.slice(0, 8)} · visto por primera vez {d.firstUserName ? `por ${d.firstUserName} ` : ""}el {fmtDateTime(d.createdAt)}
        </p>
      </div>
    </div>
  );
}
