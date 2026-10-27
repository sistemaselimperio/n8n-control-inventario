// Cliente hacia el backend (ver apps/backend). Los datos se leen por HTTP,
// pero la revalidacion es instantanea via Supabase Realtime (ver
// lib/supabase.ts y lib/useEntregasEnVivo.ts) — el polling de 5s de SWR queda como red
// de seguridad si el socket de Realtime se corta.

import {
  expirarSesion,
  leerSesion,
  tokenActual,
  type AreaDashboard,
  type RolDashboard,
  type Sesion,
  type UsuarioDashboard,
} from "./sesion";

export const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

// Punto unico de salida hacia el backend: adjunta Authorization: Bearer cuando
// hay sesion y, si el backend responde 401 estando logueado, la sesion murio
// (expiro o fue revocada) -> se limpia y se manda a /login?expirada=1 (ver
// expirarSesion en sesion.ts). Los links de descarga (<a href>) no pasan por
// aca: son GET publicos que no pueden mandar headers. Los exports de entregas
// piden sesion, por eso se descargan con descargarExport (fetch + blob).
async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const token = tokenActual();
  const headers = new Headers(init.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const res = await fetch(`${API_BASE_URL}${path}`, { ...init, headers });
  if (res.status === 401 && leerSesion()) {
    expirarSesion();
  }
  return res;
}

// Mensaje legible de una respuesta de error: usa `detail` del backend (texto,
// o la lista de un 422 resumida) y si no hay, el texto de respaldo.
async function mensajeDeError(res: Response, respaldo: string): Promise<string> {
  const body = await res.json().catch(() => ({}));
  const detalle = Array.isArray(body?.detail)
    ? body.detail.map((d: { msg?: string }) => d.msg).filter(Boolean).join("; ")
    : body?.detail;
  return typeof detalle === "string" && detalle ? detalle : `${respaldo} (${res.status})`;
}

const JSON_HEADERS = { "Content-Type": "application/json" };

// Tipos mas comunes -- sugerencia rapida (datalist), no una restriccion: en
// la practica el tipo real de un documento no siempre es uno de estos (ver
// apps/backend/app/models/entrega.py TipoDocumento). FEI/FV1 son de Sede
// Centro, EDP/EDV de Polo Sur (ver _TIPO_SEDE_DUENA en duplicates.py).
export type TipoDocumento = "FEI" | "FV1" | "EDP" | "EDV" | "TB9" | "RM3" | "RM2" | "RSF";

// Tipos que se capturan por la tab Remisiones de la app móvil (ver
// TIPOS_REMISION en apps/backend/app/models/entrega.py) -- los usan la tarjeta
// "Remisiones hoy" y el filtro Despachos/Remisiones de la tabla.
export const TIPOS_REMISION: readonly string[] = ["RM3", "RM2", "RSF"];

export interface ItemEntrega {
  id: string;
  descripcion: string;
  cantidad_entregada: number;
  cantidad_pendiente: number;
  // Unidades cerradas sin entregarse ("No se entrega" desde la app movil).
  cantidad_no_entregada?: number;
  // Remisiones: el item lo entrego otra bodega (no se acredita a esta).
  entregado_en_otra_bodega?: boolean;
}

