import type { Request } from "express";
import type { Device } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { badRequest, notFound } from "../lib/errors";
import { getDeviceIdFromReq, isLoopbackReq, clientIp } from "../lib/device";
import type { Actor } from "../lib/actor";

const SERVER_DEFAULT_NAME = "PC principal (servidor)";
// No re-escribir lastSeenAt en CADA request (el polling dispararía muchísimos writes): solo
// si pasó esta ventana desde el último visto. Mantiene el "en línea" fresco sin martillar la BD.
const HEARTBEAT_THROTTLE_MS = 20_000;

export type DeviceGateCode = "DEVICE_REQUIRED" | "DEVICE_PENDING" | "DEVICE_BLOCKED";

export interface ResolvedDevice {
  device: Device | null;
  allowed: boolean;
  code?: DeviceGateCode;
}

function gateResult(device: Device, loopback: boolean): ResolvedDevice {
  if (loopback || device.status === "approved") return { device, allowed: true };
  if (device.status === "blocked") return { device, allowed: false, code: "DEVICE_BLOCKED" };
  return { device, allowed: false, code: "DEVICE_PENDING" };
}

/**
 * Resuelve el equipo del request, lo registra si es nuevo (queda `pending`), refresca su
 * "última vez visto" y decide si puede operar. El PC servidor (loopback) SIEMPRE se auto-aprueba
 * — así el admin nunca queda por fuera aunque bloquee/rechace a los demás. Idempotente: la puerta
 * y el endpoint /devices/me lo llaman sin duplicar efectos.
 */
export async function resolveDevice(req: Request): Promise<ResolvedDevice> {
  const loopback = isLoopbackReq(req);
  const deviceId = getDeviceIdFromReq(req);
  const ip = clientIp(req);
  const ua = (req.headers["user-agent"] as string | undefined) ?? null;
  const userName = req.user?.name ?? req.user?.email ?? null;
  const userId = req.user?.sub ?? null;

  if (!deviceId) {
    // Sin identificador de equipo: el servidor local igual pasa (herramientas/consola locales),
    // cualquier otro origen queda fuera hasta que el navegador mande su X-Device-Id.
    if (loopback) return { device: null, allowed: true };
    return { device: null, allowed: false, code: "DEVICE_REQUIRED" };
  }

  const existing = await prisma.device.findUnique({ where: { id: deviceId } });

  if (!existing) {
    // La primera visita de un navegador dispara varias peticiones en paralelo (settings,
    // workers, days…) y todas llegan aquí sin encontrar el equipo: solo una puede crearlo. Las
    // demás chocaban con la clave única (P2002 → "Ya existe un registro con esos datos"), la
    // carga inicial fallaba y el frontend mostraba el asistente de instalación (AIF14).
    const device = await prisma.device.create({
      data: {
        id: deviceId,
        status: loopback ? "approved" : "pending",
        trusted: loopback,
        name: loopback ? SERVER_DEFAULT_NAME : null,
        firstUserId: userId,
        firstUserName: userName,
        lastUserName: userName,
        firstSeenIp: ip,
        lastSeenIp: ip,
        userAgent: ua,
        ...(loopback ? { approvedByName: "Servidor (auto)", approvedAt: new Date() } : {}),
      },
    }).catch(async (e: unknown) => {
      if ((e as { code?: string })?.code !== "P2002") throw e;
      const raced = await prisma.device.findUnique({ where: { id: deviceId } });
      if (!raced) throw e;
      return raced;
    });
    return gateResult(device, loopback);
  }

  const stale = Date.now() - existing.lastSeenAt.getTime() > HEARTBEAT_THROTTLE_MS;
  // Red de seguridad: si por lo que sea el equipo servidor NO está aprobado/confiable, se corrige.
  const needsPromo = loopback && (existing.status !== "approved" || !existing.trusted);
  if (!stale && !needsPromo) return gateResult(existing, loopback);

  const device = await prisma.device.update({
    where: { id: deviceId },
    data: {
      lastSeenAt: new Date(),
      lastSeenIp: ip,
      lastUserName: userName ?? existing.lastUserName,
      userAgent: ua ?? existing.userAgent,
      ...(needsPromo
        ? {
            status: "approved" as const,
            trusted: true,
            name: existing.name ?? SERVER_DEFAULT_NAME,
            approvedByName: existing.approvedByName ?? "Servidor (auto)",
            approvedAt: existing.approvedAt ?? new Date(),
          }
        : {}),
    },
  });
  return gateResult(device, loopback);
}

// ─── Vista del propio equipo (para el "gate" del frontend) ─────────────────────

export async function getMyDevice(req: Request) {
  const { device, allowed, code } = await resolveDevice(req);
  return {
    id: device?.id ?? null,
    status: device?.status ?? (allowed ? "approved" : "pending"),
    name: device?.name ?? null,
    trusted: device?.trusted ?? false,
    allowed,
    code: code ?? null,
    // Señal de "cerrar sistema": el frontend compara contra la que ya manejó (localStorage).
    logoutRequestedAt: device?.logoutRequestedAt ?? null,
  };
}

