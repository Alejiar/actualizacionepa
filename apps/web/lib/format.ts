export function formatCOP(amount: number): string {
  const n = Math.round(amount || 0);
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n).toString();
  // Add . as thousands separator
  const withSep = abs.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${sign}$${withSep}`;
}

export function todayISO(): string {
  const d = new Date();
  const tz = d.getTimezoneOffset();
  const local = new Date(d.getTime() - tz * 60000);
  return local.toISOString().slice(0, 10);
}

/**
 * "YYYY-MM-DD" del día calendario en Bogotá, SIN depender de la zona horaria del
 * navegador/equipo. Debe usarse para "hoy" en cierres de caja: con UTC puro
 * (`toISOString().slice(0,10)`) un turno hecho de noche (después de las 19:00 en
 * Bogotá) caía en el día siguiente y dejaba el cierre archivado en la fecha
 * equivocada (turnos "pendientes" fantasma). Igual que el backend (date-range.ts).
 */
export function todayBogota(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/Bogota" });
}

export function shiftDate(iso: string, days: number): string {
  // Mediodía UTC + aritmética UTC: el resultado no depende de la zona horaria del equipo.
  const d = new Date(iso + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function prettyDate(iso: string): string {
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString("es-CO", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

export function nowTime(): string {
  return new Date().toLocaleTimeString("es-CO", { hour: "2-digit", minute: "2-digit" });
}

export function uid(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}
