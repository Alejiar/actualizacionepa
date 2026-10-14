# CODEX — Resultados de pruebas finales EPA Domicilios

Fecha: 14 de octubre de 2026. Rama: `claude/entrega-final`. Código ensayado y conservado en el commit local **`d801079`**, sobre `e198b53`.

**Resultado: APTO CON CONDICIONES para entrega local.** RG01, PF01, PF02 y los seis bordes obligatorios pasan. No se autoriza producción ni se afirma que los datos reales, agosto o Shipday real hayan sido corregidos.

## 1. Conteos verificados

| Batería | Ejecutados | Aprobados | Fallidos | Omitidos | Evidencia |
|---|---:|---:|---:|---:|---|
| Núcleo financiero | 11 | 11 | 0 | 0 | `reproduccion.json` |
| Financieros adicionales | 8 | 8 | 0 | 0 | `adicionales.json` |
| Sincronización simulada | 6 | 6 | 0 | 0 | `sync-clientes.json` |
| Clientes | 2 | 2 | 0 | 0 | `clients.json` |
| Aceptación financiera anterior | 13 | 13 | 0 | 0 | `financial-acceptance.json` |
| HTTP anterior | 5 | 5 | 0 | 0 | `http-acceptance.json` |
| Bloqueadores | 18 | 18 | 0 | 0 | `post-claude-blockers.json` |
| Claude, modo completo sin QUICK | 15 | 15 | 0 | 0 | `claude-final.json` |
| Correcciones de los doce defectos | 26 | 26 | 0 | 0 | `codex-12-defectos.json` |
| Reproductores originales, I09 actualizado | 14 | 14 | 0 | 0 | `codex-independent-final.json` |
| Bordes E01–E08 | 8 | 8 | 0 | 0 | `codex-final-edges.json` |
| Nuevas regresiones y aceptación integrada | 53 | 53 | 0 | 0 | `codex-definitive.json` |
| Migraciones existentes | 2 | 2 | 0 | 0 | `migration-v2.json` |
| **Total enumerado** | **181** | **181** | **0** | **0** | `final-results.json` |

Los primeros seis grupos suman las **45 financieras**. Con las 18 y 15 forman las 78 anteriores. Las 26 siguientes son adicionales: **104 previas** preservadas. Los 14 + 8 + 53 añaden **75** casos; con las dos migraciones existentes se llega a 181. Una fila puede contener varias aserciones: no se cuenta cada aserción como otro caso ni se suman repeticiones de ejecución.

Se inspeccionó cada JSON: `ok` verdadero o indicadores `reproduce/reproduced` falsos, según el formato original. Los runners nuevos también comprueban los resultados individuales y devuelven salida no cero si hay fallos. Se incluyen los registros de preparación y de reproducciones fallidas; no se sustituyen por una afirmación de éxito.

## 2. Controles adicionales

| Control | Resultado final | Evidencia |
|---|---|---|
| Actualización específica 33→34, usuarios/hash y sesiones | Aprobado; 33 antes, 34 después, usuario idéntico salvo `tokenVersion=0` | `migration34.json`, `m34-sessions.log` |
| Restauración después de fallo intencional | Aprobado; vuelve a 33, usuario/hash idénticos y columna incompatible retirada | `recovery-after-failure.json` |
| Arranque del backend compilado | Esquema 33: salida 1 sin escribir usuario. Esquema 34: salud/login/me 200 | `compiled-startup.json` |
| Reproductor de cifrado antes/después | Antes reproduce fallback público; código actual falla con `EncryptionKeyError` antes de cifrar | `crypto-comparison.json`, registros |
| Tipos API y web, repositorio real | Cero errores; `--incremental false` para conservar el tsbuildinfo ajeno | `types-api-final.log`, `types-web-final.log` |
| Compilación production | Salida cero, shared + Next web + API; 31 páginas exportadas | `build-final.log` |
| Navegador con frontend y backend compilados | Operador solo lectura; ingreso 12.345 guardado una vez; saldo 112.345; error 503 sin falso éxito | `ui-results.json`, estados y PNG |
| Integridad de fuentes y Git | Fuentes contrastadas entre copia y repo; 34 archivos propios comprobados por SHA-256; índice y cambios ajenos revisados | `source-integrity.json`, registro del commit |

