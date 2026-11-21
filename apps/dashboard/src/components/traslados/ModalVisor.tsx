"use client";

// Visor de un PDF (iframe) o de una imagen (firma) dentro del panel, con un
// enlace para abrirlo en una pestaña nueva si el navegador no lo incrusta.

import { claseBoton, Icono } from "@/components/ui";
import { ModalBase } from "./ModalBase";

export function ModalVisor({
  titulo,
  url,
  tipo,
  onCerrar,
}: {
  titulo: string;
  url: string;
  tipo: "pdf" | "imagen";
  onCerrar: () => void;
}) {
  return (
    <ModalBase etiqueta={`Visor: ${titulo}`} titulo={titulo} ancho="max-w-4xl" onCerrar={onCerrar}>
      {tipo === "pdf" ? (
        <iframe src={url} title={titulo} className="h-[65vh] w-full rounded-md border border-line bg-white" />
      ) : (
        <div className="flex justify-center rounded-md border border-line bg-white p-3">
          {/* eslint-disable-next-line @next/next/no-img-element -- la firma viene de Storage con URL propia. */}
          <img src={url} alt={titulo} className="max-h-[60vh] w-auto max-w-full object-contain" />
        </div>
      )}
      <div className="flex justify-end">
        <a href={url} target="_blank" rel="noopener noreferrer" className={claseBoton("secundario")}>
          Abrir en pestaña nueva
          <Icono nombre="externo" className="h-4 w-4" />
        </a>
      </div>
    </ModalBase>
  );
}
