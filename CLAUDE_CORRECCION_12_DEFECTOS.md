# Corrección de los 12 defectos confirmados por Codex — EPA Domicilios

Fecha: 2026-10-14. Repositorio: `C:\cash-buddy-epa`, rama `claude/entrega-final`.
Base auditada por Codex: `1823195` (`CODEX_AUDITORIA_UNICA_FINAL.md`). Commit de la corrección: `0dba9c5` (sin push).

Son pruebas del implementador y **no sustituyen una auditoría independiente**. **No declaro el sistema completo aprobado ni listo para producción** (ver §4 y §5). Siigo quedó fuera del alcance por instrucción del dueño y no se tocó.

## 1. Resumen de verificación

Todo se ejecutó sobre bases PostgreSQL temporales, eliminadas al terminar, con Shipday simulado y la red externa bloqueada.

| Prueba | Resultado |
|---|---|
| Regresión nueva `tests/codex-12-defectos.ts` (26 casos: I01–I10 e I13 de Codex con las mismas entradas y expectativas, más casos de borde) | **26/26** |
| Reproductor original de Codex `codex-independent.ts` (I01–I14), sin cambios salvo la ruta del JSON de evidencia | **13/14**. I09 difiere por diseño: ver M01 |
| Reproductor original de Codex `codex-crypto-fallback.ts` (`.encryption-key` como directorio, sin `ENCRYPTION_KEY`) | Ya no cifra: lanza `EncryptionKeyError` (EISDIR). Antes, la clave pública descifraba |
| `tests/run-financial.cjs` (45 originales) | **45/45**, ningún defecto reproducido |
| `tests/run-post-claude.cjs` (18 bloqueadores) | **18/18** |
| `tests/run-claude-final.cjs` (15) | **15/15** (incluye la caja colgada de ~2 min) |
| `tests/run-migration-upgrade.cjs` (instalación vacía con las 34 migraciones + actualización) | **2/2** |
| `tsc --noEmit` API y web | 0 errores |
| `NODE_ENV=production npm run build` (shared + web + api) | Correcto |
| M02 en el navegador (backend compilado, BD temporal, puerto 4917) | Verificado (ver M02) |
| BD operativa `cashbuddy` (solo lectura) | Intacta: 33 migraciones, sin columna `tokenVersion` |

## 2. Matriz por defecto

### F01 — Contrapartes desiguales o del mismo signo aparecían conciliadas · **CORREGIDO Y VERIFICADO**

- **Causa raíz:** `bank-transaction.service.ts::create` enlazaba `pairWith` sin validar nada. Además, el reporte mensual excluía cualquier fila con `pairId` del indicador de pendientes.
- **Corrección:** dentro de `moneyTransaction` se exige:
  - que el original exista (si no, 404) y que su grupo no esté ya emparejado (si no, 409);
  - que el original no sea `noCounterpart`, no esté aplicado a deuda (`debtApplied`) ni pertenezca a un turno por hora;
  - signo opuesto e importe igual al **total del grupo** (incluido el mixto).

  Las contrapartes parciales se **rechazan**, porque su regla no está definida. Si se manda `pairWith` y `noCounterpart` a la vez, se rechaza (400). El nuevo `pairId` se asigna a todo el grupo original. En `getMonthlyReport`, los pares históricos que no cuadran se vuelven a contar como pendientes ("par que no cuadra").
- **Archivos:** `apps/api/src/services/bank-transaction.service.ts`, `apps/api/src/services/close.service.ts`.
- **Regresión:** F01/I04, F01/I05, F01b (inexistente 404, par válido con diferencia 0, segunda contraparte 409, dos simultáneas → [201, 409] y una sola pareja), F01c (original mixto: parcial 400, total 201), F01d (par histórico 75.000/1 → diferencia −74.999 y `ok=false`).
- **Resultado:** 5/5. Codex I04 e I05: OK.
- **Riesgo:** si el negocio necesita contrapartes parciales, hay que definir su regla. Los pares históricos descuadrados ya aparecen como pendientes, pero no se corrigen solos.

### F02 — Tarifas por hora negativas generaban deuda negativa · **CORREGIDO Y VERIFICADO**

- **Causa raíz:** `updateHourlyClient` aplicaba `Math.round` sin validar, y `registerShift` incrementaba la deuda con montos derivados negativos.
- **Corrección:** la misma validación en el alta y en la edición:
  - cada tarifa es un entero ≥ 0 dentro de `MAX_MONEY`, la suma es > 0 y el nombre no está vacío;
  - la edición valida el **par resultante**, corre en `moneyTransaction` y da 404 si el cliente no existe;
  - los montos derivados de un turno (alta y edición) pasan por `assertMoney` antes de escribir.
