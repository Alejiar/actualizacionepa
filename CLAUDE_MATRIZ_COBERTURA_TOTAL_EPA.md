# Matriz de cobertura funcional total — EPA Domicilios

Fecha: 14-oct-2026. Código: commit `bea002a` (rama `claude/entrega-final`, sin push). PC de pruebas con base DEMO.

Las cifras salen de ejecuciones reales, no de una lista escrita a mano:
- `tests/claude-cobertura.ts` lee **todas** las rutas del router y comprueba cuáles se ejecutaron y verificaron;
- el recorrido de la interfaz visitó cada pantalla con cada rol;
- las baterías financieras comprueban los efectos al peso.

**Número de pruebas ≠ cobertura.** Las tablas cuentan **funcionalidades**: rutas, pantallas, flujos y procesos.

## 1. Resumen

| Categoría | Descubiertas | Ejecutadas | Aprobadas | Corregidas y repetidas | Fallidas | Bloqueadas | Sin ejecutar |
|---|---:|---:|---:|---:|---:|---:|---:|
| Rutas de la API (cada endpoint, con su efecto) | 124 | 124 | 124 | 5 | 0 | 0 | 0 |
| Barrido de permisos (120 rutas protegidas sin sesión → 401; 33 de admin con operador → 403; sin efectos) | 153 | 153 | 153 | 0 | 0 | 0 | 0 |
| Pantallas × rol (operador y admin) | 46 | 46 | 46 | 2 | 0 | 0 | 0 |
| Flujos de interfaz con clic real | 9 | 9 | 9 | 1 | 0 | 0 | 0 |
| Formularios de interfaz ejercitados solo por su endpoint | 15 | 15 (API) | 15 (API) | 0 | 0 | 0 | 15 (sin clic) |
| Reglas financieras F14 / D7 / pedidos post-cierre | 27 | 27 | 27 | 1 | 0 | 0 | 0 |
| Migraciones (instalación, 33→36, datos heredados F14, recuperación) | 6 | 6 | 6 | 1 | 0 | 0 | 0 |
| Procesos automáticos y app de Windows | 10 | 9 | 9 | 2 | 0 | 1 | 0 |

**Bloqueada (1):** la ventana WebView2 no se inspeccionó visualmente. El propietario denegó el control de pantalla. Su contenido es la misma página verificada en `localhost:4000`.

**Sin clic (15):** formularios cuyo endpoint está verificado al 100 %, pero que no se pulsaron uno por uno en la interfaz (detalle en §4).

## 2. Cobertura de la API por módulo

Fuente: `apps/api/tests/claude-cobertura.json`. Cada ruta se ejecutó con datos ficticios y se comprobó su efecto en la base. En las rutas de dinero, el cambio de efectivo y banco se comparó con el delta calculado aparte (`money(Δcaja, Δbanco)`).

