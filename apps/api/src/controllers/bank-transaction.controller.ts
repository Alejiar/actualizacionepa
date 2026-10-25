import type { Request, Response } from "express";
import * as svc from "../services/bank-transaction.service";
import * as driverSvc from "../services/driver.service";
import { getActor } from "../lib/actor";

export async function list(req: Request, res: Response) {
  const { type, from, to } = req.query as Record<string, string>;
  res.json(await svc.list({ type: type as "ingreso" | "egreso" | undefined, from, to }));
}

export async function create(req: Request, res: Response) {
  const actor = getActor(req);
  res.status(201).json(await svc.create({ ...req.body, createdBy: actor.id, createdByName: actor.name, deviceId: actor.deviceId, deviceName: actor.deviceName }));
}

export async function remove(req: Request, res: Response) {
  await svc.remove(req.params.id);
  res.json({ ok: true });
}

export async function summary(req: Request, res: Response) {
  const { from, to } = req.query as Record<string, string>;
  res.json(await svc.summary(from, to));
}

export async function applyToDriver(req: Request, res: Response) {
  const { driverId, baseAmount } = req.body;
  res.json(await driverSvc.applyBankToDriver(req.params.id, driverId, getActor(req), baseAmount));
}

export async function pairCandidates(req: Request, res: Response) {
  res.json(await svc.pairCandidates(req.params.id));
}

export async function pair(req: Request, res: Response) {
  res.json(await svc.pairExisting(req.params.id, req.body?.withId));
}