export interface Entrega {
  id: string;
  tipo: string;
  indicativo_numero: string;
  sede_origen_id: string;
  sede_origen_nombre: string | null;
  // Un documento puede traer varios productos -- cada uno con su propia
  // cantidad entregada/pendiente (ver apps/backend/app/models/entrega.py).
  items: ItemEntrega[];
  estado: "procesada" | "pendiente_revision" | "duplicado_bloqueado";
  operador_id: string;
  // Nombre del empleado dueño de operador_id (join en el backend, ver
  // _SELECT_ENTREGAS_BASE) -- quién facturó/capturó la foto original. Nunca
  // se pisa después (aplicar_actualizacion_items no toca operador_id), así
  // que sigue siendo válido aunque el bodeguero ya haya confirmado la
  // entrega. Null si operador_id no matchea ningún empleado (ej. el
  // "supervisor" fijo que manda revisarEntrega) — el fallback es el id crudo.
  operador_nombre: string | null;
  // Rol del empleado dueño de operador_id (mismo join que operador_nombre) --
  // distingue si quien creó/facturó el documento fue "punto_venta" o
  // "operador" (bodega), para etiquetar evidencia_creacion_url en la UI.
  operador_rol: string | null;
  // Quién de bodega confirmó cantidades reales por última vez (join en el
  // backend contra bodeguero_id, ver apps/backend/app/db.py) -- a diferencia
  // de operador_id (el creador, inmutable), ESTE sí se actualiza en cada
  // confirmación real, así que refleja quién está con la factura ahora. Null
  // hasta que alguien de bodega la toque (ej. punto_venta facturó y todavía
  // nadie confirmó) -- se muestra como "NE" en la UI.
  bodeguero_id: string | null;
  bodeguero_nombre: string | null;
  // true si el admin corrigio algo desde el dashboard (ver "Cambios del
  // admin" en el detalle). Opcional mientras el backend no este desplegado.
  modificada_por_admin?: boolean;
  confianza_ia: Record<string, number>;
  evidencia_url: string;
  // Foto tal como quedó en la creación del documento -- nunca se pisa
  // después (ver evidencia_creacion_url en apps/backend/app/db.py), a
  // diferencia de evidencia_url (que sí se actualiza cuando bodega vuelve a
  // fotografiar al confirmar). Null en documentos creados antes de esta
  // columna, o cuando coincide con evidencia_url (nadie la reemplazó).
  evidencia_creacion_url: string | null;
  // Firma del cliente al confirmar la entrega desde el movil (paso 2) --
  // ausente cuando el guardado fue "Guardar nota" (sin cambio de
  // cantidades, no es un evento de entrega) o en entregas anteriores a esta
  // funcionalidad.
  firma_url?: string | null;
  // Foto del traslado (documento adicional que a veces se adjunta junto a
  // la evidencia principal) -- opcional, no todas las entregas lo traen.
  traslado_url?: string | null;
  // Tipo/numero del documento de traslado (distinto del tipo/indicativo_numero
  // del documento principal) -- solo presente cuando la entrega vino de un
  // caso "necesita_traslado" (ver _TIPO_SEDE_DUENA en duplicates.py).
  traslado_tipo: string | null;
  traslado_indicativo_numero: string | null;
  capturado_at: string;
  // Nota a nivel documento completo (distinta de ItemEntrega.nota, que es
  // por producto) -- la escribe el bodeguero en PantallaConfirmando. Llega
  // gratis por select e.* en el backend. Null si nunca se escribio.
  nota_general: string | null;
}

export interface Sede {
  id: string;
  nombre: string;
  codigo?: string;
}

// Rol completo del empleado (ver app/models/empleado.py RolEmpleado) -- el
// login del panel FAIA necesita distinguir 'faia_viewer'/'supervisor'/'admin'
// del resto para permitir o no el acceso (ver app/faia/page.tsx).
export type RolEmpleado = "operador" | "supervisor" | "admin" | "punto_venta" | "faia_viewer";

// Version liviana para el paso "elegir bodeguero" del login (ver GET
// /empleados) -- alcanza con lo que se muestra en la lista, no trae datos de
// PIN.
export interface EmpleadoBasico {
  id: string;
  nombre: string;
  rol: RolEmpleado;
}

// Empleado autenticado (respuesta de POST /auth/pin) -- ademas del id/nombre
// trae sede_id y el rol completo, usado para el gate de acceso a FAIA.
export interface Empleado {
  id: string;
  nombre: string;
  sede_id: string;
  rol: RolEmpleado;
}

export interface LogEvent {
  id: string;
  evento: string;
  entidad_tipo: string;
  entidad_id: string;
  actor_id: string;
  // Nombre resuelto del actor (join contra empleados en GET /logs) -- null
  // si actor_id no matchea ningun empleado real (ej. "system" del sync en
  // tiempo real, o "supervisor" de una correccion del dashboard).
  actor_nombre?: string | null;
  // Rol del actor, mismo join que actor_nombre -- null en los mismos casos.
  actor_rol?: RolEmpleado | null;
  sede_id: string;
  resultado: string;
  // Varia segun `evento` -- ver app/services/logging_service.py. Para
  // 'entrega_actualizada' trae los items con su cantidad_entregada/
  // cantidad_pendiente EN ESE MOMENTO (asi se arma el historial de fechas
  // de un producto puntual, ver historialDeItem en page.tsx); para
  // 'devolucion_registrada' trae item_id/cantidad/motivo/resolucion.
  detalle: Record<string, unknown>;
  timestamp: string;
}

async function getJson<T>(path: string): Promise<T> {
  const res = await apiFetch(path, { cache: "no-store" });
  if (!res.ok) {
    throw new Error(`${path} respondio ${res.status}`);
  }
  return res.json();
}