| Módulo | Rutas | Verificadas | De administrador | Pruebas de efecto |
|---|---:|---:|---:|---|
| Administración (reset/recalcular) | 2 | 2 | 2 | RESET-01/02, REQ-01 |
| Banco y contrapartes | 5 | 5 | 1 | BANK-01, F14-BANK, F01*, PAIR* |
| Bases | 6 | 6 | 2 | BASE-01, F14-MIX/MES/CONC/INTEG |
| Caja y gastos (movimientos) | 8 | 8 | 3 | MOV-01, F05*, LOCK13 |
| Cierre mensual, reportes y Excel | 6 | 6 | 1 | CLOSE-01, F14-CIERRE, INTEGRATED, demo-escenario |
| Clientes por hora | 11 | 11 | 3 | HOUR-01, HOUR01/02, F02* |
| Clientes | 9 | 9 | 1 | CLI-01, N13/N14 |
| Configuración y salud | 4 | 4 | 1 | CFG-01 (cada campo: guardar, persistir, inválido), M02 |
| Conversiones | 3 | 3 | 1 | CONV-01 |
| Dashboard | 5 | 5 | 0 | DASH-01, interfaz |
| Domiciliarios, pedidos y pagos | 7 | 7 | 0 | DRV-01, PAY-01, F14-A/B/C/D/SPLIT/VAL |
| Equipos (PCs) | 11 | 11 | 10 | DEV-01 (PC servidor protegido + ciclo completo de un PC remoto) |
| Historial y arqueo | 5 | 5 | 0 | DAY-01, D7-CHAIN |
| Libreta de campo | 4 | 4 | 0 | NOTE-01 |
| Red | 1 | 1 | 0 | NET-01 |
| Reportes de trabajadores/nómina | 5 | 5 | 0 | WRK-01 |
| Solicitudes y aprobaciones (D7) | 4 | 4 | 2 | REQ-01, D7-EDIT/REJ/DEL/ADD/ADDMOV/MES/VAL/DUP |
| Sucursales y sincronización Shipday | 10 | 10 | 5 | BR-01/02, SYNC01–03, ORD-SYNC1/2, SHIP01 |
| Trabajadores | 4 | 4 | 1 | WRK-01 |
| Turnos y cierre diario | 6 | 6 | 1 | SHIFT-01, F04*, demo-escenario --cerrar |
| Usuarios y autenticación | 7 | 7 | 5 | AUTH-01, USR-01, PERM-03, S01* |
| Webhook Shipday | 1 | 1 | 0 | WH-01, ORD-POST, S02*, LOCK19 |
| **Total** | **124** | **124 (100 %)** | **33** | |

## 3. Interfaz: pantallas por rol

Recorrido automatizado en el navegador sobre la app real (`localhost:4000`), buscando errores de consola, respuestas ≥ 400, avisos de error y texto de error.

| Pantalla | Operador | Admin | Nota |
|---|---|---|---|
| Dashboard, Caja, Arqueos→Caja, Banco, Clientes, Configuración (solo lectura para operador), Domiciliarios, Gastos, Historial, Libreta, Movimientos, Nómina→Trabajadores, Bases, Conversiones→Banco, Deudas, Domiciliarios Shipday, Pedidos, Reportes, Sucursales, Trabajadores, Turnos→Caja | ✔ 21 | ✔ 21 | Sin errores |
| Equipos | ✔ tras corrección | ✔ | **Defecto corregido:** el operador recibía 403 y el aviso "Error al cargar equipos" |
| Solicitudes | ✔ tras corrección | ✔ | **Defecto corregido:** el operador recibía 403 y "Error al cargar solicitudes" antes de ser redirigido |

## 4. Flujos de interfaz

| Flujo | Cómo se verificó | Resultado |
|---|---|---|
| Login (operador y admin; correo de ejemplo neutro) | Navegador | ✔ (corregido: el ejemplo mostraba el admin por defecto) |
| Configuración: operador en solo lectura; error del servidor sin falso "guardado" | Navegador (M02) | ✔ |
| **Pago dividido F14** (Deudas → Registrar pago → "A base" 5.000) | Clic real, servidor temporal | ✔ base 15.000 → 10.000, comisión 0, efectivo +5.000 |
| Deudas: columnas Comisiones / Base / Total informativo | Navegador | ✔ $0 / $15.000 / $15.000 |
| **D7: solicitar agregar a un día cerrado** (Historial) | Clic real | ✔ solicitud "Agregar egreso efectivo $2.000…" |
| **D7: aprobar** (Solicitudes → "Aprobar y aplicar") | Clic real | ✔ efectivo −2.000; Cierre conserva 111.600 / dif. 0; corrección registrada |
| D7: Historial muestra conteo original + corrección + esperado corregido | Navegador | ✔ |
| Ingreso bancario desde el formulario (fecha del día) | Navegador (Codex UI01) | ✔ |
| Lectura de Dashboard, Historial, Deudas y Reportes contra el libro | Navegador | ✔ |

**Formularios ejercitados solo por su endpoint (15).** Cada endpoint está verificado al 100 %, pero el formulario no se pulsó individualmente:
- entregar y devolver base;
- turno por hora y cobro por hora;
- crear cliente, deuda y abono;
- conversión;
- gasto;
- editar movimiento;
- crear y editar sucursal;
- usuarios;
- acciones de equipos;
- trabajadores;
- libreta;
- botón de Excel;
- asistente de cierre mensual;
- **"Descontar de deuda" con reparto** (nuevo campo "Parte a devolver base").

