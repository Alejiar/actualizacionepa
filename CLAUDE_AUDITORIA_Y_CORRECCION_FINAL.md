# Auditoría independiente del trabajo de Codex y corrección final — EPA Domicilios

Fecha: 14-oct-2026 (Bogotá). Repositorio `C:\cash-buddy-epa`, rama `claude/entrega-final`.
Auditado: `d801079` y `3d5be36` (Codex), sobre `e198b53`. Commit de esta corrección: **`db6f17d`**, más el commit documental. **Sin push ni despliegue.** Producción no se tocó. Siigo quedó fuera del alcance.

**No declaro el sistema listo para producción.** El PC de pruebas queda operativo con una base DEMO. La actualización de producción es una decisión posterior y separada.

## 1. Cambios de Codex revisados

| Commit | Contenido | Revisión |
|---|---|---|
| `d801079` | `period-guard.ts` (calendario estricto, `assertOpenInstant`, `financialNow`, `parseFinancialTimestamp`); guardia de período en banco, bases, pagos, crédito, conversiones, clientes, turnos por hora, pedidos manuales, webhook, sondeo y solicitudes; integridad global de pares (RG01/E04/E06); esperado de un día cerrado congelado a su corte; capital/reset/borrado de cierres bloqueados; HOUR01/HOUR02; 10 archivos de pruebas | Código leído completo en los servicios de dinero. Se encontró un defecto (D-A1) |
| `3d5be36` | `CODEX_CORRECCION_DEFINITIVA.md`, `CODEX_RESULTADOS_PRUEBAS_FINALES.md` | Afirmaciones contrastadas ejecutando las pruebas (§3) |

Las afirmaciones de Codex que se comprobaron por ejecución propia:
- 181 casos aprobados, revisados uno a uno en los JSON y no solo por el código de salida;
- migración 34: instalación vacía, 33→34, recuperación y arranque compilado;
- RG01, PF01 y PF02;
- el escenario integrado 61.000 / 139.000.

## 2. Defectos encontrados y corregidos

| ID | Defecto | Reproducción | Causa raíz | Corrección | Regresión |
|---|---|---|---|---|---|
| **D-A1** (introducido en `d801079`) | El sondeo de Shipday aborta el ciclo completo cuando un pedido cae en un período cerrado | Ayer con Cierre; el sondeo trae un rezagado de ayer y un pedido de hoy de $20.000. Resultado: 0 pedidos cargados y deuda 0 (esperado: el de hoy y deuda 6.000). Se repite en cada ciclo; con la reconciliación, durante 14 días | `persistDeliveredOrder` lanza 409 y `syncBranch`/`reconcileBranch` no lo capturan | `persistOrSkipClosed`: omite el pedido cerrado, lo identifica en el aviso de la sucursal (`syncStatus=error`) y continúa. **La política no cambia**: el pedido del período cerrado sigue sin cargarse (D7) | SYNC01, SYNC02, SYNC03 (fallaban 3/3 antes, pasan 3/3 después). LOCK17 de Codex ajustado: sigue exigiendo 0 pedidos importados, pero acepta el ciclo parcial con el pedido identificado en lugar del aborto |
| **D-A2** | Una API key de Shipday inválida devuelve **500 "Error interno"** en "Cargar pedidos desde hoy" | Reproducido en la DEMO con clave provisional: `start-orders` → 500 | `shipday.service` lanzaba `Error` genérico ante 401/403 | `HttpError(400, "API Key de Shipday inválida o sin permisos")` (no 401/403: el frontend cerraría la sesión) | SHIP01 |
| **D-A3** | La ventana de CashBuddy consultaba `/shifts/current-date` cada 8 s **sin sesión**: un 401 en el registro cada 8 s (45 líneas en 5 min; el registro ya superaba 30.000 líneas) | Observado en `cashbuddy-launcher.log` | `DayProvider` sondea también en la pantalla de login | No consulta si no hay token | Medido: 45 → 0 en el registro tras recompilar |
| **D-A4** | El login sugería `admin@cashbuddy.local` como texto de ejemplo: parecía ya escrito y revelaba el usuario por defecto | El propietario intentó entrar a la DEMO con ese usuario | Placeholder del campo de correo | Ejemplo neutro `tu-correo@empresa.com` | Verificado en la página servida |
| **D-A5** (documental) | `CLAUDE.md` decía que cerrar y abrir CashBuddy.exe relanza el backend. **Es falso**: el backend sobrevive al cierre de la ventana y el lanzador lo reutiliza con el código viejo | Probado: tras cerrar, `node` 29008 siguió activo | Diseño del lanzador (servidor para otros equipos) | `CLAUDE.md` corregido con el procedimiento real (terminar `node dist\index.js`) | — |

