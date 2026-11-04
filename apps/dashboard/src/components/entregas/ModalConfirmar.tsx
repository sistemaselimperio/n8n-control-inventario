"use client";

import { Boton } from "@/components/ui";

// Modal de confirmacion generico -- mismo patron visual que ModalConfirmarLimpieza
// (overlay fijo + tarjeta centrada), para acciones destructivas puntuales que
// no ameritan el flujo de palabra exacta de la limpieza total.
export function ModalConfirmar({
  titulo,
  mensaje,
  textoConfirmar = "Confirmar",
  onConfirmar,
  onCerrar,
}: {
  titulo: string;
  mensaje: string;
  textoConfirmar?: string;
  onConfirmar: () => void;
  onCerrar: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-brand-night/50 px-4" onClick={onCerrar}>
      <div
        className="flex w-full max-w-md flex-col gap-4 rounded-lg border border-line bg-surface p-5"
        onClick={(ev) => ev.stopPropagation()}
      >
        <h3 className="text-lg font-semibold text-ink">{titulo}</h3>
        <p className="text-sm text-muted">{mensaje}</p>
        <div className="flex justify-end gap-2">
          <Boton onClick={onCerrar}>Cancelar</Boton>
          <Boton variante="peligro" onClick={onConfirmar}>
            {textoConfirmar}
          </Boton>
        </div>
      </div>
    </div>
  );
}
