"use client";

// Receptores de traslados: las personas que reciben en cada punto. Cada punto
// entra al dashboard con un usuario compartido; al confirmar o devolver un
// comprobante se elige quien recibe de esta lista. Eliminar borra de verdad
// (los comprobantes ya firmados conservan nombre y cedula); desactivar solo
// lo saca de la lista del modal.

import { useState } from "react";
import useSWR from "swr";
import {
  actualizarReceptor,
  crearReceptor,
  eliminarReceptor,
  fetchPuntosAdmin,
  fetchReceptoresAdmin,
  type PuntoAdmin,
  type ReceptorAdmin,
} from "@/lib/api";
import { ErrorConReintento, Panel } from "@/components/ui";
import { CEDULA_FIRMA_VALIDA, normalizarCedula } from "@/lib/traslados";
import {
  INPUT,
  BOTON_PRIMARIO,
  BOTON_LINK,
  BOTON_CANCELAR,
  AccionEliminar,
  Campo,
  Insignia,
  ejecutar,
  Cargando,
  Lista,
  FILA,
} from "./compartido";

const limpiarNombre = (v: string) => v.trim().replace(/\s+/g, " ");

function FilaReceptor({
  r,
  puntos,
  onCambio,
}: {
  r: ReceptorAdmin;
  puntos: PuntoAdmin[];
  onCambio: () => void;
}) {
  const [editando, setEditando] = useState(false);
  const [nombre, setNombre] = useState(r.nombre);
  const [cedula, setCedula] = useState(r.cedula);
  const [puntoId, setPuntoId] = useState(r.punto_id);

  const cedulaLimpia = normalizarCedula(cedula);
  const valido = limpiarNombre(nombre) !== "" && CEDULA_FIRMA_VALIDA.test(cedulaLimpia);

  const guardar = async () => {
    const cambios: { nombre?: string; cedula?: string; punto_id?: string } = {};
    if (limpiarNombre(nombre) !== r.nombre) cambios.nombre = limpiarNombre(nombre);
    if (cedulaLimpia !== r.cedula) cambios.cedula = cedulaLimpia;
    if (puntoId !== r.punto_id) cambios.punto_id = puntoId;
    if (await ejecutar(() => actualizarReceptor(r.id, cambios), "Receptor actualizado")) {
      setEditando(false);
      onCambio();
    }
  };

  if (editando) {
    return (
      <li className={FILA}>
        <input aria-label="Nombre del receptor" value={nombre} onChange={(e) => setNombre(e.target.value)} maxLength={120} className={`${INPUT} min-w-[160px] flex-1`} />
        <input aria-label="Cédula del receptor" value={cedula} onChange={(e) => setCedula(e.target.value)} inputMode="numeric" className={`${INPUT} w-36`} />
        <select aria-label="Punto del receptor" value={puntoId} onChange={(e) => setPuntoId(e.target.value)} className={`${INPUT} min-w-[160px]`}>
          {puntos
            .filter((p) => p.activo || p.id === r.punto_id)
            .map((p) => (
              <option key={p.id} value={p.id}>
                {p.nombre}
              </option>
            ))}
        </select>
        <button className={BOTON_LINK} onClick={guardar} disabled={!valido}>
          Guardar
        </button>
        <button className={BOTON_CANCELAR} onClick={() => setEditando(false)}>
          Cancelar
        </button>
      </li>
    );
  }

  return (
    <li className={FILA}>
      <span className="min-w-[160px] flex-1 font-medium text-ink">{r.nombre}</span>
      <span className="cifra text-muted">{`C.C. ${r.cedula}`}</span>
      <Insignia activo={r.activo} />
      <button
        className={BOTON_LINK}
        onClick={() => {
          setNombre(r.nombre);
          setCedula(r.cedula);
          setPuntoId(r.punto_id);
          setEditando(true);
        }}
      >
        Editar
      </button>
      <button
        className={BOTON_LINK}
        onClick={async () => {
          if (
            await ejecutar(
              () => actualizarReceptor(r.id, { activo: !r.activo }),
              r.activo ? "Receptor desactivado" : "Receptor activado"
            )
          )
            onCambio();
        }}
      >
        {r.activo ? "Desactivar" : "Activar"}
      </button>
      <AccionEliminar
        nombre={r.nombre}
        exito="Receptor eliminado"
        detalle="Los comprobantes que ya firmó conservan su nombre y cédula."
        onEliminar={() => eliminarReceptor(r.id)}
        onHecho={onCambio}
      />
    </li>
  );
}

