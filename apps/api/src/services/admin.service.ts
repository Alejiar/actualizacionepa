import { prisma, moneyTransaction } from "../lib/prisma";
import { conflict } from "../lib/errors";

/**
 * Reinicia TODOS los datos operativos del sistema.
 * Borra: movimientos, días, clientes (normales y por hora con sus turnos), deudas, transacciones bancarias,
 *        conversiones, pagos y bases de domiciliarios, estadísticas diarias,
 *        cierres de turno, pedidos Shipday, cierres mensuales.
 *
 * NO borra: usuarios, trabajadores, domiciliarios (Drivers), sucursales (Branches), Settings.
 */
export async function resetAll(): Promise<void> {
  return moneyTransaction(async () => {
  if (await prisma.shiftClose.count() || await prisma.monthlyClose.count()) {
    throw conflict("El reinicio no puede borrar cierres históricos. Conserva la base y su respaldo; las correcciones se hacen con solicitudes aprobadas.");
  }
  // Orden respetando foreign keys:
  // Primero los hijos, luego los padres.
  await prisma.$transaction([
    // Sistema original
    prisma.movement.deleteMany({}),
    prisma.day.deleteMany({}),

    // Clientes y deudas
    prisma.clientDebtPayment.deleteMany({}),
    prisma.clientDebt.deleteMany({}),
    prisma.client.deleteMany({}),

    // Clientes por hora: sus turnos guardan pagos/cobros (driverPaidBankTxId, paidCash,
    // paidBank) que apuntan a transacciones bancarias que se borran abajo. Conservarlos
    // dejaba turnos "pagados/cobrados" sin su dinero (AIF12).
    prisma.hourlyShift.deleteMany({}),
    prisma.hourlyClient.deleteMany({}),

    // Banco
    prisma.bankTransaction.deleteMany({}),

    // Shipday — transacciones
    prisma.driverPayment.deleteMany({}),
    prisma.baseTransaction.deleteMany({}),
    prisma.conversion.deleteMany({}),
    prisma.dailyDriverStat.deleteMany({}),
    prisma.shipdayOrder.deleteMany({}),

    // Cierres
    prisma.shiftClose.deleteMany({}),
    prisma.monthlyClose.deleteMany({}),

    // Deuda de conductores Shipday → resetear a 0
    prisma.driver.updateMany({ data: { pendingDebt: 0, creditAmount: 0, creditMedium: null } }),

    // Marcar configuración como no completada (vuelve al wizard de bienvenida)
    prisma.settings.upsert({
      where: { id: "singleton" },
      update: { setupComplete: false },
      create: { id: "singleton", setupComplete: false },
    }),
  ]);

  });
}