// Ventana mas grande que antes (era 50/30) para que el resumen del dia y el
// feed de actividad -- calculados del lado del cliente filtrando por fecha --
// tengan un universo representativo y no se corten a mitad del dia en una
// sede activa. Sin argumentos mantiene ese comportamiento (limit 150, sin
// filtros); `sedeId`/`desde`/`hasta` habilitan el filtro por rango/sede de la
// tabla "Todas las entregas" (ver rangoAFechas en page.tsx) sin tocar esta
// llamada base.
export const fetchEntregas = (opciones?: {
  sedeId?: string;
  desde?: string;
  hasta?: string;
  busqueda?: string;
  limit?: number;
}) => {
  const params = new URLSearchParams();
  if (opciones?.sedeId) params.set("sede_id", opciones.sedeId);
  if (opciones?.desde) params.set("desde", opciones.desde);
  if (opciones?.hasta) params.set("hasta", opciones.hasta);
  if (opciones?.busqueda) params.set("busqueda", opciones.busqueda);
  params.set("limit", String(opciones?.limit ?? 150));
  return getJson<Entrega[]>(`/entregas?${params.toString()}`);
};
export const fetchLogs = () => getJson<LogEvent[]>("/logs?limit=150");

// Historial completo de una entrega (todos sus productos) -- el filtrado
// por producto se hace del lado del cliente, ver historialDeItem en page.tsx.
export const fetchHistorialEntrega = (entregaId: string) =>
  getJson<LogEvent[]>(`/logs?entidad_id=${encodeURIComponent(entregaId)}&limit=200`);

// Sedes activas -- se usan para el selector de "sede origen" al corregir una
// entrega en revision manual (ver revisarEntrega), y como paso 1 del login
// del panel FAIA (ver app/faia/page.tsx).
export const fetchSedes = () => getJson<Sede[]>("/sedes");

// Bodegueros/empleados activos de una sede -- paso 2 del login del panel
// FAIA (elegir quien esta usando el panel antes de pedir el PIN), mismo
// patron que apps/mobile/api.ts.
export const fetchEmpleados = (sedeId: string) =>
  getJson<EmpleadoBasico[]>(`/empleados?sede_id=${encodeURIComponent(sedeId)}`);

// Login por PIN (POST /auth/pin) -- el empleado ya se eligio en el paso
// anterior, aca el PIN solo confirma esa identidad puntual. Devuelve 401 con
// { detail: "PIN incorrecto" } si no matchea.
export async function loginConPin(pin: string, empleadoId: string): Promise<Empleado> {
  const res = await fetch(`${API_BASE_URL}/auth/pin`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pin, empleado_id: empleadoId }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.detail ?? `No se pudo iniciar sesión (${res.status})`);
  }
  return res.json();
}

// Documento marcado FAIA (es_faia = true) -- solo identificacion/foto, sin
// cantidades ni items editables (ver GET /entregas/faia en el backend).
export interface EntregaFaia {
  id: string;
  tipo: string;
  indicativo_numero: string;
  sede_origen_id: string;
  sede_origen_nombre: string | null;
  // Quien facturo (join en el backend con empleados.operador_id) -- null si
  // no matchea ningun empleado.
  operador_nombre: string | null;
  evidencia_url: string;
  capturado_at: string;
}

// Rol-gateado server-side (403 si el empleado no es faia_viewer/supervisor/
// admin) -- el panel FAIA igual filtra antes de llamar, ver app/faia/page.tsx.
export async function fetchEntregasFaia(empleadoId: string): Promise<EntregaFaia[]> {
  const res = await fetch(`${API_BASE_URL}/entregas/faia?empleado_id=${encodeURIComponent(empleadoId)}`, {
    cache: "no-store",
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.detail ?? `No se pudieron cargar los documentos FAIA (${res.status})`);
  }
  return res.json();
}

export async function revisarEntrega(
  id: string,
  campos: {
    tipo?: string;
    indicativo_numero?: string;
    sede_origen_id?: string;
    operador_id?: string;
    capturado_at?: string;
    traslado_tipo?: string;
    traslado_indicativo_numero?: string;
    // false = guarda las correcciones sin tocar el estado (para poder
    // corregir un dato sin aprobar todavia, o para una entrega con items
    // pendientes que ya esta "procesada" y no hay que forzar). Si se omite,
    // el backend asume true (comportamiento historico: guarda y aprueba).
    aprobar?: boolean;
  }
): Promise<Entrega> {
  const res = await apiFetch(`/entregas/${id}/revisar`, {
    method: "PATCH",
    headers: JSON_HEADERS,
    body: JSON.stringify(campos),
  });
  if (!res.ok) {
    throw new Error(await mensajeDeError(res, "No se pudo guardar la entrega"));
  }
  return res.json();
}

// Usuario de la sesion para los campos operador_id que el backend aun exige.
const operadorSesion = () => leerSesion()?.usuario.usuario ?? "supervisor";

