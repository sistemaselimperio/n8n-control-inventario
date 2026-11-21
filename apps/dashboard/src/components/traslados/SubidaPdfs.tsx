"use client";

// Carga de PDF de traslados: arrastrar y soltar o elegir varios archivos. Se
// sube un archivo por solicitud (asi hay progreso real y un fallo no tumba a
// los demas); el backend acepta hasta 20 PDF de 5 MB por carga. Al terminar se
// lista el resultado de cada archivo: creado, borrador, duplicado o error.

import { useRef, useState, type DragEvent } from "react";
import { toast } from "sonner";
import { subirTraslados, type ResultadoSubida } from "@/lib/api";
import { revalidarTraslados } from "@/lib/traslados";
import { Panel, Pildora, type TonoPildora } from "@/components/ui";

const MAX_ARCHIVOS = 20;
const MAX_BYTES = 5 * 1024 * 1024;

const esPdf = (f: File) => f.type === "application/pdf" || f.name.toLowerCase().endsWith(".pdf");

const ETIQUETA: Record<ResultadoSubida["resultado"], { texto: string; tono: TonoPildora }> = {
  creado: { texto: "Creado", tono: "ok" },
  borrador: { texto: "Borrador", tono: "warn" },
  duplicado: { texto: "Duplicado", tono: "neutro" },
  error: { texto: "Error", tono: "error" },
};

type Fila = Pick<ResultadoSubida, "archivo" | "resultado" | "detalle">;

export function SubidaPdfs({ onTerminado }: { onTerminado?: () => void }) {
  const entradaRef = useRef<HTMLInputElement>(null);
  const [arrastrando, setArrastrando] = useState(false);
  const [avisos, setAvisos] = useState<string[]>([]);
  const [progreso, setProgreso] = useState<{ hechos: number; total: number } | null>(null);
  const [filas, setFilas] = useState<Fila[]>([]);

  const procesar = async (lista: File[]) => {
    if (progreso || lista.length === 0) return;
    const nuevosAvisos: string[] = [];
    const validos: File[] = [];
    for (const f of lista) {
      if (!esPdf(f)) nuevosAvisos.push(`${f.name}: solo se aceptan archivos PDF.`);
      else if (f.size > MAX_BYTES) nuevosAvisos.push(`${f.name}: supera los 5 MB permitidos.`);
      else validos.push(f);
    }
    let aSubir = validos;
    if (validos.length > MAX_ARCHIVOS) {
      nuevosAvisos.push(`Máximo ${MAX_ARCHIVOS} archivos por carga: se subirán los primeros ${MAX_ARCHIVOS}.`);
      aSubir = validos.slice(0, MAX_ARCHIVOS);
    }
    setAvisos(nuevosAvisos);
    setFilas([]);
    if (aSubir.length === 0) return;

    setProgreso({ hechos: 0, total: aSubir.length });
    const acumuladas: Fila[] = [];
    for (const archivo of aSubir) {
      try {
        const { resultados } = await subirTraslados([archivo]);
        acumuladas.push(...resultados.map(({ archivo: a, resultado, detalle }) => ({ archivo: a, resultado, detalle })));
      } catch (err) {
        acumuladas.push({
          archivo: archivo.name,
          resultado: "error",
          detalle: err instanceof Error ? err.message : "No se pudo subir el archivo",
        });
      }
      setProgreso((p) => (p ? { ...p, hechos: p.hechos + 1 } : p));
      setFilas([...acumuladas]);
    }
    setProgreso(null);
    const buenos = acumuladas.filter((f) => f.resultado === "creado" || f.resultado === "borrador").length;
    if (buenos > 0) toast.success(`${buenos} archivo${buenos === 1 ? "" : "s"} procesado${buenos === 1 ? "" : "s"}`);
    revalidarTraslados();
    onTerminado?.();
  };

  const alSoltar = (ev: DragEvent<HTMLElement>) => {
    ev.preventDefault();
    setArrastrando(false);
    void procesar(Array.from(ev.dataTransfer.files));
  };

  return (
    <Panel titulo="Subir traslados" subtitulo="Arrastra los PDF de los comprobantes o elígelos desde tu equipo. Hasta 20 archivos de 5 MB por carga.">
      <div
        data-testid="zona-subida"
        onDragOver={(ev) => {
          ev.preventDefault();
          setArrastrando(true);
        }}
        onDragLeave={() => setArrastrando(false)}
        onDrop={alSoltar}
        className={`flex flex-col items-center gap-3 rounded-lg border-2 border-dashed px-4 py-8 text-center transition-colors duration-150 ${
          arrastrando ? "border-ok bg-ok/10" : "border-line-strong bg-surface-2"
        }`}
      >
        <p className="text-sm text-soft">Suelta aquí los PDF</p>
        <label className="inline-flex min-h-11 cursor-pointer items-center justify-center rounded-md bg-ok px-3.5 py-2 text-sm font-semibold text-ok-on transition-colors duration-150 hover:bg-ok-hover has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-50">
          Elegir PDF
          <input
            ref={entradaRef}
            type="file"
            multiple
            accept=".pdf,application/pdf"
            aria-label="Seleccionar PDFs"
            disabled={progreso !== null}
            className="sr-only"
            onChange={(ev) => {
              void procesar(Array.from(ev.target.files ?? []));
              ev.target.value = "";
            }}
          />
        </label>
      </div>

      {progreso ? (
        <div className="mt-4 flex flex-col gap-1.5">
          <div
            role="progressbar"
            aria-label="Progreso de la carga"
            aria-valuemin={0}
            aria-valuemax={progreso.total}
            aria-valuenow={progreso.hechos}
            className="h-2 w-full overflow-hidden rounded-full bg-surface-2"
          >
            <div
              className="h-full rounded-full bg-ok transition-all duration-150"
              style={{ width: `${(progreso.hechos / progreso.total) * 100}%` }}
            />
          </div>
          <p className="text-xs text-muted" aria-live="polite">
            Subiendo {Math.min(progreso.hechos + 1, progreso.total)} de {progreso.total}…
          </p>
        </div>
      ) : null}

      {avisos.length > 0 ? (
        <ul className="mt-4 flex flex-col gap-1 rounded-md border border-warn/40 bg-warn-fill/20 px-3 py-2 text-sm text-warn" aria-label="Avisos de la carga">
          {avisos.map((a) => (
            <li key={a}>{a}</li>
          ))}
        </ul>
      ) : null}

      {filas.length > 0 ? (
        <ul aria-label="Resultado de la carga" className="mt-4 flex flex-col divide-y divide-line rounded-md border border-line">
          {filas.map((f, i) => (
            <li key={`${f.archivo}-${i}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
              <span className="min-w-0 flex-1 truncate text-sm text-ink" title={f.archivo}>
                {f.archivo}
              </span>
              <Pildora tono={ETIQUETA[f.resultado].tono}>{ETIQUETA[f.resultado].texto}</Pildora>
              {f.detalle ? <span className="w-full text-xs text-muted sm:w-auto sm:max-w-[50%]">{f.detalle}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
    </Panel>
  );
}
