"use client";

// Cascaron comun de los modales de traslados: fondo oscuro, cierre con
// Escape / clic afuera / boton de cerrar. `etiqueta` es el nombre accesible
// del dialogo; `titulo` puede ser un nodo (ej. un Folio grande).

import { useEffect, type ReactNode } from "react";
import { Icono } from "@/components/ui";

export function ModalBase({
  etiqueta,
  titulo,
  pildora,
  ancho = "max-w-2xl",
  onCerrar,
  children,
}: {
  etiqueta: string;
  titulo: ReactNode;
  pildora?: ReactNode;
  ancho?: string;
  onCerrar: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    const alPresionarTecla = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") onCerrar();
    };
    document.addEventListener("keydown", alPresionarTecla);
    return () => document.removeEventListener("keydown", alPresionarTecla);
  }, [onCerrar]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-brand-night/50 px-4"
      onClick={onCerrar}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={etiqueta}
        className={`flex max-h-[85vh] w-full ${ancho} flex-col gap-5 overflow-y-auto rounded-lg border border-line bg-surface p-5`}
        onClick={(ev) => ev.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-1.5">
            <h3 className="text-lg font-semibold text-ink">{titulo}</h3>
            {pildora ? <div className="flex items-center gap-2">{pildora}</div> : null}
          </div>
          <button
            onClick={onCerrar}
            className="-m-2 flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-muted transition-colors duration-150 hover:bg-surface-2 hover:text-ink"
            aria-label="Cerrar"
          >
            <Icono nombre="cerrar" className="h-5 w-5" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

// Par etiqueta + valor de un dato del traslado.
export function Dato({ etiqueta, children }: { etiqueta: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs font-medium text-muted">{etiqueta}</span>
      <span className="text-sm text-ink">{children}</span>
    </div>
  );
}
