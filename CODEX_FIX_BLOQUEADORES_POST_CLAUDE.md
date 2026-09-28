# Corrección de bloqueadores posteriores a Claude — 2026-09-28

## Resultado y alcance

Los seis bloqueadores solicitados se corrigieron y se comprobaron con PostgreSQL temporal y llamadas HTTP reales. No se declara aptitud para producción. No se accedió al PC de producción ni a Shipday real, ni se corrigieron saldos históricos por estimación.

Se leyó completo `AUDITORIA_CLAUDE_POST_CODEX.md`, se revisó Git y se consultaron las migraciones del PC local en modo de solo lectura antes de editar. Había 32 migraciones terminadas, ninguna revertida, incluida `20260928170000_financial_payment_ledger`. Se preservó una copia del estado inicial en `C:\LayaJarvis\epa-bloqueadores\baseline` y sus hashes en `baseline-hashes.json`.

## Causas, soluciones y archivos

### 1. Autorización administrativa (D1 y D8)

**Causa:** la ruta de cierre mensual no comprobaba el rol y podía cambiar el capital. La restricción de Configuración no protegía esa ruta alternativa. El registro de cuentas era público.

**Solución:** `POST /sd/closes` exige administrador. Se revisaron las escrituras de capital: Settings, cierre mensual y edición de MonthlyClose por solicitud; las tres requieren aprobación/rol administrativo. Capital debe ser entero entre 0 y 2.147.483.647 pesos. El cero es válido para capital, no para gastos/deudas. Crear y cambiar sucursales y registrar usuarios también exige administrador autenticado. Arqueos diarios conservan el flujo del operador; no reciben capital inicial del cliente.

**Archivos:** `routes/index.ts`, `validators/schemas.ts`, `services/close.service.ts`, `services/settings.service.ts`, `lib/money-validation.ts` (bajo `apps/api/src`).

**Evidencia:** intentos HTTP de usuario normal contra Settings, cierres, reset, recálculo, usuarios y sucursales rechazados; capital, cierres y usuarios permanecen iguales. Capital inválido rechazado también para administrador; cierre administrativo con capital cero permitido.

### 2. Gastos (D2)

**Causa:** el servidor confiaba en el `status` y el autor del navegador, admitía importes negativos y permitía editar directamente gastos confirmados.

**Solución:** categorías 3/4 solo admiten egresos del medio correspondiente, con importe entero positivo hasta el límite real de INTEGER de PostgreSQL. Usuario normal crea siempre pendiente, aunque envíe `confirmed`; el autor se toma de la sesión. La edición directa de gastos exige administrador y solo admite pendientes, sin cambiar el estado por PATCH. Un confirmado se corrige/elimina mediante `EditRequest` aprobado por administrador. Aprobar/rechazar valida el estado pendiente dentro de la transacción. La edición, reversión y aprobación se reflejan en los cálculos existentes de caja y reportes. Se conservó el cobro de domicilios del sistema antiguo, que también usa Movement pero no es un gasto.

**Archivos:** `controllers/movement.controller.ts`, `services/movement.service.ts`, `validators/schemas.ts`, `services/edit-request.service.ts`, `lib/money-validation.ts`.

**Evidencia:** 0, negativos, fracciones, null, strings, NaN/Infinity y desbordamientos rechazados. NaN/Infinity se probaron además directamente en el servicio porque JSON no los representa como números. Dos aprobaciones concurrentes aplican una sola vez el gasto. PATCH, rechazo y DELETE directos no revierten un confirmado. Solicitud aprobada cambia caja y reporte; reversión restaura el importe; fallo posterior revierte movimiento y día.

La política general de reversiones de días cerrados (D7) sigue pendiente: no se inventó una nueva regla contable para todos los módulos.

### 3. Deudas de clientes (D3)

**Causa:** la creación no validaba importe ni medio, y create/update aceptaban campos adicionales en tiempo de ejecución. El abono mayor que la deuda se truncaba silenciosamente.

**Solución:** deuda inicial suministrada y nueva deuda deben ser enteros positivos dentro del rango de almacenamiento. Se validan medios y se limita la edición del cliente a sus datos de contacto/estado, sin permitir `pendingDebt` ni relaciones anidadas. Abonos que exceden la deuda se rechazan completos, incluidos los mixtos; no se inventa un crédito de cliente. Permanecen las protecciones previas de edición debajo de lo pagado, reversión individual y eliminación con cobros/vínculos.

