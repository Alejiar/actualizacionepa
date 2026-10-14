# Instrucciones para la auditoría independiente de Codex

Objetivo: que Codex verifique el sistema **sin depender de las afirmaciones de Claude**. Las pruebas incluidas son un punto de partida, no la auditoría: revisa también el código y diseña tus propios casos.

## 0. Datos del entorno

| Dato | Valor |
|---|---|
| Repositorio | `C:\cash-buddy-epa` (la ruta `C:\EPA DOMICILIOS\...` no existe en este PC) |
| Rama a auditar | `claude/entrega-final`. Base: `2f430a8`, la última entrega de Codex |
| Cambios de Claude | `git log 2f430a8..claude/entrega-final` y `git diff 2f430a8..claude/entrega-final`. Corrección de los 12 defectos: `git show 0dba9c5` y `CLAUDE_CORRECCION_12_DEFECTOS.md` |
| PostgreSQL | 17 local (`C:\Program Files\PostgreSQL\17\bin`); conexión en `C:\cash-buddy-epa\.env` (`DATABASE_URL`) |
| Base operativa | `cashbuddy`. **No escribir en ella.** Hoy tiene 33 migraciones (el repositorio tiene 34; la nueva no se aplicó aquí) y no tiene datos operativos (0 domiciliarios, 0 pedidos) |
| Producción | Otro PC, sin acceso desde aquí |

Reglas: usa solo bases temporales para todo lo que escriba datos; nunca ejecutes `reset-all`, `recalc-*`, `fix-*`, `apply-cuadre*` ni las simulaciones contra `cashbuddy`; no llames a Shipday real.

## 1. Preparar bases temporales (Git Bash)

```bash
cd /c/cash-buddy-epa
REAL=$(grep "^DATABASE_URL" .env | sed -E 's/^DATABASE_URL="?([^"]*)"?/\1/')
ADMIN=$(echo "$REAL" | sed -E 's#/cashbuddy\?.*#/postgres#')
PSQL="/c/Program Files/PostgreSQL/17/bin/psql.exe"
u() { echo "$REAL" | sed "s#/cashbuddy?#/$1?#"; }
for db in cashbuddy_codex_test_fixes cashbuddy_codex_blockers cashbuddy_claude_final cashbuddy_claude_12; do
  "$PSQL" "$ADMIN" -c "DROP DATABASE IF EXISTS $db WITH (FORCE);" -c "CREATE DATABASE $db;"
  (cd apps/api && DATABASE_URL=$(u $db) npx prisma migrate deploy)   # sin semilla: las baterías crean sus datos
done
```

## 2. Baterías existentes (comandos exactos)

```bash
cd /c/cash-buddy-epa/apps/api
DATABASE_URL=$(u cashbuddy_codex_test_fixes) node tests/run-financial.cjs        # 45 casos (Codex, ronda 1)
DATABASE_URL=$(u cashbuddy_codex_blockers)   node tests/run-post-claude.cjs      # 18 casos (Codex, bloqueadores)
DATABASE_URL=$(u cashbuddy_codex_blockers)   node tests/run-migration-upgrade.cjs # instalación vacía + actualización (crea/borra sus propias BD)
DATABASE_URL=$(u cashbuddy_claude_final)     node tests/run-claude-final.cjs      # 15 casos (Claude); QUICK=1 omite la prueba de 2 min
DATABASE_URL=$(u cashbuddy_claude_12)        node tests/run-codex-12-defectos.cjs # 26 casos: I01–I10 e I13 de Codex + bordes
```

Cada runner rechaza bases que no sean la temporal esperada. Los JSON y registros quedan en `apps/api/tests/` (ignorados por Git).

**14-oct:** en `tests/claude-final.ts`, la degradación de admin se hace ahora por `PATCH /users/:id` (camino real, que incrementa `tokenVersion`), y se añadió el caso de UPDATE directo en la BD (403). La expectativa de 401 no cambió.

**Expectativas modificadas por Claude:** solo en `tests/http-acceptance.ts` (1 línea) y `tests/post-claude-blockers.ts` (3 líneas). Pasan de 401 a 403 cuando el usuario **está autenticado pero sin permiso**. Las de usuario sin sesión y las de webhook con token inválido siguen en 401. Compruébalo con `git diff 2f430a8..claude/entrega-final -- apps/api/tests/`.

## 3. Tipos y compilación

```bash
cd /c/cash-buddy-epa/apps/api && npx tsc --noEmit -p tsconfig.json
cd /c/cash-buddy-epa/apps/web && npx tsc --noEmit -p tsconfig.json
# Compilado instalado vs código (backend), sin sobrescribir dist:
cd /c/cash-buddy-epa/apps/api && npx tsup --out-dir /tmp/rebuild && diff <(grep -v sourceMappingURL /tmp/rebuild/index.js) <(grep -v sourceMappingURL dist/index.js) | wc -l   # esperado 0
```

