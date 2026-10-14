# Continuidad para la sesión 2 de Claude — EPA Domicilios

Fecha: 2026-10-13 (sesión 1). Repositorio real: `C:\cash-buddy-epa`. La ruta `C:\EPA DOMICILIOS\cash-buddy-epa` **no existe** en este PC.

## Actualización 2026-10-14

- Corregidos y verificados los 12 defectos de `CODEX_AUDITORIA_UNICA_FINAL.md` (commit `0dba9c5`). Matriz completa en `CLAUDE_CORRECCION_12_DEFECTOS.md`.
- Nueva migración 34 `20261014090000_user_token_version`, **no aplicada** a la BD de este PC: CashBuddy.exe abortará al arrancar hasta ejecutar `db:deploy` con respaldo.
- Nueva batería `tests/codex-12-defectos.ts` + `run-codex-12-defectos.cjs` (BD temporal `cashbuddy_claude_12`): 26/26.
- Siigo, fuera del alcance por instrucción del dueño.
- Pendiente: push y despliegue (requieren autorización), decisiones del dueño (D7 hoy bloquea, contrapartes parciales, F14…) y el caso de agosto (no está en este PC).

## Estado de Git

- Rama de trabajo: `claude/entrega-final`, creada desde `main` (`2f430a8`). **No hay push**: `main` ya iba 2 commits por delante de `origin/main` y esta rama suma los commits de abajo.
- Commits de esta sesión:
  - `7e51e4d` fix(seguridad,caja): RBAC desde la BD, 403, cola financiera autorecuperable y validaciones
  - `782a9d4` fix(reportes,validación): Excel separa movimientos por medio; montos enteros en banco y conversiones
  - (más el commit documental que contiene este archivo)
- Cambios ajenos que se dejaron intactos y fuera de los commits: la línea `simulate-3months` en `apps/api/package.json`, `apps/api/scripts/simulate-3months.ts`, `CONTEXTO_AUDITORIA.md`, `AUDITORIA_CLAUDE_POST_CODEX.md` y `AUDITORIA_CLAUDE_SEGUNDA_REVISION.md`.

## Hecho en la sesión 1 (código + pruebas)

| Corrección | Archivos |
|---|---|
| RBAC real: rol y estado leídos de la BD en cada petición; cambiar rol, estado o contraseña invalida las sesiones previas; falta de permisos = 403 | `apps/api/src/middlewares/auth.ts` |
| `JWT_SECRET` obligatorio en producción | `apps/api/src/config/env.ts` |
| La lista de sucursales no expone `apiKeyEnc` | `apps/api/src/services/branch.service.ts` |
| Errores: Prisma mapeado (55P03→503, P2025→404, P2003/P2002→409, validación→400), sin mensajes internos en los 500, JSON mal formado→400 | `apps/api/src/middlewares/error.ts` |
| Cola financiera: tiempo máximo propio (125 s) que libera la caja si una operación se cuelga; liberación idempotente; estado de la cola en `/api/health` (503 si está trabada) | `apps/api/src/lib/prisma.ts`, `apps/api/src/routes/index.ts` |
| Webhook: 32 entregas autenticadas concurrentes (antes 4 rechazaba legítimas); token comparado en tiempo constante | `apps/api/src/controllers/webhook.controller.ts` |
| Movimientos: un usuario normal no corrige un confirmado de ninguna categoría (debe usar solicitud); los pendientes de cobro siguen editables | `apps/api/src/services/movement.service.ts` |
| Deudas de cliente: descripción obligatoria, fecha real y no futura, cliente existente (404) | `apps/api/src/services/client.service.ts` |
| Clientes por hora: sobrepago rechazado; eliminar con turnos solo desactiva | `apps/api/src/services/hourly-client.service.ts` |
| Sucursal desactivada: "cargar desde hoy" no cambia su fecha de corte; el sondeo no reescribe pedidos sin cambios | `apps/api/src/services/branch.service.ts` |
| Excel: movimientos separados por medio (efectivo/banco) | `apps/api/src/services/excel.service.ts` |
| Montos enteros validados en banco y conversiones | `bank-transaction.service.ts`, `conversion.service.ts` |
| Interfaz: "Cerrar mes" y gestión de sucursales solo para administradores; aviso para usuarios normales en un sistema sin configurar | `apps/web/app/(app)/shipday/reportes/page.tsx`, `apps/web/app/(app)/sucursales/page.tsx`, `apps/web/components/AppShell.tsx` |
| Pruebas nuevas | `apps/api/tests/claude-final.ts`, `apps/api/tests/run-claude-final.cjs` |
| Aserciones de Codex 401→403 (usuario autenticado sin permiso; cambio intencional) | `apps/api/tests/http-acceptance.ts`, `apps/api/tests/post-claude-blockers.ts` |

## Pruebas ejecutadas (bases temporales, eliminadas al terminar)

- 45 originales: 45/45. 18 de bloqueadores: 18/18. Migración/instalación: 2/2.
- `claude-final.ts` (modo completo): 15/15, incluida la recuperación de una caja colgada (~2 min).
- Tipos de backend y frontend sin errores; `npm run build` completo (31 páginas). `dist` y `out` instalados ya corresponden al código.
- Interfaz en el navegador (base temporal): el usuario normal no ve "Cerrar mes" ni las acciones de sucursales, y un 403 no cierra su sesión. El administrador sí las ve.
- Base operativa: solo lectura; sigue con 33 migraciones y sin datos operativos.

## Pendiente y bloqueado

- **Caso de agosto (Víctor Pérez $102.400, Bryan Alvarado $14.700, `_fix-august-close.ts`), Siigo y `AGENTS.md`**: no existen en este repositorio ni en este PC (búsqueda en disco y en la rama remota `origin/fix/correcciones-criticas`, que es de junio). Requiere acceso al PC o repositorio de producción.
- Decisiones del dueño, sin implementar: F14, D7 (reversiones en días cerrados), si la nómina o los ingresos creados por un usuario normal requieren aprobación, utilidad por hora, pedidos de sucursales inactivas.
- Aislamiento de sucursales por usuario: el modelo no tiene relación usuario↔sucursal (todos los usuarios ven todas). Implementarlo sería inventar una regla; queda documentado.
- Producción: push, despliegue y auditoría de una copia de su base (H1–H9).

## Siguiente paso exacto (sesión 2)

1. Si aparece el repositorio de producción, compararlo con esta rama antes de integrar (`git diff`), y resolver el caso de agosto con datos reales y respaldo.
2. Si no aparece: revisar `CLAUDE_ENTREGA_FINAL.md` e `INSTRUCCIONES_AUDITORIA_CODEX.md` y entregar a Codex tal como están.
