import type { Arqueo, DayData } from "@cash-buddy/shared";
import { prisma } from "../lib/prisma";
import { balancesAtEndOfDay } from "./calc";
import { toDayData, toMovement } from "./mappers";
import { getSettings } from "./settings.service";
import { bogotaDayRange, toBogotaDateStr } from "../lib/date-range";
import { isBankLinkedPaymentNote, isBankLinkedBaseNote } from "../lib/balance-markers";
import { getExpectedBalancesForDate } from "./shipday-dashboard.service";

/** "YYYY-MM-DD" del día calendario anterior (en zona Bogotá). */
function previousDateStr(date: string): string {
  return toBogotaDateStr(new Date(bogotaDayRange(date).gte.getTime() - 1));
}

/** Enumera las fechas "YYYY-MM-DD" del rango [from, to] inclusive (calendario). */
function enumerateDates(from: string, to: string): string[] {
  const out: string[] = [];
  let cur = from;
  // Guarda de seguridad: nunca más de ~400 días para no bloquear el proceso.
  for (let i = 0; i < 400 && cur <= to; i++) {
    out.push(cur);
    cur = toBogotaDateStr(new Date(bogotaDayRange(cur).lte.getTime() + 1));
  }
  return out;
}

const DELIVERED_FILTER = { in: ["DELIVERED", "COMPLETED"] };

// Garantiza que exista el registro del día, arrastrando saldos del día previo.
// Equivale a ensureDay() del store original.
export async function ensureDay(date: string): Promise<DayData> {
  const existing = await prisma.day.findUnique({
    where: { date },
    include: { movements: { orderBy: { createdAt: "asc" } } },
  });
  if (existing) return toDayData(existing);

  const settings = await getSettings();
  let initialCash = settings.initialCash;
  let initialBank = settings.initialBank;

  // Buscar el día previo más reciente con datos.
  const prev = await prisma.day.findFirst({
    where: { date: { lt: date } },
    orderBy: { date: "desc" },
    include: { movements: true },
  });
  if (prev) {
    const bal = balancesAtEndOfDay(
      prev.movements.map(toMovement),
      prev.initialCash,
      prev.initialBank,
    );
    initialCash = bal.cash;
    initialBank = bal.bank;
  }

  const created = await prisma.day.create({
    data: { date, initialCash, initialBank },
    include: { movements: true },
  });
  return toDayData(created);
}

/**
 * Saldo de apertura (efectivo y banco) para una fecha, ACUMULANDO desde el día
 * previo. El mes arranca con el capital inicial (Settings) y cada día abre con el
 * cierre del día anterior; el dinero se va sumando, no se reinicia diariamente.
 */
export async function getOpeningBalance(date: string): Promise<{ cash: number; bank: number }> {
  // Si el día ya existe, su initialCash/Bank ya es el arrastre.
  const existing = await prisma.day.findUnique({ where: { date } });
  if (existing) return { cash: existing.initialCash, bank: existing.initialBank };

  // Si no existe, calcular desde el último día previo con datos.
  const prev = await prisma.day.findFirst({
    where: { date: { lt: date } },
    orderBy: { date: "desc" },
    include: { movements: true },
  });
  if (prev) {
    const bal = balancesAtEndOfDay(prev.movements.map(toMovement), prev.initialCash, prev.initialBank);
    return { cash: bal.cash, bank: bal.bank };
  }

  // No hay historial: usar el capital inicial configurado.
  const settings = await getSettings();
  return { cash: settings.initialCash, bank: settings.initialBank };
}

export async function getDay(date: string): Promise<DayData> {
  const day = await prisma.day.findUnique({
    where: { date },
    include: { movements: { orderBy: { createdAt: "asc" } } },
  });
  if (day) return toDayData(day);
  // No persiste si no existe: devuelve un día EFÍMERO (calculado) con el saldo de
  // apertura arrastrado, SIN crear el registro. Antes llamaba a ensureDay, que sí
  // persistía, y con solo consultar/navegar un día vacío (pasado o futuro) lo creaba
  // y luego aparecía con datos en el Historial/calendario. Las escrituras (arqueo,
  // movimientos) siguen llamando a ensureDay por su cuenta cuando hace falta.
  const opening = await getOpeningBalance(date);
  return {
    date,
    initialCash: opening.cash,
    initialBank: opening.bank,
    movements: [],
    arqueoAM: null,
    arqueoPM: null,
    arqueoClose: null,
  };
}

