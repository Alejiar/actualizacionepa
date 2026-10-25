-- Conciliación (25-oct-2026): un abono de cliente (normal o por hora) se reparte FIFO en varias
-- filas (una por deuda o por turno). paymentGroupId las agrupa para mostrarlas y revertirlas como
-- UN solo abono, por el valor que se cobró. Columnas opcionales: no cambian ningún saldo.
ALTER TABLE "BankTransaction" ADD COLUMN "paymentGroupId" TEXT;
ALTER TABLE "ClientDebtPayment" ADD COLUMN "paymentGroupId" TEXT;
CREATE INDEX "BankTransaction_paymentGroupId_idx" ON "BankTransaction"("paymentGroupId");
CREATE INDEX "ClientDebtPayment_paymentGroupId_idx" ON "ClientDebtPayment"("paymentGroupId");

-- Cobros por hora ya registrados: las filas de un mismo abono comparten descripción (cliente),
-- medio, fecha contable y autor, y se crearon en la misma operación (segundos de diferencia).
-- Solo se agrupan conjuntos de 2 o más filas; las demás quedan como estaban.
WITH r AS (
  SELECT id, description, medium, date, COALESCE("createdBy", '') AS who, "createdAt",
    CASE WHEN "createdAt" - LAG("createdAt") OVER w <= INTERVAL '3 seconds' THEN 0 ELSE 1 END AS brk
  FROM "BankTransaction"
  WHERE "hourlyShiftId" IS NOT NULL AND type = 'ingreso'
  WINDOW w AS (PARTITION BY description, medium, date, COALESCE("createdBy", '') ORDER BY "createdAt", id)
), g AS (
  SELECT id, description, medium, date, who,
    SUM(brk) OVER (PARTITION BY description, medium, date, who ORDER BY "createdAt", id) AS grp
  FROM r
), k AS (
  SELECT id, 'abono_' || md5(description || '|' || COALESCE(medium::text, '') || '|' || date::text || '|' || who || '|' || grp::text) AS gid
  FROM g
)
UPDATE "BankTransaction" b SET "paymentGroupId" = k.gid
FROM k
WHERE b.id = k.id AND k.gid IN (SELECT gid FROM k GROUP BY gid HAVING COUNT(*) > 1);
