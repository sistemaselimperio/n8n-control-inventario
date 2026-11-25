"use client";

// Historial de un comprobante como linea de tiempo (eventos del detalle).

import useSWR from "swr";
import { fetchComprobante, type EventoHistorial } from "@/lib/api";
import { CLAVE_TRASLADOS, fechaHora } from "@/lib/traslados";
import { ErrorConReintento, SkeletonLinea } from "@/components/ui";
import { ModalBase } from "./ModalBase";

// Nombres reales de los eventos (EventoLog en el backend) y sus formas cortas.
const ETIQUETA_EVENTO: Record<string, string> = {
  traslado_comprobante_creado: "Enviado al punto",
  traslado_comprobante_confirmado: "Confirmado con firma",
  traslado_comprobante_devuelto: "Devuelto",
  traslado_comprobante_reenviado: "Corregido y reenviado",
  traslado_duplicado_bloqueado: "Carga repetida bloqueada",
  creado: "Creado",
  enviado: "Enviado a los puntos",
  confirmado: "Confirmado con firma",
  devuelto: "Devuelto",
  reenviado: "Corregido y reenviado",
  editado: "Editado",
  eliminado: "Eliminado",
};

const etiquetaEvento = (e: string) => ETIQUETA_EVENTO[e] ?? (e ? e.charAt(0).toUpperCase() + e.slice(1).replace(/_/g, " ") : "Evento");

// "dashboard:susa" -> "susa".
const nombreActor = (actor: string) => actor.replace(/^dashboard:/, "");

// El detalle llega como objeto (jsonb de logs); solo se muestran los campos
// que le dicen algo a una persona. Rutas de archivos e ids se omiten.
const CAMPOS_DETALLE: [string, string][] = [
  ["motivo", "Motivo"],
  ["observacion", "Observación"],
  ["numero_anterior", "Número anterior"],
];

function textoDetalle(detalle: EventoHistorial["detalle"]): string | null {
  if (!detalle) return null;
  if (typeof detalle === "string") return detalle;
  const partes = CAMPOS_DETALLE.filter(([clave]) => typeof detalle[clave] === "string" && detalle[clave]).map(
    ([clave, etiqueta]) => `${etiqueta}: ${detalle[clave] as string}`,
  );
  return partes.length > 0 ? partes.join(" · ") : null;
}

export function ModalHistorial({
  comprobanteId,
  titulo,
  onCerrar,
}: {
  comprobanteId: string;
  titulo: string;
  onCerrar: () => void;
}) {
  const { data, error, isLoading, mutate } = useSWR([CLAVE_TRASLADOS, "comprobante", comprobanteId], () =>
    fetchComprobante(comprobanteId),
  );
  const eventos = data?.historial ?? [];

  return (
    <ModalBase etiqueta="Historial" titulo={`Historial de ${titulo}`} ancho="max-w-xl" onCerrar={onCerrar}>
      {error ? <ErrorConReintento mensaje={error.message} onReintentar={() => mutate()} /> : null}
      {isLoading ? (
        <div className="flex flex-col gap-2">
          <SkeletonLinea className="h-10 w-full" />
          <SkeletonLinea className="h-10 w-full" />
        </div>
      ) : null}
      {data && eventos.length === 0 ? <p className="text-sm text-muted">Sin eventos registrados todavía.</p> : null}
      {eventos.length > 0 ? (
        <ol className="relative flex flex-col gap-4 border-l border-line-strong pl-5">
          {eventos.map((ev, i) => {
            const detalle = textoDetalle(ev.detalle);
            return (
              <li key={`${ev.timestamp}-${i}`} className="relative flex flex-col gap-0.5">
                <span aria-hidden className="absolute -left-[26px] top-1.5 h-2.5 w-2.5 rounded-full border-2 border-surface bg-ok" />
                <span className="text-sm font-semibold text-ink">{etiquetaEvento(ev.evento)}</span>
                <span className="text-xs text-muted">
                  {fechaHora(ev.timestamp)}
                  {ev.actor ? ` · ${nombreActor(ev.actor)}` : ""}
                  {ev.resultado && ev.resultado !== "ok" ? ` · ${ev.resultado}` : ""}
                </span>
                {detalle ? <span className="text-sm text-soft">{detalle}</span> : null}
              </li>
            );
          })}
        </ol>
      ) : null}
    </ModalBase>
  );
}
