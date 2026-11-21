"use client";

import { useState } from "react";
import useSWR from "swr";
import {
  type UsuarioDashboardAdmin,
  actualizarUsuarioDashboard,
  crearUsuarioDashboard,
  eliminarUsuarioDashboard,
  fetchPuntosAdmin,
  fetchUsuariosDashboard,
  resetearPasswordUsuarioDashboard,
} from "@/lib/api";
import { useSesion } from "@/lib/SesionProvider";
import { ETIQUETA_AREA, ETIQUETA_ROL, type AreaDashboard, type RolDashboard } from "@/lib/sesion";
import { ErrorConReintento, Panel } from "@/components/ui";
import {
  INPUT,
  BOTON_PRIMARIO,
  BOTON_LINK,
  BOTON_CANCELAR,
  AccionEliminar,
  ROLES_DASHBOARD,
  AREAS_DASHBOARD,
  PASSWORD_MIN,
  Campo,
  Insignia,
  ejecutar,
  Cargando,
  Lista,
  FILA,
} from "./compartido";

// Restablecer contraseña en la propia fila: boton -> input -> guardar. Mismo
// patron que CambiarPin, pero con contraseña (minimo 8) en vez de PIN.
function RestablecerPassword({ onGuardar }: { onGuardar: (password: string) => Promise<unknown> }) {
  const [abierto, setAbierto] = useState(false);
  const [password, setPassword] = useState("");
  const [guardando, setGuardando] = useState(false);

  if (!abierto) {
    return (
      <button onClick={() => setAbierto(true)} className={BOTON_LINK}>
        Restablecer contraseña
      </button>
    );
  }
  const valida = password.length >= PASSWORD_MIN;
  const guardar = async () => {
    setGuardando(true);
    const ok = await ejecutar(() => onGuardar(password), "Contraseña restablecida");
    setGuardando(false);
    if (ok) {
      setAbierto(false);
      setPassword("");
    }
  };
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      <input
        autoFocus
        type="password"
        autoComplete="new-password"
        aria-label="Nueva contraseña"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && valida && guardar()}
        placeholder="Mínimo 8 caracteres"
        className={`${INPUT} w-52`}
      />
      <button onClick={guardar} disabled={guardando || !valida} className={BOTON_LINK}>
        Guardar
      </button>
      <button
        onClick={() => {
          setAbierto(false);
          setPassword("");
        }}
        className={BOTON_CANCELAR}
      >
        Cancelar
      </button>
    </span>
  );
}

// Cedula de quien firma: solo digitos, 5 a 15 (misma regla del backend).
const CEDULA_VALIDA = /^\d{5,15}$/;
const soloDigitos = (v: string) => v.replace(/\D/g, "").slice(0, 15);

// Selector de punto (vacio = encargada, ve todos) y cedula; solo aplica al area traslados.
function CamposTraslados({
  puntos,
  puntoId,
  cedula,
  onPunto,
  onCedula,
}: {
  puntos: { id: string; nombre: string; activo: boolean }[];
  puntoId: string;
  cedula: string;
  onPunto: (v: string) => void;
  onCedula: (v: string) => void;
}) {
  return (
    <>
      <Campo etiqueta="Punto">
        <select aria-label="Punto" value={puntoId} onChange={(e) => onPunto(e.target.value)} className={INPUT}>
          <option value="">Todos los puntos (encargada)</option>
          {puntos
            .filter((p) => p.activo || p.id === puntoId)
            .map((p) => (
              <option key={p.id} value={p.id}>
                {p.nombre}
              </option>
            ))}
        </select>
      </Campo>
      <Campo etiqueta="Cédula (opcional, 5 a 15 dígitos)" className="w-44">
        <input
          inputMode="numeric"
          autoComplete="off"
          value={cedula}
          onChange={(e) => onCedula(soloDigitos(e.target.value))}
          className={INPUT}
        />
      </Campo>
    </>
  );
}

const FORMATO_FECHA = new Intl.DateTimeFormat("es-CO", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "America/Bogota",
});
const fechaCorta = (iso: string | null) => (iso ? FORMATO_FECHA.format(new Date(iso)) : null);