## 4. Áreas críticas y criterios de aceptación

| Área | Qué verificar | Criterio de aceptación |
|---|---|---|
| RBAC | Todas las rutas con `requireAdmin` en `src/routes/index.ts`; `middlewares/auth.ts` | Usuario normal → 403 sin efectos; sin sesión → 401; admin degradado o desactivado → 401/403 con su token anterior; cambio de contraseña invalida sesiones, también dentro del mismo segundo (`tokenVersion`) |
| Períodos cerrados (F05/D7) | `lib/period-guard.ts` y sus usos | Caja, Historial y Movimientos usan la misma fecha operativa; dinero con fecha en un día con Cierre o antes del último cierre de mes → 409 sin efectos |
| Contrapartes (F01) | `bank-transaction.service.ts::create`, `close.service.ts::getMonthlyReport` | Solo se concilian signo opuesto e igual total; los pares históricos que no cuadran aparecen como pendientes |
| Interfaz por rol | `reportes/page.tsx`, `sucursales/page.tsx`, `AppShell.tsx`, `lib/sd-api.ts` (401 cierra sesión, 403 no) | Usuario normal no ve "Cerrar mes" ni crear/editar/desactivar sucursal; un 403 no lo expulsa |
| Integridad financiera | `applyDebtDelta`, `moneyTransaction`, servicios de driver, base, bank-transaction, client y hourly | Deuda y crédito nunca ambos > 0 ni negativos; operaciones concurrentes conservan todos los deltas; fallo = sin efectos parciales |
| Cola financiera | `lib/prisma.ts` | Operación colgada liberada en ≤ ~125 s; `/api/health` refleja `moneyQueue`; candado de otro proceso → 503 sin efectos |
| Shipday | `webhook.controller.ts`, `branch.service.ts` (`persistDeliveredOrder`), `shipday.service.ts` | Token antes de cualquier consulta; ráfagas legítimas aceptadas; lápidas respetadas; overrides manuales (`manualOverride`) no sobrescritos; sin duplicados; sondeo sin reescrituras innecesarias |
| Overrides $0 | Campos `manualOverride`, `manualOriginalValue`, `manualOverrideBy`, `manualOverrideAt`, `shipdayDeliveryValue` | Un $0 aprobado sobrevive a sondeos y webhooks; un provisional $0 del webhook sí se sana |
| Caja / movimientos | `movement.service.ts`, `movement.controller.ts` | Gastos del usuario normal → pendientes; corregir un confirmado (cualquier categoría) solo por `EditRequest`; montos enteros > 0 |
| Clientes | `client.service.ts`, `hourly-client.service.ts` | Sin deudas negativas ni campos inyectados; fecha real y no futura; sobrepago rechazado (normal y por hora); diario `ClientDebtPayment` = acumulados |
| Sucursales | `branch.service.ts` | Desactivar conserva todo el historial y los totales; sin pedidos nuevos; "cargar desde hoy" no altera una inactiva |
| Reportes | `close.service.ts`, `excel.service.ts`, `shipday-dashboard.service.ts` | Dashboard = Deudas = Reporte = Excel en deuda total (también con más de 100 domiciliarios); Excel separa efectivo y banco |
| Errores y datos sensibles | `middlewares/error.ts`, `branch.service.ts::sanitize`, `config/env.ts` | Los 500 no exponen internos; sin `apiKeyEnc` en las respuestas; `JWT_SECRET` obligatorio en producción |
| Zona horaria | `lib/date-range.ts` y sus usos | Días según Bogotá (UTC-5), también en límites de 23:59:59 y 00:00:00 |
| Migraciones | `prisma/migrations` (34) y `services/auto-init.service.ts` | Instalación vacía y actualización sin pérdida; el arranque aborta con migraciones pendientes o fallidas |

## 5. Interfaz (opcional, recomendado)

Levanta un servidor contra una base temporal (nunca `cashbuddy`), crea un administrador y un usuario de prueba, e inicia sesión con cada rol en `http://127.0.0.1:<puerto>`. Ejemplo de servidor: `C:\LayaJarvis\auditoria-claude-segunda\ui-server.ts` (usa la BD `cashbuddy_claude_ui` y el puerto 4610).

## 6. Fuera del alcance verificable aquí

Base de producción y sus inconsistencias históricas (H1–H9), caso de agosto (Víctor Pérez / Bryan Alvarado y `_fix-august-close.ts`, ausentes de este repositorio), Siigo (fuera del alcance por instrucción del dueño), Shipday real, lanzador y watchdog, y carga sostenida. También hay decisiones del dueño pendientes (F14, D7, aprobación de nómina e ingresos, utilidad por hora). Detalle en `CLAUDE_ENTREGA_FINAL.md` §9–10.