**Archivos:** `services/client.service.ts`, `controllers/client.controller.ts`, `services/edit-request.service.ts`, `lib/money-validation.ts`.

**Evidencia:** entradas inválidas no cambian cliente, deudas, abonos ni efectivo. Crear préstamo positivo retira efectivo una vez. Cobros concurrentes no exceden el saldo. Reversión, edición aprobada y eliminación conservan el saldo. Una deuda sin medio representa deuda comercial y no crea una salida ni entrada física.

### 4. Webhook y conexiones (D4)

**Causa:** se adquiría una transacción y el candado global antes de autenticar. Cada petición falsa esperaba en una conexión del mismo pool utilizado por las lecturas.

**Solución:** token obligatorio validado antes de toda consulta, transacción y contador de operaciones. Sin token o incorrecto: 401 inmediato. Solo esta ruta admite hasta cuatro peticiones válidas activas; exceso devuelve 503 con Retry-After. Lotes válidos limitados a 100 eventos. La cola local de operaciones financieras espera fuera de PostgreSQL, con 64 solicitudes de espera como máximo y 15 segundos de límite. Se conserva el candado PostgreSQL entre procesos, con lock_timeout de 3 segundos. No se incluye ninguna llamada externa dentro de la transacción. Se vuelve a comprobar la sucursal activa al entrar en ella.

**Archivos:** `controllers/webhook.controller.ts`, `lib/prisma.ts`.

**Evidencia:** con pool de cuatro conexiones y una operación reteniendo la caja, 80 peticiones falsas son 401, no crean pedidos y Dashboard sigue siendo 200 antes de liberar la operación. Después funciona un webhook válido. Una ráfaga válida conserva la deuda y mantiene disponibles las lecturas. Claude P1 vuelve a pasar: Dashboard respondió en 148 ms con 25 peticiones falsas y una operación larga.

**Límite:** control de admisión por proceso, no defensa contra ataques volumétricos de red. Un 503 requiere reintento del emisor; no se responde éxito a un evento descartado. La carga real y varios procesos simultáneos no se certifican con estas pruebas.

### 5. Correcciones manuales a cero (D5)

**Causa:** la autosanación trataba toda tarifa cero reciente como provisional, incluyendo correcciones legítimas aprobadas.

**Solución:** campos explícitos `manualOverride`, `manualOriginalValue`, `manualOverrideBy`, `manualOverrideAt` y `shipdayDeliveryValue`. La aprobación registra el valor original y quién/cuándo corrigió; el valor externo se conserva separado. La autosanación exige que no haya override; una tarifa efectiva cero corregida no se vuelve a cobrar. El diario de solicitudes conserva las revisiones sucesivas.

**Archivos:** `prisma/schema.prisma`, nueva migración, `services/edit-request.service.ts`, `services/branch.service.ts`, `controllers/webhook.controller.ts`.

**Evidencia:** pedido de 20.000 corregido a 0, seguido de tres sondeos y otro webhook: tarifa y comisión siguen en 0, deuda en 0, valor externo 20.000, original 20.000, aprobador y fecha presentes. La regresión de provisionales verdaderos de la batería anterior continúa pasando.

### 6. Conservación de sucursales (F06/D6)

**Causa:** el DELETE físico disparaba cascadas que eliminaban pedidos, bases, pagos y domiciliarios.

**Solución:** el endpoint desactiva (`active=false`); no borra la sucursal. Se mantiene disponible para reportes y cierres. No recibe nuevos pedidos manuales ni sincronizaciones; el webhook ignora eventos de la sucursal desactivada. El texto de confirmación de la interfaz explica la conservación. Puede reactivarse por el administrador con el control existente.

**Archivos:** `services/branch.service.ts`, `controllers/webhook.controller.ts`, `controllers/order.controller.ts`, `routes/index.ts`, `apps/web/app/(app)/sucursales/page.tsx`.

**Evidencia:** registros y vínculos completos, cierre guardado, reporte mensual y saldos iguales antes/después. También se probó sucursal con pedido manual vinculado a deuda: desactivación exitosa sin error de FK ni desaparición de deuda. No se cambió el comportamiento explícito del reset administrativo.

## Migración e instalación

Se añade `20260928220000_order_manual_override/migration.sql`; no se modifica ninguna migración ya aplicada. Añade los cinco campos anteriores y protege correcciones históricas con evidencia de solicitud de edición aprobada. No recalcula deudas, comisiones ni tarifas. Si no hay evidencia fiable, no inventa el valor original; queda nulo.

