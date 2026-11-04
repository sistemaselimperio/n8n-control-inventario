"use client";

// Piezas de presentacion compartidas entre las pantallas del dashboard --
// tema claro "verde salvia" (tokens definidos en globals.css: page, surface,
// line, muted, ok, brand-gold, etc.). El verde de marca (ok) es la accion
// primaria y la seleccion; el ambar (brand-gold / warn) marca lo pendiente y el
// texto con sentido ambar usa gold-fg. Tipografia IBM Plex Sans; .cifra (Plex
// Mono tabular) para identificadores y cifras, .titular para el titulo de
// pagina (22px). Tarjetas rounded-lg con borde de 1px, controles rounded-md,
// pildoras rounded-full. Sin sombras ni degradados. Sin logica de negocio: solo
// reciben datos ya resueltos por cada pagina.

import type { ButtonHTMLAttributes, ReactNode } from "react";

// Indicador KPI -- tarjeta compacta sin iconos: rotulo en minusculas de 12px,
// cifra de 26px (.cifra) y detalle de una linea. Mismas props que antes;
// `acento` se acepta por compatibilidad pero ya no se pinta (el color no es la
// unica pista).
export function Indicador({
  etiqueta,
  valor,
  unidad,
  detalle,
  cargando,
  plano = false,
}: {
  etiqueta: string;
  valor: string;
  unidad?: string;
  detalle?: string;
  acento?: string;
  cargando: boolean;
  // plano: sin borde ni radio propios, para colgar de un tablero con reglas
  // (contenedor con `gap-px bg-line`).
  plano?: boolean;
}) {
  return (
    <div
      className={`flex flex-col gap-1 bg-surface px-4 py-3 ${
        plano ? "" : "rounded-lg border border-line transition-colors duration-150 hover:border-line-strong"
      }`}
    >
      <span className="text-xs font-medium text-muted">{etiqueta}</span>
      {cargando ? (
        <div className="flex flex-col gap-2 pt-0.5">
          <div className="h-[26px] w-24 animate-pulse rounded bg-surface-2" />
          <div className="h-3 w-40 animate-pulse rounded bg-surface-2" />
        </div>
      ) : (
        <>
          <p className="flex items-baseline gap-1.5">
            <span className="cifra text-[26px] text-ink">{valor}</span>
            {unidad ? <span className="text-xs text-muted">{unidad}</span> : null}
          </p>
          <p className="truncate text-xs text-muted" title={detalle}>
            {detalle ?? "Sin datos"}
          </p>
        </>
      )}
    </div>
  );
}

// Caja de error roja con boton "Reintentar" -- pensada para colgar de
// `mutate` de SWR (o cualquier otro callback de recarga).
export function ErrorConReintento({
  mensaje,
  onReintentar,
}: {
  mensaje: string;
  onReintentar: () => void;
}) {
  return (
    <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger-fg">
      <span>{mensaje}</span>
      <button
        onClick={onReintentar}
        className="min-h-11 cursor-pointer rounded-md border border-danger/40 px-3 py-1 text-xs font-medium text-danger-fg transition-colors duration-150 hover:bg-danger/15"
      >
        Reintentar
      </button>
    </div>
  );
}

// Estado vacio centrado de dos lineas -- titulo + ayuda chica.
export function EstadoVacio({ titulo, ayuda }: { titulo: string; ayuda?: string }) {
  return (
    <div className="flex flex-col items-center gap-1 py-10 text-center">
      <p className="text-sm text-muted">{titulo}</p>
      {ayuda ? <p className="text-xs text-subtle">{ayuda}</p> : null}
    </div>
  );
}

