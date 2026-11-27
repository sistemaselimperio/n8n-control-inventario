// Reglas de presentacion del modulo Traslados (pagina /traslados): que puede
// hacer cada perfil, etiquetas y revalidacion de SWR. Sin React.

import { mutate as mutateGlobal } from "swr";
import type { Comprobante, EstadoComprobante, QuienRecibe, TipoComprobante } from "./api";
import type { TonoPildora } from "@/components/ui";
import type { UsuarioDashboard } from "./sesion";

// Primer elemento de toda clave SWR de este modulo: permite revalidarlas todas
// de una vez (Realtime, despues de una accion).
export const CLAVE_TRASLADOS = "traslados";

export const revalidarTraslados = () =>
  mutateGlobal((key) => Array.isArray(key) && key[0] === CLAVE_TRASLADOS);

// Cedula de quien firma: solo digitos, 5 a 15 (misma regla del backend).
export const CEDULA_FIRMA_VALIDA = /^\d{5,15}$/;

// Eleccion de quien recibe en los modales de confirmar / devolver: `receptorId`
// es "" (nadie), el id de un receptor de la lista u OTRA_PERSONA (nombre y
// cedula escritos a mano, solo para ese comprobante).
export const OTRA_PERSONA = "__otra__";

export interface SeleccionReceptor {
  receptorId: string;
  nombre: string;
  cedula: string;
}

export const SELECCION_VACIA: SeleccionReceptor = { receptorId: "", nombre: "", cedula: "" };

export const normalizarCedula = (valor: string) => valor.replace(/[.\s-]/g, "");

// Lo que se manda al backend, o null mientras la eleccion no sea valida.
export function quienRecibe(s: SeleccionReceptor): QuienRecibe | null {
  if (!s.receptorId) return null;
  if (s.receptorId !== OTRA_PERSONA) return { receptor_id: s.receptorId };
  const nombre = s.nombre.trim().replace(/\s+/g, " ");
  const cedula = normalizarCedula(s.cedula);
  if (!nombre || !CEDULA_FIRMA_VALIDA.test(cedula)) return null;
  return { receptor_nombre: nombre, receptor_cedula: cedula };
}

export type TipoPerfil = "admin" | "encargada" | "punto" | "lectura" | "ninguno";

export interface PerfilTraslados {
  tipo: TipoPerfil;
  // Puede abrir la pagina (el area bodega no).
  acceso: boolean;
  // Sube PDFs, edita borradores, envia, reenvia y elimina (admin y encargada).
  gestiona: boolean;
  // Firma (confirma) comprobantes (admin y usuarios de punto).
  firma: boolean;
  soloLectura: boolean;
  // Punto al que esta atado un usuario de punto.
  puntoId: string | null;
}

const SIN_ACCESO: PerfilTraslados = {
  tipo: "ninguno",
  acceso: false,
  gestiona: false,
  firma: false,
  soloLectura: false,
  puntoId: null,
};

export function perfilTraslados(u: UsuarioDashboard | null | undefined): PerfilTraslados {
  if (!u) return SIN_ACCESO;
  if (u.rol === "admin") {
    return { tipo: "admin", acceso: true, gestiona: true, firma: true, soloLectura: false, puntoId: null };
  }
  const area = u.area ?? "todo";
  if (area === "bodega") return SIN_ACCESO;
  if (area === "traslados" && u.rol === "supervisor") {
    return u.punto_id
      ? { tipo: "punto", acceso: true, gestiona: false, firma: true, soloLectura: false, puntoId: u.punto_id }
      : { tipo: "encargada", acceso: true, gestiona: true, firma: false, soloLectura: false, puntoId: null };
  }
  return {
    tipo: "lectura",
    acceso: true,
    gestiona: false,
    firma: false,
    soloLectura: true,
    puntoId: area === "traslados" ? (u.punto_id ?? null) : null,
  };
}

export interface AccionesComprobante {
  historial: boolean;
  confirmar: boolean;
  devolver: boolean;
  eliminar: boolean;
  reenviar: boolean;
}

// Acciones disponibles de un comprobante segun el perfil. Un usuario de punto
// nunca devuelve un comprobante ya confirmado (eso lo hace la encargada).
export function accionesComprobante(perfil: PerfilTraslados, c: Pick<Comprobante, "estado">): AccionesComprobante {
  const admin = perfil.tipo === "admin";
  const punto = perfil.tipo === "punto";
  const encargada = perfil.tipo === "encargada";
  return {
    historial: perfil.acceso,
    confirmar: (admin || punto) && c.estado === "pendiente",
    devolver:
      ((admin || punto) && c.estado === "pendiente") || ((admin || encargada) && c.estado === "confirmado"),
    eliminar: perfil.gestiona,
    reenviar: perfil.gestiona && c.estado === "devuelto",
  };
}

export const etiquetaEstado = (e: EstadoComprobante) =>
  ({ pendiente: "Pendiente", confirmado: "Confirmado", devuelto: "Devuelto" })[e];

export const TONO_ESTADO: Record<EstadoComprobante, TonoPildora> = {
  pendiente: "warn",
  confirmado: "ok",
  devuelto: "error",
};

export const etiquetaMovimiento = (t: TipoComprobante) => (t === "salida" ? "Salida" : "Ingreso");

export const TONO_MOVIMIENTO: Record<TipoComprobante, TonoPildora> = {
  salida: "info",
  ingreso: "neutro",
};

const FORMATO_FECHA_HORA = new Intl.DateTimeFormat("es-CO", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "America/Bogota",
});

export const fechaHora = (iso: string | null | undefined) => (iso ? FORMATO_FECHA_HORA.format(new Date(iso)) : "—");

export const nombrePunto = (p: { nombre: string | null; codigo: string | null } | null | undefined) =>
  p?.nombre ? (p.codigo ? `${p.nombre} (${p.codigo})` : p.nombre) : "—";

// Texto de una opcion de punto en los selects: "Nombre (COD) · interna".
export const etiquetaPuntoOpcion = (p: { nombre: string; codigo: string | null; es_interna: boolean }) =>
  `${p.nombre}${p.codigo ? ` (${p.codigo})` : ""}${p.es_interna ? " · interna" : ""}`;
