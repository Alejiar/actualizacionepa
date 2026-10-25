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
    // OBS-R2-01: un día del mes ABIERTO anterior al instante del cierre también queda fijo (es parte del
    // capital declarado al cerrar). El mensaje anterior decía "mes cerrado" y confundía.
    if (dateStr.slice(0, 7) > lastClose.month) {
      const when = lastClose.closedAt.toLocaleString("es-CO", { timeZone: "America/Bogota", dateStyle: "short", timeStyle: "short" });
      throw conflict(`${label}: el día ${dateStr} es anterior al cierre de ${lastClose.month}, registrado el ${when}. Lo anterior a un cierre de mes ya no se modifica: registra el ajuste en el día operativo.`);
    }
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

/**
 * Conciliación (decisión del dueño, 25-oct-2026): enlazar una contraparte o descontar de una deuda
 * un movimiento que YA se contó no mueve dinero (no cambia ningún esperado ni el conteo de su
 * Cierre), así que un día con Cierre NO lo bloquea. Solo lo bloquea un MES cerrado: su snapshot es
 * definitivo. Misma regla de mes que assertOpenPeriod, sin la regla del día.
 */
export async function assertReconcilable(at: Date, label = "La conciliación", branchId?: string | null) {
  if (!Number.isFinite(at.getTime())) throw badRequest(`${label}: fecha inválida.`);
  const lastClose = await prisma.monthlyClose.findFirst({ where: { branchId: null }, orderBy: { closedAt: "desc" }, select: { closedAt: true, month: true } });
  if (lastClose && at.getTime() <= lastClose.closedAt.getTime()) {
    throw conflict(`${label}: el movimiento es anterior al cierre de ${lastClose.month}. Un mes cerrado no se modifica.`);
  }
  if (branchId) {
    const branchClose = await prisma.monthlyClose.findFirst({ where: { branchId, month: { gte: toBogotaDateStr(at).slice(0, 7) } }, select: { month: true } });
    if (branchClose) throw conflict(`${label}: el movimiento pertenece a un mes cerrado de la sucursal (${branchClose.month}).`);
  }
}

/** ¿El día de este instante ya tiene Cierre? */
export async function isDayClosed(at: Date): Promise<boolean> {
  return !!(await prisma.shiftClose.findUnique({ where: { date_shift: { date: toBogotaDateStr(at), shift: "close" } }, select: { id: true } }));
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
  // Excepción (NEW02): un pedido manual del día operativo cuando este va por delante del calendario.
  if (at.getTime() > Date.now() + 10 * 60_000) {
    const op = await operatingDay();
    if (op <= todayBogota() || toBogotaDateStr(at) !== op) throw badRequest(`${label}: la fecha de entrega es futura.`);
  }
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
  at ??= await moneyNow();
  if (!Number.isFinite(at.getTime())) throw badRequest(`${label}: fecha inválida.`);
  if (at.getTime() > Date.now()) {
    // Única excepción: la caja va por delante del calendario (Cierre registrado antes de
    // medianoche) y el instante cae en un día hasta el operativo. Los días cerrados por adelantado
    // siguen la regla de días cerrados (409, o corrección aprobada D7); antes una corrección
    // aprobada de un día cerrado por adelantado se rechazaba como "futura".
    const op = await operatingDay();
    if (op <= todayBogota() || toBogotaDateStr(at) > op) {
      // Un día que ya tiene Cierre se informa como tal (409), no como "futuro".
      await assertOpenPeriod(toBogotaDateStr(at), at, label, branchId);
      throw badRequest(`${label}: la fecha del dinero no puede ser futura.`);
    }
  }
  await assertOpenPeriod(toBogotaDateStr(at), at, label, branchId);
}

/**
 * Día operativo: el siguiente al último Cierre ("close"); sin Cierres, hoy. Es el día de la
 * caja abierta y NO cambia a medianoche (misma regla que shift-close.getCurrentOperatingDate).
 */
