"use client";

// Formulario para resolver una novedad pendiente desde el detalle del traslado:
// la solucion (texto) y el consecutivo bajo el que queda archivada (codigo de
// punto + numero, ej. NPT-1234). El codigo viene del punto DESTINO del
// traslado, pero se puede cambiar. Los errores del backend (consecutivo ya
// usado, novedad ya resuelta) se muestran tal cual debajo del formulario.

import { useState, type FormEvent } from "react";
import useSWR from "swr";
import { toast } from "sonner";
import { fetchPuntosPublicos, resolverNovedadDashboard } from "@/lib/api";
import { claseBoton, CLASE_CAMPO } from "@/components/ui";

const MAX_SOLUCION = 2000;

export function FormSolucionNovedad({
  trasladoId,
  puntoDestinoId,
  onResuelta,
}: {
  trasladoId: string;
  puntoDestinoId: string | null | undefined;
  onResuelta: () => void | Promise<void>;
}) {
  const { data: puntos } = useSWR("puntos-publicos", fetchPuntosPublicos);
  const codigoDestino = (puntos ?? []).find((p) => p.id === puntoDestinoId)?.codigo ?? "";

  const [solucion, setSolucion] = useState("");
  // null = el usuario aun no toco el campo: se muestra el codigo del destino.
  const [codigoEditado, setCodigoEditado] = useState<string | null>(null);
  const [numero, setNumero] = useState("");
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const codigo = codigoEditado ?? codigoDestino;
  const completo = solucion.trim() !== "" && codigo.trim() !== "" && numero !== "";

  const enviar = async (ev: FormEvent) => {
    ev.preventDefault();
    if (!completo || enviando) return;
    setEnviando(true);
    setError(null);
    try {
      await resolverNovedadDashboard(trasladoId, {
        solucion: solucion.trim(),
        consecutivo_codigo: codigo.trim().toUpperCase(),
        consecutivo_numero: numero,
      });
      toast.success("Novedad resuelta");
      await onResuelta();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo guardar la solución");
    } finally {
      setEnviando(false);
    }
  };

  return (
    <form onSubmit={enviar} className="flex flex-col gap-3 border-t border-line pt-3" aria-label="Resolver novedad">
      <div className="flex flex-col gap-1">
        <label htmlFor={`solucion-${trasladoId}`} className="text-xs font-medium text-muted">
          Solución
        </label>
        <textarea
          id={`solucion-${trasladoId}`}
          value={solucion}
          onChange={(e) => setSolucion(e.target.value)}
          maxLength={MAX_SOLUCION}
          rows={3}
          placeholder="Qué se hizo para resolver la novedad"
          className={`${CLASE_CAMPO} min-h-20 py-2`}
        />
        <span className="self-end text-xs tabular-nums text-subtle">
          {solucion.length}/{MAX_SOLUCION}
        </span>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1">
          <label htmlFor={`consec-codigo-${trasladoId}`} className="text-xs font-medium text-muted">
            Código del consecutivo
          </label>
          <input
            id={`consec-codigo-${trasladoId}`}
            value={codigo}
            onChange={(e) =>
              setCodigoEditado(
                e.target.value
                  .toUpperCase()
                  .replace(/[^A-Z0-9]/g, "")
                  .slice(0, 10),
              )
            }
            placeholder="NPT"
            className={`${CLASE_CAMPO} cifra w-28 uppercase`}
          />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor={`consec-numero-${trasladoId}`} className="text-xs font-medium text-muted">
            Número del consecutivo
          </label>
          <input
            id={`consec-numero-${trasladoId}`}
            value={numero}
            onChange={(e) => setNumero(e.target.value.replace(/\D/g, "").slice(0, 10))}
            inputMode="numeric"
            placeholder="1234"
            className={`${CLASE_CAMPO} cifra w-32`}
          />
        </div>
        <button type="submit" disabled={!completo || enviando} className={claseBoton("primario")}>
          {enviando ? "Guardando…" : "Marcar como resuelta"}
        </button>
      </div>

      {error ? (
        <p role="alert" className="text-sm text-danger-fg">
          {error}
        </p>
      ) : null}
    </form>
  );
}