- **Archivos:** `apps/api/src/services/hourly-client.service.ts`.
- **Regresión:** F02/I07 y F02b. Se rechazan en el alta los negativos, fracciones, texto, desborde, suma 0 y nombre vacío (6 × 400). En la edición, 4 × 400. No queda ninguna tarifa negativa en la BD.
- **Resultado:** 2/2. Codex I07: OK (PATCH −12.000 → 400; turno $20.000; deuda $20.000).
- **Riesgo:** clientes existentes con tarifas inválidas previas no se normalizan solos. Su próxima edición exigirá valores válidos.

### F03 — Un cierre nuevo reemplazaba el capital de fechas anteriores · **CORREGIDO Y VERIFICADO**

- **Causa raíz:** `getExpectedBalances` tomaba el último `MonthlyClose` global aunque se hubiera registrado después de la fecha consultada.
- **Corrección:**
  - El ancla es el último cierre con `closedAt <=` fin del día consultado. Si no hay ninguno, se usa el capital anterior al primer cierre.
  - `closeMonth` ahora guarda `snapshot.capitalAnterior` (los Settings vigentes antes de cerrar).
  - Un cierre sin capital explícito conserva el capital vigente en lugar de dejarlo vacío.
- **Archivos:** `apps/api/src/services/shipday-dashboard.service.ts`, `apps/api/src/services/close.service.ts`.
- **Regresión:**
  - F03/I03: ayer sigue igual tras el cierre, y desde el cierre manda el capital nuevo (500.000/200.000).
  - F03b: un cierre sin capital conserva 100.000/100.000, y un cambio posterior de Settings no altera el saldo anclado.
- **Resultado:** 2/2. Codex I03: OK.
- **Riesgos:**
  - Los cierres **anteriores** a esta versión no tienen `capitalAnterior`. Para fechas previas al primer cierre, se usa Settings como capital.
  - La fecha de efectividad del capital sigue siendo `closedAt`: su definición formal es una decisión pendiente del dueño.

### F04 — El cierre guardaba un esperado bancario desactualizado · **CORREGIDO Y VERIFICADO**

- **Causa raíz:** `shift-close.controller.ts::register` calculaba `getExpectedBalancesForDate` antes de obtener el candado financiero.
- **Corrección:** el cálculo del esperado y `registerShift` ocurren en la **misma** `moneyTransaction`.
- **Archivos:** `apps/api/src/controllers/shift-close.controller.ts`.
- **Regresión:**
  - F04/I08: el cierre se encola detrás de un ingreso de $10.000 retenido y guarda `bankExpected` igual al banco actual, con diferencia 0.
  - F04b: dos cierres simultáneos del mismo turno → [201, 409]; un `bankCounted` inválido → 400, sin cierre creado.
- **Resultado:** 2/2. Codex I08: OK.
- **Riesgo:** el conteo físico sigue siendo el del instante en que se envía. No hay "corte" con versión explícita, como se sugirió como alternativa.

### F05 — Un movimiento retroactivo no conciliaba entre fecha operativa, Historial y Caja · **CORREGIDO Y VERIFICADO** (D7 sigue pendiente)

- **Causa raíz:** la caja filtraba `Movement.createdAt`, mientras el Historial y la lista usaban `Movement.date` (o `createdAt` con la etiqueta `date`).
- **Corrección:**
  - Nuevo `lib/period-guard.ts`. `movementEffectiveAt` hace que un movimiento cuente en su instante real si se registró el mismo día de su fecha operativa, o al final de su fecha operativa si es retroactivo.
  - Caja (`getExpectedBalances`), Historial (`getDaySummary`) y Movimientos (`unified-movements`) usan esa misma fecha.
  - `assertOpenPeriod` rechaza, con **409**, registrar, aprobar o editar dinero con fecha explícita en un **día con Cierre** o **antes del último cierre de mes**. También rechaza, con 400, las fechas posteriores al día operativo.
  - Se aplica en movimientos de Caja (alta, aprobación, edición y solicitudes), banco con fecha pasada, conversiones y deudas de cliente retroactivas.
  - `getDaySummary` ahora incluye conversiones y préstamos de clientes, así que apertura + ingresos − egresos = cierre.
