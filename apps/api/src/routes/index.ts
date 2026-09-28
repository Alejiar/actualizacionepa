import { Router } from "express";
import { requireAdmin, requireAuth } from "../middlewares/auth";
import { requireAuthorizedDevice, logActivity } from "../middlewares/device";
import { asyncHandler } from "../middlewares/error";
import { validate } from "../middlewares/validate";
import * as auth from "../controllers/auth.controller";
import * as settings from "../controllers/settings.controller";
import * as workers from "../controllers/worker.controller";
import * as days from "../controllers/day.controller";
import * as movements from "../controllers/movement.controller";
import * as reports from "../controllers/reports.controller";
import * as admin from "../controllers/admin.controller";
import * as branch from "../controllers/branch.controller";
import * as driver from "../controllers/driver.controller";
import * as base from "../controllers/base.controller";
import * as conversion from "../controllers/conversion.controller";
import * as sdDashboard from "../controllers/shipday-dashboard.controller";
import * as close from "../controllers/close.controller";
import * as webhook from "../controllers/webhook.controller";
import * as order from "../controllers/order.controller";
import * as client from "../controllers/client.controller";
import * as hourly from "../controllers/hourly-client.controller";
import * as bankTx from "../controllers/bank-transaction.controller";
import * as shiftClose from "../controllers/shift-close.controller";
import * as unifiedMov from "../controllers/unified-movements.controller";
import * as users from "../controllers/user.controller";
import * as editReq from "../controllers/edit-request.controller";
import * as network from "../controllers/network.controller";
import * as fieldNote from "../controllers/field-note.controller";
import * as device from "../controllers/device.controller";
import {
  createMovementSchema,
  createWorkerSchema,
  loginSchema,
  registerSchema,
  updateArqueoSchema,
  updateMovementSchema,
  updateSettingsSchema,
  updateWorkerSchema,
} from "../validators/schemas";

export const apiRouter = Router();

apiRouter.get("/health", (_req, res) => res.json({ ok: true }));

// ─── Branding público (logo + nombre, sin auth para la pantalla de login) ──────
apiRouter.get("/branding", asyncHandler(settings.branding));

// ─── Auth ─────────────────────────────────────────────────────────────────────
apiRouter.post("/auth/login", validate(loginSchema), asyncHandler(auth.login));

apiRouter.get("/auth/me", requireAuth, asyncHandler(auth.me));

// ─── Webhooks Shipday (no requieren auth — vienen de Shipday) ─────────────────
apiRouter.post("/webhooks/shipday/:branchId", asyncHandler(webhook.shipdayWebhook));

// ─── A partir de aquí, todo requiere autenticación ───────────────────────────
apiRouter.use(requireAuth);

// ─── Estado del propio equipo (ANTES de la puerta) ────────────────────────────
// Un PC pendiente/bloqueado DEBE poder consultar su estado para mostrar la pantalla de
// "esperando autorización". Registra el equipo si es la primera vez que se ve.
apiRouter.get("/devices/me", asyncHandler(device.me));

// ─── Puerta de EQUIPOS + bitácora ─────────────────────────────────────────────
// De aquí en adelante SOLO operan los PC autorizados (o el PC servidor por loopback), y cada
// cambio (POST/PATCH/DELETE) queda registrado con el PC y el usuario que lo hizo.
apiRouter.use(requireAuthorizedDevice);
apiRouter.use(logActivity);
apiRouter.post("/auth/register", requireAdmin, validate(registerSchema), asyncHandler(auth.register));