// Correccion de items desde el dashboard: siempre valores absolutos (el
// supervisor corrige el dato, no "entrega hoy" como el movil) — ver
// PATCH /entregas/{id}/items en el backend.
export async function actualizarItems(
  entregaId: string,
  items: { id: string; descripcion: string; cantidad_entregada: number; cantidad_pendiente: number }[],
  // Nota a nivel documento completo (distinta de la nota por item, que va
  // arriba en `items`). undefined deja el valor actual sin tocar; "" SI
  // borra la nota.
  notaGeneral?: string
): Promise<{ id: string; items: ItemEntrega[] }> {
  // operador_id sigue siendo obligatorio en el payload; con sesion el backend
  // lo reemplaza por "dashboard:<usuario>" para el log, asi que aca va el
  // mismo usuario como respaldo.
  const res = await apiFetch(`/entregas/${entregaId}/items`, {
    method: "PATCH",
    headers: JSON_HEADERS,
    body: JSON.stringify({ items, operador_id: operadorSesion(), sede_id: "dashboard", nota_general: notaGeneral }),
  });
  if (!res.ok) {
    throw new Error(await mensajeDeError(res, "No se pudieron actualizar los items"));
  }
  return res.json();
}

// Borrado definitivo desde el dashboard (boton "Cancelar" de la cola de
// revision) -- solo rol admin en el backend (403 si no).
export async function eliminarEntrega(id: string): Promise<void> {
  const res = await apiFetch(`/entregas/${id}/definitivo`, { method: "DELETE" });
  if (!res.ok) {
    throw new Error(await mensajeDeError(res, "No se pudo eliminar la entrega"));
  }
}

// DELETE /entregas/{id} (con sesion exige admin o supervisor; lo usa tambien
// el mobile sin sesion) -- distinto de eliminarEntrega/definitivo: borra una entrega
// que NO este en pendiente_revision, siempre que ningun item haya tenido
// todavia una entrega parcial (cantidad_pendiente === cantidad_entregada en
// todos, ver cancelar_entrega_no_confirmada en el backend). Idempotente: si
// no aplica, no rompe nada, solo devuelve cancelado:false.
export async function cancelarEntrega(id: string): Promise<{ cancelado: boolean }> {
  // operador_id/sede_id son opcionales en el backend (default "desconocido"),
  // pero se mandan explicitos para que el log de auditoria (actor_id) diga
  // "supervisor"/"dashboard" en vez de eso -- mismo criterio que actualizarItems.
  const res = await apiFetch(
    `/entregas/${id}?operador_id=${encodeURIComponent(operadorSesion())}&sede_id=dashboard`,
    { method: "DELETE" }
  );
  if (!res.ok) {
    throw new Error(await mensajeDeError(res, "No se pudo cancelar el pedido"));
  }
  return res.json();
}

// "Zona de peligro" -- borra TODAS las entregas y logs. Solo admin, igual
// que eliminarEntrega.
export async function eliminarTodasLasEntregas(): Promise<{ entregas_borradas: number; logs_borrados: number }> {
  const res = await apiFetch(`/entregas/todas`, { method: "DELETE" });
  if (!res.ok) {
    throw new Error(await mensajeDeError(res, "No se pudo limpiar el sistema"));
  }
  return res.json();
}

// Exports de entregas -- requieren sesion (Authorization: Bearer), asi que no
// se pueden bajar con un <a href>: se piden por apiFetch y se entregan al
// navegador como blob.
// - CSV: una fila por producto (item).
// - XLSX: reporte mensual real (una hoja por mes, columnas por tipo de
//   documento), a nivel de documento -- para mandarle el control a un superior.
export type FormatoExport = "csv" | "xlsx";

export async function descargarExport(formato: FormatoExport): Promise<void> {
  const res = await apiFetch(`/entregas/export.${formato}`);
  if (!res.ok) {
    throw new Error(await mensajeDeError(res, "No se pudo descargar el archivo"));
  }
  // Nombre fijo del lado del cliente: Content-Disposition no es legible desde
  // otro origen sin expose_headers en el CORS del backend.
  const nombre = formato === "csv" ? "entregas.csv" : "reporte_mensual.xlsx";
  const url = URL.createObjectURL(await res.blob());
  const enlace = document.createElement("a");
  enlace.href = url;
  enlace.download = nombre;
  document.body.appendChild(enlace);
  enlace.click();
  enlace.remove();
  URL.revokeObjectURL(url);
}

// Catalogo codigo -> nombre de producto (ver apps/backend/app/services/productos.py)
// -- se auto-completa al procesar/corregir facturas; esto es solo para
// consultarlo y para completar/corregir a mano lo que la extraccion
// automatica no pudo resolver.
export interface Producto {
  id: string;
  codigo: string;
  nombre: string;
  creado_at: string;
}