- **Archivos:** `apps/api/src/lib/period-guard.ts` (nuevo), `apps/api/src/services/shipday-dashboard.service.ts`, `day.service.ts`, `unified-movements.service.ts`, `movement.service.ts`, `bank-transaction.service.ts`, `conversion.service.ts`, `client.service.ts`, `edit-request.service.ts`, `apps/web/components/wizards/BankTransactionWizard.tsx` (fecha anclada a Bogotá).
- **Regresión:**
  - F05/I02: la caja de ayer cambia +10.000, el Historial de ayer muestra 10.000 de ingresos, hoy muestra 0 y el saldo final es 110.000. La lista del día lo incluye.
  - F05b: con el día cerrado, el alta, la aprobación y el banco retroactivo dan 409; una fecha futura da 400; los saldos no cambian.
  - F05c: un movimiento previo al cierre de mes da 409, y el desglose del día concilia con su saldo.
- **Resultado:** 3/3. Codex I02: OK.
- **Riesgos y decisión pendiente:**
  - **D7** (cómo ajustar un día o mes ya cerrado) sigue sin definir: hoy se **bloquea** en lugar de alterar cifras cerradas. Un ajuste legítimo en un período cerrado no tiene camino hasta que el dueño lo defina.
  - La edición por solicitud de un movimiento confirmado en un día cerrado también queda bloqueada.

### F06 — El Excel duplicaba una base solo bancaria en la columna de efectivo · **CORREGIDO Y VERIFICADO**

- **Causa raíz:** `givenCash || givenTotal` reemplazaba un cero explícito por el total (igual en las devueltas).
- **Corrección:**
  - Las bases se leen fila por fila. El respaldo "sin desglose = efectivo" solo aplica cuando ambas partes son 0.
  - Las devoluciones internas ligadas a banco se excluyen, porque ya están en Movimientos.
  - Las filas "5-Bases Entregadas" y "6-Bases Devueltas" separan efectivo y banco.
- **Archivos:** `apps/api/src/services/excel.service.ts`.
- **Regresión:** F06/I06:
  - solo banco → [0, 10.000];
  - con una base mixta de 4.000/6.000 y una antigua sin desglose de 2.500 → [6.500, 16.000];
  - devuelta por banco más un pago bank-linked → [0, 3.000].
- **Resultado:** 1/1. Codex I06: OK.
- **Riesgo:** ninguno conocido. `getDaySummary` usa la misma regla.

### F07 — Un split solo en efectivo se registraba como banco · **CORREGIDO Y VERIFICADO**

- **Causa raíz:** el medio simple salía de `data.medium` con banco por defecto, sin mirar el split.
- **Corrección:**
  - Un split con una sola parte positiva decide el medio. Un `medium` que lo contradiga, o un `amount` distinto de la suma, se rechaza con 400.
  - Sin split, `medium` es obligatorio (`cash` o `bank`).
  - El asistente de banco ahora envía `medium: "bank"`. El asistente unificado ya lo enviaba, y en modo mixto exige ambas partes > 0.
- **Archivos:** `apps/api/src/services/bank-transaction.service.ts`, `apps/web/components/wizards/BankTransactionWizard.tsx`.
- **Regresión:** F07/I10 y F07b. Solo banco = banco. Dan 400: las 2 contradicciones, la suma errónea, la falta de medio y un medio inválido. El mixto crea 2 filas y los saldos esperados cuadran.
- **Resultado:** 2/2. Codex I10: OK.
- **Riesgo:** un cliente externo de la API que omita `medium` ahora recibe 400. Antes se registraba en banco en silencio.

### S01 — Un cambio de contraseña dentro del mismo segundo dejaba válida la sesión anterior · **CORREGIDO Y VERIFICADO**

- **Causa raíz:** la revocación comparaba `iat` (en segundos) con `updatedAt − 1000 ms`, lo que dejaba un hueco.
- **Corrección:**
  - Nueva columna `User.tokenVersion` (migración `20261014090000_user_token_version`). El JWT lleva `tv`.
  - `requireAuth` exige `tv == tokenVersion`. `updateUser` la incrementa al cambiar contraseña, rol o estado.
  - Se eliminó la comparación por tiempo. Un token anterior sin `tv` equivale a la versión 0, así que las sesiones vigentes no caen al actualizar.
- **Archivos:** `apps/api/prisma/schema.prisma`, `apps/api/prisma/migrations/20261014090000_user_token_version/`, `apps/api/src/lib/jwt.ts`, `apps/api/src/services/auth.service.ts`, `apps/api/src/middlewares/auth.ts`, `apps/api/src/services/user.service.ts`.
- **Regresión:**
  - S01/I01: mismo segundo → 401; la sesión nueva da 200.
  - S01b: degradar por API → 401; la sesión nueva con rol "user" → 403; desactivar → 401; Settings sin cambios.
  - S01c: el login real funciona; un token sin `tv` sirve hasta que la cuenta cambia, y luego da 401.
  - En `claude-final.ts`, la degradación se hace ahora por `PATCH /users/:id`, el camino real. Además se añadió que un UPDATE directo en la BD sigue quitando el privilegio (403).