Se corrige además D11 en `services/auto-init.service.ts`: ya no aplica SQL de la primera migración ni deja una base parcial. Comprueba que estén aplicadas todas las migraciones incluidas; si no, aborta antes de sembrar Settings o admin con instrucciones de ejecutar `npm run db:deploy -w @cash-buddy/api`.

Pruebas de instalación: base completamente vacía rechaza arranque sin crear tablas; después de migrate deploy arranca correctamente y de forma idempotente. Base con las 32 migraciones previas rechaza el arranque nuevo sin escribir; después de actualizar conserva el domiciliario y su saldo exactamente, y protege la corrección histórica a cero. Las dos bases fueron eliminadas después del ensayo.

## Pruebas y resultados

| Batería | Resultado |
|---|---|
| 45 comprobaciones originales, sin editar sus archivos ni expectativas | 45/45 |
| `post-claude-blockers.ts`, escenarios nuevos HTTP/servicio/BD | 18/18 |
| Instalación desde cero y actualización con datos históricos | Ambas aprobadas |
| Comprobación de tipos backend y build completo shared/web/API | Aprobados; 31 páginas exportadas |
| Claude, primera tanda | 19/26 literalmente verdes; siete discrepancias explicadas abajo |
| Claude, segunda tanda | 6/6 |
| Claude, HTTP de gastos | Pendiente 201, sin efecto de caja; PATCH 401; negativo 400 |

Las pruebas de Claude se copiaron cambiando únicamente SRC hacia la copia corregida y OUT hacia evidencias. Ninguna expectativa se editó. Originales intactos, hashes y adaptaciones en `C:\LayaJarvis\epa-bloqueadores\claude-adaptations.json`.

Las siete discrepancias de su primera tanda son:

- **B7:** continúa detectando la reversión retroactiva; política D7 pendiente, fuera de los seis bloqueadores solicitados.
- **B6:** dato sembrado con marcador bancario histórico inválido; no se normalizan saldos históricos sin comprobantes.
- **B8:** cliente con saldo histórico incoherente sigue bloqueado para cobrar hasta conciliación.
- **A9m:** el caso enviaba un sobrepago mixto y esperaba truncamiento; ahora se rechaza por el requisito explícito del dueño. Las pruebas nuevas verifican rechazo íntegro y conservación de datos.
- **B5:** todos los conteos antes/después coinciden. El test llama “huérfano” al marcador de un cobro sin comprobar que el domiciliario siga existiendo, y espera marcador nulo. Con desactivación, el domiciliario y el cobro enlazado permanecen legítimamente; las pruebas nuevas comprueban ambos completos.
- **B5b:** esperaba bloquear el borrado; la solución solicitada desactiva exitosamente, conservando pedido y deuda, sin error.
- **B10:** espera exactamente 403; la API responde 401 al registro sin autenticación. Ambos rechazos son válidos para el alcance solicitado; no se crea usuario.

Durante el desarrollo se corrigieron dos errores de datos en pruebas propias, conservando evidencia: la categoría de gasto se había escrito como 10 (Ingreso banco/conv) en vez de 3; y una llamada usaba `false` como tercer argumento de `registerPayment`, cuya firma real exige medio cash/bank. Se corrigieron las entradas, no las expectativas ni el código para acomodarlas.

Archivos nuevos de pruebas versionables: `apps/api/tests/post-claude-blockers.ts`, `post-claude-startup.ts`, `run-post-claude.cjs` y `run-migration-upgrade.cjs`. Los scripts `test:blockers` y `test:migration-upgrade` requieren DATABASE_URL local de prueba `cashbuddy_codex_blockers`; nunca apuntarlos a datos operativos. El primero requiere base vacía ya migrada. El segundo crea/elimina solo `cashbuddy_codex_fresh_v2` y `cashbuddy_codex_upgrade_v2`. `test:financial` conserva su base aislada `cashbuddy_codex_test_fixes`.

## F14: definición pendiente, fórmula sin cambios

Actualmente “Diferencia Bases” suma por domiciliario `max(0, min(entregas del mes − devoluciones del mes, deuda actual))`. Usa movimientos fechados en el mes seleccionado y la deuda vigente; no equivale necesariamente a la deuda al último día histórico de ese mes. El panel de deuda actual usa el libro completo y muestra bases anteriores por separado.

Alternativas para decidir con el dueño:

