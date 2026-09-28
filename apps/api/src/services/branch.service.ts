import { refreshOrderStats } from "../lib/order-stats";
import { prisma, moneyTransaction } from "../lib/prisma";
import { encryptApiKey, decryptApiKey, DecryptError } from "../lib/crypto";
import * as shipday from "./shipday.service";
import { notFound, conflict } from "../lib/errors";
import { toBogotaDateStr, todayBogota } from "../lib/date-range";
import { applyDebtDelta } from "./driver.service";

// ─── Cache de settings (evita 1 query por cada orden sincronizada) ────────────
let _settingsCache: { shipdayCommission: number } | null = null;
let _settingsCacheAt = 0;
const SETTINGS_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutos

// Los domiciliarios cambian poco; no hace falta pedirlos a Shipday cada ciclo
// (gastaría 1 solicitud/minuto del cupo). Se refrescan como mucho cada 5 minutos.
const DRIVER_SYNC_TTL_MS = 5 * 60 * 1000;
const lastDriverSyncAt = new Map<string, number>();

// ─── Autosanación de "pedidos fantasma con valor 0" ──────────────────────────
// El webhook de Shipday (ORDER_COMPLETED) dispara en el instante en que el pedido
// se marca entregado, pero en ese momento Shipday AÚN NO fija la tarifa: manda
// `delivery_fee: 0`, `total_cost: 0` y `order_number: "00"`. El webhook guarda ese
// stub con valor 0 (sin comisión ni conteo). Después, la consulta de "ya entregados"
// (polling) SÍ trae la tarifa y el número reales — pero como persistir es idempotente
// por `shipdayOrderId`, antes se ignoraba y el pedido quedaba clavado en $0/#00 para
// siempre (y sin sumar a la deuda del domiciliario). Ahora el polling corrige ese stub
// (ver `persistDeliveredOrder`).
//
// SELF_HEAL_SINCE limita la corrección a pedidos creados a partir del despliegue de
// este arreglo. El dueño pidió expresamente NO tocar los pedidos viejos que ya quedaron
// en $0; solo que de aquí en adelante se corrijan solos. Es una fecha FIJA (no "hoy
// dinámico") para que un stub creado justo antes de medianoche también se sane al día
// siguiente, y para que el corte "desde hoy" no se mueva con el paso de los días.
const SELF_HEAL_SINCE = new Date("2026-08-03T00:00:00.000-05:00");

async function getCachedCommission(): Promise<number> {
  const now = Date.now();
  if (_settingsCache && now - _settingsCacheAt < SETTINGS_CACHE_TTL_MS) {
    return _settingsCache.shipdayCommission;
  }
  const s = await prisma.settings.findUnique({ where: { id: "singleton" } });
  _settingsCache = { shipdayCommission: s?.shipdayCommission ?? 30 };
  _settingsCacheAt = now;
  return _settingsCache.shipdayCommission;
}

export interface BranchInput {
  name: string;
  address?: string;
  phone?: string;
  apiKey: string;
}

function sanitize(b: { id: string; name: string; address: string | null; phone: string | null; active: boolean; syncStatus: string; syncMessage: string | null; lastSyncAt: Date | null; createdAt: Date; updatedAt: Date }) {
  return { ...b, apiKey: "***" };
}

export async function listBranches() {
  const rows = await prisma.branch.findMany({ orderBy: { createdAt: "asc" } });
  return rows.map(sanitize);
}

export async function getBranch(id: string) {
  const row = await prisma.branch.findUnique({ where: { id } });
  if (!row) throw notFound("Sucursal no encontrada");
  return sanitize(row);
}

export async function createBranch(input: BranchInput) {
  const exists = await prisma.branch.findFirst({ where: { name: input.name } });
  if (exists) throw conflict("Ya existe una sucursal con ese nombre");
  const row = await prisma.branch.create({
    data: {
      name: input.name,
      address: input.address,
      phone: input.phone,
      apiKeyEnc: encryptApiKey(input.apiKey),
    },
  });
  return sanitize(row);
}

