"use client";

// Correccion y reenvio de un comprobante devuelto: numero, punto y, si hace
// falta, un PDF nuevo. Solo se envia lo que cambio; sin cambios se reenvia tal
// cual (el comprobante vuelve a quedar pendiente).

import { useState } from "react";
import { toast } from "sonner";
import { reenviarComprobante, type Comprobante, type PuntoTraslado } from "@/lib/api";
import { etiquetaPuntoOpcion } from "@/lib/traslados";
import { Boton, CLASE_CAMPO } from "@/components/ui";
import { ModalBase } from "./ModalBase";

export function ModalReenviar({
  comprobante,
  puntos,
  onCerrar,
  onHecho,
}: {
  comprobante: Comprobante;
  puntos: PuntoTraslado[];
  onCerrar: () => void;
  onHecho: () => void;
}) {
  const [numero, setNumero] = useState(comprobante.numero);
  const [puntoId, setPuntoId] = useState(comprobante.punto_id);
  const [archivo, setArchivo] = useState<File | null>(null);
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reenviar = async () => {
    setError(null);
    setEnviando(true);
    try {
      const datos: { numero?: string; punto_id?: string; archivo?: File } = {};
      if (numero.trim() && numero.trim() !== comprobante.numero) datos.numero = numero.trim();
      if (puntoId !== comprobante.punto_id) datos.punto_id = puntoId;
      if (archivo) datos.archivo = archivo;
      await reenviarComprobante(comprobante.id, datos);
      toast.success("Comprobante reenviado");
      onHecho();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo reenviar el comprobante");
    } finally {
      setEnviando(false);
    }
  };

  return (
    <ModalBase etiqueta="Corregir y reenviar" titulo={`Corregir ${comprobante.numero}`} onCerrar={onCerrar}>
      {comprobante.motivo_devolucion ? (
        <p className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger-fg">
          Motivo de la devolución: {comprobante.motivo_devolucion}
        </p>
      ) : null}
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-muted">Número</span>
        <input aria-label="Número" value={numero} onChange={(e) => setNumero(e.target.value)} className={CLASE_CAMPO} />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-muted">Punto</span>
        <select aria-label="Punto" value={puntoId} onChange={(e) => setPuntoId(e.target.value)} className={CLASE_CAMPO}>
          {puntos.map((p) => (
            <option key={p.id} value={p.id}>
              {etiquetaPuntoOpcion(p)}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-muted">Reemplazar PDF (opcional)</span>
        <input
          type="file"
          accept=".pdf,application/pdf"
          aria-label="Reemplazar PDF (opcional)"
          onChange={(e) => setArchivo(e.target.files?.[0] ?? null)}
          className="text-sm text-soft file:mr-3 file:min-h-10 file:cursor-pointer file:rounded-md file:border file:border-line-strong file:bg-surface-2 file:px-3 file:text-sm file:font-medium file:text-ink"
        />
      </label>
      {error ? (
        <p role="alert" className="text-sm text-danger-fg">
          {error}
        </p>
      ) : null}
      <div className="flex justify-end gap-2">
        <Boton onClick={onCerrar}>Cancelar</Boton>
        <Boton variante="primario" onClick={reenviar} disabled={enviando}>
          {enviando ? "Reenviando…" : "Corregir y reenviar"}
        </Boton>
      </div>
    </ModalBase>
  );
}
