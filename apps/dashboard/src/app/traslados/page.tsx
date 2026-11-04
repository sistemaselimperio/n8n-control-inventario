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
  type TipoTraslado,
} from "@/lib/api";
import {
  claseBoton,
  CLASE_CAMPO,
  CLASE_FILA_CLICABLE,
  CLASE_TABLA,
  CLASE_TBODY,
  CLASE_THEAD,
  EncabezadoPagina,
  ErrorConReintento,
  EstadoVacio,
  Icono,
  Panel,
  Pildora,
  type TonoPildora,
} from "@/components/ui";
import { useSesion } from "@/lib/SesionProvider";
import {
  ATAJOS_FECHA,
  BotonLimpiarFiltros,
  BuscadorBarra,
  CamposRangoFecha,
  MenuFiltro,
  PestanasConteo,
  rangoDeAtajo,
  textoFecha,
  type ModoFecha,
} from "@/components/filtros";
import { areaEfectiva } from "@/lib/sesion";
import {
  EMPRESAS_TALONARIO,
  empresaTalonario,
  ESTADOS,
  fechaCorta,
  fechaHora,
  letraTalonario,
  ORIGEN_DIRECTO,
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
      f.tipo_traslado === "directo" ? ORIGEN_DIRECTO : "",
      f.punto_destino_nombre,
      f.anulado_por_nombre,
      f.motivo,
      ESTADOS[f.estado]?.texto ?? f.estado,
      // Una hoja anulada no queda pendiente de Syscafe (la tabla no lo muestra).
      f.numero_syscafe || f.tipo === "anulada" ? "" : "pendiente",
      f.tipo === "anulada" ? "anulada" : "",
      fechaCorta(f.fecha),
      // No se ve en la tabla, pero es como se archiva la solucion de una novedad (ej. NPT-1234).
      f.consecutivo_solucion,
    ]
      .filter(Boolean)
      .join(" "),
  );
}

type Vista =
  | "todos"
  | "pendientes"
  | "en_transito"
  | "novedad_pendiente"
  | "novedad_resuelta"
  | "recibido"
  | "anulada";

type FiltroNovedad = "" | "pendiente" | "resuelta";

// Vistas rapidas en el orden del trabajo: lo que falta primero.
const VISTAS: { valor: Vista; texto: string; tono?: TonoPildora }[] = [
  { valor: "todos", texto: "Todos" },
  { valor: "pendientes", texto: "Pendiente N° Traslado", tono: "warn" },
  { valor: "en_transito", texto: "En tránsito", tono: ESTADOS.en_transito.tono },
  { valor: "novedad_pendiente", texto: "Novedad pendiente", tono: "error" },
  { valor: "novedad_resuelta", texto: "Novedad resuelta", tono: "ok" },
  { valor: "recibido", texto: "Recibidos", tono: ESTADOS.recibido.tono },
  { valor: "anulada", texto: "Anuladas", tono: ESTADOS.anulada.tono },
];