- **Resultado:** 3/3. Codex I01: OK.
- **Riesgos:**
  - Un UPDATE manual del rol en la BD, sin pasar por la API, no revoca el token (el privilegio sí se pierde: 403).
  - Un administrador que se edita a sí mismo debe volver a iniciar sesión.

### S02 — El webhook autenticado aceptaba tarifas negativas · **CORREGIDO Y VERIFICADO**

- **Causa raíz:** `Math.round` del valor sin límites, con un criterio distinto entre pedido y deuda.
- **Corrección:**
  - `parseShipdayFee`: null o "" → 0, que sigue siendo el stub provisional válido. Se acepta un número finito, ≥ 0 y ≤ `MAX_MONEY`; cualquier otro valor es inválido.
  - Si un evento de entrega trae una tarifa inválida, el **lote completo** se rechaza con 400 antes de `moneyTransaction`.
  - El sondeo (`syncBranch`/`reconcileBranch`) omite esos pedidos y marca la sincronización como incompleta (`partial`, `syncStatus=error`) con un aviso.
  - `persistDeliveredOrder` lanza un error como defensa en profundidad.
- **Archivos:** `apps/api/src/controllers/webhook.controller.ts`, `apps/api/src/services/branch.service.ts`.
- **Regresión:**
  - S02/I13: negativo → 400, sin pedido y con ventas en 0.
  - S02b: texto → 400; lote con un inválido → 400 sin pedidos; $0 → 200; 10 repetidos simultáneos → un pedido y deuda de 3.000.
  - S02c: el sondeo omite "neg", crea "pos" y marca `partial`/`error`.
- **Resultado:** 3/3. Codex I12 e I13: OK.
- **Riesgo:** si Shipday reintenta un lote con un elemento inválido, los válidos de ese lote entran por el sondeo, no por el webhook.

### S03 — Un fallo de persistencia activaba una clave de cifrado pública · **CORREGIDO Y VERIFICADO**

- **Causa raíz:** `loadOrCreateSecret` devolvía la cadena fija `cash-buddy-default-key-change-me` ante cualquier error.
- **Corrección:**
  - Se eliminó la clave fija. Se usa `ENCRYPTION_KEY`; si no existe, `.encryption-key`.
  - Lanza `EncryptionKeyError` si el archivo no se puede leer, está vacío o no se puede crear (`flag: "wx"`, sin sobrescribir).
  - `middlewares/error.ts` responde 503 sin detalles.
  - No se exige una longitud mínima, para no romper claves existentes.
- **Archivos:** `apps/api/src/lib/crypto.ts`, `apps/api/src/middlewares/error.ts`.
- **Regresión:** S03, en procesos aislados:
  - directorio → `EncryptionKeyError`; archivo vacío → `EncryptionKeyError`;
  - archivo nuevo → cifra y descifra sin sobrescribir la clave;
  - la clave pública ya no descifra;
  - `ENCRYPTION_KEY` por entorno funciona.
- **Resultado:** 1/1. El reproductor de Codex ahora aborta con `EncryptionKeyError`.
- **Riesgos:**
  - Las API keys cifradas en algún momento con la clave pública (solo si ese fallback llegó a activarse en producción) ya no se descifran: habría que volver a capturarlas.
  - No se migró a cifrado autenticado (GCM).
  - No se rotó ninguna clave productiva.

### M01 — La eliminación de un MonthlyClose quedaba "aprobada" sin efecto · **CORREGIDO Y VERIFICADO**

- **Causa raíz:** `validateChanges` admitía el tipo, pero `deleteEntity` caía en un `default` que solo advertía, y `reviewRequest` marcaba la solicitud como aprobada.
- **Corrección:**
  - Lista explícita de borrados implementados. Pedir el borrado de un tipo no soportado (p. ej. `MonthlyClose`) da 400 **al crear** la solicitud.
  - Los `default` de borrar y editar lanzan error. Borrar un registro que ya no existe da 404, y la solicitud queda pendiente para rechazarla.
  - El efecto se aplica antes de marcar "Aprobada".
- **Archivos:** `apps/api/src/services/edit-request.service.ts`.
- **Regresión:**
  - M01/I09: crear la solicitud → rechazada. Una solicitud antigua aprobada lanza error, sigue pendiente y el cierre sigue existiendo; se puede rechazar.
  - M01b: dos aprobaciones del mismo borrado → una aprobada y la otra pendiente.
