# Matriz de cobertura funcional total — EPA Domicilios

Fecha: 15-oct-2026, tercera ronda (las 3 decisiones finales del dueño, §9). Rama `claude/entrega-final`, sin push. Probado en el PC de pruebas.

**Cómo se probó la interfaz:**
- Sobre una **copia** de la base DEMO (`cashbuddy_claude_ui`).
- Con la compilación de producción servida en `127.0.0.1:4918`.
- Con la **red externa bloqueada**, así que no hubo ninguna llamada a Shipday.
- La DEMO del propietario (`cashbuddy_demo`) **no recibió datos de prueba**: sigue en 118.600 / 122.400.
- En la tercera ronda solo recibió la migración 37 (aditiva), con respaldo previo.

**De dónde salen las cifras.** Todas vienen de ejecuciones reales:
- `tests/claude-cobertura.ts` lee **todas** las rutas del router;
- los formularios se pulsaron uno por uno con datos ficticios;
- cada saldo esperado se calculó a mano, aparte del sistema, y al final se contrastó con sumas SQL directas.

**Número de pruebas ≠ cobertura.** Las tablas cuentan **funcionalidades**.

## 1. Resumen por tipo de prueba

| Categoría | Descubiertas | Ejecutadas | Aprobadas | Corregidas y repetidas | Fallidas | Bloqueadas | Sin ejecutar |
|---|---:|---:|---:|---:|---:|---:|---:|
| **API**: rutas, cada una con su efecto | 124 | 124 | 124 | 5 | 0 | 0 | 0 |
| **API**: barrido de permisos (401 sin sesión / 403 operador) | 153 | 153 | 153 | 0 | 0 | 0 | 0 |
| **API**: reglas F14 / D7 / pedidos post-cierre / último admin / movimientos por medio | 29 | 29 | 29 | 3 | 0 | 0 | 0 |
| **API**: 3 decisiones finales — pedido manual tras el Cierre, turno nocturno, tarifas y trabajadores (§9) | 25 | 25 | 25 | 0 | 0 | 0 | 0 |
| **Interfaz**: pantallas × rol | 46 | 46 | 46 | 2 | 0 | 0 | 0 |
| **Interfaz**: formularios con **clic real**, criterios del §3 y §9 | 33 | 33 | 33 | 9 | 0 | 0 | 0 |
| **Interfaz**: recorridos financieros completos, con importes calculados aparte (§4 y §9.3) | 2 (12 + 12 tramos) | 2 | 2 | 0 | 0 | 0 | 0 |
| **Escritorio**: CashBuddy.exe, procesos | 9 | 9 | 9 | 2 | 0 | 0 | 0 |
| **Escritorio**: ventana WebView2 vista en pantalla | 1 | 0 | 0 | 0 | 0 | **1** | 0 |
| **Integración**: Shipday (solo lectura, simulado y red bloqueada) | 6 | 6 | 6 | 2 | 0 | 0 | 0 |
| Migraciones (instalación, 33→36, datos heredados F14) | 6 | 6 | 6 | 1 | 0 | 0 | 0 |

**Bloqueada (1):** la ventana de CashBuddy.exe **no se ha verificado visualmente**, porque el propietario denegó el control de pantalla.
- Lo que sí se comprobó: el backend que la ventana carga (`localhost:4000`) responde, se reinicia con el watchdog y ya corre la compilación nueva.
- Lo que no: no se vio la ventana en sí.

Los 15 formularios que en la ronda anterior quedaron "solo por endpoint" ahora están **todos ejecutados con clic real** (§3).

## 2. Cobertura de la API por módulo

Fuente: `apps/api/tests/claude-cobertura.json` y `claude-f14-d7.json`. En las rutas de dinero, el cambio de efectivo y banco se compara con el delta calculado aparte.