// Bloque skeleton generico (animate-pulse) -- para armar filas/lineas de
// carga con el ancho que pida cada pantalla.
export function SkeletonLinea({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse rounded bg-surface-2 ${className}`} />;
}

// Panel con reglas -- una sola superficie con encabezado separado por una
// linea (en vez de una tarjeta suelta por bloque). El contenido va debajo,
// sin relleno propio salvo `conRelleno`, para que tablas y listas lleguen al
// borde. `id` permite enlazarlo desde una navegacion interna.
export function Panel({
  id,
  titulo,
  subtitulo,
  conteo,
  acciones,
  conRelleno = true,
  children,
  className = "",
}: {
  id?: string;
  titulo: ReactNode;
  subtitulo?: ReactNode;
  conteo?: string;
  acciones?: ReactNode;
  conRelleno?: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      id={id}
      aria-labelledby={id ? `${id}-titulo` : undefined}
      className={`scroll-mt-20 overflow-hidden rounded-lg border border-line bg-surface ${className}`}
    >
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-4 py-3 sm:px-5">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h2 id={id ? `${id}-titulo` : undefined} className="text-base font-semibold text-ink">
            {titulo}
            {conteo ? <span className="ml-2 text-sm font-normal tabular-nums text-muted">{conteo}</span> : null}
          </h2>
          {subtitulo ? <p className="text-xs text-muted">{subtitulo}</p> : null}
        </div>
        {acciones ? <div className="flex flex-wrap items-center gap-2">{acciones}</div> : null}
      </header>
      <div className={conRelleno ? "p-4 sm:p-5" : ""}>{children}</div>
    </section>
  );
}

// Control segmentado -- grupo de botones con aria-pressed para elegir una
// opcion entre pocas (periodo, semana, sede). Las opciones con `deshabilitada`
// no se pueden elegir. Cada segmento mide al menos 44px de alto.
export function Segmentado<T extends string>({
  etiqueta,
  opciones,
  valor,
  onCambiar,
}: {
  etiqueta: string;
  opciones: ReadonlyArray<{ valor: T; etiqueta: string; deshabilitada?: boolean }>;
  valor: T | null;
  onCambiar: (valor: T) => void;
}) {
  return (
    <div role="group" aria-label={etiqueta} className="inline-flex flex-wrap gap-1 rounded-md border border-line-strong bg-surface-2 p-1">
      {opciones.map((opcion) => {
        const activa = opcion.valor === valor;
        return (
          <button
            key={opcion.valor}
            type="button"
            onClick={() => onCambiar(opcion.valor)}
            aria-pressed={activa}
            disabled={opcion.deshabilitada}
            className={`min-h-10 rounded px-3 text-sm font-medium transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-50 ${
              activa ? "bg-ok text-ok-on" : "text-soft hover:bg-surface hover:text-ink"
            }`}
          >
            {opcion.etiqueta}
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Primitivas nuevas (opcionales): botones, pildoras de estado y encabezado.
// ---------------------------------------------------------------------------

export type VarianteBoton = "primario" | "secundario" | "fantasma" | "peligro";

// Clases base de boton -- exportadas como string para poder aplicarlas
// tambien a <Link> o <a> sin envolver en <button>.
export function claseBoton(variante: VarianteBoton = "secundario", extra = ""): string {
  const base =
    "inline-flex min-h-11 cursor-pointer items-center justify-center gap-2 rounded-md px-3.5 py-2 text-sm font-medium transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-50";
  const variantes: Record<VarianteBoton, string> = {
    primario: "bg-ok text-ok-on hover:bg-ok-hover font-semibold",
    secundario: "border border-line-strong bg-surface-2 text-ink hover:bg-line",
    fantasma: "text-muted hover:bg-surface-2 hover:text-ink",
    peligro: "bg-danger-solid text-white font-semibold hover:brightness-90",
  };
  return `${base} ${variantes[variante]} ${extra}`.trim();
}

export function Boton({
  variante = "secundario",
  className = "",
  type = "button",
  ...props
}: { variante?: VarianteBoton } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button type={type} className={claseBoton(variante, className)} {...props} />;
}

export type TonoPildora = "ok" | "warn" | "error" | "info" | "neutro";

const TONOS_PILDORA: Record<TonoPildora, string> = {
  ok: "border-ok-fg/40 bg-ok-fg/10 text-ok-fg",
  warn: "border-warn/40 bg-warn-fill/20 text-warn",
  error: "border-danger/40 bg-danger/10 text-danger-fg",
  info: "border-info/40 bg-info/10 text-info",
  neutro: "border-line-strong bg-surface-2 text-soft",
};

// Pildora de estado con tono semantico (procesada = ok, pendiente = warn,
// duplicado = error).
export function Pildora({
  tono = "neutro",
  children,
  className = "",
}: {
  tono?: TonoPildora;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium ${TONOS_PILDORA[tono]} ${className}`}
    >
      {children}
    </span>
  );
}

// Encabezado de pagina: titulo (.titular a 22px) + subtitulo corto de una o
// dos lineas, con una zona de acciones opcional a la derecha. `sobretitulo` se
// conserva por compatibilidad (texto chico y apagado sobre el titulo).
export function EncabezadoPagina({
  sobretitulo,
  titulo,
  descripcion,
  acciones,
}: {
  sobretitulo?: string;
  titulo: string;
  descripcion?: ReactNode;
  acciones?: ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-x-4 gap-y-3">
      <div className="flex min-w-0 max-w-3xl flex-col gap-1">
        {sobretitulo ? <p className="text-sm text-muted">{sobretitulo}</p> : null}
        <h1 className="titular text-[22px] leading-tight text-ink">{titulo}</h1>
        {descripcion ? <p className="text-sm leading-relaxed text-muted">{descripcion}</p> : null}
      </div>
      {acciones ? <div className="flex flex-wrap items-center gap-2">{acciones}</div> : null}
    </header>
  );
}

