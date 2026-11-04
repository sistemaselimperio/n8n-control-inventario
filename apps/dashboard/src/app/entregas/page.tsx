"use client";

// Pagina principal: tablero "Cómo va hoy", cola "Por revisar" (admin/
// supervisor) y el historial completo de entregas con buscador, filtros
// segmentados (estado, flujo, fechas, sede), tabla, exports y zona de peligro
// (solo admin). Los filtros de estado y flujo viven en la URL
// (?estado=...&flujo=...): las tarjetas del tablero los fijan directamente y
// asi se pueden compartir.

import { Fragment, Suspense, useEffect, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import useSWR, { mutate as mutateGlobal } from "swr";
import { toast } from "sonner";
import {
  descargarExport,
  type FormatoExport,
  TIPOS_REMISION,
  eliminarTodasLasEntregas,
  fetchEntregas,
  fetchLogs,
  fetchSedes,
  type Entrega,
} from "@/lib/api";
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
import {
  CLASE_CAMPO,
  CLASE_FILA_CLICABLE,
  CLASE_TABLA,
  CLASE_TBODY,
  CLASE_THEAD,
  claseBoton,
  EncabezadoPagina,
  Icono,
  Pildora,
} from "@/components/ui";
import {
  API_URL_HINT,
  estadoVisual,
  fechasCalendarioAISO,
  nombreBodeguero,
  nombreSedeCorto,
  revalidarEntregas,
  sumar,
  tienePendiente,
  type FiltroEstado,
  type FiltroFlujo,
} from "@/lib/entregas";
import { useEntregasEnVivo } from "@/lib/useEntregasEnVivo";
import { FilaRevision } from "@/components/entregas/FilaRevision";
import { Folio } from "@/components/entregas/Folio";
import { IconoModificadaAdmin } from "@/components/entregas/IconoModificadaAdmin";
import { IndicadorEnVivo } from "@/components/entregas/IndicadorEnVivo";
import { ModalConfirmarLimpieza } from "@/components/entregas/ModalConfirmarLimpieza";
import { ModalDetalleEntrega } from "@/components/entregas/ModalDetalleEntrega";
import { ResumenHoy } from "@/components/entregas/ResumenHoy";

const FILTROS_ESTADO: readonly FiltroEstado[] = ["todas", "revision", "pendiente", "procesada"];
const FILTROS_FLUJO: readonly FiltroFlujo[] = ["todos", "despachos", "remisiones"];

// Un valor desconocido en la URL cuenta como "sin filtro".
function leerEstado(valor: string | null): FiltroEstado {
  return FILTROS_ESTADO.find((f) => f === valor) ?? "todas";
}
function leerFlujo(valor: string | null): FiltroFlujo {
  return FILTROS_FLUJO.find((f) => f === valor) ?? "todos";
}

const ENCABEZADOS_TABLA = [
  { texto: "Documento" },
  { texto: "Sede" },
  { texto: "Bodeguero" },
  { texto: "Productos" },
  { texto: "Entregas", derecha: true },
  { texto: "Entregado", derecha: true },
  { texto: "Pendiente", derecha: true },
  { texto: "Estado" },
  { texto: "Capturado" },
  { texto: "Foto" },
];

function EntregasContenido() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  // La URL es la fuente de verdad de estado/flujo (se pueden cambiar tambien
  // navegando desde otra pagina con la pagina ya montada).
  const filtroEstado = leerEstado(searchParams.get("estado"));
  const filtroFlujo = leerFlujo(searchParams.get("flujo"));

  // Los logs alimentan la tarjeta "Devoluciones hoy" del tablero.
  const { enVivo, refreshInterval } = useEntregasEnVivo({ escucharLogs: true });

  // Para el selector de sede (filtro) y el de sede origen de FilaRevision --
  // no cambia seguido, no hace falta refreshInterval.
  const { data: sedes } = useSWR("sedes", fetchSedes);

  // Filtro por rango de fechas (calendario, ver fechasCalendarioAISO) y por
  // sede. "" en desde/hasta equivale a "Todo" (sin filtrar).
  const [fechaDesde, setFechaDesde] = useState("");
  const [fechaHasta, setFechaHasta] = useState("");
  const [sedeFiltro, setSedeFiltro] = useState<string>("todas");
  // Atajo de fecha elegido en el menu "Fecha"; "elegir" muestra Desde/Hasta.
  const [modoFecha, setModoFecha] = useState<ModoFecha>("todas");
  const [limiteTabla, setLimiteTabla] = useState(150);
  const [busqueda, setBusqueda] = useState("");

  // Reset del limite al cambiar cualquiera de los filtros -- se hace en los
  // propios manejadores y no en un useEffect, para no disparar un setState
  // sincronico dentro de un efecto (react-hooks/set-state-in-effect).
  const cambiarFechaDesde = (valor: string) => {
    setFechaDesde(valor);
    setLimiteTabla(150);
  };
  const cambiarFechaHasta = (valor: string) => {
    setFechaHasta(valor);
    setLimiteTabla(150);
  };
  const cambiarSedeFiltro = (nuevaSede: string) => {
    setSedeFiltro(nuevaSede);
    setLimiteTabla(150);
  };

  // Estado y flujo se escriben en la URL (sin recargar ni mover el scroll);
  // el valor por defecto se omite para dejar la URL limpia.
  const cambiarFiltroUrl = (clave: "estado" | "flujo", valor: string, porDefecto: string) => {
    const params = new URLSearchParams(searchParams.toString());
    if (valor === porDefecto) params.delete(clave);
    else params.set(clave, valor);
    const query = params.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  };
  const setFiltroEstado = (valor: FiltroEstado) => cambiarFiltroUrl("estado", valor, "todas");
  const setFiltroFlujo = (valor: FiltroFlujo) => cambiarFiltroUrl("flujo", valor, "todos");

  // El buscador le pega al backend (busca en todo el historico, no solo en
  // las `limiteTabla` filas ya cargadas -- ver GET /entregas?busqueda=) --
  // se debounce 300ms para no mandar un request por cada tecla.
  const [busquedaDebounced, setBusquedaDebounced] = useState("");
  useEffect(() => {
    const id = setTimeout(() => setBusquedaDebounced(busqueda.trim()), 300);
    return () => clearTimeout(id);
  }, [busqueda]);
  const cambiarBusqueda = (valor: string) => {
    setBusqueda(valor);
    setLimiteTabla(150);
  };

  // Con los filtros por defecto la peticion es la misma que la del tablero
  // (/entregas?limit=150): se comparte la key para que SWR la dedupee.
  const tablaPorDefecto =
    !fechaDesde && !fechaHasta && sedeFiltro === "todas" && !busquedaDebounced && limiteTabla === 150;
  const {
    data: entregasTabla,
    error: entregasError,
    isLoading: entregasTablaCargando,
  } = useSWR(
    tablaPorDefecto
      ? "entregas"
      : ["entregas-tabla", fechaDesde, fechaHasta, sedeFiltro, busquedaDebounced, limiteTabla],
    tablaPorDefecto
      ? () => fetchEntregas()
      : () =>
          fetchEntregas({
            sedeId: sedeFiltro === "todas" ? undefined : sedeFiltro,
            ...fechasCalendarioAISO(fechaDesde, fechaHasta),
            busqueda: busquedaDebounced || undefined,
            limit: limiteTabla,
          }),
    { refreshInterval }
  );

  // Entregas recientes sin filtrar (key compartida con la tabla por defecto)
  // y logs: de aca salen el tablero "Cómo va hoy" y la cola "Por revisar".
  const { data: entregasResumen } = useSWR("entregas", () => fetchEntregas(), { refreshInterval });
  const { data: logs } = useSWR("logs", fetchLogs, { refreshInterval });

  const [enRevision, setEnRevision] = useState<string | null>(null);
  // Entrega mostrada en el detalle visual (ver ModalDetalleEntrega) -- para
  // las ya procesadas sin pendiente es el destino del clic en la fila, y el
  // boton "Ver fotos" lo abre en cualquier estado.
  const [entregaDetalle, setEntregaDetalle] = useState<Entrega | null>(null);

  // Rol de la sesion: la zona de peligro y el borrado son solo admin.
  // Consulta (!puedeEditar) no ve la cola ni la tarjeta "Para revisión".
  const { esAdmin, puedeEditar } = useSesion();

  const [limpiezaModalAbierta, setLimpiezaModalAbierta] = useState(false);
  // Export en curso (los exports piden sesion: se bajan por fetch, no por link).
  const [descargando, setDescargando] = useState<FormatoExport | null>(null);
  const descargar = async (formato: FormatoExport) => {
    setDescargando(formato);
    try {
      await descargarExport(formato);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "No se pudo descargar el archivo");
    } finally {
      setDescargando(null);
    }
  };
  const [limpiezaResultado, setLimpiezaResultado] = useState<{
    entregas_borradas: number;
    logs_borrados: number;
  } | null>(null);

  const error = entregasError instanceof Error ? entregasError.message : null;

  // Filtro por categoria (ver filtroEstado) -- se combina con AND junto al
  // buscador de texto libre, aplicado antes en el backend.
  const entregasPorEstado = useMemo(() => {
    if (filtroEstado === "todas") return entregasTabla;
    if (filtroEstado === "revision") return entregasTabla?.filter((e) => e.estado === "pendiente_revision");
    if (filtroEstado === "pendiente") {
      return entregasTabla?.filter((e) => tienePendiente(e) && e.estado !== "pendiente_revision");
    }
    return entregasTabla?.filter((e) => e.estado === "procesada" && !tienePendiente(e));
  }, [entregasTabla, filtroEstado]);

  // El texto libre ya se filtro en el backend (ver busquedaDebounced /
  // GET /entregas?busqueda=), asi que aca solo quedan filtroEstado (arriba) y
  // filtroFlujo.
  const entregasFiltradas = useMemo(() => {
    if (filtroFlujo === "todos") return entregasPorEstado;
    const esRemision = (tipo: string) => TIPOS_REMISION.includes(tipo.toUpperCase());
    return entregasPorEstado?.filter((e) => esRemision(e.tipo) === (filtroFlujo === "remisiones"));
  }, [entregasPorEstado, filtroFlujo]);

  // Conteo de cada pestaña de estado, sobre lo cargado y con el flujo elegido.
  const conteoEstados = useMemo(() => {
    const lista = (entregasTabla ?? []).filter(
      (e) => filtroFlujo === "todos" || TIPOS_REMISION.includes(e.tipo.toUpperCase()) === (filtroFlujo === "remisiones"),
    );
    return {
      todas: lista.length,
      revision: lista.filter((e) => e.estado === "pendiente_revision").length,
      pendiente: lista.filter((e) => tienePendiente(e) && e.estado !== "pendiente_revision").length,
      procesada: lista.filter((e) => e.estado === "procesada" && !tienePendiente(e)).length,
    } satisfies Record<FiltroEstado, number>;
  }, [entregasTabla, filtroFlujo]);

  const elegirModoFecha = (m: ModoFecha) => {
    setModoFecha(m);
    const rango = rangoDeAtajo(m, new Date());
    if (rango) {
      setFechaDesde(rango[0]);
      setFechaHasta(rango[1]);
      setLimiteTabla(150);
    }
  };

  const hayFiltros =
    filtroEstado !== "todas" ||
    filtroFlujo !== "todos" ||
    Boolean(fechaDesde || fechaHasta || busqueda) ||
    sedeFiltro !== "todas";
  const limpiarFiltros = () => {
    setModoFecha("todas");
    setFechaDesde("");
    setFechaHasta("");
    setSedeFiltro("todas");
    setBusqueda("");
    setLimiteTabla(150);
    if (filtroEstado !== "todas" || filtroFlujo !== "todos") router.replace(pathname, { scroll: false });
  };

  return (
    <main className="mx-auto flex w-full max-w-7xl flex-1 flex-col gap-5 px-4 py-6 sm:px-6 sm:py-8">
      <EncabezadoPagina
        titulo="Entregas"
        descripcion="Historial completo, ordenado por más reciente."
        acciones={
          <>
            <IndicadorEnVivo enVivo={enVivo} />
            <button
              type="button"
              onClick={() => descargar("xlsx")}
              disabled={descargando !== null}
              className={claseBoton("secundario", "disabled:cursor-wait")}
            >
              <Icono nombre="descarga" className="mr-1.5 inline h-4 w-4 align-text-bottom" />
              {descargando === "xlsx" ? "Descargando…" : "Reporte mensual (Excel)"}
            </button>
            <button
              type="button"
              onClick={() => descargar("csv")}
              disabled={descargando !== null}
              className={claseBoton("secundario", "disabled:cursor-wait")}
            >
              {descargando === "csv" ? "Descargando…" : "Descargar CSV (Excel)"}
            </button>
          </>
        }
      />

      {error ? (
        <div className="rounded-md border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger-fg">
          No se pudo conectar con el backend ({API_URL_HINT}): {error}
        </div>
      ) : null}

      {/* Tablero del dia: cada tarjeta con filtro fija estado/flujo aqui mismo. */}
      <section className="flex flex-col gap-3">
        <h2 className="text-base font-semibold text-ink">Cómo va hoy</h2>
        <ResumenHoy
          entregas={entregasResumen}
          logs={logs}
          puedeEditar={puedeEditar}
          filtroEstado={filtroEstado}
          filtroFlujo={filtroFlujo}
          onEstado={setFiltroEstado}
          onFlujo={setFiltroFlujo}
        />
      </section>


      {/* Historial: titulo con total, estado como pestañas con conteo, una
          barra compacta (buscador + filtros "Etiqueta: valor") y la tabla. */}
      <section aria-labelledby="historial-titulo" className="rounded-lg border border-line bg-surface">
        <div className="flex flex-wrap items-baseline justify-between gap-2 px-4 pt-3 sm:px-5">
          <h2 id="historial-titulo" className="text-base font-semibold text-ink">
            Historial
          </h2>
          <p className="text-sm tabular-nums text-muted" aria-live="polite">
            {entregasFiltradas?.length ?? 0} {entregasFiltradas?.length === 1 ? "entrega" : "entregas"}
            {entregasTablaCargando ? <span className="ml-2 text-subtle">actualizando…</span> : null}
          </p>
        </div>

        <div className="mt-1">
          <PestanasConteo
            etiqueta="Estado"
            valor={filtroEstado}
            onCambio={setFiltroEstado}
            sinConteo={entregasTablaCargando && !entregasTabla}
            opciones={[
              { valor: "todas" as const, texto: "Todas", conteo: conteoEstados.todas },
              { valor: "revision" as const, texto: "En revisión", tono: "warn" as const, conteo: conteoEstados.revision },
              { valor: "pendiente" as const, texto: "Sin terminar", tono: "info" as const, conteo: conteoEstados.pendiente },
              { valor: "procesada" as const, texto: "Procesadas", tono: "ok" as const, conteo: conteoEstados.procesada },
            ]}
          />
        </div>

        <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3 sm:px-5">
          <BuscadorBarra
            id="entregas-buscar"
            etiqueta="Buscar entregas"
            valor={busqueda}
            onCambio={cambiarBusqueda}
            placeholder="Buscar por tipo, número, sede, operador o producto"
            claseCampo={CLASE_CAMPO}
          />
          <MenuFiltro
            etiqueta="Flujo"
            valorTexto={filtroFlujo === "despachos" ? "Despachos" : filtroFlujo === "remisiones" ? "Remisiones" : "Todos"}
            activo={filtroFlujo !== "todos"}
            valor={filtroFlujo}
            onCambio={setFiltroFlujo}
            opciones={[
              { valor: "todos" as const, texto: "Todos" },
              { valor: "despachos" as const, texto: "Despachos" },
              { valor: "remisiones" as const, texto: "Remisiones" },
            ]}
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
                idBase="entregas"
                desde={fechaDesde}
                hasta={fechaHasta}
                onDesde={cambiarFechaDesde}
                onHasta={cambiarFechaHasta}
                claseCampo={CLASE_CAMPO}
              />
            ) : null}
          </MenuFiltro>
          <MenuFiltro
            etiqueta="Sede"
            valorTexto={(sedes ?? []).find((x) => x.id === sedeFiltro)?.nombre ?? "Todas"}
            activo={sedeFiltro !== "todas"}
            valor={sedeFiltro}
            onCambio={cambiarSedeFiltro}
            opciones={[
              { valor: "todas", texto: "Todas las sedes" },
              ...(sedes ?? []).map((x) => ({ valor: x.id, texto: x.nombre })),
            ]}
          />
          {hayFiltros ? <BotonLimpiarFiltros onClick={limpiarFiltros} /> : null}
        </div>

        <div className="overflow-x-auto rounded-b-lg">
          <table className={`${CLASE_TABLA} min-w-[820px]`}>
            <thead className={CLASE_THEAD}>
              <tr>
                {ENCABEZADOS_TABLA.map((col) => (
                  <th key={col.texto} className={`px-4 py-3 font-medium ${col.derecha ? "text-right" : ""}`}>
                    {col.texto}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className={CLASE_TBODY}>
              {!entregasTablaCargando && entregasTabla?.length === 0 ? (
                <tr>
                  <td colSpan={ENCABEZADOS_TABLA.length} className="px-4 py-6 text-center text-muted">
                    Sin entregas todavía.
                  </td>
                </tr>
              ) : null}
              {!entregasTablaCargando && busquedaDebounced && entregasFiltradas?.length === 0 ? (
                <tr>
                  <td colSpan={ENCABEZADOS_TABLA.length} className="px-4 py-6 text-center text-muted">
                    Sin resultados para &quot;{busqueda}&quot;.
                  </td>
                </tr>
              ) : null}
              {entregasFiltradas?.map((e) => {
                // Una entrega totalmente procesada (sin nada pendiente) ya no
                // se corrige a mano de rutina -- abre el detalle visual de
                // solo lectura en vez del flujo editable de FilaRevision.
                // El admin la corrige desde el boton "Editar" de ese detalle.
                const editable = e.estado === "pendiente_revision" || tienePendiente(e);
                return (
                  <Fragment key={e.id}>
                    <tr
                      className={`h-11 ${CLASE_FILA_CLICABLE}`}
                      onClick={() =>
                        editable ? setEnRevision(enRevision === e.id ? null : e.id) : setEntregaDetalle(e)
                      }
                    >
                      <td className="whitespace-nowrap px-4 py-2">
                        <Folio tipo={e.tipo} numero={e.indicativo_numero} />
                        {e.modificada_por_admin ? <IconoModificadaAdmin /> : null}
                      </td>
                      <td className="whitespace-nowrap px-4 py-2 text-soft">
                        {nombreSedeCorto(e.sede_origen_nombre) ?? e.sede_origen_id}
                      </td>
                      <td className="px-4 py-2 text-soft">{nombreBodeguero(e)}</td>
                      <td
                        className="max-w-[220px] truncate px-4 py-2 text-muted"
                        title={e.items.map((i) => i.descripcion).join(", ")}
                      >
                        {e.items.length === 0
                          ? "—"
                          : `${e.items.length} producto${e.items.length === 1 ? "" : "s"}`}
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums text-soft">
                        {sumar(e.items, "cantidad_entregada") + sumar(e.items, "cantidad_pendiente")}
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums text-soft">{sumar(e.items, "cantidad_entregada")}</td>
                      <td className="px-4 py-2 text-right tabular-nums text-soft">{sumar(e.items, "cantidad_pendiente")}</td>
                      <td className="px-4 py-2">
                        <Pildora tono={estadoVisual(e).tono} className="whitespace-nowrap">
                          {estadoVisual(e).etiqueta}
                        </Pildora>
                      </td>
                      <td className="px-4 py-2 text-muted">
                        {e.capturado_at ? new Date(e.capturado_at).toLocaleString() : "—"}
                      </td>
                      <td className="whitespace-nowrap px-4 py-2">
                        {/* Un solo boton, no un link de texto por foto -- abre
                            el mismo modal de detalle (ya arma la galeria de
                            evidencia/traslado/firma), disponible aunque la
                            fila este en estado editable (donde el click en la
                            fila abre FilaRevision en vez del modal). */}
                        <button
                          onClick={(ev) => {
                            ev.stopPropagation();
                            setEntregaDetalle(e);
                          }}
                          className="min-h-9 rounded-md border border-info/40 px-2 py-1 text-xs font-medium text-info transition hover:bg-info/10"
                        >
                          Ver fotos
                        </button>
                      </td>
                    </tr>
                    {enRevision === e.id ? (
                      <FilaRevision
                        key={`${e.id}-revision`}
                        entrega={e}
                        sedes={sedes}
                        columnas={ENCABEZADOS_TABLA.length}
                        onGuardado={() => {
                          setEnRevision(null);
                          revalidarEntregas();
                        }}
                      />
                    ) : null}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
        {entregasTabla?.length === limiteTabla ? (
          <div className="flex justify-center border-t border-line p-3">
          <button
            onClick={() => setLimiteTabla((l) => l + 150)}
            className={claseBoton("secundario")}
          >
            Cargar más
          </button>
          </div>
        ) : null}
      </section>

      {esAdmin ? (
        <section className="flex flex-col gap-3 rounded-lg border border-danger/30 bg-danger/5 p-4 sm:p-5">
          <div>
            <h2 className="text-sm font-semibold text-danger-fg">Zona de peligro</h2>
            <p className="text-xs text-muted">
              Borra permanentemente todas las entregas, productos y logs del sistema. Pensado para
              resetear datos de prueba -- no toca las fotos ya subidas a Storage.
            </p>
          </div>
          <div>
            <button
              onClick={() => setLimpiezaModalAbierta(true)}
              className="rounded-md border border-danger/40 px-3 py-1.5 text-xs font-medium text-danger-fg transition hover:bg-danger/10 disabled:opacity-50"
            >
              Eliminar todos los productos
            </button>
          </div>
          {limpiezaResultado ? (
            <p className="text-xs text-muted">
              Última limpieza: {limpiezaResultado.entregas_borradas} entregas y{" "}
              {limpiezaResultado.logs_borrados} logs borrados.
            </p>
          ) : null}
        </section>
      ) : null}

      {entregaDetalle ? (
        <ModalDetalleEntrega
          entrega={entregaDetalle}
          onCerrar={() => setEntregaDetalle(null)}
          onEliminado={() => {
            setEntregaDetalle(null);
            revalidarEntregas();
          }}
          onEditado={() => {
            setEntregaDetalle(null);
            revalidarEntregas();
          }}
        />
      ) : null}

      {limpiezaModalAbierta ? (
        <ModalConfirmarLimpieza
          onCerrar={() => setLimpiezaModalAbierta(false)}
          onConfirmar={async () => {
            const resultado = await eliminarTodasLasEntregas();
            setLimpiezaResultado(resultado);
            setLimpiezaModalAbierta(false);
            toast.success(
              `Se eliminaron ${resultado.entregas_borradas} entregas y ${resultado.logs_borrados} logs`
            );
            revalidarEntregas();
            // El tablero cachea los logs (devoluciones): se revalidan.
            mutateGlobal("logs");
          }}
        />
      ) : null}
    </main>
  );
}

// useSearchParams exige un limite Suspense en paginas cliente prerenderizadas.
export default function EntregasPage() {
  return (
    <Suspense fallback={null}>
      <EntregasContenido />
    </Suspense>
  );
}
