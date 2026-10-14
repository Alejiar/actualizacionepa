# Conciliación final completa — EPA Domicilios

Fecha: 14-oct-2026. Código `bea002a`. Cada peso se rastrea hasta la operación que lo originó.

Hay dos libros:
- **A. DEMO del propietario** (`cashbuddy_demo`): reconstrucción automática de solo lectura con `tests/conciliacion-demo.ts`.
- **B. Escenario controlado con Cierre** (base temporal): `tests/demo-escenario.ts --cerrar`.

Los movimientos **reales de dinero** se separan de los registros **puramente contables**, que no se cuentan dos veces.

## A. DEMO — libro de caja y banco (los 14 registros que mueven dinero)

Capital inicial: efectivo 100000 · banco 100000

| # | Id | Fecha | Fuente | Detalle | Domiciliario | Medio | Δ efectivo | Δ banco | Efectivo antes → después | Banco antes → después |
|---|---|---|---|---|---|---|---:|---:|---|---|
| 1 | gllvnrny | 2026-10-14 | Base entregada |  | Domiciliario Demo A | cash | -20000 | 0 | 100000 → 80000 | 100000 → 100000 |
| 2 | d4s3zkkc | 2026-10-14 | Base devuelta |  | Domiciliario Demo A | cash | 5000 | 0 | 80000 → 85000 | 100000 → 100000 |
| 3 | ehvhlhfp | 2026-10-14 | Banco ingreso (aplicado) | Pago domiciliario Domiciliario Demo A (base 5400) | Domiciliario Demo A | bank | 0 | 5400 | 85000 → 85000 | 100000 → 105400 |
| 4 | h5uzzzay | 2026-10-14 | Banco ingreso | Ingreso bancario DEMO |  | bank | 0 | 30000 | 85000 → 85000 | 105400 → 135400 |
| 5 | a1fff9sf | 2026-10-14 | Caja cat.3 | Gasto DEMO |  | cash | -10000 | 0 | 85000 → 75000 | 135400 → 135400 |
| 6 | dpgs5wrk | 2026-10-14 | Conversión efectivo_a_banco |  |  | ambos | -7000 | 7000 | 75000 → 68000 | 135400 → 142400 |
| 7 | g3fvgpkr | 2026-10-14 | Banco egreso (par) | Retiro a caja |  | bank | 0 | -50000 | 68000 → 68000 | 142400 → 92400 |
| 8 | 7q100x6l | 2026-10-14 | Banco ingreso (par) | Retiro a caja (contraparte) |  | cash | 50000 | 0 | 68000 → 118000 | 92400 → 92400 |
| 9 | 5mlvmcyv | 2026-10-14 | Abono cliente |  |  | cash | 5000 | 0 | 118000 → 123000 | 92400 → 92400 |
| 10 | ntu478lh | 2026-10-14 | Banco egreso | Pago domiciliario por hora — Domiciliario Demo B (Cliente po |  | cash | -20000 | 0 | 123000 → 103000 | 92400 → 92400 |
| 11 | yprin9zs | 2026-10-14 | Banco ingreso | Cobro cliente por hora — Cliente por hora DEMO |  | bank | 0 | 30000 | 103000 → 103000 | 92400 → 122400 |
| 12 | qidfmi3m | 2026-10-14 | Banco ingreso (aplicado) | Pago domiciliario Domiciliario Demo B (comisión 3600) | Domiciliario Demo B | cash | 3600 | 0 | 103000 → 106600 | 122400 → 122400 |
| 13 | t0jo8qeg | 2026-10-14 | Base entregada | DEMO ficticio | Domiciliario real (pedido #22) | cash | -10000 | 0 | 106600 → 96600 | 122400 → 122400 |
| 14 | ez4w93fz | 2026-10-14 | Banco ingreso (aplicado) | Pago domiciliario Domiciliario real (pedido #22) (base 10000 + comisión 12 | Domiciliario real (pedido #22) | cash | 22000 | 0 | 96600 → 118600 | 122400 → 122400 |

**Saldo reconstruido:** efectivo 118600 · banco 122400. **Saldo esperado de la app:** efectivo 118600 · banco 122400. **CUADRA**

### Registros puramente contables (no mueven caja ni banco; no se cuentan dos veces)

| Registro | Importe | Por qué no mueve dinero |
|---|---:|---|
| 28 pedidos (25 reales de Shipday + 3 ficticios) | valor $312.000 · comisión $93.600 | La comisión es una obligación del domiciliario, no dinero recibido |
| Desglose interno del pago de Demo B (DriverPayment) | 3.600 | Ya está contado en el movimiento #12 |
| Desglose interno del pago del pedido #22 (DriverPayment) | 12.000 | Ya está contado en el movimiento #14 |
| Devolución de base interna de Demo A | 5.400 | Ya está contada en el movimiento #3 |
| Devolución de base interna del pedido #22 | 10.000 | Ya está contada en el movimiento #14 |
| Deuda del Cliente DEMO sin desembolso | 20.000 | Fiado: no salió dinero |

### Obligaciones en la DEMO (F14: cuentas separadas)

| Domiciliario | Comisiones generadas | Pagado a comisión | **Deuda de comisión** | Base entregada | Base devuelta | **Base pendiente** | Crédito | Total informativo |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Demo A | 5.400 | 0 | **5.400** | 20.000 | 10.400 (5.000 + 5.400 de un pago anterior a F14, asignado a base con la regla vieja) | **9.600** | 0 | 15.000 |
| Demo B | 3.600 | 3.600 | **0** | 0 | 0 | **0** | 0 | 0 |
| Real, pedido #22 | 12.000 | 12.000 | **0** | 10.000 | 10.000 | **0** | 0 | 0 |
| Otros 13 domiciliarios reales | 72.600 | 0 | **72.600** | 0 | 0 | **0** | 0 | 72.600 |
| **Totales** | **93.600** | 15.600 | **78.000** | 30.000 | 20.400 | **9.600** | 0 | **87.600** |

Comprobaciones:
- 93.600 − 15.600 = 78.000, que coincide con la comisión pendiente de Reportes.
- 30.000 − 20.400 = 9.600, que coincide con "Diferencia bases" (saldo anterior 0 + entregadas 30.000 − devueltas 20.400).
- La migración F14 de la DEMO conservó el total de 87.600 (auditoría `F14DriverMigration`: Demo A 15.000 → comisión 5.400 + base 9.600, sin residuo).

### Reportes de la DEMO contra el libro

| Indicador | App | Cálculo independiente |
|---|---:|---|
| Efectivo / banco esperados | 118.600 / 122.400 | Tabla anterior |
| Historial del día | 200.000 + 158.000 − 117.000 = 241.000 | 118.600 + 122.400 |
| Ventas (comisión del mes) | 93.600 | Suma de los 28 pedidos |
| Gastos | 10.000 | Movimiento #5 |
| Clientes | 15.000 | 20.000 − 5.000 |

## B. Escenario controlado con Cierre (base temporal, `demo-escenario.ts --cerrar`)

| # | Operación | Medio | Δ efectivo | Δ banco | Efectivo | Banco | Obligación generada (+) / extinguida (−) |
|---|---|---|---:|---:|---:|---:|---|
| 0 | Capital | — | | | 100.000 | 100.000 | |
| 1–3 | Pedidos D1 / D2 / D3 | — | 0 | 0 | 100.000 | 100.000 | +3.000 / +2.400 / +3.600 de comisión |
| 4 | Base entregada a A | efectivo | −20.000 | | 80.000 | 100.000 | +20.000 de base A |
| 5 | Base devuelta por A | efectivo | +5.000 | | 85.000 | 100.000 | −5.000 de base A |
| 6 | Pago de A a comisión (reparto del operador) | banco | | +5.400 | 85.000 | 105.400 | −5.400 de comisión A |
| 7 | Ingreso bancario | banco | | +30.000 | 85.000 | 135.400 | |
| 8 | Gasto aprobado | efectivo | −10.000 | | 75.000 | 135.400 | |
| 9 | Conversión efectivo → banco | ambos | −7.000 | +7.000 | 68.000 | 142.400 | |
| 10 | Transferencia con contraparte | ambos | +50.000 | −50.000 | 118.000 | 92.400 | Par cuadrado (diferencia 0) |
| 11 | Deuda de cliente sin desembolso / abono | efectivo | +5.000 | | 123.000 | 92.400 | +20.000 / −5.000 de deuda de cliente |
| 12 | Turno por hora: pago al domiciliario / cobro | ef. / banco | −20.000 | +30.000 | 103.000 | 122.400 | +30.000 / −30.000 del cliente por hora |
| 13 | Pago de B a comisión | efectivo | +3.600 | | **106.600** | **122.400** | −3.600 de comisión B |

**Cierre:** esperado 106.600 / 122.400, contado 106.600 / 122.400, diferencias 0 / 0. Después del Cierre, el dinero nuevo de ese día se rechaza (409).

**Reporte:**
- ventas 9.000;
- gastos 10.000;
- utilidad −1.000 (la utilidad por hora no entra: decisión pendiente);
- bases: anterior 0 + entregadas 20.000 − devueltas 5.000 = 15.000;
- comisión pendiente 0;
- contrapartes 0;
- clientes 15.000.

**Excel (CIERRE MES):** domicilios 9.000; gastos 10.000 / 0; bases entregadas 20.000 / 0; bases devueltas 5.000 / 0; movimientos de ingreso 53.600 / 65.400; movimientos de salida 20.000 / 50.000.

Las conversiones (−7.000 / +7.000) y el abono de cliente (+5.000) están en las hojas "Conversiones" e Historial: 100.000 − 10.000 − 20.000 + 5.000 + 53.600 − 20.000 + 5.000 − 7.000 = **106.600** ✔. Banco: 100.000 + 65.400 − 50.000 + 7.000 = **122.400** ✔.

## C. Casos F14 exigidos (`tests/claude-f14-d7.ts`, verificados)

| Caso | Operaciones | Resultado comprobado |
|---|---|---|
| A | Comisión 100.000; paga 30.000 en efectivo | Deuda 70.000; efectivo +30.000 |
| B | Base 50.000 + comisión 20.000 | Base 50.000 y comisión 20.000 por separado; total informativo 70.000 en Domiciliarios, estado de cuenta, Deudas, Reporte y Excel |
| C | Base 50.000 + comisión 20.000; paga 30.000 a comisión → crédito 10.000; se paga el crédito | Base intacta en 50.000 (no se compensa); crédito pagado 10.000 sale de caja; ningún descuento doble |
| D | Comisión 100.000; abonos de 25.000 + 25.000 + 50.000 | 75.000 → 50.000 → 0; efectivo +75.000, banco +25.000 |
| Reparto | 45.000 = 15.000 comisión + 30.000 base; luego se borra el movimiento | Comisión 5.000 y base 20.000; al borrar vuelven 20.000 y 50.000, y la caja se restaura |

## D. Corrección D7 (verificada en la interfaz)

Un día con Cierre (contado 111.600, diferencia 0) recibe la solicitud "Agregar egreso efectivo $2.000". Al aprobarla:
- el efectivo esperado del día pasa de 111.600 a 109.600;
- `ShiftClose.corrections` registra −2.000 (tipo "agregar", aprobador y hora);
- el conteo original queda en 111.600 con diferencia 0;
- el semáforo sigue verde;
- el Historial muestra el conteo original, la corrección y el esperado corregido;
- la cadena apertura + ingresos − egresos = cierre se mantiene.

## E. Diferencias encontradas

Ninguna sin explicar. La única brecha visible, la hoja CIERRE MES del Excel sin conversiones ni abonos de clientes, está explicada arriba. Agregar una hoja de conciliación al Excel es la decisión P5, pendiente.
