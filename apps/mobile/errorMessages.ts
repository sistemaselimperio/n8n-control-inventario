/**
 * Traduce los errores que ya circulan en este codigo (ver api.ts) a texto en
 * español que le sirve a un operador en terreno -- nunca la excepcion cruda
 * (stack traces, texto tecnico de Supabase, HTML de un 502 de Traefik, etc.).
 */

export type ContextoError =
  | 'login'
  | 'sedes'
  | 'puntos'
  | 'empleados'
  | 'personal_punto'
  | 'evidencia'
  | 'firma'
  | 'entrega'
  | 'devolucion'
  | 'no_entregado'
  | 'traslado'
  | 'talonario'
  | 'factura_faltante';

const MENSAJE_SERVIDOR = 'Error del servidor. Intenta de nuevo en unos minutos.';
const MENSAJE_SESION = 'PIN incorrecto o sesión no válida.';

const MENSAJES_POR_CONTEXTO: Record<ContextoError, string> = {
  login: MENSAJE_SESION,
  sedes: 'No se pudieron cargar las sedes. Intenta de nuevo.',
  // Login de Traslados: alli el lugar es un punto, no una sede.
  puntos: 'No se pudieron cargar los puntos. Intenta de nuevo.',
  empleados: 'No se pudo cargar el personal de esta sede. Intenta de nuevo.',
  personal_punto: 'No se pudo cargar la cuenta de este punto. Intenta de nuevo.',
  evidencia: 'No se pudo subir la foto. Revisá tu conexión e intentá de nuevo.',
  firma: 'No se pudo subir la firma. Revisá tu conexión e intentá de nuevo.',
  entrega: 'No se pudo procesar la entrega. Intentá de nuevo.',
  devolucion: 'No se pudo registrar la devolución. Intentá de nuevo.',
  no_entregado: 'No se pudo registrar el producto como no entregado. Intentá de nuevo.',
  // Cubre crear el traslado y confirmar la recepcion -- los dos caminos del
  // flujo de Traslados que llaman a mensajeError (ver PantallaTraslado*.tsx).
  traslado: 'No se pudo procesar el traslado. Intenta de nuevo.',
  // Configurar o anular una hoja del talonario (ver PantallaTrasladoInicio.tsx).
  talonario: 'No se pudo actualizar el talonario. Intenta de nuevo.',
  // Cubre reportar y descartar una factura faltante (ver PantallaFacturasFaltantes.tsx).
  factura_faltante: 'No se pudo procesar el reporte de factura. Intenta de nuevo.',
};

const MENSAJE_GENERICO = 'Ocurrió un error. Intenta de nuevo.';

function mensajePorContexto(contexto?: ContextoError): string {
  return contexto ? MENSAJES_POR_CONTEXTO[contexto] : MENSAJE_GENERICO;
}

// Forma que lanza parsearRespuesta en api.ts (ver ErrorEnvio) -- un objeto
// plano, nunca una instancia de Error.
function esErrorHttp(err: unknown): err is { status: number; detail?: unknown } {
  return typeof err === 'object' && err !== null && typeof (err as { status?: unknown }).status === 'number';
}

// Caso puntual manejado en PantallaCapturaFoto: el bodeguero fotografio un
// pedido que punto de venta todavia no facturo (ver "Este pedido debe ser
// facturado primero por punto de venta" en entregas.py). Igual que la foto
// ilegible, se queda en Captura en vez de navegar a Resultado -- el mensaje
// vive aca para no duplicar texto de negocio en el componente.
export function esErrorFacturacionPendiente(err: unknown): boolean {
  return (
    esErrorHttp(err) &&
    err.status === 422 &&
    typeof err.detail === 'string' &&
    err.detail.includes('facturado primero')
  );
}

export const MENSAJE_FACTURACION_PENDIENTE =
  'Este pedido todavía no fue facturado por punto de venta. Espera a que se cargue la factura antes de despachar.';

// Casos puntuales de la separacion Despachos/Remisiones (ver
// RemisionEnDespachos / DespachoEnRemisiones en duplicates.py): el backend
// responde 422 con `code` al lado de `detail`. Igual que la foto ilegible,
// no se creo nada -- se queda en Captura y se le indica la otra tab.
export function esErrorRemisionEnDespachos(err: unknown): boolean {
  return esErrorHttp(err) && err.status === 422 && (err as { code?: unknown }).code === 'remision_en_despachos';
}

export function esErrorDespachoEnRemisiones(err: unknown): boolean {
  return esErrorHttp(err) && err.status === 422 && (err as { code?: unknown }).code === 'despacho_en_remisiones';
}

