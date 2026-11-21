"use client";

// Confirmacion del borrado definitivo de un traslado (irreversible: borra el
// traslado, sus comprobantes y los archivos).

import { useState } from "react";
import { toast } from "sonner";
import { eliminarTraslado } from "@/lib/api";
import { Boton } from "@/components/ui";
import { ModalBase } from "./ModalBase";

export function ModalEliminarTraslado({
  trasladoId,
  numero,
  onCerrar,
  onHecho,
}: {
  trasladoId: string;
  numero: string;
  onCerrar: () => void;
  onHecho: () => void;
}) {
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const eliminar = async () => {
    setError(null);
    setEnviando(true);
    try {
      await eliminarTraslado(trasladoId);
      toast.success("Traslado eliminado");
      onHecho();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo eliminar el traslado");
    } finally {
      setEnviando(false);
    }
  };

  return (
    <ModalBase etiqueta="Eliminar traslado" titulo="Eliminar traslado" onCerrar={onCerrar}>
      <p className="text-sm text-muted">
        Se eliminará el traslado <strong className="text-ink">{numero}</strong> completo, con todos sus comprobantes y
        archivos. Esta acción no se puede deshacer.
      </p>
      {error ? (
        <p role="alert" className="text-sm text-danger-fg">
          {error}
        </p>
      ) : null}
      <div className="flex justify-end gap-2">
        <Boton onClick={onCerrar}>Cancelar</Boton>
        <Boton variante="peligro" onClick={eliminar} disabled={enviando}>
          {enviando ? "Eliminando…" : "Eliminar traslado"}
        </Boton>
      </div>
    </ModalBase>
  );
}