export async function updateBranch(id: string, input: Partial<BranchInput> & { active?: boolean }) {
  const exists = await prisma.branch.findUnique({ where: { id } });
  if (!exists) throw notFound("Sucursal no encontrada");
  const data: Record<string, unknown> = {};
  if (input.name !== undefined) data.name = input.name;
  if (input.address !== undefined) data.address = input.address;
  if (input.phone !== undefined) data.phone = input.phone;
  if (input.active !== undefined) data.active = input.active;
  if (input.apiKey !== undefined) data.apiKeyEnc = encryptApiKey(input.apiKey);
  const row = await prisma.branch.update({ where: { id }, data });
  return sanitize(row);
}

export async function deleteBranch(id: string) {
  return moneyTransaction(async () => {
  const exists = await prisma.branch.findUnique({ where: { id } });
  if (!exists) throw notFound("Sucursal no encontrada");
  // Conserva toda la historia y los vínculos bancarios; DELETE significa desactivar.
  await prisma.branch.update({ where: { id }, data: { active: false } });
  });
}

export async function testBranchConnection(id: string) {
  const branch = await prisma.branch.findUnique({ where: { id } });
  if (!branch) throw notFound("Sucursal no encontrada");
  const apiKey = decryptApiKey(branch.apiKeyEnc);
  const result = await shipday.testConnection(apiKey);
  await prisma.branch.update({
    where: { id },
    data: {
      syncStatus: result.ok ? "ok" : "error",
      syncMessage: result.message,
    },
  });
  return result;
}

// Caché en memoria de pedidos vistos como activos (pre-entrega), por sucursal.
// Cuando desaparecen del feed activo → se asumen entregados y se registran.
interface ActiveOrderSnapshot {
  shipdayOrderId: string;
  driverShipdayId: string | null;
  deliveryValue: number;
  orderNumber: string | null;
  customerName: string | null;
  customerAddress: string | null;
  raw: object;
}
const activeOrdersByBranch = new Map<string, Map<string, ActiveOrderSnapshot>>();

export interface SyncOptions {
  // Cuántos días hacia atrás (Bogotá) revisar. 0 = solo hoy (sync rápido y liviano,
  // ~3 solicitudes). El barrido de recuperación usa un valor mayor para no perder
  // pedidos rezagados o entregados cerca de medianoche. Siempre topado por ordersSince.
  windowDays?: number;
  // Forzar refresco de domiciliarios aunque la caché esté vigente.
  forceDrivers?: boolean;
}

