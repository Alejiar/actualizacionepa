import { badRequest } from "../lib/errors";
import type { Request, Response } from "express";
import * as svc from "../services/client.service";
import { getActor } from "../lib/actor";

export async function list(req: Request, res: Response) {
  const active = req.query.active === "true";
  res.json(await svc.listClients(active));
}

export async function get(req: Request, res: Response) {
  res.json(await svc.getClient(req.params.id));
}

export async function create(req: Request, res: Response) {
  res.status(201).json(await svc.createClient(req.body));
}

export async function update(req: Request, res: Response) {
  res.json(await svc.updateClient(req.params.id, req.body));
}

export async function remove(req: Request, res: Response) {
  await svc.deleteClient(req.params.id);
  res.json({ ok: true });
}

export async function addDebt(req: Request, res: Response) {
  const { description, amount, date, medium } = req.body;
  const actor = getActor(req);
  if (medium != null && medium !== "cash" && medium !== "bank") throw badRequest("Medio inválido");
  const med = medium ?? null;
  res.status(201).json(await svc.addDebt(req.params.id, description, amount, date, actor, med));
}

export async function payDebt(req: Request, res: Response) {
  const { paidAmount } = req.body;
  res.json(await svc.payDebt(req.params.id, paidAmount, getActor(req)));
}

export async function payClient(req: Request, res: Response) {
  const { amount, payAll, medium, cashAmount, bankAmount } = req.body;
  const actor = getActor(req);
  if (medium != null && medium !== "cash" && medium !== "bank") throw badRequest("Medio inválido");
  res.json(await svc.registerClientPayment(
    req.params.id,
    amount,
    payAll === true,
    medium,
    { cashAmount, bankAmount, actor },
  ));
}

export async function debtors(req: Request, res: Response) {
  res.json(await svc.getDebtors());
}
