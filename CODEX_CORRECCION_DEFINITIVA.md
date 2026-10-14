# CODEX — Corrección definitiva de EPA Domicilios

Fecha: 14 de octubre de 2026, America/Bogota. Repositorio: `C:\cash-buddy-epa`. Rama: `claude/entrega-final`.

Base: `e198b53`, con las correcciones de Claude `0dba9c5`. Commit local de código y pruebas: **`d801079`**. No se hizo push ni despliegue. No se migró ni modificó la base operativa.

**Dictamen: APTO CON CONDICIONES para entrega local del código corregido y su ensayo con datos ficticios.** Los bloqueadores locales RG01, PF01 y PF02 quedan corregidos en los casos reproducidos. La autorización para actualizar producción y la aceptación con sus datos reales siguen pendientes. No se declara el sistema 100 % funcional en producción.

## 1. Evidencias y alcance

Se reutilizaron `CODEX_AUDITORIA_UNICA_FINAL.md`, `CODEX_VERIFICACION_FINAL_POST_CLAUDE.md`, sus reproductores y el ZIP `CODEX_VERIFICACION_POST_CLAUDE_EVIDENCIAS.zip`. Se contrastaron `CLAUDE_CORRECCION_12_DEFECTOS.md` y `CLAUDE_ENTREGA_FINAL.md` con el código y con ejecuciones nuevas.

La aceptación final registra **181 casos enumerados aprobados, cero fallidos y cero omitidos en esas baterías**: 179 casos financieros, HTTP, de seguridad y regresión, más dos casos existentes de instalación/migración. Adicionalmente se ejecutaron tres guiones específicos de migración 34, el reproductor de cifrado, tipos de API/web, compilación completa y comprobaciones del navegador. Estos controles adicionales no se suman artificialmente a los 181 casos.

Las bases utilizadas fueron PostgreSQL locales, temporales, con nombres comprobados y datos ficticios. Los nuevos reproductores rechazan una conexión que no sea el fixture local autorizado. Las llamadas externas se bloquearon o sustituyeron por respuestas simuladas. Siigo quedó fuera del alcance.

Los resultados JSON se revisaron individualmente; una salida de proceso cero no fue la fuente única del dictamen. El ZIP nuevo `CODEX_CORRECCION_DEFINITIVA_EVIDENCIAS.zip` contiene registros, resultados, reproductores, capturas y manifiesto SHA-256. Las evidencias antiguas conservan sus versiones históricas; sus dictámenes correspondían al código anterior.

## 2. Matriz de correcciones obligatorias

