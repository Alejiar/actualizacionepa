import { prisma } from "./prisma";
import { badRequest, conflict } from "./errors";
import { bogotaDayRange, toBogotaDateStr, todayBogota } from "./date-range";

/**
 * Inmutabilidad de períodos cerrados (sin inventar la política D7).
 *
 * Un registro con FECHA EXPLÍCITA (retroactiva o adelantada al día operativo) solo se
 * acepta si cae en un período abierto:
 *  - no posterior al día operativo actual (ni al calendario de hoy si este es mayor);
 *  - posterior al último cierre de mes (`MonthlyClose.closedAt`), que es el ancla de capital;
 *  - en un día que todavía no tiene Cierre (`ShiftClose` "close").
 * Ajustar un día o mes ya cerrado requiere la decisión del dueño (D7); hasta entonces se
 * rechaza con 409 en vez de cambiar en silencio cifras ya cerradas.
 *
 * Debe llamarse DENTRO de `moneyTransaction` para que el estado de cierres no cambie
 * entre la verificación y la escritura.
 */
export async function assertOpenPeriod(dateStr: string, effectiveAt: Date, label = "El movimiento") {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr) || toBogotaDateStr(new Date(dateStr + "T12:00:00-05:00")) !== dateStr) {
    throw badRequest(`${label}: fecha inválida (usa AAAA-MM-DD).`);
  }
  const maxDate = await currentMaxDate();
  if (dateStr > maxDate) throw badRequest(`${label} no puede tener una fecha posterior al día operativo (${maxDate}).`);
  const lastClose = await prisma.monthlyClose.findFirst({ where: { branchId: null }, orderBy: { closedAt: "desc" }, select: { closedAt: true, month: true } });
  if (lastClose && effectiveAt.getTime() <= lastClose.closedAt.getTime()) {
    throw conflict(`${label} cae antes del cierre de ${lastClose.month}. Ajustar un período cerrado requiere la decisión del dueño (D7).`);
  }
  const dayClose = await prisma.shiftClose.findUnique({ where: { date_shift: { date: dateStr, shift: "close" } }, select: { id: true } });
  if (dayClose) {
    throw conflict(`El día ${dateStr} ya tiene Cierre. Registrar o confirmar dinero en un día cerrado requiere la decisión del dueño (D7).`);
  }
}

/** ¿Está abierto el período de esta fecha? (misma regla, sin lanzar). */
export async function isOpenPeriod(dateStr: string, effectiveAt: Date): Promise<boolean> {
  try { await assertOpenPeriod(dateStr, effectiveAt); return true; } catch { return false; }
}

/** El mayor entre hoy (Bogotá) y el día operativo (día siguiente al último Cierre). */
async function currentMaxDate(): Promise<string> {
  const today = todayBogota();
  const last = await prisma.shiftClose.findFirst({ where: { shift: "close" }, orderBy: { date: "desc" }, select: { date: true } });
  if (!last) return today;
  const next = toBogotaDateStr(new Date(bogotaDayRange(last.date).lte.getTime() + 1));
  return next > today ? next : today;
}

/**
 * Instante contable de un Movement de Caja. Si se registró el mismo día de su fecha
 * operativa, cuenta en su instante real de registro; si se registró otro día (retroactivo
 * o adelantado al día operativo), cuenta al FINAL de su fecha operativa. Así la caja, el
 * Historial y los reportes usan la MISMA fecha (antes la caja usaba `createdAt` y el
 * Historial `date`, y un movimiento retroactivo caía en días distintos según la pantalla).
 */
export function movementEffectiveAt(m: { date: string; createdAt: Date }): Date {
  return toBogotaDateStr(m.createdAt) === m.date ? m.createdAt : bogotaDayRange(m.date).lte;
}
