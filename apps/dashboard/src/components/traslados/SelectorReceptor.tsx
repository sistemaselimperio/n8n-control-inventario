"use client";

// Quien recibe un comprobante: el usuario del punto es compartido, asi que al
// confirmar o devolver un pendiente se elige a la persona de la lista de
// receptores del punto o se escribe a otra (nombre y cedula, solo para ese
// comprobante). Es un componente controlado: el modal guarda la eleccion.

import useSWR from "swr";
import { fetchReceptoresPunto } from "@/lib/api";
import { CLASE_CAMPO } from "@/components/ui";
import { OTRA_PERSONA, type SeleccionReceptor } from "@/lib/traslados";

export function SelectorReceptor({
  puntoId,
  valor,
  onCambio,
}: {
  puntoId: string;
  valor: SeleccionReceptor;
  onCambio: (v: SeleccionReceptor) => void;
}) {
  const { data, error, isLoading } = useSWR(["receptores-punto", puntoId], () => fetchReceptoresPunto(puntoId), {
    revalidateOnFocus: false,
  });
  const otra = valor.receptorId === OTRA_PERSONA;

  return (
    <div className="flex flex-col gap-2">
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-muted">Quién recibe</span>
        <select
          value={valor.receptorId}
          onChange={(e) => onCambio({ ...valor, receptorId: e.target.value })}
          className={CLASE_CAMPO}
        >
          <option value="">{isLoading ? "Cargando receptores…" : "Selecciona quién recibe"}</option>
          {(data ?? []).map((r) => (
            <option key={r.id} value={r.id}>
              {`${r.nombre} · C.C. ${r.cedula}`}
            </option>
          ))}
          <option value={OTRA_PERSONA}>Otra persona</option>
        </select>
      </label>
      {error ? (
        <p role="alert" className="text-sm text-danger-fg">
          No se pudo cargar la lista de receptores. Puedes usar «Otra persona».
        </p>
      ) : null}
      {data && data.length === 0 ? (
        <p className="text-sm text-muted">Este punto no tiene receptores registrados: usa «Otra persona».</p>
      ) : null}
      {otra ? (
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted">Nombre de quien recibe</span>
            <input
              value={valor.nombre}
              onChange={(e) => onCambio({ ...valor, nombre: e.target.value })}
              maxLength={120}
              className={CLASE_CAMPO}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted">Cédula de quien recibe</span>
            <input
              value={valor.cedula}
              onChange={(e) => onCambio({ ...valor, cedula: e.target.value })}
              inputMode="numeric"
              maxLength={20}
              className={CLASE_CAMPO}
            />
          </label>
        </div>
      ) : null}
    </div>
  );
}
