"use client";

// Piezas compartidas de las barras de filtros (Entregas y Traslados):
// pestañas subrayadas con conteo, el boton-menu "Etiqueta: valor" y los
// atajos de fecha (Hoy, Ultimos 7 dias, Este mes, Elegir fechas).

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Icono, type TonoPildora } from "@/components/ui";

export type ModoFecha = "todas" | "hoy" | "7dias" | "mes" | "elegir";

export const ATAJOS_FECHA: { valor: ModoFecha; texto: string }[] = [
  { valor: "todas", texto: "Todas las fechas" },
  { valor: "hoy", texto: "Hoy" },
  { valor: "7dias", texto: "Últimos 7 días" },
  { valor: "mes", texto: "Este mes" },
  { valor: "elegir", texto: "Elegir fechas" },
];

// Fecha local "YYYY-MM-DD" (no UTC: a las 8 p. m. en Colombia ya seria manana en UTC).
export function isoLocal(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// [desde, hasta] de cada atajo; null en "elegir" (se conservan las fechas actuales).
export function rangoDeAtajo(modo: ModoFecha, hoy: Date): [string, string] | null {
  if (modo === "todas") return ["", ""];
  if (modo === "hoy") return [isoLocal(hoy), isoLocal(hoy)];
  if (modo === "7dias") {
    const inicio = new Date(hoy);
    inicio.setDate(inicio.getDate() - 6);
    return [isoLocal(inicio), isoLocal(hoy)];
  }
  if (modo === "mes") return [isoLocal(new Date(hoy.getFullYear(), hoy.getMonth(), 1)), isoLocal(hoy)];
  return null;
}

// "2026-10-13" -> "13/10/2026" sin pasar por Date (evita el corrimiento de zona horaria).
const fechaCorta = (iso: string) => {
  const [anio, mes, dia] = iso.split("-");
  return anio && mes && dia ? `${dia}/${mes}/${anio}` : iso;
};

// Texto del boton "Fecha: …" segun el atajo o el rango elegido.
export function textoFecha(modo: ModoFecha, desde: string, hasta: string): string {
  if (modo === "elegir") return `${desde ? fechaCorta(desde) : "…"} – ${hasta ? fechaCorta(hasta) : "…"}`;
  if (modo === "todas") return "Todas";
  return ATAJOS_FECHA.find((x) => x.valor === modo)?.texto ?? "";
}

export const PUNTO_TONO: Record<TonoPildora, string> = {
  ok: "bg-ok",
  warn: "bg-warn-fill",
  error: "bg-danger",
  info: "bg-info",
  neutro: "bg-line-strong",
};

// Pestañas subrayadas de una sola eleccion (aria-pressed), con punto de color
// y conteo opcionales. En el celular se deslizan hacia los lados.
export function PestanasConteo<T extends string>({
  etiqueta,
  opciones,
  valor,
  onCambio,
  sinConteo = false,
}: {
  etiqueta: string;
  opciones: { valor: T; texto: string; tono?: TonoPildora; conteo?: number }[];
  valor: T;
  onCambio: (v: T) => void;
  // true mientras cargan los datos: no se muestran conteos en 0 engañosos.
  sinConteo?: boolean;
}) {
  return (
    <div role="group" aria-label={etiqueta} className="flex gap-1 overflow-x-auto border-b border-line px-2 sm:px-3">
      {opciones.map((o) => {
        const activo = valor === o.valor;
        return (
          <button
            key={o.valor}
            type="button"
            aria-pressed={activo}
            onClick={() => onCambio(o.valor)}
            className={`relative inline-flex min-h-11 shrink-0 cursor-pointer items-center gap-2 whitespace-nowrap px-2.5 text-sm transition-colors duration-150 after:absolute after:inset-x-1.5 after:bottom-0 after:h-0.5 after:rounded-full ${
              activo ? "font-semibold text-ink after:bg-ok" : "text-muted after:bg-transparent hover:text-ink"
            }`}
          >
            {o.tono ? <span aria-hidden className={`h-2 w-2 shrink-0 rounded-full ${PUNTO_TONO[o.tono]}`} /> : null}
            {o.texto}
            {sinConteo || o.conteo === undefined ? null : (
              <span className={`font-normal tabular-nums ${activo ? "text-ok-fg" : "text-subtle"}`}>{o.conteo}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

// Filtro de la barra: boton "Etiqueta: valor" que abre un menu de una sola
// eleccion. Se cierra al elegir (salvo opciones con mantenerAbierto), con
// Escape o con un clic afuera. `children` va al final del menu.
export function MenuFiltro<T extends string>({
  etiqueta,
  valorTexto,
  activo,
  opciones,
  valor,
  onCambio,
  children,
}: {
  etiqueta: string;
  valorTexto: string;
  activo: boolean;
  opciones: { valor: T; texto: string; mantenerAbierto?: boolean }[];
  valor: T;
  onCambio: (v: T) => void;
  children?: ReactNode;
}) {
  const [abierto, setAbierto] = useState(false);
  const caja = useRef<HTMLDivElement>(null);
  const idMenu = useId();

  useEffect(() => {
    if (!abierto) return;
    const alPulsar = (ev: PointerEvent) => {
      if (!caja.current?.contains(ev.target as Node)) setAbierto(false);
    };
    const alTecla = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") setAbierto(false);
    };
    document.addEventListener("pointerdown", alPulsar);
    document.addEventListener("keydown", alTecla);
    return () => {
      document.removeEventListener("pointerdown", alPulsar);
      document.removeEventListener("keydown", alTecla);
    };
  }, [abierto]);

  return (
    <div ref={caja} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={abierto}
        aria-controls={abierto ? idMenu : undefined}
        onClick={() => setAbierto((v) => !v)}
        className={`inline-flex min-h-11 cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-md border px-3 text-sm transition-colors duration-150 sm:min-h-9 ${
          activo
            ? "border-ok bg-ok/10 text-ink"
            : "border-line-strong bg-surface text-muted hover:bg-surface-2 hover:text-ink"
        }`}
      >
        {etiqueta}:<span className="font-medium text-ink">{valorTexto}</span>
        <Icono nombre={abierto ? "arriba" : "abajo"} className="h-3.5 w-3.5 text-muted" />
      </button>
      {abierto ? (
        <div
          id={idMenu}
          role="menu"
          aria-label={etiqueta}
          className="absolute left-0 top-full z-30 mt-1 flex min-w-56 flex-col rounded-lg border border-line bg-surface p-1 shadow-lg shadow-brand-night/15"
        >
          {opciones.map((o) => {
            const elegido = o.valor === valor;
            return (
              <button
                key={o.valor || "todos"}
                type="button"
                role="menuitemradio"
                aria-checked={elegido}
                onClick={() => {
                  onCambio(o.valor);
                  if (!o.mantenerAbierto) setAbierto(false);
                }}
                className={`flex min-h-10 cursor-pointer items-center justify-between gap-3 rounded-md px-2.5 text-left text-sm transition-colors duration-150 hover:bg-surface-2 ${
                  elegido ? "font-semibold text-ink" : "text-soft"
                }`}
              >
                {o.texto}
                {elegido ? <Icono nombre="check" className="h-4 w-4 shrink-0 text-ok-fg" /> : null}
              </button>
            );
          })}
          {children}
        </div>
      ) : null}
    </div>
  );
}

// Campos Desde/Hasta que van dentro del menu "Fecha" cuando se elige "Elegir fechas".
export function CamposRangoFecha({
  idBase,
  desde,
  hasta,
  onDesde,
  onHasta,
  claseCampo,
}: {
  idBase: string;
  desde: string;
  hasta: string;
  onDesde: (v: string) => void;
  onHasta: (v: string) => void;
  claseCampo: string;
}) {
  return (
    <div className="mt-1 flex items-end gap-2 border-t border-line px-1.5 pb-1 pt-2">
      <div className="flex flex-col gap-1">
        <label htmlFor={`${idBase}-desde`} className="text-xs text-muted">
          Desde
        </label>
        <input
          id={`${idBase}-desde`}
          type="date"
          value={desde}
          onChange={(e) => onDesde(e.target.value)}
          max={hasta || undefined}
          className={`${claseCampo} h-9`}
        />
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor={`${idBase}-hasta`} className="text-xs text-muted">
          Hasta
        </label>
        <input
          id={`${idBase}-hasta`}
          type="date"
          value={hasta}
          onChange={(e) => onHasta(e.target.value)}
          min={desde || undefined}
          className={`${claseCampo} h-9`}
        />
      </div>
    </div>
  );
}

// Boton "Limpiar filtros" (solo se muestra cuando hay algo filtrado).
export function BotonLimpiarFiltros({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="ml-auto inline-flex min-h-11 items-center gap-1 rounded-md px-2.5 text-sm font-medium text-muted transition-colors duration-150 hover:bg-surface-2 hover:text-ink sm:min-h-9"
    >
      <Icono nombre="cerrar" className="h-3.5 w-3.5" />
      Limpiar filtros
    </button>
  );
}

// Buscador de la barra: icono a la izquierda, boton para borrar y Escape limpia.
export function BuscadorBarra({
  id,
  etiqueta,
  valor,
  onCambio,
  placeholder,
  claseCampo,
}: {
  id: string;
  etiqueta: string;
  valor: string;
  onCambio: (v: string) => void;
  placeholder: string;
  claseCampo: string;
}) {
  return (
    // Angosto y a la altura de los filtros, en la misma fila: busqueda y filtros se leen como un grupo.
    <div className="relative w-full sm:w-56 lg:w-64">
      <label htmlFor={id} className="sr-only">
        {etiqueta}
      </label>
      <Icono
        nombre="revisar"
        className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted"
      />
      <input
        id={id}
        type="search"
        value={valor}
        onChange={(e) => onCambio(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") onCambio("");
        }}
        placeholder={placeholder}
        autoComplete="off"
        className={`${claseCampo} h-11 w-full pl-9 pr-10 sm:h-9 [&::-webkit-search-cancel-button]:hidden`}
      />
      {valor ? (
        <button
          type="button"
          onClick={() => onCambio("")}
          aria-label="Borrar búsqueda"
          className="absolute right-0 top-0 flex h-11 w-10 items-center justify-center text-muted transition-colors duration-150 hover:text-ink sm:h-9"
        >
          <Icono nombre="cerrar" className="h-4 w-4" />
        </button>
      ) : null}
    </div>
  );
}
