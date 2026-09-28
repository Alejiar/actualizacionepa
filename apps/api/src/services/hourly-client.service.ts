import { prisma, moneyTransaction } from "../lib/prisma";
import { badRequest, notFound } from "../lib/errors";
import { todayBogota } from "../lib/date-range";
import type { Actor } from "../lib/actor";

// ─── Cálculo de tiempo y montos ───────────────────────────────────────────────

/** Minutos entre dos horas "HH:MM". Si la salida es <= entrada se asume que cruzó
 *  medianoche (turno nocturno). Devuelve NaN si el formato es inválido. */
function computeMinutes(start: string, end: string): number {
  const parse = (s: string): number => {
    const m = /^(\d{1,2}):(\d{2})$/.exec((s ?? "").trim());
    if (!m) return NaN;
    const h = Number(m[1]);
    const min = Number(m[2]);
    if (h > 23 || min > 59) return NaN;
    return h * 60 + min;
  };
  const a = parse(start);
  const b = parse(end);
  if (Number.isNaN(a) || Number.isNaN(b)) return NaN;
  let diff = b - a;
  if (diff < 0) diff += 24 * 60; // cruza medianoche
  return diff;
}

/** Reparte el cobro por minutos. El TOTAL se calcula sobre la tarifa combinada (así
 *  coincide con "sumar valor domi + empresa, dividir por 60 y multiplicar por minutos"),
 *  y la parte del domiciliario se saca aparte; la de la empresa es el resto, de modo que
 *  driverAmount + companyAmount === totalAmount SIEMPRE (sin descuadre por redondeo). */
function computeAmounts(rates: { driverHourValue: number; companyHourValue: number }, minutes: number) {
  const totalAmount = Math.round(((rates.driverHourValue + rates.companyHourValue) * minutes) / 60);
  const driverAmount = Math.round((rates.driverHourValue * minutes) / 60);
  const companyAmount = totalAmount - driverAmount;
  return { driverAmount, companyAmount, totalAmount };
}

// ─── Desglose de saldos por cliente ───────────────────────────────────────────

type ShiftForCalc = {
  driverPaid: boolean;
  paid: boolean;
  driverAmount: number;
  totalAmount: number;
  paidAmount: number;
};

/**
 * A partir de los turnos de un cliente calcula los tres números que ve el usuario:
 *  - pendingDriverPay: lo que falta pagarle a domiciliarios (turnos sin pagar aún).
 *  - driverOutstanding / companyOutstanding: desglose de la DEUDA VIVA del cliente
 *    (turnos con el domiciliario ya pagado y el cliente aún sin saldar). El remanente
 *    de cada turno se prorratea entre domiciliario y empresa según su tarifa, de modo
 *    que driverOutstanding + companyOutstanding === deuda pendiente del cliente.
 */
function breakdown(shifts: ShiftForCalc[]) {
  let pendingDriverPay = 0;
  let driverOutstanding = 0;
  let companyOutstanding = 0;
  for (const s of shifts) {
    if (!s.driverPaid) {
      pendingDriverPay += s.driverAmount;
      continue;
    }
    if (s.paid) continue; // deuda de este turno ya saldada por el cliente
    const remaining = s.totalAmount - s.paidAmount;
    if (remaining <= 0) continue;
    const driverPart = s.totalAmount > 0 ? Math.round((s.driverAmount * remaining) / s.totalAmount) : 0;
    driverOutstanding += driverPart;
    companyOutstanding += remaining - driverPart;
  }
  return { pendingDriverPay, driverOutstanding, companyOutstanding };
}

function withBreakdown<T extends { shifts: ShiftForCalc[] }>(client: T) {
  return { ...client, ...breakdown(client.shifts) };
}

// ─── Clientes (empresas/tiendas) ──────────────────────────────────────────────

export async function listHourlyClients(activeOnly = false) {
  const clients = await prisma.hourlyClient.findMany({
    where: activeOnly ? { active: true } : undefined,
    // Solo turnos "vivos" (no saldados por el cliente): incluye los pendientes de pago
    // al domiciliario y los que ya son deuda. El historial saldado se pide en el detalle.
    include: { shifts: { where: { paid: false }, orderBy: [{ driverPaid: "asc" }, { createdAt: "desc" }] } },
    orderBy: { name: "asc" },
  });
  return clients.map(withBreakdown);
}

export async function getHourlyClient(id: string) {
  const client = await prisma.hourlyClient.findUnique({
    where: { id },
    include: { shifts: { orderBy: [{ createdAt: "desc" }] } },
  });
  if (!client) throw notFound("Cliente no encontrado");
  return withBreakdown(client);
}

