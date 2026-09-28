ALTER TABLE "ShipdayOrder"
 ADD COLUMN "manualOverride" BOOLEAN NOT NULL DEFAULT false,
 ADD COLUMN "manualOriginalValue" INTEGER,
 ADD COLUMN "manualOverrideBy" TEXT,
 ADD COLUMN "manualOverrideAt" TIMESTAMP(3),
 ADD COLUMN "shipdayDeliveryValue" INTEGER;

-- Protege también correcciones ya aprobadas. No reconstruye saldos ni tarifas.
-- El valor original solo se conserva si existe evidencia válida en la solicitud.
WITH edits AS (
 SELECT "entityId", "reviewerId", "reviewedAt", "changes"->'deliveryValue'->>'old' AS original,
 row_number() OVER (PARTITION BY "entityId" ORDER BY "reviewedAt" DESC, id DESC) AS latest,
 first_value("changes"->'deliveryValue'->>'old') OVER (PARTITION BY "entityId" ORDER BY "reviewedAt", id) AS first_original
 FROM "EditRequest"
 WHERE "entityType"='ShipdayOrder' AND "requestType"='edit' AND status='approved'
 AND "changes" ? 'deliveryValue'
)
UPDATE "ShipdayOrder" o SET "manualOverride"=true,
 "manualOverrideBy"=e."reviewerId", "manualOverrideAt"=e."reviewedAt",
 "manualOriginalValue"=CASE WHEN e.first_original ~ '^[0-9]{1,10}$'
 THEN CASE WHEN e.first_original::bigint <= 2147483647 THEN e.first_original::integer END END
FROM edits e WHERE e."entityId"=o.id AND e.latest=1;
