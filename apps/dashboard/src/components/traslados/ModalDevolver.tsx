"use client";

// Devolucion de un comprobante con motivo obligatorio (maximo 500 caracteres).

import { useState } from "react";
import { toast } from "sonner";
import { devolverComprobante, type Comprobante } from "@/lib/api";
import { Boton, CLASE_CAMPO } from "@/components/ui";
import { ModalBase } from "./ModalBase";

export function ModalDevolver({
  comprobante,
  onCerrar,
  onHecho,
}: {
  comprobante: Comprobante;
  onCerrar: () => void;
  onHecho: () => void;
}) {
  const [motivo, setMotivo] = useState("");
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const devolver = async () => {
    setError(null);
    setEnviando(true);
    try {
      await devolverComprobante(comprobante.id, motivo.trim());
      toast.success("Comprobante devuelto");
      onHecho();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo devolver el comprobante");
    } finally {
      setEnviando(false);
    }
  };

  return (
    <ModalBase etiqueta="Devolver comprobante" titulo={`Devolver ${comprobante.numero}`} onCerrar={onCerrar}>
      <p className="text-sm text-muted">
        La encargada recibirá el comprobante en la bandeja de devueltos para corregirlo y reenviarlo.
      </p>
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-muted">Motivo de la devolución (obligatorio)</span>
        <textarea
          value={motivo}
          onChange={(e) => setMotivo(e.target.value)}
          rows={3}
          maxLength={500}
          autoFocus
          className={`${CLASE_CAMPO} py-2`}
        />
        <span className="self-end text-xs tabular-nums text-subtle">{motivo.length}/500</span>
      </label>
      {error ? (
        <p role="alert" className="text-sm text-danger-fg">
          {error}
        </p>
      ) : null}
      <div className="flex justify-end gap-2">
        <Boton onClick={onCerrar}>Cancelar</Boton>
        <Boton variante="peligro" onClick={devolver} disabled={!motivo.trim() || enviando}>
          {enviando ? "Devolviendo…" : "Devolver"}
        </Boton>
      </div>
    </ModalBase>
  );
}
