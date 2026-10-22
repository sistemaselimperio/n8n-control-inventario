"use client";

// Panel de traslados entre puntos (ver apps/backend/app/services/traslados_puntos.py):
// tabla de traslados y hojas anuladas con su numero Syscafe (pendientes primero,
// marcados con una regla dorada a la izquierda), filtros por punto/estado/fechas,
// detalle en modal al hacer clic en una fila y feed de "Actividad reciente".
// Mismo lenguaje visual que Hoy y Entregas. admin/supervisor registran o
// corrigen el Syscafe en una caja pequeña que se abre encima de la celda
// (CajaSyscafe: prefijo + indicativo) o desde el detalle; consulta lo ve en solo lectura.

import { useCallback, useDeferredValue, useMemo, useState } from "react";
import useSWR from "swr";
import {
  fetchActividadTraslados,
  fetchPuntosPublicos,
  listarTrasladosSyscafe,
  type ActividadTraslado,
  type FilaTrasladoSyscafe,
} from "@/lib/api";
import {
  claseBoton,
  EncabezadoPagina,
  ErrorConReintento,
  EstadoVacio,
  Icono,
  Panel,
  Pildora,
  type TonoPildora,
} from "@/components/ui";
import { useSesion } from "@/lib/SesionProvider";
import { areaEfectiva } from "@/lib/sesion";
import {
  EMPRESAS_TALONARIO,
  empresaTalonario,
  ESTADOS,
  fechaCorta,
  fechaHora,
  letraTalonario,
  referencia,
} from "@/components/traslados/compartido";
import { ModalAnulada } from "@/components/traslados/ModalAnulada";
import { ModalDetalleTraslado } from "@/components/traslados/ModalDetalleTraslado";
import { CajaSyscafe } from "@/components/traslados/CajaSyscafe";

// Texto sin tildes ni mayusculas, para comparar busquedas.
const normalizar = (t: string) => t.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase().trim();
const compacto = (t: string) => t.replace(/[\s\-_./]+/g, "");

// Todo el texto visible de la fila en la tabla, normalizado.
function textoBusqueda(f: FilaTrasladoSyscafe): string {
  return normalizar(
    [
      referencia(f),
      empresaTalonario(f),
      f.numero_syscafe,
      f.numero_talonario,
      f.punto_origen_nombre,
      f.punto_destino_nombre,
      f.anulado_por_nombre,
      f.motivo,
      ESTADOS[f.estado]?.texto ?? f.estado,
      f.numero_syscafe ? "" : "pendiente",
      f.tipo === "anulada" ? "anulada" : "",
      fechaCorta(f.fecha),
    ]
      .filter(Boolean)
      .join(" "),
  );
}