export const MENSAJE_REMISION_EN_DESPACHOS =
  'Este documento es una remisión (RM2, RM3 o RSF). Cámbiate a la pestaña Remisiones para registrarla.';

export const MENSAJE_DESPACHO_EN_REMISIONES =
  'Este documento no es una remisión. En esta pestaña solo se registran remisiones (RM2, RM3 o RSF): usa la pestaña Despachos.';

// RolNoAutorizado (403 de POST /entregas/procesar): sin esto caeria en el
// mensaje generico de 401/403 de mensajeError ("PIN incorrecto o sesión no
// válida"), que aca confunde -- el PIN esta bien, es el rol el que no puede.
export function esErrorRolNoAutorizado(err: unknown): boolean {
  return esErrorHttp(err) && err.status === 403 && typeof err.detail === 'string';
}

// Caso puntual de punto_venta: fotografio una factura que ya habia
// registrado antes (ver FacturaYaRegistrada en duplicates.py) -- una
// factura se factura una sola vez. Igual que esErrorFacturacionPendiente,
// se queda en Captura sin mostrar el modal de exito (no hay nada nuevo).
export function esErrorFacturaYaRegistrada(err: unknown): boolean {
  return (
    esErrorHttp(err) &&
    err.status === 409 &&
    typeof err.detail === 'string' &&
    err.detail.includes('ya fue registrada')
  );
}

export const MENSAJE_FACTURA_YA_REGISTRADA = 'Esta factura ya fue registrada. No hace falta volver a fotografiarla.';

// Casos puntuales de POST /facturas-faltantes (409): el reporte no hace falta
// porque punto de venta ya subio la factura, o porque ya hay un reporte
// pendiente de esa misma factura. Mismo criterio que esErrorFacturaYaRegistrada.
export function esErrorFacturaYaReportada(err: unknown): boolean {
  return (
    esErrorHttp(err) &&
    err.status === 409 &&
    typeof err.detail === 'string' &&
    err.detail.includes('ya fue reportada')
  );
}

export function esErrorFacturaYaSubida(err: unknown): boolean {
  return (
    esErrorHttp(err) &&
    err.status === 409 &&
    typeof err.detail === 'string' &&
    err.detail.includes('ya fue subida')
  );
}

// POST /facturas-faltantes/{id}/marcar-subida (409): el mostrador dijo "ya la
// subi" pero esa factura todavia no esta en entregas (FacturaNoRegistrada).
export function esErrorFacturaNoRegistrada(err: unknown): boolean {
  return (
    esErrorHttp(err) &&
    err.status === 409 &&
    typeof err.detail === 'string' &&
    err.detail.includes('todavía no aparece')
  );
}

export const MENSAJE_FACTURA_YA_REPORTADA = 'Esa factura ya fue reportada y sigue pendiente. El punto de venta ya fue avisado.';

export const MENSAJE_FACTURA_YA_SUBIDA = 'Esa factura ya fue subida por el punto de venta. Puedes consultarla y despacharla.';

// Caso puntual de RecepcionTraslado: alguien mas ya confirmo la recepcion de
// este traslado (ver TrasladoYaRecibido en app/services/traslados_puntos.py
// -- 409, no 422, es un conflicto de estado). Mismo criterio que
// esErrorFacturaYaRegistrada de arriba.
export function esErrorTrasladoYaRecibido(err: unknown): boolean {
  return (
    esErrorHttp(err) &&
    err.status === 409 &&
    typeof err.detail === 'string' &&
    err.detail.includes('ya fue recibido')
  );
}

export const MENSAJE_TRASLADO_YA_RECIBIDO = 'Este traslado ya fue recibido.';

// Caso puntual de NovedadDetalle: otro supervisor (u otro dispositivo) ya
// resolvio esta misma novedad primero (ver NovedadYaResuelta en
// app/services/traslados_puntos.py -- 409, mismo criterio que
// esErrorTrasladoYaRecibido).
export function esErrorNovedadYaResuelta(err: unknown): boolean {
  return (
    esErrorHttp(err) &&
    err.status === 409 &&
    typeof err.detail === 'string' &&
    err.detail.includes('ya fue resuelta')
  );
}

export const MENSAJE_NOVEDAD_YA_RESUELTA = 'Esta novedad ya fue resuelta.';

