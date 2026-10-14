"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { LogIn, Lock, Mail } from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "@/lib/auth";

export default function LoginPage() {
  const { user, loading, login } = useAuth();
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [brand, setBrand] = useState<{ brandName: string; logoData: string | null }>({ brandName: "Cash Buddy EPA", logoData: null });

  useEffect(() => {
    if (!loading && user) router.replace("/");
  }, [loading, user, router]);

  // Branding público (logo + nombre) sin necesidad de login
  useEffect(() => {
    fetch("/api/branding").then(r => r.json()).then(b => setBrand({ brandName: b.brandName || "Cash Buddy", logoData: b.logoData })).catch(() => {});
  }, []);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    try {
      await login({ email, password });
      router.replace("/");
    } catch (err) {
      toast.error((err as Error)?.message ?? "No se pudo iniciar sesión");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="flex flex-col items-center mb-8">
          <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-primary to-accent flex items-center justify-center text-background font-black text-3xl shadow-cash overflow-hidden">
            {brand.logoData
              ? <img src={brand.logoData} alt="logo" className="w-full h-full object-contain" />
              : (brand.brandName.charAt(0).toUpperCase() || "E")}
          </div>
          <h1 className="mt-4 text-2xl font-black">{brand.brandName}</h1>
          <p className="text-sm text-muted-foreground">Sistema de caja diaria</p>
        </div>

        <form onSubmit={onSubmit} className="glass-strong rounded-2xl p-6 space-y-4">
          <div>
            <label className="text-xs text-muted-foreground uppercase tracking-wider">Correo</label>
            <div className="mt-1.5 flex items-center gap-2 bg-input/40 border border-border rounded-xl px-3">
              <Mail className="h-4 w-4 text-muted-foreground" />
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoFocus
                className="flex-1 bg-transparent py-3 outline-none text-sm"
                placeholder="tu-correo@empresa.com"
              />
            </div>
          </div>

          <div>
            <label className="text-xs text-muted-foreground uppercase tracking-wider">Contraseña</label>
            <div className="mt-1.5 flex items-center gap-2 bg-input/40 border border-border rounded-xl px-3">
              <Lock className="h-4 w-4 text-muted-foreground" />
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                className="flex-1 bg-transparent py-3 outline-none text-sm"
                placeholder="••••••••"
              />
            </div>
          </div>

          <button
            type="submit"
            disabled={submitting}
            className="w-full flex items-center justify-center gap-2 bg-primary text-primary-foreground font-bold py-3 rounded-xl shadow-cash hover:scale-[1.01] active:scale-[0.99] transition disabled:opacity-60"
          >
            <LogIn className="h-5 w-5" />
            {submitting ? "Entrando..." : "Iniciar sesión"}
          </button>
        </form>

        <p className="text-center text-xs text-muted-foreground mt-6">
          Acceso privado · v1.0
        </p>
      </div>
    </div>
  );
}
