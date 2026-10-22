# Cash Buddy EPA — guía para asistentes de IA

Este sistema maneja **dinero real** de una empresa de domicilios (efectivo,
banco, deudas de domiciliarios y clientes). Un error de lógica aquí no es un
bug cosmético: puede hacer que la caja "descuadre", que a un domiciliario le
cobren de más o de menos, o que una sucursal quede con cifras que no cuadran
con la plata física — con consecuencias legales reales para el negocio.

**Antes de tocar cualquier lógica de dinero (deudas, saldos, cierres, banco),
lee esta guía completa.** Si vas a replicar este sistema en otra sucursal o
PC, la única forma confiable de garantizar el mismo comportamiento es
**desplegar este mismo repositorio** (ver `INSTALACION.md`), no
"reconstruirlo" a partir de una descripción. Esta guía documenta las reglas
no obvias para que un asistente de IA no las rompa al seguir extendiendo el
sistema.

## Arquitectura (ver también README.md)

- `apps/api`: Express + Prisma + PostgreSQL (única base de datos; el
  multi-sucursal se maneja con `branchId`, no con bases de datos separadas).
- `apps/web`: Next.js exportado como estático (`output: "export"` en
  producción) — el backend lo sirve desde `apps/web/out`.
- `CashBuddy.exe` (`scripts/launcher-build`): lanzador de escritorio en C#
  (WinForms + WebView2) que verifica PostgreSQL, arranca
  `node apps/api/dist/index.js`, espera `/api/health` y abre la ventana. Tiene
  un **watchdog**: si el backend muere, lo reinicia solo cada ~3s (máx. 5
  veces). Esto importa para el flujo de deploy (ver abajo).

## Zona horaria: SIEMPRE Bogotá, nunca UTC crudo

Bogotá es UTC-5 sin horario de verano. **Nunca** calcules "hoy" con
`new Date().toISOString().slice(0, 10)` — eso da la fecha en UTC, y cualquier
cosa registrada después de las 7pm hora Bogotá cae en el día calendario
siguiente (bug real, ya corregido dos veces: nómina en `trabajadores/page.tsx`
y el default de fecha en `BankTransactionWizard.tsx`).

- Backend: usa `todayBogota()` / `toBogotaDateStr()` / `bogotaDayRange()` /
  `bogotaOpenRange()` de `apps/api/src/lib/date-range.ts`.
- Frontend: usa `todayBogota()` de `apps/web/lib/format.ts` (NO `todayISO()`,
  que depende de la zona horaria del sistema operativo del navegador/PC).

## Modelo de dinero (quién es quién)

- `Movement` ("Caja"): registros manuales antiguos (categoría numérica,
  ingreso/egreso, cash/bank). Cuelgan de `Day` (PK = fecha `YYYY-MM-DD`), que
  guarda `initialCash`/`initialBank` (arrastre del día anterior vía
  `ensureDay`).
- `BankTransaction`: todo movimiento de banco/efectivo fuera del sistema
  "Caja" viejo (depósitos, retiros, pagos a/de domiciliarios).
  - `noCounterpart`: el movimiento es autosuficiente, no espera contraparte.
  - `pairId`: enlaza una salida y su retorno para que cuadren juntos.
  - `groupId`: una sola acción del usuario dividida en efectivo+banco.
  - `driverId`: si el movimiento se aplicó a la deuda de un domiciliario.
- `BaseTransaction` (`type: "entrega" | "pago"`): base (capital de trabajo)
  entregada o devuelta por un domiciliario.
- `DriverPayment`: pago de comisión cobrado a un domiciliario.
- **F14 (decisión del dueño, 14-oct-2026): base y comisiones son cuentas SEPARADAS.**
  `Driver.pendingDebt` / `creditAmount` son **solo la cuenta de comisiones**; la base
  pendiente es el libro `BaseTransaction` (Σ entregas − Σ devoluciones,
  `lib/base-balance.ts`). Entregar/devolver/editar/borrar una base **no** toca
  `pendingDebt`. Crédito y base **no se compensan**. Un pago se reparte como indique el
  operador (`baseAmount`; el resto es comisión). El "total informativo" (comisión + base −
  crédito) no es otra deuda. La migración `20261015090000_f14_separate_base_commission`
  convirtió los saldos heredados (auditoría en `F14DriverMigration`). Al revertir un
  BankTransaction aplicado, solo se revierte `debtApplied − Σ bases enlazadas` a comisiones
  (`revertDriverApplication`).
