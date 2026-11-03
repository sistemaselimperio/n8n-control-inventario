"use client";

// Reporte de traslado generado por Syscafe. Se ve para todos los que abren el
// detalle; solo quien puede asignar Syscafe sube el archivo, una unica vez:
// elegir -> vista previa -> confirmar (no se puede reemplazar ni borrar).

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { subirReporteSyscafeDashboard } from "@/lib/api";
import { claseBoton, Icono } from "@/components/ui";
import { fechaHora } from "./compartido";
import { Dato } from "./ModalBase";

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
  const entrada = useRef<HTMLInputElement>(null);

  // La URL de la vista previa se crea al elegir el archivo; aqui solo se libera.
  useEffect(() => {
    if (!previa) return;
    return () => URL.revokeObjectURL(previa);
  }, [previa]);

  const alElegir = (archivo: File | undefined) => {
    if (!archivo) return;
    const error = validarArchivoReporte(archivo);
    if (error) {
      toast.error(error);
      if (entrada.current) entrada.current.value = "";
      return;
    }
    setElegido(archivo);
    setPrevia(TIPOS_IMAGEN.includes(archivo.type) ? URL.createObjectURL(archivo) : null);
  };

  const descartar = () => {
    setElegido(null);
    setPrevia(null);
  };

  const confirmar = async () => {
    if (!elegido) return;
    setSubiendo(true);
    try {
      await subirReporteSyscafeDashboard(traslado.id, elegido);
      toast.success("Reporte Syscafe subido");
      descartar();
      onSubido();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "No se pudo subir el reporte Syscafe");
    } finally {
      setSubiendo(false);
    }
  };

  const url = traslado.reporte_syscafe_url;
  if (url) {
    const esPdf = traslado.reporte_syscafe_tipo === "application/pdf";
    return (
      <Dato etiqueta="Reporte Syscafe">
        <span className="flex flex-col items-start gap-1">
          {esPdf ? (
            <a href={url} target="_blank" rel="noopener noreferrer" className={claseBoton("secundario")}>
              <Icono nombre="factura" className="h-4 w-4" />
              Ver PDF
            </a>
          ) : (
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              aria-label="Abrir reporte Syscafe"
              className="inline-block"
            >
              {/* eslint-disable-next-line @next/next/no-img-element -- URL publica de Storage, igual que en Imagenes */}
              <img
                src={url}
                alt="Reporte Syscafe"
                loading="lazy"
                className="h-24 w-auto max-w-full rounded-md border border-line bg-white object-contain"
              />
            </a>
          )}
          {traslado.reporte_syscafe_at ? (
            <span className="text-xs text-muted">
              Subido por {traslado.reporte_syscafe_por ?? "—"}, {fechaHora(traslado.reporte_syscafe_at)}
            </span>
          ) : null}
        </span>
      </Dato>
    );
  }

  return (
    <Dato etiqueta="Reporte Syscafe">
      {!puedeSubir ? (
        <span className="text-sm text-muted">Sin reporte</span>
      ) : elegido ? (
        <span className="flex flex-col items-start gap-2">
          {previa ? (
            // eslint-disable-next-line @next/next/no-img-element -- vista previa local (blob:), no es un recurso optimizable
            <img
              src={previa}
              alt="Vista previa del reporte"
              className="h-24 w-auto max-w-full rounded-md border border-line bg-white object-contain"
            />
          ) : (
            <span className="flex items-center gap-2 text-sm text-ink">
              <Icono nombre="factura" className="h-4 w-4" />
              <span>{elegido.name}</span>
            </span>
          )}
          <span className="text-xs text-muted">Una vez subido no se puede cambiar. ¿Confirmar?</span>
          <span className="flex flex-wrap gap-2">
            <button onClick={confirmar} disabled={subiendo} className={claseBoton("primario")}>
              {subiendo ? "Subiendo…" : "Confirmar y subir"}
            </button>
            <button onClick={descartar} disabled={subiendo} className={claseBoton("fantasma")}>
              Cancelar
            </button>
          </span>
        </span>
      ) : (
        <span className="flex flex-col items-start gap-1">
          <span className="text-sm text-muted">Sin reporte</span>
          <input
            ref={entrada}
            type="file"
            accept="image/jpeg,image/png,image/webp,application/pdf"
            aria-label="Archivo del reporte Syscafe"
            onChange={(e) => alElegir(e.target.files?.[0])}
            className="text-sm text-ink file:mr-2 file:min-h-11 file:cursor-pointer file:rounded-md file:border file:border-line-strong file:bg-surface-2 file:px-3 file:text-sm file:font-medium"
          />
          <span className="text-xs text-muted">JPG, PNG, WebP o PDF, hasta 5 MB.</span>
        </span>
      )}
    </Dato>
  );
}