export async function createHourlyClient(data: { name: string; driverHourValue: number; companyHourValue: number }) {
  const name = (data.name ?? "").trim();
  if (!name) throw badRequest("El nombre del cliente es obligatorio");
  const driverHourValue = Math.round(data.driverHourValue ?? 0);
  const companyHourValue = Math.round(data.companyHourValue ?? 0);
  if (driverHourValue < 0 || companyHourValue < 0) throw badRequest("Los valores por hora no pueden ser negativos");
  if (driverHourValue + companyHourValue <= 0) throw badRequest("Define al menos un valor por hora mayor a 0");
  return prisma.hourlyClient.create({ data: { name, driverHourValue, companyHourValue } });
}

export async function updateHourlyClient(
  id: string,
  data: Partial<{ name: string; driverHourValue: number; companyHourValue: number; active: boolean }>,
) {
  return prisma.hourlyClient.update({
    where: { id },
    data: {
      ...(typeof data.name === "string" ? { name: data.name.trim() } : {}),
      ...(data.driverHourValue != null ? { driverHourValue: Math.round(data.driverHourValue) } : {}),
      ...(data.companyHourValue != null ? { companyHourValue: Math.round(data.companyHourValue) } : {}),
      ...(typeof data.active === "boolean" ? { active: data.active } : {}),
    },
  });
}

export async function deleteHourlyClient(id: string) {
  // Los turnos caen por Cascade. Los BankTransaction de pagos/cobros ya ocurridos se
  // dejan intactos a propósito: son dinero REAL que se movió y debe seguir en el ledger
  // de caja/banco; solo desaparece el registro informativo de la deuda.
  await prisma.hourlyClient.delete({ where: { id } });
}

// ─── Turnos ───────────────────────────────────────────────────────────────────

/**
 * Registra un turno y, EN UN SOLO PASO, paga al domiciliario y genera la deuda del cliente:
 *  - crea el turno ya marcado como pagado al domiciliario (driverPaid),
 *  - registra el EGRESO real (efectivo o transferencia según `medium`) por driverAmount,
 *  - suma el total del turno a la deuda del cliente.
 * Todo en una transacción (caja y deuda no pueden quedar desincronizados). Antes esto eran
 * dos pasos (registrar + "Pagar al domiciliario"); el dueño pidió unificarlos.
 */
export async function registerShift(
  clientId: string,
  input: { driverId?: string; startTime: string; endTime: string; date?: string; medium: "cash" | "bank"; actor?: Actor },
) {
  return moneyTransaction(async () => {
  const client = await prisma.hourlyClient.findUnique({ where: { id: clientId } });
  if (!client) throw notFound("Cliente no encontrado");
  if (!input.driverId) throw badRequest("Selecciona un domiciliario");
  const driver = await prisma.driver.findUnique({ where: { id: input.driverId } });
  if (!driver) throw badRequest("Domiciliario no encontrado");

  const minutes = computeMinutes(input.startTime, input.endTime);
  if (!Number.isFinite(minutes)) throw badRequest("Horas inválidas. Usa el formato HH:MM (24h)");
  if (minutes <= 0) throw badRequest("La hora de salida debe ser posterior a la de entrada");

  const { driverAmount, companyAmount, totalAmount } = computeAmounts(client, minutes);
  const medium = input.medium === "bank" ? "bank" : "cash";
  const actorId = input.actor?.id ?? null;
  const actorName = input.actor?.name ?? null;
  const deviceId = input.actor?.deviceId ?? null;
  const deviceName = input.actor?.deviceName ?? null;

  return prisma.$transaction(async (tx) => {
    const shift = await tx.hourlyShift.create({
      data: {
        hourlyClientId: clientId,
        driverId: driver.id,
        driverName: driver.name,
        date: input.date || todayBogota(),
        startTime: input.startTime.trim(),
        endTime: input.endTime.trim(),
        minutes,
        driverAmount,
        companyAmount,
        totalAmount,
        driverPaid: true,
        driverPaidMedium: medium,
        driverPaidAt: new Date(),
        driverPaidBy: actorId,
        driverPaidByName: actorName,
        createdBy: actorId,
        createdByName: actorName,
      },
    });

    // Egreso real del pago al domiciliario (solo si hay valor para el domiciliario), enlazado
    // por hourlyShiftId para que el borrado del turno lo limpie solo.
    if (driverAmount > 0) {
      const bankTx = await tx.bankTransaction.create({
        data: {
          type: "egreso",
          medium,
          amount: driverAmount,
          description: `Pago domiciliario por hora — ${driver.name} (${client.name})`,
          hourlyShiftId: shift.id,
          noCounterpart: true,
          createdBy: actorId,
          createdByName: actorName,
          deviceId,
          deviceName,
          date: new Date(),
        },
      });
      await tx.hourlyShift.update({ where: { id: shift.id }, data: { driverPaidBankTxId: bankTx.id } });
    }

    // El total del turno entra a la deuda del cliente.
    await tx.hourlyClient.update({
      where: { id: clientId },
      data: { pendingDebt: { increment: totalAmount } },
    });

    return shift;
  });

  });
}