| Módulo | Rutas | Verificadas | De admin | Pruebas de efecto |
|---|---:|---:|---:|---|
| Administración (reset/recalcular) | 2 | 2 | 2 | RESET-01/02, REQ-01 |
| Banco y contrapartes | 5 | 5 | 1 | BANK-01, F14-BANK, F01*, PAIR* |
| Bases | 6 | 6 | 2 | BASE-01, F14-MIX/MES/CONC/INTEG |
| Caja y gastos (movimientos) | 8 | 8 | 3 | MOV-01, F05*, LOCK13 |
| Cierre mensual, reportes y Excel | 6 | 6 | 1 | CLOSE-01, F14-CIERRE, INTEGRATED |
| Clientes por hora | 11 | 11 | 3 | HOUR-01, HOUR01/02, F02* |
| Clientes | 9 | 9 | 1 | CLI-01, N13/N14 |
| Configuración y salud | 4 | 4 | 1 | CFG-01, M02 |
| Conversiones | 3 | 3 | 1 | CONV-01 |
| Dashboard | 5 | 5 | 0 | DASH-01 |
| Domiciliarios, pedidos y pagos | 7 | 7 | 0 | DRV-01, PAY-01, F14-A/B/C/D/SPLIT/VAL |
| Equipos (PCs) | 11 | 11 | 10 | DEV-01 |
| Historial y arqueo | 5 | 5 | 0 | DAY-01, D7-CHAIN |
| Libreta de campo | 4 | 4 | 0 | NOTE-01 |
| Movimientos unificados | 1 | 1 | 0 | **MOV-PARTS (nueva)** |
| Red | 1 | 1 | 0 | NET-01 |
| Reportes de trabajadores/nómina | 5 | 5 | 0 | WRK-01 |
| Solicitudes y aprobaciones (D7) | 4 | 4 | 2 | REQ-01, D7-EDIT/REJ/DEL/ADD/ADDMOV/MES/VAL/DUP |
| Sucursales y sincronización Shipday | 10 | 10 | 5 | BR-01/02, SYNC01–03, ORD-SYNC1/2, SHIP01 |
| Trabajadores | 4 | 4 | 1 | WRK-01 |
| Turnos y cierre diario | 6 | 6 | 1 | SHIFT-01, F04* |
| Usuarios y autenticación | 7 | 7 | 5 | AUTH-01, USR-01, PERM-03, S01*, **USR-ADMIN (nueva)** |
| Webhook Shipday | 1 | 1 | 0 | WH-01, ORD-POST, S02*, LOCK19 |

## 3. Interfaz: formularios con clic real

Cada formulario se evaluó con los mismos criterios:

- **Crear:** el formulario crea el registro.
- **Editar:** se probó donde existe edición.
- **Validación:** se probó al menos un caso inválido.
- **Permiso:** operador frente a admin.
- **Persiste:** el dato sigue tras recargar o consultar.
- **Efecto:** los saldos de efectivo y banco coinciden con el cálculo a mano.
- **Reflejo:** el cambio aparece en Deudas, Movimientos, Historial o Reportes.

**Convenciones de las tablas:**
- **✔** significa verificado.
- **—** significa que el formulario no tiene esa función.
- Las cifras van en pesos; «→» indica el valor antes y después de la acción.

### 3.1 Bases, clientes y conversiones

| # | Formulario | Creación y edición | Validación | Permiso | Efecto (a mano = sistema) y reflejo |
|---|---|---|---|---|---|
| 1 | **Entregar base** (efectivo, banco o mixta) | ✔ / — (corrección por solicitud) | Sin domiciliario o sin monto se rechaza | Operador ✔ | Mixta 7.000 + 3.000: efectivo −7.000, banco −3.000, base +10.000, comisión igual. Movimientos con desglose por medio |
| 2 | **Registrar devolución de base** (antes "Registrar pago") | ✔ | Devolver más que la base pendiente se rechaza con mensaje | Operador ✔ | Banco +4.000; efectivo +6.000; base pendiente baja exacto |
| 3 | **Cliente por hora**: crear, turno, editar turno, eliminar turno, cobro parcial y total, desactivar | ✔ / ✔ (solicitud aprobada) | Tarifas en 0 se rechazan; cobro mayor que la deuda se rechaza | Editar turno: operador por solicitud, admin aprueba. Eliminar turno: solo admin | Turno 2 h: −24.000 y deuda 36.000; edición: −12.000 y deuda 54.000; cobros +20.000 por banco y +34.000 en efectivo; eliminación revierte exacto |
| 4 | **Cliente nuevo con deuda inicial** | ✔ | Nombre vacío se bloquea; **sin elegir medio no avanza** | Operador ✔ | **Fiado:** caja sin cambio. **Préstamo:** sale de efectivo o banco. *(Defecto D-B1 corregido)* |
| 5 | **+ Deuda** (préstamo o fiado) | ✔ | Monto 0 o medio sin elegir se bloquean | Operador ✔ | Préstamo por banco 5.000: banco −5.000, deuda 9.000 → 14.000 |
| 6 | **Abonar / pagar deuda completa** | ✔ | Un abono mayor que la deuda se limita al saldo | Operador ✔ | Abono 6.000 por banco: +6.000, aplicado a la deuda más antigua. Pago total 14.000 en efectivo: deuda 0. La confirmación ahora muestra el medio |
| 7 | **Conversión** (Banco → salida con contraparte + "Registrar Ingreso … para cuadrar") | ✔ | Contraparte por valor distinto se rechaza sin mover dinero | Operador ✔ | Banco −15.000 / efectivo +15.000, con `pairId`; "sin cuadrar" = 0 |

Sobre el formulario 7: el antiguo asistente de conversión no está enlazado y `/shipday/conversiones` redirige a Banco.