| ID | Causa raíz | Corrección y archivos principales | Reproducción permanente y resultado | Estado |
|---|---|---|---|---|
| RG01 | El reporte calculaba la integridad del par después de filtrar por mes, domiciliario y presentación | `close.service.ts` consulta todas las filas de los `pairId` relevantes; solo después usa las filas del período para el indicador vigente | E04/E06; PAIR01–PAIR08; reporte, Excel y proyector coherentes | Corregido |
| PF01 | Guardias parciales y rutas alternativas de escritura, edición, eliminación y aprobación | `period-guard.ts` y servicios de dinero; controles dentro de `moneyTransaction`, con el mismo candado que los cierres; corte histórico en `shipday-dashboard.service.ts` | E01–E03; LOCK01–LOCK20; rechazos, rollback, concurrencia, sucursal, mes, arqueo, capital y reinicio | Corregido en los caminos ensayados |
| PF02 | La fecha del turno se guardaba como texto sin comprobar el calendario | `hourly-client.service.ts` y `period-guard.ts`: calendario gregoriano estricto, fecha de servicio abierta/no futura y desembolso con su instante real | E07; DATE01–DATE16, HOUR01/HOUR02; ningún efecto parcial de entradas rechazadas | Corregido |
| E01 | Banco solo comprobaba fechas de días anteriores al calendario actual | `bank-transaction.service.ts`: comprueba también el día actual y la fecha implícita; no sustituye entradas inválidas por ahora | POST del ingreso después del cierre: **409**; banco permanece **100.000** | Corregido |
| E02 | La aprobación delegaba en una edición bancaria sin guardia | `bank-transaction.service.ts::edit`, dentro de la transacción de revisión | Revisión rechazada; solicitud **pending**; importe **10.000** y esperado **110.000** conservados | Corregido |
| E03 | DELETE directo de `Movement` omitía el control presente en solicitudes | `movement.service.ts::deleteMovement` comprueba el período del confirmado | DELETE administrativo: **409**; efectivo **110.000** y movimiento conservados | Corregido |
| E04 | Solo se examinaba la contraparte del mes consultado | `close.service.ts`: integridad global del grupo, sin cambiar sus fechas ni crear compensaciones | Dos filas en meses distintos, neto global **0**; no se etiqueta como par roto; indicador actual **0** | Corregido |
| E06 | El filtro `driverId:null` excluía la contraparte legítima | Misma corrección RG01; atribuir un domiciliario no descuenta automáticamente su deuda | Salida/ingreso de **10.000**, uno con domiciliario: diferencia **0**, `ok:true` | Corregido |
| E07 | `2026-02-31` pasaba a turno, deuda y salida de dinero | Validación antes de cualquier escritura, dentro de la transacción | HTTP **400**; cero turnos/cero movimientos; deuda **0** y cambio de efectivo **0** | Corregido |

Los E01–E08 están en `apps/api/tests/codex-final-edges.ts`. La ampliación está en `apps/api/tests/codex-definitive.ts`. Los catorce casos originales, con I09 actualizado, están en `apps/api/tests/codex-independent-final.ts`.

## 3. Defectos adicionales encontrados y corregidos

| ID | Causa y reproducción | Corrección | Prueba / resultado |
|---|---|---|---|
| HOUR01 | Un cliente por hora con saldo 20.000 y sin turnos podía confirmar un cobro sin crear ingreso real | Antes del FIFO se exige que la suma pendiente de turnos coincida con el saldo; una inconsistencia histórica requiere conciliación, sin ajustar dinero arbitrariamente | Cobro rechazado **400**; saldo 20.000 y cero movimientos. Antes: faltaba el rechazo, evidencia `hourly-before-fix.json` |
| HOUR02 | Un turno con tarifa inicial del domiciliario cero no tenía egreso; editarlo a una tarifa positiva modificaba deuda pero omitía el dinero | Si la corrección abierta genera pago y no existe su movimiento, se crea el egreso enlazado, con la fecha y actor del pago original | Turno pasa de 8.000 a 40.000; egreso **24.000**, deuda **40.000**, efectivo **76.000**. Antes: efectivo 100.000 |
| INPUT01/INPUT05 | Los controladores convertían medios desconocidos de clientes normales/por hora a efectivo; horas numéricas podían provocar error no controlado | Los controladores pasan el medio al servicio; se valida el valor y los tipos de hora | Medio `card` y horas inválidas: **400**, sin abonos ni movimientos |
| INPUT02/INPUT03 | Las bases redondeaban fracciones e ignoraban totales contradictorios; faltaba el límite de la suma | `base.service.ts` usa la validación monetaria antes de redondeos derivados y exige total coherente con el split | Fracción, total 99.999 frente a split 10.000 y desborde: **400**, sin base ni deuda |
| INPUT04 | El webhook sustituía una fecha textual inválida por el instante actual | Calendario y fecha de entrega inválida/futura rechazados antes de persistir | Tres variantes: **400**, ningún pedido |
| LOCK14 | Cambiar capital inicial, borrar cierres o usar un reset podía desproteger la historia | Se rechazan cambios de capital con cierres, eliminación de cierres y reset con historia cerrada; arqueo alternativo también usa la guardia | **409**, cierre intacto; cambios de nombre sin efecto financiero siguen permitidos |
| UI01 | La validación estricta introdujo un rechazo en el frontend que aún enviaba hoy al mediodía, futuro antes de las 12 | Ambos formularios `BankTransactionWizard.tsx` y `UnifiedBankWizard.tsx` envían el día; el servidor usa ahora para hoy y mediodía Bogotá para fechas anteriores válidas | Fallo reproducido y capturado; tras recompilar, ingreso **12.345** persistido una vez y banco **112.345** |
| MIGSAFE | El runner antiguo eliminaba por nombre una base de prueba que pudiera existir previamente | Preflight dentro del runner: conserva y rechaza nombres ya existentes, sin `DROP IF EXISTS` | Las dos pruebas de migración existentes siguen aprobadas |