/**
 * Paga al domiciliario por un turno. Movimiento REAL de dinero: registra un
 * BankTransaction EGRESO (efectivo o banco), que es lo que baja el saldo esperado.
 * Recién en este momento el total del turno entra a la deuda del cliente. Todo va en
 * una sola transacción para que caja y deuda no puedan quedar desincronizados.
 */
export async function payDriver(shiftId: string, input: { medium: "cash" | "bank"; actor?: Actor }) {
  return moneyTransaction(async () => {
  const shift = await prisma.hourlyShift.findUnique({ where: { id: shiftId }, include: { hourlyClient: true } });
  if (!shift) throw notFound("Turno no encontrado");
  if (shift.driverPaid) throw badRequest("A este domiciliario ya se le pagó este turno");
  if (shift.driverAmount <= 0) throw badRequest("El turno no tiene valor para el domiciliario");
  const medium = input.medium === "bank" ? "bank" : "cash";

  await prisma.$transaction(async (tx) => {
    const bankTx = await tx.bankTransaction.create({
      data: {
        type: "egreso",
        medium,
        amount: shift.driverAmount,
        description: `Pago domiciliario por hora — ${shift.driverName} (${shift.hourlyClient.name})`,
        hourlyShiftId: shift.id,
        noCounterpart: true,
        createdBy: input.actor?.id ?? null,
        createdByName: input.actor?.name ?? null,
        date: new Date(),
      },
    });
    await tx.hourlyShift.update({
      where: { id: shiftId },
      data: {
        driverPaid: true,
        driverPaidMedium: medium,
        driverPaidAt: new Date(),
        driverPaidBankTxId: bankTx.id,
        driverPaidBy: input.actor?.id ?? null,
        driverPaidByName: input.actor?.name ?? null,
      },
    });
    await tx.hourlyClient.update({
      where: { id: shift.hourlyClientId },
      data: { pendingDebt: { increment: shift.totalAmount } },
    });
  });

  return { ok: true };

  });
}

/**
 * Cobro (abono o pago total) de la deuda del cliente. Movimiento REAL: registra un
 * BankTransaction INGRESO (efectivo o banco), que sube el saldo esperado, y aplica el
 * monto FIFO sobre los turnos que ya son deuda (domiciliario pagado, cliente sin saldar).
 */
export async function payClient(
  clientId: string,
  input: { amount?: number; payAll?: boolean; medium: "cash" | "bank"; actor?: Actor },
) {
  return moneyTransaction(async () => {
  const client = await prisma.hourlyClient.findUnique({ where: { id: clientId } });
  if (!client) throw notFound("Cliente no encontrado");
  const totalPending = client.pendingDebt;
  if (totalPending <= 0) throw badRequest("El cliente no tiene deuda pendiente");

  const medium = input.medium === "bank" ? "bank" : "cash";
  const requested = input.payAll ? totalPending : Math.round(input.amount ?? 0);
  const applied = Math.min(requested, totalPending);
  if (applied <= 0) throw badRequest("El monto del abono debe ser mayor a 0");

  return prisma.$transaction(async (tx) => {
    const shifts = await tx.hourlyShift.findMany({
      where: { hourlyClientId: clientId, driverPaid: true, paid: false },
      orderBy: { createdAt: "asc" },
    });
    let left = applied;
    for (const s of shifts) {
      if (left <= 0) break;
      const remaining = s.totalAmount - s.paidAmount;
      const apply = Math.min(left, remaining);
      const newPaid = s.paidAmount + apply;
      // Un ingreso POR TURNO, enlazado por hourlyShiftId. Antes era un solo ingreso lump
      // imposible de revertir por turno: al borrar un turno cobrado quedaba el cobro + un
      // egreso de compensación (dos movimientos colgados). Así el borrado queda limpio.
      await tx.bankTransaction.create({
        data: {
          type: "ingreso",
          medium,
          amount: apply,
          description: `Cobro cliente por hora — ${client.name}`,
          hourlyShiftId: s.id,
          noCounterpart: true,
          createdBy: input.actor?.id ?? null,
          createdByName: input.actor?.name ?? null,
          deviceId: input.actor?.deviceId ?? null,
          deviceName: input.actor?.deviceName ?? null,
          date: new Date(),
        },
      });
      await tx.hourlyShift.update({
        where: { id: s.id },
        data: {
          paidAmount: newPaid,
          paid: newPaid >= s.totalAmount,
          paidAt: new Date(),
          // Medio del cobro por turno (registro; el saldo lo lleva el BankTransaction de arriba).
          ...(medium === "cash" ? { paidCash: { increment: apply } } : { paidBank: { increment: apply } }),
          paidBy: input.actor?.id ?? null,
          paidByName: input.actor?.name ?? null,
        },
      });
      left -= apply;
    }

    await tx.hourlyClient.update({
      where: { id: clientId },
      data: { pendingDebt: { decrement: applied } },
    });

    return { applied, remaining: totalPending - applied };
  });

  });
}

