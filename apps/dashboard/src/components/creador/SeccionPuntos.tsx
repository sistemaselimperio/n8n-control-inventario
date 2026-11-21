"use client";

import { useState } from "react";
import useSWR from "swr";
import {
  actualizarPunto,
  actualizarUsuarioPunto,
  crearPunto,
  crearUsuarioPunto,
  eliminarPunto,
  eliminarUsuarioPunto,
  fetchPuntosAdmin,
  fetchUsuariosPuntoAdmin,
  resetearPinUsuarioPunto,
} from "@/lib/api";
import { ErrorConReintento, Panel, Pildora } from "@/components/ui";
import {
  INPUT,
  BOTON_PRIMARIO,
  BOTON_LINK,
  BOTON_CANCELAR,
  AccionEliminar,
  PIN_VALIDO,
  Campo,
  Insignia,
  ejecutar,
  CambiarPin,
  Cargando,
  Lista,
  FILA,
} from "./compartido";

function UsuariosDePunto({ puntoId }: { puntoId: string }) {
  const { data, error, isLoading, mutate } = useSWR(["creador-usuarios-punto", puntoId], () =>
    fetchUsuariosPuntoAdmin(puntoId)
  );
  const [nombre, setNombre] = useState("");
  const [pin, setPin] = useState("");
  const [enviando, setEnviando] = useState(false);
  const [editandoId, setEditandoId] = useState<string | null>(null);
  const [nombreEdit, setNombreEdit] = useState("");

  const agregar = async () => {
    setEnviando(true);
    const ok = await ejecutar(() => crearUsuarioPunto(puntoId, { nombre: nombre.trim(), pin }), "Usuario creado");
    setEnviando(false);
    if (ok) {
      setNombre("");
      setPin("");
      mutate();
    }
  };

  return (
    <div className="flex flex-col border-t border-line bg-surface-2">
      <div className="flex flex-wrap items-end gap-3 border-b border-line p-4 sm:p-5">
        <Campo etiqueta="Nombre del usuario" className="min-w-[160px] flex-1">
          <input value={nombre} onChange={(e) => setNombre(e.target.value)} className={INPUT} />
        </Campo>
        <Campo etiqueta="PIN (4 a 6 dígitos)" className="w-32">
          <input
            type="password"
            inputMode="numeric"
            maxLength={6}
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))}
           
            className={INPUT}
          />
        </Campo>
        <button onClick={agregar} disabled={enviando || !nombre.trim() || !PIN_VALIDO.test(pin)} className={BOTON_PRIMARIO}>
          {enviando ? "Creando…" : "Crear usuario"}
        </button>
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
          {data.map((usuario) => (
            <li key={usuario.id} className={FILA}>
              {editandoId === usuario.id ? (
                <>
                  <input aria-label="Nombre" value={nombreEdit} onChange={(e) => setNombreEdit(e.target.value)} className={`${INPUT} min-w-[140px] flex-1`} />
                  <button
                    className={BOTON_LINK}
                    disabled={!nombreEdit.trim()}
                    onClick={async () => {
                      if (await ejecutar(() => actualizarUsuarioPunto(usuario.id, { nombre: nombreEdit.trim() }), "Usuario actualizado")) {
                        setEditandoId(null);
                        mutate();
                      }
                    }}
                  >
                    Guardar
                  </button>
                  <button className={BOTON_CANCELAR} onClick={() => setEditandoId(null)}>
                    Cancelar
                  </button>
                </>
              ) : (
                <>
                  <span className="min-w-[140px] flex-1 text-ink">{usuario.nombre}</span>
                  <Insignia activo={usuario.estado === "activo"} />
                  <button
                    className={BOTON_LINK}
                   
                    onClick={() => {
                      setEditandoId(usuario.id);
                      setNombreEdit(usuario.nombre);
                    }}
                  >
                    Editar
                  </button>
                  <CambiarPin onGuardar={(p) => resetearPinUsuarioPunto(usuario.id, p)} />
                  <button
                    className={BOTON_LINK}
                   
                    onClick={async () => {
                      const nuevo = usuario.estado === "activo" ? "inactivo" : "activo";
                      if (await ejecutar(() => actualizarUsuarioPunto(usuario.id, { estado: nuevo }), nuevo === "activo" ? "Usuario activado" : "Usuario desactivado")) mutate();
                    }}
                  >
                    {usuario.estado === "activo" ? "Desactivar" : "Activar"}
                  </button>
                  <AccionEliminar
                    nombre={usuario.nombre}
                    exito="Usuario eliminado"
                    onEliminar={() => eliminarUsuarioPunto(usuario.id)}
                    onDesactivar={
                      usuario.estado === "activo" ? () => actualizarUsuarioPunto(usuario.id, { estado: "inactivo" }) : undefined
                    }
                    exitoDesactivar="Usuario desactivado"
                    onHecho={() => mutate()}
                  />
                </>
              )}
            </li>
          ))}
        </Lista>
      )}
    </div>
  );
}

const ETIQUETA_ALIAS = "Otros nombres (separados por coma)";

// "Principal, Bodega Matriz" -> ["Principal", "Bodega Matriz"] (sin vacios).
const aListaAlias = (texto: string) =>
  texto
    .split(",")
    .map((a) => a.trim())
    .filter(Boolean);