HOUR01 y HOUR02 se reprodujeron antes de corregirse y constan como dos fallos en la ejecución de 52 casos conservada en el ZIP. UI01 fue una regresión introducida durante esta implementación y se resolvió antes de entregar. Los controles de tiempo y LOCK20 refuerzan la consistencia alrededor del candado; LOCK20 también pasó antes del refuerzo, por lo que **no se presenta como un defecto previo confirmado**.

## 4. Protección financiera y contratos conservados

La comprobación de período abierto se realiza dentro de la transacción financiera que aplica el efecto. Los cierres y las escrituras usan el candado PostgreSQL común. Se cubren banco, caja, bases, pagos/crédito, préstamos y abonos, conversiones, turnos y cobros por hora, pedidos manuales, webhook, sondeo, recálculo y solicitudes administrativas.

En una corrección o reversión se verifica la fecha del registro afectado. Para un grupo mixto se verifican sus partes; al romper un par se verifican también las filas supervivientes. Para un turno se verifican su fecha de servicio, pago y movimientos enlazados. Una aprobación fallida revierte conjuntamente la entidad, deuda, dinero y estado de la solicitud.

Los importes y medios se conservan; no hay ingresos ficticios ni corrección automática de datos históricos. Los cierres diarios preservan su esperado registrado y su corte. Un cierre mensual posterior del mismo día no reemplaza ese esperado. Los cierres mensuales mantienen sus snapshots; no se habilitó su eliminación ni la reescritura de su capital mediante solicitudes.

Una contraparte de un original cerrado puede registrarse en el período actual abierto, como ya hacía el contrato vigente. Se puede actualizar el vínculo de conciliación; no se cambia el importe ni la fecha del original ni el snapshot del cierre. Romper posteriormente una pareja con una mitad cerrada se rechaza. El reporte mantiene sus reglas actuales para pares íntegros y expone los realmente desbalanceados. La regla empresarial de reconocimiento entre meses y F14 no se redefinieron.

La caja sigue admitiendo la fecha operativa siguiente que abre el cierre diario. Los módulos con fecha de dinero `Date` se validan por día calendario de Bogotá: si ese día ya tiene cierre final, su nueva entrada se rechaza; no se desplaza silenciosamente al día siguiente. Ampliar la fecha operativa de esos módulos requiere una definición del propietario. Esta restricción conservadora forma parte de las condiciones de entrega.

El servicio por hora puede tener una fecha anterior válida y abierta, mientras el desembolso se registra hoy. No se redatan pagos físicos para simular que ocurrieron el día del servicio. Los instantes de nuevas operaciones se toman después del candado; se espera al siguiente tick si coinciden con el corte mensual, sin fabricar un instante futuro.

## 5. Escenario integrado aceptado

Con administrador, operador, sucursal, domiciliario, cliente normal y cliente por hora ficticios, se inició con **100.000 efectivo / 100.000 banco**. Se ejecutaron ingresos, gasto aprobado, conversión, pedido entregado con comisión empresarial de 3.000, entrega/devolución de bases, pago del domiciliario, préstamo y abono, turno y cobro por hora, transferencia mixta con contraparte, nómina y devolución del crédito generado por un sobrepago.

