"use client";

// Detalle de un punto (/puntos/[id]): encabezado con nombre y codigo, cuatro
// indicadores del mes, traslados del punto (enviados y recibidos), talonario
// activo y -solo para admin- usuarios del punto. Solo usa endpoints existentes:
//  - enviados (y hojas anuladas): GET /traslados-puntos/syscafe?punto_id= (origen
//    del traslado, o destino si es llegada directa);
//  - recibidos: GET /traslados-puntos?destino_id= (el backend si filtra por
//    destino, pero devuelve solo los 100 mas recientes) y se normalizan a la misma
//    fila; los dos listados se unen y se deduplican en el cliente (lib/puntos.ts);
//  - talonario: GET /puntos/{id}/talonario (no depende del resumen global);
//  - usuarios: GET /puntos/{id}/usuarios?incluir_inactivos=true (exige admin).

import { useCallback, useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import useSWR from "swr";
import {
  fetchPuntosPublicos,
  fetchTalonarioPunto,
  fetchUsuariosPuntoAdmin,
  listarTrasladosRecibidos,
  listarTrasladosSyscafe,
  type FilaTrasladoSyscafe,
  type TalonarioActivo,
} from "@/lib/api";
import {
  EncabezadoPagina,
  ErrorConReintento,
  EstadoVacio,
  Icono,
  Indicador,
  Panel,
  Pildora,
  Segmentado,
  SkeletonLinea,
} from "@/components/ui";
import { EMPRESAS_TALONARIO } from "@/components/traslados/compartido";
import { ModalAnulada } from "@/components/traslados/ModalAnulada";
import { ModalDetalleTraslado } from "@/components/traslados/ModalDetalleTraslado";
import { TablaTrasladosPunto } from "@/components/puntos/TablaTrasladosPunto";
import { useSesion } from "@/lib/SesionProvider";
import { areaEfectiva } from "@/lib/sesion";
import { combinarTrasladosDePunto, kpisDePunto } from "@/lib/puntos";

type FiltroMovimiento = "todos" | "enviado" | "recibido";

const OPCIONES_MOVIMIENTO = [
  { valor: "todos", etiqueta: "Todos" },
  { valor: "enviado", etiqueta: "Enviados" },
  { valor: "recibido", etiqueta: "Recibidos" },
] as const;

function FilaTalonario({ talonario }: { talonario: TalonarioActivo }) {
  const empresa = EMPRESAS_TALONARIO.find((e) => e.letra === talonario.letra)?.nombre;
  const tono = talonario.agotado ? "error" : talonario.quedan <= talonario.umbral_aviso ? "warn" : "ok";
  return (
    <li className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 py-3 sm:px-5">
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="text-sm font-medium text-ink">
          Talonario {talonario.letra}
          {empresa ? <span className="font-normal text-muted"> · {empresa}</span> : null}
        </span>
        <span className="text-xs text-muted">
          Rango <span className="cifra text-ink">{talonario.rango}</span>
          {talonario.siguiente_hoja ? (
            <>
              {" · "}Siguiente hoja <span className="cifra text-ink">{talonario.siguiente_hoja}</span>
            </>
          ) : null}
        </span>
      </div>
      <Pildora tono={tono}>{talonario.agotado ? "Agotado" : `Quedan ${talonario.quedan}`}</Pildora>
    </li>
  );
}

export default function PuntoPage() {
  const { id } = useParams<{ id: string }>();
  const { usuario, puedeEditar, esAdmin } = useSesion();
  // Supervisores de area "bodega" no pueden escribir Syscafe (el backend responde 403).
  const puedeAsignar = puedeEditar && ["todo", "traslados"].includes(areaEfectiva(usuario));

  const [filtro, setFiltro] = useState<FiltroMovimiento>("todos");
  const [detalleId, setDetalleId] = useState<string | null>(null);
  const [anuladaDetalle, setAnuladaDetalle] = useState<FilaTrasladoSyscafe | null>(null);

  const { data: puntos, error: errorPuntos, isLoading: cargandoPuntos } = useSWR("puntos-publicos", fetchPuntosPublicos);
  const punto = puntos?.find((p) => p.id === id);

  const {
    data: enviados,
    error: errorEnviados,
    mutate: recargarEnviados,
  } = useSWR(["punto-enviados", id], () => listarTrasladosSyscafe({ puntoId: id }), { refreshInterval: 10000 });
  const {
    data: recibidos,
    error: errorRecibidos,
    mutate: recargarRecibidos,
  } = useSWR(["punto-recibidos", id], () => listarTrasladosRecibidos(id), { refreshInterval: 10000 });
  const { data: talonarios, error: errorTalonario, isLoading: cargandoTalonario } = useSWR(["punto-talonario", id], () =>
    fetchTalonarioPunto(id),
  );
  // Solo admin: la clave null evita la consulta para el resto de roles.
  const {
    data: usuarios,
    error: errorUsuarios,
    isLoading: cargandoUsuarios,
  } = useSWR(esAdmin ? ["punto-usuarios", id] : null, () => fetchUsuariosPuntoAdmin(id));

  const cargandoTraslados = !enviados && !recibidos && !errorEnviados && !errorRecibidos;
  const errorTraslados = errorEnviados && errorRecibidos ? errorEnviados : null;
  const traslados = useMemo(
    () => combinarTrasladosDePunto(enviados ?? [], recibidos ?? [], id),
    [enviados, recibidos, id],
  );
  const kpis = useMemo(() => kpisDePunto(traslados, id), [traslados, id]);
  const visibles = useMemo(
    () => (filtro === "todos" ? traslados : traslados.filter((t) => t.direccion === filtro)),
    [traslados, filtro],
  );

  const recargar = useCallback(() => {
    void recargarEnviados();
    void recargarRecibidos();
  }, [recargarEnviados, recargarRecibidos]);

  const abrirFila = (fila: FilaTrasladoSyscafe) => {
    if (fila.tipo === "anulada") setAnuladaDetalle(fila);
    else setDetalleId(fila.id);
  };

  const sinPermisoUsuarios =
    errorUsuarios && [401, 403].includes((errorUsuarios as { status?: number }).status ?? 0);

  const enlaceVolver = (
    <Link
      href="/puntos"
      className="inline-flex min-h-11 w-fit items-center gap-1.5 rounded-md text-sm font-medium text-info hover:underline"
    >
      <Icono nombre="izquierda" className="h-3.5 w-3.5" />
      Todos los puntos
    </Link>
  );

  const contenido = (
    <main className="mx-auto flex w-full max-w-7xl flex-1 flex-col gap-5 px-4 py-6 sm:px-6 sm:py-8">
      {enlaceVolver}

      {!punto && !cargandoPuntos ? (
        <Panel titulo="Punto no disponible">
          {errorPuntos ? (
            <EstadoVacio titulo="No se pudo cargar el punto." ayuda="Revisa tu conexión e inténtalo de nuevo." />
          ) : (
            <EstadoVacio titulo="No encontramos este punto." ayuda="Puede estar desactivado o el enlace ser incorrecto." />
          )}
        </Panel>
      ) : (
        <>
          <EncabezadoPagina
            titulo={punto?.nombre ?? "Cargando punto…"}
            descripcion={
              punto ? (
                <>
                  Código <span className="cifra text-ink">{punto.codigo ?? "—"}</span> · traslados enviados y recibidos, talonario y
                  usuarios.
                </>
              ) : undefined
            }
          />

          <section aria-label="Indicadores del punto" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Indicador
              etiqueta="Traslados del mes"
              valor={String(kpis.delMes)}
              detalle="Enviados y recibidos"
              cargando={cargandoTraslados}
            />
            <Indicador
              etiqueta="Pendientes de recibir"
              valor={String(kpis.pendientesRecibir)}
              detalle="En tránsito hacia este punto"
              cargando={cargandoTraslados}
            />
            <Indicador
              etiqueta="Con novedad"
              valor={String(kpis.conNovedad)}
              detalle="Recibidos con diferencias"
              cargando={cargandoTraslados}
            />
            <Indicador
              etiqueta="Sin número Syscafe"
              valor={String(kpis.sinSyscafe)}
              detalle="Hojas del punto por registrar"
              cargando={cargandoTraslados}
            />
          </section>

          <Panel
            titulo="Traslados del punto"
            subtitulo="Los más recientes primero. Haz clic en una fila para ver el detalle."
            conteo={!cargandoTraslados ? String(visibles.length) : undefined}
            conRelleno={false}
            acciones={
              <Segmentado
                etiqueta="Movimiento"
                opciones={OPCIONES_MOVIMIENTO}
                valor={filtro}
                onCambiar={setFiltro}
              />
            }
          >
            {errorTraslados ? (
              <div className="p-4">
                <ErrorConReintento mensaje="No se pudieron cargar los traslados del punto." onReintentar={recargar} />
              </div>
            ) : cargandoTraslados ? (
              <ul className="flex flex-col divide-y divide-line" aria-busy>
                {Array.from({ length: 4 }, (_, i) => (
                  <li key={i} className="px-4 py-3">
                    <SkeletonLinea className="h-5" />
                  </li>
                ))}
              </ul>
            ) : visibles.length === 0 ? (
              <EstadoVacio
                titulo={filtro === "todos" ? "Este punto todavía no tiene traslados." : "No hay traslados con este filtro."}
              />
            ) : (
              <TablaTrasladosPunto filas={visibles} onAbrir={abrirFila} />
            )}
          </Panel>

          <div className={`grid items-start gap-5 ${esAdmin ? "lg:grid-cols-2" : ""}`}>
            <Panel titulo="Talonario activo" subtitulo="Hoja siguiente y hojas que quedan, por empresa." conRelleno={false}>
              {errorTalonario ? (
                <EstadoVacio titulo="No se pudo consultar el talonario de este punto." ayuda="Inténtalo de nuevo más tarde." />
              ) : cargandoTalonario ? (
                <div className="p-4 sm:p-5" aria-busy>
                  <SkeletonLinea className="h-10" />
                </div>
              ) : (talonarios?.talonarios.length ?? 0) === 0 ? (
                <EstadoVacio titulo="Este punto todavía no tiene un talonario configurado." />
              ) : (
                <ul className="flex flex-col divide-y divide-line">
                  {talonarios!.talonarios.map((t) => (
                    <FilaTalonario key={t.id} talonario={t} />
                  ))}
                </ul>
              )}
            </Panel>

            {esAdmin ? (
              <Panel
                titulo="Usuarios del punto"
                subtitulo="Quienes entran a la app de este punto con su PIN."
                conteo={usuarios ? String(usuarios.length) : undefined}
                conRelleno={false}
              >
                {sinPermisoUsuarios ? (
                  <EstadoVacio
                    titulo="No tienes permiso para ver los usuarios de este punto."
                    ayuda="Inicia sesión como administrador para consultarlos."
                  />
                ) : errorUsuarios ? (
                  <EstadoVacio titulo="No se pudieron cargar los usuarios." ayuda="Inténtalo de nuevo más tarde." />
                ) : cargandoUsuarios ? (
                  <div className="p-4 sm:p-5" aria-busy>
                    <SkeletonLinea className="h-10" />
                  </div>
                ) : (usuarios?.length ?? 0) === 0 ? (
                  <EstadoVacio titulo="Este punto todavía no tiene usuarios." />
                ) : (
                  <ul className="flex flex-col divide-y divide-line">
                    {usuarios!.map((u) => (
                      <li key={u.id} className="flex min-h-11 items-center justify-between gap-3 px-4 py-2.5 text-sm sm:px-5">
                        <span className="min-w-0 truncate text-ink">{u.nombre}</span>
                        <Pildora tono={u.estado === "activo" ? "ok" : "neutro"}>
                          {u.estado === "activo" ? "Activo" : "Inactivo"}
                        </Pildora>
                      </li>
                    ))}
                  </ul>
                )}
              </Panel>
            ) : null}
          </div>
        </>
      )}

      {detalleId ? (
        <ModalDetalleTraslado
          id={detalleId}
          puedeAsignar={puedeAsignar}
          onCerrar={() => setDetalleId(null)}
          onCambio={recargar}
        />
      ) : null}
      {anuladaDetalle ? <ModalAnulada fila={anuladaDetalle} onCerrar={() => setAnuladaDetalle(null)} /> : null}
    </main>
  );

  return contenido;
}
