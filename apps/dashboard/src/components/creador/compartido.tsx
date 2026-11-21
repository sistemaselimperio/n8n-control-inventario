"use client";

import { useEffect, useId, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { toast } from "sonner";
import { type AreaDashboard, type RolDashboard } from "@/lib/sesion";
import { Boton, claseBoton, EstadoVacio, Pildora } from "@/components/ui";
import { ErrorAdmin, type RolEmpleado } from "@/lib/api";

// Piezas compartidas por las secciones de Administracion: clases de controles,
// campo con rotulo, insignia de estado, aviso de resultado y reset de PIN.

// Controles: 44px de alto, radio de control (rounded-md), sin sombras.
export const INPUT =
  "min-h-11 rounded-md border border-line-strong bg-surface px-3 text-sm text-ink disabled:opacity-50";
export const BOTON_PRIMARIO = claseBoton("primario");
// Accion secundaria dentro de una fila (Editar, Desactivar...): texto de enlace
// (verde azulado, info), area de toque de 44px.
export const BOTON_LINK =
  "inline-flex min-h-11 items-center rounded-md px-2.5 text-sm font-medium text-info transition-colors duration-150 hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-50";
// Accion destructiva dentro de una fila (Eliminar): fantasma en rojo, 44px.
export const BOTON_PELIGRO =
  "inline-flex min-h-11 cursor-pointer items-center rounded-md px-2.5 text-sm font-medium text-danger-fg transition-colors duration-150 hover:bg-danger/10 disabled:cursor-not-allowed disabled:opacity-50";
export const BOTON_CANCELAR =
  "inline-flex min-h-11 items-center rounded-md px-2.5 text-sm text-muted transition-colors duration-150 hover:bg-surface-2 hover:text-ink";

export const ROLES: { valor: RolEmpleado; etiqueta: string }[] = [
  { valor: "operador", etiqueta: "Bodeguero" },
  { valor: "punto_venta", etiqueta: "Punto de venta" },
  { valor: "supervisor", etiqueta: "Supervisor" },
  { valor: "admin", etiqueta: "Administrador" },
  { valor: "faia_viewer", etiqueta: "Visor FAIA" },
];
export const etiquetaRol = (rol: string) => ROLES.find((r) => r.valor === rol)?.etiqueta ?? rol;

export const PIN_VALIDO = /^\d{4,6}$/;

export const ROLES_DASHBOARD: RolDashboard[] = ["admin", "supervisor", "consulta"];
export const AREAS_DASHBOARD: AreaDashboard[] = ["todo", "bodega", "traslados"];
export const PASSWORD_MIN = 8;

export function Campo({ etiqueta, children, className = "" }: { etiqueta: string; children: ReactNode; className?: string }) {
  return (
    <label className={`flex flex-col gap-1.5 ${className}`}>
      <span className="text-xs font-medium text-muted">{etiqueta}</span>
      {children}
    </label>
  );
}

export function Insignia({ activo }: { activo: boolean }) {
  return <Pildora tono={activo ? "ok" : "neutro"}>{activo ? "Activo" : "Inactivo"}</Pildora>;
}

// Ejecuta una accion contra el backend con aviso de exito/error -- devuelve
// true si salio bien para que el llamador limpie su formulario.
export async function ejecutar(accion: () => Promise<unknown>, exito: string): Promise<boolean> {
  try {
    await accion();
    toast.success(exito);
    return true;
  } catch (err) {
    toast.error(err instanceof Error ? err.message : "La operación falló");
    return false;
  }
}

// Reset de PIN en la propia fila: boton -> input -> guardar.
export function CambiarPin({ onGuardar }: { onGuardar: (pin: string) => Promise<unknown> }) {
  const [abierto, setAbierto] = useState(false);
  const [pin, setPin] = useState("");
  const [guardando, setGuardando] = useState(false);

  if (!abierto) {
    return (
      <button onClick={() => setAbierto(true)} className={BOTON_LINK}>
        Cambiar PIN
      </button>
    );
  }
  const guardar = async () => {
    setGuardando(true);
    const ok = await ejecutar(() => onGuardar(pin), "PIN actualizado");
    setGuardando(false);
    if (ok) {
      setAbierto(false);
      setPin("");
    }
  };
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      <input
        autoFocus
        type="password"
        inputMode="numeric"
        aria-label="Nuevo PIN"
        maxLength={6}
        value={pin}
        onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))}
        onKeyDown={(e) => e.key === "Enter" && PIN_VALIDO.test(pin) && guardar()}
        placeholder="4 a 6 dígitos"
        className={`${INPUT} w-36`}
      />
      <button onClick={guardar} disabled={guardando || !PIN_VALIDO.test(pin)} className={BOTON_LINK}>
        Guardar
      </button>
      <button
        onClick={() => {
          setAbierto(false);
          setPin("");
        }}
        className={BOTON_CANCELAR}
      >
        Cancelar
      </button>
    </span>
  );
}