### 3.2 Gastos, movimientos y Banco

| # | Formulario | Creación y edición | Validación | Permiso | Efecto (a mano = sistema) y reflejo |
|---|---|---|---|---|---|
| 8 | **Gasto** (pendiente → aprobar o rechazar) | ✔ | Monto o concepto vacío no avanza | Operador crea pendiente; aprueba o rechaza el admin | Pendiente: sin efecto. Aprobado: −6.500 / −3.000. Rechazado: sin efecto. Reportes: gastos 16.000 en efectivo + 2.500 por banco |
| 9 | **Editar o eliminar movimiento** (Movimientos → solicitud) | ✔ (operador y admin solicitan) | Sin motivo no avanza; sin cambio no avanza | Aprobación solo del admin | Gasto 6.500 → 6.000: efectivo +500. En mes cerrado la aprobación falla con mensaje y la solicitud sigue pendiente |
| 10 | **Registrar movimiento en Banco** (ingreso, salida, mixto, con o sin contraparte) | ✔ | Monto 0 no avanza | Operador ✔; borrar solo el admin | Cuadra al peso. La contraparte se fecha en el día del original |
| 11 | **Descontar de deuda** con "Parte a devolver base" | ✔ | Parte a base mayor que el pago se rechaza sin mover dinero | Operador ✔ | Ingreso 8.000 con 3.000 a base: comisión 5.400 → 400, base 9.600 → 6.600, banco sin doble conteo. El botón desaparece al aplicarse. **El admin borra el ingreso:** comisión 5.400, base 9.600, banco −8.000, y se borran los registros vinculados |

### 3.3 Domiciliarios, pedidos y caja

| # | Formulario | Creación y edición | Validación | Permiso | Efecto (a mano = sistema) y reflejo |
|---|---|---|---|---|---|
| 12 | **Registrar pago** (Deudas): comisión y base por separado | ✔ | Base mayor que la pendiente se rechaza | Operador ✔ | 6.000 a comisión + 4.000 a base en efectivo: +10.000, comisión 7.200 → 1.200, base 9.600 → 5.600. Exceso: 5.000 sobre 3.000 deja crédito 2.000 **y no toca la base** |
| 13 | **Pagar a domiciliario** (devolver crédito) | ✔ | — | Operador ✔ | Banco −2.000, crédito 0. **El admin borra el pago:** crédito vuelve a 2.000 y banco +2.000 (caso real de sep-2026) |
| 14 | **Pedido manual** (con o sin cliente vinculado) | ✔ | Valor 0 no avanza; sucursal desactivada se rechaza con mensaje | Operador ✔ | 15.000: comisión 4.500, caja igual. 6.000 vinculado: deuda del cliente 8.000 → 14.000 (fiado), caja igual |
| 15 | **Solicitar corrección de pedido** | ✔ (solicitud → aprobación) | Sin motivo no avanza | Aprueba el admin | 15.000 → 10.000: comisión 4.500 → 3.000 |
| 16 | **Caja: Recibo AM, Recibo PM, Cierre final** (billetes, monedas, banco) | ✔ | Sin nombre o sin banco no avanza; un turno no se repite | Operador ✔ | Conteo exacto: "cuadrada". PM con −600: descuadre registrado, saldo igual. El Cierre avanza el día operativo |
| 17 | **D7: corregir y agregar en día cerrado** | ✔ | Campos vacíos se rechazan | Aprueba el admin | Corrección +500 por banco y movimiento olvidado −1.000 en efectivo. El conteo del Cierre no cambia, se guardan 2 correcciones y el semáforo sigue verde |

### 3.4 Administración, cierre mensual y Excel

