"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";

// NEW09 (decisión del dueño, 21-oct-2026): la pantalla antigua registraba bases como movimientos de
// Caja (cat. 5/6) que no entraban en Bases, Deudas ni en el cierre de mes. Se retira y redirige a
// la pantalla vigente, igual que /nomina → /trabajadores.
export default function DomiciliariosRedirect() {
  const router = useRouter();
  useEffect(() => { router.replace("/shipday/domiciliarios"); }, []);
  return <div className="flex items-center justify-center h-64 text-muted-foreground">Redirigiendo a Domiciliarios…</div>;
}
