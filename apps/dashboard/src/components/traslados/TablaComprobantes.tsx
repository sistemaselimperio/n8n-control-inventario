"use client";

// Tabla principal de comprobantes (escritorio) / tarjetas (celular).

import type { Comprobante } from "@/lib/api";
import {
  etiquetaEstado,
  etiquetaMovimiento,
  TONO_ESTADO,
  TONO_MOVIMIENTO,
  type PerfilTraslados,
} from "@/lib/traslados";
import { Pildora } from "@/components/ui";
import {
  BotonesComprobante,
  BTN_INFO,
  T_TABLA,
  T_TBODY,
  T_TD,
  T_TD_ACCIONES,
  T_THEAD,
  T_TR,
  type ManejadoresComprobante,
} from "./compartido";

const COLUMNAS = ["Punto", "Número", "Archivo", "Movimiento", "Estado", "Responsable", "Acciones"];

export function PuntoCelda({ c }: { c: Comprobante }) {
  return (
    <span className="flex flex-col md:items-start max-md:items-end">
      <span className="text-soft">{c.punto_nombre ?? "—"}</span>
      {c.punto_codigo ? <span className="cifra text-xs text-muted">{c.punto_codigo}</span> : null}
    </span>
  );
}

export function ResponsableCelda({ c }: { c: Comprobante }) {
  if (!c.responsable_nombre) return <span className="text-muted">—</span>;
  return (
    <span className="flex flex-col md:items-start max-md:items-end">
      <span className="text-ink">{c.responsable_nombre}</span>
      {c.responsable_cedula ? <span className="text-xs text-muted">C.C. {c.responsable_cedula}</span> : null}
    </span>
  );
}

export function TablaComprobantes({
  items,
  perfil,
  onVerPdf,
  onVerFirma,
  ...manejadores
}: {
  items: Comprobante[];
  perfil: PerfilTraslados;
  onVerPdf: (c: Comprobante) => void;
  onVerFirma: (c: Comprobante) => void;
} & ManejadoresComprobante) {
  return (
    <table aria-label="Comprobantes" className={T_TABLA}>
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
            <td data-etiqueta="Archivo" className={`${T_TD} max-w-[220px]`}>
              {c.pdf_url ? (
                <button
                  type="button"
                  onClick={() => onVerPdf(c)}
                  className="max-w-full truncate text-left text-info underline-offset-2 hover:underline max-md:text-right"
                  title="Ver PDF"
                >
                  {c.archivo_nombre ?? "Ver PDF"}
                </button>
              ) : (
                <span className="text-muted">{c.archivo_nombre ?? "—"}</span>
              )}
            </td>
            <td data-etiqueta="Movimiento" className={T_TD}>
              <Pildora tono={TONO_MOVIMIENTO[c.tipo]}>{etiquetaMovimiento(c.tipo)}</Pildora>
            </td>
            <td data-etiqueta="Estado" className={T_TD}>
              <Pildora tono={TONO_ESTADO[c.estado]}>{etiquetaEstado(c.estado)}</Pildora>
            </td>
            <td data-etiqueta="Responsable" className={T_TD}>
              <span className="flex flex-col gap-1 md:items-start max-md:items-end">
                <ResponsableCelda c={c} />
                {c.estado === "confirmado" && c.firma_url ? (
                  <button type="button" className={BTN_INFO} onClick={() => onVerFirma(c)}>
                    Ver firma
                  </button>
                ) : null}
              </span>
            </td>
            <td className={T_TD_ACCIONES}>
              <BotonesComprobante perfil={perfil} comprobante={c} {...manejadores} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
