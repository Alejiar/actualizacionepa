-- F14 (decisión del dueño, 14-oct-2026): la base y la deuda por comisiones son cuentas
-- independientes que no se compensan. Antes Driver.pendingDebt sumaba base + comisiones
-- (saldo neto único) y la base mostrada era min(libro, deuda). Desde ahora:
--   * base pendiente = Σ entregas − Σ devoluciones (libro BaseTransaction);
--   * Driver.pendingDebt / creditAmount = SOLO comisiones.
--
-- Conversión, por domiciliario con libro de base:
--   shown   = max(0, min(libro, pendingDebt))      -- la base que el sistema mostraba
--   residuo = max(0, libro − shown)                -- base ya compensada con comisión/crédito
--   neto    = (pendingDebt − creditAmount) − shown -- nueva cuenta de comisiones
-- Como shown ≤ pendingDebt y deuda/crédito nunca son ambos > 0, ningún domiciliario gana
-- crédito por esta migración (no se crean créditos pagables). El residuo se registra como
-- devolución INTERNA (nota "Regularización F14", excluida de caja/banco) para que el libro de
-- base refleje la compensación histórica que ya ocurrió. Todo queda en F14DriverMigration.

CREATE TABLE "F14DriverMigration" (
    "driverId" TEXT NOT NULL,
    "pendingDebtBefore" INTEGER NOT NULL,
    "creditAmountBefore" INTEGER NOT NULL,
    "baseLedger" INTEGER NOT NULL,
    "baseShown" INTEGER NOT NULL,
    "residueRegularized" INTEGER NOT NULL,
    "pendingDebtAfter" INTEGER NOT NULL,
    "creditAmountAfter" INTEGER NOT NULL,
    "migratedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "F14DriverMigration_pkey" PRIMARY KEY ("driverId")
);

INSERT INTO "F14DriverMigration" ("driverId", "pendingDebtBefore", "creditAmountBefore", "baseLedger", "baseShown", "residueRegularized", "pendingDebtAfter", "creditAmountAfter")
SELECT c.id, c.pd, c.cr, c.raw, c.shown,
       GREATEST(0, c.raw - c.shown),
       GREATEST(0, c.pd - c.cr - c.shown),
       GREATEST(0, -(c.pd - c.cr - c.shown))
FROM (
  SELECT d.id, d."pendingDebt" AS pd, d."creditAmount" AS cr, l.raw,
         GREATEST(0, LEAST(l.raw, d."pendingDebt")) AS shown
  FROM "Driver" d
  JOIN (
    SELECT "driverId", SUM(CASE WHEN "type" = 'entrega' THEN "amount" ELSE -"amount" END)::INTEGER AS raw
    FROM "BaseTransaction" GROUP BY "driverId"
  ) l ON l."driverId" = d.id
  WHERE l.raw <> 0
) c;

INSERT INTO "BaseTransaction" ("id", "branchId", "driverId", "amount", "cashAmount", "bankAmount", "type", "notes", "date")
SELECT 'f14_' || md5(m."driverId" || clock_timestamp()::text), d."branchId", m."driverId", m."residueRegularized", 0, 0, 'pago',
       'Regularización F14: base compensada históricamente con comisión o crédito (sin movimiento de caja)', CURRENT_TIMESTAMP
FROM "F14DriverMigration" m JOIN "Driver" d ON d.id = m."driverId"
WHERE m."residueRegularized" > 0;

UPDATE "Driver" d
SET "pendingDebt" = m."pendingDebtAfter",
    "creditAmount" = m."creditAmountAfter",
    "creditMedium" = CASE WHEN m."creditAmountAfter" > 0 THEN d."creditMedium" ELSE NULL END
FROM "F14DriverMigration" m
WHERE m."driverId" = d.id;