Hallazgos que **no son defectos** y quedan documentados:
- Dos pedidos reales en $0 / número "00" (`54814075`, `54808397`). Shipday los reporta así en sus propios datos crudos (`deliveryFee=0`, `orderTotal=0`) más de una hora después de entregados. La app guarda fielmente lo que reporta Shipday y la autosanación los corrige si Shipday fija la tarifa.
- La hoja "CIERRE MES" del Excel no incluye conversiones ni abonos de clientes por medio. Están en "Resumen"/"Conversiones" y en el Historial, así que la diferencia queda explicada (ver `CLAUDE_VERIFICACION_TOTAL_EPA.md` §4). Añadir una hoja de conciliación es la decisión P5.

## 3. Resultado de cada batería (código final `db6f17d`, bases temporales nuevas)

| Batería | Casos | Resultado |
|---|---:|---|
| `run-financial.cjs` (6 grupos) | 45 | 45/45, ningún defecto reproducido |
| `run-post-claude.cjs` | 18 | 18/18 |
| `run-claude-final.cjs` (completo, sin QUICK) | 15 | 15/15 |
| `run-codex-12-defectos.cjs` | 26 | 26/26 |
| `run-definitive.cjs` (independiente 14 + bordes 8 + definitiva 53) | 75 | 75/75 |
| `run-migration-upgrade.cjs` | 2 | 2/2 |
| **Subtotal Codex** | **181** | **181/181** |
| `run-claude-auditoria.cjs` (nueva) | 5 | 5/5 |
| **Total** | **186** | **186/186** |
| `run-migration34-final.cjs` (3 guiones) | — | 3/3 |
| `demo-escenario.ts --cerrar` (escenario completo, libro independiente, Cierre y rechazos posteriores) | — | Aprobado: 106.600 / 122.400, diferencia 0 |
| Tipos API y web | — | 0 errores |
| `NODE_ENV=production npm run build` | — | Correcto |

## 4. Archivos modificados

- `apps/api/src/services/branch.service.ts`: D-A1.
- `apps/api/src/services/shipday.service.ts`: D-A2.
- `apps/web/lib/day-context.tsx`: D-A3.
- `apps/web/app/login/page.tsx`: D-A4.
- `apps/api/tests/codex-definitive.ts`: la aserción de LOCK17 (ver D-A1).
- Nuevos:
  - `apps/api/tests/claude-auditoria-final.ts` y `run-claude-auditoria.cjs`;
  - `apps/api/tests/demo-escenario.ts`;
  - `apps/api/tests/demo-pedido-real.ts`.
- `.gitignore` (Excel generado, `DEMO_CREDENCIALES.local`) y `CLAUDE.md` (D-A5 y reglas).
- Documentos: este, `CLAUDE_PC_PRUEBAS_OPERATIVO.md`, `GUIA_MANUAL_PRUEBAS_EPA.md` y `CLAUDE_VERIFICACION_TOTAL_EPA.md`.

## 5. Incidencias durante la ejecución (transparencia)

- **Mi herramienta auxiliar de bases temporales** derivaba la URL del `.env`. Después de apuntar el `.env` a la DEMO, el archivo de URL de la base temporal quedó apuntando a `cashbuddy_demo`, y un servidor de prueba arrancó contra la DEMO. El escenario falló en el login **antes de escribir**. Lo detecté, detuve ese servidor y verifiqué que la DEMO no cambió (1 usuario, 0 sucursales, 0 movimientos, 0 dispositivos). Desde entonces la URL se construye con un analizador real y se excluyen explícitamente `cashbuddy` y `cashbuddy_demo`.
- La clave DEMO generada tenía caracteres ambiguos (0/O, l/1) y el propietario no pudo entrar. Se cambió por una sin ambigüedad. Al cambiar el admin su propia clave se invalidó su sesión (protección S01, comportamiento correcto) y se repitió el cambio del operador.
- Pausé la sucursal real mientras el propietario la editaba: su "Cargar pedidos desde hoy" recibió 409. Se coordinó de nuevo y la importación funcionó.
- El control de pantalla de CashBuddy.exe fue **denegado** por el propietario. La ventana WebView2 no se inspeccionó visualmente. Se verificó por procesos, registro, salud y la misma interfaz (`http://localhost:4000`) en el navegador integrado.

## 6. Decisiones del propietario pendientes (no se inventaron reglas)