/**
 * Edita un turno (admin directo, o vía solicitud aprobada). Permite cambiar domiciliario,
 * fecha y horas; recalcula los montos con la tarifa ACTUAL del cliente. Ajusta el dinero:
 *  - Si ya se pagó al domiciliario, corrige ese egreso a la nueva cifra y ajusta la deuda
 *    del cliente por la diferencia del total (que aún no ha cobrado).
 *  - Se BLOQUEA si el cliente ya cobró (parcial o total) algo de este turno (`paidAmount` > 0):
 *    en ese caso hay que eliminarlo y crearlo de nuevo (el borrado revierte todo limpio,
 *    incluidos los cobros). Cambiar montos ya cobrados desincronizaría los cobros del cliente.
 */
export async function editShift(
  shiftId: string,
  input: { driverId?: string; startTime?: string; endTime?: string; date?: string },
) {
  return moneyTransaction(async () => {
  const shift = await prisma.hourlyShift.findUnique({ where: { id: shiftId }, include: { hourlyClient: true } });
  if (!shift) throw notFound("Turno no encontrado");
  if (shift.paidAmount > 0) {
    throw badRequest("Este turno ya tiene cobros del cliente. Para cambiarlo, elimínalo y créalo de nuevo.");
  }

  let driverId = shift.driverId;
  let driverName = shift.driverName;
  if (input.driverId && input.driverId !== shift.driverId) {
    const drv = await prisma.driver.findUnique({ where: { id: input.driverId } });
    if (!drv) throw badRequest("Domiciliario no encontrado");
    driverId = drv.id;
    driverName = drv.name;
  }
  const startTime = (input.startTime ?? shift.startTime).trim();
  const endTime = (input.endTime ?? shift.endTime).trim();
  const date = input.date ?? shift.date;

  const minutes = computeMinutes(startTime, endTime);
  if (!Number.isFinite(minutes)) throw badRequest("Horas inválidas. Usa el formato HH:MM (24h)");
  if (minutes <= 0) throw badRequest("La hora de salida debe ser posterior a la de entrada");

  const { driverAmount, companyAmount, totalAmount } = computeAmounts(shift.hourlyClient, minutes);
  const deltaTotal = totalAmount - shift.totalAmount;

  await prisma.$transaction(async (tx) => {
    await tx.hourlyShift.update({
      where: { id: shiftId },
      data: { driverId, driverName, date, startTime, endTime, minutes, driverAmount, companyAmount, totalAmount },
    });

    if (shift.driverPaid) {
      // Corregir el egreso del pago al domiciliario a la nueva cifra + descripción.
      if (shift.driverPaidBankTxId) {
        await tx.bankTransaction.update({
          where: { id: shift.driverPaidBankTxId },
          data: {
            amount: driverAmount,
            description: `Pago domiciliario por hora — ${driverName} (${shift.hourlyClient.name})`,
          },
        });
      }
      // Ajustar la deuda del cliente por la diferencia del total (aún no cobrada).
      if (deltaTotal !== 0) {
        const client = await tx.hourlyClient.findUnique({ where: { id: shift.hourlyClientId } });
        if (client) {
          const newDebt = client.pendingDebt + deltaTotal;
          await tx.hourlyClient.update({
            where: { id: shift.hourlyClientId },
            data: { pendingDebt: newDebt > 0 ? newDebt : 0 },
          });
        }
      }
    }
  });

  return { ok: true };

  });
}