export function Cargando() {
  return <p className="px-4 py-6 text-center text-sm text-muted sm:px-5">Cargando…</p>;
}

export function Lista({ vacio, children }: { vacio: boolean; children: ReactNode }) {
  if (vacio) return <EstadoVacio titulo="Todavía no hay registros." />;
  return <ul className="flex flex-col divide-y divide-line">{children}</ul>;
}

export const FILA = "flex min-h-11 flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2 text-sm sm:px-5";

// "Eliminar" de una fila: boton + modal de confirmacion. Borra de verdad solo si
// el registro nunca se uso; si tiene historial el backend responde 409 con el
// motivo, que se muestra en el modal junto con "Desactivar" (sin `onDesactivar`
// cuando el registro ya esta inactivo). Nada con historial se borra jamas.
export function AccionEliminar({
  nombre,
  exito,
  onEliminar,
  onDesactivar,
  exitoDesactivar,
  onHecho,
  deshabilitado,
  titulo,
}: {
  nombre: string;
  // Aviso al borrar, ej. "Sede eliminada".
  exito: string;
  onEliminar: () => Promise<unknown>;
  onDesactivar?: () => Promise<unknown>;
  exitoDesactivar?: string;
  // Despues de borrar o desactivar: revalidar la lista.
  onHecho: () => void;
  deshabilitado?: boolean;
  titulo?: string;
}) {
  const [abierto, setAbierto] = useState(false);
  const [trabajando, setTrabajando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // true cuando el backend dijo que tiene historial (409): ya no se puede borrar.
  const [conHistorial, setConHistorial] = useState(false);
  const idTitulo = useId();

  const cerrar = () => {
    if (trabajando) return;
    setAbierto(false);
    setError(null);
    setConHistorial(false);
  };

  useEffect(() => {
    if (!abierto) return;
    const alTecla = (ev: KeyboardEvent) => {
      if (ev.key === "Escape" && !trabajando) {
        setAbierto(false);
        setError(null);
        setConHistorial(false);
      }
    };
    document.addEventListener("keydown", alTecla);
    return () => document.removeEventListener("keydown", alTecla);
  }, [abierto, trabajando]);

  const eliminar = async () => {
    setTrabajando(true);
    setError(null);
    try {
      await onEliminar();
      toast.success(exito);
      setAbierto(false);
      onHecho();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo eliminar");
      setConHistorial(err instanceof ErrorAdmin && err.status === 409);
    } finally {
      setTrabajando(false);
    }
  };

  const desactivar = async () => {
    if (!onDesactivar) return;
    setTrabajando(true);
    try {
      await onDesactivar();
      toast.success(exitoDesactivar ?? "Desactivado");
      setAbierto(false);
      setError(null);
      setConHistorial(false);
      onHecho();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo desactivar");
    } finally {
      setTrabajando(false);
    }
  };

  return (
    <>
      <button
        type="button"
        className={BOTON_PELIGRO}
        disabled={deshabilitado}
        title={titulo}
        onClick={() => setAbierto(true)}
      >
        Eliminar
      </button>
      {abierto
        ? createPortal(
            <div
              className="fixed inset-0 z-50 flex items-center justify-center bg-brand-night/50 px-4"
              onClick={cerrar}
            >
              <div
                role="dialog"
                aria-modal="true"
                aria-labelledby={idTitulo}
                className="flex w-full max-w-md flex-col gap-4 rounded-lg border border-line bg-surface p-5"
                onClick={(ev) => ev.stopPropagation()}
              >
                <h3 id={idTitulo} className="text-lg font-semibold text-ink">
                  ¿Eliminar {nombre}?
                </h3>
                <p className="text-sm text-muted">Esta acción no se puede deshacer.</p>
                {error ? (
                  <p role="alert" className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger-fg">
                    {error}
                  </p>
                ) : null}
                <div className="flex flex-wrap justify-end gap-2">
                  <Boton autoFocus onClick={cerrar} disabled={trabajando}>
                    Cancelar
                  </Boton>
                  {conHistorial && onDesactivar ? (
                    <Boton variante="primario" onClick={desactivar} disabled={trabajando}>
                      {trabajando ? "Desactivando…" : "Desactivar"}
                    </Boton>
                  ) : null}
                  {!conHistorial ? (
                    <Boton variante="peligro" onClick={eliminar} disabled={trabajando}>
                      {trabajando ? "Eliminando…" : "Eliminar"}
                    </Boton>
                  ) : null}
                </div>
              </div>
            </div>,
            document.body
          )
        : null}
    </>
  );
}
