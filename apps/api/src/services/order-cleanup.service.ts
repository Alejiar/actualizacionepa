/** El libro financiero no se puede purgar sin un archivo auditable y saldos de
 * apertura. Conservamos esta API para callers antiguos, sin borrar registros. */
export async function deleteOldData(): Promise<Record<string, number>> {
  return { orders: 0, movements: 0, bankTransactions: 0, driverPayments: 0,
    baseTransactions: 0, clientDebts: 0, dailyStats: 0, shiftCloses: 0, conversions: 0 };
}
export function scheduleOrderCleanup() {
  console.log("[historial] Conservación permanente del libro financiero habilitada.");
}