export const fetchProductos = (buscar?: string) =>
  getJson<Producto[]>(`/productos${buscar ? `?buscar=${encodeURIComponent(buscar)}` : ""}`);

export async function crearProducto(datos: { codigo: string; nombre: string }): Promise<Producto> {
  const res = await apiFetch(`/productos`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(datos),
  });
  if (!res.ok) {
    throw new Error(await mensajeDeError(res, "No se pudo crear el producto"));
  }
  return res.json();
}

export async function actualizarProducto(
  id: string,
  cambios: { codigo?: string; nombre?: string },
): Promise<Producto> {
  const res = await apiFetch(`/productos/${id}`, {
    method: "PATCH",
    headers: JSON_HEADERS,
    body: JSON.stringify(cambios),
  });
  if (!res.ok) {
    throw new Error(await mensajeDeError(res, "No se pudo actualizar el producto"));
  }
  return res.json();
}

// Traslados entre puntos con su numero Syscafe (ver GET /traslados-puntos/syscafe
// en el backend): traslados y hojas anuladas del talonario, pendientes primero.
// Se llena desde la app movil (Supervision) o desde la pagina /traslados.
// "directo": mercancia que llega del proveedor al punto (sin origen ni despacho).
export type TipoTraslado = "entre_puntos" | "directo";

export interface FilaTrasladoSyscafe {
  tipo: "traslado" | "anulada";
  id: string;
  consecutivo: number | null;
  numero_talonario: string | null;
  talonario_id: string | null;
  numero_syscafe: string | null;
  // null en una llegada directa.
  punto_origen_id: string | null;
  punto_origen_nombre: string | null;
  // Clase de traslado; null en las hojas anuladas.
  tipo_traslado: TipoTraslado | null;
  punto_destino_id: string | null;
  punto_destino_nombre: string | null;
  estado: string;
  fecha: string;
  created_at: string;
  // Solo en las anuladas.
  motivo: string | null;
  anulado_por_nombre: string | null;
}

// desde/hasta: "YYYY-MM-DD" inclusivos (fecha del traslado; en anuladas, la de creacion).
export const listarTrasladosSyscafe = (
  filtros: { puntoId?: string; pendientes?: boolean; desde?: string; hasta?: string } = {},
) => {
  const params = new URLSearchParams();
  if (filtros.puntoId) params.set("punto_id", filtros.puntoId);
  if (filtros.pendientes) params.set("pendientes", "true");
  if (filtros.desde) params.set("desde", filtros.desde);
  if (filtros.hasta) params.set("hasta", filtros.hasta);
  const query = params.toString();
  return getJson<FilaTrasladoSyscafe[]>(`/traslados-puntos/syscafe${query ? `?${query}` : ""}`);
};

// Detalle de un traslado (GET /traslados-puntos/{id}). Las URLs de foto/firmas
// ya son URLs publicas de Storage (las guarda asi la app movil).
export interface ItemTrasladoDetalle {
  id: string;
  producto: string;
  marca: string;
  presentacion: string;
  cantidad: number;
  cantidad_recibida: number | null;
  novedad: string | null;
  fecha_vencimiento: string | null;
}

export interface TrasladoDetalle {
  id: string;
  consecutivo: number;
  tipo: TipoTraslado;
  numero_talonario: string | null;
  talonario_id: string | null;
  numero_syscafe: string | null;
  numero_syscafe_at: string | null;
  numero_syscafe_por: string | null;
  punto_origen_nombre: string | null;
  punto_destino_nombre: string | null;
  transportador_nombre: string;
  fecha: string;
  estado: string;
  observaciones: string | null;
  novedad: string | null;
  novedad_estado: string | null;
  solucion: string | null;
  consecutivo_solucion: string | null;
  solucionado_por_nombre: string | null;
  solucionado_at: string | null;
  creado_por_nombre: string | null;
  created_at: string;
  recibido_por_nombre: string | null;
  recibido_at: string | null;
  declaracion_aceptada_at: string | null;
  foto_talonario_url: string | null;
  // Texto libre de la hoja en una llegada directa.
  contenido_texto?: string | null;
  firma_despacha_url: string | null;
  firma_transporta_url: string | null;
  firma_recibe_url: string | null;
  items: ItemTrasladoDetalle[];
}

export const fetchTrasladoDetalle = (id: string) => getJson<TrasladoDetalle>(`/traslados-puntos/${id}`);