1. **Conservar el indicador actual:** mantiene comparación del libro mensual conciliado con deuda vigente. No pretende representar todo el capital pendiente.
2. **Mostrar todas las bases pendientes actuales:** usa el libro completo conciliado; incluye meses anteriores y coincide con Bases actuales, pero deja de ser un indicador exclusivo del mes.
3. **Mostrar saldo al cierre del mes:** usar el snapshot cerrado o reconstrucción histórica verificable. Es una cifra histórica distinta del saldo actual y requiere reglas explícitas de reversiones y completitud del historial.

No se implementó ninguna redefinición ni se cambió la utilidad por hora.

## Riesgos y límites pendientes

- Producción está en otro PC: su base, comprobantes y magnitud de H1–H9 no se revisaron ni se modificaron. Requiere copia para auditoría independiente y conciliación.
- Sincronización real con Shipday, interfaz completa, lanzador/watchdog, instalador empaquetado y carga real no verificados aquí. La sincronización de las pruebas usa respuestas simuladas con el código de persistencia real.
- D7, F14, utilidad por hora y alcance operativo de “cargar desde hoy” siguen pendientes de decisión. Los defectos menores de clasificación histórica en Movimientos y Excel fuera del alcance no se declaran corregidos.
- Un pedido histórico editado fuera del flujo de solicitudes puede no tener evidencia para activar override automáticamente. Requiere revisión de H8.
- Las FK históricas conservan sus cascadas; el servicio de sucursales ya no invoca borrado físico. El reset administrativo continúa siendo una operación destructiva explícita y privilegiada.
- La advertencia existente de Next sobre rewrites en export estático persiste; Express sirve las rutas API. El build omite lint por la configuración existente; tipos sí verificados.

## Git y entrega local

Los detalles exactos de archivos, `git diff --stat`, commit y estado final se registran en el anexo generado al finalizar. Se preservan los cambios previos ajenos a estas correcciones. No se hace push ni despliegue al otro PC.

### Aplicación local y archivos de esta segunda corrección

Instalada solo en este PC local (sin pedidos ni domiciliarios operativos), con 33 migraciones. La comparación de todos los registros previos fue idéntica. Respaldo: `C:/cash-buddy-epa/backups/pre_post_claude_2026-09-28T23-37-05-162Z`. No se aplicó nada al otro PC.

- `CLAUDE.md`
- `apps/api/package.json`
- `apps/api/prisma/schema.prisma`
- `apps/api/src/controllers/client.controller.ts`
- `apps/api/src/controllers/movement.controller.ts`
- `apps/api/src/controllers/order.controller.ts`
- `apps/api/src/controllers/webhook.controller.ts`
- `apps/api/src/lib/prisma.ts`
- `apps/api/src/routes/index.ts`
- `apps/api/src/services/auto-init.service.ts`
- `apps/api/src/services/branch.service.ts`
- `apps/api/src/services/client.service.ts`
- `apps/api/src/services/close.service.ts`
- `apps/api/src/services/edit-request.service.ts`
- `apps/api/src/services/movement.service.ts`
- `apps/api/src/services/settings.service.ts`
- `apps/api/src/validators/schemas.ts`
- `apps/web/app/(app)/sucursales/page.tsx`
- `apps/api/src/lib/money-validation.ts`
- `apps/api/prisma/migrations/20260928220000_order_manual_override/migration.sql`
- `CODEX_FIX_BLOQUEADORES_POST_CLAUDE.md`
- `apps/api/tests/post-claude-blockers.ts`
- `apps/api/tests/post-claude-startup.ts`
- `apps/api/tests/run-post-claude.cjs`
- `apps/api/tests/run-migration-upgrade.cjs`

### Captura de `git diff --cached --stat`

Incluye las correcciones anteriores verificadas y esta segunda ronda. Capturada antes de añadir este anexo final.

