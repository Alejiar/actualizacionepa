import { applyDebtDelta, applyBankToDriver, revertDriverApplication } from "./driver.service";
import { prisma, moneyTransaction } from "../lib/prisma";
import { bogotaOpenRange, toBogotaDateStr } from "../lib/date-range";
import { badRequest, conflict, notFound } from "../lib/errors";
import { assertOpenInstant, financialNow, isOpenPeriod, operatingClock, parseFinancialTimestamp } from "../lib/period-guard";
import { assertMoney } from "../lib/money-validation";
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
  // ── Contrato de entrada (F07): el medio NUNCA se asume por defecto. ─────────────────
  if (data.type !== "ingreso" && data.type !== "egreso") throw badRequest("Tipo inválido (ingreso o egreso).");
  if (data.medium != null && data.medium !== "cash" && data.medium !== "bank") throw badRequest("Medio inválido (cash o bank).");
  const hasSplit = data.cashAmount != null || data.bankAmount != null;
  let cash = 0, bank = 0;
  if (hasSplit) {
    if (data.cashAmount != null) assertMoney(data.cashAmount, true);
    if (data.bankAmount != null) assertMoney(data.bankAmount, true);
    cash = data.cashAmount ?? 0;
    bank = data.bankAmount ?? 0;
    assertMoney(cash + bank);
    if (data.amount != null && data.amount !== cash + bank) {
      throw badRequest("El total no coincide con la suma de efectivo y transferencia.");
    }
    // Split de una sola parte: el medio lo dicta el split; un `medium` contradictorio se rechaza.
    if (cash > 0 && bank === 0 && data.medium === "bank") throw badRequest("Contradicción: el desglose es solo efectivo pero el medio indicado es banco.");
    if (bank > 0 && cash === 0 && data.medium === "cash") throw badRequest("Contradicción: el desglose es solo transferencia pero el medio indicado es efectivo.");
  } else {
    assertMoney(data.amount);
    if (data.medium !== "cash" && data.medium !== "bank") throw badRequest("Indica el medio (cash o bank) o el desglose efectivo/transferencia.");
    if (data.medium === "cash") cash = data.amount; else bank = data.amount;
  }
  if (data.pairWith && data.noCounterpart === true) throw badRequest("Un movimiento no puede ser contraparte y a la vez 'sin contraparte'.");

  let driverName: string | undefined;
  if (data.driverId) {
    const driver = await prisma.driver.findUnique({ where: { id: data.driverId } });
    if (!driver) throw notFound("Domiciliario no encontrado");
    driverName = driver.name;
  }
  // La fecha solicitada se valida sin normalización ni sustitución silenciosa.
  const now = await financialNow();
  // NEW02/AIF09: sin fecha, o con la fecha del día operativo, el dinero cuenta en el día operativo
  // (la caja abierta), aunque el calendario vaya por delante o por detrás.
  const op = await operatingClock();
  let when = data.date !== undefined ? parseFinancialTimestamp(data.date, now, undefined, op) : op.at;

  // ── Contraparte (F01): un pairId solo se asigna a un par que REALMENTE cuadra. ────────
  // Original existente, sin pareja previa, de signo opuesto, mismo importe total (suma del
  // grupo si es mixto), sin efecto sobre deudas ni turnos y no marcado "sin contraparte".
  // Las contrapartes parciales no están definidas por el negocio: se rechazan.
  let pairId: string | undefined;
  if (data.pairWith) {
    const original = await prisma.bankTransaction.findUnique({ where: { id: data.pairWith } });
    if (!original) throw notFound("El movimiento original de la contraparte no existe.");
    const group = original.groupId
      ? await prisma.bankTransaction.findMany({ where: { groupId: original.groupId } })
      : [original];
    if (group.some(r => r.pairId)) throw conflict("El movimiento original ya tiene contraparte.");
    if (group.some(r => r.noCounterpart || r.debtApplied !== 0 || r.hourlyShiftId)) {
      throw badRequest("El movimiento original no admite contraparte (está marcado sin contraparte o aplicado a una deuda/turno).");
    }
    if (original.type === data.type) throw badRequest("La contraparte debe ser del signo opuesto (ingreso ↔ salida).");
    const originalTotal = group.reduce((t, r) => t + r.amount, 0);
    if (originalTotal !== cash + bank) {
      throw badRequest(`La contraparte debe ser por el mismo importe del original (${originalTotal}). Las contrapartes parciales no están definidas.`);
    }
    // La contraparte se fecha en el día del original para que el par cuadre en su día, salvo
    // que ese día ya esté cerrado: entonces cuenta hoy (no altera un día cerrado).
    const originalDay = toBogotaDateStr(original.date);
    when = (await isOpenPeriod(originalDay, original.date)) ? original.date : op.at;
    await assertOpenInstant(when);
    pairId = `pair_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    await prisma.bankTransaction.updateMany({ where: { id: { in: group.map(r => r.id) } }, data: { pairId } });
  }

  await assertOpenInstant(when);

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

  // Movimiento simple: el medio sale del desglose validado arriba (nunca un "bank" por defecto).
  const medium = cash > 0 ? "cash" : "bank";
  return prisma.bankTransaction.create({ data: { ...base, medium, amount: cash + bank } });

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

  // El borrado también rompe la conciliación de la mitad superviviente: ambas
  // fechas deben estar abiertas, aunque la fila que se borra pertenezca a hoy.
  const paired = rows.some(r => r.pairId) ? await prisma.bankTransaction.findMany({
    where: { pairId: { in: rows.flatMap(r => r.pairId ? [r.pairId] : []) } },
  }) : [];
  for (const row of [...rows, ...paired]) await assertOpenInstant(row.date);

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
        // F14: `debtApplied` es el TOTAL aplicado (comisión + base). La parte de base vuelve al
        // libro de base al borrar sus BaseTransaction enlazadas (abajo); a la cuenta de
        // comisiones solo se le revierte `debtApplied − base enlazada`, para AMBOS signos.
        const linkWindow = { gte: new Date(row.date.getTime() - 5000), lte: new Date(row.date.getTime() + 5000) };
        const linkedBase = row.debtApplied > 0 ? (await tx.baseTransaction.aggregate({
          where: { driverId: row.driverId, type: "pago", notes: { startsWith: BANK_LINKED_BASE_PREFIX }, OR: [{ bankTransactionId: row.id }, { bankTransactionId: null, date: linkWindow }] },
          _sum: { amount: true },
        }))._sum.amount ?? 0 : 0;
        await applyDebtDelta(tx, row.driverId, row.debtApplied - linkedBase);
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
  await assertOpenInstant(original.date);
  if (!Number.isSafeInteger(values.amount) || values.amount <= 0) throw badRequest("Monto inválido");
  if (original.hourlyShiftId) throw badRequest("Corrige el turno o revierte su cobro desde Clientes por hora.");
  if (original.pairId || original.groupId) throw badRequest("Revierte el movimiento enlazado y regístralo de nuevo con el importe correcto.");
  if (!original.driverId || !original.debtApplied) return prisma.bankTransaction.update({where:{id},data:values});
  if (original.debtApplied < 0) {
    await applyDebtDelta(prisma, original.driverId, values.amount-original.amount);
    return prisma.bankTransaction.update({where:{id},data:{...values,debtApplied:-values.amount}});
  }
  // Conservar el reparto que eligió el operador: la parte de base se mantiene (si cabe en el
  // nuevo importe) y el resto va a comisión.
  const previousBase = (await prisma.baseTransaction.aggregate({ where: { bankTransactionId: id }, _sum: { amount: true } }))._sum.amount ?? 0;
  // Quien aplicó originalmente el ingreso a la deuda: los registros derivados se recrean a su
  // nombre (antes quedaban sin autor ni equipo).
  const derived = (await prisma.driverPayment.findFirst({ where: { bankTransactionId: id }, select: { createdBy: true, createdByName: true, deviceId: true, deviceName: true } }))
    ?? (await prisma.baseTransaction.findFirst({ where: { bankTransactionId: id }, select: { createdBy: true, createdByName: true, deviceId: true, deviceName: true } }));
  const actor = derived
    ? { id: derived.createdBy, name: derived.createdByName, deviceId: derived.deviceId, deviceName: derived.deviceName }
    : { id: original.createdBy, name: original.createdByName, deviceId: original.deviceId, deviceName: original.deviceName };
  await revertDriverApplication(prisma, original);
  await prisma.baseTransaction.deleteMany({where:{bankTransactionId:id}});
  await prisma.driverPayment.deleteMany({where:{bankTransactionId:id}});
  // applyBankToDriver agrega la leyenda "· Aplicado a …" con el reparto NUEVO. Antes se
  // restauraba luego la descripción original, que conservaba la leyenda del importe anterior
  // ("comisión $999" junto a +$998, AIF16). Se parte del texto sin la leyenda.
  const text = values.description ?? original.description;
  const marker = text.indexOf(" · Aplicado a ");
  const plain = marker >= 0 ? text.slice(0, marker) : text;
  await prisma.bankTransaction.update({where:{id},data:{...values,description:plain,debtApplied:0}});
  await applyBankToDriver(id,original.driverId,actor,Math.min(previousBase,values.amount));
  return prisma.bankTransaction.findUniqueOrThrow({where:{id}});

  });
}