Estos controles son tres guiones de migración y comprobaciones técnicas adicionales, no filas nuevas inventadas para aumentar los 181 casos. La compilación mantiene las advertencias de Next sobre rewrites con exportación estática y omite lint por su configuración existente. No se declara lint ejecutado.

## 3. Resultados de los defectos auditados anteriormente

| Defecto original | Verificación final |
|---|---|
| F01 conciliación | Signos/importes inválidos rechazados; grupos válidos completos sin falsos descuadres; rotos históricos visibles |
| F02 tarifas/deudas | Tarifas inválidas rechazadas; se conserva el control de cobro y se corrigen los dos defectos adicionales por hora |
| F03 saldos históricos | Capital anterior conservado en snapshots nuevos; cierre posterior no modifica el esperado diario cerrado |
| F04 concurrencia de cierres | Esperado y registro dentro del candado; cierre/escritura concurrentes comprobados |
| F05 fechas/períodos | Guardias ampliadas a rutas equivalentes; E01–E03 pasan; fecha operativa y de registro distinguidas |
| F06 Excel | Sin doble conteo de bases por medio; reporte y hoja concilian en casos nuevos |
| F07 medio | Split coherente; medios inválidos también rechazados en clientes y por hora |
| S01 sesiones | Cambio de seguridad revoca token anterior inmediatamente mediante versión persistida |
| S02 Shipday | Tarifas negativas y lotes inválidos no crean dinero/pedidos; integración externa simulada |
| S03 cifrado | Sin fallback público ante fallo; pruebas de clave y persistencia anteriores pasan |
| M01 solicitudes | Operación no soportada rechazada; revisión fallida no deja falsa aprobación |
| M02 frontend | Operador no guarda configuración; fallo administrativo muestra error sin éxito |

**I09 cambió legítimamente de contrato:** ya no se espera que una solicitud elimine un cierre mensual. Crear su eliminación se rechaza sin guardar solicitud; revisar una solicitud antigua también se rechaza, esta sigue pendiente y el cierre existe. Los otros trece casos conservan sus expectativas. Además de I09 solo se adaptaron conexión/salida de evidencia y se añadió propagación de fallos al proceso.

## 4. Nuevos casos y aceptación financiera

`codex-definitive.ts` contiene 16 DATE, cinco INPUT, ocho PAIR, veinte LOCK, dos HOUR, un TZ y un INTEGRATED: **53** casos. Se prueban fechas imposibles y bisiestos, futuro, medianoche Bogotá, rollback de edición, grupo mixto, grupo incompleto, signos iguales, importe distinto, concurrencia, reporte/Excel/proyector, entradas y reversiones cerradas, solicitudes, capital, arqueos, reset, cierres por sucursal, evento externo cerrado y persistencia tras reinicio.

El INTEGRATED calcula **61.000 efectivo / 139.000 banco** de forma independiente. Comprueba deuda normal **13.000**, deuda por hora **16.000**, domiciliario **0 deuda / 0 crédito**. El cierre registra diferencias cero. La solicitud histórica rechazada continúa pendiente; el día cerrado conserva su saldo tras el cierre mensual y reinicio. La fecha operativa siguiente acepta 2.000 y muestra **102.000 / 100.000** desde su nuevo capital.

LOCK20 usa otra conexión PostgreSQL que mantiene el mismo candado mientras se encola una base. El registro posterior tiene fecha posterior al corte y el esperado es **90.000 / 100.000**. Se trata de cobertura adicional de concurrencia; no se atribuye un defecto previo confirmado a un caso que también pasó antes del refuerzo.

El navegador reprodujo una regresión intermedia por el mediodía enviado desde el formulario bancario principal. Se conserva su captura y respuesta de error; el formulario se corrigió y recompiló. La repetición guardó exactamente una fila de 12.345, medio `bank`, día Bogotá correcto; el esperado independiente pasó a 112.345. No queda pendiente ese fallo.

## 5. Estado del backend y frontend

**Backend:** tipos, compilación, HTTP real de ensayo, transacciones, concurrencia, cierres, persistencia y migración aprobados en los fixtures. Los servicios externos fueron simulados. Ante falta de migración el arranque falla antes de crear datos.

