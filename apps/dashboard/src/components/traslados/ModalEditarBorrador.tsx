"use client";

// Edicion de un traslado en borrador: lo que el sistema leyo del PDF se
// corrige a mano (numero, origen, destino, fecha, concepto). Un campo vacio se
// envia como null (limpia el valor).

import { useState } from "react";
import { toast } from "sonner";
import { actualizarTraslado, type PuntoTraslado, type Traslado } from "@/lib/api";
import { etiquetaPuntoOpcion } from "@/lib/traslados";
import { Boton, CLASE_CAMPO } from "@/components/ui";
import { Dato, ModalBase } from "./ModalBase";

const SelectorPunto = ({
  etiqueta,
  valor,
  puntos,
  onCambio,
}: {
  etiqueta: string;
  valor: string;
  puntos: PuntoTraslado[];
  onCambio: (v: string) => void;
}) => (
  <label className="flex flex-col gap-1">
    <span className="text-xs font-medium text-muted">{etiqueta}</span>
    <select aria-label={etiqueta} value={valor} onChange={(e) => onCambio(e.target.value)} className={CLASE_CAMPO}>
      <option value="">Sin asignar</option>
      {puntos.map((p) => (
        <option key={p.id} value={p.id}>
          {etiquetaPuntoOpcion(p)}
        </option>
      ))}
    </select>
  </label>
);

export function ModalEditarBorrador({
  traslado,
  puntos,
  onCerrar,
  onHecho,
}: {
  traslado: Traslado;
  puntos: PuntoTraslado[];
  onCerrar: () => void;
  onHecho: () => void;
}) {
  const [numero, setNumero] = useState(traslado.numero ?? "");
  const [origen, setOrigen] = useState(traslado.origen_punto_id ?? "");
  const [destino, setDestino] = useState(traslado.destino_punto_id ?? "");
  const [fecha, setFecha] = useState(traslado.fecha?.slice(0, 10) ?? "");
  const [concepto, setConcepto] = useState(traslado.concepto ?? "");
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const guardar = async () => {
    setError(null);
    setEnviando(true);
    try {
      await actualizarTraslado(traslado.id, {
        numero: numero.trim() || null,
        origen_punto_id: origen || null,
        destino_punto_id: destino || null,
        fecha: fecha || null,
        concepto: concepto.trim() || null,
      });
      toast.success("Borrador actualizado");
      onHecho();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo guardar el borrador");
    } finally {
      setEnviando(false);
    }
  };

  return (
    <ModalBase etiqueta="Editar borrador" titulo={`Editar borrador${traslado.archivo_nombre ? ` · ${traslado.archivo_nombre}` : ""}`} onCerrar={onCerrar}>
      {traslado.origen_texto || traslado.destino_texto ? (
        <div className="grid grid-cols-1 gap-3 rounded-md border border-line bg-surface-2 px-3 py-2 sm:grid-cols-2">
          <Dato etiqueta="Leído en el PDF: origen">{traslado.origen_texto ?? "—"}</Dato>
          <Dato etiqueta="Leído en el PDF: destino">{traslado.destino_texto ?? "—"}</Dato>
        </div>
      ) : null}
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-muted">Número</span>
        <input aria-label="Número" value={numero} onChange={(e) => setNumero(e.target.value)} className={CLASE_CAMPO} />
      </label>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <SelectorPunto etiqueta="Origen" valor={origen} puntos={puntos} onCambio={setOrigen} />
        <SelectorPunto etiqueta="Destino" valor={destino} puntos={puntos} onCambio={setDestino} />
      </div>
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-muted">Fecha</span>
        <input
          type="date"
          aria-label="Fecha"
          value={fecha}
          onChange={(e) => setFecha(e.target.value)}
          className={`${CLASE_CAMPO} [color-scheme:light]`}
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-muted">Concepto</span>
        <textarea aria-label="Concepto" value={concepto} onChange={(e) => setConcepto(e.target.value)} rows={2} className={`${CLASE_CAMPO} py-2`} />
      </label>
      {error ? (
        <p role="alert" className="text-sm text-danger-fg">
          {error}
        </p>
      ) : null}
      <div className="flex justify-end gap-2">
        <Boton onClick={onCerrar}>Cancelar</Boton>
        <Boton variante="primario" onClick={guardar} disabled={enviando}>
          {enviando ? "Guardando…" : "Guardar cambios"}
        </Boton>
      </div>
    </ModalBase>
  );
}
