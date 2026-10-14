# Verificación total de EPA Domicilios — matriz, conciliación y evidencia

Fecha: 14-oct-2026. Código `db6f17d`. Detalle de la auditoría en `CLAUDE_AUDITORIA_Y_CORRECCION_FINAL.md`.

**Tipos de prueba:**
- **[A]** automatizada en base temporal;
- **[UI]** interfaz servida por la app (`localhost:4000`, la misma de la ventana);
- **[F]** datos ficticios en la DEMO, por endpoints reales;
- **[V]** pedido **real** de Shipday importado por solo lectura en la DEMO.

**Shipday simulado ≠ Shipday real:** [A] usa respuestas simuladas; solo [V] usa datos reales.

## 1. Matriz de funcionalidades

| Funcionalidad | Escenario probado | Entrada | Esperado | Obtenido | Impacto financiero | Persistencia | Evidencia | Estado |
|---|---|---|---|---|---|---|---|---|
| Pedido Shipday: stub $0 → tarifa real | Webhook a $0; luego sondeo con tarifa | $0 y luego $15.000 | Se sana una vez: $15.000, comisión 4.500, deuda 4.500 | Igual | Deuda +4.500; caja 0 | Sí (reconexión) | [A] DOM01 | OK |
| Reintentos y duplicados | 5 webhooks repetidos + 2 sondeos | Mismo pedido | 1 pedido, 1 comisión | 1 / 4.500 | Sin doble deuda | Sí | [A] DOM01, S02b, I12 | OK |
| Pedido real Shipday | Importación de hoy, 25 pedidos | Sucursal real (lectura) | Comisión = 30 % de cada tarifa; deuda = suma por domiciliario | 25/25; $282.000 → $84.600; 14/14 domiciliarios cuadran | Deuda +84.600 | Sí (reinicio) | [V] consultas en `cashbuddy_demo` | OK |
| Recorrido del pedido real #22 | Base y pago ficticios | Tarifa 40.000; base 10.000; pago 22.000 en efectivo | Comisión 12.000; deuda 0; efectivo +12.000 neto; comisión pendiente −12.000 | Igual | Efectivo 106.600 → 118.600 | Sí | [V]+[F] `demo-pedido-real.ts` | OK |
| Pedido manual | 3 pedidos | 10.000 / 8.000 / 12.000 | Comisión 3.000 / 2.400 / 3.600 | Igual | Solo deuda | Sí | [F] `demo-escenario.ts` | OK |
| Pedido en día cerrado | Sondeo con rezagado de un día cerrado | Ayer cerrado + pedido de hoy | Hoy se carga; ayer se omite y se avisa | Igual (antes abortaba) | Deuda solo del abierto | Sí | [A] SYNC01–03 | **Corregido (D-A1)** |
| Cancelaciones | Los cancelados no figuran en "completados" de Shipday | — | No se cargan | Por diseño del sondeo | — | — | Código (`ALREADY_DELIVERED`) | No probado con un cancelado real |
| Overrides manuales ($0 aprobado) | Sobreviven a sondeos y webhooks | — | Sin cambios | Igual | — | Sí | [A] baterías de Codex | OK |
| Base entregada / devuelta | Entrega 20.000; devolución 5.000 | Efectivo | Caja −20.000 / +5.000; deuda +20.000 / −5.000 | Igual | Caja | Sí | [F] | OK |
| Pago de domiciliario (regla base primero) | Pago 5.400 por banco | Base pendiente 15.000 | 5.400 a base; deuda 15.000; banco +5.400 | Igual | Banco | Sí | [F] reporte: bases dif. 9.600, comisión pendiente 5.400 | OK |
| Crédito a favor | Sobrepago y pago del crédito | — | Deuda y crédito nunca positivos a la vez | Igual | — | Sí | [A] Codex INTEGRATED, N2 | OK |
| Ingreso / egreso de banco | Ingreso 30.000 | Banco | +30.000 | Igual | Banco | Sí | [F], [A] | OK |
| Contrapartes | Salida 50.000 + contraparte en efectivo 50.000 | — | Total constante; diferencia 0 | Igual | Efectivo +50.000 / banco −50.000 | Sí | [F], [A] F01/PAIR | OK |
| Contraparte desigual / mismo signo | 75.000 vs 1; ingreso vs ingreso | — | 400, sin conciliar | Igual | Ninguno | — | [A] F01, I04, I05 | OK |
| Mixto efectivo + banco | 3.000 + 4.000 | — | 2 filas, cada medio por separado | Igual | Ambos | Sí | [A] F07b | OK |
| Conversión | Efectivo → banco 7.000 | — | −7.000 / +7.000 | Igual | Ambos | Sí | [F] | OK |
| Gasto con aprobación | Operador 10.000 en efectivo | — | Pendiente sin efecto; aprobado −10.000 | Igual | Efectivo | Sí | [F], [A] LOCK13 | OK |
| Cliente normal | Deuda 20.000 + abono 5.000 en efectivo | — | Deuda 15.000; efectivo +5.000 | Igual | Efectivo | Sí | [F] | OK |
| Sobrepago de cliente | Abono mayor que la deuda | — | 400 | Igual | Ninguno | — | [A] Claude 15 | OK |
| Cliente por hora | 2 h × (10.000 + 5.000) | Pago efectivo; cobro por banco | Egreso 20.000; deuda 30.000 → 0; banco +30.000 | Igual | Ambos | Sí | [F], [A] HOUR01/02, F02 | OK |
| Turnos AM/PM y Cierre diario | Cierre contado = esperado | 106.600 / 122.400 | Diferencia 0; luego 409 al registrar dinero | Igual | — | Sí | [F en base temporal] `demo-escenario.ts --cerrar` | OK |
| Cierre concurrente | Ingreso retenido en la cola | — | El esperado incluye el ingreso | Igual | — | — | [A] F04, LOCK15, LOCK20 | OK |
| Cierre mensual / capital | Capital nuevo, fechas anteriores intactas | — | Sin reescritura del pasado | Igual | — | Sí | [A] F03, LOCK16, INTEGRATED | OK |
| Períodos cerrados (D7) | Registrar, editar, borrar o aprobar en un período cerrado | — | 409, sin efectos | Igual | Ninguno | — | [A] F05, LOCK01–19, E01–E03 | OK (política conservadora) |
| Solicitudes de edición | Aprobar / rechazar / no implementada | — | Sin falsa aprobación | Igual | Según la solicitud | Sí | [A] M01, I14, LOCK11 | OK |
| Usuarios, roles, sesiones | 403 sin permiso; revocación al cambiar contraseña o rol | — | 403 / 401 | Igual (y en la DEMO al cambiar claves) | — | — | [A] S01, Claude 15; [UI] | OK |
| Configuración en solo lectura | Operador | — | Deshabilitada | Igual | — | — | [UI] M02 | OK |
| Sucursales | Desactivar conserva el historial; API key inválida → 400 | — | Igual | Igual | — | Sí | [A] SHIP01, LOCK18 | **Corregido (D-A2)** |
| Dashboard | Saldos, pedidos, deuda | Escenario DEMO | 106.600 / 122.400; 3 pedidos; 9.000; deuda 15.000 | Igual | — | — | [UI] | OK |
| Deudas | Lista y total | — | 15.000 (Demo A) | Igual | — | — | [UI] | OK |
| Historial | Apertura + ingresos − egresos = cierre | — | 200.000 + 136.000 − 107.000 = 229.000 | Igual | — | — | [UI], [F] | OK |
| Reporte mensual | Ventas, gastos, bases, comisión, contrapartes, clientes | — | 9.000 / 10.000 / 9.600 / 5.400 / 0 / 15.000 | Igual | — | — | [UI], [F] | OK |
| Excel | Hoja CIERRE MES | — | Ver §4 | Igual; sin duplicados | — | — | [F] `demo-escenario-excel.xlsx` | OK (P5 abierta) |
| Migración 34 | 33 → 34, recuperación, arranque compilado | — | — | Aprobado | — | — | [A] `run-migration34-final.cjs` | OK |
| App de Windows | Abrir, cerrar, reabrir, watchdog, persistencia | — | — | Ver `CLAUDE_PC_PRUEBAS_OPERATIVO.md` | — | Sí | Procesos, registro, salud | OK (ventana no inspeccionada visualmente) |
| Libreta de campo, Equipos, Trabajadores/nómina en pantalla | — | — | — | Sin ensayo manual propio; nómina cubierta por el INTEGRATED de Codex | — | — | — | **No verificado en interfaz** |

