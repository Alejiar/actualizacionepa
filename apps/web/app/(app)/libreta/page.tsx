"use client";

import { useEffect, useState } from "react";
import { NotebookPen, Plus, Trash2, Pencil, Check, X } from "lucide-react";
import { toast } from "sonner";
import * as api from "@/lib/sd-api";
import type { FieldNote } from "@/lib/sd-api";
import { useAuth } from "@/lib/auth";
import { useLive } from "@/lib/use-live";
import { useDay } from "@/lib/day-context";
import { prettyDate } from "@/lib/format";

export default function LibretaPage() {
  const { user } = useAuth();
  const { date, operatingDay } = useDay();
  const isToday = date === operatingDay;
  const [notes, setNotes] = useState<FieldNote[]>([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");

  async function load() {
    try {
      const data = await api.getFieldNotes(date);
      setNotes(prev => JSON.stringify(prev) === JSON.stringify(data) ? prev : data);
    } catch {
      /* silencioso en polling */
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { setLoading(true); load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [date]);
  // Sincroniza en vivo entre todos los PCs cada 5s (silencioso: sin parpadeo)
  useLive(load, 5000);

  async function add() {
    const content = draft.trim();
    if (!content) return;
    setSaving(true);
    try {
      await api.createFieldNote(content, user?.name, date);
      setDraft("");
      await load();
      toast.success("Nota guardada");
    } catch (err) {
      toast.error(String(err));
    } finally {
      setSaving(false);
    }
  }

  async function saveEdit(id: string) {
    const content = editText.trim();
    if (!content) {
      // Antes retornaba en silencio y el botón parecía no hacer nada (UX01).
      toast.error("La nota no puede quedar vacía. Escribe el contenido o pulsa Cancelar.");
      return;
    }
    try {
      await api.updateFieldNote(id, content);
      setEditId(null);
      await load();
      toast.success("Nota actualizada");
    } catch (err) {
      toast.error(String(err));
    }
  }

  async function remove(id: string) {
    if (!confirm("¿Eliminar esta nota?")) return;
    try {
      await api.deleteFieldNote(id);
      await load();
    } catch (err) {
      toast.error(String(err));
    }
  }

  function fmt(iso: string) {
    const d = new Date(iso);
    return d.toLocaleString("es-CO", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
  }

  return (
    <div className="max-w-3xl mx-auto space-y-5">
      <div className="flex items-center gap-3">
        <div className="w-11 h-11 rounded-2xl bg-gradient-to-br from-primary to-accent flex items-center justify-center text-background">
          <NotebookPen className="h-6 w-6" />
        </div>
        <div>
          <h1 className="text-2xl font-black">Libreta de campo</h1>
          <p className="text-sm text-muted-foreground">
            Notas del día <span className="font-semibold capitalize text-foreground">{prettyDate(date)}</span>
            {isToday ? " (hoy)" : ""}. Se comparten y actualizan en vivo entre todos los equipos.
          </p>
        </div>
      </div>

      {!isToday && (
        <div className="rounded-2xl bg-amber-500/10 border border-amber-500/30 px-4 py-2.5 text-sm text-amber-600 dark:text-amber-400">
          Estás viendo notas de un día anterior. Usa las flechas de fecha (arriba) para volver a hoy.
        </div>
      )}

      {/* Composer */}
      <div className="glass-strong rounded-3xl p-4">
        <textarea
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) add(); }}
          placeholder="Escribe una nota… (Ctrl+Enter para guardar)"
          rows={3}
          className="w-full bg-secondary/50 rounded-2xl p-3 text-sm resize-y outline-none focus:ring-2 focus:ring-primary/40"
        />
        <div className="flex justify-end mt-2">
          <button
            onClick={add}
            disabled={!draft.trim() || saving}
            className="flex items-center gap-2 bg-primary text-primary-foreground font-bold px-5 py-2.5 rounded-2xl shadow-cash disabled:opacity-40 hover:opacity-90 transition"
          >
            <Plus className="h-4 w-4" /> {saving ? "Guardando…" : "Agregar nota"}
          </button>
        </div>
      </div>

      {/* Lista */}
      {loading ? (
        <div className="flex justify-center py-10">
          <div className="h-8 w-8 rounded-full border-2 border-primary border-t-transparent animate-spin" />
        </div>
      ) : notes.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">
          <NotebookPen className="h-10 w-10 mx-auto opacity-30 mb-2" />
          <p>Aún no hay notas. ¡Escribe la primera!</p>
        </div>
      ) : (
        <div className="space-y-3">
          {notes.map(n => (
            <div key={n.id} className="glass rounded-2xl p-4">
              {editId === n.id ? (
                <div className="space-y-2">
                  <textarea
                    value={editText}
                    onChange={e => setEditText(e.target.value)}
                    rows={3}
                    className="w-full bg-secondary/50 rounded-xl p-3 text-sm resize-y outline-none focus:ring-2 focus:ring-primary/40"
                  />
                  <div className="flex justify-end gap-2">
                    <button onClick={() => setEditId(null)} className="flex items-center gap-1 px-3 py-1.5 rounded-xl text-sm hover:bg-secondary transition">
                      <X className="h-4 w-4" /> Cancelar
                    </button>
                    <button onClick={() => saveEdit(n.id)} disabled={!editText.trim()} className="flex items-center gap-1 bg-primary text-primary-foreground px-3 py-1.5 rounded-xl text-sm font-semibold disabled:opacity-40">
                      <Check className="h-4 w-4" /> Guardar
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <p className="whitespace-pre-wrap text-sm leading-relaxed">{n.content}</p>
                  <div className="flex items-center justify-between mt-3 pt-2 border-t border-border/50">
                    <span className="text-[11px] text-muted-foreground">
                      {n.author ? `${n.author} · ` : ""}{fmt(n.createdAt)}
                    </span>
                    <div className="flex gap-1">
                      <button
                        onClick={() => { setEditId(n.id); setEditText(n.content); }}
                        className="p-1.5 rounded-lg hover:bg-secondary transition text-muted-foreground hover:text-foreground"
                        title="Editar"
                      >
                        <Pencil className="h-4 w-4" />
                      </button>
                      <button
                        onClick={() => remove(n.id)}
                        className="p-1.5 rounded-lg hover:bg-red-500/10 transition text-muted-foreground hover:text-red-500"
                        title="Eliminar"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                </>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
