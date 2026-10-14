# Guía de pruebas manuales — EPA Domicilios (base DEMO de este PC)

Todo lo que hagas aquí ocurre en la **base DEMO** de este PC, con datos ficticios. No afecta producción.

## Antes de empezar

1. Abre **CashBuddy** con el acceso directo o con `C:\cash-buddy-epa\CashBuddy.exe`. Espera la ventana.
2. Inicia sesión **escribiendo** el correo. El texto gris "tu-correo@empresa.com" es solo un ejemplo.
   - Usuarios: `admin@epa.demo` (administrador) y `operador@epa.demo` (operador).
   - La clave está en `C:\cash-buddy-epa\DEMO_CREDENCIALES.local`.
3. **Haz los escenarios en orden.** Cada uno parte del saldo que dejó el anterior.

**Saldos de partida (14-oct-2026): Efectivo $118.600 · Banco $122.400.**

**Cómo reconocer un fallo:** cualquier saldo distinto del indicado, un mensaje de éxito sin que el dato aparezca después, un "Error interno", o que la app cierre tu sesión sin motivo. Anota la pantalla, la hora y lo que escribiste.

---

### E1. Permisos del operador
- **Pantalla:** Configuración, con la sesión de `operador@epa.demo`.
- **Operación:** intenta cambiar el capital o el porcentaje.
- **Resultado esperado:** aviso "🔒 Solo lectura" y botones Guardar deshabilitados. La sesión no se cierra.
- **Fallo si:** puedes guardar, o aparece "Configuración guardada".

### E2. Saldos iniciales
- **Pantalla:** Dashboard.
- **Observa:** "Saldos esperados hoy": efectivo **$118.600**, banco **$122.400**. "Pedidos de hoy": **28**, valor **$312.000** (25 reales + 3 ficticios), % empresa **$93.600**.
- **Verifica:** Historial → día 14 muestra **$241.000** (118.600 + 122.400).

### E3. Ingreso bancario
- **Pantalla:** Banco → nuevo ingreso.
- **Valores:** $30.000, medio **transferencia**, descripción "Prueba E3", sin contraparte.
- **Esperado:** Efectivo **$118.600** · Banco **$152.400**.
- **Verifica que se guardó:** aparece en Banco y en Movimientos del día, y el Dashboard refleja el nuevo saldo.

### E4. Gasto en efectivo con aprobación
- **Pantalla:** Gastos, con la sesión del **operador**.
- **Valores:** $10.000 en efectivo, categoría gasto.
- **Esperado 1:** queda **pendiente** y la caja **no cambia** (118.600).
- **Luego**, con el **admin**, apruébalo (Gastos o Movimientos → pendientes → aprobar).
- **Esperado 2:** Efectivo **$108.600** · Banco **$152.400**.
- **Fallo si:** la caja baja antes de aprobarse, o baja dos veces.

### E5. Transferencia con contraparte (no crea ni destruye dinero)
- **Pantalla:** Banco.
- **Paso 1:** una **salida** por transferencia de $20.000, descripción "Retiro a caja".
- **Paso 2:** en esa salida, registra su **contraparte**: un ingreso en **efectivo** de $20.000.
- **Esperado:** Efectivo **$128.600** · Banco **$132.400**. Total sin cambio: 261.000.
- **Verifica:** Reportes → "Movimientos sin cuadrar (contraparte)" = **$0**.
- **Prueba negativa:** intenta una contraparte de $19.000. Debe rechazarse, y los saldos no cambian.

### E6. Cliente con deuda y abono
- **Pantalla:** Clientes.
- **Pasos:** crea "Cliente prueba". Añade una deuda de $20.000, descripción "Fiado", **sin** medio de desembolso. Luego registra un abono de $5.000 en **efectivo**.
- **Esperado:** la deuda deja la caja igual (128.600). Tras el abono: Efectivo **$133.600** y deuda del cliente **$15.000**.
- **Prueba negativa:** un abono de $20.000 (mayor que la deuda) debe rechazarse.

