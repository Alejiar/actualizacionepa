import { prisma } from "../lib/prisma";
import { bogotaOpenRange, toBogotaDateStr } from "../lib/date-range";
import { isBankLinkedPaymentNote, isBankLinkedBaseNote } from "../lib/balance-markers";

export interface UnifiedMovement {
  id: string;
  date: string;          // YYYY-MM-DD
  time: string;          // HH:MM
  _sortKey?: string;     // ISO timestamp para ordenar, interno
  type: "ingreso" | "egreso";
  medium: "cash" | "bank";
  amount: number;
  description: string;
  category: string;      // etiqueta legible
  source: string;        // sistema origen
  relatedName?: string;  // nombre de persona/cliente asociado
  createdByName?: string | null; // usuario que REALIZÓ el movimiento
  deviceName?: string | null;    // PC desde el que se registró (etiqueta inline)
  entityType: string;    // modelo real para solicitudes de cambio
  entityId: string;      // ID real del registro
  editableDescription: boolean; // si el campo descripción es editable
}

function iso(d: Date): string { return toBogotaDateStr(d); }
// HH:MM en formato 24h (zona Bogotá), para ordenar correctamente como string
function hm(d: Date): string {
  return d.toLocaleTimeString("en-GB", { timeZone: "America/Bogota", hour: "2-digit", minute: "2-digit" });
}
// Timestamp completo para ordenar con precisión de segundos
function sortKey(d: Date): string { return d.toISOString(); }