export async function listDays(): Promise<DayData[]> {
  // Acota a los últimos ~90 días para no inflar memoria con todo el histórico
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 90);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  const days = await prisma.day.findMany({
    where: { date: { gte: cutoffStr } },
    orderBy: { date: "asc" },
    include: { movements: { orderBy: { createdAt: "asc" } } },
  });
  return days.map(toDayData);
}

/**
 * Resumen detallado de un día para el Historial: inicio (efectivo/banco),
 * ingresos, egresos, comisión de domicilios, deudas de clientes, saldo final
 * y ganancia — juntando TODAS las fuentes (Caja, Banco, pagos de
 * domiciliarios, bases, deudas de clientes), no solo los Movement de Caja
 * como hacía dayBalances(). El "cuadre" (verde/rojo) sale exclusivamente del
 * Cierre (ShiftClose shift="close") registrado ese día — el resto de la
 * información no afecta ese semáforo.
 */
export async function getDaySummary(date: string, openingOverride?: { cash: number; bank: number }) {
  // READ-ONLY: NO usar getDay/ensureDay aquí — eso CREARÍA el día (persiste un Day con
  // el saldo arrastrado del día anterior), y entonces días vacíos —pasados o futuros—
  // aparecían con "información que no existe" (saldo heredado) en el Historial y hasta
  // ensuciaban el calendario. Aquí solo se LEE: si el día no existe, movimientos=[].
  const dayRecord = await prisma.day.findUnique({
    where: { date },
    include: { movements: { orderBy: { createdAt: "asc" } } },
  });
  const movements = dayRecord?.movements ?? [];
  const range = bogotaDayRange(date);

  // Saldo de APERTURA y CIERRE del día = balance REAL acumulado que usa la Caja/Cierre
  // (getExpectedBalances), NO el arrastre viejo (Day.initialCash / balancesAtEndOfDay),
  // que solo miraba los Movement de la "Caja" vieja e ignoraba banco, domiciliarios,
  // bases, conversiones y deudas de clientes. Ese arrastre incompleto hacía que dos días
  // seguidos sin movimientos de Caja vieja abrieran con el MISMO monto aunque de por medio
  // hubiera plata de banco/domiciliarios (bug del Historial). Aquí:
  //   apertura(D) = balance real al cierre del día anterior
  //   cierre(D)   = balance real al final del día D
  // Así el cierre de un día SIEMPRE es la apertura del siguiente (cadena consistente).
  const [expectedEnd, opening] = await Promise.all([
    getExpectedBalancesForDate(date),
    openingOverride
      ? Promise.resolve(openingOverride)
      : getExpectedBalancesForDate(previousDateStr(date)),
  ]);

  const [bankTxs, driverPayments, bases, clientDebtsPaid, clientDebtsGenAgg, orders, closeShift] = await Promise.all([
    prisma.bankTransaction.findMany({ where: { date: range } }),
    prisma.driverPayment.findMany({ where: { date: range } }),
    prisma.baseTransaction.findMany({ where: { date: range } }),
    prisma.clientDebtPayment.findMany({ where: { paidAt: range }, select: { paidCash: true, paidBank: true, paidAmount: true } }),
    prisma.clientDebt.aggregate({ where: { createdAt: range }, _sum: { amount: true } }),
    prisma.shipdayOrder.findMany({ where: { deliveredAt: range, status: DELIVERED_FILTER }, select: { companyAmount: true } }),
    prisma.shiftClose.findUnique({ where: { date_shift: { date, shift: "close" } } }),
  ]);

  let cashIn = 0, cashOut = 0, bankIn = 0, bankOut = 0;
  let gastos = 0, nomina = 0;

  for (const m of movements) {
    if (m.status !== "confirmed") continue;
    if (m.medium === "cash") { if (m.type === "ingreso") cashIn += m.amount; else cashOut += m.amount; }
    else { if (m.type === "ingreso") bankIn += m.amount; else bankOut += m.amount; }
    const cat = m.category as number;
    if (m.type === "egreso" && (cat === 3 || cat === 4)) gastos += m.amount;
    if (m.type === "egreso" && (cat === 15 || cat === 16 || cat === 18)) nomina += m.amount;
  }
  for (const t of bankTxs) {
    if (t.type === "ingreso") { if (t.medium === "cash") cashIn += t.amount; else bankIn += t.amount; }
    else { if (t.medium === "cash") cashOut += t.amount; else bankOut += t.amount; }
  }
  // Pagos de comisión de domiciliarios: dinero que entra. Se excluyen los que son
  // contraparte de un BankTransaction ya contado arriba (evita doble conteo).
  for (const p of driverPayments) {
    if (isBankLinkedPaymentNote(p.notes)) continue;
    if (p.medium === "cash") cashIn += p.amount; else bankIn += p.amount;
  }
  // Bases: entrega sale, devolución vuelve. Igual, se excluyen las bank-linked.
  for (const b of bases) {
    if (b.type === "pago" && isBankLinkedBaseNote(b.notes)) continue;
    const cash = b.cashAmount || (b.bankAmount ? 0 : b.amount);
    const bank = b.bankAmount;
    if (b.type === "entrega") { cashOut += cash; bankOut += bank; }
    else { cashIn += cash; bankIn += bank; }
  }
  // Cobros de deudas de clientes: dinero que entra según el medio del abono.
  for (const cp of clientDebtsPaid) { cashIn += cp.paidCash; bankIn += cp.paidBank; }

  const comision = orders.reduce((s, o) => s + o.companyAmount, 0);
  const deudasGeneradas = clientDebtsGenAgg._sum.amount ?? 0;
  const deudasCobradas = clientDebtsPaid.reduce((s, cp) => s + (cp.paidAmount ?? cp.paidCash + cp.paidBank), 0);

  // Saldo final REAL (autoritativo), consistente con la Caja y con la apertura del
  // día siguiente. Los ingresos/egresos de arriba son el desglose informativo del día.
  const finalCash = expectedEnd.cash;
  const finalBank = expectedEnd.bank;

  // El semáforo de "caja cuadrada" depende EXCLUSIVAMENTE del Cierre del día.
  const cajaCuadrada = !!closeShift && closeShift.difference === 0 && (closeShift.bankDifference == null || closeShift.bankDifference === 0);

  // ¿Hubo ALGO ese día? Si no (día vacío, pasado o futuro), el Historial lo muestra
  // vacío en vez del saldo arrastrado. El saldo de apertura NO cuenta como actividad.
  const hasActivity =
    movements.length > 0 ||
    bankTxs.length > 0 ||
    driverPayments.length > 0 ||
    bases.length > 0 ||
    clientDebtsPaid.length > 0 ||
    orders.length > 0 ||
    (clientDebtsGenAgg._sum.amount ?? 0) > 0 ||
    !!closeShift;

  return {
    date,
    hasActivity,
    initialCash: opening.cash,
    initialBank: opening.bank,
    initialTotal: opening.cash + opening.bank,
    ingresos: cashIn + bankIn,
    egresos: cashOut + bankOut,
    comision,
    deudasGeneradas,
    deudasCobradas,
    finalCash,
    finalBank,
    finalTotal: finalCash + finalBank,
    netProfit: comision - gastos - nomina,
    hasClose: !!closeShift,
    cajaCuadrada,
  };
}