// ─── Equipos: administración (solo admin) ─────────────────────────────────────
apiRouter.get("/devices", requireAdmin, asyncHandler(device.list));
apiRouter.get("/devices/pending-count", requireAdmin, asyncHandler(device.countPending));
apiRouter.get("/devices/activity", requireAdmin, asyncHandler(device.activity));
apiRouter.patch("/devices/:id/approve", requireAdmin, asyncHandler(device.approve));
apiRouter.patch("/devices/:id/rename", requireAdmin, asyncHandler(device.rename));
apiRouter.patch("/devices/:id/block", requireAdmin, asyncHandler(device.block));
apiRouter.patch("/devices/:id/unblock", requireAdmin, asyncHandler(device.unblock));
apiRouter.patch("/devices/:id/reject", requireAdmin, asyncHandler(device.reject));
apiRouter.post("/devices/:id/logout", requireAdmin, asyncHandler(device.logout));
apiRouter.delete("/devices/:id", requireAdmin, asyncHandler(device.remove));

// ─── Settings ─────────────────────────────────────────────────────────────────
apiRouter.get("/settings", asyncHandler(settings.get));
apiRouter.patch("/settings", requireAdmin, validate(updateSettingsSchema), asyncHandler(settings.update));

// ─── Libreta de campo ─────────────────────────────────────────────────────────
apiRouter.get("/field-notes", asyncHandler(fieldNote.list));
apiRouter.post("/field-notes", asyncHandler(fieldNote.create));
apiRouter.patch("/field-notes/:id", asyncHandler(fieldNote.update));
apiRouter.delete("/field-notes/:id", asyncHandler(fieldNote.remove));

// ─── Workers (sistema original) ───────────────────────────────────────────────
apiRouter.get("/workers", asyncHandler(workers.list));
apiRouter.post("/workers", validate(createWorkerSchema), asyncHandler(workers.create));
apiRouter.patch("/workers/:id", validate(updateWorkerSchema), asyncHandler(workers.update));
apiRouter.delete("/workers/:id", requireAdmin, asyncHandler(workers.remove));

// ─── Days / Arqueos ───────────────────────────────────────────────────────────
apiRouter.get("/days", asyncHandler(days.list));
// Literal antes que "/days/:date" para que no lo capture el parámetro :date.
apiRouter.get("/days/summaries", asyncHandler(days.summaries));
apiRouter.get("/days/:date/summary", asyncHandler(days.summary));
apiRouter.get("/days/:date", asyncHandler(days.get));
apiRouter.put("/days/:date/arqueo", validate(updateArqueoSchema), asyncHandler(days.updateArqueo));

// ─── Movements ────────────────────────────────────────────────────────────────
apiRouter.get("/movements", asyncHandler(movements.list));
apiRouter.get("/movements/pending", asyncHandler(movements.pending));
apiRouter.post("/movements/:id/approve", requireAdmin, asyncHandler(movements.approve));
apiRouter.post("/movements/:id/reject", requireAdmin, asyncHandler(movements.reject));
apiRouter.post("/movements", validate(createMovementSchema), asyncHandler(movements.create));
apiRouter.patch("/movements/:id", validate(updateMovementSchema), asyncHandler(movements.update));
apiRouter.delete("/movements/:id", requireAdmin, asyncHandler(movements.remove));

// ─── Reports (sistema original) ───────────────────────────────────────────────
apiRouter.get("/reports/couriers/:date", asyncHandler(reports.couriersByDay));
apiRouter.get("/reports/couriers/:date/:workerId", asyncHandler(reports.courierByWorker));
apiRouter.get("/reports/couriers/:date/:workerId/deliveries", asyncHandler(reports.courierDeliveries));
apiRouter.get("/reports/commissions/:workerId", asyncHandler(reports.commissions));
apiRouter.get("/reports/payroll/:workerId", asyncHandler(reports.payroll));

// ─── Admin ────────────────────────────────────────────────────────────────────
apiRouter.post("/admin/reset", requireAdmin, asyncHandler(admin.reset));