## 2. Conciliación general del escenario DEMO

Libro independiente; la app coincidió en **cada** paso.

| # | Operación | Efectivo | Banco | Saldo efectivo | Saldo banco |
|---|---|---:|---:|---:|---:|
| 0 | Capital inicial | | | 100.000 | 100.000 |
| 2 | Pedidos D1 / D2 / D3 (comisión 3.000 / 2.400 / 3.600) | 0 | 0 | 100.000 | 100.000 |
| 3 | Base entregada a A | −20.000 | | 80.000 | 100.000 |
| 3 | Base devuelta por A | +5.000 | | 85.000 | 100.000 |
| 4 | Pago de A (banco) | | +5.400 | 85.000 | 105.400 |
| 5 | Ingreso bancario | | +30.000 | 85.000 | 135.400 |
| 6 | Gasto aprobado | −10.000 | | 75.000 | 135.400 |
| 7 | Conversión efectivo → banco | −7.000 | +7.000 | 68.000 | 142.400 |
| 8 | Transferencia banco → efectivo (contraparte) | +50.000 | −50.000 | 118.000 | 92.400 |
| 9 | Deuda de cliente (sin desembolso) / abono | +5.000 | | 123.000 | 92.400 |
| 10 | Turno por hora (pago al domiciliario) / cobro al cliente | −20.000 | +30.000 | 103.000 | 122.400 |
| 11 | Pago de B | +3.600 | | **106.600** | **122.400** |
| V | Pedido real #22: base ficticia / pago ficticio | −10.000 / +22.000 | | **118.600** | **122.400** |

