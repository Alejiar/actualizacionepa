import type { Request, Response } from "express";
import * as movementService from "../services/movement.service";
import { getActor } from "../lib/actor";

export async function list(req: Request, res: Response) {
  const date = typeof req.query.date === "string" ? req.query.date : undefined;
  res.json(await movementService.listMovements(date));
}

export async function create(req: Request, res: Response) {
  const actor = getActor(req);
  const expense = req.body.category === 3 || req.body.category === 4;
  res.status(201).json(await movementService.addMovement({ ...req.body, status: expense && req.user?.role !== "admin" ? "pending" : (req.body.status ?? "confirmed"), createdBy: actor.id, createdByName: actor.name, deviceId: actor.deviceId, deviceName: actor.deviceName }));
}

export async function update(req: Request, res: Response) {
  res.json(await movementService.updateMovement(req.params.id, req.body, req.user?.role === "admin"));
}

export async function remove(req: Request, res: Response) {
  await movementService.deleteMovement(req.params.id);
  res.status(204).end();
}

export async function pending(_req: Request, res: Response) {
  res.json(await movementService.listPendingMovements());
}

export async function approve(req: Request, res: Response) {
  res.json(await movementService.approveMovement(req.params.id, req.user!.sub, req.user!.name ?? null));
}

export async function reject(req: Request, res: Response) {
  res.json(await movementService.rejectMovement(req.params.id));
}
