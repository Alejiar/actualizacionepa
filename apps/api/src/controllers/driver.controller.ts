import type { Request, Response } from "express";
import * as svc from "../services/driver.service";
import { getActor } from "../lib/actor";

export async function list(req: Request, res: Response) {
  const branchId = req.query.branchId as string | undefined;
  res.json(await svc.listDrivers(branchId));
}

export async function detail(req: Request, res: Response) {
  res.json(await svc.getDriverDetail(req.params.id));
}

export async function statement(req: Request, res: Response) {
  res.json(await svc.getDriverStatement(req.params.id));
}

export async function registerPayment(req: Request, res: Response) {
  // F14: `baseAmount` = parte del pago que el operador asigna a devolver base (el resto, comisión).
  const { amount, medium, notes, baseAmount } = req.body;
  res.status(201).json(await svc.registerPayment(req.params.id, Number(amount), medium, notes, getActor(req), baseAmount));
}

export async function payCredit(req: Request, res: Response) {
  const { medium } = req.body;
  res.json(await svc.payCredit(req.params.id, medium, getActor(req)));
}

export async function ordersToday(req: Request, res: Response) {
  const branchId = (req.query.branchId as string | undefined) || undefined;
  const date = (req.query.date as string | undefined) || undefined;
  res.json(await svc.getOrdersToday(branchId, date));
}