/**
 * Resúmenes de todos los días de un rango (Historial: calendario y tabla del mes).
 * Encadena el saldo: la apertura de cada día es el cierre REAL del día anterior, así
 * el mes entero queda consistente y usa una sola vez el cálculo autoritativo por día
 * (openingOverride evita recalcular el saldo de apertura desde cero cada vez).
 */
export async function getDaySummariesRange(from: string, to: string) {
  const dates = enumerateDates(from, to);
  if (dates.length === 0) return [];
  // Apertura del primer día = cierre real del día anterior al rango.
  let prevFinal = await getExpectedBalancesForDate(previousDateStr(dates[0]));
  const results = [];
  for (const date of dates) {
    const summary = await getDaySummary(date, prevFinal);
    results.push(summary);
    prevFinal = { cash: summary.finalCash, bank: summary.finalBank };
  }
  return results;
}

export async function updateArqueo(
  date: string,
  slot: "AM" | "PM" | "close",
  arqueo: Arqueo,
): Promise<DayData> {
  await ensureDay(date);
  const field = slot === "AM" ? "arqueoAM" : slot === "PM" ? "arqueoPM" : "arqueoClose";
  const updated = await prisma.day.update({
    where: { date },
    data: { [field]: arqueo },
    include: { movements: { orderBy: { createdAt: "asc" } } },
  });
  return toDayData(updated);
}