export function SeccionReceptores() {
  const [filtro, setFiltro] = useState("");
  const puntos = useSWR(["creador-puntos-receptores"], () => fetchPuntosAdmin());
  const { data, error, isLoading, mutate } = useSWR(["creador-receptores", filtro], () =>
    fetchReceptoresAdmin(filtro || undefined)
  );
  const [puntoId, setPuntoId] = useState("");
  const [nombre, setNombre] = useState("");
  const [cedula, setCedula] = useState("");
  const [enviando, setEnviando] = useState(false);

  const listaPuntos = puntos.data ?? [];
  const cedulaLimpia = normalizarCedula(cedula);
  const valido = puntoId !== "" && limpiarNombre(nombre) !== "" && CEDULA_FIRMA_VALIDA.test(cedulaLimpia);

  const agregar = async () => {
    setEnviando(true);
    const ok = await ejecutar(
      () => crearReceptor({ punto_id: puntoId, nombre: limpiarNombre(nombre), cedula: cedulaLimpia }),
      "Receptor agregado"
    );
    setEnviando(false);
    if (ok) {
      setNombre("");
      setCedula("");
      mutate();
    }
  };

  // Agrupa por punto conservando el orden del backend (por nombre de punto).
  const grupos: { puntoId: string; nombre: string; items: ReceptorAdmin[] }[] = [];
  for (const r of data ?? []) {
    const ultimo = grupos[grupos.length - 1];
    if (ultimo && ultimo.puntoId === r.punto_id) ultimo.items.push(r);
    else grupos.push({ puntoId: r.punto_id, nombre: r.punto_nombre, items: [r] });
  }

  return (
    <Panel
      conRelleno={false}
      titulo="Receptores de traslados"
      subtitulo="Personas que reciben en cada punto. Al confirmar o devolver un comprobante, el punto elige quién recibe de esta lista."
      conteo={data ? String(data.length) : undefined}
    >
      <div role="group" aria-label="Agregar receptor" className="flex flex-wrap items-end gap-3 border-b border-line p-4 sm:p-5">
        <Campo etiqueta="Punto" className="min-w-[200px]">
          <select value={puntoId} onChange={(e) => setPuntoId(e.target.value)} className={INPUT}>
            <option value="">Selecciona un punto</option>
            {listaPuntos
              .filter((p) => p.activo)
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.nombre}
                </option>
              ))}
          </select>
        </Campo>
        <Campo etiqueta="Nombre" className="min-w-[180px] flex-1">
          <input value={nombre} onChange={(e) => setNombre(e.target.value)} maxLength={120} className={INPUT} />
        </Campo>
        <Campo etiqueta="Cédula" className="w-40">
          <input value={cedula} onChange={(e) => setCedula(e.target.value)} inputMode="numeric" className={INPUT} />
        </Campo>
        <button onClick={agregar} disabled={enviando || !valido} className={BOTON_PRIMARIO}>
          Agregar receptor
        </button>
      </div>

      <div className="flex flex-wrap items-end gap-3 border-b border-line px-4 py-3 sm:px-5">
        <Campo etiqueta="Filtrar por punto" className="min-w-[200px]">
          <select value={filtro} onChange={(e) => setFiltro(e.target.value)} className={INPUT}>
            <option value="">Todos los puntos</option>
            {listaPuntos.map((p) => (
              <option key={p.id} value={p.id}>
                {p.nombre}
              </option>
            ))}
          </select>
        </Campo>
      </div>

      {error ? (
        <div className="p-4 sm:p-5">
          <ErrorConReintento mensaje={error.message} onReintentar={() => mutate()} />
        </div>
      ) : null}
      {isLoading || !data ? (
        error ? null : <Cargando />
      ) : (
        <Lista vacio={data.length === 0}>
          {grupos.map((g) => (
            <li key={g.puntoId} className="list-none">
              <h4 className="bg-surface-2 px-4 py-2 text-xs font-semibold text-muted sm:px-5">{g.nombre}</h4>
              <ul className="flex flex-col divide-y divide-line">
                {g.items.map((r) => (
                  <FilaReceptor key={r.id} r={r} puntos={listaPuntos} onCambio={() => mutate()} />
                ))}
              </ul>
            </li>
          ))}
        </Lista>
      )}
    </Panel>
  );
}