export async function syncBranch(id: string, opts: SyncOptions = {}): Promise<{ drivers: number; orders: number; partial?: boolean; error?: string }> {
  const branch = await prisma.branch.findUnique({ where: { id } });
  if (!branch) throw notFound("Sucursal no encontrada");
  if (!branch.active) throw conflict("La sucursal está desactivada. Su historial permanece disponible.");

  let apiKey: string;
  try {
    apiKey = decryptApiKey(branch.apiKeyEnc);
  } catch (err) {
    // Error de descifrado: marcar estado claro y accionable (no silencioso).
    const msg = err instanceof DecryptError
      ? err.message
      : "Error al leer la API Key. Vuelve a guardarla en la sucursal.";
    await prisma.branch.update({
      where: { id },
      data: { syncStatus: "error", syncMessage: msg },
    });
    throw err;
  }

  let driversCount = 0;
  let ordersCount = 0;
  let partialError: string | undefined;

  try {
    // 1. Sync drivers (solo si la caché expiró: ahorra 1 solicitud/ciclo del cupo).
    const driversStale = opts.forceDrivers || Date.now() - (lastDriverSyncAt.get(id) ?? 0) > DRIVER_SYNC_TTL_MS;
    if (driversStale) {
      const shipdayDrivers = await shipday.getDrivers(apiKey);
      const seenShipdayIds = new Set<string>();
      for (const sd of shipdayDrivers) {
        seenShipdayIds.add(String(sd.id));
        await prisma.driver.upsert({
          where: { shipdayDriverId_branchId: { shipdayDriverId: String(sd.id), branchId: id } },
          create: {
            shipdayDriverId: String(sd.id),
            branchId: id,
            name: sd.name,
            phone: sd.phoneNumber ?? null,
            email: sd.email ?? null,
            active: sd.isActive !== false,
          },
          update: {
            name: sd.name,
            phone: sd.phoneNumber ?? null,
            email: sd.email ?? null,
            active: sd.isActive !== false,
          },
        });
        driversCount++;
      }
      // Reconciliar ELIMINACIONES: un domiciliario borrado en Shipday desaparece por
      // completo de /carriers (uno solo desactivado sigue apareciendo con isActive=false
      // y ya lo maneja el upsert de arriba). GUARDA anti-glitch: solo reconciliar si
      // Shipday devolvió al menos un domiciliario. Una lista vacía puede ser un fallo
      // transitorio de la API; borrar/inactivar a TODA la nómina por eso sería catastrófico.
      if (seenShipdayIds.size > 0) {
        await reconcileDeletedDrivers(id, seenShipdayIds);
      }
      lastDriverSyncAt.set(id, Date.now());
    }

    // 2. Pedidos — se leen los COMPLETADOS reales desde Shipday (POST /orders/query
    //    con orderStatus=ALREADY_DELIVERED), NO se infiere la entrega por desaparición.
    //    Los pedidos cancelados/eliminados NO aparecen en "completados", así que no
    //    se pueden contar como entregados por error. Se persiste cada completado nuevo
    //    (persistDeliveredOrder ignora los que ya existen) y se acumula la deuda.
    const commissionPercent = await getCachedCommission();

    // Ventana de consulta. El sync rápido usa solo HOY (windowDays=0): así cada
    // ciclo pide pocas páginas (~3) y no crece sin límite con el paso de los días
    // —que era la causa de fondo del "rate limit exceeded". El barrido de
    // recuperación periódico usa una ventana mayor para reconocer cualquier pedido
    // rezagado o entregado cerca de medianoche, sin perder ninguno.
    const windowDays = Math.max(0, opts.windowDays ?? 0);
    const to = todayBogota();
    const fromDate = new Date(to + "T00:00:00.000-05:00");
    fromDate.setDate(fromDate.getDate() - windowDays);
    // DÍA DE ARRANQUE: si la sucursal tiene ordersSince, nunca se cargan pedidos
    // anteriores a esa fecha (el sistema solo cuenta desde el día que se empezó a usar).
    if (branch.ordersSince && branch.ordersSince > fromDate) {
      fromDate.setTime(branch.ordersSince.getTime());
    }
    const from = toBogotaDateStr(fromDate);

    const completed = await shipday.getCompletedOrders(apiKey, from, to);
    partialError = completed.partialError;
    for (const co of completed) {
      const orderId = String(co.orderId);
      const deliveredAt = shipday.getCompletedDeliveredAt(co);
      // Ignorar lo anterior al día de arranque.
      if (branch.ordersSince && deliveredAt < branch.ordersSince) continue;
      const created = await persistDeliveredOrder(id, orderId, {
        deliveryValue: shipday.getCompletedDeliveryValue(co),
        driverShipdayId: shipday.getCompletedCarrierId(co),
        orderNumber: co.orderNumber ?? null,
        customerName: co.delivery?.name ?? null,
        customerAddress: co.delivery?.address ?? null,
        deliveredAt,
        commissionPercent,
        raw: co as object,
      });
      if (created) ordersCount++;
    }

    await prisma.branch.update({
      where: { id },
      data: { syncStatus: partialError ? "error" : "ok", syncMessage: partialError ?? null, lastSyncAt: new Date() },
    });
  } catch (err) {
    await prisma.branch.update({
      where: { id },
      data: { syncStatus: "error", syncMessage: err instanceof Error ? err.message : String(err) },
    });
    throw err;
  }

  return { drivers: driversCount, orders: ordersCount, partial: !!partialError, error: partialError };
}

