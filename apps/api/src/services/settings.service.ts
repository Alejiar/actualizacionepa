import { assertMoney } from "../lib/money-validation";
import type { Settings, UpdateSettingsRequest } from "@cash-buddy/shared";
import { prisma } from "../lib/prisma";

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
  const s = await prisma.settings.upsert({
    where: { id: SINGLETON_ID },
    update: patch,
    create: { id: SINGLETON_ID, ...patch },
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
