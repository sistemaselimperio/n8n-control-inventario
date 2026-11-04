"use client";

// Lista de puntos (/puntos): una tarjeta por punto activo (GET /puntos) con un
// resumen del mes calculado en el cliente a partir de una sola llamada a
// /traslados-puntos/syscafe (los 500 movimientos mas recientes). Si el resumen
// falla igual se listan los puntos, solo sin cifras. Cada tarjeta enlaza a
// /puntos/[id].

import { useDeferredValue, useMemo, useState } from "react";
import Link from "next/link";
import useSWR from "swr";
import { fetchPuntosPublicos, listarTrasladosSyscafe } from "@/lib/api";
import {
  CampoFiltro,
  CLASE_CAMPO,
  EncabezadoPagina,
  ErrorConReintento,
  EstadoVacio,
  SkeletonLinea,
  TarjetaFiltros,
} from "@/components/ui";
import { combinarTrasladosDePunto, kpisDePunto, type KpisPunto } from "@/lib/puntos";

// Texto sin tildes ni mayusculas, para comparar busquedas.
const normalizar = (t: string) => t.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase().trim();

function Cifra({ etiqueta, valor }: { etiqueta: string; valor: number | null }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs text-muted">{etiqueta}</span>
      <span className="cifra text-[18px] text-ink">{valor ?? "—"}</span>
    </div>
  );
}

export default function PuntosPage() {
  const [busqueda, setBusqueda] = useState("");
  const busquedaDiferida = useDeferredValue(busqueda);
  const { data: puntos, error, isLoading, mutate } = useSWR("puntos-publicos", fetchPuntosPublicos);
  const { data: movimientos } = useSWR(["puntos-resumen"], () => listarTrasladosSyscafe(), { refreshInterval: 15000 });

  const resumenes = useMemo(() => {
    const mapa = new Map<string, KpisPunto>();
    if (!movimientos) return mapa;
    for (const p of puntos ?? []) {
      const delPunto = movimientos.filter((f) => f.punto_origen_id === p.id || f.punto_destino_id === p.id);
      mapa.set(p.id, kpisDePunto(combinarTrasladosDePunto(delPunto, [], p.id), p.id));
    }
    return mapa;
  }, [puntos, movimientos]);

  const visibles = useMemo(() => {
    const q = normalizar(busquedaDiferida);
    return (puntos ?? []).filter((p) => !q || normalizar(`${p.nombre} ${p.codigo ?? ""}`).includes(q));
  }, [puntos, busquedaDiferida]);

  return (
    <main className="mx-auto flex w-full max-w-7xl flex-1 flex-col gap-5 px-4 py-6 sm:px-6 sm:py-8">
      <EncabezadoPagina
        titulo="Puntos"
        descripcion="Cada punto de venta con su actividad del mes. Abre uno para ver sus traslados, su talonario y sus usuarios."
      />

      <TarjetaFiltros
        etiqueta="Filtros de puntos"
        resumen={isLoading ? "Cargando…" : `${visibles.length} ${visibles.length === 1 ? "punto" : "puntos"}`}
      >
        <CampoFiltro id="puntos-buscar" etiqueta="Buscar punto" className="w-full sm:w-80">
          <input
            id="puntos-buscar"
            type="search"
            value={busqueda}
            onChange={(e) => setBusqueda(e.target.value)}
            placeholder="Nombre o código"
            autoComplete="off"
            className={CLASE_CAMPO}
          />
        </CampoFiltro>
      </TarjetaFiltros>

      {error ? (
        <ErrorConReintento mensaje="No se pudieron cargar los puntos." onReintentar={() => mutate()} />
      ) : isLoading ? (
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" aria-busy>
          {Array.from({ length: 6 }, (_, i) => (
            <li key={i} className="rounded-lg border border-line bg-surface p-4">
              <SkeletonLinea className="h-5 w-40" />
              <SkeletonLinea className="mt-4 h-8 w-full" />
            </li>
          ))}
        </ul>
      ) : visibles.length === 0 ? (
        <div className="rounded-lg border border-line bg-surface">
          <EstadoVacio titulo={busqueda.trim() ? "Ningún punto coincide con la búsqueda." : "No hay puntos para mostrar."} />
        </div>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {visibles.map((p) => {
            const r = resumenes.get(p.id);
            return (
              <li key={p.id}>
                <Link
                  href={`/puntos/${p.id}`}
                  className="flex h-full flex-col gap-4 rounded-lg border border-line bg-surface p-4 transition-colors duration-150 hover:border-line-strong hover:bg-page/60"
                >
                  <span className="flex items-start justify-between gap-3">
                    <span className="text-base font-semibold text-ink">{p.nombre}</span>
                    {p.codigo ? <span className="cifra shrink-0 text-xs text-muted">{p.codigo}</span> : null}
                  </span>
                  <span className="grid grid-cols-3 gap-3">
                    <Cifra etiqueta="Del mes" valor={r?.delMes ?? null} />
                    <Cifra etiqueta="Por recibir" valor={r?.pendientesRecibir ?? null} />
                    <Cifra etiqueta="Sin Syscafe" valor={r?.sinSyscafe ?? null} />
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}
