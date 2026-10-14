import { prisma, moneyTransaction } from "../lib/prisma";
import { conflict } from "../lib/errors";

/**
 * Reinicia TODOS los datos operativos del sistema.
 * Borra: movimientos, días, clientes, deudas, transacciones bancarias,
 *        conversiones, pagos y bases de domiciliarios, estadísticas diarias,
 *        cierres de turno, pedidos Shipday, cierres mensuales.
 *
 * NO borra: usuarios, trabajadores, domiciliarios (Drivers), sucursales (Branches), Settings.
 */
export async function resetAll(): Promise<void> {
  return moneyTransaction(async () => {
  if (await prisma.shiftClose.count() || await prisma.monthlyClose.count()) {
    throw conflict("El reinicio no puede borrar cierres históricos. Conserva la base y su respaldo; D7 sigue pendiente.");
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