| # | Formulario | Creación y edición | Validación | Permiso | Efecto (a mano = sistema) y reflejo |
|---|---|---|---|---|---|
| 18 | **Sucursales**: crear, editar, activar, desactivar, probar conexión | ✔ / ✔ | Campos obligatorios vacíos no guardan; API key vacía al editar conserva la anterior | Operador sin botones y 403 | Desactivar conserva el historial. "Probar" sin red da un error controlado (tras el limitador de Shipday) |
| 19 | **Usuarios**: crear, cambiar rol, desactivar, eliminar | ✔ / ✔ | Clave de menos de 6 caracteres se rechaza; **no puede quedar sin admin activo** | Solo admin (operador 403) | Cambiar rol invalida la sesión previa (401). Usuario inactivo no entra (401). *(Defecto D-B4 corregido)* |
| 20 | **Configuración**: marca, capital inicial, porcentaje de nómina | ✔ / ✔ | Capital bloqueado si ya hay un Cierre; porcentaje mayor que 100 se limita | Solo admin (403) | Capital 100.000 → 150.000 sin cierres: esperado +50.000; restaurado al valor exacto |
| 21 | **Equipos**: autorizar con nombre, rechazar, renombrar, cerrar sistema, bloquear, reautorizar, eliminar | ✔ | El PC servidor no se puede bloquear ni eliminar | Solo admin (403) | Estados persistidos. *(Defecto D-B5 corregido: error falso al eliminar)* |
| 22 | **Trabajadores**: crear administrativo o domiciliario, activo/inactivo | ✔ / — (sin renombrar ni eliminar en la interfaz) | Nombre vacío no crea | Eliminar solo admin (403) | — |
| 23 | **Pago de nómina** | ✔ | Monto 0 no avanza | Operador ✔ | 12.000 en efectivo: −12.000, movimiento confirmado de categoría 15; Reportes: nómina 12.000 |
| 24 | **Pago de domiciliario desde Trabajadores** (otro asistente) | ✔ | Base mayor que la pendiente bloquea Siguiente | Operador ✔ | 1.200 a comisión + 600 a base por banco: +1.800, comisión 0, base 5.000. La ficha ahora muestra la base sin devolver (D-B6) |
| 25 | **Libreta**: crear, editar, eliminar | ✔ / ✔ | Nota vacía no se agrega | Operador ✔ | Persiste al recargar; la actividad aparece en Equipos |
| 26 | **Asistente de cierre mensual** | ✔ | Sin confirmar no cierra; el reparto se completa solo | Solo admin (403) | Pendientes 10.000 + 72.600 + 23.000 = 105.600. Objetivo 200.000 deja 94.400, repartidos 47.200 / 47.200. Totales del cierre = SQL |
| 27 | **Botón Excel** | ✔ | — | ✔ | Genera `cashbuddy-2026-10.xlsx` de 16.829 bytes con 6 hojas, igual al endpoint; cifras iguales al reporte |

## 4. Recorrido financiero completo (interfaz, importes calculados aparte)

Copia de la DEMO. Punto de partida: efectivo **108.600** · banco **136.200** · A [comisión 0, crédito 0, base 5.000] · B [0, 2.000, 6.000].

| Tramo | Acción en la interfaz | Esperado a mano | Sistema |
|---|---|---|---|
| J1 | Pedido manual 20.000 a B (comisión 6.000 neteada con el crédito de 2.000) | B [4.000, 0, 6.000]; caja igual | ✔ |
| J2 | Entregar base 10.000 en efectivo a B | Efectivo 98.600; base B 16.000 | ✔ |
| J3 | Devolución de base 6.000 en efectivo | Efectivo 104.600; base B 10.000 | ✔ |
| J4 | Ingreso por banco 9.000 → Descontar de deuda (5.000 a base) | Banco 145.200; B [0, 0, 5.000] | ✔ |
| J5 | Cliente paga toda su deuda, 14.000 en efectivo | Efectivo 118.600; deuda 0 | ✔ |
| J6 | Gasto 3.000 por banco, aprobado | Banco 142.200 | ✔ |
| J7 | Salida 20.000 por banco con contraparte en efectivo | Efectivo 138.600 · banco 122.200 | ✔ |
| — | Movimientos (por medio) y Resumen del día | +38.600 / +22.200; total +60.800 | ✔ (antes del arreglo D-B2 daba +4.000 / +3.000 de más) |
| J8 | Recibo AM (cuadrado), PM (−600), Cierre final (cuadrado) | Diferencia 0 / 0; Historial verde | ✔ |
| J9 | D7: gasto 3.000 → 2.500 y movimiento olvidado −1.000 en efectivo | Esperado 137.600 / 122.700; conteo 138.600 intacto | ✔ |
| J10 | Cierre mensual de octubre (asistente) | Ver la tabla de abajo | ✔ |
| J11 | Botón Excel | Cifras iguales al cierre | ✔ |
| J12 | Tras el cierre de mes: aprobar eliminación, capital, base nueva | Rechazado con mensaje; dinero igual | ✔ |

**Cifras del cierre mensual de octubre:**
- **Pedidos:** 31, por 348.000.
- **Comisión:** 104.400 (348.000 × 30 %).
- **Bases:** entregadas 50.000, devueltas 40.000, pendientes 10.000 (A 5.000 y B 5.000).
- **Comisiones pendientes:** 72.600.
- **Clientes:** 23.000.
- **Gastos:** 16.000 en efectivo + 2.500 por banco.
- **Nómina:** 12.000.
- **Utilidad:** 73.900.

**Contraste final con SQL directo** sobre la copia (no pasa por la lógica del sistema): pedidos 31 / 348.000 / 104.400; Demo A 24.000 → 7.200; Demo B 42.000 → 12.600; deuda de comisiones 72.600; bases 50.000 / 40.000; gastos 16.000 + 2.500; nómina 12.000; clientes 23.000. **Todo coincide.**