// ─── Administración (solo admin) ───────────────────────────────────────────────

export async function listDevices() {
  const devices = await prisma.device.findMany({
    orderBy: [{ status: "asc" }, { lastSeenAt: "desc" }],
  });
  // Orden legible: pendientes primero (necesitan acción), luego aprobados, luego bloqueados.
  const rank: Record<string, number> = { pending: 0, approved: 1, blocked: 2 };
  devices.sort((a, b) => (rank[a.status] - rank[b.status]) || (b.lastSeenAt.getTime() - a.lastSeenAt.getTime()));
  const pendingCount = devices.filter(d => d.status === "pending").length;
  return { devices, pendingCount };
}

export async function countPending() {
  return { count: await prisma.device.count({ where: { status: "pending" } }) };
}

/** Autoriza un equipo. EXIGE nombre: sin nombre no puede operar (regla del dueño: nada de
 *  movimientos "sin nombre"). */
export async function approveDevice(id: string, name: string, actor: Actor) {
  const clean = (name ?? "").trim();
  if (!clean) throw badRequest("Ponle un nombre al equipo para autorizarlo (p. ej. \"PC 1\")");
  const device = await prisma.device.findUnique({ where: { id } });
  if (!device) throw notFound("Equipo no encontrado");
  return prisma.device.update({
    where: { id },
    data: {
      status: "approved",
      name: clean,
      approvedBy: actor.id,
      approvedByName: actor.name,
      approvedAt: new Date(),
    },
  });
}

export async function renameDevice(id: string, name: string) {
  const clean = (name ?? "").trim();
  if (!clean) throw badRequest("El nombre no puede quedar vacío");
  const device = await prisma.device.findUnique({ where: { id } });
  if (!device) throw notFound("Equipo no encontrado");
  return prisma.device.update({ where: { id }, data: { name: clean } });
}

export async function blockDevice(id: string) {
  const device = await prisma.device.findUnique({ where: { id } });
  if (!device) throw notFound("Equipo no encontrado");
  // El PC servidor no se puede bloquear (se re-aprueba solo al siguiente request); avisamos claro.
  if (device.trusted) throw badRequest("Este es el PC servidor y no se puede bloquear.");
  return prisma.device.update({ where: { id }, data: { status: "blocked" } });
}

/** Reautoriza un equipo bloqueado (conserva su nombre si ya tenía). Un equipo que se rechazó
 *  estando pendiente nunca recibió nombre: igual que en approveDevice, para operar necesita uno
 *  (antes quedaba "approved" con name=null y operaba sin identificación — AIF11). */
export async function unblockDevice(id: string, actor: Actor, name?: string) {
  const device = await prisma.device.findUnique({ where: { id } });
  if (!device) throw notFound("Equipo no encontrado");
  const clean = (name ?? "").trim() || (device.name ?? "").trim();
  if (!clean) throw badRequest("Ponle un nombre al equipo para reautorizarlo (p. ej. \"PC 1\")");
  return prisma.device.update({
    where: { id },
    data: { status: "approved", name: clean, approvedBy: actor.id, approvedByName: actor.name, approvedAt: new Date() },
  });
}

export async function rejectDevice(id: string) {
  // "Rechazar" un pendiente = bloquearlo (queda en la lista para poder reautorizar si hace falta).
  const device = await prisma.device.findUnique({ where: { id } });
  if (!device) throw notFound("Equipo no encontrado");
  if (device.trusted) throw badRequest("Este es el PC servidor y no se puede rechazar.");
  return prisma.device.update({ where: { id }, data: { status: "blocked" } });
}

/** "Cerrar sistema" en un equipo: señal de una sola vez para que vuelva al login (identificación).
 *  NO lo bloquea; puede volver a entrar. */
export async function requestLogout(id: string) {
  const device = await prisma.device.findUnique({ where: { id } });
  if (!device) throw notFound("Equipo no encontrado");
  return prisma.device.update({ where: { id }, data: { logoutRequestedAt: new Date() } });
}

export async function deleteDevice(id: string) {
  const device = await prisma.device.findUnique({ where: { id } });
  if (!device) throw notFound("Equipo no encontrado");
  if (device.trusted) throw badRequest("Este es el PC servidor y no se puede eliminar.");
  await prisma.device.delete({ where: { id } });
}

// ─── Bitácora por equipo ───────────────────────────────────────────────────────

export async function getActivity(params?: { deviceId?: string; limit?: number }) {
  return prisma.activityLog.findMany({
    where: params?.deviceId ? { deviceId: params.deviceId } : undefined,
    orderBy: { createdAt: "desc" },
    take: Math.min(params?.limit ?? 200, 1000),
  });
}