export async function operatingDay(): Promise<string> {
  const last = await prisma.shiftClose.findFirst({ where: { shift: "close" }, orderBy: { date: "desc" }, select: { date: true } });
  if (!last) return todayBogota();
  return toBogotaDateStr(new Date(bogotaDayRange(last.date).lte.getTime() + 1));
}

/**
 * Instante contable del dinero registrado "ahora" (NEW02, decisión del dueño 21-oct-2026):
 * TODO cuenta en el día operativo, nunca según el reloj. Si el día operativo es hoy, es el
 * instante real; si la caja va atrasada (hoy es 21 y sigue abierta la del 20), el final del día
 * operativo; si va adelantada (se cerró el 20 antes de medianoche), el inicio del día operativo.
 * Los Cierres (ShiftClose/MonthlyClose) siguen sellándose con la hora real (financialNow): su
 * esperado se guarda al cerrar y las correcciones posteriores se comparan con esa hora.
 */
export async function moneyNow(): Promise<Date> {
  const real = await financialNow();
  const op = await operatingDay();
  const today = toBogotaDateStr(real);
  if (op === today) return real;
  return op < today ? bogotaDayRange(op).lte : bogotaDayRange(op).gte;
}

/** Día operativo y su instante contable actual, para validar fechas pedidas explícitamente. */
export async function operatingClock(): Promise<{ day: string; at: Date }> {
  return { day: await operatingDay(), at: await moneyNow() };
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

/** No normaliza entradas erróneas. Con `op` (de operatingClock), una fecha sin hora igual al día
 * operativo cuenta en su instante contable (moneyNow) y una posterior se rechaza; sin `op`, hoy
 * usa el instante real. Días anteriores: mediodía Bogotá. */
export function parseFinancialTimestamp(value: unknown, now = new Date(), label = "La operación", op?: { day: string; at: Date }): Date {
  if (typeof value !== "string") throw badRequest(`${label}: fecha inválida.`);
  const day = value.slice(0, 10);
  assertCalendarDate(day, label);
  if (value !== day && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.test(value)) {
    throw badRequest(`${label}: indica una fecha o un instante con zona horaria.`);
  }
  if (op && value === day) {
    if (day === op.day) return op.at;
    if (day > op.day) throw badRequest(`${label} no puede tener una fecha posterior al día operativo (${op.day}).`);
  }
  const at = value === day && day === toBogotaDateStr(now) ? now : new Date(value === day ? day + "T12:00:00-05:00" : value);
  if (value !== day && (Number(value.slice(11, 13)) > 23 || Number(value.slice(14, 16)) > 59 || Number(value.slice(17, 19)) > 59)) {
    throw badRequest(`${label}: hora inválida.`);
  }
  if (!Number.isFinite(at.getTime())) throw badRequest(`${label}: fecha inválida o futura.`);
  if (op) {
    // NEW02: el tope es el día operativo, no el reloj. Un instante "futuro" de un día cerrado o del
    // operativo lo resuelve assertOpenInstant (409 día cerrado / permitido / futuro).
    if (toBogotaDateStr(at) > op.day) throw badRequest(`${label} no puede tener una fecha posterior al día operativo (${op.day}).`);
    return at;
  }
  if (at > now) throw badRequest(`${label}: fecha inválida o futura.`);
  return at;
}

/** ¿Está abierto el período de esta fecha? (misma regla, sin lanzar). */
export async function isOpenPeriod(dateStr: string, effectiveAt: Date): Promise<boolean> {
  try { await assertOpenPeriod(dateStr, effectiveAt); return true; } catch { return false; }
}

/** Fecha máxima registrable = el día operativo (NEW02): con la caja del 20 abierta no se registra
 * dinero en el 21 aunque el calendario ya diga 21. Antes era el mayor entre hoy y el operativo. */
async function currentMaxDate(): Promise<string> {
  return operatingDay();
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