export async function getUnifiedMovements(params?: { from?: string; to?: string; limit?: number }): Promise<UnifiedMovement[]> {
  const dateWhere = bogotaOpenRange(params?.from, params?.to);

  const [
    movements,
    bankTxs,
    conversions,
    driverPayments,
    baseTxs,
    clientDebtsPaid,
    clientDebtsCreated,
  ] = await Promise.all([
    // Sistema original (movimientos de caja)
    prisma.movement.findMany({
      // Por FECHA OPERATIVA (la que se muestra y la que usa la caja), no por registro.
      where: (params?.from || params?.to) ? { date: { ...(params?.from ? { gte: params.from } : {}), ...(params?.to ? { lte: params.to } : {}) } } : undefined,
      include: { worker: { select: { name: true } } },
      orderBy: { createdAt: "desc" },
      take: params?.limit ?? 500,
    }),
    // Transacciones bancarias
    prisma.bankTransaction.findMany({
      where: dateWhere ? { date: dateWhere } : undefined,
      orderBy: { date: "desc" },
      take: params?.limit ?? 300,
    }),
    // Conversiones efectivo↔banco
    prisma.conversion.findMany({
      where: dateWhere ? { date: dateWhere } : undefined,
      include: { branch: { select: { name: true } } },
      orderBy: { date: "desc" },
      take: params?.limit ?? 200,
    }),
    // Pagos a domiciliarios
    prisma.driverPayment.findMany({
      where: dateWhere ? { date: dateWhere } : undefined,
      include: { driver: { select: { name: true } } },
      orderBy: { date: "desc" },
      take: params?.limit ?? 300,
    }),
    // Bases entregadas/pagadas
    prisma.baseTransaction.findMany({
      where: dateWhere ? { date: dateWhere } : undefined,
      include: { driver: { select: { name: true } } },
      orderBy: { date: "desc" },
      take: params?.limit ?? 300,
    }),
    // Cobros de deudas de clientes (total O parcial): basta con que tengan paidAt.
    prisma.clientDebtPayment.findMany({
      where: dateWhere ? { paidAt: dateWhere } : {},
      include: { client: { select: { name: true } } },
      orderBy: { paidAt: "desc" },
      take: params?.limit ?? 200,
    }),
    // Deudas creadas CON medio (desembolso al cliente): se muestran como egreso.
    prisma.clientDebt.findMany({
      where: { medium: { not: null }, ...(dateWhere ? { createdAt: dateWhere } : {}) },
      include: { client: { select: { name: true } } },
      orderBy: { createdAt: "desc" },
      take: params?.limit ?? 200,
    }),
  ]);

  const result: UnifiedMovement[] = [];

  // --- Sistema original (usa createdAt como timestamp de referencia) ---
  for (const m of movements) {
    result.push({
      id: `mov-${m.id}`,
      date: m.date,
      time: hm(m.createdAt),
      _sortKey: m.createdAt.toISOString(),
      type: m.type,
      medium: m.medium,
      amount: m.amount,
      description: m.description || categoryLabel(m.category),
      category: categoryLabel(m.category),
      source: "Caja",
      relatedName: m.worker?.name,
      createdByName: m.createdByName,
      deviceName: m.deviceName,
      entityType: "Movement",
      entityId: m.id,
      editableDescription: true,
    });
  }

  // --- Banco ---
  for (const t of bankTxs) {
    result.push({
      id: `bank-${t.id}`,
      date: iso(t.date),
      time: hm(t.createdAt),
      _sortKey: t.createdAt.toISOString(),
      type: t.type,
      medium: t.medium,
      amount: t.amount,
      description: t.description,
      category: t.type === "ingreso" ? "Ingreso banco" : "Salida banco",
      source: "Banco",
      relatedName: t.driverName ?? t.reference ?? undefined,
      createdByName: t.createdByName,
      deviceName: t.deviceName,
      entityType: "BankTransaction",
      entityId: t.id,
      editableDescription: true,
    });
  }

  // --- Conversiones ---
  for (const c of conversions) {
    const esBancoAEfectivo = c.type === "banco_a_efectivo";
    result.push({
      id: `conv-${c.id}`,
      date: iso(c.date),
      time: hm(c.date),
      _sortKey: c.date.toISOString(),
      type: esBancoAEfectivo ? "egreso" : "ingreso",
      medium: "bank",
      amount: c.amount,
      description: c.notes || (esBancoAEfectivo ? "Banco → Efectivo" : "Efectivo → Banco"),
      category: esBancoAEfectivo ? "Banco→Efectivo" : "Efectivo→Banco",
      source: "Conversión",
      relatedName: c.driverName ?? c.branch?.name,
      createdByName: c.userName,
      deviceName: c.deviceName,
      entityType: "Conversion",
      entityId: c.id,
      editableDescription: false,
    });
  }

  // --- Pagos de comisión de domiciliarios (dinero que ENTRA a la empresa) ---
  for (const p of driverPayments) {
    // Los registrados desde registerPayment llevan el marcador bank-linked:
    // el bankTransaction ya es el único registro de display para ese pago.
    if (isBankLinkedPaymentNote(p.notes)) continue;
    result.push({
      id: `dpay-${p.id}`,
      date: iso(p.date),
      time: hm(p.date),
      _sortKey: p.date.toISOString(),
      type: "ingreso",
      medium: p.medium,
      amount: p.amount,
      description: `Pago de comisión de ${p.driver?.name ?? "domiciliario"}${p.notes ? ` — ${p.notes}` : ""}`,
      category: "Pago comisión",
      source: "Domiciliarios",
      relatedName: p.driver?.name,
      createdByName: p.createdByName,
      deviceName: p.deviceName,
      entityType: "DriverPayment",
      entityId: p.id,
      editableDescription: false,
    });
  }

  // --- Bases ---
  for (const b of baseTxs) {
    // Las bases de tipo "pago" generadas por registerPayment llevan marcador bank-linked:
    // el bankTransaction ya cubre ese flujo. Las entregas y pagos manuales sí se muestran.
    if (b.type === "pago" && isBankLinkedBaseNote(b.notes)) continue;
    result.push({
      id: `base-${b.id}`,
      date: iso(b.date),
      time: hm(b.date),
      _sortKey: b.date.toISOString(),
      type: b.type === "entrega" ? "egreso" : "ingreso",
      medium: b.bankAmount > 0 && b.cashAmount === 0 ? "bank" : "cash",
      amount: b.amount,
      description: `${b.type === "entrega" ? "Base entregada a" : "Base pagada por"} ${b.driver?.name ?? "domiciliario"}${b.notes ? ` — ${b.notes}` : ""}`,
      category: b.type === "entrega" ? "Base entregada" : "Base cobrada",
      source: "Bases",
      relatedName: b.driver?.name,
      createdByName: b.createdByName,
      deviceName: b.deviceName,
      entityType: "BaseTransaction",
      entityId: b.id,
      editableDescription: false,
    });
  }

  // --- Creación de deudas con medio (dinero que SALE al cliente) ---
  for (const d of clientDebtsCreated) {
    result.push({
      id: `cdebt-out-${d.id}`,
      date: iso(d.createdAt),
      time: hm(d.createdAt),
      _sortKey: d.createdAt.toISOString(),
      type: "egreso",
      medium: d.medium === "bank" ? "bank" : "cash",
      amount: d.amount,
      description: `Deuda registrada: ${d.description} — ${d.client?.name ?? "cliente"}`,
      category: "Deuda cliente",
      source: "Clientes",
      relatedName: d.client?.name,
      createdByName: d.createdByName,
      deviceName: d.deviceName,
      entityType: "ClientDebt",
      entityId: d.id,
      editableDescription: false,
    });
  }

  // --- Cobros de deudas de clientes (total o parcial) ---
  for (const d of clientDebtsPaid) {
    if (!d.paidAt) continue;
    result.push({
      id: `cdebt-${d.id}`,
      date: iso(d.paidAt),
      time: hm(d.paidAt),
      _sortKey: d.paidAt.toISOString(),
      type: "ingreso",
      medium: d.paidBank > 0 && d.paidCash === 0 ? "bank" : "cash",
      amount: d.paidAmount,
      description: `Cobro deuda: ${d.description} — ${d.client?.name ?? "cliente"}`,
      category: "Cobro cliente",
      source: "Clientes",
      relatedName: d.client?.name,
      createdByName: d.paidByName,
      deviceName: d.paidDeviceName,
      // Tipo propio (no "ClientDebt"): al eliminar este movimiento se REVIERTE el
      // cobro y la deuda vuelve a su valor real, en vez de borrar la deuda entera.
      entityType: "ClientDebtPayment",
      entityId: d.id,
      editableDescription: false,
    });
  }

  // Ordenar por timestamp exacto (desc) — el más reciente primero
  result.sort((a, b) => (b._sortKey ?? "").localeCompare(a._sortKey ?? ""));

  // Limpiar campo interno antes de retornar
  return result.slice(0, params?.limit ?? 500).map(({ _sortKey, ...m }) => m);
}

function categoryLabel(cat: number): string {
  const labels: Record<number, string> = {
    1: "Domicilio efectivo",
    2: "Domicilio banco",
    3: "Gasto efectivo",
    4: "Gasto banco",
    5: "Base efectivo",
    6: "Base banco",
    7: "Conversión (efectivo entrada)",
    8: "Conversión (banco salida)",
    9: "Conversión (efectivo salida)",
    10: "Conversión (banco entrada)",
    11: "Salida temporal efectivo",
    12: "Salida temporal banco",
    13: "Ingreso pendiente efectivo",
    14: "Ingreso pendiente banco",
    15: "Nómina efectivo",
    16: "Nómina banco",
    17: "Otro efectivo",
    18: "Otro banco",
  };
  return labels[cat] ?? `Categoría ${cat}`;
}