**Comprobación a mano de la deuda de comisiones (72.600):**
- Los domiciliarios reales suman 84.600 de comisión, menos 12.000 del pago ficticio del pedido #22.
- A pagó 6.000 + 1.200 = 7.200, su comisión completa.
- B tenía 12.600 = 3.600 pagados antes + 5.000 + 4.000 (el crédito de 2.000 se consumió en J1).

## 5. Defectos encontrados al pulsar los formularios (corregidos y repetidos)

| ID | Defecto | Corrección | Prueba que lo repite |
|---|---|---|---|
| D-B1 | Crear cliente con deuda inicial **sacaba efectivo por defecto**, aunque fuera un fiado | Elegir medio es obligatorio: efectivo, transferencia o "No sale dinero (fiado)" | Clic: fiado sin cambio de caja; préstamo −5.000 por banco |
| D-B2 | Movimientos contaba una base mixta en un solo medio y una conversión de un solo lado: los totales por medio no cuadraban (+4.000 / +3.000) | Desglose `parts` por medio en la API; filtros y totales por parte | MOV-PARTS (API) + clic (+10.600 / +28.400 exactos) |
| D-B3 | Banco mostraba "Efectivo→Banco" al revés ("Entró por efectivo") e inflaba el balance neto | Etiqueta y medio iguales al backend; la conversión cuenta en ambos lados | Clic |
| D-B4 | El admin podía desactivarse, quitarse el rol o eliminarse aunque fuera el **único** admin, y el sistema quedaba sin administrador | Siempre debe quedar al menos un admin activo | USR-ADMIN (API) + clic |
| D-B5 | Eliminar equipo, desactivar sucursal, eliminar conversión o eliminar nota mostraban "Unexpected end of JSON input" aunque la acción sí se aplicaba | El cliente web acepta respuestas 204 | Clic: aviso correcto en los 3 casos |
| D-B6 | La ficha del domiciliario en Trabajadores no mostraba la base sin devolver y llamaba "Deuda pendiente" a la comisión | Bases recibidas / devueltas / **sin devolver** / deuda por comisiones | Clic |
| D-B7 | Mensajes de error que decían "D7 sigue pendiente" | Texto actualizado | — |
| D-B8 | La confirmación del abono no decía por qué medio entraba el dinero; Bases decía "Registrar pago" para una devolución | Fila "Entra a" y botones renombrados | Clic |

## 6. Observaciones para el propietario (no se cambiaron: son decisiones de negocio)

1. **Registros después del Cierre, antes de medianoche:** se rechazan con un mensaje claro hasta el día siguiente o hasta una solicitud aprobada. Aplica a banco, bases y pedidos manuales.
   - No se pierde dinero.
   - Pero el encabezado ya muestra el día operativo (mañana) y el formulario de Banco propone la fecha del calendario sin permitir elegir mañana.
   - La regla "cargar en su día" que aprobó el propietario era para los pedidos de **Shipday**. ¿Deben los pedidos manuales seguirla también?
2. **Turno por hora:** un turno de 10:00 a 09:00 se toma como nocturno de 23 h sin ningún aviso.
3. **Funciones que existen en la API pero no en la interfaz:**
   - editar las tarifas de un cliente por hora;
   - renombrar o eliminar un trabajador.
4. **Recibo AM:** el texto "Persona que recibe el turno" se presta a confusión. El Recibo PM lo trata como quien cerró la mañana.
5. **Avisos de error:** se muestran con el prefijo "Error: ".

## 7. Escritorio e integración

| Proceso | Verificación | Estado |
|---|---|---|
| CashBuddy.exe: abrir, salud, un solo backend | Procesos y registro | ✔ |
| Watchdog | Backend terminado → nuevo en ~5 s. Se repitió hoy a las 17:44 para cargar la compilación nueva en la DEMO; salud OK y saldos DEMO 118.600 / 122.400 intactos | ✔ |
| Persistencia tras reinicio | Saldos iguales | ✔ |
| Ventana WebView2 en pantalla | — | **No verificada visualmente** (control de pantalla denegado) |
| Shipday: sondeos, autosanación, lápida, pedido de mes cerrado | Simulado + importación real de solo lectura (ronda anterior) | ✔ |
| Shipday en esta ronda | Red externa bloqueada; "Probar conexión" da un error controlado; ninguna llamada real | ✔ |
| Webhook Cloudflare | No se tocó (apunta a producción) | — |

## 8. Totales de ejecución (código final de esta ronda)

