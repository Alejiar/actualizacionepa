-- Corrección previa a la migración F14 — pago del 26-sep-2026 registrado completo como base (aprobada por el dueño).
-- El 26-sep-2026 02:29 UTC (día operativo 25-sep) se registró un pago de $129.100 completo como
-- devolución de base, cuando eran $100.000 de base + $29.100 de comisión (su comisión de ese día
-- fue exactamente $29.100; los demás días quedó como "Pago de comisión"). Se deja igual que el
-- registro del 25-sep: base 100.000 + DriverPayment de comisión 29.100, ambos internos del mismo
-- BankTransaction (excluidos de caja/banco por su nota). El dinero real (BankTransaction de
-- $129.100) NO se toca. Resultado: libro de base de la domiciliaria = 0 y deuda/crédito sin cambio (0/0).
-- Idempotente: si ya se aplicó, no hace nada. Aborta si algo no coincide.
\set ON_ERROR_STOP on
BEGIN;
DO $$
DECLARE n int; ledger int;
BEGIN
  IF EXISTS (SELECT 1 FROM "DriverPayment" WHERE id = 'fix_f14_20260925_comision') THEN
    RAISE NOTICE 'Corrección ya aplicada; no se hace nada.';
    RETURN;
  END IF;
  UPDATE "BaseTransaction" SET amount = 100000, "cashAmount" = 100000
   WHERE id = 'cmuhrufdf0bpbil0wgmyewctm' AND "driverId" = 'cmrav0a7u001cilk0pc5b3xpq'
     AND amount = 129100 AND "cashAmount" = 129100 AND "bankAmount" = 0 AND type = 'pago'
     AND "bankTransactionId" = 'cmuhrufd70bp9il0wejx6szmv';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN RAISE EXCEPTION 'La devolución de base de 129.100 no está como se esperaba (filas: %)', n; END IF;
  INSERT INTO "DriverPayment" (id, "driverId", "branchId", amount, notes, date, medium, "createdBy", "createdByName", "bankTransactionId", "deviceId", "deviceName")
  SELECT 'fix_f14_20260925_comision', t."driverId", 'cmrav04xb0000ilk0ko3c5vs1', 29100,
         'Pago vía movimiento bancario · Pago de comisión', '2026-09-26 02:29:34.419', 'cash',
         NULL, 'Corrección previa a la actualización (aprobada por el dueño)', t.id, NULL, NULL
    FROM "BankTransaction" t
   WHERE t.id = 'cmuhrufd70bp9il0wejx6szmv' AND t.amount = 129100 AND t."debtApplied" = 129100 AND t."driverId" = 'cmrav0a7u001cilk0pc5b3xpq';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN RAISE EXCEPTION 'El movimiento de 129.100 no está como se esperaba'; END IF;
  SELECT COALESCE(SUM(CASE WHEN type = 'entrega' THEN amount ELSE -amount END), 0) INTO ledger
    FROM "BaseTransaction" WHERE "driverId" = 'cmrav0a7u001cilk0pc5b3xpq';
  IF ledger <> 0 THEN RAISE EXCEPTION 'El libro de base quedó en % (se esperaba 0)', ledger; END IF;
  RAISE NOTICE 'Corrección aplicada: libro de base = 0.';
END $$;
COMMIT;