// ─── Sucursales ───────────────────────────────────────────────────────────────
apiRouter.get("/branches", asyncHandler(branch.list));
apiRouter.get("/branches/:id", asyncHandler(branch.get));
apiRouter.post("/branches", requireAdmin, asyncHandler(branch.create));
apiRouter.patch("/branches/:id", requireAdmin, asyncHandler(branch.update));
apiRouter.delete("/branches/:id", requireAdmin, asyncHandler(branch.remove));
apiRouter.post("/branches/:id/test-connection", asyncHandler(branch.testConnection));
apiRouter.post("/branches/:id/sync", asyncHandler(branch.sync));
apiRouter.post("/branches/sync-all", asyncHandler(branch.syncAll));
apiRouter.post("/branches/:id/reconcile", requireAdmin, asyncHandler(branch.reconcile));
apiRouter.post("/branches/:id/start-orders", requireAdmin, asyncHandler(branch.startOrders));

// ─── Domiciliarios Shipday ────────────────────────────────────────────────────
apiRouter.get("/sd/drivers", asyncHandler(driver.list));
apiRouter.get("/sd/orders/today", asyncHandler(driver.ordersToday));
apiRouter.get("/sd/drivers/:id", asyncHandler(driver.detail));
apiRouter.get("/sd/drivers/:id/statement", asyncHandler(driver.statement));
apiRouter.post("/sd/drivers/:id/payment", asyncHandler(driver.registerPayment));
apiRouter.post("/sd/drivers/:id/pay-credit", asyncHandler(driver.payCredit));

// ─── Bases ────────────────────────────────────────────────────────────────────
apiRouter.get("/sd/bases", asyncHandler(base.list));
apiRouter.post("/sd/bases/:driverId/give", asyncHandler(base.give));
apiRouter.post("/sd/bases/:driverId/pay", asyncHandler(base.pay));
apiRouter.get("/sd/bases/:driverId/summary", asyncHandler(base.summary));
apiRouter.patch("/sd/bases/:id", requireAdmin, asyncHandler(base.edit));
apiRouter.delete("/sd/bases/:id", requireAdmin, asyncHandler(base.remove));

// ─── Conversiones ─────────────────────────────────────────────────────────────
apiRouter.get("/sd/conversions", asyncHandler(conversion.list));
apiRouter.post("/sd/conversions", asyncHandler(conversion.create));
apiRouter.delete("/sd/conversions/:id", requireAdmin, asyncHandler(conversion.remove));

// ─── Dashboard Shipday ────────────────────────────────────────────────────────
apiRouter.get("/sd/dashboard", asyncHandler(sdDashboard.dashboard));
apiRouter.get("/sd/dashboard/full", asyncHandler(sdDashboard.dashboardFull));
apiRouter.get("/sd/dashboard/daily/:date", asyncHandler(sdDashboard.dailyStats));
apiRouter.get("/sd/dashboard/debts", asyncHandler(sdDashboard.debtsDashboard));
apiRouter.get("/sd/dashboard/orders/:branchId", asyncHandler(sdDashboard.ordersByBranch));

// ─── Pedidos ──────────────────────────────────────────────────────────────────
apiRouter.post("/sd/orders/manual", asyncHandler(order.manualCreate));

// ─── Cierres mensuales ────────────────────────────────────────────────────────
apiRouter.get("/sd/closes", asyncHandler(close.list));
apiRouter.post("/sd/closes", requireAdmin, asyncHandler(close.close));
apiRouter.get("/sd/report/:month", asyncHandler(close.report));
apiRouter.get("/sd/projection/:month", asyncHandler(close.projection));
apiRouter.get("/sd/closes/:id", asyncHandler(close.get));
apiRouter.get("/sd/closes/export/:month", asyncHandler(close.exportExcel));

// ─── Clientes ─────────────────────────────────────────────────────────────────
apiRouter.get("/clients", asyncHandler(client.list));
apiRouter.get("/clients/debtors", asyncHandler(client.debtors));
apiRouter.get("/clients/:id", asyncHandler(client.get));
apiRouter.post("/clients", asyncHandler(client.create));
apiRouter.patch("/clients/:id", asyncHandler(client.update));
apiRouter.delete("/clients/:id", requireAdmin, asyncHandler(client.remove));
apiRouter.post("/clients/:id/debt", asyncHandler(client.addDebt));
apiRouter.post("/clients/:id/pay", asyncHandler(client.payClient));
apiRouter.post("/clients/debts/:id/pay", asyncHandler(client.payDebt));

