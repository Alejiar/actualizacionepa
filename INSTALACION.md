# 📦 Instalación de Cash Buddy EPA en otro PC

Esta guía deja el sistema funcionando en un PC nuevo **exactamente igual** que en el PC principal: backend + frontend servidos en un solo puerto (4000) y el lanzador de escritorio `CashBuddy.exe`.

> Pensado para **Windows 10/11**. Sigue los pasos en orden.

---

## 1. Requisitos previos (instalar una sola vez)

Descarga e instala en el PC nuevo:

| Programa | Versión recomendada | Enlace |
|----------|--------------------|--------|
| **Node.js** | 20 o superior (LTS) | https://nodejs.org |
| **PostgreSQL** | 16 o 17 | https://www.postgresql.org/download/windows/ |
| **WebView2 Runtime** | (ya viene en Windows 11) | https://developer.microsoft.com/microsoft-edge/webview2/ |

> Durante la instalación de **PostgreSQL** anota la **contraseña** del usuario `postgres`; la necesitarás más adelante. Acepta el puerto **5432** por defecto.

Verifica que Node quedó instalado abriendo **PowerShell**:

```powershell
node --version
npm --version
```

---

## 2. Copiar el proyecto

Copia la carpeta del proyecto (desde USB, red, etc.) y déjala en:

```
C:\cash-buddy-epa
```

> El lanzador `CashBuddy.exe` espera estar en esa ruta exacta.

---

## 3. Crear la base de datos

```powershell
& "C:\Program Files\PostgreSQL\17\bin\createdb.exe" -U postgres cashbuddy
```

> Si instalaste otra versión de PostgreSQL, cambia el `17` por la tuya (ej. `16`).

---

## 4. Configurar las variables de entorno (.env)

```powershell
cd C:\cash-buddy-epa
Copy-Item .env.example .env
notepad .env
```

Ajusta como mínimo:

```
DATABASE_URL="postgresql://postgres:TU_CONTRASEÑA@localhost:5432/cashbuddy?schema=public"
JWT_SECRET="cadena-larga-y-aleatoria"
ENCRYPTION_KEY="otra-cadena-larga-y-aleatoria"
```

Guarda y cierra.

> ⚠️ El `.env` **no se incluye en la copia** porque contiene contraseñas. Hay que crearlo en cada PC.

---

## 5. Instalar dependencias

```powershell
cd C:\cash-buddy-epa
npm install
```

(Puede tardar varios minutos la primera vez.)

---

## 6. Preparar la base de datos

```powershell
cd C:\cash-buddy-epa\apps\api
# El .env está en la raíz; la herramienta de Prisma necesita la URL en esta sesión:
$env:DATABASE_URL = ((Get-Content ..\..\.env | Where-Object { $_ -match '^DATABASE_URL=' }) -replace '^DATABASE_URL=','').Trim('"')
npm run db:deploy   # crea todas las tablas
npm run db:seed     # crea el usuario administrador inicial
```

> Usuario inicial: **admin@cashbuddy.local** / **admin123** (cámbialo luego desde el sistema).

---

## 7. Compilar el sistema

```powershell
cd C:\cash-buddy-epa
$env:NODE_ENV="production"
npm run build
```

> El backend sirve el frontend y la API en el **mismo puerto 4000**.

---

## 8. Iniciar el sistema

Haz **doble clic** en `C:\cash-buddy-epa\CashBuddy.exe`.

El lanzador arranca el backend automáticamente y abre la aplicación en una **ventana de escritorio propia**.

> Para tenerlo a mano: clic derecho en `CashBuddy.exe` → **Enviar a → Escritorio (crear acceso directo)**.

---

## 9. Primer uso

1. Acepta los **Términos y Condiciones**.
2. Completa el asistente de **configuración inicial** (capital inicial, etc.).
3. En **Configuración** puedes cambiar el nombre del sistema y el logo.
4. Para la integración con **Shipday**, ve a **Sucursales** y registra la **API Key** de cada sucursal.

---

## 🔄 Acceso desde otros dispositivos

- **Misma red WiFi:** otros equipos abren `http://IP-DEL-PC:4000` (la IP aparece en el Dashboard).
- **Desde fuera (Tailscale):** instala **Tailscale** en ambos equipos con la misma cuenta. La URL aparece en el Dashboard.

---

## 🔁 Actualizar el sistema

Cuando recibas una versión nueva, reemplaza la carpeta del proyecto y ejecuta:

```powershell
cd C:\cash-buddy-epa
npm install
cd apps\api
$env:DATABASE_URL = ((Get-Content ..\..\.env | Where-Object { $_ -match '^DATABASE_URL=' }) -replace '^DATABASE_URL=','').Trim('"')
npm run db:deploy
npx prisma generate
cd ..\..
$env:NODE_ENV="production"
npm run build
```

Antes de `db:deploy`, **haz un respaldo** de la base (pg_dump) y **cierra CashBuddy.exe por completo** y el proceso `node dist\index.js`: si siguen abiertos, `prisma generate` falla con `EPERM` y el backend viejo seguiría en memoria. Luego abre `CashBuddy.exe`.

---

## ❓ Solución de problemas

| Problema | Solución |
|----------|----------|
| El `.exe` se queda en "Iniciando…" | Verifica que el servicio **PostgreSQL** esté activo (`postgresql-x64-17`). Revisa `cashbuddy-launcher.log`. El lanzador espera hasta 90 s a que el servidor responda. |
| **"This site can't be reached"** al abrir | Corregido: el lanzador ahora **espera** a que el puerto 4000 responda antes de cargar la app y **reintenta** si la conexión falla. Si reaparece, recompila con `powershell -ExecutionPolicy Bypass -File scripts\build-launcher.ps1`. |
| "No se encontró Node.js" | Reinstala Node.js y reinicia el PC. |
| La app no carga / pantalla en blanco | Asegúrate de haber ejecutado `npm run build` con `NODE_ENV=production`. |
| Error de base de datos | Revisa que `DATABASE_URL` en `.env` tenga la contraseña correcta. |
| La ventana muestra ícono del navegador | Instala el **WebView2 Runtime** (viene con Windows 11). |

---

**Desarrollado por Alejandro Jiménez Arbeláez · ZENBYTE · 3234750914**