**Obligaciones al cierre:**
- Domiciliario A: 15.000 = base pendiente 9.600 + comisión 5.400.
- Domiciliario B: 0.
- Domiciliario del pedido #22: 0.
- Cliente DEMO: 15.000. Cliente por hora: 0.
- Otros 13 domiciliarios reales con pedidos: suma 72.600, de los 84.600 importados menos 12.000 pagados.
- Total domiciliarios: **87.600** = 15.000 + 72.600, igual al de Reportes.

**Totales de la DEMO comprobados contra los registros:**
- Pedidos 28, valor $312.000.
- Comisión $93.600 = 84.600 + 9.000.
- Gastos $10.000. Nómina $0.
- Bases: entregadas 30.000; devueltas 20.400 (5.000 directas, 5.400 y 10.000 dentro de pagos).
- Contrapartes con diferencia 0. Clientes 15.000.
- Historial: 200.000 + 158.000 − 117.000 = 241.000 = 118.600 + 122.400.

## 3. Pedido real (evidencia en vivo)

- Fuente: Shipday real, **solo lectura** (`GET /carriers`, `POST /orders/query`), con la API key que pegó el propietario en la DEMO.
- Importación: 25 pedidos y 57 domiciliarios. Ningún duplicado. Ningún pedido sin domiciliario.
- 2 pedidos en $0 / #00 que **Shipday reporta así** (`deliveryFee=0`, `orderTotal=0`).
- El webhook real **no** se usó: apunta a producción.
- Después de la verificación la sucursal real quedó **pausada** en la DEMO.

## 4. Excel (hoja CIERRE MES, escenario DEMO antes del pedido real)

| Fila | Efectivo | Banco | Comprobación independiente |
|---|---:|---:|---|
| 1-Domicilios (comisión) | 9.000 | | 3.000 + 2.400 + 3.600 |
| 3/4 Gastos | 10.000 | 0 | Gasto aprobado |
| 5 Bases entregadas | 20.000 | 0 | Entrega a A |
| 6 Bases devueltas | 5.000 | 0 | Solo la directa; la de 5.400 va en Movimientos |
| Movimientos ingreso | 53.600 | 65.400 | 50.000 + 3.600 / 5.400 + 30.000 + 30.000 |
| Movimientos salida | 20.000 | 50.000 | Turno por hora / transferencia |
| Deudas clientes (saldo) | 15.000 | | Cliente DEMO |

**Conciliación del efectivo:**
- Solo con esta hoja: 100.000 − 10.000 − 20.000 + 5.000 + 53.600 − 20.000 = 108.600.
- Sumando lo que está en otras hojas: + abono de cliente 5.000 (Historial) − conversión 7.000 (hoja "Conversiones") = **106.600** ✔.

**Banco:** 100.000 + 65.400 − 50.000 + 7.000 de la conversión = **122.400** ✔.

La diferencia queda explicada. La hoja no pretende ser un saldo final; incorporarlo es la decisión P5.

## 5. No verificado (y por qué)

- Producción, saldos históricos reales y caso de agosto: están en otro equipo y no hay autorización.
- Ventana WebView2 en pantalla: el propietario denegó el control de pantalla.
- Pedido cancelado real y webhook real: el webhook apunta a producción.
- Pantallas de Libreta de campo, Equipos y Trabajadores: sin ensayo propio en la interfaz.
- Instalador nuevo de Windows: no se generó.

> **Nota (segunda ronda, 14-oct-2026):** este documento describe la primera ronda. Para el estado vigente (F14 con base y comisión separadas, D7 y cobertura 124/124), consulta `CLAUDE_MATRIZ_COBERTURA_TOTAL_EPA.md` y `CLAUDE_CONCILIACION_FINAL_COMPLETA.md`. Las cifras de domiciliarios de §2 usan el modelo anterior (base dentro de la deuda).
