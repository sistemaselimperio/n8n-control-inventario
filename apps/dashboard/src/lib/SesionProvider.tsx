"use client";

// Estado reactivo de la sesion del panel (ver lib/sesion.ts para el storage).
// Se monta una sola vez en el layout raiz; las pantallas leen `useSesion()`.

import { createContext, useCallback, useContext, useEffect, useMemo, useSyncExternalStore, type ReactNode } from "react";
import { fetchYo, loginDashboard } from "@/lib/api";
import {
  borrarSesion,
  esAdmin as esAdminRol,
  expirarSesion,
  guardarSesion,
  leerSesion,
  puedeEditar as puedeEditarRol,
  suscribirSesion,
  type Sesion,
  type UsuarioDashboard,
} from "@/lib/sesion";

interface ValorSesion {
  // false hasta que el cliente hidrato y pudo leer localStorage -- evita
  // decidir "no hay sesion" con el snapshot del servidor.
  listo: boolean;
  sesion: Sesion | null;
  usuario: UsuarioDashboard | null;
  esAdmin: boolean;
  // admin o supervisor.
  puedeEditar: boolean;
  login: (usuario: string, password: string) => Promise<void>;
  logout: () => void;
}

const Contexto = createContext<ValorSesion | null>(null);

const sinSuscripcion = () => () => {};

export function SesionProvider({ children }: { children: ReactNode }) {
  const sesion = useSyncExternalStore(suscribirSesion, leerSesion, () => null);
  const listo = useSyncExternalStore(sinSuscripcion, () => true, () => false);
  const token = sesion?.token;
  const expiraAt = sesion?.expira_at;

  // Vencimiento por expira_at: si ya paso, o cuando llegue, se cierra la sesion
  // (el backend igual la rechazaria con 401). setTimeout admite hasta ~24 dias.
  useEffect(() => {
    if (!token || !expiraAt) return;
    const ms = Date.parse(expiraAt) - Date.now();
    if (Number.isNaN(ms) || ms <= 0) {
      expirarSesion();
      return;
    }
    const t = setTimeout(expirarSesion, Math.min(ms, 2 ** 31 - 1));
    return () => clearTimeout(t);
  }, [token, expiraAt]);

  // Al abrir con una sesion guardada se valida contra el backend y se refresca
  // nombre/rol (un admin pudo cambiarlos). Un 401 ya lo maneja apiFetch; otros
  // errores (red caida) se ignoran: se sigue con lo guardado.
  useEffect(() => {
    if (!token) return;
    let cancelado = false;
    fetchYo()
      .then((usuario) => {
        const actual = leerSesion();
        if (cancelado || !actual || actual.token !== token) return;
        if (
          actual.usuario.nombre !== usuario.nombre ||
          actual.usuario.rol !== usuario.rol ||
          actual.usuario.area !== usuario.area ||
          (actual.usuario.punto_id ?? null) !== (usuario.punto_id ?? null) ||
          (actual.usuario.cedula ?? null) !== (usuario.cedula ?? null)
        ) {
          guardarSesion({ ...actual, usuario });
        }
      })
      .catch(() => {});
    return () => {
      cancelado = true;
    };
  }, [token]);

  const login = useCallback(async (usuario: string, password: string) => {
    const r = await loginDashboard(usuario.trim().toLowerCase(), password);
    guardarSesion({ token: r.token, usuario: r.usuario, expira_at: r.expira_at });
  }, []);

  const logout = useCallback(() => {
    borrarSesion();
    // Navegacion completa: descarta tambien el cache de SWR y el estado en memoria.
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- recarga completa a proposito
    window.location.assign("/login");
  }, []);

  const valor = useMemo<ValorSesion>(
    () => ({
      listo,
      sesion,
      usuario: sesion?.usuario ?? null,
      esAdmin: esAdminRol(sesion?.usuario),
      puedeEditar: puedeEditarRol(sesion?.usuario),
      login,
      logout,
    }),
    [listo, sesion, login, logout]
  );

  return <Contexto.Provider value={valor}>{children}</Contexto.Provider>;
}

export function useSesion(): ValorSesion {
  const v = useContext(Contexto);
  if (!v) throw new Error("useSesion debe usarse dentro de <SesionProvider>");
  return v;
}