### E7. Pedido manual y comisión del 30 %
- **Pantalla:** Sucursales, con el **admin**. Edita "Sucursal DEMO (ficticia)" y marca **Activa**.
- **Pantalla:** Pedidos → pedido manual. Sucursal DEMO, domiciliario **Demo B**, valor $10.000.
- **Esperado:** comisión **$3.000**; Deudas → Demo B debe **$3.000**; la caja **no cambia** (133.600).
- **Al terminar:** vuelve a **desactivar** la sucursal DEMO. Mientras está activa intenta sincronizar con Shipday sin una key válida y muestra un error de sincronización: es esperado.

### E8. Pago del domiciliario
- **Pantalla:** Domiciliarios (o Deudas) → Demo B → registrar pago.
- **Valores:** $3.000 en efectivo.
- **Esperado:** deuda de Demo B **$0**. Efectivo **$136.600** · Banco **$132.400**.

### E9. Base entregada y devuelta
- **Pantalla:** Bases → Demo B.
- **Paso 1:** entregar $10.000 en efectivo. Esperado: efectivo **$126.600** y deuda de Demo B **$10.000**.
- **Paso 2:** registrar la devolución de $10.000 en efectivo. Esperado: efectivo **$136.600** y deuda **$0**.
- **Prueba negativa:** devolver más de lo pendiente debe rechazarse.

### E10. Cliente por hora
- **Pantalla:** Clientes por hora → "Cliente por hora DEMO" (tarifa: $10.000 domiciliario + $5.000 empresa por hora).
- **Paso 1:** registrar un turno de 08:00 a 09:00 con Demo B, pago en **efectivo**. Esperado: total $15.000, se paga $10.000 al domiciliario y el **efectivo queda en $126.600**. El cliente debe **$15.000**.
- **Paso 2:** cobrar $15.000 al cliente por **transferencia**. Esperado: Banco **$147.400** y deuda del cliente **$0**.

### E11. Reportes, Historial y Excel
- **Historial, día 14:** apertura $200.000 y cierre $274.000 (126.600 + 147.400). Debe cumplirse: apertura + ingresos − egresos = cierre.
- **Reportes:**
  - Total ventas: **$96.600** (93.600 + 3.000).
  - Gastos: **$20.000** (10.000 del escenario DEMO + 10.000 de E4).
  - Movimientos sin cuadrar: **$0**.
  - Deuda de clientes: **$30.000** (15.000 Cliente DEMO + 15.000 Cliente prueba).
- **Excel del mes** (Reportes → Excel): "1-Domicilios (comisión)" = 96.600. Una base devuelta dentro de un pago de domiciliario no aparece duplicada.

### E12. Cierre del día (hazlo al final: bloquea el día)
- **Pantalla:** Caja → Cierre.
- **Valores:** cuenta **$126.600** en efectivo y **$147.400** en banco.
- **Esperado:** diferencia **0** en efectivo y banco. En Historial el día 14 queda **verde**.
- **Luego:** cualquier dinero nuevo con fecha de hoy debe **rechazarse** (día cerrado). Mañana se puede registrar de nuevo.
- **Fallo si:** el esperado del cierre no es 126.600 / 147.400, o se acepta dinero en el día cerrado.

### E13. Persistencia
- Cierra CashBuddy y vuelve a abrirlo, o reinicia el PC. Inicia sesión: los saldos y registros deben ser los mismos.

---

## Pedido real de Shipday (ya verificado; solo consulta)
- **Pedido #22** (Shipday 54814555): tarifa $40.000, comisión **$12.000**, el domiciliario quedó en **$0** tras una base y un pago **ficticios** de $22.000 en efectivo. Está en Pedidos y Deudas.
- Los pedidos **54814075** y **54808397** aparecen en **$0 / #00** porque Shipday los reporta sin tarifa. Revísalos en Shipday: si les pones tarifa allá, la app los corrige sola en el siguiente sondeo, con la sucursal real activa.
- La "Sucursal real (lectura)" está **pausada**. Si la activas, la DEMO consulta Shipday con tu key y comparte el cupo de peticiones con producción. Actívala solo un rato.
