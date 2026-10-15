import { assertMoney } from "../lib/money-validation";
import type { Settings, UpdateSettingsRequest } from "@cash-buddy/shared";
import { prisma, moneyTransaction } from "../lib/prisma";
import { conflict } from "../lib/errors";

const SINGLETON_ID = "singleton";

export async function getSettings(): Promise<Settings> {
  const s = await prisma.settings.upsert({
    where: { id: SINGLETON_ID },
    update: {},
    create: { id: SINGLETON_ID },
  });
  return {
    companyName: s.companyName,
    brandName: s.brandName,
    logoData: s.logoData,
    termsAcceptedAt: s.termsAcceptedAt ? s.termsAcceptedAt.toISOString() : null,
    initialCash: s.initialCash,
    initialBank: s.initialBank,
    setupComplete: s.setupComplete,
    commissionPercent: s.commissionPercent,
  };
}

export async function updateSettings(patch: UpdateSettingsRequest): Promise<Settings> {
  if (patch.initialCash !== undefined) assertMoney(patch.initialCash, true);
  if (patch.initialBank !== undefined) assertMoney(patch.initialBank, true);
  // El capital es el ancla de la caja esperada: se escribe serializado con la caja.
  const s = await moneyTransaction(async () => {
    const current = await prisma.settings.findUnique({ where: { id: SINGLETON_ID } });
    const changingCapital = (patch.initialCash !== undefined && patch.initialCash !== current?.initialCash)
      || (patch.initialBank !== undefined && patch.initialBank !== current?.initialBank);
    if (changingCapital && await prisma.shiftClose.count()) {
      throw conflict("Cambiar el capital inicial alteraría días cerrados. Para ajustar la caja registra un movimiento, o una corrección aprobada si el día ya está cerrado.");
    }
    return prisma.settings.upsert({
    where: { id: SINGLETON_ID },
    update: patch,
    create: { id: SINGLETON_ID, ...patch },
    });
  });
  return {
    companyName: s.companyName,
    brandName: s.brandName,
    logoData: s.logoData,
    termsAcceptedAt: s.termsAcceptedAt ? s.termsAcceptedAt.toISOString() : null,
    initialCash: s.initialCash,
    initialBank: s.initialBank,
    setupComplete: s.setupComplete,
    commissionPercent: s.commissionPercent,
  };
}
