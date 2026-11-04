"use client";

// Reporte de traslado generado por Syscafe. Se ve para todos los que abren el
// detalle; solo quien puede asignar Syscafe sube el archivo, una unica vez:
// elegir (clic, arrastrar o pegar con Ctrl+V) -> vista previa -> confirmar.
// No se puede reemplazar ni borrar.

import { useCallback, useEffect, useRef, useState, type DragEvent } from "react";
import { toast } from "sonner";
import { subirReporteSyscafeDashboard } from "@/lib/api";
import { claseBoton, Icono } from "@/components/ui";
import { fechaHora } from "./compartido";

export const MAX_BYTES_REPORTE = 5 * 1024 * 1024;
const TIPOS_IMAGEN = ["image/jpeg", "image/png", "image/webp"];
const TIPOS_PERMITIDOS = [...TIPOS_IMAGEN, "application/pdf"];

// Mensaje de error si el archivo no sirve; null si es valido.
export function validarArchivoReporte(archivo: File): string | null {
  if (!TIPOS_PERMITIDOS.includes(archivo.type)) return "El reporte debe ser una imagen JPG, PNG, WebP o PDF.";
  if (archivo.size > MAX_BYTES_REPORTE) return "El reporte no puede pesar más de 5 MB.";
  return null;
}

export interface CamposReporteSyscafe {
  id: string;
  reporte_syscafe_url?: string | null;
  reporte_syscafe_tipo?: string | null;
  reporte_syscafe_at?: string | null;
  reporte_syscafe_por?: string | null;
}

const claseMiniatura = "h-32 w-auto max-w-full rounded-md border border-line bg-white object-contain";

export function ReporteSyscafe({
  traslado,
  puedeSubir,
  onSubido,
}: {
  traslado: CamposReporteSyscafe;
  puedeSubir: boolean;
  onSubido: () => void;
}) {
  const [elegido, setElegido] = useState<File | null>(null);
  const [previa, setPrevia] = useState<string | null>(null);
  const [subiendo, setSubiendo] = useState(false);
  const [encima, setEncima] = useState(false);
  const entrada = useRef<HTMLInputElement>(null);

  // La URL de la vista previa se crea al elegir el archivo; aqui solo se libera.
  useEffect(() => {
    if (!previa) return;
    return () => URL.revokeObjectURL(previa);
  }, [previa]);

  const alElegir = useCallback((archivo: File | undefined | null) => {
    if (!archivo) return;
    const error = validarArchivoReporte(archivo);
    if (error) {
      toast.error(error);
      if (entrada.current) entrada.current.value = "";
      return;
    }
    setElegido(archivo);
    setPrevia(TIPOS_IMAGEN.includes(archivo.type) ? URL.createObjectURL(archivo) : null);
  }, []);

  const yaSubido = Boolean(traslado.reporte_syscafe_url);
  const zonaActiva = puedeSubir && !yaSubido && !elegido;

  // Pegar una captura (Ctrl+V) mientras la zona esta disponible.
  useEffect(() => {
    if (!zonaActiva) return;
    const alPegar = (ev: ClipboardEvent) => {
      const items = Array.from(ev.clipboardData?.items ?? []);
      const item = items.find((i) => i.kind === "file");
      const archivo = item?.getAsFile();
      if (!archivo) return;
      ev.preventDefault();
      alElegir(archivo);
    };
    document.addEventListener("paste", alPegar);
    return () => document.removeEventListener("paste", alPegar);
  }, [zonaActiva, alElegir]);

  const descartar = () => {
    setElegido(null);
    setPrevia(null);
  };

  const confirmar = async () => {
    if (!elegido) return;
    setSubiendo(true);
    try {
      await subirReporteSyscafeDashboard(traslado.id, elegido);
      toast.success("Reporte de traslado subido");
      descartar();
      onSubido();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "No se pudo subir el reporte de traslado");
    } finally {
      setSubiendo(false);
    }
  };

  const url = traslado.reporte_syscafe_url;
  if (url) {
    const esPdf = traslado.reporte_syscafe_tipo === "application/pdf";
    return (
      <div className="flex flex-col items-start gap-1.5">
        {esPdf ? (
          <a href={url} target="_blank" rel="noopener noreferrer" className={claseBoton("secundario")}>
            <Icono nombre="factura" className="h-4 w-4" />
            Ver PDF
          </a>
        ) : (
          <a href={url} target="_blank" rel="noopener noreferrer" aria-label="Abrir reporte de traslado" className="inline-block">
            {/* eslint-disable-next-line @next/next/no-img-element -- URL publica de Storage, igual que en Imagenes */}
            <img src={url} alt="Reporte de traslado" loading="lazy" className={claseMiniatura} />
          </a>
        )}
        {traslado.reporte_syscafe_at ? (
          <span className="text-xs text-muted">
            {traslado.reporte_syscafe_por ?? "—"} · {fechaHora(traslado.reporte_syscafe_at)}
          </span>
        ) : null}
      </div>
    );
  }

  if (!puedeSubir) return <span className="text-sm text-muted">Sin reporte</span>;

  if (elegido) {
    return (
      <div className="flex flex-col items-start gap-2">
        {previa ? (
          // eslint-disable-next-line @next/next/no-img-element -- vista previa local (blob:), no es un recurso optimizable
          <img src={previa} alt="Vista previa del reporte" className={claseMiniatura} />
        ) : (
          <span className="flex items-center gap-2 text-sm text-ink">
            <Icono nombre="factura" className="h-4 w-4" />
            <span>{elegido.name}</span>
          </span>
        )}
        <span className="text-xs text-muted">Después no se puede cambiar.</span>
        <span className="flex flex-wrap gap-2">
          <button onClick={confirmar} disabled={subiendo} className={claseBoton("primario")}>
            {subiendo ? "Subiendo…" : "Confirmar y subir"}
          </button>
          <button onClick={descartar} disabled={subiendo} className={claseBoton("fantasma")}>
            Cancelar
          </button>
        </span>
      </div>
    );
  }

  const alSoltar = (ev: DragEvent<HTMLElement>) => {
    ev.preventDefault();
    setEncima(false);
    alElegir(ev.dataTransfer?.files?.[0]);
  };

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label="Subir reporte de traslado"
      onClick={() => entrada.current?.click()}
      onKeyDown={(ev) => {
        if (ev.key === "Enter" || ev.key === " ") {
          ev.preventDefault();
          entrada.current?.click();
        }
      }}
      onDragOver={(ev) => {
        ev.preventDefault();
        setEncima(true);
      }}
      onDragLeave={() => setEncima(false)}
      onDrop={alSoltar}
      className={`flex min-h-32 w-full cursor-pointer flex-col items-center justify-center gap-1.5 rounded-md border-2 border-dashed px-4 py-5 text-center transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ok ${
        encima ? "border-ok bg-ok/10" : "border-line-strong bg-surface hover:border-ok hover:bg-surface-2"
      }`}
    >
      <Icono nombre="arriba" className="h-5 w-5 text-ok-fg" />
      <span className="text-sm font-semibold text-ink">Subir reporte</span>
      <span className="text-xs text-muted">Arrastra, pega o haz clic · JPG, PNG, PDF · 5 MB</span>
      <input
        ref={entrada}
        type="file"
        accept="image/jpeg,image/png,image/webp,application/pdf"
        aria-label="Archivo del reporte de traslado"
        onClick={(ev) => ev.stopPropagation()}
        onChange={(e) => alElegir(e.target.files?.[0])}
        className="sr-only"
      />
    </div>
  );
}
