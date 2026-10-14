import type { Request, Response } from "express";
import * as svc from "../services/hourly-client.service";
import { getActor } from "../lib/actor";

export async function list(req: Request, res: Response) {
  const active = req.query.active === "true";
  res.json(await svc.listHourlyClients(active));
}

export async function get(req: Request, res: Response) {
  res.json(await svc.getHourlyClient(req.params.id));
}

export async function create(req: Request, res: Response) {
  res.status(201).json(await svc.createHourlyClient(req.body));
}

export async function update(req: Request, res: Response) {
  res.json(await svc.updateHourlyClient(req.params.id, req.body));
}

export async function remove(req: Request, res: Response) {
  await svc.deleteHourlyClient(req.params.id);
  res.json({ ok: true });
}

export async function registerShift(req: Request, res: Response) {
  const { driverId, startTime, endTime, date, medium } = req.body;
  res.status(201).json(
    await svc.registerShift(req.params.id, {
      driverId, startTime, endTime, date,
      medium,
      actor: getActor(req),
    }),
  );
}

export async function payClient(req: Request, res: Response) {
  const { amount, payAll, medium } = req.body;
  res.json(
    await svc.payClient(req.params.id, {
      amount,
      payAll: payAll === true,
      medium,
      actor: getActor(req),
    }),
  );
}

export async function payDriver(req: Request, res: Response) {
  const { medium } = req.body;
  res.json(
    await svc.payDriver(req.params.id, { medium, actor: getActor(req) }),
  );
}

export async function editShift(req: Request, res: Response) {
  const { driverId, startTime, endTime, date } = req.body;
  res.json(await svc.editShift(req.params.id, { driverId, startTime, endTime, date }));
}

export async function removeShift(req: Request, res: Response) {
  await svc.deleteShift(req.params.id);
  res.json({ ok: true });
}

export async function history(_req: Request, res: Response) {
  res.json(await svc.listAllShifts());
}
