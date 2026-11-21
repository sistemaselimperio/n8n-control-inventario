"use client";

// Borradores (admin y encargada): traslados leidos del PDF que aun no se
// envian. Cada tarjeta muestra lo leido y sus advertencias; desde ahi se edita,
// se envia a los puntos (si el backend rechaza con 422 se muestran sus
// advertencias dentro de la tarjeta) o se elimina.

import { useState } from "react";
import useSWR from "swr";
import { toast } from "sonner";
import { enviarTraslado, ErrorTraslado, fetchTraslados, type Traslado } from "@/lib/api";
import { CLAVE_TRASLADOS, nombrePunto, revalidarTraslados } from "@/lib/traslados";
import { Boton, ErrorConReintento, Panel, SkeletonLinea } from "@/components/ui";
import { Dato } from "./ModalBase";

interface ErrorEnvio {
  mensaje: string;
  advertencias: string[];
}

export function SeccionBorradores({
  refreshInterval,
  onEditar,
  onEliminar,
  onVerPdf,
}: {
  refreshInterval: number;
  onEditar: (t: Traslado) => void;
  onEliminar: (t: Traslado) => void;
  onVerPdf: (t: Traslado) => void;
}) {
  const { data, error, isLoading, mutate } = useSWR(
    [CLAVE_TRASLADOS, "borradores"],
    () => fetchTraslados({ estado: "borrador", limit: 100 }),
    { refreshInterval },
  );
  const [enviando, setEnviando] = useState<string | null>(null);
  const [errores, setErrores] = useState<Record<string, ErrorEnvio>>({});
  const items = data?.items ?? [];

  const enviar = async (t: Traslado) => {
    setEnviando(t.id);
    setErrores((prev) => {
      const resto = { ...prev };
      delete resto[t.id];
      return resto;
    });
    try {
      await enviarTraslado(t.id);
      toast.success("Traslado enviado a los puntos");
      revalidarTraslados();
    } catch (err) {
      const e = err instanceof ErrorTraslado ? err : null;
      setErrores((prev) => ({
        ...prev,
        [t.id]: {
          mensaje: err instanceof Error ? err.message : "No se pudo enviar el traslado",
          advertencias: e?.advertencias ?? [],
        },
      }));
    } finally {
      setEnviando(null);
    }
  };

  return (
    <Panel
      titulo="Borradores"
      subtitulo="Revisa lo que se leyó de cada PDF, corrígelo si hace falta y envíalo a los puntos."
      conteo={data ? String(data.total) : undefined}
    >
      {error ? <ErrorConReintento mensaje={error.message} onReintentar={() => mutate()} /> : null}
      {isLoading && !data ? <SkeletonLinea className="h-24" /> : null}
      {data && items.length === 0 ? <p className="py-2 text-center text-sm text-muted">No hay borradores por revisar.</p> : null}
      <div className="flex flex-col gap-3">
        {items.map((t) => {
          const fallo = errores[t.id];
          const origen = t.origen_punto ? nombrePunto(t.origen_punto) : (t.origen_texto ?? "—");
          const destino = t.destino_punto ? nombrePunto(t.destino_punto) : (t.destino_texto ?? "—");
          return (
            <article key={t.id} className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                {t.pdf_url ? (
                  <button type="button" onClick={() => onVerPdf(t)} className="min-w-0 truncate text-left text-sm font-medium text-info hover:underline" title="Ver PDF">
                    {t.archivo_nombre ?? "Ver PDF"}
                  </button>
                ) : (
                  <span className="min-w-0 truncate text-sm font-medium text-ink">{t.archivo_nombre ?? "Sin archivo"}</span>
                )}
              </div>
              <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                <Dato etiqueta="Número">{t.numero ?? "—"}</Dato>
                <Dato etiqueta="Fecha">{t.fecha ?? "—"}</Dato>
                <Dato etiqueta="Origen">{origen}</Dato>
                <Dato etiqueta="Destino">{destino}</Dato>
              </div>
              {t.concepto ? <p className="text-sm text-muted">{t.concepto}</p> : null}
              {t.advertencias.length > 0 ? (
                <ul aria-label="Advertencias" className="flex flex-col gap-1 rounded-md border border-warn/40 bg-warn-fill/20 px-3 py-2 text-sm text-warn">
                  {t.advertencias.map((a) => (
                    <li key={a}>{a}</li>
                  ))}
                </ul>
              ) : null}
              {fallo ? (
                <div role="alert" className="flex flex-col gap-1 rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger-fg">
                  <p className="font-medium">{fallo.mensaje}</p>
                  {fallo.advertencias.length > 0 ? (
                    <ul className="list-disc pl-5">
                      {fallo.advertencias.map((a) => (
                        <li key={a}>{a}</li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              ) : null}
              <div className="flex flex-wrap justify-end gap-2">
                <Boton variante="peligro" onClick={() => onEliminar(t)}>
                  Eliminar
                </Boton>
                <Boton onClick={() => onEditar(t)}>Editar</Boton>
                <Boton variante="primario" onClick={() => enviar(t)} disabled={enviando === t.id}>
                  {enviando === t.id ? "Enviando…" : "Enviar a los puntos"}
                </Boton>
              </div>
            </article>
          );
        })}
      </div>
    </Panel>
  );
}