- `Driver.pendingDebt` / `creditAmount`: **un solo saldo neto de comisiones** por
  domiciliario. Invariante: nunca deben ser positivos los dos a la vez —
  `applyDebtDelta()` en `driver.service.ts` los netea. No los actualices a
  mano sin pasar por ahí (o por la lógica equivalente ya existente).
  - **Nunca uses `pendingDebt: { increment/decrement }` crudo** para ajustar la
    deuda al crear/editar/borrar una base o pago: eso ignora el crédito a favor
    y no tiene tope inferior, así que puede dejar `pendingDebt` NEGATIVO. Un
    `pendingDebt` negativo es un agujero silencioso: el domiciliario desaparece
    tanto de "Deudas" (filtra `pendingDebt > 0`) como de la lista de créditos
    (`pendingDebt = 0`), aunque en "Domiciliarios" su base siga pendiente. Bug
    real (Andrés Durán, jul-2026): una base salía en Domiciliarios pero no en
    Deudas; borrarla y re-crearla la "arregló sola" porque `giveBase` re-neteaba.
    `removeBase`/`editBase` (base.service.ts) y el borrado de `BaseTransaction`
    en `edit-request.service.ts` pasan por `applyDebtDelta` justamente por esto.
  - **No existe un "recalcular deudas" masivo confiable por fórmula.** El saldo
    correcto depende de TODA la semántica de `BankTransaction` (`debtApplied`,
    egresos que pagan crédito, egresos con `debtApplied`, contrapartes, splits);
    reconstruirlo con `comisión + bases − pagos` cuenta doble los registros
    bank-linked y resucita créditos ya pagados. El script `scripts/recalc-debts.ts`
    quedó obsoleto por esto y aborta a propósito — **no lo ejecutes**. La única
    forma correcta de mantener el saldo es que cada escritura netee su delta con
    `applyDebtDelta()`.

### Pagos vía banco a la deuda de un domiciliario (el punto más frágil)

Cuando un `BankTransaction` se "aplica" a la deuda de un domiciliario
(`applyBankToDriver` o el flujo todo-en-uno `registerPayment`), el sistema
crea TAMBIÉN un `BaseTransaction` "pago" y/o `DriverPayment` como contabilidad
interna, marcados con notas especiales (`BANK_LINKED_PAYMENT_NOTE`,
`bankLinkedBaseNote()` en `lib/balance-markers.ts`).

- Esos registros marcados **deben excluirse** de cualquier cálculo de saldo
  esperado (`getExpectedBalances`, `unified-movements.service.ts`, el nuevo
  `getDaySummary`) — si no, el mismo dinero se cuenta dos veces.
- Están enlazados al `BankTransaction` que los originó por
  **`bankTransactionId`** (no por fecha aproximada — eso fue un bug real: un
  `BankTransaction` con fecha distinta a "ahora" hacía que la búsqueda por
  ventana de ±5s fallara y dejara "pagos" huérfanos que descuadraban el
  estado de cuenta del domiciliario).
- Al eliminar un `BankTransaction` (`bank-transaction.service.ts::remove()` o
  `edit-request.service.ts::deleteEntity("BankTransaction")`), el sistema
  DEBE: revertir la posición neta del domiciliario por **`debtApplied`**, y
  borrar los registros vinculados por `bankTransactionId`. **Ambos lugares
  deben mantenerse sincronizados** — si agregas una tercera forma de borrar un
  `BankTransaction`, replica esta misma lógica.
