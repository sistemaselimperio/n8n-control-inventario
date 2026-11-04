// Utilidades puras de las pantallas /puntos: unir los traslados enviados y
// recibidos de un punto y calcular sus indicadores. Sin React ni red.

import type { FilaTrasladoSyscafe } from "@/lib/api";

export type DireccionTraslado = "enviado" | "recibido";

export interface TrasladoDePunto {
  fila: FilaTrasladoSyscafe;
  direccion: DireccionTraslado;
}

export interface KpisPunto {
  delMes: number;
  pendientesRecibir: number;
  conNovedad: number;
  sinSyscafe: number;
}

// "2026-10-13" o Date -> "2026-10" (mes local, sin pasar por zona horaria).
export function mesDe(valor: string | Date): string {
  if (typeof valor === "string") return valor.slice(0, 7);
  return `${valor.getFullYear()}-${String(valor.getMonth() + 1).padStart(2, "0")}`;
}

// Une lo que el punto envio (y sus hojas anuladas, de /traslados-puntos/syscafe
// con punto_id) con lo que recibio (/traslados-puntos con destino_id). Sin
// repetir por id y del mas reciente al mas antiguo. Una llegada directa no
// tiene origen: cuenta como recibida.
export function combinarTrasladosDePunto(
  enviados: FilaTrasladoSyscafe[],
  recibidos: FilaTrasladoSyscafe[],
  puntoId: string,
): TrasladoDePunto[] {
  const porId = new Map<string, TrasladoDePunto>();
  const agregar = (fila: FilaTrasladoSyscafe) => {
    const clave = `${fila.tipo}:${fila.id}`;
    if (porId.has(clave)) return;
    const recibido = fila.tipo === "traslado" && fila.punto_destino_id === puntoId && fila.punto_origen_id !== puntoId;
    porId.set(clave, { fila, direccion: recibido ? "recibido" : "enviado" });
  };
  enviados.forEach(agregar);
  recibidos.forEach(agregar);
  return [...porId.values()].sort((a, b) => b.fila.created_at.localeCompare(a.fila.created_at));
}

// Indicadores del punto. "Sin Syscafe" cuenta solo las hojas que son del punto
// (las que envio y sus llegadas directas, igual que el backend); el numero de un
// traslado recibido de otro punto lo registra el origen. Las hojas anuladas no
// son traslados y no entran en ningun conteo.
export function kpisDePunto(traslados: TrasladoDePunto[], puntoId: string, hoy: string | Date = new Date()): KpisPunto {
  const mes = mesDe(hoy);
  const reales = traslados.filter((t) => t.fila.tipo === "traslado");
  return {
    delMes: reales.filter((t) => mesDe(t.fila.fecha) === mes).length,
    pendientesRecibir: reales.filter((t) => t.fila.punto_destino_id === puntoId && t.fila.estado === "en_transito").length,
    conNovedad: reales.filter((t) => t.fila.estado === "recibido_con_novedad").length,
    sinSyscafe: reales.filter(
      (t) => (t.fila.punto_origen_id ?? t.fila.punto_destino_id) === puntoId && !t.fila.numero_syscafe,
    ).length,
  };
}