/**
 * Reconcilia los domiciliarios que YA NO existen en Shipday (borrados allá) contra la
 * base local. Regla (elegida por el dueño — opción "inteligente"):
 *   - Sin ningún rastro de dinero/historial (deuda, crédito, pedidos, bases, pagos,
 *     stats) → se BORRA del sistema: desaparece por completo, no deja basura.
 *   - Con deuda, crédito o historial → se INACTIVA (active=false), NUNCA se borra:
 *     borrar a alguien que debe (o a quien se le debe) plata borraría ese registro y
 *     dejaría un agujero contable. Inactivo sigue visible en "Deudas" y en la lista
 *     (marcado "Inactivo") para poder cobrar/pagar.
 * `shipdayIds` = ids de Shipday presentes en la última respuesta de /carriers.
 */
async function reconcileDeletedDrivers(branchId: string, shipdayIds: Set<string>): Promise<void> {
  return moneyTransaction(async () => {
  const locals = await prisma.driver.findMany({
    where: { branchId },
    select: { id: true, shipdayDriverId: true, active: true, pendingDebt: true, creditAmount: true },
  });
  for (const d of locals) {
    if (shipdayIds.has(d.shipdayDriverId)) continue; // sigue existiendo en Shipday

    // ¿Tiene deuda/crédito o cualquier historial que debamos conservar?
    let hasFootprint = d.pendingDebt > 0 || (d.creditAmount ?? 0) > 0;
    if (!hasFootprint) {
      const [orders, bases, payments, stats, bankTxs] = await Promise.all([
        prisma.shipdayOrder.count({ where: { driverId: d.id } }),
        prisma.baseTransaction.count({ where: { driverId: d.id } }),
        prisma.driverPayment.count({ where: { driverId: d.id } }),
        prisma.dailyDriverStat.count({ where: { driverId: d.id } }),
        // BankTransaction referencia al domiciliario solo por trazabilidad (sin FK), pero
        // si aparece en algún movimiento de banco preferimos conservarlo (inactivar) antes
        // que borrarlo y dejar un driverId colgante.
        prisma.bankTransaction.count({ where: { driverId: d.id } }),
      ]);
      hasFootprint = orders > 0 || bases > 0 || payments > 0 || stats > 0 || bankTxs > 0;
    }

    if (hasFootprint) {
      // Conservar: solo inactivar si aún estaba activo (evita escrituras redundantes).
      if (d.active) {
        await prisma.driver.update({ where: { id: d.id }, data: { active: false } });
      }
    } else {
      // Sin rastro alguno → seguro de borrar (no hay dinero ni historial que perder).
      await prisma.driver.delete({ where: { id: d.id } });
    }
  }

  });
}

interface DeliveredPayload {
  deliveryValue: number;
  driverShipdayId: string | null;
  orderNumber: string | null;
  customerName: string | null;
  customerAddress: string | null;
  deliveredAt: Date;
  commissionPercent: number;
  raw: object;
}

