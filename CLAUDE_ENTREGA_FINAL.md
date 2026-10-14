# Entrega final de Claude — EPA Domicilios (cash-buddy-epa)

Fecha: 2026-10-13. Repositorio: `C:\cash-buddy-epa`, rama `claude/entrega-final`. Estas son pruebas propias del implementador; **no sustituyen** la auditoría independiente de Codex.

**Veredicto del implementador: no declaro el sistema listo para producción.** El código corregido pasa todas las pruebas locales, pero falta lo que no depende del código: el caso de agosto, la base de producción, Shipday real y varias decisiones del dueño (sección 9).

## 1. Correcciones efectivas

1. **RBAC real en el backend.** El rol y el estado se leen de la base de datos en cada petición. Un administrador degradado o desactivado pierde privilegios de inmediato, aunque su token anterior diga "admin". Un cambio de contraseña, rol o estado invalida las sesiones previas.
2. **403 para falta de permisos** (401 queda solo para sesión inválida). Antes, el 401 hacía que la interfaz cerrara la sesión de un usuario normal que pulsaba una acción restringida.
3. **Interfaz por rol.** "Cerrar mes" y la creación, edición y desactivación de sucursales solo aparecen para administradores. Un usuario normal no ve formularios de configuración inicial que fallarían.
4. **Cola financiera autorecuperable.** Una operación de dinero colgada ya no bloquea la caja para siempre: se libera a los ~125 s. `/api/health` informa el estado de la cola y responde 503 si queda trabada.
5. **Webhook de Shipday.** Admite ráfagas legítimas (32 concurrentes; antes rechazaba 16 de 20) y compara el token en tiempo constante. Se mantiene la validación del token antes de tocar la BD.
6. **Movimientos de Caja.** Un usuario normal no puede corregir directamente un movimiento confirmado de **ninguna** categoría (nómina, ingresos, conversiones…); debe pedirlo por solicitud aprobada. Se conserva el flujo de cobro de domicilios pendiente→confirmado.
7. **Deudas de cliente.** Descripción obligatoria, fecha real y no futura, cliente existente. Antes se aceptaba "2026-02-31" y un préstamo con fecha futura no se descontaba de la caja del día.
8. **Clientes por hora.** El sobrepago se rechaza (antes se truncaba en silencio) y eliminar un cliente con turnos lo desactiva, conservando turnos y deuda.
9. **Sucursales.** "Cargar pedidos desde hoy" ya no altera la fecha de corte de una sucursal desactivada.
10. **Sondeo de Shipday.** No reescribe pedidos cuya tarifa externa no cambió.
11. **Errores.** Los de Prisma/PostgreSQL se traducen a respuestas controladas (candado retenido por otro proceso → 503 reintentable; no encontrado → 404; conflicto → 409). Los 500 ya no exponen rutas ni SQL, y un JSON mal formado da 400.
12. **Datos sensibles.** La lista de sucursales ya no devuelve la API key cifrada. `JWT_SECRET` es obligatorio con `NODE_ENV=production`.
13. **Excel de cierre.** Los movimientos se separan por medio. Antes, los movimientos en efectivo se sumaban a la columna BANCO como "Transferencias".
14. **Validación de montos** en movimientos bancarios y conversiones: entero positivo dentro del rango de INTEGER, sin redondeo silencioso.

## 2. Causas raíz solucionadas

| Problema | Causa raíz |
|---|---|
| Privilegios revocados vigentes 7 días | El rol viajaba en el JWT y nunca se consultaba la BD |
| Expulsión al login | `requireAdmin` respondía 401, y el frontend cierra sesión ante cualquier 401 |
| Caja trabada | La cola en memoria se liberaba solo cuando `$transaction` terminaba, y Prisma no rechaza la promesa al vencer su tiempo máximo |
| Webhooks legítimos rechazados | Límite fijo de 4 activos |
| Corrección directa de nómina | El control de aprobación solo miraba las categorías 3/4 |
| Préstamo fuera de la caja del día | Fecha sin validar y construida en la hora local del servidor |
| Sobrepago por hora | `Math.min` silencioso |
| Pérdida de historia por hora | Borrado físico en cascada |
| Banco inflado en el Excel | Agregado sin distinguir el medio |

## 3. Archivos modificados

- **Backend**: `src/middlewares/auth.ts`, `src/middlewares/error.ts`, `src/config/env.ts`, `src/lib/prisma.ts`, `src/routes/index.ts`, `src/controllers/webhook.controller.ts` y los servicios `branch`, `client`, `hourly-client`, `movement`, `excel`, `bank-transaction` y `conversion`.
- **Frontend**: `app/(app)/shipday/reportes/page.tsx`, `app/(app)/sucursales/page.tsx`, `components/AppShell.tsx`.
- **Pruebas**: `apps/api/tests/claude-final.ts` y `run-claude-final.cjs` (nuevos). En `http-acceptance.ts` y `post-claude-blockers.ts`, las aserciones de usuario autenticado sin permiso pasan de 401 a 403 (cambio de comportamiento intencional, punto 2).
- **Documentos**: este archivo, `CLAUDE_CONTINUIDAD_SESION_2.md`, `INSTRUCCIONES_AUDITORIA_CODEX.md`.

Detalle exacto: `git diff 2f430a8..claude/entrega-final`.

## 4. Funcionalidades verificadas

