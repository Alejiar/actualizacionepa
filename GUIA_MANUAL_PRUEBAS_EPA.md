# Guía de pruebas manuales — EPA Domicilios (base DEMO de este PC)

Todo ocurre en la **base DEMO** de este PC, con datos ficticios. No afecta producción.
Versión: rama `claude/entrega-final` (15-oct-2026), con:
- F14 (base y comisiones separadas);
- D7 (corrección de días cerrados);
- las 3 decisiones finales: pedido manual tras el Cierre, turnos que cruzan medianoche y tarifas/trabajadores editables.

## Antes de empezar

1. Abre **CashBuddy**.
2. **Escribe** el correo (el texto gris "tu-correo@empresa.com" es solo un ejemplo).
   - Usuarios: `admin@epa.demo` (administrador) y `operador@epa.demo` (operador).
   - La clave de ambos está en `C:\cash-buddy-epa\DEMO_CREDENCIALES.local`.
3. Haz los escenarios **en orden**: cada uno parte del saldo que dejó el anterior.

**Saldos de partida:** Efectivo **$118.600** · Banco **$122.400**. Haz toda la guía el **mismo día** (lo llamamos "hoy").

**Cómo están los domiciliarios DEMO:**
- **Demo A:** comisión **$5.400** y base sin devolver **$9.600** (total informativo $15.000).
- **Demo B:** al día.
- **Domiciliarios reales (25 pedidos importados):** comisiones $72.600 en total.

**Cómo reconocer un fallo:** un saldo distinto del indicado, un "guardado" sin que el dato aparezca, un "Error interno", o que la app cierre tu sesión sin motivo. Anota la pantalla, la hora y lo que escribiste.

---

### E1. Permisos del operador
- **Pantalla:** Configuración, Equipos y Solicitudes, con la sesión del **operador**.
- **Esperado:**
  - Configuración: aviso "🔒 Solo lectura" y botones deshabilitados.
  - Equipos: "Solo el administrador puede ver los equipos", **sin** aviso rojo de error.
  - Solicitudes: te lleva al Dashboard sin avisos de error.

### E2. Saldos y cuentas separadas
- **Pantalla:** Dashboard. Esperado: efectivo **$118.600**, banco **$122.400**.
- **Pantalla:** Deudas. Esperado: columnas **Comisiones**, **Base** y **Total inf.**; Demo A = $5.400 / $9.600 / $15.000.
- **Pantalla:** Historial, día de hoy. Esperado: **$241.000**.

### E3. Ingreso bancario
- **Pantalla:** Banco → nuevo ingreso: $30.000 por transferencia, sin contraparte.
- **Esperado:** Efectivo **$118.600** · Banco **$152.400**.

### E4. Gasto con aprobación
- **Operador:** Gastos → $10.000 en efectivo. Queda **pendiente** y la caja no cambia.
- **Admin:** lo aprueba.
- **Esperado:** Efectivo **$108.600** · Banco **$152.400**.

### E5. Transferencia con contraparte
- **Pantalla:** Banco.
- **Paso 1:** salida por transferencia de $20.000.
- **Paso 2:** su **contraparte**: un ingreso en **efectivo** de $20.000.
- **Esperado:** Efectivo **$128.600** · Banco **$132.400**. Reportes → "Movimientos sin cuadrar" = **$0**.
- **Prueba negativa:** una contraparte de $19.000 se rechaza.

### E6. Cliente con deuda y abono
- **Pantalla:** Clientes.
- **Pasos:** crea "Cliente prueba", con una deuda de $20.000. En "¿Sale dinero de la caja?" elige **📝 No sale dinero (fiado)**. Luego registra un abono de $5.000 en efectivo.
- **Esperado:** Efectivo **$133.600** y deuda del cliente $15.000.
- **Pruebas negativas:**
  - Sin elegir una de las tres opciones de medio, el botón Siguiente no avanza.
  - Un abono mayor que la deuda se limita al saldo pendiente.

