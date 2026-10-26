// Utilidades y constantes compartidas entre el panel de traslados y sus
// modales (estados con su tono, referencia del talonario y formato de fechas).

import type { FilaTrasladoSyscafe } from "@/lib/api";
import type { TonoPildora } from "@/components/ui";

export const ESTADOS: Record<string, { texto: string; tono: TonoPildora }> = {
  en_transito: { texto: "En tránsito", tono: "warn" },
  recibido: { texto: "Recibido", tono: "ok" },
  recibido_con_novedad: { texto: "Con novedad", tono: "error" },
  anulada: { texto: "Anulada", tono: "neutro" },
};

// Texto del origen cuando la mercancia llega directo del proveedor (sin punto de origen).
export const ORIGEN_DIRECTO = "Llega directo";

export function referencia(
  fila: Pick<FilaTrasladoSyscafe, "tipo" | "numero_talonario" | "talonario_id" | "consecutivo">,
): string {
  if (fila.numero_talonario && (fila.tipo === "anulada" || fila.talonario_id)) return fila.numero_talonario;
  return `TP-${String(fila.consecutivo ?? 0).padStart(6, "0")}`;
}

// Empresas con talonario propio, por la letra de la hoja (debe coincidir con
// EMPRESAS_TALONARIO de la app movil, ModalTalonario.tsx).
export const EMPRESAS_TALONARIO = [
  { letra: "A", nombre: "Comercializadora El Imperio" },
  { letra: "V", nombre: "Agroveterinaria La Rebaja" },
] as const;

/** Letra de la hoja ("V 120" -> "V") si la fila es de talonario; null en los traslados antiguos. */
export function letraTalonario(
  fila: Pick<FilaTrasladoSyscafe, "tipo" | "numero_talonario" | "talonario_id">,
): string | null {
  if (!fila.numero_talonario || !(fila.tipo === "anulada" || fila.talonario_id)) return null;
  return /^\s*([A-Za-z]{1,3})/.exec(fila.numero_talonario)?.[1].toUpperCase() ?? null;
}

/** Empresa del talonario de la fila segun su letra, o null si no aplica. */
export function empresaTalonario(
  fila: Pick<FilaTrasladoSyscafe, "tipo" | "numero_talonario" | "talonario_id">,
): string | null {
  const letra = letraTalonario(fila);
  return EMPRESAS_TALONARIO.find((e) => e.letra === letra)?.nombre ?? null;
}

// "2026-10-13" -> "13/10/2026" sin pasar por Date (evita el corrimiento de zona horaria).
export function fechaCorta(iso: string): string {
  const [anio, mes, dia] = iso.slice(0, 10).split("-");
  return anio && mes && dia ? `${dia}/${mes}/${anio}` : iso;
}

export function fechaHora(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString() : "—";
}