// Evento del punto sobre un traslado (GET /traslados-puntos/{id}/historial):
// envio, recepcion y novedad, del mas antiguo al mas reciente.
export interface EventoHistorialTraslado {
  evento: string;
  momento: string;
  resultado: string;
  detalle: Record<string, unknown>;
  actor_nombre: string | null;
  punto_nombre: string | null;
}

export const fetchHistorialTraslado = (id: string) =>
  getJson<EventoHistorialTraslado[]>(`/traslados-puntos/${id}/historial`);

// Feed de actividad reciente del panel de traslados, en lenguaje simple.
export interface ActividadTraslado {
  tipo: "envio" | "recepcion" | "solucion" | "syscafe" | "anulada";
  momento: string;
  texto: string;
  traslado_id: string | null;
}

export const fetchActividadTraslados = (limite = 50) =>
  getJson<ActividadTraslado[]>(`/traslados-puntos/actividad?limite=${limite}`);

// Talonarios activos de cada punto (GET /talonarios-puntos/resumen): uno por
// letra; un punto con la lista vacia todavia no configuro ninguno.
export interface TalonarioActivo {
  id: string;
  letra: string;
  rango: string;
  siguiente_hoja: string | null;
  quedan: number;
  agotado: boolean;
  umbral_aviso: number;
}

export interface ResumenTalonarioPunto {
  punto_id: string;
  punto_nombre: string;
  talonarios: TalonarioActivo[];
}

export const fetchResumenTalonarios = () => getJson<ResumenTalonarioPunto[]>("/talonarios-puntos/resumen");

export const fetchPuntosPublicos = () => getJson<{ id: string; nombre: string; codigo: string | null }[]>("/puntos");

// Guarda (o borra, con null) el numero Syscafe de un traslado. Requiere sesion
// admin/supervisor; 422 si el formato no es CODIGO-NUMERO, 409 si ya lo tiene
// otro traslado (el mensaje nombra la hoja de ese otro).
export async function asignarSyscafeDashboard(trasladoId: string, numeroSyscafe: string | null): Promise<void> {
  const res = await apiFetch(`/traslados-puntos/${trasladoId}/syscafe/dashboard`, {
    method: "PATCH",
    headers: JSON_HEADERS,
    body: JSON.stringify({ numero_syscafe: numeroSyscafe }),
  });
  if (!res.ok) {
    throw new Error(await mensajeDeError(res, "No se pudo guardar el número Syscafe"));
  }
}

// Ranking de productos mas/menos vendidos en un rango de fechas (ver GET
// /ranking/productos en el backend) -- se agrega en Python a partir de
// entrega_items, sin agregacion en SQL (ver apps/backend/app/services/ranking.py).
export interface RankingProductoItem {
  codigo: string | null;
  nombre: string;
  cantidad_total: number;
  entregas_count: number;
}

export interface RankingProductosResponse {
  desde: string;
  hasta: string;
  sede_id: string | null;
  mas_vendidos: RankingProductoItem[];
  menos_vendidos: RankingProductoItem[];
}

export const fetchRankingProductos = (opciones: {
  desde: string;
  hasta: string;
  sedeId?: string;
  limit?: number;
}) => {
  const params = new URLSearchParams({ desde: opciones.desde, hasta: opciones.hasta });
  if (opciones.sedeId) params.set("sede_id", opciones.sedeId);
  if (opciones.limit) params.set("limit", String(opciones.limit));
  return getJson<RankingProductosResponse>(`/ranking/productos?${params.toString()}`);
};

// Carga de trabajo por dia/hora local y bloques de turno sugeridos de una sede
// (ver GET /turnos/carga y app/services/turnos.py en el backend) -- pagina
// /turnos. `dia`: 0 = lunes ... 6 = domingo.
export interface CeldaCarga {
  dia: number;
  hora: number;
  promedio: number;
  pico: boolean;
}

export interface BloqueTurno {
  dia: string;
  dia_indice: number;
  hora_inicio: string;
  hora_fin: string;
  personal_sugerido: number;
  carga_maxima: number;
}

export interface CargaTurnosResponse {
  sede_id: string;
  semanas: number;
  umbral_pico: number | null;
  celdas: CeldaCarga[];
  bloques: BloqueTurno[];
}

export const fetchCargaTurnos = (sedeId: string, semanas: number) =>
  getJson<CargaTurnosResponse>(
    `/turnos/carga?${new URLSearchParams({ sede_id: sedeId, semanas: String(semanas) }).toString()}`
  );

// --- Administracion (pantalla /creador) ---------------------------------
// Todos estos endpoints exigen sesion de rol admin (Bearer, ver apiFetch). El
// PIN solo viaja hacia el backend (alta y reset); nunca vuelve en las
// respuestas.