| Batería | Resultado |
|---|---|
| Financiera / bloqueadores / Claude completa / 12 defectos / Codex definitiva / migraciones / auditoría / cobertura | ver §8.1 (regresión completa repetida tras los arreglos) |
| F14-D7-pedidos + MOV-PARTS + USR-ADMIN | 29 / 29 |
| Formularios con clic real | 27 / 27 |
| Recorrido financiero | 12 tramos ✔, contraste SQL ✔ |
| Tipos API y web / compilación de producción | 0 errores / correcta |

### 8.1 Regresión completa

Se repitió completa, sobre bases temporales nuevas, después de todos los arreglos de esta ronda (`run-all.sh`). **11 de 11 grupos con salida 0:**

| Grupo | Resultado |
|---|---|
| Financiera (audit-clients, financial-acceptance, http-acceptance) | 0 fallas |
| Claude completa | 15 / 15 |
| 12 defectos | 26 / 26 |
| Bloqueadores post-Claude | 0 fallas |
| Migración de actualización (instalación limpia + 33→36) | ✔ |
| Codex independiente / bordes / definitiva | 14 / 14 · 8 / 8 · 53 / 53 |
| Migración 34 (normal, recuperación, compilada) | 3 / 3 |
| Auditoría final | 5 / 5 |
| F14-D7-pedidos + MOV-PARTS + USR-ADMIN | 29 / 29 |
| Migración F14 con datos heredados | ✔ (34 → 36) |
| Cobertura de rutas | 28 / 28 pasos, 124 rutas |

## 9. Tercera ronda (15-oct-2026): las 3 decisiones finales del dueño

**Decisiones implementadas:**
1. **Pedido manual tras el Cierre:** se registra con su fecha real si el mes sigue abierto. No mueve caja.
2. **Turno que cruza medianoche:** se permite, con aviso y confirmación explícita.
3. **Funciones nuevas en la interfaz:**
   - editar las tarifas de un cliente por hora;
   - renombrar trabajadores;
   - desactivar o reactivar trabajadores;
   - eliminar trabajadores solo si no tienen historial.

### 9.1 API (`tests/claude-decisiones-finales.ts`, 25 / 25)

| ID | Caso | Resultado |
|---|---|---|
| ORD-M1 | Pedido manual antes del Cierre: 10.000 → comisión 3.000, caja igual | ✔ |
| ORD-M2 | **Ejemplo del dueño:** Cierre y luego pedido de 40.000 del mismo día. Comisión +12.000; caja, banco y conteo intactos; resumen del día, `DailyDriverStat`, reporte mensual y Excel lo incluyen | ✔ |
| ORD-M3 | Día anterior cerrado con el mes abierto: se carga en ese día, no en hoy | ✔ |
| ORD-M4 | Mes cerrado → 409, sin rastro | ✔ |
| ORD-M5 | Tarifa 0, negativa, decimal, texto o fuera de rango → 400 | ✔ |
| ORD-M6 | Mismo número, sucursal y día → 409; otro día se permite | ✔ |
| ORD-M7 | Reintento con la misma clave (también simultáneo): una sola comisión. Dos pedidos distintos simultáneos suman bien | ✔ |
| ORD-M8 | Domiciliario o sucursal desactivados → 400 | ✔ |
| ORD-M9 | Fecha futura o inexistente → 400 | ✔ |
| ORD-M10 | D7 intacto: tras el Cierre, una base (mueve dinero) sigue en 409 | ✔ |
| ORD-M11 | Pedido tras el Cierre vinculado a un cliente: deuda **fiada**, caja intacta | ✔ |
| HR-1 | Turno normal: 2 h, −24.000, deuda +36.000, tarifa congelada | ✔ |
| HR-2 | Nocturno de 2 h: sin confirmar → 409 con detalle y nada cambia; confirmado → se registra | ✔ |
| HR-3 | **Ejemplo del dueño** 10:00 → 09:00: aviso de 23 horas y valores 276.000 / 138.000 / 414.000; confirmado = 1.380 min | ✔ |
| HR-4 | Rechazos sin efecto: entrada = salida, hora o fecha inválidas, fecha futura, confirmación no booleana | ✔ |
| HR-5 | Turno duplicado (doble clic y simultáneo): un solo turno y un solo pago | ✔ |
| HR-6 | Turno de un mes cerrado → 409 | ✔ |
| HR-7 | Tarifa: validación; los turnos viejos y la deuda no cambian; editar uno viejo usa **su** tarifa; los nuevos usan la nueva | ✔ |
| HR-8 | Editar a nocturno: el admin necesita confirmar; la solicitud del operador exige la confirmación y se aplica al aprobar | ✔ |
| HR-9 | Cliente o domiciliario desactivados → 400 | ✔ |
| HR-10 | Turno nocturno por banco reflejado en Movimientos y en el resumen del día | ✔ |
| WK-1 | Renombrar: mismo id, pagos enlazados, sin duplicar, nombre limpio | ✔ |
| WK-2 | Nombre vacío, solo espacios, de más de 80 caracteres o repetido (sin importar mayúsculas) → rechazo | ✔ |
| WK-3 | Desactivar: conserva el historial y bloquea pagos nuevos; reactivar los permite | ✔ |
| WK-4 | Eliminar: operador 403; con historial 409 y se conserva; sin historial el admin lo elimina | ✔ |