export default function TrasladosPage() {
  const { usuario, puedeEditar } = useSesion();
  // Supervisores de area "bodega" no pueden escribir Syscafe (el backend responde 403).
  const puedeAsignar = puedeEditar && ["todo", "traslados"].includes(areaEfectiva(usuario));
  const [puntoId, setPuntoId] = useState("");
  const [estado, setEstado] = useState("");
  // Letra del talonario ("A", "V") para ver solo una empresa; "" = todas.
  const [empresa, setEmpresa] = useState("");
  const [soloPendientes, setSoloPendientes] = useState(false);
  // Novedades: "pendiente" o "resuelta" (segun novedad_estado); "" = sin filtrar.
  const [novedad, setNovedad] = useState<FiltroNovedad>("");
  // Clase de traslado: entre puntos o llegada directa del proveedor; "" = todos.
  const [tipo, setTipo] = useState<"" | TipoTraslado>("");
  const [fechaDesde, setFechaDesde] = useState("");
  const [fechaHasta, setFechaHasta] = useState("");
  // Atajo de fecha elegido; "elegir" muestra los campos Desde/Hasta.
  const [modoFecha, setModoFecha] = useState<ModoFecha>("todas");
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
        (f) =>
          (!estado || f.estado === estado) &&
          (!novedad || f.novedad_estado === novedad) &&
          (!empresa || letraTalonario(f) === empresa) &&
          (!tipo || f.tipo_traslado === tipo),
      ),
    [filas, estado, novedad, empresa, tipo],
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

  // Vista rapida: "pendientes" es un filtro del servidor (sin numero Syscafe);
  // las demas filtran por estado en el cliente.
  const vista: Vista = soloPendientes
    ? "pendientes"
    : novedad
      ? `novedad_${novedad}`
      : ((estado || "todos") as Vista);
  const elegirVista = (v: Vista) => {
    setSoloPendientes(v === "pendientes");
    setNovedad(v === "novedad_pendiente" ? "pendiente" : v === "novedad_resuelta" ? "resuelta" : "");
    setEstado(["todos", "pendientes", "novedad_pendiente", "novedad_resuelta"].includes(v) ? "" : v);
  };
  const conteos = useMemo(() => {
    const lista = filas ?? [];
    const porEstadoDe = (e: string) => lista.filter((f) => f.estado === e).length;
    return {
      todos: lista.length,
      pendientes: lista.filter((f) => !f.numero_syscafe && f.tipo !== "anulada").length,
      en_transito: porEstadoDe("en_transito"),
      novedad_pendiente: lista.filter((f) => f.novedad_estado === "pendiente").length,
      novedad_resuelta: lista.filter((f) => f.novedad_estado === "resuelta").length,
      recibido: porEstadoDe("recibido"),
      anulada: porEstadoDe("anulada"),
    } satisfies Record<Vista, number>;
  }, [filas]);

  const elegirModoFecha = (m: ModoFecha) => {
    setModoFecha(m);
    const [desde, hasta] = rangoDeAtajo(m, new Date()) ?? [fechaDesde, fechaHasta];
    setFechaDesde(desde);
    setFechaHasta(hasta);
  };

  const hayFiltros = Boolean(
    puntoId || estado || novedad || empresa || soloPendientes || tipo || fechaDesde || fechaHasta || busqueda,
  );
  const limpiarFiltros = () => {
    setPuntoId("");
    setEstado("");
    setEmpresa("");
    setSoloPendientes(false);
    setNovedad("");
    setTipo("");
    setModoFecha("todas");
    setFechaDesde("");
    setFechaHasta("");
    setBusqueda("");
  };

  const abrirFila = (fila: FilaTrasladoSyscafe) => {
    if (fila.tipo === "anulada") setAnuladaDetalle(fila);
    else setDetalleId(fila.id);
  };

  const claseCampo = CLASE_CAMPO;

  return (
    <main className="mx-auto flex w-full max-w-7xl flex-1 flex-col gap-5 px-4 py-6 sm:px-6 sm:py-8">
      <EncabezadoPagina
        titulo="Traslados"
        descripcion="Revisa cada traslado y registra su número en Syscafe (por ejemplo NBR-945). Haz clic en una fila para ver el detalle."
      />

      {/* Traslados: titulo con total, vistas como pestañas subrayadas con
          su conteo, una barra con la busqueda y filtros que se leen como
          frase ("Fecha: Hoy"), y la tabla debajo. */}
      <section aria-labelledby="traslados-titulo" className="rounded-lg border border-line bg-surface">
        <div className="flex flex-wrap items-baseline justify-between gap-2 px-4 pt-3 sm:px-5">
          <h2 id="traslados-titulo" className="text-base font-semibold text-ink">
            Traslados
          </h2>
          <p className="text-sm tabular-nums text-muted" aria-live="polite">
            {isLoading
              ? "Cargando…"
              : textoBuscado
                ? `Mostrando ${visibles.length} de ${porEstado.length}`
                : `${visibles.length} ${visibles.length === 1 ? "traslado" : "traslados"}`}
          </p>
        </div>

        <div className="mt-1">
          <PestanasConteo
            etiqueta="Vista"
            valor={vista}
            onCambio={elegirVista}
            sinConteo={isLoading}
            opciones={VISTAS.map((v) => ({ ...v, conteo: conteos[v.valor] }))}
          />
        </div>

        <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3 sm:px-5">
          <BuscadorBarra
            id="traslados-buscar"
            etiqueta="Buscar traslado"
            valor={busqueda}
            onCambio={setBusqueda}
            placeholder="Buscar Syscafe, talonario, punto, persona o consecutivo"
            claseCampo={claseCampo}
          />

          <MenuFiltro
            etiqueta="Punto"
            valorTexto={(puntos ?? []).find((p) => p.id === puntoId)?.nombre ?? "Todos"}
            activo={Boolean(puntoId)}
            valor={puntoId}
            onCambio={setPuntoId}
            opciones={[{ valor: "", texto: "Todos los puntos" }, ...(puntos ?? []).map((p) => ({ valor: p.id, texto: p.nombre }))]}
          />
          <MenuFiltro
            etiqueta="Fecha"
            valorTexto={textoFecha(modoFecha, fechaDesde, fechaHasta)}
            activo={modoFecha !== "todas"}
            valor={modoFecha}
            onCambio={elegirModoFecha}
            opciones={ATAJOS_FECHA.map((x) => ({ ...x, mantenerAbierto: x.valor === "elegir" }))}
          >
            {modoFecha === "elegir" ? (
              <CamposRangoFecha
                idBase="traslados"
                desde={fechaDesde}
                hasta={fechaHasta}
                onDesde={setFechaDesde}
                onHasta={setFechaHasta}
                claseCampo={claseCampo}
              />
            ) : null}
          </MenuFiltro>
          <MenuFiltro
            etiqueta="Empresa"
            valorTexto={EMPRESAS_TALONARIO.find((e) => e.letra === empresa)?.nombre ?? "Todas"}
            activo={Boolean(empresa)}
            valor={empresa}
            onCambio={setEmpresa}
            opciones={[
              { valor: "", texto: "Todas" },
              ...EMPRESAS_TALONARIO.map((e) => ({ valor: e.letra as string, texto: e.nombre })),
            ]}
          />
          <MenuFiltro
            etiqueta="Tipo"
            valorTexto={tipo === "directo" ? "Llega directo" : tipo === "entre_puntos" ? "Entre puntos" : "Todos"}
            activo={Boolean(tipo)}
            valor={tipo}
            onCambio={setTipo}
            opciones={[
              { valor: "" as const, texto: "Todos" },
              { valor: "entre_puntos" as const, texto: "Entre puntos" },
              { valor: "directo" as const, texto: "Llega directo" },
            ]}
          />

          {hayFiltros ? <BotonLimpiarFiltros onClick={limpiarFiltros} /> : null}
        </div>

        <div className="overflow-hidden rounded-b-lg">
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
            <table className={`${CLASE_TABLA} min-w-[820px]`}>
              <thead className={CLASE_THEAD}>
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
              <tbody className={CLASE_TBODY}>
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
                      className={CLASE_FILA_CLICABLE}
                    >
                      {/* Regla dorada a la izquierda: lo pendiente de Syscafe.
                          El texto "Pendiente" de la columna siguiente es la
                          otra pista (el color no va solo). */}
                      <td
                        className={`whitespace-nowrap border-l-4 py-2.5 pl-3 pr-3 ${
                          pendiente ? "border-brand-gold" : "border-transparent"
                        }`}
                      >
                        <span className={`cifra block text-[14px] ${anulada ? "text-muted" : "text-ink"}`}>
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
                              <span className="cifra text-[14px] text-ink">{fila.numero_syscafe}</span>
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
                                    : "border border-brand-gold/50 bg-brand-gold/10 text-gold-fg hover:bg-brand-gold/20"
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
                            {fila.tipo_traslado === "directo" ? ORIGEN_DIRECTO : (fila.punto_origen_nombre ?? "—")}
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
      </div>
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
