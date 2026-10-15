# PC de pruebas — EPA Domicilios operativo con base DEMO

Fecha: 14-oct-2026. Equipo de pruebas del propietario (no es producción).

## 1. Componentes verificados

| Componente | Estado verificado |
|---|---|
| Ejecutable | `C:\cash-buddy-epa\CashBuddy.exe` (781.824 bytes, compilado el 22-jun-2026). Lanzador **WinForms + WebView2, no Electron**. Ejecuta `node dist\index.js` desde `apps\api` y abre `http://localhost:4000` |
| Versión del código | Commit `bea002a` (F14, D7, pedidos post-cierre). `apps/api/dist/index.js` y `apps/web/out` recompilados el 14-oct-2026 a las 12:25 con `NODE_ENV=production` |
| Node.js | v24.16.0 |
| PostgreSQL | 17, servicio `postgresql-x64-17` automático, puerto 5432 |
| Base que usa la app | **`cashbuddy_demo`** (DEMO aislada), con las **36 migraciones**: la 34 (`user_token_version`), la 35 (F14, conversión de saldos auditada en `F14DriverMigration`) y la 36 (D7, correcciones en el Cierre). Respaldo previo a F14: `backups/cashbuddy_demo_pre_f14_20261014_135448.dump` |
| Base original `cashbuddy` | **Sin tocar**: 33 migraciones, 1 usuario, sin datos operativos. Respaldo: `backups/cashbuddy_pre_demo_20261014_114158.dump`, restaurado en una base temporal y comparado (migraciones, usuario, hash y capital idénticos) |
| Configuración | `.env` → `cashbuddy_demo`, con `JWT_SECRET`, `ENCRYPTION_KEY` y admin **propios de la DEMO** (no se copiaron secretos productivos). Original: `backups/env_antes_demo_20261014.bak` |
| Webhook | `WEBHOOK_TOKEN` no está definido en la DEMO: responde 401. La DEMO no recibe webhooks, y el de Cloudflare apunta a producción y no se tocó |
| Inicio automático | El lanzador se registra en el inicio de Windows y arranca contra la DEMO |

## 2. Arranque, cierre, reinicio y watchdog (comprobado)

| Prueba | Resultado |
|---|---|
| Abrir CashBuddy.exe | PostgreSQL OK, backend iniciado, puerto 4000, `/api/health` → `{"ok":true}`, ventana abierta. Registro: `cashbuddy-launcher.log` |
| Cerrar la ventana | La ventana se cierra; **el backend sigue activo por diseño** (atiende a otros equipos) |
| Reabrir | Reutiliza el backend ya activo. Para cargar una compilación nueva hay que terminar `node dist\index.js` antes de abrir |
| Watchdog | Se terminó el backend a la fuerza: "Reinicio automático #1 en 3 s" y un nuevo backend sano en unos 5 s. Siempre un solo proceso `node dist\index.js`. Límite de diseño: 5 reinicios por sesión del lanzador |
| Persistencia | Tras reiniciar el backend, los saldos DEMO siguieron en 118.600 / 122.400 |
| Errores | API key inválida → 400 con mensaje claro; acciones sobre una sucursal pausada → 409; sin sesión → 401 sin cerrar la app |
| Inspección visual de la ventana | **No realizada**: el propietario denegó el control de pantalla. La interfaz se verificó en `http://localhost:4000`, la misma página que carga la ventana |

## 3. Usuarios DEMO

Están en `C:\cash-buddy-epa\DEMO_CREDENCIALES.local`, fuera de Git. Son ficticios y **solo existen en la DEMO de este PC**:

- **Admin:** `admin@epa.demo`.
- **Operador:** `operador@epa.demo`.
- **Clave:** la misma para los dos, y está en ese archivo.

El usuario `admin@cashbuddy.local` es de la base original y no existe en la DEMO.

## 4. Datos cargados en la DEMO (todos por endpoints reales)

Detalle de cada movimiento en `CLAUDE_VERIFICACION_TOTAL_EPA.md`.

| Bloque | Contenido |
|---|---|
| Capital | Efectivo 100.000 / banco 100.000 |
| Sucursal DEMO (ficticia, pausada) | Domiciliarios Demo A y Demo B. Pedidos manuales D1 $10.000, D2 $8.000, D3 $12.000. Base, devolución, pagos, ingreso bancario, gasto aprobado, conversión, transferencia con contraparte, cliente con deuda y abono, cliente por hora con turno y cobro |
| Sucursal real (lectura, pausada) | 25 pedidos reales de hoy importados de Shipday por **solo lectura** (con la API key que pegó el propietario) y 57 domiciliarios reales. Pedido real #22 (Shipday 54814555) con base y pago **ficticios** |
| Saldos al cierre de esta sesión | **Efectivo 118.600 · Banco 122.400** (sin Cierre registrado: el día queda abierto para tus ensayos) |

## 5. Volver a la base original

1. Terminar `node dist\index.js` (Administrador de tareas) y cerrar CashBuddy.
2. Copiar `backups/env_antes_demo_20261014.bak` sobre `.env`.
3. **Antes de abrirla**, aplicar las migraciones 34–36 a `cashbuddy`: `npm run db:deploy -w @cash-buddy/api`, con respaldo previo. Sin ella el arranque se detiene a propósito porque faltan migraciones.

La DEMO se puede conservar o eliminar (`DROP DATABASE cashbuddy_demo`) cuando ya no se necesite.

## 6. Limitaciones

- No se compiló un instalador nuevo de Windows: el ejecutable del lanzador no cambió y usa la compilación del repositorio.
- Shipday real se usó solo para **leer** y solo durante la importación. Las dos sucursales de la DEMO quedaron **pausadas** para no consumir el cupo de peticiones (~5/min por cuenta) que comparte con producción.

## 7. Actualización (segunda ronda, 14-oct-2026)

- La DEMO se migró a 36 migraciones con respaldo previo. Resultado exacto:
  - Demo A pasó de un saldo de 15.000 a **comisión 5.400 + base 9.600**.
  - Total de domiciliarios: 87.600, conservado.
  - Caja y banco sin cambios: 118.600 / 122.400.
- Las claves DEMO están en `DEMO_CREDENCIALES.local`. Se cambiaron por una sin caracteres ambiguos.
- Interfaz: 23 pantallas × 2 roles visitadas sin errores. Corregidos dos casos de 403 con el operador (Equipos y Solicitudes).
- Los escenarios de `GUIA_MANUAL_PRUEBAS_EPA.md` se ejecutaron sobre una **copia** de la DEMO: los 19 saldos de la guía coinciden con la app.

## 8. Tercera ronda (14-oct-2026): formularios con clic real

- Los 27 formularios y un recorrido financiero completo se ejecutaron con clics en una **copia** de la DEMO, con la red externa bloqueada. El detalle está en `CLAUDE_MATRIZ_COBERTURA_TOTAL_EPA.md` (§3–§6).
- Se corrigieron 8 defectos (D-B1 a D-B8). Se recompilaron `apps/api/dist` y `apps/web/out`.
- A las 17:44 se terminó el backend de la DEMO y el watchdog lo relanzó con la compilación nueva. Quedó sano y los saldos DEMO siguen en 118.600 / 122.400.
- La ventana de CashBuddy.exe sigue **sin verificación visual** (control de pantalla denegado).