```text
 .gitignore                                         |   1 +
 AUDITORIA_CODEX_2026-09-28.md                      | 162 ++++++++++++
 CLAUDE.md                                          |  20 +-
 CODEX_FIX_BLOQUEADORES_POST_CLAUDE.md              | 164 ++++++++++++
 CORRECCIONES_CODEX_2026-09-28.md                   |  30 +++
 apps/api/package.json                              |   5 +-
 .../migration.sql                                  |  20 ++
 .../migration.sql                                  |  22 ++
 apps/api/prisma/schema.prisma                      |  32 +++
 apps/api/src/controllers/client.controller.ts      |   5 +-
 apps/api/src/controllers/movement.controller.ts    |   5 +-
 apps/api/src/controllers/order.controller.ts       |  26 +-
 apps/api/src/controllers/webhook.controller.ts     |  45 +++-
 apps/api/src/lib/money-validation.ts               |  10 +
 apps/api/src/lib/order-stats.ts                    |  14 ++
 apps/api/src/lib/prisma.ts                         |  66 ++++-
 apps/api/src/routes/index.ts                       |  11 +-
 apps/api/src/services/admin.service.ts             |   8 +-
 apps/api/src/services/auto-init.service.ts         |  67 ++---
 apps/api/src/services/bank-transaction.service.ts  |  48 +++-
 apps/api/src/services/base.service.ts              |  24 +-
 apps/api/src/services/branch.service.ts            |  75 +++---
 apps/api/src/services/client.service.ts            | 185 ++++++--------
 apps/api/src/services/close.service.ts             |  21 +-
 apps/api/src/services/day.service.ts               |   2 +-
 apps/api/src/services/driver.service.ts            |  22 +-
 apps/api/src/services/edit-request.service.ts      | 280 +++++++--------------
 apps/api/src/services/excel.service.ts             |   2 +
 apps/api/src/services/hourly-client.service.ts     |  20 +-
 apps/api/src/services/movement.service.ts          |  36 ++-
 apps/api/src/services/order-cleanup.service.ts     |  94 +------
 apps/api/src/services/settings.service.ts          |   3 +
 apps/api/src/services/shift-close.service.ts       |   8 +-
 apps/api/src/services/shipday-dashboard.service.ts |   6 +-
 apps/api/src/services/shipday.service.ts           |   6 +-
 apps/api/src/services/unified-movements.service.ts |  10 +-
 apps/api/src/validators/schemas.ts                 |   9 +-
 apps/api/tests/audit-clients.ts                    |  36 +++
 apps/api/tests/audit-core.ts                       | 213 ++++++++++++++++
 apps/api/tests/audit-extra.ts                      | 107 ++++++++
 apps/api/tests/audit-sync.ts                       |  76 ++++++
 apps/api/tests/financial-acceptance.ts             | 127 ++++++++++
 apps/api/tests/http-acceptance.ts                  |  37 +++
 apps/api/tests/post-claude-blockers.ts             | 171 +++++++++++++
 apps/api/tests/post-claude-startup.ts              |  20 ++
 apps/api/tests/run-financial.cjs                   |  10 +
 apps/api/tests/run-migration-upgrade.cjs           |  34 +++
 apps/api/tests/run-post-claude.cjs                 |   6 +
 apps/web/app/(app)/shipday/reportes/page.tsx       |   5 +
 apps/web/app/(app)/sucursales/page.tsx             |  12 +-
 apps/web/lib/sd-api.ts                             |   1 +
 51 files changed, 1872 insertions(+), 547 deletions(-)
```

### Estado de Git verificado tras el commit

Se versionan código, esquema, ambas migraciones de Codex, pruebas e informes propios. Se dejan intactos y fuera del commit los archivos ajenos: `AUDITORIA_CLAUDE_POST_CODEX.md`, `CONTEXTO_AUDITORIA.md`, `apps/api/scripts/simulate-3months.ts`, y la línea de ese script en `apps/api/package.json`. No se hace push. El hash y la comprobación final se conservan en `C:\LayaJarvis\epa-bloqueadores\git-final.txt`.

### Comprobación final

Commit de implementación: `719132b` (`fix: preserve financial consistency and resolve post-audit blockers`), 51 archivos, 1.935 inserciones y 547 eliminaciones; incluye la primera corrección que estaba pendiente de versionar. La compilación completa en el proyecto instalado terminó correctamente. API `/api/health` y pantalla `/login`: HTTP 200, conexión local y diario disponibles. Las bases temporales de esta ejecución se retiraron después de guardar evidencia.

`git diff --stat` después del commit de implementación (solo cambio previo del usuario):

```text
 apps/api/package.json | 1 +
 1 file changed, 1 insertion(+)
```

`git status --short` verificado, sin correcciones de código pendientes de commit:

```text
 M apps/api/package.json
?? AUDITORIA_CLAUDE_POST_CODEX.md
?? CONTEXTO_AUDITORIA.md
?? apps/api/scripts/simulate-3months.ts
```

Este anexo se guarda en un commit documental posterior. No se hizo push ni despliegue a producción.
