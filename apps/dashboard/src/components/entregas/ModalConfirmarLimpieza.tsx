"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Boton } from "@/components/ui";

const PALABRA_CONFIRMACION_LIMPIEZA = "ELIMINAR TODO";

// "Zona de peligro" -- borra TODAS las entregas y logs. Mismo patron visual
// que los otros modales (overlay fijo + tarjeta centrada), pero exige
// escribir una palabra exacta para habilitar el boton de confirmar.
export function ModalConfirmarLimpieza({
  onConfirmar,
  onCerrar,
}: {
  onConfirmar: () => Promise<void>;
  onCerrar: () => void;
}) {
  const [palabra, setPalabra] = useState("");
  const [limpiando, setLimpiando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const habilitado = palabra.trim() === PALABRA_CONFIRMACION_LIMPIEZA;

  const confirmar = async () => {
    setLimpiando(true);
    setError(null);
    try {
      await onConfirmar();
    } catch (err) {
      const mensaje = err instanceof Error ? err.message : "Error al limpiar";
      // El error se mantiene visible DENTRO del modal (para que no se pierda
      // mientras sigue abierto) y ademas se dispara un toast, en linea con
      // el resto del feedback de esta pantalla.
      setError(mensaje);
      toast.error(mensaje);
      setLimpiando(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-brand-night/50 px-4" onClick={onCerrar}>
      <div
        className="flex w-full max-w-md flex-col gap-4 rounded-lg border border-danger/40 bg-surface p-5"
        onClick={(ev) => ev.stopPropagation()}
      >
        <h3 className="text-lg font-semibold text-danger-fg">Eliminar todos los productos</h3>
        <p className="text-sm text-muted">
          Esto borra permanentemente todas las entregas, sus productos y todo el historial de logs. No
          se puede deshacer.
        </p>
        <label className="flex flex-col gap-1 text-xs text-muted">
          Escribe &quot;{PALABRA_CONFIRMACION_LIMPIEZA}&quot; para confirmar
          <input
            value={palabra}
            onChange={(e) => setPalabra(e.target.value)}
            disabled={limpiando}
            className="rounded-lg border border-line bg-page px-2 py-1.5 text-sm text-ink disabled:opacity-40"
          />
        </label>
        {error ? <p className="text-xs text-danger-fg">{error}</p> : null}
        <div className="flex justify-end gap-2">
          <Boton onClick={onCerrar} disabled={limpiando}>
            Cancelar
          </Boton>
          <Boton variante="peligro" onClick={confirmar} disabled={!habilitado || limpiando}>
            {limpiando ? "Eliminando..." : "Eliminar todo"}
          </Boton>
        </div>
      </div>
    </div>
  );
}