### E7. Pedido manual y comisión del 30 %
- **Admin, Sucursales:** edita "Sucursal DEMO (ficticia)" y marca **Activa**. Mientras esté activa mostrará un error de sincronización con Shipday: es esperado, porque es ficticia.
- **Pantalla:** Pedidos → pedido manual de $10.000 para **Demo B**.
- **Esperado:** comisión $3.000; Deudas → Demo B, comisión **$3.000**; la caja no cambia.
- Después, **desactiva** de nuevo la sucursal ficticia.

### E8. Pago solo de comisión
- **Pantalla:** Deudas → Demo B → **Registrar pago**.
- **Valores:** **A comisión** $3.000; **A base** vacío; efectivo.
- **Esperado:** comisión de B **$0**. Efectivo **$136.600**.

### E9. Pago dividido entre comisión y base (F14)
- **Pantalla:** Deudas → Demo A → **Registrar pago**.
- **Valores:** **A comisión** $5.400 y **A base** $4.600, en efectivo (total $10.000).
- **Esperado:** Demo A queda con comisión **$0** y base **$5.000**. Efectivo **$146.600**. Un solo movimiento de $10.000 en Movimientos.
- **Pruebas negativas:**
  - En "A base", un valor mayor que la base pendiente se rechaza.
  - Pagar solo comisión **no** reduce la base, y devolver base **no** reduce la comisión.

### E10. Base entregada y devuelta
- **Pantalla:** Bases → Demo B.
- **Paso 1:** entregar $10.000 en efectivo → efectivo **$136.600**; base de B **$10.000**; la comisión de B sigue en $0.
- **Paso 2:** devolución de $10.000 → efectivo **$146.600**; base de B **$0**.

### E11. Cliente por hora
- **Pantalla:** Clientes por hora → "Cliente por hora DEMO".
- **Paso 1:** turno de 08:00 a 09:00 con Demo B, pago en efectivo → efectivo **$136.600**; el cliente debe $15.000.
- **Paso 2:** cobro de $15.000 por transferencia → banco **$147.400**.

### E12. Reportes, Historial y Excel
- **Reportes:**
  - Total ventas **$96.600**.
  - Gastos **$20.000**.
  - Bases: saldo anterior $0 + entregadas $40.000 − devueltas $35.000 = **$5.000** (la de Demo A).
  - Comisiones pendientes **$72.600** (las de los domiciliarios reales).
  - Contrapartes **$0**.
  - Clientes **$30.000**.
- **Historial, hoy:** apertura + ingresos − egresos = cierre = **$284.000** (136.600 + 147.400).
- **Excel:** hoja "Domiciliarios" con columnas de comisión, crédito, base y total informativo.

### E13. Editar tarifas de un cliente por hora
- **Pantalla:** Clientes → Clientes por hora → "Cliente por hora DEMO" → **Editar tarifas**.
- **Valores:** domiciliario $12.000 y empresa $6.000 (antes $10.000 + $5.000).
- **Esperado:**
  - El total por hora pasa de $15.000 a **$18.000**.
  - La confirmación avisa que los turnos ya registrados no cambian.
  - El turno de E11 sigue en **$15.000**.
  - La caja no cambia.
- **Prueba negativa:** dejar las dos tarifas en 0 se rechaza.

### E14. Turno que cruza medianoche
- **Pantalla:** "Cliente por hora DEMO" → **Registrar turno**, con Demo B.
- **Paso 1 (aviso):** entrada **10:00**, salida **09:00** → Registrar turno. Debe aparecer:
  - "Este turno termina mañana y tiene una duración de 23 horas. ¿Deseas registrarlo?";
  - el inicio y el fin con sus fechas;
  - domiciliario $276.000, empresa $138.000 y total $414.000.
  - Pulsa **Cancelar**: no se guarda nada y el efectivo sigue en **$136.600**.
- **Paso 2 (confirmar):** entrada **22:00**, salida **00:00**, efectivo.
  - Aviso de 2 horas: domiciliario $24.000, empresa $12.000, total $36.000.
  - Pulsa **Sí, registrar turno**.
  - **Esperado:** efectivo **$112.600**; deuda del cliente **$36.000**.
