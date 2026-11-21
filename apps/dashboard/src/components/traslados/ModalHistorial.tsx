"use client";

// Historial de un comprobante como linea de tiempo (eventos del detalle).

import useSWR from "swr";
import { fetchComprobante } from "@/lib/api";
import { CLAVE_TRASLADOS, fechaHora } from "@/lib/traslados";
import { ErrorConReintento, SkeletonLinea } from "@/components/ui";
import { ModalBase } from "./ModalBase";

const ETIQUETA_EVENTO: Record<string, string> = {
  creado: "Creado",
  enviado: "Enviado a los puntos",
  confirmado: "Confirmado con firma",
  devuelto: "Devuelto",
  reenviado: "Corregido y reenviado",
  editado: "Editado",
  eliminado: "Eliminado",
};

const etiquetaEvento = (e: string) => ETIQUETA_EVENTO[e] ?? (e ? e.charAt(0).toUpperCase() + e.slice(1).replace(/_/g, " ") : "Evento");

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
          {eventos.map((ev, i) => (
            <li key={`${ev.timestamp}-${i}`} className="relative flex flex-col gap-0.5">
              <span aria-hidden className="absolute -left-[26px] top-1.5 h-2.5 w-2.5 rounded-full border-2 border-surface bg-ok" />
              <span className="text-sm font-semibold text-ink">{etiquetaEvento(ev.evento)}</span>
              <span className="text-xs text-muted">
                {fechaHora(ev.timestamp)}
                {ev.actor ? ` · ${ev.actor}` : ""}
                {ev.resultado && ev.resultado !== "ok" ? ` · ${ev.resultado}` : ""}
              </span>
              {ev.detalle ? <span className="text-sm text-soft">{ev.detalle}</span> : null}
            </li>
          ))}
        </ol>
      ) : null}
    </ModalBase>
  );
}
