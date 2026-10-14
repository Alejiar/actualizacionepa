-- D7 (decisión del dueño, 14-oct-2026): un día cerrado puede corregirse mediante solicitud
-- aprobada mientras el mes siga abierto. Cada corrección queda registrada en el Cierre del día,
-- sin alterar su conteo original.
ALTER TABLE "ShiftClose" ADD COLUMN "corrections" JSONB NOT NULL DEFAULT '[]';
