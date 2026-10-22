/** INC-01 (22-oct-2026): el servidor solo acepta las denominaciones reales del asistente de Cierre.
 * Arma el conteo de un monto con billetes y monedas reales (mayor a menor). */
export function realCount(amount: number) {
  let rest = amount; const bills: { value: number; qty: number }[] = [], coins: { value: number; qty: number }[] = [];
  for (const v of [100000, 50000, 20000, 10000, 5000, 2000, 1000]) { const q = Math.floor(rest / v); if (q) { bills.push({ value: v, qty: q }); rest -= q * v; } }
  for (const v of [500, 200, 100, 50]) { const q = Math.floor(rest / v); if (q) { coins.push({ value: v, qty: q }); rest -= q * v; } }
  if (rest !== 0 || amount < 0) throw Error("efectivo no contable con billetes y monedas reales: " + amount);
  return { bills, coins };
}