export function SeccionUsuariosDashboard() {
  const { usuario: yo } = useSesion();
  const { data, error, isLoading, mutate } = useSWR("creador-usuarios-dashboard", () => fetchUsuariosDashboard());
  // Instante de montaje: para decidir si un bloqueo sigue vigente sin llamar
  // a Date.now() en el render.
  const { data: puntos } = useSWR(["creador-puntos"], () => fetchPuntosAdmin());
  const nombrePunto = (id: string | null | undefined) => (puntos ?? []).find((p) => p.id === id)?.nombre ?? "punto";
  const [ahora] = useState(() => Date.now());
  const [usuario, setUsuario] = useState("");
  const [nombre, setNombre] = useState("");
  const [rol, setRol] = useState<RolDashboard>("consulta");
  const [area, setArea] = useState<AreaDashboard>("todo");
  const [password, setPassword] = useState("");
  const [puntoId, setPuntoId] = useState("");
  const [cedula, setCedula] = useState("");
  const [enviando, setEnviando] = useState(false);
  const [editandoId, setEditandoId] = useState<string | null>(null);
  const [edit, setEdit] = useState<{
    nombre: string;
    rol: RolDashboard;
    area: AreaDashboard;
    puntoId: string;
    cedula: string;
  }>({ nombre: "", rol: "consulta", area: "todo", puntoId: "", cedula: "" });
  const esTraslados = rol !== "admin" && area === "traslados";
  const cedulaOk = !esTraslados || cedula === "" || CEDULA_VALIDA.test(cedula);
  const editTraslados = edit.rol !== "admin" && edit.area === "traslados";
  const editCedulaOk = !editTraslados || edit.cedula === "" || CEDULA_VALIDA.test(edit.cedula);

  const agregar = async () => {
    setEnviando(true);
    const ok = await ejecutar(
      () =>
        crearUsuarioDashboard({
          usuario: usuario.trim().toLowerCase(),
          nombre: nombre.trim(),
          rol,
          area: rol === "admin" ? "todo" : area,
          password,
          ...(esTraslados ? { punto_id: puntoId || null, cedula: cedula || null } : {}),
        }),
      "Usuario creado"
    );
    setEnviando(false);
    if (ok) {
      setUsuario("");
      setNombre("");
      setPassword("");
      setCedula("");
      mutate();
    }
  };

  const guardarEdicion = async (u: UsuarioDashboardAdmin) => {
    const ok = await ejecutar(
      () =>
        actualizarUsuarioDashboard(u.id, {
          nombre: edit.nombre.trim(),
          rol: edit.rol,
          area: edit.rol === "admin" ? "todo" : edit.area,
          // En traslados se envia punto y cedula (null limpia); al salir de
          // traslados se libera el punto, que el backend no admite fuera de el.
          ...(editTraslados
            ? { punto_id: edit.puntoId || null, cedula: edit.cedula || null }
            : u.punto_id
              ? { punto_id: null }
              : {}),
        }),
      "Usuario actualizado"
    );
    if (ok) {
      setEditandoId(null);
      mutate();
    }
  };

  return (
    <Panel conRelleno={false}
      titulo="Usuarios del dashboard"
      subtitulo="Quienes inician sesión en este panel con usuario y contraseña. El rol define qué pueden hacer y el área qué secciones ven."
      conteo={data ? String(data.length) : undefined}
    >
      <div className="flex flex-wrap items-end gap-3 border-b border-line p-4 sm:p-5">
        <Campo etiqueta="Usuario (a-z, 0-9 . _ @ -)" className="w-44">
          <input
            value={usuario}
            onChange={(e) => setUsuario(e.target.value)}
            autoCapitalize="none"
            autoComplete="off"
            className={INPUT}
          />
        </Campo>
        <Campo etiqueta="Nombre" className="min-w-[160px] flex-1">
          <input value={nombre} onChange={(e) => setNombre(e.target.value)} className={INPUT} />
        </Campo>
        <Campo etiqueta="Rol">
          <select value={rol} onChange={(e) => setRol(e.target.value as RolDashboard)} className={INPUT}>
            {ROLES_DASHBOARD.map((r) => (
              <option key={r} value={r}>
                {ETIQUETA_ROL[r]}
              </option>
            ))}
          </select>
        </Campo>
        <Campo etiqueta="Área">
          <select
            value={rol === "admin" ? "todo" : area}
            disabled={rol === "admin"}
            onChange={(e) => setArea(e.target.value as AreaDashboard)}
            className={INPUT}
          >
            {AREAS_DASHBOARD.map((a) => (
              <option key={a} value={a}>
                {ETIQUETA_AREA[a]}
              </option>
            ))}
          </select>
        </Campo>
        {esTraslados ? (
          <CamposTraslados
            puntos={puntos ?? []}
            puntoId={puntoId}
            cedula={cedula}
            onPunto={setPuntoId}
            onCedula={setCedula}
          />
        ) : null}
        <Campo etiqueta="Contraseña (mínimo 8)" className="w-44">
          <input
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className={INPUT}
          />
        </Campo>
        <button
          onClick={agregar}
          disabled={enviando || usuario.trim().length < 3 || !nombre.trim() || password.length < PASSWORD_MIN || !cedulaOk}
          className={BOTON_PRIMARIO}
        >
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
          {data.map((u) => {
            const esYo = u.id === yo?.id;
            const bloqueado = u.bloqueado_hasta && Date.parse(u.bloqueado_hasta) > ahora ? u.bloqueado_hasta : null;
            return (
              <li key={u.id} className={FILA}>
                {editandoId === u.id ? (
                  <>
                    <span className="text-sm text-muted">{u.usuario}</span>
                    <input aria-label="Nombre" value={edit.nombre} onChange={(e) => setEdit({ ...edit, nombre: e.target.value })} className={`${INPUT} min-w-[140px] flex-1`} />
                    <select aria-label="Rol" value={edit.rol} onChange={(e) => setEdit({ ...edit, rol: e.target.value as RolDashboard })} className={INPUT}>
                      {ROLES_DASHBOARD.map((r) => (
                        <option key={r} value={r}>
                          {ETIQUETA_ROL[r]}
                        </option>
                      ))}
                    </select>
                    <select
                      aria-label="Área"
                      value={edit.rol === "admin" ? "todo" : edit.area}
                      disabled={edit.rol === "admin"}
                      onChange={(e) => setEdit({ ...edit, area: e.target.value as AreaDashboard })}
                      className={INPUT}
                    >
                      {AREAS_DASHBOARD.map((a) => (
                        <option key={a} value={a}>
                          {ETIQUETA_AREA[a]}
                        </option>
                      ))}
                    </select>
                    {editTraslados ? (
                      <CamposTraslados
                        puntos={puntos ?? []}
                        puntoId={edit.puntoId}
                        cedula={edit.cedula}
                        onPunto={(v) => setEdit({ ...edit, puntoId: v })}
                        onCedula={(v) => setEdit({ ...edit, cedula: v })}
                      />
                    ) : null}
                    <button className={BOTON_LINK} disabled={!edit.nombre.trim() || !editCedulaOk} onClick={() => guardarEdicion(u)}>
                      Guardar
                    </button>
                    <button className={BOTON_CANCELAR} onClick={() => setEditandoId(null)}>
                      Cancelar
                    </button>
                  </>
                ) : (
                  <>
                    <span className="min-w-[160px] flex-1 text-ink">
                      {u.nombre}
                      {esYo ? <span className="ml-1 text-xs text-muted">(tú)</span> : null}
                      <span className="ml-2 text-xs text-muted">{u.usuario}</span>
                      <span className="ml-2 text-xs text-muted">
                        {ETIQUETA_ROL[u.rol]}, área {ETIQUETA_AREA[u.area ?? "todo"].toLowerCase()}
                        {u.area === "traslados" ? (
                          <>
                            {" · "}
                            {u.punto_id ? nombrePunto(u.punto_id) : "todos los puntos"}
                            {u.cedula ? ` · C.C. ${u.cedula}` : ""}
                          </>
                        ) : null}
                      </span>
                      <span className="block text-xs text-subtle">
                        Último ingreso: {fechaCorta(u.ultimo_login_at) ?? "nunca"}
                        {bloqueado ? (
                          <span className="ml-2 text-warn">Bloqueado hasta {fechaCorta(bloqueado)}</span>
                        ) : null}
                      </span>
                    </span>
                    <Insignia activo={u.activo} />
                    <button
                      className={BOTON_LINK}
                      onClick={() => {
                        setEditandoId(u.id);
                        setEdit({
                          nombre: u.nombre,
                          rol: u.rol,
                          area: u.area ?? "todo",
                          puntoId: u.punto_id ?? "",
                          cedula: u.cedula ?? "",
                        });
                      }}
                    >
                      Editar
                    </button>
                    <RestablecerPassword onGuardar={(p) => resetearPasswordUsuarioDashboard(u.id, p)} />
                    <button
                      className={BOTON_LINK}
                      disabled={esYo && u.activo}
                      title={esYo && u.activo ? "No puedes desactivarte a ti mismo" : undefined}
                      onClick={async () => {
                        if (await ejecutar(() => actualizarUsuarioDashboard(u.id, { activo: !u.activo }), u.activo ? "Usuario desactivado" : "Usuario activado")) mutate();
                      }}
                    >
                      {u.activo ? "Desactivar" : "Activar"}
                    </button>
                    <AccionEliminar
                      nombre={u.nombre}
                      exito="Usuario eliminado"
                      deshabilitado={esYo}
                      titulo={esYo ? "No puedes eliminarte a ti mismo" : undefined}
                      onEliminar={() => eliminarUsuarioDashboard(u.id)}
                      onDesactivar={u.activo && !esYo ? () => actualizarUsuarioDashboard(u.id, { activo: false }) : undefined}
                      exitoDesactivar="Usuario desactivado"
                      onHecho={() => mutate()}
                    />
                  </>
                )}
              </li>
            );
          })}
        </Lista>
      )}
    </Panel>
  );
}