- La condición para revertir es **`debtApplied != 0`** (marca explícita), NUNCA
  `noCounterpart && type === "ingreso"`. Esa heurística vieja causó un bug
  real (17-jul-2026): se aplicó por error una **salida** de $100.000 a la
  deuda de una domiciliaria; al borrar el movimiento la guarda no se cumplió
  (era `egreso`), la deuda nunca se restableció y quedó un `DriverPayment`
  fantasma de $18.600 manteniéndola en cero. El signo de `debtApplied` importa:
  - **`> 0`** = ingreso que descontó deuda (`applyBankToDriver`/`registerPayment`).
    Al revertir, además borra los registros contables vinculados (base pago +
    `DriverPayment` bank-linked) por `bankTransactionId`.
  - **`< 0`** = egreso que **pagó crédito** (`payCredit`, guarda `-creditAmount`).
    NO tiene registros contables vinculados que borrar. Antes NO se marcaba, así
    que borrar el pago del crédito no devolvía el saldo a favor (quedaba en cero) y
    luego revertir el ingreso original dejaba una **deuda fantasma** (bug real Juan
    Sanabria, 15-sep-2026). **No simplifiques la guarda a `> 0`** o lo reintroduces.
    La fórmula `net = (pendingDebt − creditAmount) + debtApplied` ya cuadra ambos signos.
- `applyBankToDriver` **solo acepta ingresos sin contraparte** (`pairId` nulo).
  Una salida es plata que sale (descontarla de una deuda es contabilidad al
  revés) y un movimiento con contraparte es plata de paso, no un pago del
  domiciliario. El botón "Descontar de deuda" en `banco/page.tsx` aplica el
  mismo filtro, pero **la validación que manda es la del backend**.
- Las FK `BaseTransaction.bankTransactionId` y `DriverPayment.bankTransactionId`
  son `onDelete: Cascade`, **no `SetNull`**. Con `SetNull`, borrar el
  `BankTransaction` dejaba esos registros vivos y sin enlace — pagos fantasma
  imposibles de rastrear. Con `Cascade`, si alguna ruta olvida la limpieza
  explícita, el descuadre es visible en vez de silencioso. No la cambies.

## Pedidos de Shipday: el stub "$0 / #00" del webhook y su autosanación

El webhook de Shipday (`ORDER_COMPLETED`) dispara en el **instante** en que el
pedido se marca entregado, pero en ese momento Shipday **aún no fija la tarifa**:
manda `delivery_fee: 0`, `total_cost: 0` y `order_number: "00"` (confirmado en el
`rawData` real). El webhook guarda ese **stub**: `deliveryValue = 0`,
`companyAmount = 0`, sin aplicar deuda ni estadística (exige `companyAmount > 0`).

