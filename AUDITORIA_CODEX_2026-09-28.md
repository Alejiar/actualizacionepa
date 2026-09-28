# Auditoría independiente de Cash Buddy EPA

Fecha: 28 de septiembre de 2026. Proyecto: `C:\cash-buddy-epa`. Rama: `main`. Commit auditado: `783ecb1e9ae1c1c1c52195463dc16ea04076d55e`.

**Dictamen: no está listo para certificar una entrega confiable.** Hay errores reproducidos que afectan deuda, crédito, cobros, estadísticas, reportes y saldos históricos. Compilar sin errores no detecta estos problemas.

Esta entrega es una auditoría: no se corrigió ni desplegó código de la aplicación y no se modificó su base operativa. Se ejecutaron servicios y controladores reales sobre PostgreSQL local en la base exclusiva `cashbuddy_audit_codex_20260928`, creada vacía y con las migraciones del proyecto. Los pedidos y personas de las pruebas son ficticios. No se arrancó el servidor de producción ni el planificador de tareas para probar.

## Resultado y método

- Se reprodujeron las ocho diferencias R1–R8 del contexto preparado por Claude. R7 requiere distinguir una decisión de alcance temporal de un error de saldo: el comportamiento se reproduce, pero no justifica cambiar silenciosamente la definición del reporte.
- Se añadieron pruebas independientes de concurrencia, límites de reportes, limpieza histórica, recepción de pedidos, abonos de clientes y eliminación de pedidos manuales.
- 28 comprobaciones registradas: 21 discrepancias y 7 resultados coincidentes. **Son escenarios, no 21 causas distintas**; las causas se agrupan abajo. Una discrepancia de presentación con regla de negocio por definir no equivale por sí sola a pérdida de dinero.
- Pasaron las verificaciones TypeScript de backend y frontend (`--noEmit --incremental false`). No se reconstruyeron los archivos que sirve la aplicación instalada.
- Los casos R1–R8/C1–C3 reutilizan el script entregado por Claude, ejecutado nuevamente contra una base nueva. N1–N14 son comprobaciones añadidas por Codex; los datos y salidas están conservados.
- Las pruebas de polling usan respuestas HTTP simuladas y el código real de sincronización. No prueban la conexión, las tarifas ni los límites actuales de una cuenta real de Shipday.

## Hallazgos que deben corregirse antes de entregar

P1 indica un error que puede alterar o esconder dinero o producir resultados operativos incorrectos. P2 indica inconsistencia de información o alcance que debe resolverse y verificarse.

### F01 — P1: los cobros y ajustes simultáneos pierden cambios

**Reproducido: N1 y N3.** Deuda inicial de $30.000; dos cobros simultáneos de $10.000 se guardan como ingresos por $20.000, pero queda deuda de $20.000 en vez de $10.000. Dos entregas de base por $10.000 y $20.000 se guardan por $30.000, pero el saldo terminó en $10.000.

`driver.service.ts:107,195` lee el saldo antes de la transacción y luego lo sobrescribe. El propio `applyDebtDelta` (`:23–40`) lee y escribe sin bloquear la fila; ponerlo dentro de una transacción no hace atómica esa operación de lectura/cálculo/escritura. `base.service.ts:84` lo usa.

Corrección necesaria: serializar todas las mutaciones de un mismo domiciliario o aplicar un cambio neto atómico; incluir lecturas del reparto base/comisión en la misma protección. Validar la estrategia también en reversiones y cobros bancarios. Las dos operaciones deben reflejarse completas o rechazarse de forma explícita y recuperable.

### F02 — P1: el mismo crédito puede pagarse dos veces

**Reproducido: N2.** Crédito de $10.000, dos llamadas simultáneas a pagar crédito: ambas aceptadas, egresos por $20.000, crédito final $0.

Causa: `driver.service.ts:419–456` comprueba el crédito antes de la transacción y después lo pone en cero. Corrección: validación y consumo atómicos, con protección ante repetición de la misma operación. Un crédito de $10.000 debe generar un único pago de $10.000.

### F03 — P1: editar un cobro o un pago de crédito no corrige su efecto contable

**Reproducido: R4 y N7.** Cobro editado de $20.000 a $15.000: caja reconoce $15.000, pero `debtApplied` y el pago interno siguen en $20.000; la deuda queda $5.000 menor de lo debido. Un egreso de crédito reducido de $10.000 a $5.000 tampoco devuelve los $5.000 restantes al crédito.