async function persistDeliveredOrder(branchId: string, shipdayOrderId: string, p: DeliveredPayload): Promise<boolean> {
  return moneyTransaction(async () => {
  // Lápida: un pedido que un admin eliminó (vía EditRequest) NO debe resucitar aunque
  // Shipday lo siga reportando entregado. Sin esta guarda, el borrado "no pega".
  const tombstoned = await prisma.deletedShipdayOrder.findUnique({ where: { shipdayOrderId } });
  if (tombstoned) return false;

  const branch = await prisma.branch.findUnique({where:{id:branchId}});
  if (!branch?.active) return false;
  const existing = await prisma.shipdayOrder.findUnique({ where: { shipdayOrderId } });

  const companyAmount = Math.round(p.deliveryValue * (p.commissionPercent / 100));
  let driverId: string | null = null;
  if (p.driverShipdayId) {
    const d = await prisma.driver.findUnique({
      where: { shipdayDriverId_branchId: { shipdayDriverId: p.driverShipdayId, branchId } },
    });
    driverId = d?.id ?? null;
  }

  const dateStr = toBogotaDateStr(p.deliveredAt);

  if (existing) {
    await prisma.shipdayOrder.update({where:{id:existing.id},data:{shipdayDeliveryValue:p.deliveryValue}});
    // AUTOSANACIÓN: el pedido ya está guardado, pero puede ser un stub del webhook con
    // valor 0 (ver SELF_HEAL_SINCE). Si el registro está en 0 y el polling ya trae la
    // tarifa real (>0), lo corregimos UNA sola vez: valor, comisión, número y datos del
    // cliente, y lo CONTAMOS por primera vez (deuda + estadística del día real), porque
    // el stub en 0 nunca se contó (el webhook exige companyAmount>0 para sumar).
    // Solo pedidos creados a partir del despliegue de este arreglo: los viejos no se tocan.
    const isZeroStub =
      !existing.manualOverride && existing.deliveryValue === 0 &&
      p.deliveryValue > 0 &&
      companyAmount > 0 &&
      existing.createdAt >= SELF_HEAL_SINCE &&
      !existing.shipdayOrderId.startsWith("manual-"); // los manuales no se sincronizan
    const needsDriver = !existing.driverId && !!driverId && existing.companyAmount > 0;
    if (!isZeroStub && !needsDriver) return false;
    if (!isZeroStub) {
      await prisma.$transaction(async tx => {
        await tx.shipdayOrder.update({where:{id:existing.id},data:{driverId}});
        await applyDebtDelta(tx, driverId!, existing.companyAmount);
        await refreshOrderStats(tx, {...existing, driverId});
      });
      return true;
    }

    const effectiveDriverId = driverId ?? existing.driverId;
    await prisma.$transaction(async (tx) => {
      await tx.shipdayOrder.update({
        where: { id: existing.id },
        data: {
          deliveryValue: p.deliveryValue,
          companyAmount,
          driverId: effectiveDriverId,
          orderNumber: p.orderNumber ?? existing.orderNumber,
          customerName: p.customerName ?? existing.customerName,
          customerAddress: p.customerAddress ?? existing.customerAddress,
          deliveredAt: p.deliveredAt,
          rawData: p.raw,
        },
      });
      if (effectiveDriverId) {
        // Netea contra el crédito existente (no apila deuda y crédito a la vez).
        await applyDebtDelta(tx, effectiveDriverId, companyAmount);
        await tx.dailyDriverStat.upsert({
          where: { date_driverId: { date: dateStr, driverId: effectiveDriverId } },
          create: { date: dateStr, branchId, driverId: effectiveDriverId, orderCount: 1, totalValue: p.deliveryValue, companyTotal: companyAmount },
          update: { orderCount: { increment: 1 }, totalValue: { increment: p.deliveryValue }, companyTotal: { increment: companyAmount } },
        });
      }
    });
    console.log(`[sync] pedido sanado (stub $0→real): #${p.orderNumber ?? existing.orderNumber ?? "?"} (${shipdayOrderId}) valor=${p.deliveryValue} driver=${effectiveDriverId ?? "sin asignar"}`);
    return true;
  }

  // Todas las escrituras en una sola transacción — previene datos inconsistentes en crash
  await prisma.$transaction(async (tx) => {
    await tx.shipdayOrder.create({
      data: {
        shipdayOrderId,
        branchId,
        driverId,
        orderNumber: p.orderNumber,
        deliveryValue: p.deliveryValue,
        shipdayDeliveryValue: p.deliveryValue,
        companyAmount,
        customerName: p.customerName,
        customerAddress: p.customerAddress,
        status: "DELIVERED",
        deliveredAt: p.deliveredAt,
        rawData: p.raw,
      },
    });

    if (driverId && companyAmount > 0) {
      // Netea contra el crédito existente (no apila deuda y crédito a la vez).
      await applyDebtDelta(tx, driverId, companyAmount);
      await tx.dailyDriverStat.upsert({
        where: { date_driverId: { date: dateStr, driverId } },
        create: { date: dateStr, branchId, driverId, orderCount: 1, totalValue: p.deliveryValue, companyTotal: companyAmount },
        update: { orderCount: { increment: 1 }, totalValue: { increment: p.deliveryValue }, companyTotal: { increment: companyAmount } },
      });
    }
  });

  return true;

  });
}