**Migración 37** (`hourly_shift_rate_snapshot`, aditiva):
- Probada sobre una copia de la DEMO (36 → 37). El turno real recibió su tarifa 10.000 / 5.000.
- Un turno no reconstruible queda en NULL. Se probó en una transacción revertida.

### 9.2 Interfaz con clic real (copia de la DEMO, red bloqueada)

**Pedido manual:**
- **Antes del Cierre:** P-ANTES 10.000 → B 3.000; caja igual.
- **Después del Cierre** (Cierre de hoy 118.600 / 122.400 cuadrado):
  - Al elegir la fecha aparece el aviso «🔒 Ese día ya tiene Cierre».
  - Una hora futura (21:00 a las 04:36) se rechazó: el servidor lo validó y ahora el asistente avisa antes.
  - A las 03:00: 40.000 → A 5.400 → **17.400**.
  - Efectivo y banco igual; Cierre 118.600 / dif. 0.
  - Historial del 15 en verde con comisión 15.000.
  - Pedidos lo muestra el 15 a las 03:00; Deudas, A 17.400.
- **Duplicado:** rechazado con mensaje.
- **Tras reiniciar el servidor:** todo igual.

**Turno nocturno:**
- **10:00 → 09:00:** el aviso muestra «termina mañana y tiene una duración de 23 horas», el inicio 15/10 10:00, el fin 16/10 09:00 y los valores 230.000 / 115.000 / 345.000. **Cancelar** no guarda nada.
- **23:00 → 01:00 confirmado:** efectivo −20.000 y deuda 30.000, con la tarifa congelada.
- **Entrada = salida:** mensaje claro.
- **Duplicado:** rechazado sin cobro.
- **Solicitud del operador que pasa un turno a nocturno:** pide confirmación y la tarjeta de Solicitudes lo indica. Al aprobarla, efectivo −36.000 y deuda +54.000.
- **Mes cerrado:** 409 con mensaje.

**Editar tarifas:**
- 10.000 / 5.000 → 12.000 / 6.000, con confirmación que avisa que los turnos existentes no cambian.
- Tarifas en 0 se rechazan.
- La deuda (60.000) y los turnos viejos no cambiaron.
- **Turno viejo editado** de 08:00–10:00 a 08:00–11:00: se recalculó con **su** tarifa (30.000 / 45.000) → banco −10.000, deuda +15.000.
- **Turno nuevo:** 24.000 / 36.000 con la tarifa nueva.

**Trabajadores:**
- **Alta y nómina:** alta y pago de 5.000 → efectivo −5.000.
- **Renombrar:** mismo id; la nómina pagada sigue en 5.000.
  - Vacío: botón deshabilitado.
  - Repetido: rechazado.
- **Desactivar:** confirmación; «Registrar pago» oculto; el pago por API da 400.
- **Eliminar:** con historial se rechaza con mensaje; sin historial se eliminó.
- **Reactivar:** OK.
- **Domiciliario:** al renombrarlo, avisa que el vínculo con Shipday es por nombre.

**Operador:**
- Puede renombrar, activar o desactivar trabajadores y editar tarifas, igual que antes.
- **No** ve «Eliminar trabajador»; la API le responde 403 con mensaje claro.

**Barrido:** 20 pantallas × 2 roles, sin respuestas ≥ 400 ni avisos de error.

### 9.3 Recorrido financiero de la tercera ronda (importes calculados aparte)

Copia de la DEMO, día 15. Punto de partida: 118.600 / 122.400. Las operaciones de §9.2 la dejaron en **33.600 / 92.400**:
- turno 23–01: −20.000 en efectivo;
- turno de B: −20.000 y luego −10.000 por banco;
- turno de A: −24.000 y luego −36.000 en efectivo;
- nómina: −5.000 en efectivo.