| # | Problema | Opciones | Consecuencias | Recomendación técnica |
|---|---|---|---|---|
| P1 (D7) | Corregir dinero de un día o mes ya cerrado | a) **Ajuste compensatorio autorizado en el período abierto**, con referencia al original; b) reabrir el período con aprobación de admin; c) prohibir siempre | a) conserva los cierres y su trazabilidad; b) altera cifras ya cuadradas; c) hoy no hay forma de corregir | **a)**, con `EditRequest` |
| P2 | Pedido de Shipday entregado **después del Cierre del mismo día** (hoy queda sin cargar y se avisa) | a) contarlo en el día cerrado (no mueve caja: solo deuda y comisión); b) atribuirlo al siguiente día operativo; c) dejarlo pendiente de revisión manual | a) la comisión del Historial de ese día cambia, pero la caja no; b) coherente con la "fecha operativa" de la Caja; c) requiere una pantalla nueva | **b)**. Mientras tanto, **no registrar el Cierre mientras haya domicilios en curso** |
| P3 (F14) | Fórmula de "Diferencia bases" del mes | Base pendiente conciliada con la deuda (actual) / entregadas − devueltas del mes / acumulado histórico | Cambia el indicador del reporte y del Excel, no los saldos | Mantener la actual hasta definirla con ejemplos reales |
| P4 | ¿La utilidad de clientes por hora entra en "Utilidad neta"? | Sí / No (actual) | Ejemplo DEMO: utilidad −1.000 sin incluir 10.000 de margen por hora | Incluirla si el negocio la considera venta |
| P5 | Hoja de conciliación en el Excel (saldo inicial + cada fuente = saldo final) | Añadir / no | Hace el Excel autoverificable | Añadir, tras definir P1 (los cierres de mes cambian el capital) |
| P6 | Cerrar CashBuddy.exe ¿debe detener el servidor? | Mantener (otros equipos siguen) / detener | Hoy, actualizar exige terminar `node` a mano | Mantener, y documentar el reinicio |

## 7. Estado final de Git

- Rama `claude/entrega-final`: `db6f17d` (código y pruebas) más el commit documental. Sin push.
- Fuera de los commits, como se pidió: `apps/api/package.json` (línea `simulate-3months`), `apps/web/tsconfig.tsbuildinfo`, `AUDITORIA_CLAUDE_POST_CODEX.md`, `AUDITORIA_CLAUDE_SEGUNDA_REVISION.md`, `CONTEXTO_AUDITORIA.md` y `apps/api/scripts/simulate-3months.ts`.
- Configuración local no versionada:
  - `.env` apunta a la DEMO; el original está en `backups/env_antes_demo_20261014.bak`;
  - `DEMO_CREDENCIALES.local`;
  - `backups/cashbuddy_pre_demo_20261014_114158.dump`.

## 8. Segunda ronda: decisiones del propietario implementadas (14-oct-2026)

El propietario decidió:
1. El operador divide cada pago entre comisión y base.
2. Crédito y base **no** se compensan.
3. D7: un día cerrado se corrige por solicitud aprobada (editar, eliminar o **agregar**) mientras el mes esté abierto.
4. Un pedido de Shipday posterior al Cierre se carga en su día.

| Decisión | Implementación | Verificación |
|---|---|---|
| F14 (1 y 2) | `lib/base-balance.ts` (base pura); `pendingDebt`/`creditAmount` solo comisiones; `registerPayment` y `applyBankToDriver` con `baseAmount`; reversión por `debtApplied − bases enlazadas`; reportes, Excel, Deudas, Domiciliarios, Dashboard y estado de cuenta separados; migración 35 con auditoría | `claude-f14-d7.ts` (casos A–D y más), `claude-migration-f14.cjs` (datos heredados: sin créditos fantasma, total conservado, caja sin cambios), migración real de la DEMO, clic real en el pago dividido |
| D7 (3) | `runAsApprovedCorrection`; `ShiftClose.corrections` (migración 36); `requestType: "create"`; esperado del día = registrado + correcciones posteriores; formulario en Historial, tarjeta en Solicitudes | D7-EDIT/REJ/DEL/ADD/ADDMOV/CHAIN/MES/VAL/DUP + flujo completo con clic real |
| Pedidos post-cierre (4) | `assertOrderPeriodOpen` (bloquea solo el **mes** del pedido) | ORD-POST, ORD-SYNC1/2, LOCK12/17/19 |

Defectos nuevos encontrados y corregidos en esta ronda:
- **D-A6:** la guardia por instante del cierre de mes perdía pedidos del mes abierto.
- **D-A7:** fechas calculadas en UTC o con la zona horaria del PC (Historial, cierre mensual, Caja).
- **D-A8:** Equipos y Solicitudes consultaban rutas de admin con sesión de operador.
- **D-A9:** el guion de la migración 34 de Codex usaba una base vieja sucia y un conteo fijo.

Cobertura: **124/124 rutas de la API** verificadas con su efecto, y barrido de permisos sobre 153 combinaciones (ver `CLAUDE_MATRIZ_COBERTURA_TOTAL_EPA.md`). Conciliación peso a peso en `CLAUDE_CONCILIACION_FINAL_COMPLETA.md`.

Decisiones que siguen abiertas:
- P3/F14: la fórmula de bases ya está **definida** por el propietario.
- P4: utilidad por hora.
- P5: hoja de conciliación en el Excel.
- P6: comportamiento del servidor al cerrar la app.
- Pedidos manuales después del Cierre: hoy se rechazan, como el resto del dinero.

Commits: `bea002a` (código y pruebas) y el documental. Sin push.