async function getCommissionPercent(): Promise<number> {
  const settings = await prisma.settings.findUnique({ where: { id: "singleton" } });
  return settings?.shipdayCommission ?? 30;
}

/**
 * Reconciliación administrativa: recorre el historial paginado completo de Shipday
 * (no solo el feed de "activos") para un rango de fechas y persiste cualquier pedido
 * DELIVERED/COMPLETED que falte en la BD. Corrige backlog perdido por la limitación
 * de paginación de getAllOrders (ver shipday.service.ts) — por ejemplo, pedidos del
 * día anterior que nunca se sincronizaron porque la cuenta ya tenía muchos pedidos
 * históricos.
 */
export async function reconcileBranch(id: string, from: string, to: string): Promise<{ checked: number; created: number }> {
  const branch = await prisma.branch.findUnique({ where: { id } });
  if (!branch) throw notFound("Sucursal no encontrada");
  if (!branch.active) throw conflict("La sucursal está desactivada. Su historial permanece disponible.");

  const apiKey = decryptApiKey(branch.apiKeyEnc);
  const commissionPercent = await getCachedCommission();
  const delivered = await shipday.getDeliveredOrdersInRange(apiKey, from, to);

  let created = 0;
  for (const so of delivered) {
    const orderId = String(so.orderId);
    const ok = await persistDeliveredOrder(id, orderId, {
      deliveryValue: shipday.getOrderDeliveryValue(so),
      driverShipdayId: shipday.getOrderCarrierId(so),
      orderNumber: so.orderNumber ?? null,
      customerName: so.customer?.name ?? null,
      customerAddress: so.customer?.address ?? null,
      deliveredAt: shipday.getOrderDeliveredAt(so),
      commissionPercent,
      raw: so as object,
    });
    if (ok) created++;
  }

  return { checked: delivered.length, created };
}

export async function syncAllBranches(opts: SyncOptions = {}) {
  const branches = await prisma.branch.findMany({ where: { active: true } });
  const results = [];
  for (const b of branches) {
    try {
      const r = await syncBranch(b.id, opts);
      results.push({ branchId: b.id, name: b.name, ...r, ok: !r.partial });
    } catch (err) {
      results.push({ branchId: b.id, name: b.name, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return results;
}

/**
 * "Cargar pedidos desde hoy": fija el día de arranque al inicio de HOY (Bogotá),
 * limita las importaciones futuras y sincroniza los pedidos de hoy.
 * Conserva el historial contable y los saldos existentes.
 */
export async function startOrdersFromToday(branchId: string) {
  const branch = await prisma.branch.findUnique({ where: { id: branchId } });
  if (!branch) throw notFound("Sucursal no encontrada");

  const since = new Date(todayBogota() + "T00:00:00.000-05:00");

  // Solo limita futuras importaciones; conserva pedidos, pagos y saldos existentes.
  await prisma.branch.update({ where: { id: branchId }, data: { ordersSince: since } });

  // Sincronizar para traer todos los pedidos de hoy.
  const r = await syncBranch(branchId);
  return { ordersSince: since, ...r };
}
