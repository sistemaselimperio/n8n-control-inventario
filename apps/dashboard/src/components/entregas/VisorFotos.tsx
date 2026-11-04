"use client";

import { useCallback, useEffect, useState } from "react";
import { Icono } from "@/components/ui";

export type FotoVisor = { url: string; etiqueta: string };

// Visor de las fotos de un documento: pestañas con miniatura arriba (si hay
// varias), imagen grande ajustada (object-contain) sobre fondo claro, navegacion con
// botones y flechas izquierda/derecha, y enlace para abrir el original.
// `teclado` permite apagar las flechas mientras hay otro dialogo encima.
export function VisorFotos({ fotos, teclado = true }: { fotos: FotoVisor[]; teclado?: boolean }) {
  const [indice, setIndice] = useState(0);
  // Estado de carga por url: sin entrada = cargando.
  const [estados, setEstados] = useState<Record<string, "ok" | "error">>({});

  const total = fotos.length;
  const actual = fotos[Math.min(indice, Math.max(total - 1, 0))];
  const hayVarias = total > 1;

  const ir = useCallback(
    (delta: number) => setIndice((i) => (i + delta + total) % total),
    [total]
  );

  useEffect(() => {
    if (!hayVarias || !teclado) return;
    const alPresionarTecla = (ev: KeyboardEvent) => {
      if (ev.key !== "ArrowLeft" && ev.key !== "ArrowRight") return;
      // No robar las flechas a campos de texto ni a controles que las usan.
      const el = ev.target as HTMLElement | null;
      if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;
      ev.preventDefault();
      ir(ev.key === "ArrowLeft" ? -1 : 1);
    };
    document.addEventListener("keydown", alPresionarTecla);
    return () => document.removeEventListener("keydown", alPresionarTecla);
  }, [hayVarias, teclado, ir]);

  if (!actual) {
    return (
      <div className="flex min-h-64 items-center justify-center rounded-lg bg-surface-2 p-6 text-sm text-muted">
        Este documento no tiene fotos.
      </div>
    );
  }

  const estado = estados[actual.url];
  const marcar = (url: string, valor: "ok" | "error") =>
    setEstados((prev) => (prev[url] === valor ? prev : { ...prev, [url]: valor }));

  return (
    <div className="flex flex-col gap-2">
      {/* Fotos del documento como pestañas con miniatura: se ve de una vez
          cuales hay (foto inicial, bodega, traslado) y cual esta abierta. */}
      {hayVarias ? (
        <div className="flex gap-2 overflow-x-auto pb-1" role="group" aria-label="Fotos del documento">
          {fotos.map((foto, i) => (
            <button
              key={foto.url}
              type="button"
              onClick={() => setIndice(i)}
              aria-label={`Ver foto ${i + 1} de ${total}: ${foto.etiqueta}`}
              aria-current={i === indice ? "true" : undefined}
              className={`flex min-h-11 shrink-0 items-center gap-2 rounded-md border p-1.5 pr-3 text-left transition-colors duration-150 ${
                i === indice
                  ? "border-ok bg-ok/10 text-ink"
                  : "border-line bg-surface text-muted hover:border-line-strong hover:text-ink"
              }`}
            >
              {/* eslint-disable-next-line @next/next/no-img-element -- ver nota abajo. */}
              <img src={foto.url} alt="" className="h-8 w-10 rounded-sm bg-surface-2 object-cover" />
              <span className="text-sm font-medium">{foto.etiqueta}</span>
            </button>
          ))}
        </div>
      ) : null}

      <div className="relative flex h-64 items-center lg:h-[320px] justify-center overflow-hidden rounded-lg bg-surface-2">
        {estado === "error" ? (
          <p className="max-w-xs px-6 text-center text-sm text-soft">
            No se pudo cargar la foto. Ábrela en una pestaña nueva.
          </p>
        ) : (
          <>
            {estado === undefined ? (
              <div aria-hidden className="absolute inset-0 animate-pulse bg-line/40" />
            ) : null}
            {/* eslint-disable-next-line @next/next/no-img-element -- fotos
                vienen de Supabase Storage, no del dominio de Next. */}
            <img
              key={actual.url}
              ref={(img) => {
                // Imagen ya en cache: el onLoad pudo dispararse antes de montar.
                if (img && img.complete && img.naturalWidth > 0) marcar(actual.url, "ok");
              }}
              src={actual.url}
              alt={actual.etiqueta}
              onLoad={() => marcar(actual.url, "ok")}
              onError={() => marcar(actual.url, "error")}
              className={`max-h-full max-w-full object-contain transition-opacity duration-150 ${
                estado === "ok" ? "opacity-100" : "opacity-0"
              }`}
            />
          </>
        )}

        {/* Barra inferior sobre la foto: cual es, posicion y abrir original. */}
        <div className="absolute inset-x-2 bottom-2 flex items-center justify-between gap-2">
          <span className="rounded-md bg-surface/95 px-2.5 py-1 text-xs font-medium text-ink">
            {actual.etiqueta}
            {hayVarias ? <span className="text-muted"> · {indice + 1} de {total}</span> : null}
          </span>
          <a
            href={actual.url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex min-h-9 items-center gap-1 rounded-md bg-surface/95 px-3 text-xs font-medium text-ink transition-colors duration-150 hover:bg-surface"
          >
            Abrir original
            <Icono nombre="externo" />
          </a>
        </div>

        {hayVarias ? (
          <>
            <button
              type="button"
              onClick={() => ir(-1)}
              aria-label="Foto anterior"
              className="absolute left-2 top-1/2 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full bg-surface/95 text-ink transition-colors duration-150 hover:bg-surface"
            >
              <Icono nombre="izquierda" className="h-5 w-5" />
            </button>
            <button
              type="button"
              onClick={() => ir(1)}
              aria-label="Foto siguiente"
              className="absolute right-2 top-1/2 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full bg-surface/95 text-ink transition-colors duration-150 hover:bg-surface"
            >
              <Icono nombre="derecha" className="h-5 w-5" />
            </button>
          </>
        ) : null}
      </div>
    </div>
  );
}