export function SeccionPuntos() {
  const { data, error, isLoading, mutate } = useSWR(["creador-puntos"], () => fetchPuntosAdmin());
  const [nombre, setNombre] = useState("");
  const [aliasTexto, setAliasTexto] = useState("");
  const [enviando, setEnviando] = useState(false);
  const [editandoId, setEditandoId] = useState<string | null>(null);
  const [nombreEdit, setNombreEdit] = useState("");
  const [aliasEdit, setAliasEdit] = useState("");
  const [abiertoId, setAbiertoId] = useState<string | null>(null);

  const agregar = async () => {
    setEnviando(true);
    const ok = await ejecutar(() => crearPunto(nombre.trim(), aListaAlias(aliasTexto)), "Punto creado");
    setEnviando(false);
    if (ok) {
      setNombre("");
      setAliasTexto("");
      mutate();
    }
  };

  return (
    <Panel conRelleno={false} titulo="Puntos y usuarios de punto" subtitulo="Puntos de destino de los traslados y quienes firman en cada uno. Un punto interno es una bodega propia." conteo={data ? String(data.length) : undefined}>
      <div className="flex flex-wrap items-end gap-3 border-b border-line p-4 sm:p-5">
        <Campo etiqueta="Nombre del punto" className="min-w-[200px] flex-1">
          <input value={nombre} onChange={(e) => setNombre(e.target.value)} className={INPUT} />
        </Campo>
        <Campo etiqueta={ETIQUETA_ALIAS} className="min-w-[200px] flex-1">
          <input value={aliasTexto} onChange={(e) => setAliasTexto(e.target.value)} className={INPUT} />
        </Campo>
        <button onClick={agregar} disabled={enviando || !nombre.trim()} className={BOTON_PRIMARIO}>
          {enviando ? "Creando…" : "Crear punto"}
        </button>
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
          {data.map((punto) => (
            <li key={punto.id} className="flex flex-col">
              <div className={FILA}>
                {editandoId === punto.id ? (
                  <>
                    <input aria-label="Nombre" value={nombreEdit} onChange={(e) => setNombreEdit(e.target.value)} className={`${INPUT} min-w-[160px] flex-1`} />
                    <input
                      aria-label={ETIQUETA_ALIAS}
                      placeholder="Otros nombres, separados por coma"
                      value={aliasEdit}
                      onChange={(e) => setAliasEdit(e.target.value)}
                      className={`${INPUT} min-w-[200px] flex-1`}
                    />
                    <button
                      className={BOTON_LINK}
                      disabled={!nombreEdit.trim()}
                      onClick={async () => {
                        if (
                          await ejecutar(
                            () => actualizarPunto(punto.id, { nombre: nombreEdit.trim(), alias: aListaAlias(aliasEdit) }),
                            "Punto actualizado",
                          )
                        ) {
                          setEditandoId(null);
                          mutate();
                        }
                      }}
                    >
                      Guardar
                    </button>
                    <button className={BOTON_CANCELAR} onClick={() => setEditandoId(null)}>
                      Cancelar
                    </button>
                  </>
                ) : (
                  <>
                    <span className="min-w-[160px] flex-1 text-ink">{punto.nombre}</span>
                    <Insignia activo={punto.activo} />
                    {punto.es_interna ? <Pildora tono="info">Interna</Pildora> : null}
                    <button
                      role="switch"
                      aria-checked={punto.es_interna}
                      aria-label={`Interna: ${punto.nombre}`}
                      className={BOTON_LINK}
                      onClick={async () => {
                        const nuevo = !punto.es_interna;
                        if (
                          await ejecutar(
                            () => actualizarPunto(punto.id, { es_interna: nuevo }),
                            nuevo ? "Punto marcado como interno" : "Punto ya no es interno",
                          )
                        )
                          mutate();
                      }}
                    >
                      {punto.es_interna ? "Quitar interna" : "Marcar interna"}
                    </button>
                    <button className={BOTON_LINK} onClick={() => setAbiertoId(abiertoId === punto.id ? null : punto.id)}>
                      {abiertoId === punto.id ? "Ocultar usuarios" : "Usuarios"}
                    </button>
                    <button
                      className={BOTON_LINK}
                     
                      onClick={() => {
                        setEditandoId(punto.id);
                        setNombreEdit(punto.nombre);
                        setAliasEdit((punto.alias ?? []).join(", "));
                      }}
                    >
                      Editar
                    </button>
                    <button
                      className={BOTON_LINK}
                     
                      onClick={async () => {
                        if (await ejecutar(() => actualizarPunto(punto.id, { activo: !punto.activo }), punto.activo ? "Punto desactivado" : "Punto activado")) mutate();
                      }}
                    >
                      {punto.activo ? "Desactivar" : "Activar"}
                    </button>
                    <AccionEliminar
                      nombre={punto.nombre}
                      exito="Punto eliminado"
                      onEliminar={() => eliminarPunto(punto.id)}
                      onDesactivar={punto.activo ? () => actualizarPunto(punto.id, { activo: false }) : undefined}
                      exitoDesactivar="Punto desactivado"
                      onHecho={() => mutate()}
                    />
                  </>
                )}
              </div>
              {editandoId !== punto.id && (punto.alias ?? []).length > 0 ? (
                <p className="-mt-2 px-4 pb-3 text-xs text-muted sm:px-5">Otros nombres: {punto.alias.join(", ")}</p>
              ) : null}
              {abiertoId === punto.id ? <UsuariosDePunto puntoId={punto.id} /> : null}
            </li>
          ))}
        </Lista>
      )}
    </Panel>
  );
}
