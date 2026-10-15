# Matriz de cobertura funcional total — EPA Domicilios

Fecha: 14-oct-2026, segunda ronda. Rama `claude/entrega-final`, sin push. Probado en el PC de pruebas.

**Cómo se probó la interfaz:**
- Sobre una **copia** de la base DEMO (`cashbuddy_claude_ui`).
- Con la compilación de producción servida en `127.0.0.1:4918`.
- Con la **red externa bloqueada**, así que no hubo ninguna llamada a Shipday.
- La DEMO del propietario (`cashbuddy_demo`) **no se tocó**: sigue en 118.600 / 122.400.

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
| **Interfaz**: pantallas × rol | 46 | 46 | 46 | 2 | 0 | 0 | 0 |
| **Interfaz**: formularios con **clic real**, criterios del §3 | 27 | 27 | 27 | 8 | 0 | 0 | 0 |
| **Interfaz**: recorrido financiero completo, con importes calculados aparte (§4) | 1 (12 tramos) | 1 | 1 | 0 | 0 | 0 | 0 |
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
