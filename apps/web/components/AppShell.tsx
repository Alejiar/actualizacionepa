"use client";

import { useState, type ReactNode } from "react";
import { Sidebar } from "./Sidebar";
import { useDay } from "@/lib/day-context";
import { useStore } from "@/lib/store";
import { prettyDate, shiftDate } from "@/lib/format";
import { ChevronLeft, ChevronRight, Sunrise, Lock, Menu, X, UserCircle2 } from "lucide-react";
import { WelcomeWizard } from "./wizards/WelcomeWizard";
import { TermsGate } from "./TermsGate";
import { useAuth } from "@/lib/auth";

export function AppShell({ children }: { children: ReactNode }) {
  const { date, setDate, operatingDay } = useDay();
  const { state, loading, getDay } = useStore();
  const { user } = useAuth();
  const [sidebarOpen, setSidebarOpen] = useState(false);

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="h-10 w-10 rounded-full border-2 border-primary border-t-transparent animate-spin" />
      </div>
    );
  }

  // La configuración inicial y los Términos los guarda solo un administrador (el servidor lo
  // exige). Un usuario normal ve un aviso en vez de un formulario que fallaría.
  if ((!state.settings.setupComplete || !state.settings.termsAcceptedAt) && user?.role !== "admin") {
    return (
      <div className="flex min-h-screen items-center justify-center p-6 text-center">
        <div className="max-w-md space-y-2">
          <Lock className="mx-auto h-8 w-8 text-muted-foreground" />
          <h1 className="text-xl font-black">Sistema pendiente de configuración</h1>
          <p className="text-sm text-muted-foreground">Un administrador debe completar la configuración inicial y aceptar los términos antes de que puedas operar.</p>
        </div>
      </div>
    );
  }

  if (!state.settings.setupComplete) {
    return <WelcomeWizard />;
  }

  // Primera entrada: exigir aceptación de Términos y Condiciones
  if (!state.settings.termsAcceptedAt) {
    return <TermsGate />;
  }

  // "Día en curso" = el día OPERATIVO (avanza al hacer el Cierre), no la fecha calendario.
  const isToday = date === operatingDay;
  const day = getDay(date);
  const dayExists = !!state.days[date];

  return (
    <div className="flex min-h-screen w-full">
      {/* Sidebar: drawer en móvil, fijo en desktop */}
      <Sidebar mobileOpen={sidebarOpen} onClose={() => setSidebarOpen(false)} />

      {/* Overlay oscuro en móvil cuando el sidebar está abierto */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 bg-black/50 z-30 md:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      <main className="flex-1 min-w-0 flex flex-col">
        <header className="sticky top-0 z-20 glass-strong border-b border-border px-3 md:px-6 py-2.5 md:py-3 flex items-center gap-2 md:gap-4">
          {/* Botón hamburguesa — solo móvil */}
          <button
            onClick={() => setSidebarOpen(true)}
            className="md:hidden p-2 rounded-lg hover:bg-secondary transition shrink-0"
            aria-label="Abrir menú"
          >
            <Menu className="h-5 w-5" />
          </button>

          <button
            onClick={() => setDate(shiftDate(date, -1))}
            className="p-2 rounded-lg hover:bg-secondary transition shrink-0"
            title="Día anterior"
          >
            <ChevronLeft className="h-5 w-5" />
          </button>
          <div className="flex-1 flex flex-col items-center min-w-0">
            <div className="text-[10px] md:text-xs text-muted-foreground uppercase tracking-wider">
              {isToday ? "Hoy" : ""}
            </div>
            <div className="text-sm md:text-lg font-bold capitalize truncate max-w-full">{prettyDate(date)}</div>
          </div>
          <button
            onClick={() => setDate(shiftDate(date, +1))}
            className="p-2 rounded-lg hover:bg-secondary transition shrink-0"
            title="Día siguiente"
          >
            <ChevronRight className="h-5 w-5" />
          </button>

          {/* Badge de estado — oculto en móvil pequeño */}
          <div className={`hidden sm:flex items-center gap-2 px-3 py-1.5 rounded-full text-sm font-medium shrink-0 ${
            isToday ? "bg-cash-soft text-cash" : "bg-muted text-muted-foreground"
          }`}>
            {isToday ? <Sunrise className="h-4 w-4" /> : <Lock className="h-4 w-4" />}
            {isToday ? "Día en curso" : "Día cerrado"}
          </div>

          {/* Usuario en sesión — bien visible (para saber con qué cuenta se está) */}
          {user && (
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-primary/10 border border-primary/30 shrink-0" title={user.email}>
              <UserCircle2 className="h-5 w-5 text-primary shrink-0" />
              <div className="leading-tight min-w-0">
                <div className="text-sm font-bold truncate max-w-[160px]">{user.name}</div>
                <div className="text-[10px] text-muted-foreground truncate max-w-[160px]">{user.email}</div>
              </div>
            </div>
          )}
        </header>

        <div className="flex-1 p-3 md:p-6">{children}</div>
      </main>

      {/* hidden refs to avoid unused */}
      <span className="hidden">{day.date}{dayExists ? "" : ""}</span>
    </div>
  );
}