- **Permisos**: rutas administrativas para el usuario normal (403 sin cambios); admin degradado o desactivado; cambio de contraseña.
- **Movimientos**: gastos pendientes, nómina confirmada no editable por el usuario, cobro de domicilios pendiente→confirmado.
- **Clientes**: validación de deudas; sobrepago y desactivación de clientes por hora.
- **Webhook y caja**: ráfaga legítima; candado retenido por otro proceso (503 sin efectos); caja colgada recuperada; salud.
- **Sucursales y sondeo**: sucursal desactivada; sondeo sin reescrituras; Excel por medio.
- **Toda la batería previa de Codex**, que abarca deudas, pagos concurrentes, crédito, bases, ediciones y reversiones, reportes con más de 100 domiciliarios, Excel, abonos, pedidos manuales, autosanación y overrides, desactivación de sucursales, instalación y actualización.
- **Interfaz en el navegador**, con usuario normal y administrador, sobre base temporal: visibilidad de acciones por rol y un 403 que no cierra la sesión.

## 5. Pruebas ejecutadas

Todas en bases PostgreSQL temporales, eliminadas al terminar; Shipday simulado.

| Batería | Resultado |
|---|---|
| `tests/run-financial.cjs` (45 originales) | 45/45 |
| `tests/run-post-claude.cjs` (18 de bloqueadores) | 18/18 |
| `tests/run-migration-upgrade.cjs` (instalación vacía + actualización 32→33) | 2/2 |
| `tests/run-claude-final.cjs` (modo completo) | 15/15 |
| Tipos del backend (`tsc --noEmit`) y del frontend | Sin errores |
| `npm run build` (shared + web + api) | Correcto, 31 páginas exportadas |

## 6. Compilación

`apps/api/dist/index.js` y `apps/web/out` se recompilaron el 2026-10-13 a las 21:32 desde esta rama. **No se ha reiniciado ningún backend de producción**: en este PC no había backend en ejecución.

## 7. Migraciones

No agregué migraciones. Hay 33 en el repositorio (las dos últimas son de Codex: `20260928170000_financial_payment_ledger` y `20260928220000_order_manual_override`). La base de este PC tiene las 33 aplicadas. **Producción no se ha comprobado**: no supongo que tenga las mismas; aplicar con `npm run db:deploy -w @cash-buddy/api` tras un respaldo.

## 8. Git

Rama `claude/entrega-final` con los commits `7e51e4d`, `782a9d4` y el documental. **Sin push.** `main` está 2 commits por delante de `origin/main` y esta rama suma 3 más. Los cambios ajenos se dejaron sin commitear (ver `CLAUDE_CONTINUIDAD_SESION_2.md`).

## 9. Problemas no resueltos

- **Caso de agosto (Víctor Pérez $102.400, Bryan Alvarado $14.700, total $117.100) y `_fix-august-close.ts`.** No existen en este repositorio ni en este PC, así que no pude investigar la causa raíz. No ejecuté ni escribí ningún script de corrección de datos.
- **Siigo.** No hay integración Siigo en este código. No se tocó.
- **Aislamiento de sucursales por usuario.** No existe relación usuario↔sucursal en el modelo, así que todos los usuarios autenticados ven todas las sucursales. No lo implementé para no inventar reglas de negocio.
- **Decisiones del dueño:**
  - F14: definición de "Diferencia bases" del mes.
  - D7: reversiones y ajustes que alteran días ya cerrados.
  - Si la nómina o los ingresos creados por un usuario normal deben quedar pendientes de aprobación (hoy solo los gastos 3/4).
  - Utilidad de clientes por hora en el reporte mensual.
  - Pedidos entregados mientras una sucursal está desactivada.
- **Menores conocidos:**
  - Orden de nulos en la migración de overrides históricos (solo trazabilidad, improbable en datos reales).
  - Una ráfaga de más de 64 operaciones de caja en espera recibe 503 reintentable, sin efectos parciales.
  - Un administrador que edita su propio usuario debe volver a iniciar sesión.
- **Datos históricos (H1–H9 de `AUDITORIA_CLAUDE_POST_CODEX.md`)**: requieren una copia de la base de producción y comprobantes. No se normalizan automáticamente.

## 10. Restricciones externas

- **Producción** está en otro PC sin acceso desde aquí.
- **Shipday real** no se probó, para no generar cambios en la cuenta; todas las pruebas usan respuestas simuladas.
- **`WEBHOOK_TOKEN`** no está en el `.env` de este PC, así que el webhook responde 401 hasta configurarlo.
- **La contraseña de PostgreSQL de este PC es débil.**
- **Push y despliegue** quedan pendientes de autorización.

## 11. Despliegue (en el PC de producción, tras autorización)

```powershell
# 1) Respaldo
& "C:\Program Files\PostgreSQL\17\bin\pg_dump.exe" -Fc -f backups\pre_entrega.dump "<DATABASE_URL>"
# 2) Código
git fetch; git checkout claude/entrega-final   # o fusionar en main tras la auditoría
npm install
# 3) Esquema y cliente (con CashBuddy.exe cerrado)
npm run db:deploy -w @cash-buddy/api
npm run db:generate
# 4) Compilar y arrancar
$env:NODE_ENV="production"; npm run build
# .env: JWT_SECRET (obligatorio), ENCRYPTION_KEY, WEBHOOK_TOKEN si se usa el webhook
.\CashBuddy.exe
# 5) Verificar: GET /api/health -> {"ok":true,...}
```

## 12. Comandos de prueba para Codex

Ver `INSTRUCCIONES_AUDITORIA_CODEX.md` (bases temporales, comandos exactos y criterios de aceptación).