// Error de una llamada de administracion con el codigo HTTP: el 409 de un
// borrado ("tiene historial") se distingue de un fallo cualquiera para ofrecer
// desactivar en su lugar.
export class ErrorAdmin extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = "ErrorAdmin";
  }
}

async function adminFetch<T>(path: string, opciones?: { method?: string; body?: unknown }): Promise<T> {
  const res = await apiFetch(path, {
    method: opciones?.method ?? "GET",
    cache: "no-store",
    headers: opciones?.body !== undefined ? JSON_HEADERS : undefined,
    body: opciones?.body !== undefined ? JSON.stringify(opciones.body) : undefined,
  });
  if (!res.ok) {
    throw new ErrorAdmin(await mensajeDeError(res, "La solicitud falló"), res.status);
  }
  return res.json();
}

// DELETE de administracion: solo borra registros que nunca se usaron; con
// historial el backend responde 409 con el motivo (ver borrado_admin.py).
const eliminarAdmin = (path: string) => adminFetch<{ ok: boolean }>(path, { method: "DELETE" });

export interface SedeAdmin {
  id: string;
  nombre: string;
  codigo: string;
  direccion: string;
  timezone: string;
  activa: boolean;
}

export interface EmpleadoAdmin {
  id: string;
  nombre: string;
  sede_id: string;
  rol: RolEmpleado;
  estado: "activo" | "inactivo";
}

export interface PuntoAdmin {
  id: string;
  nombre: string;
  codigo: string | null;
  activo: boolean;
}

export interface UsuarioPuntoAdmin {
  id: string;
  nombre: string;
  punto_id: string;
  estado: "activo" | "inactivo";
}

export interface SupervisorAdmin {
  id: string;
  nombre: string;
  estado: "activo" | "inactivo";
}

export interface TipoDocumentoAdmin {
  codigo: string;
  descripcion: string;
  activo: boolean;
}

export const fetchSedesAdmin = () => adminFetch<SedeAdmin[]>("/sedes?incluir_inactivas=true");
export const crearSede = (datos: { nombre: string; codigo: string; direccion?: string; timezone?: string }
) => adminFetch<{ id: string }>("/sedes", { method: "POST", body: datos });
export const actualizarSede = (id: string,
  cambios: { nombre?: string; direccion?: string; activa?: boolean }
) => adminFetch<SedeAdmin>(`/sedes/${id}`, { method: "PATCH", body: cambios });

export const eliminarSede = (id: string) => eliminarAdmin(`/sedes/${id}`);

export const fetchEmpleadosAdmin = () =>
  adminFetch<EmpleadoAdmin[]>("/empleados?incluir_inactivos=true");
export const crearEmpleado = (datos: { nombre: string; sede_id: string; rol: RolEmpleado; pin: string }
) => adminFetch<EmpleadoAdmin>("/empleados", { method: "POST", body: datos });
export const actualizarEmpleado = (id: string,
  cambios: { nombre?: string; sede_id?: string; rol?: RolEmpleado; estado?: "activo" | "inactivo" }
) => adminFetch<EmpleadoAdmin>(`/empleados/${id}`, { method: "PATCH", body: cambios });
export const eliminarEmpleado = (id: string) => eliminarAdmin(`/empleados/${id}`);
export const resetearPinEmpleado = (id: string, pin: string) =>
  adminFetch<{ ok: boolean }>(`/empleados/${id}/pin`, { method: "POST", body: { pin } });

export const fetchPuntosAdmin = () => adminFetch<PuntoAdmin[]>("/puntos?incluir_inactivos=true");
export const crearPunto = (nombre: string) =>
  adminFetch<{ id: string; nombre: string }>("/puntos", { method: "POST", body: { nombre } });
export const actualizarPunto = (id: string, cambios: { nombre?: string; activo?: boolean }) =>
  adminFetch<PuntoAdmin>(`/puntos/${id}`, { method: "PATCH", body: cambios });

export const eliminarPunto = (id: string) => eliminarAdmin(`/puntos/${id}`);

export const fetchUsuariosPuntoAdmin = (puntoId: string) =>
  adminFetch<UsuarioPuntoAdmin[]>(`/puntos/${puntoId}/usuarios?incluir_inactivos=true`);
export const crearUsuarioPunto = (puntoId: string, datos: { nombre: string; pin: string }) =>
  adminFetch<UsuarioPuntoAdmin>(`/puntos/${puntoId}/usuarios`, { method: "POST", body: datos });
