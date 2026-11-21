"use client";

// Lienzo de firma: Pointer Events (raton, tactil y lapiz con el mismo codigo),
// touch-action none para que el dedo dibuje en vez de desplazar la pagina, y
// escalado por devicePixelRatio para que el trazo se vea nitido en pantallas
// de alta densidad. La firma se exporta como PNG (Blob) solo si hay trazo.

import { useCallback, useEffect, useImperativeHandle, useRef, type PointerEvent, type Ref } from "react";
import { Boton } from "@/components/ui";

export interface ControlFirma {
  // PNG de la firma, o null si todavia no hay trazo.
  exportar: () => Promise<Blob | null>;
  limpiar: () => void;
}

export function FirmaCanvas({
  onCambio,
  ref,
  alto = 180,
}: {
  // Se llama con true al empezar a firmar y con false al limpiar.
  onCambio: (hayTrazo: boolean) => void;
  ref?: Ref<ControlFirma>;
  alto?: number;
}) {
  const lienzoRef = useRef<HTMLCanvasElement>(null);
  const dibujando = useRef(false);
  const hayTrazo = useRef(false);
  const ultimo = useRef<{ x: number; y: number } | null>(null);

  const contexto = () => lienzoRef.current?.getContext("2d") ?? null;

  // Ajusta el tamaño interno al tamaño CSS por la densidad de pixeles.
  useEffect(() => {
    const el = lienzoRef.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    el.width = Math.round(width * dpr);
    el.height = Math.round(height * dpr);
    const c = el.getContext("2d");
    if (!c) return;
    c.scale(dpr, dpr);
    c.lineWidth = 2.5;
    c.lineCap = "round";
    c.lineJoin = "round";
    c.strokeStyle = "#0b1b33";
  }, []);

  const punto = (e: PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const empezar = (e: PointerEvent<HTMLCanvasElement>) => {
    e.currentTarget.setPointerCapture?.(e.pointerId);
    dibujando.current = true;
    ultimo.current = punto(e);
  };

  const mover = (e: PointerEvent<HTMLCanvasElement>) => {
    if (!dibujando.current || !ultimo.current) return;
    const c = contexto();
    const p = punto(e);
    if (c) {
      c.beginPath();
      c.moveTo(ultimo.current.x, ultimo.current.y);
      c.lineTo(p.x, p.y);
      c.stroke();
    }
    ultimo.current = p;
    if (!hayTrazo.current) {
      hayTrazo.current = true;
      onCambio(true);
    }
  };

  const terminar = (e: PointerEvent<HTMLCanvasElement>) => {
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    dibujando.current = false;
    ultimo.current = null;
  };

  const limpiar = useCallback(() => {
    const el = lienzoRef.current;
    const c = el?.getContext("2d");
    if (el && c) {
      const dpr = window.devicePixelRatio || 1;
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.clearRect(0, 0, el.width, el.height);
      c.scale(dpr, dpr);
    }
    hayTrazo.current = false;
    onCambio(false);
  }, [onCambio]);

  useImperativeHandle(
    ref,
    () => ({
      limpiar,
      exportar: () =>
        new Promise<Blob | null>((resolver) => {
          const el = lienzoRef.current;
          if (!el || !hayTrazo.current) return resolver(null);
          el.toBlob((b) => resolver(b), "image/png");
        }),
    }),
    [limpiar],
  );

  return (
    <div className="flex flex-col gap-2">
      <canvas
        ref={lienzoRef}
        aria-label="Área de firma"
        role="img"
        style={{ touchAction: "none", height: alto }}
        className="w-full cursor-crosshair rounded-md border border-dashed border-line-strong bg-white"
        onPointerDown={empezar}
        onPointerMove={mover}
        onPointerUp={terminar}
        onPointerCancel={terminar}
      />
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-muted">Firma dentro del recuadro con el dedo, el lápiz o el ratón.</p>
        <Boton variante="fantasma" onClick={limpiar}>
          Limpiar
        </Boton>
      </div>
    </div>
  );
}