Causa: `edit-request.service.ts:359–362` actualiza únicamente el movimiento bancario. Corrección: revertir y reaplicar el efecto con sus registros vinculados en una operación protegida, o impedir la edición contable y ofrecer una reversión/corrección trazable. Mantener ambos signos de `debtApplied`.

### F04 — P1: varias escrituras producen deudas negativas o deuda y crédito simultáneos

**Reproducido: R1, R2, R5, R6.** Reducir un pedido ya pagado deja deuda de −$15.000 en lugar de crédito por $15.000: el domiciliario desaparece de ambas listas. Un pedido manual puede mostrar deuda de $6.000 y crédito de $10.000 cuando solo corresponde crédito de $4.000.

Causas: incrementos directos en `edit-request.service.ts:416,504` y `controllers/order.controller.ts:44`. En estos cuatro casos la resta deuda−crédito conserva el neto, pero se rompe la representación y los filtros. Por lectura, la misma familia existe al editar/borrar `DriverPayment` y en `recalcAllOrders`; estas variantes no se ejecutaron.

Corrección: unificar el cálculo de deuda/crédito, con la protección de concurrencia de F01. Para datos existentes, normalizar una representación no equivale a reconstruir o certificar el saldo histórico.

### F05 — P1: el reporte mensual suma solo veinte domiciliarios

**Reproducido: N4.** Con 21 domiciliarios que deben $3.000 cada uno, la deuda agregada es $63.000, pero Reportes muestra comisión pendiente por $60.000.

Causa: `close.service.ts:119–120` corta la lista a veinte antes de sumar. La proyección de capital también consume ese total (`:207,224`). Corrección: calcular el total completo y limitar exclusivamente el detalle visual.

Por lectura, existe otro límite en Deudas: el backend retorna como máximo cien deudores y cien acreedores (`shipday-dashboard.service.ts:234,240`) y la página calcula sus totales sobre esas listas (`shipday/deudas/page.tsx:56–57`). Ese umbral no se ejecutó en esta auditoría.

### F06 — P1: la limpieza automática destruye información financiera todavía necesaria

**Reproducido: N8 y N12.** Una base pendiente de $50.000 con más de dos meses deja de aparecer como base, aunque sigue en la deuda del domiciliario. Con un cierre ancla anterior a esa base, el efectivo esperado cambia de $335.000 a $385.000 después de la limpieza: no hubo un ingreso.

Causa: `order-cleanup.service.ts:38–55` elimina pedidos, bases, cobros y otros registros sin conservar un libro o ancla suficiente. Se ejecuta al arrancar y cada 24 horas (`:73,77`). En N8, sin el cierre antiguo, no cambió el efectivo: la comprobación de esa consecuencia específica es N12.

Corrección: conservar la historia financiera o archivarla con saldos y referencias verificables antes de eliminarla. No intentar reconstruir producción con una fórmula parcial ni ejecutar una reparación masiva basándose en historia ya eliminada.

### F07 — P1: cargar pedidos desde hoy crea crédito sin dinero nuevo

**Reproducido: R8.** Pedido anterior con comisión de $30.000, ya pagada: tras la acción aparece crédito de $30.000.

Causa: `branch.service.ts:468–502` elimina pedidos anteriores, conserva pagos y reconstruye el saldo con una fórmula incompleta. Además, esos cambios permanecen si la sincronización posterior falla, como ocurrió en la prueba con clave ficticia.

Corrección: definir un corte de importación que preserve las obligaciones y su historia. La acción debe tener semántica explícita de corte/saldo inicial, no convertir pagos anteriores en crédito artificial.

### F08 — P1: un pedido con tarifa puede quedar sin cobrar permanentemente

**Reproducido: N6 y N9.** El webhook recibe un pedido de $10.000 antes de que exista el domiciliario local. Después se registra el domiciliario y se reenvía el pedido o ejecuta polling: sigue sin asignación y sus $3.000 de comisión no se aplican. En la prueba combinada el saldo fue $6.000, debía ser $9.000.

