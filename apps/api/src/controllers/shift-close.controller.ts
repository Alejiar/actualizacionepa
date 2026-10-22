import type { Request, Response } from "express";
import * as svc from "../services/shift-close.service";
import { getExpectedBalancesForDate } from "../services/shipday-dashboard.service";
import { getActor } from "../lib/actor";
import { badRequest } from "../lib/errors";
import { moneyTransaction } from "../lib/prisma";
import { assertMoney, MAX_MONEY } from "../lib/money-validation";

// INC-01 (auditoría final, 22-oct-2026): el conteo se valida en el servidor con las mismas
// denominaciones y límites del asistente (ShiftCloseWizard.tsx). Antes aceptaba cantidades
// negativas o billetes inexistentes y se podía registrar un Cierre "cuadrado" sin la plata.
const BILLS = [100000, 50000, 20000, 10000, 5000, 2000, 1000];
const COINS = [1000, 500, 200, 100, 50];
function assertDenominations(d: unknown) {
  const o = d as { bills?: unknown; coins?: unknown } | null;
  if (!o || typeof o !== "object" || !Array.isArray(o.bills) || !Array.isArray(o.coins)) throw badRequest("Conteo de efectivo inválido.");
  let total = 0;
  for (const [list, allowed, label] of [[o.bills, BILLS, "billete"], [o.coins, COINS, "moneda"]] as const) {
    for (const line of list as { value?: unknown; qty?: unknown }[]) {
      if (!line || !allowed.includes(line.value as number)) throw badRequest(`Conteo de efectivo inválido: ${label} de ${String(line?.value)} no existe.`);
      if (typeof line.qty !== "number" || !Number.isSafeInteger(line.qty) || line.qty < 0) throw badRequest(`Conteo de efectivo inválido: la cantidad de ${label}s de ${line.value} debe ser un entero mayor o igual a 0.`);
      total += (line.value as number) * line.qty;
    }
  }
  if (total > MAX_MONEY) throw badRequest("Conteo de efectivo inválido: el total supera el máximo permitido.");
}

export async function getForDate(req: Request, res: Response) {
  res.json(await svc.getShiftsForDate(req.params.date));
}

/** Día operativo actual (no se salta al siguiente hasta que se registre el Cierre). */
export async function currentDate(req: Request, res: Response) {
  res.json({ date: await svc.getCurrentOperatingDate() });
}

/** #6 — efectivo y banco esperados calculados automáticamente para la fecha. */
export async function expectedForDate(req: Request, res: Response) {
  const { cash, bank } = await getExpectedBalancesForDate(req.params.date);
  res.json({ date: req.params.date, expectedCash: cash, expectedBank: bank });
}

export async function register(req: Request, res: Response) {
  const actor = getActor(req);
  const date: string = req.body.date;

  // El monto esperado lo decide el SERVIDOR (no el cliente) para que ningún
  // trabajador pueda alterarlo. SIEMPRE es el efectivo ESPERADO EN VIVO de la
  // fecha = apertura + TODOS los movimientos de efectivo confirmados hasta el
  // momento (bases, pagos, gastos, conversiones…). Es el "valor oficial" de la
  // caja en ese instante, igual para AM, PM y cierre.
  //
  // Antes el PM se comparaba contra lo CONTADO en la mañana (un valor estático),
  // ignorando los movimientos de efectivo de la tarde y mostrando un descuadre
  // falso igual a esos movimientos (p. ej. −$179.000 por bases entregadas después
  // del cierre AM, aunque la caja estuviera perfecta).
  // El banco contado es OBLIGATORIO en todo cierre: puede ser 0, pero no vacío. Se valida
  // antes de entrar a la caja (no requiere leer saldos).
  const rawBank = req.body.bankCounted;
  if (rawBank == null || rawBank === "" || Number.isNaN(Number(rawBank))) {
    throw badRequest("Debe ingresar el valor del banco para continuar con el cierre.");
  }
  const bankCounted = Number(rawBank);
  assertMoney(bankCounted, true);
  assertDenominations(req.body.denominations);

  // Esperado + registro en UNA operación serializada (F04): se toma el candado financiero,
  // se calcula el esperado con la vista ya consistente y se guarda el cierre en la misma
  // transacción. Antes el esperado se leía FUERA del candado y un movimiento que entraba
  // mientras el cierre esperaba quedaba fuera del esperado guardado (diferencia falsa).
  const shift = await moneyTransaction(async () => {
    const expected = await getExpectedBalancesForDate(date);
    return svc.registerShift({
      ...req.body,
      expectedAmount: expected.cash,
      bankCounted,
      bankExpected: expected.bank,
      createdBy: actor.id,
      createdByName: actor.name,
    });
  });
  res.status(201).json(shift);
}

export async function list(req: Request, res: Response) {
  const { from, to } = req.query as Record<string, string>;
  res.json(await svc.listShifts(from, to));
}

export async function remove(req: Request, res: Response) {
  res.json(await svc.deleteShift(req.params.id));
}
