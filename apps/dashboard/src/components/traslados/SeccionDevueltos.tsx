"use client";

// Bandeja de devueltos (admin y encargada): comprobantes que un punto
// rechazo, con el motivo, para corregirlos y reenviarlos o eliminar el traslado.

import useSWR from "swr";
import { fetchComprobantes, type Comprobante } from "@/lib/api";
import { CLAVE_TRASLADOS, type PerfilTraslados } from "@/lib/traslados";
import { ErrorConReintento, Panel, SkeletonLinea } from "@/components/ui";
import { BotonesComprobante, T_TABLA, T_TBODY, T_TD, T_TD_ACCIONES, T_THEAD, T_TR, type ManejadoresComprobante } from "./compartido";
import { PuntoCelda, ResponsableCelda } from "./TablaComprobantes";

const COLUMNAS = ["Punto", "Número", "Responsable", "Motivo", "Acciones"];

export function SeccionDevueltos({
  perfil,
  refreshInterval,
  ...manejadores
}: { perfil: PerfilTraslados; refreshInterval: number } & ManejadoresComprobante) {
  const { data, error, isLoading, mutate } = useSWR(
    [CLAVE_TRASLADOS, "devueltos"],
    () => fetchComprobantes({ estado: "devuelto", limit: 100 }),
    { refreshInterval },
  );
  const items: Comprobante[] = data?.items ?? [];

  return (
    <Panel
      conRelleno={false}
      titulo="Bandeja de devueltos"
      subtitulo="Comprobantes que un punto devolvió. Corrígelos y reenvíalos, o elimina el traslado."
      conteo={data ? String(data.total) : undefined}
    >
      {error ? (
        <div className="p-4 sm:p-5">
          <ErrorConReintento mensaje={error.message} onReintentar={() => mutate()} />
        </div>
      ) : null}
      {isLoading && !data ? <SkeletonLinea className="m-4 h-10" /> : null}
      {data && items.length === 0 ? <p className="px-5 py-6 text-center text-sm text-muted">Sin devoluciones pendientes por corregir.</p> : null}
      {items.length > 0 ? (
        <table aria-label="Bandeja de devueltos" className={T_TABLA}>
          <thead className={T_THEAD}>
            <tr>
              {COLUMNAS.map((c) => (
                <th key={c} className="px-4 py-3 font-medium">
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className={T_TBODY}>
            {items.map((c) => (
              <tr key={c.id} className={T_TR}>
                <td data-etiqueta="Punto" className={T_TD}>
                  <PuntoCelda c={c} />
                </td>
                <td data-etiqueta="Número" className={`${T_TD} cifra whitespace-nowrap text-ink`}>
                  {c.numero}
                </td>
                <td data-etiqueta="Responsable" className={T_TD}>
                  <ResponsableCelda c={c} />
                </td>
                <td data-etiqueta="Motivo" className={`${T_TD} md:max-w-xs`}>
                  <span className="text-danger-fg">{c.motivo_devolucion ?? "—"}</span>
                </td>
                <td className={T_TD_ACCIONES}>
                  <BotonesComprobante
                    perfil={perfil}
                    comprobante={c}
                    etiquetaEliminar="Eliminar traslado"
                    incluirReenviar
                    {...manejadores}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </Panel>
  );
}
