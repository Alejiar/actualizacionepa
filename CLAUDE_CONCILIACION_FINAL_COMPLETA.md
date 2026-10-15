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

## F. Tercera ronda (15-oct-2026): conciliación de las 3 decisiones finales

Copia de la DEMO, migrada a 37. Todo se hizo con clics en la interfaz, el día 15, y cada esperado se calculó a mano antes de mirar el sistema.

### F.1 Libro del día 15 (efectivo / banco)

Apertura: **118.600 / 122.400**.

| # | Registro | Efectivo | Banco | Saldo |
|---|---|---:|---:|---|
| 1 | Turno nocturno 23:00–01:00 (2 h × 10.000), pago al domiciliario | −20.000 | | 98.600 / 122.400 |
| 2 | Turno de B 08:00–10:00 por banco | | −20.000 | 98.600 / 102.400 |
| 3 | Edición del turno de B a 11:00 con **su** tarifa (+1 h × 10.000) | | −10.000 | 98.600 / 92.400 |
| 4 | Turno de A 20:00–22:00 con la tarifa nueva (2 h × 12.000) | −24.000 | | 74.600 / 92.400 |
| 5 | Solicitud aprobada: turno de A hasta la 01:00 (+3 h × 12.000) | −36.000 | | 38.600 / 92.400 |
| 6 | Nómina "Anticipo UI" | −5.000 | | 33.600 / 92.400 |
| 7 | Base a A | −10.000 | | 23.600 / 92.400 |
| 8 | Devolución de base de A por banco | | +5.000 | 23.600 / 97.400 |
| 9 | Pago de A (5.400 comisión + 4.600 base) | +10.000 | | 33.600 / 97.400 |
| 10 | Ingreso por banco aplicado a B | | +7.000 | 33.600 / 104.400 |
| 11 | Cliente por hora abona 50.000 (repartido en 2 turnos: 20.000 + 30.000) | | +50.000 | 33.600 / 154.400 |
| 12 | Salida por banco con contraparte en efectivo | +30.000 | −30.000 | 63.600 / 124.400 |
| — | **Cierre** (conteo) | 63.600 | 124.400 | diferencias 0 |
| 13 | D7: movimiento olvidado, aprobado | −1.000 | | esperado 62.600 / 124.400 |

**Totales del día:**
- Movimientos (filtro por medio, registro por registro): efectivo −55.000 y banco +2.000. Coincide con el libro: 63.600 − 118.600 = −55.000 y 124.400 − 122.400 = +2.000.
- El conteo original del Cierre (63.600) no cambia; el esperado corregido es 62.600.

### F.2 Lo que NO movió caja (y no debía)

| Registro | Efecto | Caja |
|---|---|---|
| Pedido manual J1, B, 10.000 | B comisión +3.000 | igual |
| **Pedido manual J9 después del Cierre**, A, 40.000 | A comisión +12.000; resumen del día +12.000 | **igual**; Cierre 63.600 / dif. 0, sin correcciones nuevas |
| Cambio de tarifa 10.000/5.000 → 12.000/6.000 | Solo los turnos nuevos | igual; deuda 60.000 sin cambio |
| Aviso nocturno de 23 h, cancelado | nada | igual |
| Renombrar, desactivar o reactivar un trabajador | nada | igual |

### F.3 Cuentas de domiciliarios y clientes al final

**Demo A:**

| Concepto | Comisión | Crédito | Base |
|---|---:|---:|---:|
| Inicial | 5.400 | 0 | 9.600 |
| Base entregada | | | +10.000 |
| Base devuelta | | | −5.000 |
| Pago dividido | −5.400 | | −4.600 |
| Pedido de 40.000 tras el Cierre | +12.000 | | |
| **Final** | **12.000** | **0** | **10.000** |

**Demo B:**

| Concepto | Comisión | Crédito | Base |
|---|---:|---:|---:|
| Inicial | 0 | 0 | 0 |
| Pedido de 10.000 | +3.000 | | |
| Ingreso aplicado de 7.000 | −3.000 | +4.000 | |
| **Final** | **0** | **4.000** | **0** |

**Cliente por hora:** 30.000 + 30.000 + 15.000 + 36.000 + 54.000 = 165.000; menos el abono de 50.000 = **115.000**.

### F.4 Mes de octubre: tres fuentes independientes

| Concepto | Cálculo a mano | SQL directo | Reporte / Cierre / Excel |
|---|---:|---:|---:|
| Pedidos (cantidad / valor) | 28 de la DEMO + 2 = 30 / 312.000 + 50.000 = 362.000 | 30 / 362.000 | 30 / 362.000 |
| Comisión | 93.600 + 3.000 + 12.000 = 108.600 | 108.600 | 108.600 |
| Comisiones pendientes / crédito | 72.600 + 12.000 = 84.600 / 4.000 | 84.600 / 4.000 | 84.600 / 4.000 |
| Bases entregadas / devueltas / pendientes | 30.000 + 10.000 = 40.000 / 20.400 + 9.600 = 30.000 / 10.000 | 40.000 / 30.000 | 40.000 / 30.000 / 10.000 |
| Gastos / nómina | 10.000 / 5.000 | 10.000 / 5.000 | 10.000 / 5.000 |
| Clientes (normal + por hora) | 15.000 + 115.000 = 130.000 | 15.000 / 115.000 | 130.000 |
| Utilidad | 108.600 − 10.000 − 5.000 = 93.600 | — | 93.600 |
| Capital a dejar (objetivo 300.000) | 300.000 − (10.000 + 84.600 + 15.000 + 115.000) = 75.400 | — | 75.400 (37.700 + 37.700) |

### F.5 Diferencias encontradas

Ninguna sin explicar. El botón de Excel generó 16.574 bytes y el endpoint 16.573: es la marca de tiempo interna del archivo. Las cifras son idénticas.
