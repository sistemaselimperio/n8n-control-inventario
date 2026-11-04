// Identificador de un documento (tipo + número, ej. "FEI 10254"): el elemento
// visual principal de filas y modales. Cifra tabular (.cifra, IBM Plex Mono), el
// tipo en tono apagado y el número en tinta.

const TAMANOS = {
  fila: "text-[16px]",
  modal: "text-[22px]",
} as const;

export function Folio({
  tipo,
  numero,
  tamano = "fila",
  className = "",
}: {
  tipo: string | null | undefined;
  numero: string | null | undefined;
  tamano?: keyof typeof TAMANOS;
  className?: string;
}) {
  return (
    <span className={`cifra whitespace-nowrap ${TAMANOS[tamano]} ${className}`}>
      <span className="text-muted">{tipo || "—"}</span> <span className="text-ink">{numero || "—"}</span>
    </span>
  );
}