// Caso puntual de NovedadDetalle, distinto del de arriba: la novedad en si
// sigue libre, pero el CONSECUTIVO que Erika eligio ya lo uso otra novedad
// resuelta antes (indice unico parcial sobre consecutivo_solucion, ver
// ConsecutivoDuplicado en app/services/traslados_puntos.py -- 409 con un
// detail distinto del de esErrorNovedadYaResuelta, asi el movil no confunde
// los dos casos). A diferencia de "ya fue resuelta", aca el formulario sigue
// abierto -- Erika solo tiene que cambiar el numero.
export function esErrorConsecutivoDuplicado(err: unknown): boolean {
  return (
    esErrorHttp(err) &&
    err.status === 409 &&
    typeof err.detail === 'string' &&
    err.detail.includes('consecutivo ya está registrado')
  );
}

export const MENSAJE_CONSECUTIVO_DUPLICADO = 'Ese consecutivo ya está registrado. Usa otro número.';

// Caso puntual al CONFIRMAR (no al crear): el documento pertenece a otra
// sede y la que esta confirmando no adjunto un traslado valido (ver
// NecesitaTrasladoParaConfirmar en duplicates.py) -- a diferencia de los dos
// casos de arriba, este SI trae datos que hacen falta (tipo/indicativo) para
// mostrar la tarjeta de traslado, por eso devuelve el payload en vez de solo
// un booleano. El backend manda `detail` como objeto (no texto) para este
// caso puntual -- distinto del resto de los errores de este archivo.
export function extraerNecesitaTrasladoConfirmar(
  err: unknown
): { tipo: string; indicativo_numero: string } | null {
  if (!esErrorHttp(err) || err.status !== 409) return null;
  const detail = err.detail as { situacion?: string; tipo?: string; indicativo_numero?: string } | undefined;
  if (detail?.situacion !== 'necesita_traslado') return null;
  if (typeof detail.tipo !== 'string' || typeof detail.indicativo_numero !== 'string') return null;
  return { tipo: detail.tipo, indicativo_numero: detail.indicativo_numero };
}

/**
 * `contexto` solo se usa como fallback -- cuando el error no trae ya un
 * mensaje de negocio utilizable (404/422 con detail, o los casos conocidos
 * de subida a Storage). Sin contexto devuelve un fallback generico.
 */
export function mensajeError(err: unknown, contexto?: ContextoError): string {
  // fetch() rechaza con un TypeError cuando no hay conexion -- el texto exacto
  // varia segun plataforma ("Network request failed" en React Native,
  // "Failed to fetch" en web/debugger).
  // No siempre es falta de internet: tambien pasa cuando la red (ej. un wifi
  // inestable) no logra llegar al servidor aunque haya conexion.
  if (err instanceof TypeError && /network request failed|failed to fetch/i.test(err.message)) {
    return 'No se pudo conectar con el servidor. Revisa tu conexión (wifi o datos móviles) e intenta de nuevo.';
  }

  if (esErrorHttp(err)) {
    const { status, detail } = err;
    if (status >= 500) return MENSAJE_SERVIDOR; // puede traer HTML/texto tecnico -- se ignora
    if (status === 401 || status === 403) return MENSAJE_SESION;
    if ((status === 404 || status === 422) && typeof detail === 'string' && detail.trim()) {
      // Ya son mensajes de negocio escritos a mano en el backend
      // (ExtraccionFallida, CantidadInvalida, "no se encontro ese documento", etc.).
      return detail;
    }
    // 409 del talonario (sin talonario, agotado, o la hoja ya la uso otra
    // persona): el detail ya dice que hoja toca ahora, se muestra tal cual.
    if (status === 409 && (contexto === 'traslado' || contexto === 'talonario') && typeof detail === 'string' && detail.trim()) {
      return detail;
    }
    return mensajePorContexto(contexto);
  }

  if (err instanceof Error) {
    // Timeout de api.ts (fetchConTimeout / conLimite): el mensaje ya viene listo.
    if (err.name === 'TimeoutError') return err.message;
    // Se agrega el mensaje real de Supabase Storage entre parentesis -- antes
    // esto se tapaba con "revisá tu conexión", que es enganioso cuando la
    // causa real es un permiso (RLS) o el tipo/tamano de archivo, no la red.
    if (err.message.startsWith('No se pudo subir la evidencia:')) {
      const detalle = err.message.slice('No se pudo subir la evidencia:'.length).trim();
      return `No se pudo subir la foto${detalle ? ` (${detalle})` : ''}. Revisá tu conexión e intentá de nuevo.`;
    }
    if (err.message.startsWith('No se pudo subir la firma:')) {
      const detalle = err.message.slice('No se pudo subir la firma:'.length).trim();
      return `No se pudo subir la firma${detalle ? ` (${detalle})` : ''}. Revisá tu conexión e intentá de nuevo.`;
    }
  }

  return mensajePorContexto(contexto);
}