**Frontend:** build de producción y tipos aprobados; pruebas de navegador con operador/administrador, banco y configuración. Se preserva el manejo de errores y se ajustan los dos formularios bancarios al contrato de fecha. La prueba de UI empleó la herramienta de computer-use contra `127.0.0.1`; las capturas contienen datos ficticios. No es una cobertura exhaustiva de todas las pantallas ni del instalador Electron/Windows.

## 6. Migración 34 y respaldo

`run-migration34-final.cjs` y sus helpers quedan en `apps/api/tests`. Requieren la conexión temporal local `cashbuddy_codex_definitive_20261014`. Antes de crear las bases auxiliares comprueban que no existen. Restauran únicamente el dump de usuarios ficticios generado por su propio ensayo y eliminan solo sus bases creadas.

Se confirmó:

1. Instalación vacía completa de las 34 migraciones.
2. Baseline exacto de 33 excluyendo únicamente `20261014090000_user_token_version`, seguido de deploy a 34.
3. Conservación del usuario y su hash completo.
4. Compatibilidad del token antiguo de versión cero; cambio de contraseña revoca ambos tokens previos con 401, sesión nueva 200.
5. Arranque source y compilado con esquema actualizado.
6. Bloqueo de arranque si faltan migraciones o quedó una fallida; sin escribir usuario.
7. Fallo inducido mediante columna incompatible en una copia, detección, restauración a 33 y comprobación de usuario/hash idénticos.

La migración no gira claves ni revoca masivamente tokens de versión cero. Se conserva la compatibilidad comprobada; una revocación global debe ser una acción autorizada separada.

El runner de migración anterior conserva sus dos casos, incluido el backfill de overrides; su subconjunto antiguo no se presenta como prueba exacta 33→34. La prueba específica nueva cubre esa actualización. También se corrigió su preflight para no borrar una base preexistente por compartir un nombre de ensayo.

## 7. Reproducción segura de los ensayos

Desde una copia del commit y con PostgreSQL local, crear bases **nuevas, vacías y desechables**, comprobando que sus nombres no existan. Las cuatro baterías previas requieren, respectivamente, `cashbuddy_codex_test_fixes`, `cashbuddy_codex_blockers`, `cashbuddy_claude_final` y `cashbuddy_claude_12`. La nueva requiere `cashbuddy_codex_definitive_20261014`. No reutilizar una base con información real ni el `.env` operativo como destino de una migración.

Configurar `DATABASE_URL` exclusivamente para el fixture seleccionado, `JWT_SECRET`/`ENCRYPTION_KEY` ficticios, `NODE_ENV=test` y `TZ=America/Bogota`. Verificar host local y nombre antes de cada comando. Aplicar las migraciones solo a ese fixture, generar el cliente y compilar el proyecto de ensayo antes de sus pruebas HTTP y de arranque compilado.

Desde `apps/api` de la copia:

```powershell
node tests/run-financial.cjs
node tests/run-post-claude.cjs
node tests/run-claude-final.cjs
node tests/run-codex-12-defectos.cjs
node tests/run-migration-upgrade.cjs
node tests/run-definitive.cjs
node tests/run-migration34-final.cjs
```

**Cambiar la conexión al fixture exigido por cada runner antes de ejecutarlo.** No ejecutar toda la lista con una sola conexión. Los cuatro primeros deben partir de su semilla limpia; crear nuevas bases propias o vaciar exclusivamente el fixture propio previamente identificado. No usar QUICK para la batería de 15. Revisar cada JSON al terminar. Los guiones nuevos guardan JSON/logs en tests; los respaldos ficticios de migración están en `tests/results-m34`, excluido de Git.

Los guiones de orquestación de esta ejecución, incluidos preparación, comprobación de resultados y limpieza de sus propios nombres, se conservan en el ZIP. Las credenciales reales no se escribieron en informes ni evidencias.

## 8. Incidencias de preparación y reparación

El primer build restringido recibió EPERM al crear un directorio de Next; se repitió con autorización del entorno y pasó. Hubo errores de rutas relativas en guiones auxiliares y una preparación que inicialmente reutilizó semillas anteriores, produciendo P2002 de `Settings`. Se identificó la causa, se vaciaron exclusivamente los fixtures propios y se repitieron las baterías hasta su resultado final aprobado. No fueron fallos de producto encubiertos.