Causa: el webhook descarta cualquier pedido existente (`webhook.controller.ts:104–105`) y el polling solo repara los de valor cero (`branch.service.ts:339–345`). Corrección: reconciliar asignaciones pendientes de pedidos ya existentes, aplicar la comisión una sola vez y respetar eliminaciones autorizadas.

### F09 — P1: un abono nuevo cambia el historial de cobros anteriores

**Reproducido: N11.** Dos abonos de $10.000 en días distintos sobre la misma deuda: al registrar el segundo, el efectivo esperado de ayer pasa de $310.000 a $300.000.

Causa: `client.service.ts:191,196–197` guarda acumulados de efectivo/banco bajo una única fecha `paidAt`, reemplazada con cada abono. `shipday-dashboard.service.ts:91` filtra esos acumulados por esa fecha. Se configuró la fecha del primer abono en el fixture para representar el día anterior; el segundo pasó por el servicio real.

Corrección: conservar cada abono con fecha, monto, medio y reversión propios. Los reportes y cierres deben sumar eventos, no trasladar todos los abonos a la fecha del último. No alcanza con quitar un filtro.

### F10 — P2: Historial omite los abonos parciales

**Reproducido: N13.** Un abono de $10.000 a una deuda de $20.000 no incrementa los ingresos ni las deudas cobradas del resumen diario.

Causa: `day.service.ts:168` selecciona solo deudas `paid: true`. Corrección junto con F09: reconocer cada abono efectivo aunque todavía quede deuda.

### F11 — P2: editar pedidos nocturnos deja estadísticas desactualizadas

**Reproducido: R3.** Pedido del 10 de septiembre a las 21:30 de Bogotá, editado de $10.000 a $20.000: estadística conserva $10.000/$3.000 en vez de $20.000/$6.000.

Causa: `edit-request.service.ts:422` busca la fecha UTC. Corrección: usar el día Bogotá y probar antes/después de las 19:00 y medianoche.

### F12 — P2: borrar un pedido provisional resta un pedido que nunca se contó

**Reproducido: N5.** Un pedido válido más un provisional de $0; eliminar el provisional deja cero pedidos en la estadística y comisión por $3.000.

Causa: `edit-request.service.ts:104–118` decrementa el conteo al borrar aunque el provisional no lo incrementó. Corrección: revertir exactamente el efecto originalmente aplicado; considerar también editar un provisional a tarifa positiva.

### F13 — P1: eliminar un pedido manual deja viva la deuda que generó al cliente

**Reproducido: N14, deuda sin abonos.** Se crea pedido manual de $20.000 con la opción de cobrarlo al cliente. Se aprueba eliminar el pedido: desaparece, pero el cliente sigue debiendo $20.000.

Causa: `order.controller.ts:54–65` genera `ClientDebt` al crear; el borrado de `ShipdayOrder` en `edit-request.service.ts:91–135` revierte al domiciliario y las estadísticas, pero no esa deuda. Falta una relación de origen que permita una reversión inequívoca.

Corrección: vincular pedido y deuda y definir su corrección conjunta. Si ya hubo abonos, no borrar esos movimientos ni sus pruebas: exigir una reversión contable trazable. Ese caso pagado no se ejecutó.

## Diferencia que necesita una definición de negocio

**F14 — P2, R7:** Deudas muestra $80.000; Reportes muestra $0 de base del mes y $30.000 de comisión, porque la base de $50.000 fue entregada el mes anterior. `close.service.ts:79–120` combina base del mes con comisión pendiente viva calculada usando bases de toda la historia.

La diferencia existe. El cambio anterior documenta que limitar las bases al mes fue intencional. Por tanto, la solución debe explicar por separado actividad del mes, saldo anterior y saldo pendiente actual, sin cambiar la definición unilateralmente. La proyección ya consume `diffAllTime`, pero el panel no explica esa conciliación.

## Otros riesgos comprobados por lectura, sin explotación ni reproducción completa

