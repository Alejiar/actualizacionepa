import { applyDebtDelta, applyBankToDriver } from "./driver.service";
import { prisma, moneyTransaction } from "../lib/prisma";
import { bogotaOpenRange } from "../lib/date-range";
import { badRequest } from "../lib/errors";
import { BANK_LINKED_PAYMENT_NOTE, BANK_LINKED_BASE_PREFIX } from "../lib/balance-markers";
import * as hourlySvc from "./hourly-client.service";

export async function list(params?: { type?: "ingreso" | "egreso"; from?: string; to?: string }) {
  const where: Record<string, unknown> = {};
  if (params?.type) where.type = params.type;
  const dateRange = bogotaOpenRange(params?.from, params?.to);
  if (dateRange) where.date = dateRange;
  return prisma.bankTransaction.findMany({
    where,
    orderBy: { date: "desc" },
  });
}

export async function create(data: {
  type: "ingreso" | "egreso";
  medium?: "cash" | "bank";
  amount: number;
  // Movimientos mixtos (#3): si se envían, se reparte el monto en efectivo + banco.
  cashAmount?: number;
  bankAmount?: number;
  description: string;
  reference?: string;
  driverId?: string;
  date?: string;
  createdBy?: string | null;
  createdByName?: string | null;
  deviceId?: string | null;
  deviceName?: string | null;
  // Si se registra como contraparte de otro movimiento, su id va aquí para enlazarlos.
  pairWith?: string;
  // Marca explícita: este movimiento NO requiere contraparte (es independiente).
  noCounterpart?: boolean;
}) {
  return moneyTransaction(async () => {
  // Punto 4 — bloquear montos inválidos (0 o negativos) que falsean los saldos.
  const cashIn0 = Math.round(data.cashAmount ?? 0);
  const bankIn0 = Math.round(data.bankAmount ?? 0);
  const totalIn = (cashIn0 + bankIn0) || Math.round(data.amount ?? 0);
  if (!Number.isFinite(totalIn) || totalIn <= 0) {
    throw badRequest("El monto debe ser mayor a 0.");
  }
  if (cashIn0 < 0 || bankIn0 < 0) {
    throw badRequest("Los montos no pueden ser negativos.");
  }

  let driverName: string | undefined;
  if (data.driverId) {
    const driver = await prisma.driver.findUnique({ where: { id: data.driverId } });
    driverName = driver?.name;
  }
  // Fecha del movimiento. Defensa: NINGÚN movimiento puede quedar fechado en el
  // futuro (eso lo sacaría del "esperado de hoy" y el dinero parecería no existir).
  // Si por una zona horaria mal calculada en el cliente llega una fecha futura, se
  // ajusta a "ahora". El back-dating al pasado sí se respeta (corrección manual).
  const now = new Date();
  let when = data.date ? new Date(data.date) : now;
  if (Number.isNaN(when.getTime()) || when.getTime() > now.getTime()) when = now;

  // Enlace explícito de contraparte: comparten un pairId. Así, salida ↔ retorno se
  // cuadran sin depender de coincidencias de monto.
  //
  // FECHA DE LA CONTRAPARTE: se fija SIEMPRE en el día del movimiento ORIGINAL, no en
  // "hoy". Un par entrada↔salida es plata de paso que neta a cero; si la contraparte
  // cae en otro día que el original, en la vista de un solo día nunca se ven juntos y
  // AMBOS quedan pintados como "esperando contraparte" para siempre (bug reportado: dos
  // movimientos —75.000 y 100.000— cuadrados pero en días distintos). Heredar la fecha
  // del original hace que el par cuadre en su día. Es neutro para el saldo del período
  // (neto cero y el ancla del saldo esperado es el cierre mensual, no el día).
  let pairId: string | undefined;
  if (data.pairWith) {
    const original = await prisma.bankTransaction.findUnique({ where: { id: data.pairWith } });
    if (original) {
      when = original.date; // ← la contraparte se fecha en el día del original
      pairId = original.pairId ?? `pair_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      if (!original.pairId) {
        // Marcar también la(s) fila(s) del original (puede ser mixto con groupId).
        if (original.groupId) await prisma.bankTransaction.updateMany({ where: { groupId: original.groupId }, data: { pairId } });
        else await prisma.bankTransaction.update({ where: { id: original.id }, data: { pairId } });
      }
    }
  }

  const base = {
    type: data.type,
    description: data.description,
    reference: data.reference,
    driverId: data.driverId,
    driverName,
    date: when,
    createdBy: data.createdBy ?? null,
    createdByName: data.createdByName ?? null,
    deviceId: data.deviceId ?? null,
    deviceName: data.deviceName ?? null,
    pairId,
    noCounterpart: data.noCounterpart === true,
  };

  const cash = Math.round(data.cashAmount ?? 0);
  const bank = Math.round(data.bankAmount ?? 0);

  // Movimiento MIXTO: parte efectivo + parte transferencia → dos registros enlazados
  // por un groupId compartido para que la UI los muestre como UN solo movimiento.
  if (cash > 0 && bank > 0) {
    const groupId = `mix_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const [a, b] = await prisma.$transaction([
      prisma.bankTransaction.create({ data: { ...base, medium: "cash", amount: cash, groupId } }),
      prisma.bankTransaction.create({ data: { ...base, medium: "bank", amount: bank, groupId } }),
    ]);
    return { mixed: true, parts: [a, b] };
  }

  // Movimiento simple (un solo medio).
  const medium = data.medium === "cash" ? "cash" : "bank";
  const amount = (cash + bank) || data.amount;
  return prisma.bankTransaction.create({ data: { ...base, medium, amount } });

  });
}

export async function remove(id: string) {
  return moneyTransaction(async () => {
  const original = await prisma.bankTransaction.findUnique({ where: { id } });
  if (!original) return;
  // Si el movimiento pertenece a un turno por hora, delegar al módulo por-hora: borra el
  // turno (egreso = pago al domi) o revierte el cobro (ingreso), y sincroniza la deuda del
  // cliente y los demás movimientos del turno. Así, borrar desde Banco también lo borra de
  // Clientes por hora y de Movimientos (todos leen de bankTransaction).
  if (original.hourlyShiftId) {
    await hourlySvc.deleteHourlyBankTx(id);
    return;
  }
  // Movimiento mixto: hay que revertir/eliminar ambas mitades enlazadas.
  const rows = original.groupId
    ? await prisma.bankTransaction.findMany({ where: { groupId: original.groupId } })
    : [original];

  await prisma.$transaction(async (tx) => {
    for (const row of rows) {
      // Si este movimiento redujo la deuda de un domiciliario, hay que revertir esa
      // deuda y limpiar los registros contables subsidiarios que se crearon junto a
      // él — igual que hace edit-request.service.ts al aprobar una eliminación.
      //
      // La condición es debtApplied != 0 (marca explícita), NO (noCounterpart && type=="ingreso"):
      // esa heurística dejó pasar un egreso aplicado por error a una deuda, y al borrarlo la deuda
      // nunca se restableció. Ver nota en schema.prisma.
      //   debtApplied > 0 → ingreso que descontó deuda (applyBankToDriver/registerPayment).
      //   debtApplied < 0 → egreso que pagó crédito (payCredit). Antes NO se marcaba, así que
      //     borrar el pago-crédito no devolvía el crédito al domiciliario (bug real Juan Sanabria).
      if (row.driverId && row.debtApplied !== 0) {
        // Revertir por POSICIÓN NETA (deuda − crédito): `net + debtApplied` restaura pendingDebt o
        // creditAmount según corresponda, para AMBOS signos, sin dejar crédito/deuda fantasma.
        await applyDebtDelta(tx, row.driverId, row.debtApplied);
        // Registros contables subsidiarios (base pago + driverPayment bank-linked) SOLO existen
        // para pagos-INGRESO (debtApplied > 0). payCredit (debtApplied < 0) no crea ninguno, así
        // que solo se limpian cuando debtApplied > 0 (y así la ventana ±5s no toca nada ajeno).
        // Búsqueda por ID (bankTransactionId), sin ambigüedad; respaldo por ventana de fecha ±5s
        // SOLO para registros viejos sin el enlace directo (bankTransactionId=null).
        if (row.debtApplied > 0) {
          const window = { gte: new Date(row.date.getTime() - 5000), lte: new Date(row.date.getTime() + 5000) };
          await tx.baseTransaction.deleteMany({
            where: {
              driverId: row.driverId,
              type: "pago",
              notes: { startsWith: BANK_LINKED_BASE_PREFIX },
              OR: [{ bankTransactionId: row.id }, { bankTransactionId: null, date: window }],
            },
          });
          await tx.driverPayment.deleteMany({
            where: {
              driverId: row.driverId,
              notes: { startsWith: BANK_LINKED_PAYMENT_NOTE },
              OR: [{ bankTransactionId: row.id }, { bankTransactionId: null, date: window }],
            },
          });
        }
      }
    }
    if (original.groupId) {
      await tx.bankTransaction.deleteMany({ where: { groupId: original.groupId } });
    } else {
      await tx.bankTransaction.delete({ where: { id } });
    }

    // Si lo borrado era una mitad de un par (contraparte), la mitad que sobrevive debe
    // dejar de verse como "cuadrada": se le quita el pairId para que vuelva a marcarse
    // como "falta contraparte". Sin esto quedaría un pairId colgante que la pintaría en
    // verde (cuadrada) sin tener pareja real.
    const pairIds = [...new Set(rows.map((r) => r.pairId).filter((p): p is string => !!p))];
    if (pairIds.length) {
      const deletedIds = rows.map((r) => r.id);
      await tx.bankTransaction.updateMany({
        where: { pairId: { in: pairIds }, id: { notIn: deletedIds } },
        data: { pairId: null },
      });
    }
  });

  });
}

export async function summary(from?: string, to?: string) {
  const dateWhere = bogotaOpenRange(from, to);

  const [ingresosAgg, egresosAgg, count] = await Promise.all([
    prisma.bankTransaction.aggregate({
      where: { type: "ingreso", ...(dateWhere ? { date: dateWhere } : {}) },
      _sum: { amount: true },
    }),
    prisma.bankTransaction.aggregate({
      where: { type: "egreso", ...(dateWhere ? { date: dateWhere } : {}) },
      _sum: { amount: true },
    }),
    prisma.bankTransaction.count({
      where: dateWhere ? { date: dateWhere } : undefined,
    }),
  ]);

  const ingresos = ingresosAgg._sum.amount ?? 0;
  const egresos = egresosAgg._sum.amount ?? 0;
  return { ingresos, egresos, balance: ingresos - egresos, count };
}

/** Corrige el movimiento y TODO su efecto de deuda, en la transacción común. */
export async function edit(id: string, values: { amount?: number; description?: string }) {
  return moneyTransaction(async () => {
  const original = await prisma.bankTransaction.findUnique({where:{id}});
  if (!original) throw badRequest("Movimiento no encontrado");
  if (values.amount == null || values.amount === original.amount) {
    return prisma.bankTransaction.update({where:{id},data:values});
  }
  if (!Number.isSafeInteger(values.amount) || values.amount <= 0) throw badRequest("Monto inválido");
  if (original.hourlyShiftId) throw badRequest("Corrige el turno o revierte su cobro desde Clientes por hora.");
  if (original.pairId || original.groupId) throw badRequest("Revierte el movimiento enlazado y regístralo de nuevo con el importe correcto.");
  if (!original.driverId || !original.debtApplied) return prisma.bankTransaction.update({where:{id},data:values});
  if (original.debtApplied < 0) {
    await applyDebtDelta(prisma, original.driverId, values.amount-original.amount);
    return prisma.bankTransaction.update({where:{id},data:{...values,debtApplied:-values.amount}});
  }
  await applyDebtDelta(prisma,original.driverId,original.debtApplied);
  await prisma.baseTransaction.deleteMany({where:{bankTransactionId:id}});
  await prisma.driverPayment.deleteMany({where:{bankTransactionId:id}});
  await prisma.bankTransaction.update({where:{id},data:{...values,debtApplied:0}});
  await applyBankToDriver(id,original.driverId);
  return prisma.bankTransaction.update({where:{id},data:{description:values.description ?? original.description}});

  });
}