export const actualizarUsuarioPunto = (id: string,
  cambios: { nombre?: string; estado?: "activo" | "inactivo" }
) => adminFetch<UsuarioPuntoAdmin>(`/puntos/usuarios/${id}`, { method: "PATCH", body: cambios });
export const eliminarUsuarioPunto = (id: string) => eliminarAdmin(`/puntos/usuarios/${id}`);
export const resetearPinUsuarioPunto = (id: string, pin: string) =>
  adminFetch<{ ok: boolean }>(`/puntos/usuarios/${id}/pin`, { method: "POST", body: { pin } });

export const fetchSupervisoresAdmin = () =>
  adminFetch<SupervisorAdmin[]>("/supervisores?incluir_inactivos=true");
export const crearSupervisor = (datos: { nombre: string; pin: string }) =>
  adminFetch<SupervisorAdmin>("/supervisores", { method: "POST", body: datos });
export const actualizarSupervisor = (id: string,
  cambios: { nombre?: string; estado?: "activo" | "inactivo" }
) => adminFetch<SupervisorAdmin>(`/supervisores/${id}`, { method: "PATCH", body: cambios });
export const eliminarSupervisor = (id: string) => eliminarAdmin(`/supervisores/${id}`);
export const resetearPinSupervisor = (id: string, pin: string) =>
  adminFetch<{ ok: boolean }>(`/supervisores/${id}/pin`, { method: "POST", body: { pin } });

// DELETE /productos/{id}: quita el producto del catalogo (sin historial que
// proteger). Si una entrega futura trae el mismo codigo, se vuelve a crear solo.
export const eliminarProducto = (id: string) => eliminarAdmin(`/productos/${encodeURIComponent(id)}`);

export const eliminarTipoDocumento = (codigo: string) =>
  eliminarAdmin(`/tipos-documento/${encodeURIComponent(codigo)}`);

export const fetchTiposDocumentoAdmin = () =>
  adminFetch<TipoDocumentoAdmin[]>("/tipos-documento?incluir_inactivos=true");
export const crearTipoDocumento = (datos: { codigo: string; descripcion: string }) =>
  adminFetch<TipoDocumentoAdmin>("/tipos-documento", { method: "POST", body: datos });
export const actualizarTipoDocumento = (codigo: string,
  cambios: { descripcion?: string; activo?: boolean }
) => adminFetch<TipoDocumentoAdmin>(`/tipos-documento/${encodeURIComponent(codigo)}`, { method: "PATCH", body: cambios });

// --- Sesion y usuarios del dashboard (login con roles) -------------------

// POST /dashboard/auth/login -- 401 "Usuario o contraseña incorrectos", 423
// "Demasiados intentos...". Va con fetch plano (no apiFetch): un 401 aca no es
// "sesion expirada" sino credenciales malas.
export async function loginDashboard(usuario: string, password: string): Promise<Sesion> {
  const res = await fetch(`${API_BASE_URL}/dashboard/auth/login`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ usuario, password }),
  });
  if (!res.ok) {
    throw new Error(await mensajeDeError(res, "No se pudo iniciar sesión"));
  }
  return res.json();
}

// Usuario de la sesion actual (refresca nombre/rol por si un admin los cambio).
export const fetchYo = () => getJson<UsuarioDashboard>("/dashboard/auth/yo");

export async function cambiarPassword(actual: string, nueva: string): Promise<void> {
  const res = await apiFetch("/dashboard/auth/cambiar-password", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ actual, nueva }),
  });
  if (!res.ok) {
    throw new Error(await mensajeDeError(res, "No se pudo cambiar la contraseña"));
  }
}

export interface UsuarioDashboardAdmin extends UsuarioDashboard {
  activo: boolean;
  creado_at: string;
  ultimo_login_at: string | null;
  bloqueado_hasta: string | null;
}

export const fetchUsuariosDashboard = () => adminFetch<UsuarioDashboardAdmin[]>("/dashboard/usuarios");
export const crearUsuarioDashboard = (datos: {
  usuario: string;
  nombre: string;
  rol: RolDashboard;
  area: AreaDashboard;
  password: string;
}) => adminFetch<UsuarioDashboardAdmin>("/dashboard/usuarios", { method: "POST", body: datos });
export const actualizarUsuarioDashboard = (
  id: string,
  cambios: { nombre?: string; rol?: RolDashboard; area?: AreaDashboard; activo?: boolean }
) => adminFetch<UsuarioDashboardAdmin>(`/dashboard/usuarios/${id}`, { method: "PATCH", body: cambios });
export const eliminarUsuarioDashboard = (id: string) => eliminarAdmin(`/dashboard/usuarios/${id}`);
export const resetearPasswordUsuarioDashboard = (id: string, password: string) =>
  adminFetch<{ ok: boolean }>(`/dashboard/usuarios/${id}/password`, { method: "POST", body: { password } });