- **Resultado:** 2/2.
  - **El reproductor original de Codex marca I09 como FAIL**, porque su aserción exige que el cierre **se borre** (`remains === 0`). Esa expectativa contradice la corrección que el mismo informe recomienda: "rechazar operaciones no implementadas… No se propone habilitar la eliminación de un cierre sin autorización". Seguí la recomendación y **no** habilité el borrado de cierres. Hoy `createRequest` responde "La eliminación de MonthlyClose no está implementada."
- **Riesgo:** borrar un cierre mensual requiere una regla del dueño y una reversión íntegra. No existe.

### M02 — Configuración mostraba "guardado" pese al 403 · **CORREGIDO Y VERIFICADO**

- **Causa raíz:** `store.tsx::updateSettings` capturaba el error y devolvía una promesa resuelta. La página lo tomaba como éxito, y los formularios estaban habilitados para el operador.
- **Corrección:**
  - `updateSettings` y `resetAll` propagan el error.
  - `configuracion/page.tsx` muestra el éxito solo tras persistir y no envía nada si el usuario no es admin.
  - Para el no-admin hay un aviso "🔒 Solo lectura" y un `<fieldset disabled>` sobre marca, empresa/capital y porcentaje.
  - `WelcomeWizard` muestra el error (`TermsGate` ya lo hacía).
- **Archivos:** `apps/web/lib/store.tsx`, `apps/web/app/(app)/configuracion/page.tsx`, `apps/web/components/wizards/WelcomeWizard.tsx`.
- **Regresión (navegador, backend compilado, BD temporal):**
  - Operador: el aviso está visible; los 3 botones Guardar y los 6 campos están deshabilitados.
  - Administrador con `PATCH /api/settings` forzado a 503: solo aparece el aviso de error, sin "guardado".
  - No es una prueba automatizada permanente: el repositorio no tiene arnés de interfaz.
- **Resultado:** verificado manualmente en el navegador integrado.
- **Riesgo:** sin prueba de interfaz automatizada.

## 3. Cambios de comportamiento visibles

- `POST /bank-transactions` sin `medium` ni split → 400. Contraparte incompatible → 400/404/409.
- Registrar, aprobar o editar dinero en un día con Cierre o antes del último cierre de mes → 409 (D7).
- Webhook con una tarifa inválida → 400 para todo el lote.
- Sin clave de cifrado legible → 503 en las operaciones que cifran o descifran.
- Pedir el borrado de un tipo no soportado → 400 al crear la solicitud.

## 4. Antes de volver a abrir CashBuddy.exe en este PC

`apps/api/dist` y `apps/web/out` se recompilaron desde esta rama, y el cliente de Prisma se regeneró con `tokenVersion`. La BD operativa de este PC sigue con 33 migraciones: **no** apliqué la nueva sin autorización. Por eso, al arrancar, la verificación de migraciones **abortará** con el aviso de migraciones pendientes, que es la protección prevista. Para usar la app aquí:

1. Hacer un respaldo con `pg_dump`.
2. Ejecutar `npm run db:deploy -w @cash-buddy/api` con CashBuddy.exe cerrado.
3. Reabrir la app.

En producción, el procedimiento es el de `CLAUDE_ENTREGA_FINAL.md` §11.

## 5. Bloqueado o fuera de alcance

- **Caso de agosto** (Víctor Pérez $102.400, Bryan Alvarado $14.700) y `_fix-august-close.ts`: no existen en este repositorio ni en este PC. La BD de este PC no tiene domiciliarios. No toqué esos valores.
- **Producción**, Shipday real y datos históricos (H1–H9): sin acceso.
- **Decisiones del dueño, sin inventar reglas:**
  - F14;
  - D7 (hoy se bloquea);
  - aprobación de ingresos y nómina;
  - usuarios↔sucursales;
  - utilidad por hora;
  - pedidos de sucursales inactivas;
  - pérdidas históricas;
  - fecha efectiva del capital;
  - contrapartes parciales (hoy se rechazan);
  - borrado de cierres mensuales (no implementado).
- **Siigo:** excluido por instrucción.

## 6. Cómo repetir

Ver `INSTRUCCIONES_AUDITORIA_CODEX.md` §1–3. Para la batería nueva:

```bash
cd /c/cash-buddy-epa/apps/api
DATABASE_URL=$(u cashbuddy_claude_12) node tests/run-codex-12-defectos.cjs   # BD temporal migrada; 26 casos
```
