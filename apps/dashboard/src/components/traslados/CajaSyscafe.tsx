"use client";

// Caja pequeña para registrar el numero Syscafe de un traslado: se abre encima
// de la celda "Pendiente" de la fila, con solo dos campos -- prefijo (NBR) e
// indicativo (945) -- que se guardan como "NBR-945". Enter guarda; Escape, un
// clic afuera, el scroll o un cambio de tamaño la cierran.

import { useEffect, useRef, useState, type KeyboardEvent as EventoTeclado } from "react";
import { toast } from "sonner";
import { asignarSyscafeDashboard, type FilaTrasladoSyscafe } from "@/lib/api";
import { Icono } from "@/components/ui";
import { referencia } from "./compartido";

// Ultimo prefijo guardado en esta pestaña: casi siempre se repite, asi que la
// siguiente caja ya lo trae puesto.
let ultimoPrefijo = "";

// Ancho aproximado de la caja, solo para no salirse por la derecha.
const ANCHO_CAJA = 230;

// "NBR-945" -> ["NBR", "945"], "TB9-120" -> ["TB9", "120"]; si no tiene ese
// formato, todo va al prefijo.
function separar(numero: string | null): [string, string] {
  if (!numero) return [ultimoPrefijo, ""];
  const texto = numero.trim();
  const m = /^([A-Z][A-Z0-9]*)-(\d+)$/.exec(texto) ?? /^([A-Z]+)(\d+)$/.exec(texto);
  return m ? [m[1], m[2]] : [numero, ""];
}

export function CajaSyscafe({
  fila,
  ancla,
  onCerrar,
  onGuardado,
}: {
  fila: FilaTrasladoSyscafe;
  // Rectangulo de la celda sobre la que se abre la caja.
  ancla: DOMRect;
  onCerrar: () => void;
  onGuardado: () => void;
}) {
  const [inicialPrefijo, inicialIndicativo] = separar(fila.numero_syscafe);
  const [prefijo, setPrefijo] = useState(inicialPrefijo);
  const [indicativo, setIndicativo] = useState(inicialIndicativo);
  const [guardando, setGuardando] = useState(false);
  const caja = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const alTecla = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") onCerrar();
    };
    const alPulsar = (ev: PointerEvent) => {
      if (!caja.current?.contains(ev.target as Node)) onCerrar();
    };
    document.addEventListener("keydown", alTecla);
    document.addEventListener("pointerdown", alPulsar);
    window.addEventListener("resize", onCerrar);
    window.addEventListener("scroll", onCerrar, true);
    return () => {
      document.removeEventListener("keydown", alTecla);
      document.removeEventListener("pointerdown", alPulsar);
      window.removeEventListener("resize", onCerrar);
      window.removeEventListener("scroll", onCerrar, true);
    };
  }, [onCerrar]);

  const numero = prefijo && indicativo ? `${prefijo}-${indicativo}` : "";
  const valido = numero !== "" && numero !== fila.numero_syscafe;

  const guardar = async (nuevo: string | null) => {
    setGuardando(true);
    try {
      await asignarSyscafeDashboard(fila.id, nuevo);
      if (nuevo) ultimoPrefijo = prefijo;
      toast.success(nuevo ? `Syscafe ${nuevo} guardado en ${referencia(fila)}` : "Número Syscafe borrado");
      onGuardado();
      onCerrar();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "No se pudo guardar el número Syscafe");
      setGuardando(false);
    }
  };

  const alEnter = (ev: EventoTeclado<HTMLInputElement>) => {
    if (ev.key === "Enter" && valido && !guardando) {
      ev.preventDefault();
      guardar(numero);
    }
  };

  // Encima de la celda, sin salirse de la pantalla por la derecha.
  const left = Math.max(8, Math.min(ancla.left, window.innerWidth - ANCHO_CAJA - 8));
  const top = Math.max(8, ancla.top + ancla.height / 2 - 21);
  const claseCampo =
    "cifra h-8 rounded border border-line-strong bg-surface px-1.5 text-sm uppercase tracking-wide text-ink focus:border-brand-gold focus:outline-none";

  return (
    <div
      ref={caja}
      role="dialog"
      aria-label={`Número Syscafe del traslado ${referencia(fila)}`}
      style={{ left, top }}
      className="fixed z-50 flex rounded-md border border-brand-gold/50 bg-surface p-1.5 shadow-lg shadow-brand-night/30"
    >
      <div className="flex items-center gap-1">
        {/* Con el prefijo ya puesto (el ultimo usado) se arranca en el indicativo. */}
        <input
          autoFocus={!inicialPrefijo}
          value={prefijo}
          // Letras y numeros (ej. TB9), empezando por letra y hasta 4: lo que acepta el backend.
          onChange={(e) =>
            setPrefijo(
              e.target.value
                .toUpperCase()
                .replace(/[^A-Z0-9]/g, "")
                .replace(/^\d+/, "")
                .slice(0, 4),
            )
          }
          onKeyDown={alEnter}
          placeholder="NBR"
          aria-label="Prefijo"
          autoComplete="off"
          className={`${claseCampo} w-14`}
        />
        <span aria-hidden className="text-muted">
          –
        </span>
        <input
          autoFocus={!!inicialPrefijo}
          value={indicativo}
          onChange={(e) => setIndicativo(e.target.value.replace(/\D/g, "").slice(0, 8))}
          onKeyDown={alEnter}
          placeholder="945"
          inputMode="numeric"
          aria-label="Indicativo"
          autoComplete="off"
          className={`${claseCampo} w-20`}
        />
        <button
          type="button"
          onClick={() => guardar(numero)}
          disabled={!valido || guardando}
          title="Guardar"
          aria-label="Guardar número Syscafe"
          className="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded bg-brand-gold text-brand-ink transition-colors duration-150 hover:bg-gold-hover disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Icono nombre="check" className="h-3.5 w-3.5" />
        </button>
        {fila.numero_syscafe ? (
          <button
            type="button"
            onClick={() => guardar(null)}
            disabled={guardando}
            title="Borrar número"
            aria-label="Borrar número Syscafe"
            className="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded text-danger transition-colors duration-150 hover:bg-surface-2 disabled:opacity-50"
          >
            <Icono nombre="basura" className="h-3.5 w-3.5" />
          </button>
        ) : null}
      </div>
    </div>
  );
}
