// Sesion unica de la app -- se inicia una sola vez en la pantalla de entrada
// (ver PantallaEntrada.tsx) y la comparten todas las tabs. Antes cada tab
// tenia su propio login; ahora un bodeguero entra una vez y usa Despachos y
// Remisiones sin volver a poner el PIN.
//
// Vive solo en memoria (useState en Navegacion.tsx), igual que antes: si la
// app se cierra, hay que volver a entrar. No se persiste a proposito -- eso
// requeriria una libreria nativa (y un .apk nuevo).
import { createContext, useContext } from 'react';

import type { Empleado, Punto, Sede, UsuarioPunto } from './api';

// Discriminada por tipo de cuenta -- son tablas distintas en el backend
// (empleados, usuarios_punto), cada una con su propio login.
export type Sesion =
  | { tipo: 'bodega'; empleado: Empleado; sede: Sede }
  | { tipo: 'punto'; usuario: UsuarioPunto; punto: Punto };

export type TipoSesion = Sesion['tipo'];

// Tabs cuyo acceso depende de la sesion (Inicio es de todos).
export type AreaApp = 'Despachos' | 'Remisiones' | 'TrasladosPuntos';

// Roles que pueden entrar a Remisiones (el bodeguero fotografia directo,
// punto_venta y faia_viewer no participan -- ver procesar_extraccion).
const ROLES_REMISIONES = ['operador', 'supervisor', 'admin'];

export function tieneAcceso(sesion: Sesion, area: AreaApp): boolean {
  switch (area) {
    case 'Despachos':
      return sesion.tipo === 'bodega';
    case 'Remisiones':
      return sesion.tipo === 'bodega' && ROLES_REMISIONES.includes(sesion.empleado.rol);
    case 'TrasladosPuntos':
      return sesion.tipo === 'punto';
  }
}

// Nombre para mostrar de quien esta logueado (ver SinAcceso.tsx).
export function nombreSesion(sesion: Sesion): string {
  switch (sesion.tipo) {
    case 'bodega':
      return `${sesion.empleado.nombre} · ${sesion.sede.nombre}`;
    case 'punto':
      return sesion.punto.nombre;
  }
}

// Donde esta trabajando la sesion -- chip de Inicio junto a la fecha.
export function lugarSesion(sesion: Sesion): { texto: string; icono: 'location-outline' } {
  switch (sesion.tipo) {
    case 'bodega':
      return { texto: sesion.sede.nombre, icono: 'location-outline' };
    case 'punto':
      return { texto: sesion.punto.nombre, icono: 'location-outline' };
  }
}

type ValorSesion = { sesion: Sesion; cerrarSesion: () => void };

const SesionContext = createContext<ValorSesion | null>(null);

export const SesionProvider = SesionContext.Provider;

// Solo se usa dentro de las tabs, que se montan unicamente con sesion
// iniciada (ver Navegacion.tsx) -- por eso la sesion nunca es null aca.
export function useSesion(): ValorSesion {
  const valor = useContext(SesionContext);
  if (!valor) {
    throw new Error('useSesion se usó fuera de SesionProvider');
  }
  return valor;
}