| Tramo | Acción | Esperado | Sistema |
|---|---|---|---|
| J1 | Pedido B 10.000 (con la sucursal desactivada se rechaza; tras activarla se registra) | B comisión 3.000; caja igual | ✔ |
| J2 | Base 10.000 en efectivo a A | 23.600; base A 19.600 | ✔ |
| J3 | Devolución de 5.000 por banco | banco 97.400; base A 14.600 | ✔ |
| J4 | Pago de A: 5.400 comisión + 4.600 base, en efectivo | 33.600; A [0, 0, 10.000] | ✔ |
| J5 | Ingreso por banco 7.000 → «Descontar de deuda» a B | banco 104.400; B comisión 0, crédito 4.000 | ✔ |
| J6 | Cliente por hora abona 50.000 por banco | banco 154.400; deuda 115.000 | ✔ |
| J7 | Salida 30.000 por banco + contraparte en efectivo | 63.600 / 124.400; sin contrapartes pendientes | ✔ |
| — | Movimientos por medio, registro por registro | efectivo −55.000, banco +2.000 | ✔ |
| J8 | Cierre en Caja | 63.600 / 124.400, diferencias 0 | ✔ |
| J9 | Pedido manual de A, 40.000, tras el Cierre; base y turno siguen en 409 | A 12.000; caja igual; Cierre intacto | ✔ |
| J10 | D7: movimiento olvidado −1.000 | esperado 62.600; conteo 63.600; 1 corrección | ✔ |
| J11 | Cierre mensual (objetivo 300.000) + Excel | pendientes 10.000 + 84.600 + 15.000 + 115.000 = 224.600 → dejar 75.400 | ✔ |
| J12 | Mes cerrado: pedido manual y turno de octubre → 409; reinicio → todo persiste | sin cambios | ✔ |

**Cifras del mes:**
- **Pedidos:** 30, por 362.000.
- **Comisión:** 108.600. Son los 93.600 de la DEMO + 3.000 + 12.000.
- **Comisiones pendientes:** 84.600. Son 72.600 de los domiciliarios reales + 12.000 de A.
- **Crédito a favor:** 4.000.
- **Bases:** entregadas 40.000, devueltas 30.000, pendientes 10.000.
- **Gastos:** 10.000.
- **Nómina:** 5.000.
- **Clientes:** 15.000 + 115.000 por hora = 130.000.
- **Utilidad:** 93.600.

Las mismas cifras salieron de tres fuentes: el **cálculo a mano**, las **sumas SQL directas** y el **reporte/cierre/Excel** del sistema. En el Excel, TOTAL INFORMATIVO = 84.600 + 10.000 − 4.000 = 90.600.

### 9.4 Pruebas anteriores ajustadas por las decisiones (la intención protegida se conserva)

| Prueba | Regla anterior | Regla nueva | Qué sigue verificando |
|---|---|---|---|
| codex-definitive LOCK12 | Pedido manual tras el Cierre → 409 | Se carga en su día (201) | Ingresos y egresos de Caja tras el Cierre siguen en 409; nada mueve caja |
| codex-definitive HOUR02 | Cambiar la tarifa re-preciaba un turno viejo al editarlo | El turno conserva su tarifa | Se sigue creando el egreso faltante cuando la tarifa propia del turno tiene valor para el domiciliario (40.000 / 76.000 / 24.000) |

Primer diseño descartado: había restringido al admin la edición de tarifas y de trabajadores. Las pruebas existentes (claude-12 F02, Codex I07, cobertura WRK-01 y HOUR-01) mostraron que ese permiso del operador era parte del contrato, así que se **conservó** (no se inventó una restricción). Sus expectativas **no** se cambiaron.

### 9.5 Regresión completa final (código de esta ronda)

**12 de 12 grupos con salida 0.** Las 181 pruebas anteriores más las ampliaciones de Claude:

| Grupo | Resultado |
|---|---|
| Financiera: audit-core, audit-extra, audit-sync, audit-clients, financial-acceptance, http-acceptance (45) | 0 fallas |
| Bloqueadores (18) | 0 fallas |
| Claude completa (15) | 15 / 15 |
| 12 defectos (26) | 26 / 26 |
| Codex independiente / bordes / definitiva (75) | 14 / 14 · 8 / 8 · 53 / 53 |
| Migraciones: actualización + 34 (3 guiones) + F14 con datos heredados | ✔ (ahora 35 → 37) |
| Auditoría final | 5 / 5 |
| F14-D7-pedidos + MOV-PARTS + USR-ADMIN | 29 / 29 |
| Cobertura de rutas | 28 / 28 pasos · **124 / 124 rutas (100 %)** |
| **Decisiones finales (nueva)** | **25 / 25** |
| Guía manual (E2–E18), sobre una copia de la DEMO | todas las cifras ✔ |
| Tipos API y web / compilación de producción | 0 errores / correcta |

### 9.6 Escritorio

- Se cerró CashBuddy.exe para regenerar Prisma; si sigue abierto, el motor queda bloqueado (EPERM).
- Se aplicó la migración 37 a la DEMO con el comando documentado, probado aquí.
- Se volvió a abrir CashBuddy.exe: backend nuevo a las 05:01, `/api/health` OK, saldos DEMO 118.600 / 122.400.
- La ventana **no se verificó visualmente**, porque el control de pantalla sigue denegado.