Después, la consulta de "ya entregados" (`POST /orders/query ALREADY_DELIVERED`,
el *polling*) trae la **tarifa y el número reales**. Como persistir es idempotente
por `shipdayOrderId`, **antes** ese stub se ignoraba y el pedido quedaba clavado en
`$0 / #00` para siempre, **sin sumar a la deuda del domiciliario**. Esto producía
**dos síntomas que son el mismo bug**: (1) pedidos con valor 0, y (2) "no cargaron
todos" — porque el pedido está guardado como `#00` en vez de su número real, así que
la numeración del día muestra **huecos** (falta el #80, #128…) aunque el pedido sí
exista.

- La corrección vive en `persistDeliveredOrder` (`branch.service.ts`): si el registro
  existe **en 0** y el polling trae un valor **> 0**, se **sana una sola vez** — se
  actualiza valor, comisión, número y datos del cliente, y se **cuenta por primera
  vez** (deuda vía `applyDebtDelta` + `DailyDriverStat`), porque el stub en 0 nunca se
  contó. La condición `deliveryValue === 0 && nuevo > 0` identifica candidatos,
  pero solo se sanan si `manualOverride` es false. Una corrección aprobada puede
  dejar legítimamente el valor en $0 y debe sobrevivir toda sincronización.
- Se limita a pedidos creados a partir de `SELF_HEAL_SINCE` (fecha **fija** =
  despliegue del arreglo, 03-ago-2026). Fue un pedido explícito del dueño: **no tocar
  los pedidos viejos que ya quedaron en $0**, solo que de aquí en adelante se corrijan
  solos. Fija (no "hoy dinámico") para que un stub creado justo antes de medianoche
  también se sane al día siguiente.
- El *fast sync* (~60 s, solo hoy) sana los stubs del día casi de inmediato; catch-up
  (3 d) y reconciliación profunda (14 d) cubren los rezagados. Todos pasan por
  `persistDeliveredOrder`, así que **no dupliques** esta lógica en otra ruta de carga.
- El **stub es necesario**: da presencia en tiempo real y captura pedidos
  **programados** creados hace días (que la ventana por fecha de CREACIÓN del polling
  no alcanza). Por eso el webhook NO debe dejar de crear el pedido cuando la tarifa
  llega en 0 — se crea y el polling lo sana.

### Eliminar un pedido: la lápida (`DeletedShipdayOrder`) — no debe resucitar

Como `persistDeliveredOrder` es idempotente por `shipdayOrderId` y **crea** cualquier
pedido que no exista localmente, borrar un pedido entregado NO alcanza: Shipday lo sigue
reportando como `ALREADY_DELIVERED`, así que el siguiente sync (rápido/catch-up/reconcile,
que cubren hasta 14 días atrás) lo **re-crea** y vuelve a aplicar la comisión a la deuda del
domiciliario. Bug real (Pedido #35, 18-ago-2026): un admin aprobó la eliminación vía
`EditRequest`, el pedido se borró y **un minuto después el sync lo trajo de vuelta** — en el
historial la solicitud quedaba "Aprobada" pero el pedido seguía vivo y la deuda intacta.

- Al eliminar un `ShipdayOrder` por el flujo de aprobación
  (`edit-request.service.ts::deleteEntity`), se escribe una **lápida** en
  `DeletedShipdayOrder` (PK = `shipdayOrderId`). Tanto el polling
  (`persistDeliveredOrder` en `branch.service.ts`) como el **webhook**
  (`webhook.controller.ts`) consultan esa tabla **antes de crear** y se niegan a
  recrear un pedido con lápida. **Si agregas otra ruta que cree pedidos desde Shipday,
  respeta la lápida ahí también**, o el borrado dejará de "pegar".
- La reversión de la comisión en ese borrado usa **`applyDebtDelta(tx, driverId,
  -companyAmount)`**, NUNCA un `pendingDebt: { decrement }` crudo (misma regla de dinero
  que bases/pagos: netea contra el crédito y topa en 0).
- `reviewRequest` aplica el efecto (borrado/edición) **antes** de marcar la solicitud como
  "Aprobada": si el efecto falla, la solicitud queda "pending" y el error sube — nunca queda
  un falso "Aprobada" en el historial.
- Las lápidas son intencionalmente permanentes (borrar un pedido no debe deshacerse solo por
  un sync). Si alguna vez hay que **re-cargar** un pedido borrado a propósito, hay que
  **eliminar su fila de `DeletedShipdayOrder`** primero.

## Cierre de caja: "día operativo" ≠ fecha calendario

El día que se puede cerrar **no avanza solo porque cambió la fecha**. Solo
avanza cuando se registra el Cierre (`ShiftClose` con `shift: "close"`) del
día actual — así un cierre hecho a las 00:30 (ya "mañana" en el calendario)
sigue encontrando el día de ayer disponible para cerrarlo.

- `getCurrentOperatingDate()` en `shift-close.service.ts` calcula esto: el
  día siguiente al último Cierre registrado. **Sí puede quedar en "mañana"**
  tras cerrar hoy antes de medianoche (el tope a "hoy" se quitó a propósito en
  63b0bdb, "día operativo manual"). En ese lapso, todo registro de dinero
  fechado hoy se rechaza (día cerrado) salvo por solicitud aprobada (D7).
- **NEW02 (decisión del dueño, 21-oct-2026): todo cuenta en el día operativo, nunca en el
  reloj.** Si el calendario va adelante (es 21 pero la caja abierta es la del 20), todo
  registro de dinero sin fecha (bases, pagos de domiciliarios, deudas/abonos de clientes,
  turnos y cobros por hora, banco, conversiones, libreta, pedidos manuales) queda en el 20
  (`moneyNow()` = fin del día operativo); si va atrás (tras el Cierre nocturno, operativo =
  mañana) queda al inicio del día operativo. Una fecha posterior al día operativo → 400.
  Backend: `operatingDay()` / `moneyNow()` / `operatingClock()` en `lib/period-guard.ts`;
  frontend: `useDay().operatingDay` como fecha por defecto y máximo de los formularios. No
  vuelvas a usar `new Date()` / `todayBogota()` para fechar dinero. Excepciones: `closedAt`
  de `ShiftClose`/`MonthlyClose` (instante real) y pedidos sincronizados de Shipday (su hora
  real de entrega, ver regla de pedidos).
- **NEW10 (consecuencia de NEW02, 21-oct-2026): un mes solo se cierra con la caja al día.**
  `closeMonth` exige día operativo = hoy y en un mes posterior al que se cierra. El capital se
  declara en la hora real (`closedAt`): con la caja adelantada, lo ya registrado (fechado al
  inicio del operativo) quedaba después de `closedAt` y se contaba dos veces (comprobado:
  44.550/174.408 → 28.350/215.908); con la caja atrasada, lo siguiente quedaba antes de
  `closedAt` y se rechazaba para siempre (ni el Cierre del día entraba). No quites estas guardas.
- **NEW11 (21-oct-2026): sin cierre de mes, el esperado es capital + TODO lo registrado.** Antes
  arrancaba el día 1 del mes consultado y, si el mes anterior no se había cerrado, la caja
  "olvidaba" ese mes. El capital de Configuración no se puede cambiar tras el primer Cierre de caja,
  así que rige desde la instalación. Con cierres de mes, el ancla sigue siendo el último cierre.
  Prueba: `tests/claude-mes-simulado.ts` (30 días con Cierre diario cruzando el cambio de mes).
- **NEW03 (decisión del dueño, 21-oct-2026): la ganancia incluye clientes por hora.** Ventas =
  comisión de domicilios + `HourlyShift.companyAmount` (lo que paga el cliente menos lo del
  domiciliario, por la fecha del servicio). Ganancia = ventas − gastos − nómina, igual en
  `getDaySummary` (`gananciaPorHora`), `getMonthlyReport` (`sales.orders/hourly`) y el Excel (fila
  "Clientes por hora" al final para no mover las filas fijas). Si cambias una, cambia las tres.
- **NEW13 (21-oct-2026):** con la caja adelantada, un instante "futuro" en el reloj pero hasta el día
  operativo NO es futuro: si su día ya tiene Cierre (cerrado por adelantado) sigue la regla de días
  cerrados (409 directo, permitido como corrección D7 aprobada). Solo lo posterior al día operativo
  es "futuro" (`assertOpenInstant`). Regresión: `D7-ADELANTADO` en `tests/claude-f14-d7.ts`.
- **NEW15 (22-oct-2026):** `closeMonth` se rechaza si hay dinero con hora posterior a `closedAt` (registrado con la caja
  adelantada con hora explícita del día operativo): el capital declarado ya lo incluía y el esperado lo
  volvía a sumar. Regresión `MES-FUTURO` en `tests/claude-f14-d7.ts`.
- **NEW12 (21-oct-2026):** toda ventana emergente (overlay `fixed inset-0` propio o `DialogContent`)
  lleva `max-h-[92vh] overflow-y-auto` en el panel: en pantallas bajas (588 px) el detalle del día
  cortaba sus botones y no se podía desplazar.
- **NEW09 (21-oct-2026):** `/domiciliarios` (pantalla antigua que daba bases como movimientos de
  Caja fuera del libro `BaseTransaction`) solo redirige a `/shipday/domiciliarios`. No la revivas.
- La página de Caja (`apps/web/app/(app)/caja/page.tsx`) SIEMPRE debe pedir
  este valor a `/shifts/current-date` — nunca calcular "hoy" directo.
- `expectedAmount`/`bankExpected` de un cierre **siempre** los calcula el
  servidor (`getExpectedBalancesForDate`), nunca el cliente.
- Un `ShiftClose` ya registrado queda `locked`; corregirlo pasa por el flujo
  de `EditRequest` (aprobación de un admin), nunca por sobrescritura directa.

## Historial: el semáforo verde/rojo depende SOLO del Cierre

En `apps/web/app/(app)/historial/page.tsx`, un día se ve verde si y solo si
tiene un `ShiftClose(shift="close")` con `difference === 0` y
(`bankDifference == null` o `=== 0`). Ninguna otra cifra (comisión, deudas,
ganancia, etc.) debe afectar ese color — así lo pidió explícitamente el
dueño del sistema.

El detalle de un día (`getDaySummary` en `day.service.ts`) junta TODAS las
fuentes de dinero (Caja, Banco, domiciliarios, bases, deudas de clientes) —
si agregas una fuente nueva de ingreso/egreso, súmala ahí también o el
resumen del historial quedará incompleto.

## Flujo de deploy (Windows, app de escritorio empaquetada)

Esto **no es un entorno de desarrollo con recarga automática**. Después de
cualquier cambio en `apps/api/src` o `apps/web`:

```powershell
npm run build -w @cash-buddy/api   # tsup -> apps/api/dist/index.js
npm run build -w @cash-buddy/web   # next build -> apps/web/out (export estático)
```

Y luego reiniciar el proceso `node dist\index.js`. **Cerrar y volver a abrir
`CashBuddy.exe` NO basta**: al cerrar la ventana el backend sigue vivo (atiende a
otros equipos por la red/Tailscale) y al reabrir el lanzador *reutiliza* el
servidor que ya escucha en el puerto 4000, con el código viejo en memoria
(comprobado 14-oct-2026). Hay que terminar el proceso `node dist\index.js` (o
reiniciar el PC) y abrir CashBuddy.exe. Si el cambio no se aplica, casi siempre
es porque faltó este paso.

Si cambias `prisma/schema.prisma`, corre `npx prisma migrate dev --name X`
**y luego** `npx prisma generate`. El watchdog de `CashBuddy.exe` reinicia el
backend cada ~3s y eso bloquea el archivo del motor de Prisma en Windows —
si `prisma generate` falla con `EPERM ... query_engine-windows.dll.node`,
**cierra `CashBuddy.exe` por completo** (no solo el proceso `node`) antes de
reintentar, y vuelve a abrirlo al terminar.

## Git

### Protección añadida tras la auditoría independiente (septiembre de 2026)

- Una corrección de tarifa guarda `manualOverride`, valor original, aprobador y
  fecha. `shipdayDeliveryValue` conserva la tarifa externa conocida por separado.
- `DELETE /branches/:id` desactiva la sucursal; no elimina su libro contable.
- Gastos: categoría 3/4, monto entero positivo. El usuario normal solo crea
  pendientes. Corregir o eliminar uno confirmado exige `EditRequest` aprobado.
- Autenticar el webhook antes de consultar la BD o entrar en `moneyTransaction`.
  La cola local espera fuera de PostgreSQL; mantener el candado entre procesos.
- El arranque verifica todas las migraciones. Si faltan, aborta sin sembrar datos.
  En una instalación/actualización, ejecutar `npm run db:deploy -w @cash-buddy/api`
  y generar Prisma antes de iniciar. Nunca aplicar solo la primera migración.
  **El `.env` vive en la raíz y la CLI de Prisma no lo lee desde `apps/api`** (falla con
  "Environment variable not found: DATABASE_URL"). Antes de `db:deploy`/`prisma generate`, en
  PowerShell dentro de `apps\api`:
  `$env:DATABASE_URL = ((Get-Content ..\..\.env | Where-Object { $_ -match '^DATABASE_URL=' }) -replace '^DATABASE_URL=','').Trim('"')`
  (probado el 15-oct-2026 al aplicar la migración 37 a la DEMO).
- No cambiar la fórmula de bases del mes ni la política de reversiones históricas
  sin una decisión explícita del dueño.
- Autenticación (oct-2026): `requireAuth` lee rol y estado del usuario en la BD en cada
  petición; un cambio del usuario invalida sesiones previas. Falta de permisos = **403**
  (`requireAdmin`); 401 solo para sesión inválida, porque el frontend cierra sesión ante 401.
- `moneyTransaction` tiene un tiempo máximo propio que libera la cola si una operación se
  cuelga; `/api/health` expone `moneyQueue`. No envolver llamadas externas en ella.
- Un movimiento de Caja confirmado (cualquier categoría) solo lo corrige un admin o un
  `EditRequest` aprobado; el usuario normal solo edita pendientes (cobro de domicilios).

### Reglas añadidas al corregir los 12 defectos de Codex (14-oct-2026, ver `CLAUDE_CORRECCION_12_DEFECTOS.md`)

- Sesiones: `User.tokenVersion` viaja en el JWT como `tv`. Cambiar contraseña, rol o estado
  **debe** pasar por `updateUser` (incrementa la versión). No vuelvas a comparar `iat` con
  `updatedAt`: tiene un hueco de un segundo.
- Períodos cerrados: todo registro de dinero con fecha explícita pasa por
  `assertOpenPeriod` (`lib/period-guard.ts`) dentro de `moneyTransaction`. Día con Cierre o
  anterior al último `MonthlyClose` → 409. Un `Movement` cuenta en `movementEffectiveAt()`:
  Caja, Historial y Movimientos deben usar esa misma fecha.
- **D7 (decisión del dueño, 14-oct-2026):** un día con Cierre se corrige (editar, eliminar o
  AGREGAR con `requestType: "create"`) SOLO aplicando una `EditRequest` aprobada, y solo si es
  posterior al último cierre de mes. La aplicación corre en `runAsApprovedCorrection` y el
  efecto en el flujo de cada día cerrado se guarda en `ShiftClose.corrections`
  (`recordClosedDayCorrections`). El conteo original del Cierre (`totalCounted`,
  `totalExpected`, `difference`) **nunca** se modifica, ni por solicitud (assertEntityPeriod lo
  bloquea). El esperado de un día cerrado = su esperado registrado + correcciones aprobadas
  DESPUÉS de su cierre (de días ≤ él), así la cadena del Historial sigue cuadrando. El semáforo
  sigue dependiendo solo del Cierre original.
- **Pedidos de Shipday (decisión del dueño, 14-oct-2026):** un pedido entregado después del
  Cierre de su día se carga en su día (`assertOrderPeriodOpen`): un pedido no mueve caja. Solo
  lo bloquea que SU MES (o uno posterior) esté cerrado — por mes del pedido, no por el instante
  del cierre, para no perder pedidos del mes abierto.
- **Pedidos manuales (decisión del dueño, 15-oct-2026):** misma regla que Shipday. Se registran con
  su fecha REAL de entrega (`deliveredAt`: día o instante con zona, nunca futuro) aunque el día
  tenga Cierre, si su mes sigue abierto (`assertOrderPeriodOpen`). Suman comisión
  (`applyDebtDelta`) y `DailyDriverStat` del día REAL; no tocan caja ni el conteo del Cierre (una
  deuda de cliente vinculada es FIADA, sin medio). `idempotencyKey` hace que un reintento devuelva
  el mismo pedido sin duplicar comisión; mismo número + sucursal + día → 409; domiciliario o
  sucursal desactivados → 400. Lo que SÍ mueve dinero sigue con la guardia D7.
- **Turnos por hora que cruzan medianoche (decisión del dueño, 15-oct-2026):** salida < entrada =
  termina al día siguiente; se permite SOLO con `confirmOvernight: true` (sin ella → 409 con
  `details` de duración y valores). Entrada = salida → 400. Sin límite máximo de horas (el dueño
  no lo definió; no lo inventes). El mismo turno (cliente, domiciliario, día, horas) no se registra
  dos veces. Una solicitud de edición que pasa a nocturno debe traer `confirmOvernight` "true".
- **Tarifa congelada por turno (migración 37, `HourlyShift.driverHourValue/companyHourValue`):**
  cambiar la tarifa del cliente NO re-precia turnos ni deudas existentes; `editShift` recalcula con
  la tarifa del TURNO. Turnos viejos sin tarifa guardada solo usan la vigente si reproduce
  exactamente sus montos; si no, se exige eliminarlo y registrarlo de nuevo.
- **Trabajadores:** renombrar/desactivar conserva el mismo `id` y su historial (pagos por
  `workerId`). Un trabajador desactivado no recibe pagos nuevos (400). `DELETE /workers/:id` (solo
  admin) se rechaza con 409 si tiene movimientos: nunca borres historial financiero.
- Permisos: se conservaron los existentes (editar tarifas y trabajadores: cualquier usuario
  autenticado; eliminar trabajador: admin). Restringirlos es decisión del dueño.
- Capital: el ancla es el último `MonthlyClose` con `closedAt <=` la fecha consultada, nunca
  "el último" a secas. `closeMonth` guarda `snapshot.capitalAnterior`; no lo quites.
- Contrapartes (`pairWith`): exigen original existente, sin pareja previa, signo opuesto e
  igual total del grupo. Las parciales se rechazan (regla no definida). El reporte mensual
  cuenta como pendientes los pares que no cuadran.
- `POST /bank-transactions` exige `medium` o un split coherente; nunca asumas banco por defecto.
- Tarifas (Shipday y por hora): enteros ≥ 0 dentro de `MAX_MONEY`; un lote de webhook con una
  tarifa inválida se rechaza entero. $0 sigue siendo el stub provisional válido.
- Cifrado: sin clave → `EncryptionKeyError` (503). Nunca reintroduzcas una clave por defecto.
- `EditRequest`: solo los tipos de la lista `deletable` se pueden borrar; un caso desconocido
  lanza error y nunca queda "Aprobada" sin efecto. El borrado de `MonthlyClose` no existe.
- Siigo está fuera del alcance de este repositorio.

### Auditoría final de Claude (14-oct-2026, ver `CLAUDE_AUDITORIA_Y_CORRECCION_FINAL.md`)

- Sondeo de Shipday: un pedido que cae en un mes cerrado (409 de `assertOrderPeriodOpen`)
  se **omite y se reporta** en `syncMessage` (`persistOrSkipClosed`); nunca debe abortar el
  ciclo, porque entonces ningún pedido abierto posterior de la ventana se cargaba. Si agregas
  otra ruta de carga masiva, usa el mismo patrón.
- Errores 401/403 de Shipday se devuelven como 400 (`HttpError`), nunca como 401/403 propios:
  el frontend cierra sesión ante 401.
- Shipday limita ~5 peticiones/min **por cuenta**. Una segunda instalación (DEMO, otra PC)
  con la misma API key compite con producción: mantener esas sucursales desactivadas.

- Las migraciones de Prisma (`apps/api/prisma/migrations/**/*.sql`) SÍ deben
  versionarse. El `.gitignore` tiene una regla `*.sql` para respaldos de
  base de datos con una excepción explícita para las migraciones — no la
  borres, o una sucursal nueva que clone el repo se quedaría sin los cambios
  de esquema y el sistema fallaría de forma silenciosa.
- Para instalar/replicar el sistema en un PC o sucursal nueva, sigue
  `INSTALACION.md` al pie de la letra (incluye `npm run db:deploy`, que
  aplica todas las migraciones — la garantía real de que quede "igual" es
  que corra el mismo código y el mismo esquema, no una reimplementación).
