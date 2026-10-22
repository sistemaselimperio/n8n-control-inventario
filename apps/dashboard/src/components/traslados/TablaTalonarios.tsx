"use client";

// Talonarios por punto: una columna por empresa (EMPRESAS_TALONARIO) para ver,
// por separado, que puntos ya configuraron cada talonario y cuantas hojas les
// quedan. Plegada por defecto; el subtitulo resume los conteos.

import { useState } from "react";
import useSWR from "swr";
import { fetchResumenTalonarios, type TalonarioActivo } from "@/lib/api";
import { claseBoton, ErrorConReintento, Panel, Pildora } from "@/components/ui";
import { EMPRESAS_TALONARIO } from "@/components/traslados/compartido";

function CeldaTalonario({ talonario }: { talonario: TalonarioActivo | undefined }) {
  if (!talonario) return <Pildora tono="error">Sin configurar</Pildora>;
  const tono = talonario.agotado ? "error" : talonario.quedan <= talonario.umbral_aviso ? "warn" : "ok";
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="cifra text-ink">{talonario.rango}</span>
      <Pildora tono={tono}>{talonario.agotado ? "Agotado" : `Quedan ${talonario.quedan}`}</Pildora>
    </div>
  );
}

export function TablaTalonarios() {
  const [abierto, setAbierto] = useState(false);
  const { data, error, isLoading, mutate } = useSWR("talonarios-resumen", fetchResumenTalonarios, {
    refreshInterval: 5000,
  });

  const total = data?.length ?? 0;
  const resumen = EMPRESAS_TALONARIO.map(
    (e) => `${(data ?? []).filter((p) => p.talonarios.some((t) => t.letra === e.letra)).length} de ${total} con ${e.letra}`,
  ).join(" · ");

  return (
    <Panel
      titulo="Talonarios por punto"
      subtitulo={isLoading ? "Cargando…" : `Qué puntos ya configuraron cada talonario: ${resumen}.`}
      conRelleno={false}
      acciones={
        <button
          type="button"
          onClick={() => setAbierto((v) => !v)}
          aria-expanded={abierto}
          className={claseBoton("secundario")}
        >
          {abierto ? "Ocultar" : "Ver detalle"}
        </button>
      }
    >
      {error ? (
        <div className="p-4">
          <ErrorConReintento mensaje="No se pudieron cargar los talonarios." onReintentar={() => mutate()} />
        </div>
      ) : abierto ? (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-left text-sm">
            <thead className="border-b border-line text-xs text-muted">
              <tr>
                <th scope="col" className="py-3 pl-4 pr-3 font-medium">
                  Punto
                </th>
                {EMPRESAS_TALONARIO.map((e) => (
                  <th key={e.letra} scope="col" className="px-3 py-3 font-medium">
                    {e.nombre} ({e.letra})
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {(data ?? []).map((p) => (
                <tr key={p.punto_id}>
                  <td className="py-2.5 pl-4 pr-3 text-ink">{p.punto_nombre}</td>
                  {EMPRESAS_TALONARIO.map((e) => (
                    <td key={e.letra} className="px-3 py-2.5">
                      <CeldaTalonario talonario={p.talonarios.find((t) => t.letra === e.letra)} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </Panel>
  );
}