Los resultados se compararon con ecuaciones escritas independientemente de la función de saldo:

```text
Efectivo = 100000 -10000 -5000 -20000 +5000 -20000 -12000
           +4000 -2000 +5000 -2000 +18000 = 61000
Banco    = 100000 +30000 +5000 -5000 +8000 +7000 -3000 -3000 = 139000
```

Deuda del cliente normal: **13.000**. Deuda por hora: **16.000**. Deuda y crédito del domiciliario: **0 / 0**. Reporte: ventas empresariales de pedidos **3.000** y deuda viva de clientes **29.000**, conforme al contrato actual.

Historial, reporte y Excel se contrastaron. El cierre diario guardó **61.000 / 139.000**, diferencias cero. Una corrección posterior se rechazó y su solicitud permaneció pendiente. Se ejecutó un cierre mensual, se verificó la conservación del día cerrado y una entrada válida de 2.000 en la fecha operativa siguiente. Después de desconectar Prisma y reiniciar el servidor de ensayo se conservaron cierres, deudas y saldos.

También se probaron contrapartes simultáneas, reenvíos de webhooks, aprobaciones concurrentes, rollback, un lote externo con un elemento cerrado y dos conexiones compitiendo por el candado. La idempotencia se comprobó en operaciones con identidad existente: pedido, contraparte, solicitud, cierre y pago de turno/crédito. No se inventó deduplicación por importe para dos ingresos independientes legítimos; antes de reintentar una entrada manual con respuesta de red incierta debe comprobarse su persistencia.

## 6. Migración, frontend y backend

La migración 34 `User.tokenVersion` permanece intacta. Se ensayaron instalación vacía, actualización exacta **33→34**, conservación de usuario/hash, arranque, cambio de contraseña y revocación inmediata de tokens, restauración después de un fallo provocado y compatibilidad con el backend compilado. Con esquema 33 el backend compilado termina con salida **1** antes de escribir usuarios; con 34 devuelve salud, login y `/auth/me` **200**.

La migración asigna `tokenVersion=0`: **por sí sola no revoca todos los tokens antiguos**. La compatibilidad del token antiguo en versión cero se comprobó; tras cambiar contraseña ambos tokens anteriores recibieron **401**, y la sesión nueva **200**. Si el propietario exige una revocación global al desplegar, debe autorizar y planificar esa acción separadamente.

El frontend compiló 31 páginas exportadas. El navegador, mediante la herramienta de computer-use y solo contra el fixture local, verificó tres botones de guardado deshabilitados para el operador, el ingreso bancario real del formulario y un administrador con respuesta 503 simulada que mostró solamente error. API/web aprobaron tipos. El build completo shared + web + API terminó con salida cero. No se compiló el instalador completo de Windows.

## 7. Entrega y condiciones

Se conservan diez archivos nuevos de pruebas/soporte y la ampliación segura del runner de migración existente. El commit `d801079` contiene únicamente código, pruebas y `.gitignore` propios. `apps/api/package.json`, `apps/web/tsconfig.tsbuildinfo` y los cuatro archivos ajenos no seguidos quedan fuera del commit y se preservan.

**NO VERIFICADOS:** saldos históricos reales, agosto, Shipday real, instalador completo Windows, configuraciones y base del otro computador. No son defectos confirmados en esta ejecución. F14 y D7 siguen pendientes y no se resolvieron inventando reglas. Los datos históricos que ya estuvieran inconsistentes no se normalizan automáticamente.

La entrega local permite revisar y ensayar el código corregido. La producción requiere el respaldo restaurable, revisión de identidad/esquema/configuración del otro equipo, las comprobaciones personales del propietario y autorización expresa. El procedimiento se incluye en `CODEX_RESULTADOS_PRUEBAS_FINALES.md`; no se ejecutó.