Quedan cubiertos en la guía manual para que el propietario los pulse.

## 5. Procesos automáticos y aplicación de Windows

| Proceso | Verificación | Estado |
|---|---|---|
| Sondeo rápido, de recuperación y reconciliación profunda | `syncBranch`/`reconcileBranch` con Shipday simulado + importación real de solo lectura | ✔ (corregido: un pedido cerrado abortaba el ciclo) |
| Autosanación del stub $0 | DOM01 | ✔ |
| Lápida de pedidos eliminados | Baterías de Codex | ✔ |
| Cola financiera (tiempo máximo, 503 ante candado ajeno) | claude-final | ✔ |
| Arranque: bloqueo si faltan migraciones | codex-migration34-compiled | ✔ |
| CashBuddy.exe: abrir, salud, un solo backend | Procesos y registro | ✔ |
| Watchdog: reinicio tras caída | Backend terminado a la fuerza → nuevo en ~5 s | ✔ |
| Persistencia tras reinicio | Saldos DEMO iguales tras reiniciar | ✔ |
| Registro sin ruido de 401 | 45 → 0 líneas | ✔ (corregido) |
| Ventana WebView2 en pantalla | — | **Bloqueado**: control de pantalla denegado |

## 6. Defectos encontrados en esta auditoría (todos corregidos y repetidos)

| ID | Defecto | Prueba |
|---|---|---|
| D-A1 | Un pedido de un período cerrado abortaba todo el ciclo del sondeo | SYNC01–03, ORD-SYNC2 |
| D-A2 | API key inválida → 500 | SHIP01 |
| D-A3 | 401 cada 8 s en el registro | Medición del registro |
| D-A4 | El login sugería el admin por defecto | Navegador |
| D-A6 | La guardia de pedidos por instante del cierre de mes perdía pedidos del mes abierto | ORD-SYNC2 |
| D-A7 | Historial, cierre mensual y Caja calculaban fechas en UTC o con la zona del PC | Revisión + tipos |
| D-A8 | Equipos y Solicitudes consultaban rutas de admin con sesión de operador | Navegador |
| D-A9 | Guion de migración 34 de Codex con base vieja sucia y conteo fijo | run-migration34-final |

## 7. Pruebas de Codex ajustadas por las decisiones del propietario

Estas pruebas fijaban una regla que el propietario reemplazó. La intención protegida se conserva en cada una:

| Prueba | Regla anterior | Regla nueva (14-oct) |
|---|---|---|
| R5, R7, N3 | Base dentro de la deuda; indicador de bases solo del mes | F14 (base aparte; saldo anterior + entregadas − devueltas) |
| 5 de financial-acceptance | Pago primero a base | F14 (el operador reparte) |
| http-acceptance | Total = base + comisión | F14 (− crédito); fila de Excel renombrada |
| LOCK11, E02, INTEGRATED | Solicitud sobre día cerrado rechazada | D7 (se aplica y se registra; el conteo no cambia) |
| LOCK12, LOCK17, LOCK19 | Pedido tras el Cierre rechazado | Se carga en su día; un mes cerrado sigue bloqueando |

## 8. Totales de ejecución (código final)

| Batería | Resultado |
|---|---|
| Financiera (45) / bloqueadores (18) / Claude completa, incluida la de 2 min (15) | 45 / 18 / 15 |
| 12 defectos (26) / Codex independiente + bordes + definitiva (75) / migraciones (2) | 26 / 75 / 2 |
| Auditoría final (5) / F14-D7-pedidos (27) / cobertura (28 pasos, 124 rutas) | 5 / 27 / 28 |
| Migración 34 (3 guiones) / migración F14 con datos heredados / escenario DEMO con Cierre / conciliación peso a peso | ✔ / ✔ / ✔ / ✔ |
| Tipos API y web / compilación de producción | 0 errores / correcta |
