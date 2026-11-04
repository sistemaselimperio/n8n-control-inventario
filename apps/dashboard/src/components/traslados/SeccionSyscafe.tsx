"use client";

// Apartado "Syscafe" del detalle de un traslado: numero Syscafe (prefijo +
// indicativo, ej. CUK-172) y reporte (imagen o PDF), cada uno con quien y
// cuando lo registro. El estado arriba a la derecha dice que falta.

import { useState, type KeyboardEvent } from "react";
import { toast } from "sonner";
import { asignarSyscafeDashboard } from "@/lib/api";
import { claseBoton, Icono, Pildora, type TonoPildora } from "@/components/ui";
import { fechaHora } from "./compartido";
import { ReporteSyscafe, type CamposReporteSyscafe } from "./ReporteSyscafe";

export interface CamposSyscafe extends CamposReporteSyscafe {
  numero_syscafe: string | null;
  numero_syscafe_at?: string | null;
  numero_syscafe_por?: string | null;
}

// "CUK-172" -> ["CUK", "172"]; "TB9120" -> ["TB9", "120"]; otro formato va al prefijo.
function separar(numero: string | null): [string, string] {
  if (!numero) return ["", ""];
  const texto = numero.trim().toUpperCase();
  const m = /^([A-Z][A-Z0-9]*)-(\d+)$/.exec(texto) ?? /^([A-Z]+)(\d+)$/.exec(texto);
  return m ? [m[1], m[2]] : [texto, ""];
}

function estado(t: CamposSyscafe): { texto: string; tono: TonoPildora } {
  const numero = Boolean(t.numero_syscafe);
  const reporte = Boolean(t.reporte_syscafe_url);
  if (numero && reporte) return { texto: "Completo", tono: "ok" };
  if (numero) return { texto: "Falta reporte", tono: "warn" };
  if (reporte) return { texto: "Falta número", tono: "warn" };
  return { texto: "Falta número y reporte", tono: "warn" };
}

const claseCampo =
  "cifra h-11 rounded-md border border-line-strong bg-surface px-2 text-base uppercase text-ink focus:border-ok focus:outline-none";

export function SeccionSyscafe({
  traslado: t,
  puedeEditar,
  onCambio,
}: {
  traslado: CamposSyscafe;
  puedeEditar: boolean;
  onCambio: () => void | Promise<void>;
}) {
  const [editando, setEditando] = useState(false);
  const [prefijo, setPrefijo] = useState("");
  const [indicativo, setIndicativo] = useState("");
  const [guardando, setGuardando] = useState(false);

  const abrirEdicion = () => {
    const [p, i] = separar(t.numero_syscafe);
    setPrefijo(p);
    setIndicativo(i);
    setEditando(true);
  };

  const numero = prefijo && indicativo ? `${prefijo}-${indicativo}` : "";
  const valido = numero !== "" && numero !== t.numero_syscafe;

  const guardar = async (nuevo: string | null) => {
    setGuardando(true);
    try {
      await asignarSyscafeDashboard(t.id, nuevo);
      toast.success(nuevo ? `Syscafe ${nuevo} guardado` : "Número Syscafe borrado");
      setEditando(false);
      await onCambio();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "No se pudo guardar el número Syscafe");
    } finally {
      setGuardando(false);
    }
  };

  const alTecla = (ev: KeyboardEvent<HTMLInputElement>) => {
    if (ev.key === "Enter" && valido && !guardando) {
      ev.preventDefault();
      guardar(numero);
    }
    if (ev.key === "Escape") {
      ev.stopPropagation();
      setEditando(false);
    }
  };

  const info = estado(t);

  return (
    <section aria-labelledby={`syscafe-${t.id}`} className="flex flex-col gap-4 rounded-lg border border-line bg-surface-2/60 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 id={`syscafe-${t.id}`} className="text-base font-semibold text-ink">
          Syscafe
        </h4>
        <Pildora tono={info.tono}>{info.texto}</Pildora>
      </div>

      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
        {/* Numero */}
        <div className="flex flex-col gap-2">
          <span className="text-xs font-medium text-muted">Número</span>
          {editando ? (
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-1.5">
                <input
                  autoFocus={!prefijo}
                  value={prefijo}
                  onChange={(e) =>
                    setPrefijo(
                      e.target.value
                        .toUpperCase()
                        .replace(/[^A-Z0-9]/g, "")
                        .replace(/^\d+/, "")
                        .slice(0, 4),
                    )
                  }
                  onKeyDown={alTecla}
                  placeholder="CUK"
                  aria-label="Prefijo"
                  autoComplete="off"
                  className={`${claseCampo} w-20`}
                />
                <span aria-hidden className="text-muted">
                  –
                </span>
                <input
                  autoFocus={!!prefijo}
                  value={indicativo}
                  onChange={(e) => setIndicativo(e.target.value.replace(/\D/g, "").slice(0, 8))}
                  onKeyDown={alTecla}
                  placeholder="172"
                  inputMode="numeric"
                  aria-label="Indicativo"
                  autoComplete="off"
                  className={`${claseCampo} w-24`}
                />
              </div>
              <div className="flex flex-wrap gap-2">
                <button onClick={() => guardar(numero)} disabled={!valido || guardando} className={claseBoton("primario")}>
                  {guardando ? "Guardando…" : "Guardar"}
                </button>
                <button onClick={() => setEditando(false)} disabled={guardando} className={claseBoton("fantasma")}>
                  Cancelar
                </button>
              </div>
            </div>
          ) : t.numero_syscafe ? (
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-1">
                <span className="cifra text-xl font-semibold text-ink">{t.numero_syscafe}</span>
                {puedeEditar ? (
                  <>
                    <button
                      onClick={abrirEdicion}
                      aria-label="Editar número Syscafe"
                      title="Editar"
                      className="ml-1 flex h-11 w-11 cursor-pointer items-center justify-center rounded-md text-muted transition-colors duration-150 hover:bg-surface hover:text-ink"
                    >
                      <Icono nombre="lapiz" className="h-4 w-4" />
                    </button>
                    <button
                      onClick={() => guardar(null)}
                      disabled={guardando}
                      aria-label="Borrar número Syscafe"
                      title="Borrar"
                      className="flex h-11 w-11 cursor-pointer items-center justify-center rounded-md text-danger-fg transition-colors duration-150 hover:bg-surface disabled:opacity-50"
                    >
                      <Icono nombre="basura" className="h-4 w-4" />
                    </button>
                  </>
                ) : null}
              </div>
              {t.numero_syscafe_at ? (
                <span className="text-xs text-muted">
                  {t.numero_syscafe_por ?? "—"} · {fechaHora(t.numero_syscafe_at)}
                </span>
              ) : null}
            </div>
          ) : puedeEditar ? (
            <button
              onClick={abrirEdicion}
              aria-label="Registrar número Syscafe"
              className={claseBoton("secundario", "self-start")}
            >
              <Icono nombre="mas" className="h-4 w-4" />
              Registrar número
            </button>
          ) : (
            <span className="text-sm text-muted">Pendiente</span>
          )}
        </div>

        {/* Reporte */}
        <div className="flex flex-col gap-2">
          <span className="text-xs font-medium text-muted">Reporte</span>
          <ReporteSyscafe traslado={t} puedeSubir={puedeEditar} onSubido={() => void onCambio()} />
        </div>
      </div>
    </section>
  );
}
