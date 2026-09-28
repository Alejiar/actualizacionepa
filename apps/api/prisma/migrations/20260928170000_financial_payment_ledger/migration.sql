ALTER TABLE "ClientDebt" ADD COLUMN "sourceOrderId" TEXT;
CREATE UNIQUE INDEX "ClientDebt_sourceOrderId_key" ON "ClientDebt"("sourceOrderId");
ALTER TABLE "ClientDebt" ADD CONSTRAINT "ClientDebt_sourceOrderId_fkey" FOREIGN KEY ("sourceOrderId") REFERENCES "ShipdayOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE TABLE "ClientDebtPayment" (
 "id" TEXT NOT NULL, "debtId" TEXT NOT NULL, "clientId" TEXT NOT NULL, "description" TEXT NOT NULL,
 "paidAmount" INTEGER NOT NULL, "paidCash" INTEGER NOT NULL DEFAULT 0, "paidBank" INTEGER NOT NULL DEFAULT 0,
 "paidAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "paidBy" TEXT, "paidByName" TEXT,
 "paidDeviceId" TEXT, "paidDeviceName" TEXT, "legacyAggregate" BOOLEAN NOT NULL DEFAULT false,
 CONSTRAINT "ClientDebtPayment_pkey" PRIMARY KEY ("id"),
 CONSTRAINT "ClientDebtPayment_debtId_fkey" FOREIGN KEY ("debtId") REFERENCES "ClientDebt"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 CONSTRAINT "ClientDebtPayment_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "ClientDebtPayment_debtId_idx" ON "ClientDebtPayment"("debtId");
CREATE INDEX "ClientDebtPayment_clientId_idx" ON "ClientDebtPayment"("clientId");
CREATE INDEX "ClientDebtPayment_paidAt_idx" ON "ClientDebtPayment"("paidAt");
-- Conserva exactamente la fecha y medios conocidos. NO inventa abonos históricos
-- individuales ni recalcula saldos. legacyAggregate identifica esta limitación.
INSERT INTO "ClientDebtPayment" ("id","debtId","clientId","description","paidAmount","paidCash","paidBank","paidAt","paidBy","paidByName","paidDeviceId","paidDeviceName","legacyAggregate")
SELECT 'legacy-' || "id", "id", "clientId", "description", COALESCE("paidAmount", "paidCash"+"paidBank"), "paidCash", "paidBank", "paidAt", "paidBy", "paidByName", "paidDeviceId", "paidDeviceName", true
FROM "ClientDebt" WHERE "paidAt" IS NOT NULL AND (COALESCE("paidAmount",0)>0 OR "paidCash"+"paidBank">0);