- `PATCH /settings` pasa autenticación y autorización del equipo, pero no exige administrador (`routes/index.ts:85`). El esquema permite cambiar `initialCash` y `initialBank`, que anclan el saldo. Verificar y restringir quién debe tener ese permiso.
- `applyChanges` carece de una lista permitida de campos por entidad. Una solicitud aprobada puede alterar campos que tienen efectos contables distintos; validar campos y montos en servidor.
- Registro de cuentas público (`routes/index.ts:51`). No significa acceso automático desde un equipo remoto: existe una puerta de equipos. Revisar el alcance esperado junto con los permisos de configuración.
- La sincronización devuelve resultados parciales si falla una página posterior; `syncBranch` puede marcar el ciclo como correcto pese a la recuperación incompleta. Diferenciar completado de parcial y conservar el error/cursor.
- La reparación concurrente del mismo provisional lee su estado antes de la transacción y lo actualiza sin condición sobre el valor anterior. En dos ejecuciones concurrentes de esta auditoría **no se reprodujo** doble aplicación: ambas quedaron correctas. Eso no prueba exclusión mutua; se requiere una prueba de intercalación controlada antes de declararla segura.
- Utilidad de clientes por hora, Excel, arqueos editados y otras rutas pendientes del documento de Claude siguen necesitando pruebas específicas.

## Controles que sí pasaron

1. C1: revertir pago de crédito y después su ingreso original restaura la deuda esperada.
2. C2: reenviar por webhook un pedido eliminado con lápida no lo recrea.
3. C3: recibir un provisional de $0 no genera deuda.
4. C4: polling con datos simulados completa tarifa y domiciliario de un provisional y aplica su comisión.
5. C5: repetir secuencialmente ese polling no vuelve a sumar deuda.
6. N10 y N10b: las dos ejecuciones concurrentes de polling ensayadas quedaron correctas; no son una garantía general de concurrencia.

## Orden propuesto para la fase de corrección

1. Preservar historia y respaldos; resolver limpieza destructiva y la acción de corte que altera saldos.
2. Hacer atómicas las mutaciones monetarias: cobros, créditos, bases, sincronización y reversiones. Repetir N1–N3 y añadir solicitudes repetidas.
3. Corregir ediciones y saldos normalizados; enlazar y revertir todas las entidades derivadas.
4. Corregir sumas, fechas, abonos y conciliación entre pantallas. Acordar la presentación de saldos históricos en el reporte mensual.
5. Repetir la batería completa y pruebas de interfaz contra una copia aislada; comparar reportes, Excel, caja y deudas operación por operación.
6. Auditar una copia de la base realmente usada por el negocio antes de proponer reparación de saldos existentes. Solo entonces preparar despliegue y verificación posterior.

## Evidencia, reproducción y límites

Carpeta de evidencia: `C:\LayaJarvis\auditoria-epa`. Archivos principales:

- `reproduccion.json`: R1–R8, C1–C3.
- `adicionales.json`: N1–N8.
- `sync-clientes.json`: N9, C4, C5, N10, N11, N10b, N12.
- `clients.json`: N13 y N14.
- `repro.ts`, `extra.ts`, `sync.ts`, `followup.ts`, `clients.ts`: casos ejecutados; `run.cjs`: creación y selección protegida de la base aislada.
- `migrations.log`, `reproduccion.log`, `adicionales.log`, `sync-clientes.log`, `followup.log`, `clients.log`: salidas de ejecución.

Nota de ejecución: la primera invocación de TypeScript falló por una restricción del entorno Windows y se repitió con el permiso de ejecución correspondiente. La primera prueba N12 tenía un fixture `MonthlyClose` incompleto; se corrigió el fixture y N12 se completó mediante `followup.ts`. Los resultados anteriores a ese error se recuperaron del log. Ninguno de esos errores del arnés se cuenta como defecto de la aplicación. El arnés conserva comparaciones, pero sus códigos de salida indican ejecución, no ausencia de discrepancias: consultar los JSON.

La base usada por el negocio en otro equipo no fue inspeccionada. No se afirman montos de pérdida real, ni se identifican personas afectadas en producción. La información del contexto acerca de que la base de este PC está vacía y de su webhook no configurado no se volvió a verificar. No hubo pruebas de interfaz punta a punta, API real de Shipday, reinicios del lanzador ni validación integral de Excel/por hora. Este informe es una auditoría del código y de los escenarios enumerados, no una certificación de todos los flujos.

Al iniciar y al terminar las pruebas, Git conservó los mismos cambios previos: `apps/api/package.json` modificado, `CONTEXTO_AUDITORIA.md` y `apps/api/scripts/simulate-3months.ts` sin seguimiento. La entrega del informe añade únicamente documentación; no reemplaza esos cambios.
