"use client";

// Piezas compartidas de las listas de traslados: clases de la tabla que en
// celular se vuelve una pila de tarjetas (el mismo DOM, sin duplicar filas) y
// los botones de accion de cada comprobante segun el perfil.

import type { Comprobante } from "@/lib/api";
import { accionesComprobante, type PerfilTraslados } from "@/lib/traslados";

// Tabla de escritorio / tarjetas en celular. Cada <td> lleva data-etiqueta,
// que en celular se pinta como rotulo a la izquierda del valor.
export const T_TABLA = "w-full text-left text-sm max-md:block";
export const T_THEAD = "border-b border-line text-xs text-muted max-md:hidden";
export const T_TBODY = "md:divide-y md:divide-line max-md:flex max-md:flex-col max-md:gap-3 max-md:p-3";
export const T_TR =
  "md:odd:bg-surface md:even:bg-page/60 max-md:flex max-md:flex-col max-md:gap-2 max-md:rounded-lg max-md:border max-md:border-line max-md:bg-surface max-md:p-3";
export const T_TD =
  "md:px-4 md:py-2.5 md:align-middle max-md:flex max-md:items-start max-md:justify-between max-md:gap-3 max-md:text-right before:text-left before:text-xs before:font-medium before:text-muted before:content-[attr(data-etiqueta)] md:before:content-none";
export const T_TD_ACCIONES = "md:px-4 md:py-2.5 md:align-middle max-md:flex max-md:flex-wrap max-md:justify-end max-md:gap-2";

const BTN = "inline-flex min-h-11 cursor-pointer items-center justify-center rounded-md border px-2.5 text-xs font-medium transition-colors duration-150 disabled:opacity-50 md:min-h-9";
export const BTN_NEUTRO = `${BTN} border-line-strong text-soft hover:bg-surface-2`;
export const BTN_INFO = `${BTN} border-info/40 text-info hover:bg-info/10`;
export const BTN_PRIMARIO = `${BTN} border-ok bg-ok text-ok-on hover:bg-ok-hover`;
export const BTN_PELIGRO = `${BTN} border-danger/40 text-danger-fg hover:bg-danger/10`;

export interface ManejadoresComprobante {
  onHistorial: (c: Comprobante) => void;
  onConfirmar: (c: Comprobante) => void;
  onDevolver: (c: Comprobante) => void;
  onReenviar: (c: Comprobante) => void;
  onEliminar: (c: Comprobante) => void;
}

// Botones de un comprobante: solo los que su perfil puede usar.
export function BotonesComprobante({
  perfil,
  comprobante,
  etiquetaEliminar = "Eliminar",
  incluirReenviar = false,
  ...m
}: {
  perfil: PerfilTraslados;
  comprobante: Comprobante;
  etiquetaEliminar?: string;
  incluirReenviar?: boolean;
} & ManejadoresComprobante) {
  const a = accionesComprobante(perfil, comprobante);
  return (
    <>
      {a.historial ? (
        <button type="button" className={BTN_NEUTRO} onClick={() => m.onHistorial(comprobante)}>
          Historial
        </button>
      ) : null}
      {a.confirmar ? (
        <button type="button" className={BTN_PRIMARIO} onClick={() => m.onConfirmar(comprobante)}>
          Confirmar
        </button>
      ) : null}
      {a.devolver ? (
        <button type="button" className={BTN_PELIGRO} onClick={() => m.onDevolver(comprobante)}>
          Devolver
        </button>
      ) : null}
      {a.reenviar && incluirReenviar ? (
        <button type="button" className={BTN_INFO} onClick={() => m.onReenviar(comprobante)}>
          Corregir y reenviar
        </button>
      ) : null}
      {a.eliminar ? (
        <button type="button" className={BTN_PELIGRO} onClick={() => m.onEliminar(comprobante)}>
          {etiquetaEliminar}
        </button>
      ) : null}
    </>
  );
}
