import { z } from "zod";
import { assertMoney } from "../lib/money-validation";
const clientFields = z.object({name:z.string().trim().min(1),phone:z.string().nullish(),email:z.string().nullish(),address:z.string().nullish(),notes:z.string().nullish(),active:z.boolean().optional()}).strict();
function parseClient<T extends z.ZodTypeAny>(schema:T, value:unknown):z.infer<T> { const r=schema.safeParse(value); if(!r.success) throw badRequest("Datos de cliente inválidos",r.error.flatten()); return r.data; }
function debtMedium(value:unknown) { if(value != null && value !== "cash" && value !== "bank") throw badRequest("Medio inválido"); }
import { prisma, moneyTransaction } from "../lib/prisma";
import { badRequest, notFound } from "../lib/errors";

// Usuario + equipo (PC) que hace la acción. Compatible con getActor(req).
type ActorLike = { id?: string | null; name?: string | null; deviceId?: string | null; deviceName?: string | null };

export async function listClients(activeOnly = false) {
  return prisma.client.findMany({
    where: activeOnly ? { active: true } : undefined,
    include: {
      debts: {
        where: { paid: false },
        orderBy: { createdAt: "desc" },
      },
    },
    orderBy: { name: "asc" },
  });
}

export async function getClient(id: string) {
  const c = await prisma.client.findUnique({
    where: { id },
    include: {
      debts: { orderBy: { createdAt: "desc" } },
    },
  });
  if (!c) throw notFound("Cliente no encontrado");
  return c;
}

export async function createClient(data: {
  name: string;
  phone?: string;
  email?: string;
  address?: string;
  notes?: string;
  initialDebt?: number;
  initialDebtDescription?: string;
  initialDebtMedium?: "cash" | "bank";
}) {
  return moneyTransaction(async () => {
  const { initialDebt, initialDebtDescription, initialDebtMedium, ...clientData } = data;

  if (initialDebt !== undefined) assertMoney(initialDebt);
  debtMedium(initialDebtMedium);
  const client = await prisma.client.create({ data: parseClient(clientFields,clientData) });

  // Si hay deuda inicial, registrarla y reflejarla en el saldo
  if (initialDebt && initialDebt > 0) {
    await prisma.$transaction([
      prisma.clientDebt.create({
        data: {
          clientId: client.id,
          description: initialDebtDescription?.trim() || "Deuda inicial",
          amount: Math.round(initialDebt),
          medium: initialDebtMedium ?? null,
        },
      }),
      prisma.client.update({
        where: { id: client.id },
        data: { pendingDebt: { increment: Math.round(initialDebt) } },
      }),
    ]);
  }

  return prisma.client.findUnique({
    where: { id: client.id },
    include: { debts: { where: { paid: false }, orderBy: { createdAt: "desc" } } },
  });

  });
}

export async function updateClient(id: string, data: Partial<{
  name: string;
  phone: string;
  email: string;
  address: string;
  notes: string;
  active: boolean;
}>) {
  return prisma.client.update({ where: { id }, data: parseClient(clientFields.partial(),data) });
}

export async function addDebt(clientId: string, description: string, amount: number, date?: string, actor?: ActorLike, medium?: "cash" | "bank" | null) {
  return moneyTransaction(async () => {
  assertMoney(amount);
  debtMedium(medium);
  const [debt] = await prisma.$transaction([
    prisma.clientDebt.create({
      data: { clientId, description, amount, medium: medium ?? null, createdBy: actor?.id ?? null, createdByName: actor?.name ?? null, deviceId: actor?.deviceId ?? null, deviceName: actor?.deviceName ?? null, ...(date ? { createdAt: new Date(date + "T12:00:00") } : {}) },
    }),
    prisma.client.update({
      where: { id: clientId },
      data: { pendingDebt: { increment: amount } },
    }),
  ]);
  return debt;

  });
}

export async function payDebt(debtId: string, paidAmount?: number, actor?: ActorLike) {
  return moneyTransaction(async () => {
  const debt = await prisma.clientDebt.findUnique({where:{id:debtId}});
  if (!debt) throw notFound("Deuda no encontrada");
  const amount = paidAmount ?? debt.amount - (debt.paidAmount ?? 0);
  if (!Number.isSafeInteger(amount) || amount <= 0) throw badRequest("Monto inválido");
  // Ruta heredada: exige un medio explícito antes de mover dinero.
  throw badRequest("Registra el abono desde Clientes indicando efectivo o banco.");

  });
}

/**
 * Registra un abono parcial al saldo total del cliente.
 * Se aplica sobre las deudas pendientes más antiguas primero (FIFO).
 * Si `payAll` es true, liquida toda la deuda pendiente.
 */
