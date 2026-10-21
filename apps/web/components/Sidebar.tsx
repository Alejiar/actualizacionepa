"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import {
  LayoutDashboard, Truck, Package, FileText, Landmark, Lock, History,
  Users, UserCircle, BarChart3, Settings, LogOut, Banknote, AlertTriangle, Receipt, Bell, X, NotebookPen, Monitor,
} from "lucide-react";
import { useAuth } from "@/lib/auth";
import { useStore } from "@/lib/store";
import * as api from "@/lib/sd-api";

interface NavItem { to: string; icon: React.ElementType; label: string; exact?: boolean; adminOnly?: boolean; badge?: number }
interface NavGroup { label: string; items: NavItem[] }

interface SidebarProps {
  mobileOpen?: boolean;
  onClose?: () => void;
}

export function Sidebar({ mobileOpen = false, onClose }: SidebarProps) {
  const path = usePathname();
  const { logout, user } = useAuth();
  const { state } = useStore();
  const brand = state.settings.brandName || "Cash Buddy";
  const logo = state.settings.logoData;
  const company = state.settings.companyName;
  const isAdmin = user?.role === "admin";
  const [pendingRequests, setPendingRequests] = useState(0);
  const [pendingExpenses, setPendingExpenses] = useState(0);
  const [pendingDevices, setPendingDevices] = useState(0);

  // Notificaciones del admin: solicitudes de cambio + gastos pendientes + equipos por autorizar
  // Poll cada 8s para que sea casi en vivo entre varios PCs.
  useEffect(() => {
    if (!isAdmin) return;
    const loadCount = () => {
      api.getEditRequestCount().then(r => setPendingRequests(r.count)).catch(() => {});
      // Solo gastos (3/4): es lo que lista Gastos. Una comisión manual pendiente se liquida en
      // Trabajadores; contarla aquí mostraba un aviso sin fila que atender (AIF13).
      api.getPendingMovements().then(m => setPendingExpenses(m.filter(x => x.category === 3 || x.category === 4).length)).catch(() => {});
      api.getDevicePendingCount().then(r => setPendingDevices(r.count)).catch(() => {});
    };
    loadCount();
    const onVis = () => { if (document.visibilityState === "visible") loadCount(); };
    document.addEventListener("visibilitychange", onVis);
    const t = setInterval(loadCount, 8_000);
    return () => { clearInterval(t); document.removeEventListener("visibilitychange", onVis); };
  }, [isAdmin]);

  const NAV_GROUPS: NavGroup[] = [
    {
      label: "Operaciones",
      items: [
        { to: "/shipday", icon: LayoutDashboard, label: "Dashboard", exact: true },
        { to: "/shipday/domiciliarios", icon: Truck, label: "Domiciliarios" },
        { to: "/shipday/pedidos", icon: Package, label: "Pedidos" },
        { to: "/shipday/bases", icon: Banknote, label: "Bases" },
        { to: "/shipday/deudas", icon: AlertTriangle, label: "Deudas" },
      ],
    },
    {
      label: "Caja",
      items: [
        { to: "/movimientos", icon: FileText, label: "Movimientos" },
        { to: "/gastos", icon: Receipt, label: "Gastos", badge: isAdmin ? pendingExpenses : 0 },
        { to: "/banco", icon: Landmark, label: "Banco" },
        { to: "/caja", icon: Lock, label: "Caja / Turnos" },
        { to: "/libreta", icon: NotebookPen, label: "Libreta de campo" },
        { to: "/historial", icon: History, label: "Historial" },
      ],
    },
    {
      label: "Personas & Admin",
      items: [
        { to: "/trabajadores", icon: Users, label: "Trabajadores" },
        { to: "/clientes", icon: UserCircle, label: "Clientes" },
        { to: "/solicitudes", icon: Bell, label: "Solicitudes", adminOnly: true, badge: pendingRequests },
        { to: "/equipos", icon: Monitor, label: "Equipos", adminOnly: true, badge: pendingDevices },
        { to: "/shipday/reportes", icon: BarChart3, label: "Reportes" },
        { to: "/configuracion", icon: Settings, label: "Configuración" },
      ],
    },
  ];

  function isActive(item: NavItem) {
    if (item.exact) return path === item.to;
    return path.startsWith(item.to);
  }

  return (
    <aside
      className={`
        bg-sidebar text-sidebar-foreground border-r border-sidebar-border flex flex-col
        w-60 shrink-0
        md:sticky md:top-0 md:h-screen md:self-start
        max-md:fixed max-md:inset-y-0 max-md:left-0 max-md:z-40 max-md:w-64
        max-md:transition-transform max-md:duration-300
        ${mobileOpen ? "max-md:translate-x-0" : "max-md:-translate-x-full"}
      `}
    >
      <div className="px-5 py-5 border-b border-sidebar-border flex items-center justify-between">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-primary to-accent flex items-center justify-center text-background font-black text-lg overflow-hidden shrink-0">
            {logo
              ? <img src={logo} alt="logo" className="w-full h-full object-contain" />
              : brand.charAt(0).toUpperCase()}
          </div>
          <div className="min-w-0">
            <div className="font-bold leading-none truncate">{brand}</div>
            <div className="text-xs text-muted-foreground mt-0.5 truncate">{company} · {isAdmin ? "Admin" : "Operador"}</div>
          </div>
        </div>
        {/* Cerrar — solo móvil */}
        <button onClick={onClose} className="md:hidden p-1.5 rounded-lg hover:bg-sidebar-accent/40 transition" aria-label="Cerrar menú">
          <X className="h-5 w-5" />
        </button>
      </div>

      <nav className="flex-1 px-3 py-3 space-y-4 overflow-y-auto">
        {NAV_GROUPS.map((group) => (
          <div key={group.label}>
            <p className="px-2 mb-1 text-[10px] font-bold uppercase tracking-widest text-muted-foreground/50">
              {group.label}
            </p>
            <div className="space-y-0.5">
              {group.items.filter(item => !item.adminOnly || isAdmin).map((item) => {
                const active = isActive(item);
                const Icon = item.icon;
                return (
                  <Link
                    key={item.to}
                    href={item.to}
                    onClick={onClose}
                    className={`flex items-center gap-3 px-3 py-2 rounded-xl transition text-sm ${
                      active
                        ? "bg-sidebar-accent text-sidebar-accent-foreground shadow-cash font-semibold"
                        : "text-sidebar-foreground/70 hover:bg-sidebar-accent/40 hover:text-sidebar-accent-foreground"
                    }`}
                  >
                    <Icon className={`h-4 w-4 shrink-0 ${active ? "text-primary" : ""}`} />
                    <span className="truncate flex-1">{item.label}</span>
                    {item.badge != null && item.badge > 0 && (
                      <span className="shrink-0 min-w-[18px] h-[18px] px-1 rounded-full bg-red-500 text-white text-[10px] font-bold flex items-center justify-center">
                        {item.badge}
                      </span>
                    )}
                  </Link>
                );
              })}
            </div>
          </div>
        ))}
      </nav>

      <div className="px-3 py-3 border-t border-sidebar-border">
        <button
          onClick={logout}
          className="w-full flex items-center gap-3 px-3 py-2 rounded-xl text-sidebar-foreground/70 hover:bg-sidebar-accent/40 hover:text-sidebar-accent-foreground transition text-sm"
        >
          <LogOut className="h-4 w-4" />
          <span className="flex-1 text-left">Cerrar sesión</span>
        </button>
        <p className="px-2 pt-2 text-[10px] text-muted-foreground opacity-40">Cash Buddy · v1.0</p>
      </div>
    </aside>
  );
}