El primer guion nuevo tuvo tres expectativas/preparaciones incorrectas: Date construido como número, pago HTTP cuyo contrato es 201 y sondeo cuyo rechazo se propaga como 409. Se corrigió el guion conforme al contrato observado. Un typecheck detectó una guardia insertada en un lector en vez del servicio de aplicación de pago; se movió al punto correcto antes de la aceptación final.

Durante la ampliación se reprodujeron HOUR01/HOUR02 y un rechazo inmediato alrededor del corte mensual. Se corrigieron y volvieron a pasar las pruebas afectadas. La regresión real de UI por mediodía se reprodujo y resolvió en navegador. Los archivos finales no contienen fallos de esas ejecuciones; los resultados intermedios relevantes permanecen como evidencia diferenciada.

## 9. Condiciones y verificaciones pendientes

| Pendiente | Clasificación |
|---|---|
| Saldos históricos reales y caso de agosto | NO VERIFICADOS: los originales están en otro computador |
| Shipday real, horarios y payloads reales | NO VERIFICADO: solo simulación local |
| Instalador completo Windows y ejecución en el otro equipo | NO VERIFICADOS |
| Configuración, secretos, red y base de producción | NO VERIFICADOS |
| F14 y D7 | Decisiones empresariales pendientes; no se inventó una regla ni una corrección histórica |
| Módulos con `Date` después del cierre del mismo día calendario | Rechazo conservador; extenderles fecha operativa exige definición del propietario |

No hay un fallo crítico reproducido pendiente en las baterías finales. La ausencia de datos/producto externos no se convierte en un defecto confirmado. Tampoco se promete reparar automáticamente inconsistencias históricas existentes o ofrecer exactamente una ejecución de entradas manuales sin identidad al reintentarlas tras una respuesta de red incierta.

## 10. Procedimiento futuro de actualización de producción — NO ejecutado

1. El propietario revisa los commits y autoriza la actualización. Identificar inequívocamente equipo, aplicación, conexión y base objetivo; no asumir que coinciden con este ensayo.
2. Detener escrituras y sincronizaciones. Registrar versión de código, migraciones aplicadas, usuarios y saldos de referencia que el propietario verificará. Conservar el código/binarios anteriores.
3. Crear un respaldo PostgreSQL completo y respaldar de forma segura configuración y clave de cifrado vigente. No publicar secretos ni cambiar `.encryption-key`/`ENCRYPTION_KEY`; una clave distinta impediría leer API keys existentes.
4. Restaurar el respaldo en **otra base aislada** y comprobar integridad, usuarios, contraseñas, permisos y datos relevantes. Ensayar allí primero la migración y el arranque del backend compilado. Detenerse si fallan o si la historia necesita decisiones F14/D7.
5. Preparar dependencias, cliente Prisma y build de la versión aprobada. Confirmar el plan de sesiones: versión cero conserva tokens previos hasta un cambio de seguridad; cualquier revocación global necesita autorización y ejecución explícitas.
6. Solo con respaldo restaurable y autorización, ejecutar `prisma migrate deploy` contra la conexión productiva previamente confirmada. **No usar `db push`, `migrate reset` ni los runners de prueba en producción.** Comprobar que la migración 34 quedó terminada y no hay pendientes/fallidas.
7. Arrancar la versión compilada. El propietario verifica login, permisos, lectura de saldos e historia, caso de agosto, reportes/Excel y operaciones reales pertinentes. Habilitar Shipday real únicamente con la autorización correspondiente y revisar su primer ciclo.
8. Si falla la actualización, detener inmediatamente las escrituras. Preservar diagnóstico y base fallida; restaurar el respaldo validado en una base nueva y devolver código/configuración compatibles. No restaurar encima de escrituras posteriores sin evaluar y autorizar su conservación/reconciliación. No reparar fallos mediante saldos arbitrarios ni eliminando cierres.

Estos pasos son una preparación para el propietario, no una autorización ni evidencia de despliegue. En esta ejecución no se hizo push, no se desplegó y no se modificó producción.