export async function registerClientPayment(
  clientId: string,
  amount: number,
  payAll = false,
  medium: "cash" | "bank" = "cash",
  opts?: { cashAmount?: number; bankAmount?: number; actor?: ActorLike },
) {
  return moneyTransaction(async () => {
  const client = await prisma.client.findUnique({ where: { id: clientId } });
  if (!client) throw notFound("Cliente no encontrado");
  if (medium !== "cash" && medium !== "bank") throw badRequest("Medio inválido");
  const cashIn = opts?.cashAmount ?? 0, bankIn = opts?.bankAmount ?? 0;
  if (![cashIn, bankIn].every(n => Number.isSafeInteger(n) && n >= 0)) throw badRequest("Monto inválido");
  const split = cashIn + bankIn > 0;
  const requested = split ? cashIn + bankIn : (payAll ? client.pendingDebt : amount);
  if (!Number.isSafeInteger(requested) || requested <= 0) throw badRequest("Monto inválido");
  const debts = await prisma.clientDebt.findMany({where:{clientId, paid:false},orderBy:[{createdAt:"asc"},{id:"asc"}]});
  const available = debts.reduce((sum,d) => sum + Math.max(0,d.amount-(d.paidAmount ?? 0)),0);
  if (available !== client.pendingDebt) throw badRequest("El saldo histórico necesita conciliación antes de registrar el abono.");
  assertMoney(requested);
  if (requested > available) throw badRequest("El abono supera la deuda pendiente. No se admite sobrepago de clientes.");
  const applied = requested;
  if (applied <= 0) throw badRequest("El cliente no tiene deuda pendiente");
  let left = applied, cashPool = split ? cashIn : (medium === "cash" ? applied : 0);
  for (const debt of debts) {
    if (!left) break;
    const part = Math.min(left, debt.amount - (debt.paidAmount ?? 0));
    const cash = Math.min(part,cashPool), bank = part-cash;
    cashPool -= cash; left -= part;
    const paidAt = new Date();
    for (const [paidCash,paidBank] of [[cash,0],[0,bank]]) {
      if (!paidCash && !paidBank) continue;
      await prisma.clientDebtPayment.create({data:{
        debtId:debt.id,clientId,description:debt.description,paidAmount:paidCash+paidBank,paidCash,paidBank,paidAt,
        paidBy:opts?.actor?.id ?? null,paidByName:opts?.actor?.name ?? null,
        paidDeviceId:opts?.actor?.deviceId ?? null,paidDeviceName:opts?.actor?.deviceName ?? null,
      }});
    }
    const newPaid = (debt.paidAmount ?? 0)+part;
    await prisma.clientDebt.update({where:{id:debt.id},data:{paidAmount:newPaid,paid:newPaid>=debt.amount,
      paidCash:{increment:cash},paidBank:{increment:bank},paidAt,
      paidBy:opts?.actor?.id ?? null,paidByName:opts?.actor?.name ?? null,paidDeviceId:opts?.actor?.deviceId ?? null,paidDeviceName:opts?.actor?.deviceName ?? null}});
  }
  await prisma.client.update({where:{id:clientId},data:{pendingDebt:{decrement:applied}}});
  return {applied,remaining:client.pendingDebt-applied};

  });
}

export async function getDebtors() {
  return prisma.client.findMany({
    where: { pendingDebt: { gt: 0 }, active: true },
    include: { debts: { where: { paid: false }, orderBy: { createdAt: "asc" } } },
    orderBy: [{ pendingDebt: "desc" }, { name: "asc" }],
  });
}

export async function deleteClient(id: string) {
  return moneyTransaction(async () => {
  if (await prisma.clientDebt.count({where:{clientId:id}})) throw badRequest("El cliente tiene historial financiero. Inactívalo para conservarlo.");
  await prisma.client.delete({ where: { id } });

  });
}

export async function reverseClientPayment(id: string) {
  return moneyTransaction(async () => {
  const payment = await prisma.clientDebtPayment.findUnique({where:{id}});
  if (!payment) throw badRequest("El abono ya no existe. Actualiza Movimientos.");
  const debt = await prisma.clientDebt.findUniqueOrThrow({where:{id:payment.debtId}});
  await prisma.clientDebtPayment.delete({where:{id}});
  const latest = await prisma.clientDebtPayment.findFirst({where:{debtId:debt.id},orderBy:{paidAt:"desc"}});
  const paid = Math.max(0,(debt.paidAmount ?? 0)-payment.paidAmount);
  await prisma.clientDebt.update({where:{id:debt.id},data:{paidAmount:paid,paid:paid>=debt.amount,
    paidCash:{decrement:payment.paidCash},paidBank:{decrement:payment.paidBank},paidAt:latest?.paidAt ?? null,
    paidBy:latest?.paidBy ?? null,paidByName:latest?.paidByName ?? null,paidDeviceId:latest?.paidDeviceId ?? null,paidDeviceName:latest?.paidDeviceName ?? null}});
  await prisma.client.update({where:{id:debt.clientId},data:{pendingDebt:{increment:payment.paidAmount}}});

  });
}
