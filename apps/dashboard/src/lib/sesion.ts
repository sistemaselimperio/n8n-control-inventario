// Sesion del panel (login con usuario/contraseña y roles, ver
// /dashboard/auth/* en el backend). Modulo sin React: lo usan api.ts (para
// adjuntar el Bearer y reaccionar al 401) y el SesionProvider (para el estado
// reactivo). Token + usuario + expira_at viven en localStorage; ese acceso
// siempre va en try/catch porque puede fallar (modo privado, storage lleno).

export type RolDashboard = "admin" | "supervisor" | "consulta";

// Area: que secciones ve el usuario (el rol define que puede hacer en ellas).
export type AreaDashboard = "todo" | "bodega" | "traslados";

export interface UsuarioDashboard {
  id: string;
  usuario: string;
  nombre: string;
  rol: RolDashboard;
  // Opcional: las sesiones guardadas antes de existir las areas no la traen
  // y cuentan como "todo".
  area?: AreaDashboard;
}

export interface Sesion {
  token: string;
  usuario: UsuarioDashboard;
  // ISO UTC -- el backend expira el token a las 8 h.
  expira_at: string;
}

const CLAVE = "despachos_sesion";

// useSyncExternalStore compara por identidad: se cachea el ultimo texto crudo
// leido y su version parseada para devolver SIEMPRE el mismo objeto mientras
// el texto no cambie (si no, React entraria en un bucle de renders).
let crudoCache: string | null = null;
let sesionCache: Sesion | null = null;

function parsear(crudo: string | null): Sesion | null {
  if (!crudo) return null;
  try {
    const s = JSON.parse(crudo) as Sesion;
    if (typeof s?.token === "string" && s.token && s.usuario && typeof s.expira_at === "string") return s;
  } catch {
    // JSON corrupto: se trata como "sin sesion".
  }
  return null;
}

export function leerCrudo(): string | null {
  try {
    return localStorage.getItem(CLAVE);
  } catch {
    return null;
  }
}

// Snapshot estable de la sesion guardada (null si no hay o esta corrupta).
// No valida expira_at: eso lo hace quien la usa (ver sesionVigente).
export function leerSesion(): Sesion | null {
  if (typeof window === "undefined") return null;
  const crudo = leerCrudo();
  if (crudo !== crudoCache) {
    crudoCache = crudo;
    sesionCache = parsear(crudo);
  }
  return sesionCache;
}

export function sesionVigente(s: Sesion | null): boolean {
  if (!s) return false;
  const t = Date.parse(s.expira_at);
  return Number.isNaN(t) ? false : t > Date.now();
}

const oyentes = new Set<() => void>();

function avisar() {
  oyentes.forEach((fn) => fn());
}

// Se suscribe a cambios de sesion -- tanto de esta pestaña (guardar/borrar)
// como de otras (evento "storage"), asi cerrar sesion en una pestaña cierra
// todas.
export function suscribirSesion(fn: () => void): () => void {
  oyentes.add(fn);
  const alStorage = (e: StorageEvent) => {
    if (e.key === CLAVE || e.key === null) fn();
  };
  window.addEventListener("storage", alStorage);
  return () => {
    oyentes.delete(fn);
    window.removeEventListener("storage", alStorage);
  };
}

export function guardarSesion(s: Sesion): void {
  try {
    localStorage.setItem(CLAVE, JSON.stringify(s));
  } catch {
    // Sin storage la sesion no persiste entre recargas -- no es critico.
  }
  avisar();
}

export function borrarSesion(): void {
  try {
    localStorage.removeItem(CLAVE);
  } catch {
    // Idem guardarSesion.
  }
  avisar();
}

// Token para el header Authorization, o null si no hay sesion vigente.
export function tokenActual(): string | null {
  const s = leerSesion();
  return sesionVigente(s) ? s!.token : null;
}

// Punto unico para "la sesion murio" (cualquier 401 estando logueado): limpia
// y manda a /login?expirada=1. Navegacion completa (no router) para que
// tambien se descarte el estado en memoria (cache de SWR, formularios).
export function expirarSesion(): void {
  borrarSesion();
  if (typeof window === "undefined") return;
  if (window.location.pathname.startsWith("/login")) return;
  // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- recarga completa a proposito
  window.location.assign("/login?expirada=1");
}

export const esAdmin = (u: UsuarioDashboard | null | undefined) => u?.rol === "admin";
// admin o supervisor: corrigen entregas y administran el catalogo.
export const puedeEditar = (u: UsuarioDashboard | null | undefined) =>
  u?.rol === "admin" || u?.rol === "supervisor";

export const ETIQUETA_ROL: Record<RolDashboard, string> = {
  admin: "Administrador",
  supervisor: "Supervisor",
  consulta: "Consulta",
};

export const ETIQUETA_AREA: Record<AreaDashboard, string> = {
  todo: "Todo",
  bodega: "Bodega",
  traslados: "Traslados",
};

// Area con la que actua el usuario: el admin siempre es "todo", y una sesion
// vieja sin area tambien.
export const areaEfectiva = (u: UsuarioDashboard | null | undefined): AreaDashboard =>
  !u || u.rol === "admin" ? "todo" : (u.area ?? "todo");

// Paginas que ve cada area (las exclusivas de admin se filtran aparte). "/" ya
// no es una pagina: redirige a /entregas, por eso sigue permitida en bodega
// (la primera ruta de la lista es la pagina inicial).
const RUTAS_POR_AREA: Record<AreaDashboard, string[] | "todas"> = {
  todo: "todas",
  bodega: ["/entregas", "/", "/productos", "/ranking"],
  traslados: ["/traslados"],
};

const coincideRuta = (ruta: string, base: string) =>
  base === "/" ? ruta === "/" : ruta === base || ruta.startsWith(`${base}/`);

export function rutaPermitida(u: UsuarioDashboard | null | undefined, ruta: string): boolean {
  const permitidas = RUTAS_POR_AREA[areaEfectiva(u)];
  return permitidas === "todas" || permitidas.some((base) => coincideRuta(ruta, base));
}

// Primera pagina a la que puede entrar el usuario (destino de la redireccion).
export function rutaInicial(u: UsuarioDashboard | null | undefined): string {
  const permitidas = RUTAS_POR_AREA[areaEfectiva(u)];
  return permitidas === "todas" ? "/entregas" : permitidas[0];
}