- **Pruebas negativas:**
  - Entrada igual a salida se rechaza.
  - Registrar dos veces el mismo turno (mismo domiciliario, día y horas) se rechaza.

### E15. Trabajadores: renombrar y desactivar
- **Pantalla:** Trabajadores → **Agregar trabajador** "Auxiliar prueba" (Administrativo).
- **Paso 1:** ábrelo → **Registrar pago** de $5.000 en efectivo → efectivo **$107.600**.
- **Paso 2:** lápiz ✏️ → renómbralo "Auxiliar renombrado".
  - Es el mismo trabajador: "Nómina pagada" sigue en **$5.000**.
  - Un nombre vacío o el de otro trabajador se rechaza.
- **Paso 3:** pulsa **Activo** y confirma para desactivarlo.
  - Queda "Inactivo"; "Registrar pago" desaparece y su historial se conserva.
- **Paso 4 (admin):** **Eliminar trabajador** → se rechaza porque tiene historial. Reactívalo.
- **Operador:** puede renombrar y activar/desactivar, pero **no** ve "Eliminar trabajador" (el servidor responde 403).

### E16. Cierre del día
- **Pantalla:** Caja → Cierre.
- **Valores:** cuenta **$107.600** en efectivo y **$147.400** en banco.
- **Esperado:** diferencias **0**; hoy queda **verde** en Historial.
- **Después:** registrar dinero nuevo con fecha de hoy se rechaza (día cerrado).

### E17. Corregir el día cerrado (D7)
- **Operador, Historial:** hoy → **"Solicitar agregar un movimiento olvidado a este día"**.
  - Valores: egreso, efectivo, $1.000, "Olvido de prueba"; motivo "Prueba D7".
- **Admin, Solicitudes:** la tarjeta dice "Agregar a día cerrado". Pulsa **Aprobar y aplicar**.
- **Esperado:**
  - El efectivo esperado pasa a **$106.600**.
  - En Historial, "Cierre registrado (conteo original)" sigue en **$107.600** con diferencia **$0**.
  - Aparece "Correcciones aprobadas después del cierre (1)".
  - El día sigue **verde**.
- **Prueba negativa:** sin solicitud, editar o eliminar directamente un movimiento de ese día se rechaza. Una solicitud **rechazada** no cambia nada.

### E18. Pedido manual después del Cierre
- **Admin, Sucursales:** activa "Sucursal DEMO (ficticia)".
- **Pantalla:** Pedidos → **Registrar pedido**: Demo A, **$40.000**, número "POST-CIERRE".
  - Fecha de entrega: hoy.
  - Hora: una **anterior** a la actual. Una hora futura no deja continuar.
  - Debe aparecer el aviso "🔒 Ese día ya tiene Cierre…".
- **Esperado:**
  - Deudas → Demo A, comisión **$12.000** (el 30 %).
  - Efectivo **$106.600** y banco **$147.400**: **sin cambios**.
  - Historial, hoy: sigue verde; el conteo original sigue en $107.600; la comisión del día aumenta $12.000.
  - Reportes: Total ventas **$108.600** (96.600 + 12.000).
- **Prueba negativa:** registrar otra vez el mismo número ese día se rechaza ("Ya existe el pedido #POST-CIERRE…").
- Después, desactiva de nuevo la sucursal ficticia.

### E19. Persistencia
- Reinicia el PC o termina el proceso `node` y abre CashBuddy de nuevo. Los saldos y registros deben ser los mismos.

---

## Pedidos reales de Shipday (ya verificados)
- **Pedido #22** (Shipday 54814555): tarifa $40.000 y comisión **$12.000**. Su domiciliario quedó en $0 tras una base y un pago **ficticios**.
- Los pedidos **54814075** y **54808397** están en $0 / #00 porque Shipday los reporta sin tarifa. Revísalos en Shipday.
- La "Sucursal real (lectura)" está **pausada**. Si la activas, consulta Shipday con tu key y comparte el límite de peticiones con producción.
- Un pedido entregado **después** del Cierre del día, de Shipday o manual, se carga en ese día y no mueve caja. Solo un **mes** cerrado lo bloquea.
