"use client";

// Realtime de Supabase de la pagina "Traslados": un cambio en traslados o
// traslado_comprobantes revalida al instante las listas (el polling de SWR
// sigue como red de seguridad: 5 s sin socket, 30 s con el canal suscrito).
// Misma mecanica que useEntregasEnVivo.

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { POLLING_EN_VIVO_MS, POLLING_SIN_REALTIME_MS } from "@/lib/entregas";
import { revalidarTraslados } from "@/lib/traslados";

export function useTrasladosEnVivo() {
  const [enVivo, setEnVivo] = useState(false);
  const refreshInterval = enVivo ? POLLING_EN_VIVO_MS : POLLING_SIN_REALTIME_MS;

  useEffect(() => {
    const cliente = supabase;
    if (!cliente) return;
    const canal = cliente
      .channel("dashboard-traslados")
      .on("postgres_changes", { event: "*", schema: "public", table: "traslados" }, () => {
        revalidarTraslados();
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "traslado_comprobantes" }, () => {
        revalidarTraslados();
      })
      .subscribe((status) => setEnVivo(status === "SUBSCRIBED"));
    return () => {
      cliente.removeChannel(canal);
    };
  }, []);

  return { enVivo, refreshInterval };
}
