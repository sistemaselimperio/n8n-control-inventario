"use client";

// Confirmacion de recepcion de un comprobante por un usuario de punto (o el
// admin): firma obligatoria en el lienzo (se exporta como PNG), observacion
// opcional y quien recibe (receptor del punto u otra persona). El usuario del
// punto es compartido: el responsable que queda es el receptor elegido.

import { useRef, useState } from "react";
import { toast } from "sonner";
import { confirmarComprobante, type Comprobante } from "@/lib/api";
import { Boton, CLASE_CAMPO } from "@/components/ui";
import { quienRecibe, SELECCION_VACIA } from "@/lib/traslados";
import { FirmaCanvas, type ControlFirma } from "./FirmaCanvas";
import { ModalBase } from "./ModalBase";
import { SelectorReceptor } from "./SelectorReceptor";

export function ModalConfirmarComprobante({
  comprobante,
  onCerrar,
  onHecho,
}: {
  comprobante: Comprobante;
  onCerrar: () => void;
  onHecho: () => void;
}) {
  const firmaRef = useRef<ControlFirma>(null);
  const [hayTrazo, setHayTrazo] = useState(false);
  const [observacion, setObservacion] = useState("");
  const [receptor, setReceptor] = useState(SELECCION_VACIA);
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const quien = quienRecibe(receptor);

  const confirmar = async () => {
    if (!quien) return;
    setError(null);
    setEnviando(true);
    try {
      const png = await firmaRef.current?.exportar();
      if (!png) {
        setError("Dibuja tu firma antes de confirmar.");
        return;
      }
      await confirmarComprobante(comprobante.id, png, observacion.trim() || undefined, quien);
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
      <SelectorReceptor puntoId={comprobante.punto_id} valor={receptor} onCambio={setReceptor} />

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

      {error ? (
        <p role="alert" className="text-sm text-danger-fg">
          {error}
        </p>
      ) : null}
      <div className="flex justify-end gap-2">
        <Boton onClick={onCerrar}>Cancelar</Boton>
        <Boton variante="primario" onClick={confirmar} disabled={!hayTrazo || !quien || enviando}>
          {enviando ? "Confirmando…" : "Confirmar recepción"}
        </Boton>
      </div>
    </ModalBase>
  );
}
