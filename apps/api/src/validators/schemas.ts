import { z } from "zod";
import { MAX_MONEY } from "../lib/money-validation";
export const positiveMoney = z.number().int().positive().max(MAX_MONEY);
export const nonnegativeMoney = z.number().int().min(0).max(MAX_MONEY);

const categoryCodes = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 18] as const;

export const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Fecha debe tener formato YYYY-MM-DD");

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6, "La contraseña debe tener al menos 6 caracteres"),
  name: z.string().min(1),
});

export const createMovementSchema = z.object({
  date: dateSchema,
  category: z.union(
    categoryCodes.map((c) => z.literal(c)) as [z.ZodLiteral<number>, z.ZodLiteral<number>, ...z.ZodLiteral<number>[]],
  ),
  type: z.enum(["ingreso", "egreso"]),
  medium: z.enum(["cash", "bank"]),
  amount: positiveMoney,
  workerId: z.string().nullish(),
  description: z.string().nullish(),
  status: z.enum(["pending", "confirmed"]).optional(),
  time: z.string().optional(),
  group: z.string().nullish(),
  kind: z.enum(["commission", "delivery"]).nullish(),
  deliveryId: z.string().nullish(),
  deliveryValue: z.number().int().nullish(),
  taxAmount: z.number().int().nullish(),
  createdBy: z.string().nullish(),
});

export const updateMovementSchema = createMovementSchema.partial();

export const createWorkerSchema = z.object({
  name: z.string().min(1),
  role: z.enum(["domiciliario", "administrativo"]),
  active: z.boolean(),
  color: z.string().optional(),
});

export const updateWorkerSchema = createWorkerSchema.partial();

export const updateSettingsSchema = z.object({
  companyName: z.string().optional(),
  brandName: z.string().optional(),
  logoData: z.string().nullable().optional(),
  termsAcceptedAt: z.string().nullable().optional(),
  initialCash: nonnegativeMoney.optional(),
  initialBank: nonnegativeMoney.optional(),
  setupComplete: z.boolean().optional(),
  commissionPercent: z.number().optional(),
});

const arqueoSchema = z.object({
  bills: z.number().optional(),
  coins: z.number().optional(),
  bank: z.number().optional(),
});

export const updateArqueoSchema = z.object({
  slot: z.enum(["AM", "PM", "close"]),
  arqueo: arqueoSchema,
});
