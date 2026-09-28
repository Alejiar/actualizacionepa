# Correcciones de la auditoría — 28 de septiembre de 2026

Se corrigieron los casos reproducidos de la auditoría F01–F14:

- Pagos simultáneos, doble aplicación y aprobaciones concurrentes: saldo y movimientos se guardan juntos o se revierten juntos.
- Edición y reversión bancaria: actualizan deuda, crédito y desglose de bases/comisiones. Los registros derivados se corrigen desde su movimiento original.
- Cambios de pedidos, bases y pagos: mantienen la representación de deuda y crédito.
- Reportes y Deudas: incluyen todos los domiciliarios; el reporte y Excel distinguen bases del mes, bases anteriores y comisiones pendientes.
- Se conserva permanentemente el historial contable. Cambiar la fecha inicial de importación ya no borra pedidos ni reconstruye saldos.
- Sincronización: los pedidos sin domiciliario local pueden vincularse después; una descarga parcial ya no figura como exitosa.
- Abonos de clientes: cada pago conserva su fecha y medio; los pagos parciales aparecen en caja y resumen diario, y pueden revertirse individualmente.
- Pedidos manuales: su deuda de cliente queda vinculada; edición y eliminación conservan la coherencia y protegen cobros ya realizados.
- Estadísticas de pedidos: usan el día de Bogotá y excluyen los pedidos provisionales sin comisión.
- Configuración contable: requiere administrador. Ediciones: campos permitidos y montos válidos.

## Validación

45 comprobaciones automatizadas aprobadas en una base local desechable: concurrencia, reversiones, preservación histórica, sincronización simulada, reportes, API y Excel. Compilación completa y verificación de tipos aprobadas. Inicio de sesión y reporte revisados en navegador con datos ficticios.

La migración se ensayó con pagos históricos: mantiene importe, fecha conocida, medios y saldos originales. Los abonos antiguos se identifican como agregados históricos; el sistema anterior no guardaba todas sus fechas individuales y no se inventan.

## Alcance y continuidad

Estas correcciones resuelven los fallos reproducidos; no certifican que toda combinación futura esté libre de errores. Los saldos operativos previos se preservan. Diferencias históricas causadas antes de esta actualización necesitan conciliación con comprobantes; no se compensan automáticamente. La sincronización remota se probó mediante casos simulados, no mediante cambios en Shipday real.

Los pedidos antiguos sin enlace inequívoco a una deuda de cliente requieren conciliación antes de editar esa deuda. Esto evita asignarla por coincidencias de texto.

Para futuros cambios financieros, usar moneyTransaction antes de leer saldos; no incluir peticiones externas dentro de la transacción. Mantener applyDebtDelta, el diario ClientDebtPayment, vínculos bancarios y tombstones. No reactivar limpieza destructiva ni reconstruir saldos desde historial incompleto.

Las pruebas están en apps/api/tests; test:financial solo acepta una base local llamada cashbuddy_codex_test_fixes, recién creada y migrada. Nunca ejecutar pruebas contra la base operativa.
