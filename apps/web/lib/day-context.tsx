"use client";

import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { todayBogota } from "./format";
import * as api from "./sd-api";
import { getToken } from "./api";

const Ctx = createContext<{
  date: string;
  setDate: (d: string) => void;
  /** Día OPERATIVO actual (avanza manualmente al registrar el Cierre, no por reloj). */
  operatingDay: string;
} | null>(null);

export function DayProvider({ children }: { children: ReactNode }) {
  const [date, setDate] = useState(todayBogota);
  const [operatingDay, setOperatingDay] = useState(todayBogota);
  const firstPersist = useRef(true);
  const hydrated = useRef(false);
  const prevOp = useRef<string | null>(null);

  // Persistir el día seleccionado (salta el primer render para no pisar lo guardado
  // antes de restaurarlo abajo).
  useEffect(() => {
    if (firstPersist.current) { firstPersist.current = false; return; }
    if (typeof window !== "undefined") sessionStorage.setItem("epa.day", date);
  }, [date]);

  useEffect(() => {
    const stored = typeof window !== "undefined" ? sessionStorage.getItem("epa.day") : null;
    if (stored) setDate(stored);

    let cancelled = false;
    async function loadOperatingDay() {
      // Sin sesión (pantalla de login) no se consulta: cada intento era un 401 en el
      // registro del lanzador cada 8 s mientras la ventana esperaba el inicio de sesión.
      if (!getToken()) return;
      try {
        const r = await api.getCurrentOperatingDate();
        if (cancelled || !r?.date) return;
        setOperatingDay(r.date);
        if (!hydrated.current) {
          // Primera carga: si no había día guardado en la sesión, ubicarse en el día
          // operativo (no en la fecha calendario del navegador).
          hydrated.current = true;
          prevOp.current = r.date;
          if (!stored) setDate(r.date);
        } else if (prevOp.current && r.date !== prevOp.current) {
          // El día operativo AVANZÓ (se registró un Cierre). Si el usuario estaba
          // viendo el día operativo anterior, llevarlo automáticamente al nuevo.
          const from = prevOp.current;
          setDate((prev) => (prev === from ? r.date : prev));
          prevOp.current = r.date;
        }
      } catch {
        /* aún sin sesión: el intervalo reintenta */
      }
    }
    loadOperatingDay();
    const id = setInterval(loadOperatingDay, 8000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  return <Ctx.Provider value={{ date, setDate, operatingDay }}>{children}</Ctx.Provider>;
}

export function useDay() {
  const c = useContext(Ctx);
  if (!c) throw new Error("useDay must be inside DayProvider");
  return c;
}