/**
 * Elimina un turno. Borra TODA su huella bancaria de una sola vez (el egreso del pago al
 * domiciliario y los ingresos de cobro del cliente, todos enlazados por `hourlyShiftId`) —
 * así el dinero vuelve neto a como si el turno nunca hubiera existido y NO quedan movimientos
 * colgados en Banco/Movimientos. Además baja de la deuda del cliente la parte aún no cobrada.
 *
 * Correctitud del dinero: borrar el egreso del domi devuelve `driverAmount`; borrar los
 * ingresos de cobro quita lo cobrado; el neto de esos dos es −ganancia (deshace la utilidad
 * del turno) y la deuda pendiente restante se descuenta aparte. Todo cuadra a cero.
 */
export async function deleteShift(shiftId: string) {
  return moneyTransaction(async () => {
  const shift = await prisma.hourlyShift.findUnique({ where: { id: shiftId } });
  if (!shift) return;

  await prisma.$transaction(async (tx) => {
    // Toda la huella bancaria del turno (pago al domi + cobros del cliente) en una sola
    // operación. No-op si el turno nunca movió dinero (pendiente de pago al domiciliario).
    await tx.bankTransaction.deleteMany({ where: { hourlyShiftId: shiftId } });

    if (shift.driverPaid) {
      // Bajar de la deuda del cliente SOLO la parte aún no cobrada (lo cobrado ya se quitó
      // al borrar sus ingresos arriba).
      const stillOwed = shift.totalAmount - shift.paidAmount;
      if (stillOwed > 0) {
        const client = await tx.hourlyClient.findUnique({ where: { id: shift.hourlyClientId } });
        if (client) {
          const newDebt = client.pendingDebt - stillOwed;
          await tx.hourlyClient.update({
            where: { id: shift.hourlyClientId },
            data: { pendingDebt: newDebt > 0 ? newDebt : 0 },
          });
        }
      }
    }
    await tx.hourlyShift.delete({ where: { id: shiftId } });
  });

  });
}

/**
 * Sincroniza el lado "Clientes por hora" cuando se ELIMINA un BankTransaction suyo desde
 * Banco o Movimientos (o vía solicitud aprobada). Es la contraparte de `deleteShift` (que
 * va del turno hacia el banco); esta va del banco hacia el turno. Según el tipo:
 *  - EGRESO (pago al domiciliario): borra el TURNO completo (deleteShift → borra este y los
 *    demás movimientos del turno y revierte la deuda del cliente).
 *  - INGRESO (cobro del cliente): revierte SOLO ese cobro — borra el movimiento, baja el
 *    abonado del turno y vuelve a subir la deuda del cliente por ese monto.
 * Si el turno ya no existe (movimiento huérfano), solo borra el movimiento.
 * Devuelve true si se encargó del borrado (el llamador NO debe volver a borrar el movimiento).
 */
export async function deleteHourlyBankTx(bankTxId: string): Promise<boolean> {
  return moneyTransaction(async () => {
  const tx = await prisma.bankTransaction.findUnique({ where: { id: bankTxId } });
  if (!tx || !tx.hourlyShiftId) return false;

  const shift = await prisma.hourlyShift.findUnique({ where: { id: tx.hourlyShiftId } });
  if (!shift) {
    await prisma.bankTransaction.deleteMany({ where: { id: bankTxId } });
    return true;
  }

  if (tx.type === "egreso") {
    // Pago al domiciliario → el turno completo se va (cascada a sus movimientos + deuda).
    await deleteShift(shift.id);
  } else {
    // Cobro del cliente → revertir SOLO ese cobro: la deuda del cliente vuelve a subir.
    await prisma.$transaction(async (txx) => {
      await txx.bankTransaction.deleteMany({ where: { id: bankTxId } });
      const newPaid = Math.max(0, shift.paidAmount - tx.amount);
      const newCash = tx.medium === "cash" ? Math.max(0, shift.paidCash - tx.amount) : shift.paidCash;
      const newBank = tx.medium === "bank" ? Math.max(0, shift.paidBank - tx.amount) : shift.paidBank;
      await txx.hourlyShift.update({
        where: { id: shift.id },
        data: { paidAmount: newPaid, paid: false, paidCash: newCash, paidBank: newBank },
      });
      await txx.hourlyClient.update({
        where: { id: shift.hourlyClientId },
        data: { pendingDebt: { increment: tx.amount } },
      });
    });
  }
  return true;

  });
}

/** Historial global: TODOS los turnos (de todos los clientes), con el nombre del cliente,
 *  más recientes primero. Incluye quién creó, quién pagó al domiciliario y quién cobró. */
export async function listAllShifts(limit = 1000) {
  return prisma.hourlyShift.findMany({
    include: { hourlyClient: { select: { id: true, name: true } } },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
}
