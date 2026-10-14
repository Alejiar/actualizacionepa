import { AsyncLocalStorage } from "node:async_hooks";
import { prisma } from "./prisma";

/**
 * D7 (decisión del dueño, 14-oct-2026): un día con Cierre puede corregirse SOLO al aplicar una
 * solicitud (EditRequest) aprobada por un administrador, y solo mientras el mes siga abierto.
 * Este contexto existe únicamente durante esa aplicación; fuera de él el día cerrado sigue
 * rechazando cualquier cambio de dinero (409).
 */
const approvedCorrection = new AsyncLocalStorage<{ requestId: string }>();
export function runAsApprovedCorrection<T>(requestId: string, fn: () => Promise<T>): Promise<T> {
  return approvedCorrection.run({ requestId }, fn);
}
export function inApprovedCorrection(): boolean {
  return !!approvedCorrection.getStore();
}
import { badRequest, conflict } from "./errors";
import { bogotaDayRange, toBogotaDateStr, todayBogota } from "./date-range";

/**
 * Inmutabilidad de períodos cerrados.
 *
 * Todo registro financiero (incluida una fecha implícita) solo se
 * acepta si cae en un período abierto:
 *  - no posterior al día operativo actual (ni al calendario de hoy si este es mayor);
 *  - posterior al último cierre de mes (`MonthlyClose.closedAt`), que es el ancla de capital;
 *  - en un día que todavía no tiene Cierre (`ShiftClose` "close").
 * D7: un DÍA cerrado solo se corrige por solicitud aprobada (runAsApprovedCorrection) con el mes
 * abierto; un MES cerrado nunca se modifica (su snapshot es definitivo). Fuera de eso se
 * rechaza con 409 en vez de cambiar en silencio cifras ya cerradas.
 *
 * Debe llamarse DENTRO de `moneyTransaction` para que el estado de cierres no cambie
 * entre la verificación y la escritura.
 */
export async function assertOpenPeriod(dateStr: string, effectiveAt: Date, label = "El movimiento", branchId?: string | null) {
  assertCalendarDate(dateStr, label);
  if (!Number.isFinite(effectiveAt.getTime())) throw badRequest(`${label}: fecha inválida.`);
  const maxDate = await currentMaxDate();
  if (dateStr > maxDate) throw badRequest(`${label} no puede tener una fecha posterior al día operativo (${maxDate}).`);
  const lastClose = await prisma.monthlyClose.findFirst({ where: { branchId: null }, orderBy: { closedAt: "desc" }, select: { closedAt: true, month: true } });
  if (lastClose && effectiveAt.getTime() <= lastClose.closedAt.getTime()) {
    throw conflict(`${label} cae antes del cierre de ${lastClose.month}. Un mes cerrado no se modifica.`);
  }
  if (branchId) {
    const branchClose = await prisma.monthlyClose.findFirst({ where: { branchId, month: { gte: dateStr.slice(0, 7) } }, select: { month: true } });
    if (branchClose) throw conflict(`${label} pertenece a un mes cerrado de la sucursal (${branchClose.month}). Un mes cerrado no se modifica.`);
  }
  const dayClose = await prisma.shiftClose.findUnique({ where: { date_shift: { date: dateStr, shift: "close" } }, select: { id: true } });
  if (dayClose && !inApprovedCorrection()) {
    throw conflict(`El día ${dateStr} ya tiene Cierre. Para corregirlo, crea una solicitud que un administrador apruebe (el mes debe seguir abierto).`);
  }
}

/** Valida el calendario antes de convertirlo: Date normaliza, por ejemplo, el 31 de febrero. */
export function assertCalendarDate(value: unknown, label = "El registro"): asserts value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw badRequest(`${label}: fecha inválida (usa AAAA-MM-DD).`);
  }
  const [year, month, day] = value.split("-").map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > days[month - 1]) {
    throw badRequest(`${label}: fecha inexistente.`);
  }
}

/**
 * Pedidos de Shipday (decisión del dueño, 14-oct-2026): un pedido entregado DESPUÉS del Cierre
 * de su día se carga igual, con su fecha real, porque un pedido no mueve caja ni banco (solo
 * comisión y deuda del domiciliario). Lo único que lo bloquea es un MES cerrado (su snapshot).
 */
export async function assertOrderPeriodOpen(at: Date, label = "El pedido", branchId?: string | null) {
  if (!Number.isFinite(at.getTime())) throw badRequest(`${label}: fecha inválida.`);
  // Una entrega no puede ser futura; se toleran 10 min de desfase entre el reloj de Shipday y el PC.
  if (at.getTime() > Date.now() + 10 * 60_000) throw badRequest(`${label}: la fecha de entrega es futura.`);
  // Por MES del pedido (no por el instante del último cierre): un pedido no toca la caja ni el
  // capital declarado al cerrar, así que solo lo bloquea que SU mes (o uno posterior) esté
  // cerrado. Antes, cerrar septiembre el 2 de octubre impedía cargar un pedido del 1 de octubre.
  const orderMonth = toBogotaDateStr(at).slice(0, 7);
  const closed = await prisma.monthlyClose.findFirst({
    where: { month: { gte: orderMonth }, OR: [{ branchId: null }, ...(branchId ? [{ branchId }] : [])] },
    select: { month: true },
  });
  if (closed) throw conflict(`${label} pertenece a un mes cerrado (${closed.month}). Un mes cerrado no se modifica.`);
}

/** Los módulos con fecha Date reconocen el dinero en ese instante, en Bogotá. */
export async function assertOpenInstant(at?: Date, label = "La operación", branchId?: string | null) {
  at ??= await financialNow();
  if (!Number.isFinite(at.getTime())) throw badRequest(`${label}: fecha inválida.`);
  if (at.getTime() > Date.now()) throw badRequest(`${label}: la fecha del dinero no puede ser futura.`);
  await assertOpenPeriod(toBogotaDateStr(at), at, label, branchId);
}

/** Instante tomado después del candado financiero, nunca el NOW() del inicio SQL.
 * Dos operaciones consecutivas pueden coincidir en el mismo milisegundo. Esperar
 * al siguiente tick preserva el corte estricto sin fabricar una fecha futura.
 */
export async function financialNow(): Promise<Date> {
  const last = await prisma.monthlyClose.findFirst({ where: { branchId: null }, orderBy: { closedAt: "desc" }, select: { closedAt: true } });
  if (last) {
    const delay = last.closedAt.getTime() - Date.now() + 1;
    if (delay > 100) throw conflict("El cierre tiene un instante futuro. Revisa el reloj antes de registrar dinero.");
    if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
  }
  return new Date();
}

/** No normaliza entradas erróneas. Hoy usa el instante real; días anteriores, mediodía Bogotá. */
export function parseFinancialTimestamp(value: unknown, now = new Date(), label = "La operación"): Date {
  if (typeof value !== "string") throw badRequest(`${label}: fecha inválida.`);
  const day = value.slice(0, 10);
  assertCalendarDate(day, label);
  if (value !== day && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.test(value)) {
    throw badRequest(`${label}: indica una fecha o un instante con zona horaria.`);
  }
  const at = value === day && day === toBogotaDateStr(now) ? now : new Date(value === day ? day + "T12:00:00-05:00" : value);
  if (value !== day && (Number(value.slice(11, 13)) > 23 || Number(value.slice(14, 16)) > 59 || Number(value.slice(17, 19)) > 59)) {
    throw badRequest(`${label}: hora inválida.`);
  }
  if (!Number.isFinite(at.getTime()) || at > now) throw badRequest(`${label}: fecha inválida o futura.`);
  return at;
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
