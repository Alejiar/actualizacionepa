// Auditoría ronda 2 (22-oct-2026): reloj SIMULADO solo dentro de este proceso de prueba, para continuar
// las simulaciones de la ronda 1 durante meses sin tocar el reloj del PC. Reemplaza `Date` (new Date()
// sin argumentos y Date.now()) por el instante real + un desfase. El desfase se fija con
// globalThis.__fakeClock.set(ms) o con la variable FAKE_NOW_MS (para un servidor hijo).
// Los temporizadores (setTimeout) siguen en tiempo real.
const RealDate = Date;
let offset = process.env.FAKE_NOW_MS ? Number(process.env.FAKE_NOW_MS) - RealDate.now() : 0;
class FakeDate extends RealDate {
  constructor(...a) { if (a.length === 0) super(RealDate.now() + offset); else super(...a); }
  static now() { return RealDate.now() + offset; }
}
globalThis.Date = FakeDate;
globalThis.__fakeClock = { set(ms) { offset = ms - RealDate.now(); }, now() { return RealDate.now() + offset; }, Real: RealDate };
