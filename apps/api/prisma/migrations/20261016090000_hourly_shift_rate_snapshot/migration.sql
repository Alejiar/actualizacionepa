-- Tarifa congelada por turno (aditiva, sin pérdida de datos).
ALTER TABLE "HourlyShift" ADD COLUMN "driverHourValue" INTEGER;
ALTER TABLE "HourlyShift" ADD COLUMN "companyHourValue" INTEGER;

-- Turnos existentes: se guarda la tarifa vigente del cliente SOLO si reproduce exactamente los
-- montos guardados (mismo redondeo que computeAmounts). Si no, queda NULL y el turno no se
-- re-precia en silencio: editar sus horas exige eliminarlo y registrarlo de nuevo.
UPDATE "HourlyShift" s
SET "driverHourValue" = c."driverHourValue", "companyHourValue" = c."companyHourValue"
FROM "HourlyClient" c
WHERE c.id = s."hourlyClientId"
  AND s."driverAmount" = ROUND((c."driverHourValue"::numeric * s.minutes) / 60)
  AND s."totalAmount" = ROUND(((c."driverHourValue" + c."companyHourValue")::numeric * s.minutes) / 60);