// ─── Clientes por hora (alquiler de domiciliarios) ────────────────────────────
apiRouter.get("/hourly-clients", asyncHandler(hourly.list));
apiRouter.get("/hourly-clients/:id", asyncHandler(hourly.get));
apiRouter.post("/hourly-clients", asyncHandler(hourly.create));
apiRouter.patch("/hourly-clients/:id", asyncHandler(hourly.update));
apiRouter.delete("/hourly-clients/:id", requireAdmin, asyncHandler(hourly.remove));
apiRouter.post("/hourly-clients/:id/shifts", asyncHandler(hourly.registerShift));
apiRouter.post("/hourly-clients/:id/pay", asyncHandler(hourly.payClient));
apiRouter.get("/hourly-shifts", asyncHandler(hourly.history));
apiRouter.post("/hourly-shifts/:id/pay-driver", asyncHandler(hourly.payDriver));
apiRouter.patch("/hourly-shifts/:id", requireAdmin, asyncHandler(hourly.editShift));
apiRouter.delete("/hourly-shifts/:id", requireAdmin, asyncHandler(hourly.removeShift));

// ─── Transacciones bancarias ──────────────────────────────────────────────────
apiRouter.get("/bank-transactions", asyncHandler(bankTx.list));
apiRouter.get("/bank-transactions/summary", asyncHandler(bankTx.summary));
apiRouter.post("/bank-transactions", asyncHandler(bankTx.create));
apiRouter.post("/bank-transactions/:id/apply-to-driver", asyncHandler(bankTx.applyToDriver));
apiRouter.delete("/bank-transactions/:id", requireAdmin, asyncHandler(bankTx.remove));

// ─── Cierres de turno ─────────────────────────────────────────────────────────
apiRouter.get("/shifts", asyncHandler(shiftClose.list));
apiRouter.get("/shifts/current-date", asyncHandler(shiftClose.currentDate));
apiRouter.get("/shifts/:date/expected", asyncHandler(shiftClose.expectedForDate));
apiRouter.get("/shifts/:date", asyncHandler(shiftClose.getForDate));
apiRouter.post("/shifts", asyncHandler(shiftClose.register));
apiRouter.delete("/shifts/:id", requireAdmin, asyncHandler(shiftClose.remove));

// ─── Movimientos unificados (todos los sistemas) ──────────────────────────────
apiRouter.get("/movements/unified", asyncHandler(unifiedMov.list));

// ─── URL de acceso local en la red ────────────────────────────────────────────
apiRouter.get("/network/local-urls", asyncHandler(network.localUrls));

// ─── Usuarios (solo admin) ────────────────────────────────────────────────────
apiRouter.get("/users", requireAdmin, asyncHandler(users.list));
apiRouter.post("/users", requireAdmin, asyncHandler(users.create));
apiRouter.patch("/users/:id", requireAdmin, asyncHandler(users.update));
apiRouter.delete("/users/:id", requireAdmin, asyncHandler(users.remove));

// ─── Solicitudes de edición ───────────────────────────────────────────────────
// Crear: cualquier usuario autenticado. Listar/revisar: solo admin.
apiRouter.get("/edit-requests", requireAdmin, asyncHandler(editReq.list));
apiRouter.get("/edit-requests/count", asyncHandler(editReq.countPending));
apiRouter.post("/edit-requests", asyncHandler(editReq.create));
apiRouter.post("/edit-requests/:id/review", requireAdmin, asyncHandler(editReq.review));
apiRouter.post("/admin/recalc-orders", requireAdmin, asyncHandler(editReq.recalcOrders));