// Clase comun de los campos de filtro (select, input, fecha): 44px de alto.
export const CLASE_CAMPO =
  "min-h-11 rounded-md border border-line-strong bg-surface px-3 text-sm text-ink placeholder:text-subtle";

// Campo de filtro: rotulo de 12px sobre el control.
export function CampoFiltro({
  id,
  etiqueta,
  children,
  className = "",
}: {
  id: string;
  etiqueta: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`flex flex-col gap-1 ${className}`}>
      <label htmlFor={id} className="text-xs font-medium text-muted">
        {etiqueta}
      </label>
      {children}
    </div>
  );
}

// Tarjeta de filtros: agrupa los controles de una pantalla en una sola
// superficie, encima del contenido. `resumen` (conteo de filas, por ejemplo)
// va alineado a la derecha.
export function TarjetaFiltros({
  etiqueta,
  resumen,
  children,
  className = "",
}: {
  etiqueta: string;
  resumen?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section aria-label={etiqueta} className={`rounded-lg border border-line bg-surface p-4 ${className}`}>
      <div className="flex flex-wrap items-end gap-3">
        {children}
        {resumen ? (
          <p className="ml-auto text-sm tabular-nums text-muted" aria-live="polite">
            {resumen}
          </p>
        ) : null}
      </div>
    </section>
  );
}

// Clases de tabla: encabezado de 12px apagado, filas con regla fina, zebra
// suave en filas pares y resalte al pasar el cursor (sobre fondo claro).
export const CLASE_TABLA = "w-full text-left text-sm";
export const CLASE_THEAD = "border-b border-line text-xs text-muted";
export const CLASE_TBODY = "divide-y divide-line [&>tr:nth-child(even)]:bg-page/60";
export const CLASE_FILA_CLICABLE =
  "min-h-11 cursor-pointer transition-colors duration-150 hover:bg-surface-2! focus-visible:bg-surface-2!";

// ---------------------------------------------------------------------------
// Iconos en linea (estilo Lucide: viewBox 24, trazo currentColor). Sin
// dependencias externas.
// ---------------------------------------------------------------------------

const RUTAS_ICONO = {
  externo: "M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6",
  reloj: "M12 6v6l4 2M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0Z",
  cerrar: "M18 6 6 18M6 6l12 12",
  mas: "M12 5v14M5 12h14",
  lapiz:
    "M21.17 6.81a1 1 0 0 0-3.99-3.99L3.84 16.17a2 2 0 0 0-.5.83l-1.32 4.35a.5.5 0 0 0 .62.62l4.35-1.32a2 2 0 0 0 .83-.5ZM15 5l4 4",
  basura: "M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2",
  check: "M20 6 9 17l-5-5",
  arriba: "m18 15-6-6-6 6",
  abajo: "m6 9 6 6 6-6",
  descarga: "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3",
  izquierda: "m12 19-7-7 7-7M19 12H5",
  derecha: "M5 12h14M12 5l7 7-7 7",
  factura:
    "M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7ZM14 2v4a2 2 0 0 0 2 2h4M10 9H8M16 13H8M16 17H8",
  camion:
    "M14 18V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v11a1 1 0 0 0 1 1h2M15 18H9M19 18h2a1 1 0 0 0 1-1v-3.65a1 1 0 0 0-.22-.624l-3.48-4.35A1 1 0 0 0 17.52 8H14M17 18a2 2 0 1 1-4 0 2 2 0 0 1 4 0ZM9 18a2 2 0 1 1-4 0 2 2 0 0 1 4 0Z",
  remision:
    "M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2M9 2h6a1 1 0 0 1 1 1v2a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1ZM12 11h4M12 16h4M8 11h.01M8 16h.01",
  revisar:
    "M2.06 12.35a1 1 0 0 1 0-.7 10.75 10.75 0 0 1 19.88 0 1 1 0 0 1 0 .7 10.75 10.75 0 0 1-19.88 0ZM15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z",
  devolucion: "M9 14 4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5 5.5 5.5 0 0 1-5.5 5.5H11",
  usuarioAdmin:
    "M5 7a4 4 0 1 0 8 0a4 4 0 1 0-8 0M10 15H6a4 4 0 0 0-4 4v2M15 15a3 3 0 1 0 6 0a3 3 0 1 0-6 0M21.7 16.4l-.9-.3M15.2 13.9l-.9-.3M16.6 18.7l.3-.9M19.1 12.2l.3-.9M19.6 18.7l-.4-1M16.8 12.3l-.4-1M14.3 16.6l1-.4M20.7 13.8l1-.4",
} as const;

export type NombreIcono = keyof typeof RUTAS_ICONO;

export function Icono({ nombre, className = "ml-1 inline h-3.5 w-3.5 align-text-bottom" }: { nombre: NombreIcono; className?: string }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={RUTAS_ICONO[nombre]} />
    </svg>
  );
}
