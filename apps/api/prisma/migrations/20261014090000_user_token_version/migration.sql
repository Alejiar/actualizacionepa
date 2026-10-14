-- Versión de sesión por usuario (aditiva, sin tocar datos existentes). Se incrementa al
-- cambiar contraseña, rol o estado; un token emitido con una versión anterior deja de ser
-- válido de inmediato, sin depender de la precisión de segundos de `iat`.
ALTER TABLE "User" ADD COLUMN "tokenVersion" INTEGER NOT NULL DEFAULT 0;
