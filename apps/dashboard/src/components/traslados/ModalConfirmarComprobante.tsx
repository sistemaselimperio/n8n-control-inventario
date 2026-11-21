"use client";

// Confirmacion de recepcion de un comprobante por un usuario de punto (o el
// admin): firma obligatoria en el lienzo (se exporta como PNG), observacion
// opcional. Firma quien tiene la sesion abierta, con su nombre y cedula; si la
// cuenta no tiene cedula no se puede firmar y se pide al administrador.

import { useRef, useState } from "react";
import { toast } from "sonner";
import { confirmarComprobante, type Comprobante } from "@/lib/api";
import { Boton, CLASE_CAMPO } from "@/components/ui";
import { FirmaCanvas, type ControlFirma } from "./FirmaCanvas";
import { ModalBase } from "./ModalBase";

export function ModalConfirmarComprobante({
  comprobante,
  usuario,
  onCerrar,
  onHecho,
}: {
  comprobante: Comprobante;
  usuario: { nombre: string; cedula?: string | null };
  onCerrar: () => void;
  onHecho: () => void;
}) {
  const firmaRef = useRef<ControlFirma>(null);
  const [hayTrazo, setHayTrazo] = useState(false);
  const [observacion, setObservacion] = useState("");
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sinCedula = !usuario.cedula;

  const confirmar = async () => {
    setError(null);
    setEnviando(true);
    try {
      const png = await firmaRef.current?.exportar();
      if (!png) {
        setError("Dibuja tu firma antes de confirmar.");
        return;
      }
      await confirmarComprobante(comprobante.id, png, observacion.trim() || undefined);
      toast.success("Recepción confirmada");
      onHecho();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo confirmar la recepción");
    } finally {
      setEnviando(false);
    }
  };

  return (
    <ModalBase etiqueta="Confirmar recepción" titulo={`Confirmar ${comprobante.numero}`} onCerrar={onCerrar}>
      <div className="flex flex-col gap-0.5 rounded-md border border-line bg-surface-2 px-3 py-2">
        <span className="text-xs font-medium text-muted">Firma</span>
        <strong className="text-sm font-semibold text-ink">{usuario.nombre}</strong>
        <p className="text-sm text-soft">{sinCedula ? "Sin cédula registrada" : `C.C. ${usuario.cedula}`}</p>
      </div>

      {sinCedula ? (
        <p role="alert" className="rounded-md border border-warn/40 bg-warn-fill/20 px-3 py-2 text-sm text-warn">
          Tu usuario no tiene cédula registrada, por eso no puedes firmar. Solicita al administrador que la agregue en
          tu cuenta.
        </p>
      ) : (
        <>
          <FirmaCanvas ref={firmaRef} onCambio={setHayTrazo} />
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted">Observación (opcional)</span>
            <textarea
              value={observacion}
              onChange={(e) => setObservacion(e.target.value)}
              rows={2}
              maxLength={500}
              className={`${CLASE_CAMPO} py-2`}
            />
          </label>
        </>
      )}

      {error ? (
        <p role="alert" className="text-sm text-danger-fg">
          {error}
        </p>
      ) : null}
      <div className="flex justify-end gap-2">
        <Boton onClick={onCerrar}>Cancelar</Boton>
        <Boton variante="primario" onClick={confirmar} disabled={sinCedula || !hayTrazo || enviando}>
          {enviando ? "Confirmando…" : "Confirmar recepción"}
        </Boton>
      </div>
    </ModalBase>
  );
}