export default function TrasladosPage() {
  const { usuario, puedeEditar } = useSesion();
  // Supervisores de area "bodega" no pueden escribir Syscafe (el backend responde 403).
  const puedeAsignar = puedeEditar && ["todo", "traslados"].includes(areaEfectiva(usuario));
  const [puntoId, setPuntoId] = useState("");
  const [estado, setEstado] = useState("");
  // Letra del talonario ("A", "V") para ver solo una empresa; "" = todas.
  const [empresa, setEmpresa] = useState("");
  const [soloPendientes, setSoloPendientes] = useState(false);
  const [fechaDesde, setFechaDesde] = useState("");
  const [fechaHasta, setFechaHasta] = useState("");
  const [busqueda, setBusqueda] = useState("");
  const busquedaDiferida = useDeferredValue(busqueda);

  const { data: puntos } = useSWR("puntos-publicos", fetchPuntosPublicos);
  const {
    data: filas,
    error,
    isLoading,
    mutate: recargar,
  } = useSWR(
    ["traslados-syscafe", puntoId, soloPendientes, fechaDesde, fechaHasta],
    () =>
      listarTrasladosSyscafe({
        puntoId: puntoId || undefined,
        pendientes: soloPendientes,
        desde: fechaDesde || undefined,
        hasta: fechaHasta || undefined,
      }),
    { refreshInterval: 5000 },
  );
  const {
    data: actividad,
    isLoading: actividadCargando,
    mutate: recargarActividad,
  } = useSWR("traslados-actividad", () => fetchActividadTraslados(50), { refreshInterval: 5000 });

  // Traslado con la caja de Syscafe abierta y la celda sobre la que se abre.
  const [syscafe, setSyscafe] = useState<{ fila: FilaTrasladoSyscafe; ancla: DOMRect } | null>(null);
  const cerrarSyscafe = useCallback(() => setSyscafe(null), []);
  const [detalleId, setDetalleId] = useState<string | null>(null);
  const [anuladaDetalle, setAnuladaDetalle] = useState<FilaTrasladoSyscafe | null>(null);

  // El orden (pendientes primero) viene del backend y el filtro lo conserva.
  const porEstado = useMemo(
    () =>
      (filas ?? []).filter(
        (f) => (!estado || f.estado === estado) && (!empresa || letraTalonario(f) === empresa),
      ),
    [filas, estado, empresa],
  );
  const visibles = useMemo(() => {
    const q = normalizar(busquedaDiferida);
    if (!q) return porEstado;
    const qc = compacto(q);
    return porEstado.filter((f) => {
      const texto = textoBusqueda(f);
      return texto.includes(q) || (qc.length > 0 && compacto(texto).includes(qc));
    });
  }, [porEstado, busquedaDiferida]);
  const textoBuscado = busquedaDiferida.trim();

  const abrirFila = (fila: FilaTrasladoSyscafe) => {
    if (fila.tipo === "anulada") setAnuladaDetalle(fila);
    else setDetalleId(fila.id);
  };

  const claseCampo = "min-h-11 rounded-md border border-line-strong bg-surface px-3 text-sm text-ink";

  return (
    <main className="mx-auto flex w-full max-w-7xl flex-1 flex-col gap-6 px-4 py-8 sm:px-6 sm:py-10">
      <EncabezadoPagina
        titulo="Traslados"
        descripcion="Revisa cada traslado de talonario y registra su número en Syscafe (por ejemplo NBR-945). Los pendientes aparecen primero; haz clic en una fila para ver el detalle."
      />

      {/* Filtros y tabla en una sola superficie: los filtros arriba, separados
          de las filas por una regla. */}
      <section aria-label="Traslados" className="overflow-hidden rounded-lg border border-line bg-surface">
        <div className="flex flex-wrap items-end gap-3 border-b border-line p-4">
          <div className="flex w-full flex-col gap-1">
            <label htmlFor="traslados-buscar" className="text-xs font-medium text-muted">
              Buscar traslado
            </label>
            <div className="relative">
              <input
                id="traslados-buscar"
                type="search"
                value={busqueda}
                onChange={(e) => setBusqueda(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") setBusqueda("");
                }}
                placeholder="Buscar por número Syscafe, talonario, punto o persona…"
                autoComplete="off"
                className={`${claseCampo} h-11 w-full pr-11 [&::-webkit-search-cancel-button]:hidden`}
              />
              {busqueda ? (
                <button
                  type="button"
                  onClick={() => setBusqueda("")}
                  aria-label="Borrar búsqueda"
                  className="absolute right-0 top-0 flex h-11 w-11 items-center justify-center rounded-md text-muted transition-colors duration-150 hover:text-ink"
                >
                  <svg
                    aria-hidden
                    viewBox="0 0 24 24"
                    className="h-4 w-4"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={2}
                    strokeLinecap="round"
                  >
                    <path d="M6 6l12 12M18 6 6 18" />
                  </svg>
                </button>
              ) : null}
            </div>
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="traslados-punto" className="text-xs font-medium text-muted">
              Punto de origen
            </label>
            <select
              id="traslados-punto"
              value={puntoId}
              onChange={(e) => setPuntoId(e.target.value)}
              className={claseCampo}
            >
              <option value="">Todos los puntos</option>
              {(puntos ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.nombre}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="traslados-estado" className="text-xs font-medium text-muted">
              Estado
            </label>
            <select
              id="traslados-estado"
              value={estado}
              onChange={(e) => setEstado(e.target.value)}
              className={claseCampo}
            >
              <option value="">Todos</option>
              {Object.entries(ESTADOS).map(([valor, { texto }]) => (
                <option key={valor} value={valor}>
                  {texto}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="traslados-empresa" className="text-xs font-medium text-muted">
              Empresa
            </label>
            <select
              id="traslados-empresa"
              value={empresa}
              onChange={(e) => setEmpresa(e.target.value)}
              className={claseCampo}
            >
              <option value="">Todas</option>
              {EMPRESAS_TALONARIO.map((e) => (
                <option key={e.letra} value={e.letra}>
                  {e.nombre} ({e.letra})
                </option>
              ))}
            </select>
          </div>
          {/* Rango de fechas -- desde/hasta con "Todo" para volver a no filtrar. */}
          <div className="flex flex-col gap-1">
            <label htmlFor="traslados-desde" className="text-xs font-medium text-muted">
              Desde
            </label>
            <input
              id="traslados-desde"
              type="date"
              value={fechaDesde}
              onChange={(e) => setFechaDesde(e.target.value)}
              max={fechaHasta || undefined}
              className={claseCampo}
            />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="traslados-hasta" className="text-xs font-medium text-muted">
              Hasta
            </label>
            <input
              id="traslados-hasta"
              type="date"
              value={fechaHasta}
              onChange={(e) => setFechaHasta(e.target.value)}
              min={fechaDesde || undefined}
              className={claseCampo}
            />
          </div>
          <button
            onClick={() => {
              setFechaDesde("");
              setFechaHasta("");
            }}
            aria-pressed={!fechaDesde && !fechaHasta}
            className={`min-h-11 rounded-md border px-3 text-sm font-medium transition-colors duration-150 ${
              !fechaDesde && !fechaHasta
                ? "border-brand-blue bg-brand-blue text-white"
                : "border-line-strong bg-surface text-soft hover:bg-surface-2"
            }`}
          >
            Todas las fechas
          </button>
          <label className="flex min-h-11 cursor-pointer items-center gap-2 text-sm text-ink">
            <input
              type="checkbox"
              checked={soloPendientes}
              onChange={(e) => setSoloPendientes(e.target.checked)}
              className="h-5 w-5 cursor-pointer accent-brand-blue"
            />
            Solo pendientes de Syscafe
          </label>
          <p className="ml-auto text-sm tabular-nums text-muted" aria-live="polite">
            {isLoading
              ? "Cargando…"
              : textoBuscado
                ? `Mostrando ${visibles.length} de ${porEstado.length}`
                : `${visibles.length} ${visibles.length === 1 ? "fila" : "filas"}`}
          </p>
        </div>

        {error ? (
          <div className="p-4">
            <ErrorConReintento mensaje="No se pudieron cargar los traslados." onReintentar={() => recargar()} />
          </div>
        ) : null}

        {isLoading ? (
          <ul className="flex flex-col divide-y divide-line" aria-busy>
            {Array.from({ length: 6 }, (_, i) => (
              <li key={i} className="px-4 py-3">
                <div className="h-5 animate-pulse rounded bg-surface-2" />
              </li>
            ))}
          </ul>
        ) : visibles.length === 0 && textoBuscado ? (
          <div className="flex flex-col items-center gap-3 py-10 text-center">
            <p className="px-4 text-sm text-muted">
              Ningún traslado coincide con «{textoBuscado}». Revisa el número o borra la búsqueda.
            </p>
            <button type="button" onClick={() => setBusqueda("")} className={claseBoton("secundario")}>
              Borrar búsqueda
            </button>
          </div>
        ) : visibles.length === 0 ? (
          <EstadoVacio
            titulo={soloPendientes ? "No hay traslados pendientes de Syscafe." : "No hay traslados para mostrar."}
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[820px] text-left text-sm">
              <thead className="border-b border-line text-xs text-muted">
                <tr>
                  <th scope="col" className="py-3 pl-4 pr-3 font-medium">
                    Talonario
                  </th>
                  <th scope="col" className="px-3 py-3 font-medium">
                    Syscafe
                  </th>
                  <th scope="col" className="px-3 py-3 font-medium">
                    Origen y destino
                  </th>
                  <th scope="col" className="px-3 py-3 font-medium">
                    Fecha
                  </th>
                  <th scope="col" className="px-3 py-3 font-medium">
                    Estado
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {visibles.map((fila) => {
                  const anulada = fila.tipo === "anulada";
                  const pendiente = !anulada && !fila.numero_syscafe;
                  const info = ESTADOS[fila.estado] ?? { texto: fila.estado, tono: "neutro" as TonoPildora };
                  return (
                    <tr
                      key={`${fila.tipo}:${fila.id}`}
                      tabIndex={0}
                      onClick={() => abrirFila(fila)}
                      onKeyDown={(e) => {
                        if (e.target === e.currentTarget && e.key === "Enter") abrirFila(fila);
                      }}
                      className="min-h-11 cursor-pointer transition-colors duration-150 hover:bg-surface-2 focus-visible:bg-surface-2"
                    >
                      {/* Regla dorada a la izquierda: lo pendiente de Syscafe.
                          El texto "Pendiente" de la columna siguiente es la
                          otra pista (el color no va solo). */}
                      <td
                        className={`whitespace-nowrap border-l-4 py-2.5 pl-3 pr-3 ${
                          pendiente ? "border-brand-gold" : "border-transparent"
                        }`}
                      >
                        <span className={`cifra block text-[16px] ${anulada ? "text-muted" : "text-ink"}`}>
                          {referencia(fila)}
                        </span>
                        {empresaTalonario(fila) ? (
                          <span className="block text-xs text-muted">{empresaTalonario(fila)}</span>
                        ) : null}
                      </td>
                      <td className="px-3 py-2.5" onClick={(e) => e.stopPropagation()}>
                        {anulada ? (
                          <span className="text-xs text-muted" title={fila.motivo ?? undefined}>
                            {fila.motivo ? `Motivo: ${fila.motivo}` : "—"}
                          </span>
                        ) : (
                          <div className="flex items-center gap-2">
                            {fila.numero_syscafe ? (
                              <span className="cifra text-[16px] text-ink">{fila.numero_syscafe}</span>
                            ) : (
                              <Pildora tono="warn">Pendiente</Pildora>
                            )}
                            {puedeAsignar ? (
                              <button
                                type="button"
                                onClick={(e) => {
                                  const celda = e.currentTarget.closest("td") ?? e.currentTarget;
                                  setSyscafe({ fila, ancla: celda.getBoundingClientRect() });
                                }}
                                title={fila.numero_syscafe ? "Editar número Syscafe" : "Registrar número Syscafe"}
                                aria-label={`${fila.numero_syscafe ? "Editar" : "Registrar"} número Syscafe de ${referencia(fila)}`}
                                className={`flex h-8 w-8 cursor-pointer items-center justify-center rounded-md transition-colors duration-150 ${
                                  fila.numero_syscafe
                                    ? "text-muted hover:bg-surface-2 hover:text-ink"
                                    : "border border-brand-gold/50 bg-brand-gold/10 text-brand-gold hover:bg-brand-gold/20"
                                }`}
                              >
                                <Icono nombre={fila.numero_syscafe ? "lapiz" : "mas"} className="h-4 w-4" />
                              </button>
                            ) : null}
                          </div>
                        )}
                      </td>
                      <td className="px-3 py-2.5 text-ink">
                        {anulada ? (
                          (fila.punto_origen_nombre ?? "—")
                        ) : (
                          <>
                            {fila.punto_origen_nombre ?? "—"}
                            <Icono nombre="derecha" className="mx-1.5 inline h-3.5 w-3.5 align-text-bottom text-muted" />
                            <span className="sr-only">a</span>
                            {fila.punto_destino_nombre ?? "—"}
                          </>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2.5 text-muted">{fechaCorta(fila.fecha)}</td>
                      <td className="px-3 py-2.5">
                        <Pildora tono={info.tono}>{info.texto}</Pildora>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <Panel
        titulo="Actividad reciente"
        subtitulo="Qué fue pasando con los traslados, en lenguaje simple."
        conteo={!actividadCargando ? `${actividad?.length ?? 0}` : undefined}
        conRelleno={false}
      >
        {!actividadCargando && (actividad?.length ?? 0) === 0 ? (
          <EstadoVacio titulo="Sin actividad registrada todavía." />
        ) : (
          <ul className="flex flex-col divide-y divide-line">
            {(actividad ?? []).map((a: ActividadTraslado, i) => (
              <li
                key={`${a.tipo}:${a.momento}:${i}`}
                className="flex min-h-11 flex-wrap items-center justify-between gap-x-3 gap-y-1 px-4 py-2.5 text-sm text-soft sm:px-5"
              >
                <span>{a.texto}</span>
                <span className="shrink-0 text-xs text-subtle">{fechaHora(a.momento)}</span>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      {detalleId ? (
        <ModalDetalleTraslado
          id={detalleId}
          puedeAsignar={puedeAsignar}
          onCerrar={() => setDetalleId(null)}
          onCambio={() => {
            recargar();
            recargarActividad();
          }}
        />
      ) : null}

      {syscafe ? (
        <CajaSyscafe
          key={syscafe.fila.id}
          fila={syscafe.fila}
          ancla={syscafe.ancla}
          onCerrar={cerrarSyscafe}
          onGuardado={() => {
            recargar();
            recargarActividad();
          }}
        />
      ) : null}

      {anuladaDetalle ? <ModalAnulada fila={anuladaDetalle} onCerrar={() => setAnuladaDetalle(null)} /> : null}
    </main>
  );
}
