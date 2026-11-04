"use client";

import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { eliminarEntrega, fetchHistorialEntrega, type Entrega, type LogEvent } from "@/lib/api";
import { useSesion } from "@/lib/SesionProvider";
import { claseBoton, Icono, Pildora } from "@/components/ui";
import {
  describirCambioAdmin,
  describirEvento,
  esCorreccionAdmin,
  estadoVisual,
  formatearFechaHora,
  nombreActorAdmin,
  nombreBodeguero,
  type CambioAdmin,
} from "@/lib/entregas";
import { Folio } from "./Folio";
import { IconoModificadaAdmin } from "./IconoModificadaAdmin";
import { ModalConfirmar } from "./ModalConfirmar";
import { ModalEditarEntrega } from "./ModalEditarEntrega";
import { VisorFotos } from "./VisorFotos";

// Detalle visual para comparar las fotos de una entrega con los datos
// extraidos: visor grande a la izquierda (arriba en movil) y, a la derecha
// (abajo en movil), tarjetas en orden de lectura: avance, datos, productos,
// nota, recorrido, cambios del admin e historial. Admin puede editar o
// eliminar desde el encabezado.
export function ModalDetalleEntrega({
  entrega,
  onCerrar,
  onEliminado,
  onEditado,
}: {
  entrega: Entrega;
  onCerrar: () => void;
  onEliminado: () => void;
  onEditado: () => void;
}) {
  // Solo admin puede borrar o editar una entrega ya completada (ver
  // eliminar_entrega_definitivo en el backend, que tambien lo exige).
  const { esAdmin } = useSesion();
  const [editando, setEditando] = useState(false);
  const [confirmandoBorrado, setConfirmandoBorrado] = useState(false);
  const [eliminando, setEliminando] = useState(false);
  const eliminar = async () => {
    setConfirmandoBorrado(false);
    setEliminando(true);
    try {
      await eliminarEntrega(entrega.id);
      toast.success("Entrega eliminada");
      onEliminado();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Error al eliminar");
    } finally {
      setEliminando(false);
    }
  };
  // historial === null es el estado "cargando" -- evita un setState
  // sincronico al entrar al efecto (regla react-hooks/set-state-in-effect).
  const [historial, setHistorial] = useState<LogEvent[] | null>(null);
  const [historialAbierto, setHistorialAbierto] = useState(false);
  const cargandoHistorial = historial === null;

  useEffect(() => {
    let cancelado = false;
    fetchHistorialEntrega(entrega.id)
      .then((data) => {
        if (!cancelado) setHistorial(data);
      })
      .catch(() => {
        if (!cancelado) setHistorial([]);
      });
    return () => {
      cancelado = true;
    };
  }, [entrega.id]);

  // Cerrar con Escape ademas del click en el fondo/la X.
  // Mientras se edita o se confirma un borrado, Escape cierra solo ese
  // dialogo interno, no el detalle.
  useEffect(() => {
    const alPresionarTecla = (ev: KeyboardEvent) => {
      if (ev.key !== "Escape") return;
      if (editando) setEditando(false);
      else if (confirmandoBorrado) setConfirmandoBorrado(false);
      else onCerrar();
    };
    document.addEventListener("keydown", alPresionarTecla);
    return () => document.removeEventListener("keydown", alPresionarTecla);
  }, [onCerrar, editando, confirmandoBorrado]);

  // Accesibilidad del dialogo: el foco entra al abrirlo y vuelve al boton que
  // lo abrio ("Ver fotos") al cerrarlo.
  const idTitulo = useId();
  const dialogoRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const disparador = document.activeElement as HTMLElement | null;
    dialogoRef.current?.focus();
    return () => {
      if (disparador && disparador.isConnected) disparador.focus();
    };
  }, []);

  // describirEvento espera un mapa de entregas por id -- aca alcanza con la
  // propia entrega del modal, ya que el historial es siempre de ella.
  const entregasPorId = useMemo(() => new Map([[entrega.id, entrega]]), [entrega]);
  const eventosHistorial = (historial ?? [])
    .map((log) => ({ log, texto: describirEvento(log, entregasPorId) }))
    .filter((x): x is { log: LogEvent; texto: string } => x.texto !== null);

  // Bodegueros DISTINTOS que confirmaron cantidades -- entregas.bodeguero_id
  // solo guarda el ULTIMO (se pisa en cada visita, ver aplicar_actualizacion_items
  // en el backend), asi que si mas de una persona atendio visitas distintas
  // de este mismo documento, la columna sola no lo muestra. Se arma desde el
  // historial en su lugar (cada entrega_actualizada ya trae actor_id/
  // actor_nombre). null mientras el historial todavia esta cargando -- ahi
  // se usa como fallback el ultimo bodeguero de la fila (entrega.bodeguero_nombre).
  // Se excluye punto_venta: tambien genera entrega_actualizada (sin items) al
  // marcar FAIA, pero nunca confirma cantidades, asi que no es bodeguero.
  // Cada visita de bodega que confirmo cantidades, en orden -- base tanto de
  // la lista de bodegueros como de la seccion "Fechas" (una fila por entrega,
  // asi se ve cuando el documento se entrego en varias visitas).
  // Las visitas marcadas desde_punto_venta se excluyen: las registro un
  // bodeguero pero no las entrego bodega (se listan aparte, abajo).
  const entregadoDesdePuntoVenta = (log: LogEvent) =>
    (log.detalle as { desde_punto_venta?: boolean } | undefined)?.desde_punto_venta === true;
  const entregadoDesdeOtraBodega = (log: LogEvent) =>
    (log.detalle as { desde_otra_bodega?: boolean } | undefined)?.desde_otra_bodega === true;
  const visitasBodega =
    historial === null
      ? null
      : historial
          .filter(
            (log) =>
              log.evento === "entrega_actualizada" &&
              log.actor_rol !== "punto_venta" &&
              !entregadoDesdePuntoVenta(log) &&
              !entregadoDesdeOtraBodega(log) &&
              !esCorreccionAdmin(log)
          )
          .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  // Correcciones manuales desde el dashboard -- seccion "Cambios del admin".
  const correccionesAdmin =
    historial === null
      ? []
      : historial
          .filter(esCorreccionAdmin)
          .map((log) => ({ log, cambios: (log.detalle as { cambios?: CambioAdmin[] } | undefined)?.cambios }))
          // Guardados que no cambiaron nada (ej. "Guardar" sin tocar campos)
          // no son un cambio que mostrar.
          .filter(({ cambios }) => cambios === undefined || cambios.length > 0)
          .sort((a, b) => new Date(a.log.timestamp).getTime() - new Date(b.log.timestamp).getTime());
  const visitasPuntoVenta =
    historial === null
      ? []
      : historial
          .filter((log) => log.evento === "entrega_actualizada" && entregadoDesdePuntoVenta(log))
          .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  const visitasOtraBodega =
    historial === null
      ? []
      : historial
          .filter((log) => log.evento === "entrega_actualizada" && entregadoDesdeOtraBodega(log))
          .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  const bodeguerosHistorial =
    visitasBodega === null
      ? null
      : Array.from(
          new Map(visitasBodega.map((log) => [log.actor_id, log.actor_nombre ?? log.actor_id] as const)).values()
        );

  // Fotos del documento -- solo las que la entrega realmente trae (traslado
  // es opcional). La firma va aparte, en su tarjeta con fondo blanco: sobre
  // el fondo del visor no contrasta. Si evidencia_creacion_url existe y es DISTINTA de
  // evidencia_url, alguien (tipicamente bodega) volvio a fotografiar al
  // confirmar -- se muestran las dos por separado, etiquetando la original
  // segun quien la tomo (operador_rol). Si son iguales (nadie la reemplazo,
  // ej. flujo de un solo operador) no se duplica.
  const huboRefoto =
    entrega.evidencia_creacion_url != null && entrega.evidencia_creacion_url !== entrega.evidencia_url;
  const fotos = [
    huboRefoto
      ? {
          url: entrega.evidencia_creacion_url as string,
          etiqueta: entrega.operador_rol === "punto_venta" ? "Punto de venta" : "Foto inicial",
        }
      : null,
    { url: entrega.evidencia_url, etiqueta: huboRefoto ? "Bodega" : "Foto" },
    entrega.traslado_url ? { url: entrega.traslado_url, etiqueta: "Traslado" } : null,
  ].filter((f): f is { url: string; etiqueta: string } => f !== null);

  const estado = estadoVisual(entrega);
  // Avance del documento: unidades entregadas sobre el total (entregadas +
  // pendientes + cerradas sin entregar).
  const totalEntregado = entrega.items.reduce((s, it) => s + it.cantidad_entregada, 0);
  const totalPendiente = entrega.items.reduce((s, it) => s + it.cantidad_pendiente, 0);
  const totalNoEntregado = entrega.items.reduce((s, it) => s + (it.cantidad_no_entregada ?? 0), 0);
  const totalUnidades = totalEntregado + totalPendiente + totalNoEntregado;
  const porcentaje = totalUnidades > 0 ? Math.round((totalEntregado / totalUnidades) * 100) : 0;

  const bodegueros =
    bodeguerosHistorial && bodeguerosHistorial.length > 0 ? bodeguerosHistorial.join(", ") : nombreBodeguero(entrega);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-brand-night/70 sm:p-4"
      onClick={onCerrar}
    >
      <div
        ref={dialogoRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={idTitulo}
        tabIndex={-1}
        className="flex h-full w-full flex-col overflow-hidden bg-surface outline-none sm:h-auto sm:max-h-[88vh] sm:max-w-[880px] sm:rounded-lg sm:border sm:border-line"
        onClick={(ev) => ev.stopPropagation()}
      >
        {/* Encabezado: folio y estado a la izquierda, acciones a la derecha. */}
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-2">
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
            <h2 id={idTitulo} className="min-w-0 truncate">
              <Folio tipo={entrega.tipo} numero={entrega.indicativo_numero} tamano="modal" />
            </h2>
            <Pildora tono={estado.tono}>{estado.etiqueta}</Pildora>
            {entrega.modificada_por_admin ? (
              <span className="flex items-center gap-1 text-xs text-warn">
                <IconoModificadaAdmin /> Modificada por el admin
              </span>
            ) : null}
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            {esAdmin ? (
              <button onClick={() => setEditando(true)} disabled={eliminando} className={claseBoton("secundario")}>
                <Icono nombre="lapiz" className="h-4 w-4" />
                Editar
              </button>
            ) : null}
            {esAdmin ? (
              <button
                onClick={() => setConfirmandoBorrado(true)}
                disabled={eliminando}
                className={claseBoton("fantasma", "text-danger-fg hover:bg-danger/10 hover:text-danger-fg")}
              >
                <Icono nombre="basura" className="h-4 w-4" />
                {eliminando ? "Eliminando…" : "Eliminar"}
              </button>
            ) : null}
            <button
              onClick={onCerrar}
              className="flex h-11 w-11 items-center justify-center rounded-md text-muted transition-colors duration-150 hover:bg-surface-2 hover:text-ink"
              aria-label="Cerrar"
            >
              <Icono nombre="cerrar" className="h-5 w-5" />
            </button>
          </div>
        </header>
        {editando ? (
          <ModalEditarEntrega entrega={entrega} onCerrar={() => setEditando(false)} onGuardado={onEditado} />
        ) : null}
        {confirmandoBorrado ? (
          <ModalConfirmar
            titulo="Eliminar entrega"
            mensaje={`¿Eliminar por completo ${entrega.tipo} ${entrega.indicativo_numero}? Ya está entregada: desaparece del historial y del reporte mensual. Esta acción no se puede deshacer.`}
            textoConfirmar="Eliminar entrega"
            onConfirmar={eliminar}
            onCerrar={() => setConfirmandoBorrado(false)}
          />
        ) : null}

        {/* Cuerpo: visor de fotos como area principal (arriba en movil,
            izquierda en escritorio) y panel de datos para compararlas. */}
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto lg:flex-row lg:overflow-hidden">
          <div className="flex shrink-0 flex-col gap-2 p-3 lg:w-[400px] lg:shrink-0 lg:overflow-y-auto">
            <VisorFotos fotos={fotos} teclado={!editando && !confirmandoBorrado} />
            {entrega.firma_url ? <FirmaCliente url={entrega.firma_url} /> : null}
          </div>

          <aside className="flex flex-col border-t border-line bg-page p-3 lg:min-w-0 lg:flex-1 lg:overflow-y-auto lg:border-l lg:border-t-0">
            {/* Un solo panel con bloques separados por linea: denso, sin
                tarjetas sueltas. Orden de lectura: avance, datos, productos,
                nota, recorrido, cambios del admin e historial. */}
            <div className="flex flex-col divide-y divide-line rounded-lg border border-line bg-surface">
              <Seccion
                titulo="Avance"
                extra={
                  totalUnidades > 0 && totalPendiente === 0 && totalNoEntregado === 0 ? (
                    <Pildora tono="ok">Todo entregado</Pildora>
                  ) : (
                    <span className="flex flex-wrap justify-end gap-1">
                      {totalPendiente > 0 ? (
                        <Pildora tono="warn">
                          {totalPendiente} {totalPendiente === 1 ? "pendiente" : "pendientes"}
                        </Pildora>
                      ) : null}
                      {totalNoEntregado > 0 ? <Pildora tono="neutro">{totalNoEntregado} sin entregar</Pildora> : null}
                    </span>
                  )
                }
              >
                <div className="flex items-center gap-3">
                  <span className="flex shrink-0 items-baseline gap-1">
                    <span className="cifra text-base font-semibold text-ink">
                      {totalEntregado} de {totalUnidades}
                    </span>
                    <span className="text-xs text-muted">entregadas</span>
                  </span>
                  <div
                    role="progressbar"
                    aria-label="Unidades entregadas"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={porcentaje}
                    className="h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-surface-2"
                  >
                    <div className="h-full rounded-full bg-ok" style={{ width: `${porcentaje}%` }} />
                  </div>
                  <span className="cifra shrink-0 text-sm font-semibold text-ok-fg">{porcentaje}%</span>
                </div>
              </Seccion>

              <Seccion titulo="Datos">
                <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm sm:grid-cols-3">
                  <Dato etiqueta="Sede">{entrega.sede_origen_nombre ?? entrega.sede_origen_id}</Dato>
                  <Dato etiqueta="Operador">{entrega.operador_nombre ?? entrega.operador_id}</Dato>
                  <Dato etiqueta={bodeguerosHistorial && bodeguerosHistorial.length > 1 ? "Bodegueros" : "Bodeguero"}>
                    {bodegueros}
                  </Dato>
                </dl>
              </Seccion>

              {/* Productos extraidos: lo que hay que comparar contra la foto. */}
              <Seccion titulo="Productos" contador={entrega.items.length}>
                {entrega.items.length === 0 ? (
                  <p className="text-sm text-muted">Sin productos registrados.</p>
                ) : (
                  <ul className="flex flex-col divide-y divide-line">
                    {entrega.items.map((item) => (
                      <li key={item.id} className="flex items-baseline justify-between gap-3 py-1.5 first:pt-0 last:pb-0">
                        <span className="min-w-0 text-sm text-ink">{item.descripcion}</span>
                        <span className="flex shrink-0 items-baseline gap-2 text-xs">
                          {item.cantidad_pendiente > 0 ? (
                            <span className="font-medium text-warn">Pendiente {item.cantidad_pendiente}</span>
                          ) : null}
                          {(item.cantidad_no_entregada ?? 0) > 0 ? (
                            <span className="text-muted">No entregado {item.cantidad_no_entregada}</span>
                          ) : null}
                          <span className="flex items-baseline gap-1">
                            <span className="cifra text-sm font-semibold text-ok-fg">{item.cantidad_entregada}</span>
                            <span className="text-muted">entregadas</span>
                          </span>
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </Seccion>

              {/* Nota a nivel documento completo (distinta de la nota por producto). */}
              {entrega.nota_general?.trim() ? (
                <Seccion titulo="Nota general">
                  <p className="whitespace-pre-wrap text-sm text-ink">{entrega.nota_general}</p>
                </Seccion>
              ) : null}

              {/* Recorrido: cuando se subio el documento y cada entrega por
                  separado -- si se entrego en varias visitas, una fila por visita. */}
              <Seccion titulo="Recorrido">
                <ol className="flex flex-col">
                  <PasoRecorrido
                    titulo={entrega.operador_rol === "punto_venta" ? "Subido por punto de venta" : "Capturado"}
                    quien={entrega.operador_nombre ?? entrega.operador_id}
                    cuando={formatearFechaHora(entrega.capturado_at)}
                    tono="info"
                    ultimo={
                      visitasBodega !== null &&
                      visitasBodega.length === 0 &&
                      visitasPuntoVenta.length === 0 &&
                      visitasOtraBodega.length === 0
                    }
                  />
                  {visitasBodega === null ? (
                    <li className="pl-5 text-xs text-muted">Cargando entregas…</li>
                  ) : (
                    <>
                      {visitasBodega.map((log, i) => (
                        <PasoRecorrido
                          key={log.id}
                          titulo={
                            visitasBodega.length > 1 ? `Entrega ${i + 1} de ${visitasBodega.length}` : "Entregado en bodega"
                          }
                          quien={log.actor_nombre ?? log.actor_id ?? "—"}
                          cuando={formatearFechaHora(log.timestamp)}
                          tono="ok"
                          ultimo={
                            i === visitasBodega.length - 1 && visitasPuntoVenta.length === 0 && visitasOtraBodega.length === 0
                          }
                        />
                      ))}
                      {visitasPuntoVenta.map((log, i) => (
                        <PasoRecorrido
                          key={log.id}
                          titulo="Punto de venta"
                          quien={`Registró ${log.actor_nombre ?? log.actor_id ?? "—"}`}
                          cuando={formatearFechaHora(log.timestamp)}
                          tono="ok"
                          ultimo={i === visitasPuntoVenta.length - 1 && visitasOtraBodega.length === 0}
                        />
                      ))}
                      {visitasOtraBodega.map((log, i) => (
                        <PasoRecorrido
                          key={log.id}
                          titulo="Otra bodega"
                          quien={`Registró ${log.actor_nombre ?? log.actor_id ?? "—"}`}
                          cuando={formatearFechaHora(log.timestamp)}
                          tono="ok"
                          ultimo={i === visitasOtraBodega.length - 1}
                        />
                      ))}
                      {visitasBodega.length === 0 && visitasPuntoVenta.length === 0 && visitasOtraBodega.length === 0 ? (
                        <li className="pl-5 text-xs text-muted">Todavía no se entregó en bodega.</li>
                      ) : null}
                    </>
                  )}
                </ol>
              </Seccion>

              {/* Correcciones manuales desde el dashboard: quien corrigio,
                  cuando y que valor cambio. Los logs de antes de este registro
                  no traen el detalle del cambio. */}
              {correccionesAdmin.length > 0 ? (
                <Seccion titulo="Cambios del admin">
                  <ol className="flex flex-col divide-y divide-line text-sm">
                    {correccionesAdmin.map(({ log, cambios }) => (
                      <li key={log.id} className="flex flex-col gap-0.5 py-1.5 first:pt-0 last:pb-0">
                        <div className="flex items-baseline justify-between gap-3">
                          <span className="font-medium text-ink">{nombreActorAdmin(log)}</span>
                          <span className="shrink-0 text-xs text-warn">{formatearFechaHora(log.timestamp)}</span>
                        </div>
                        {cambios ? (
                          <ul className="flex flex-col text-xs text-muted">
                            {cambios.map((cambio, i) => (
                              <li key={i}>{describirCambioAdmin(cambio)}</li>
                            ))}
                          </ul>
                        ) : (
                          <span className="text-xs text-subtle">Corrección sin detalle (registrada antes de guardar los cambios).</span>
                        )}
                      </li>
                    ))}
                  </ol>
                </Seccion>
              ) : null}

              {/* Historial colapsado por defecto -- no obliga a leerlo si solo
                  se vino a ver las fotos. */}
              <Seccion
                titulo="Historial"
                contador={historial ? eventosHistorial.length : undefined}
                extra={
                  <button
                    onClick={() => setHistorialAbierto((v) => !v)}
                    aria-expanded={historialAbierto}
                    className="-my-2.5 -mr-2 flex min-h-11 items-center gap-1 rounded-md px-2 text-xs font-medium text-muted hover:bg-surface-2 hover:text-ink"
                  >
                    {historialAbierto ? "Ocultar" : "Ver"}
                    <Icono nombre={historialAbierto ? "arriba" : "abajo"} className="h-4 w-4" />
                  </button>
                }
              >
                {historialAbierto ? (
                  cargandoHistorial ? (
                    <span className="text-sm text-muted">Cargando…</span>
                  ) : eventosHistorial.length === 0 ? (
                    <span className="text-sm text-muted">Sin cambios registrados todavía.</span>
                  ) : (
                    <ol className="flex flex-col">
                      {eventosHistorial.map(({ log, texto }, i) => (
                        <PasoRecorrido
                          key={log.id}
                          titulo={texto}
                          cuando={formatearFechaHora(log.timestamp)}
                          tono="neutro"
                          ultimo={i === eventosHistorial.length - 1}
                        />
                      ))}
                    </ol>
                  )
                ) : null}
              </Seccion>
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}

// Bloque del panel lateral: titulo pequeño (con contador opcional) y algo a
// la derecha (estado, boton). Los bloques se separan por linea en el panel.
function Seccion({
  titulo,
  contador,
  extra,
  children,
}: {
  titulo: string;
  contador?: number;
  extra?: ReactNode;
  children?: ReactNode;
}) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="flex flex-col gap-1.5 px-3 py-2.5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-baseline gap-1.5">
          <h3 id={id} className="text-xs font-semibold text-muted">
            {titulo}
          </h3>
          {contador !== undefined ? <span className="text-xs text-subtle">{contador}</span> : null}
        </div>
        {extra}
      </div>
      {children}
    </section>
  );
}

function Dato({ etiqueta, children }: { etiqueta: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="text-xs text-muted">{etiqueta}</dt>
      <dd className="break-words text-ink">{children}</dd>
    </div>
  );
}

const PUNTO_TONO = { info: "bg-info", ok: "bg-ok", neutro: "bg-line-strong" } as const;

// Paso de una linea de tiempo vertical: punto de color, linea hacia el
// siguiente paso, titulo, quien (opcional) y cuando.
function PasoRecorrido({
  titulo,
  quien,
  cuando,
  tono,
  ultimo,
}: {
  titulo: string;
  quien?: string;
  cuando: string;
  tono: keyof typeof PUNTO_TONO;
  ultimo: boolean;
}) {
  return (
    <li className="flex gap-2.5">
      <div className="flex w-2 flex-col items-center pt-1.5">
        <span className={`h-2 w-2 shrink-0 rounded-full ${PUNTO_TONO[tono]}`} />
        {ultimo ? null : <span className="mt-0.5 w-px flex-1 bg-line-strong" />}
      </div>
      <div className={`flex min-w-0 flex-1 items-baseline justify-between gap-3 ${ultimo ? "" : "pb-1.5"}`}>
        <span className="min-w-0 text-sm text-ink">
          {titulo}
          {quien ? <span className="text-xs text-muted"> · {quien}</span> : null}
        </span>
        <span className="shrink-0 whitespace-nowrap text-xs text-soft">{cuando}</span>
      </div>
    </li>
  );
}

// Firma del cliente al confirmar: siempre sobre blanco (tinta oscura; las
// firmas antiguas pueden venir con fondo transparente) y con borde, para que
// se lea igual sin importar el fondo del panel.
function FirmaCliente({ url }: { url: string }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="flex shrink-0 items-center gap-3 rounded-lg border border-line bg-surface px-3 py-2">
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <h3 id={id} className="text-sm font-semibold text-ink">
          Firma del cliente
        </h3>
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          className="inline-flex min-h-9 items-center gap-1 self-start text-xs font-medium text-info hover:underline"
        >
          Abrir original
          <Icono nombre="externo" />
        </a>
      </div>
      {/* eslint-disable-next-line @next/next/no-img-element -- URL publica de Storage */}
      <img
        src={url}
        alt="Firma del cliente"
        loading="lazy"
        className="h-14 w-36 max-w-[55%] rounded-md border border-line-strong bg-white object-contain p-1"
      />
    </section>
  );
}
