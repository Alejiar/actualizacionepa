import type { Request, Response } from "express";
import { getActor } from "../lib/actor";
import * as svc from "../services/device.service";

// Estado del propio equipo (lo consulta el frontend para su "gate"). Registra el PC si es nuevo.
export async function me(req: Request, res: Response) {
  res.json(await svc.getMyDevice(req));
}

// ─── Administración (solo admin) ───────────────────────────────────────────────

export async function list(_req: Request, res: Response) {
  res.json(await svc.listDevices());
}

export async function countPending(_req: Request, res: Response) {
  res.json(await svc.countPending());
}

export async function activity(req: Request, res: Response) {
  const deviceId = typeof req.query.deviceId === "string" ? req.query.deviceId : undefined;
  const limit = req.query.limit ? Number(req.query.limit) : undefined;
  res.json(await svc.getActivity({ deviceId, limit }));
}

export async function approve(req: Request, res: Response) {
  const { name } = req.body ?? {};
  res.json(await svc.approveDevice(req.params.id, name, getActor(req)));
}

export async function rename(req: Request, res: Response) {
  const { name } = req.body ?? {};
  res.json(await svc.renameDevice(req.params.id, name));
}

export async function block(req: Request, res: Response) {
  res.json(await svc.blockDevice(req.params.id));
}

export async function unblock(req: Request, res: Response) {
  res.json(await svc.unblockDevice(req.params.id, getActor(req), req.body?.name));
}

export async function reject(req: Request, res: Response) {
  res.json(await svc.rejectDevice(req.params.id));
}

export async function logout(req: Request, res: Response) {
  res.json(await svc.requestLogout(req.params.id));
}

export async function remove(req: Request, res: Response) {
  await svc.deleteDevice(req.params.id);
  res.status(204).end();
}
