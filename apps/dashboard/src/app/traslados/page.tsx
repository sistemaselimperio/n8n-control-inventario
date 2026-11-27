"use client";

// Traslados entre puntos. La encargada (y el admin) suben los PDF, revisan los
// borradores y los envian a los puntos; cada punto confirma la recepcion con
// firma o devuelve el comprobante con un motivo. Una lista unica de
// comprobantes con filtros, en tabla (escritorio) o tarjetas (celular). Los
// permisos por perfil viven en lib/traslados.ts; el backend los vuelve a
// verificar. Los datos se revalidan por Supabase Realtime y, de respaldo, por
// el polling de SWR.

import { useEffect, useMemo, useState } from "react";
import useSWR from "swr";
import {
  fetchComprobantes,
  fetchTrasladoPuntos,
  type Comprobante,
  type EstadoComprobante,
  type Traslado,
  type TipoComprobante,
} from "@/lib/api";
import { useSesion } from "@/lib/SesionProvider";
import { CLAVE_TRASLADOS, perfilTraslados, revalidarTraslados } from "@/lib/traslados";
import { useTrasladosEnVivo } from "@/lib/useTrasladosEnVivo";
import { BuscadorBarra } from "@/components/filtros";
import { IndicadorEnVivo } from "@/components/entregas/IndicadorEnVivo";
import {
  CampoFiltro,
  CLASE_CAMPO,
  claseBoton,
  EncabezadoPagina,
  ErrorConReintento,
  EstadoVacio,
  Panel,
  Pildora,
  SkeletonLinea,
  TarjetaFiltros,
} from "@/components/ui";
import { etiquetaPuntoOpcion } from "@/lib/traslados";
import { SeccionBorradores } from "@/components/traslados/SeccionBorradores";
import { SeccionDevueltos } from "@/components/traslados/SeccionDevueltos";
import { SubidaPdfs } from "@/components/traslados/SubidaPdfs";
import { TablaComprobantes } from "@/components/traslados/TablaComprobantes";
import { ModalConfirmarComprobante } from "@/components/traslados/ModalConfirmarComprobante";
import { ModalDevolver } from "@/components/traslados/ModalDevolver";
import { ModalEditarBorrador } from "@/components/traslados/ModalEditarBorrador";
import { ModalEliminarTraslado } from "@/components/traslados/ModalEliminarTraslado";
import { ModalHistorial } from "@/components/traslados/ModalHistorial";
import { ModalReenviar } from "@/components/traslados/ModalReenviar";
import { ModalVisor } from "@/components/traslados/ModalVisor";

const TANDA = 50;

type Modal =
  | { tipo: "visor"; titulo: string; url: string; formato: "pdf" | "imagen" }
  | { tipo: "historial"; id: string; titulo: string }
  | { tipo: "confirmar"; comprobante: Comprobante }
  | { tipo: "devolver"; comprobante: Comprobante }
  | { tipo: "reenviar"; comprobante: Comprobante }
  | { tipo: "editar"; traslado: Traslado }
  | { tipo: "eliminar"; trasladoId: string; numero: string };

function useDebounce<T>(valor: T, ms: number): T {
  const [v, setV] = useState(valor);
  useEffect(() => {
    const t = setTimeout(() => setV(valor), ms);
    return () => clearTimeout(t);
  }, [valor, ms]);
  return v;
}

const DESCRIPCION: Record<string, string> = {
  admin: "Sube los PDF, revisa los borradores, envíalos a los puntos y sigue la confirmación de cada comprobante.",
  encargada: "Sube los PDF, revisa los borradores, envíalos a los puntos y sigue la confirmación de cada comprobante.",
  punto: "Confirma con tu firma los comprobantes que llegan a tu punto, o devuélvelos con el motivo.",
  lectura: "Consulta de comprobantes de traslados.",
};

export default function TrasladosPage() {
  const { usuario } = useSesion();
  const perfil = useMemo(() => perfilTraslados(usuario), [usuario]);
  const { enVivo, refreshInterval } = useTrasladosEnVivo();

  const [busqueda, setBusqueda] = useState("");
  const q = useDebounce(busqueda.trim(), 300);
  const [puntoId, setPuntoId] = useState("");
  const [estado, setEstado] = useState<EstadoComprobante | "">("");
  const [tipo, setTipo] = useState<TipoComprobante | "">("");
  const [limite, setLimite] = useState(TANDA);
  const [modal, setModal] = useState<Modal | null>(null);

  const verFiltroPunto = perfil.acceso && !perfil.puntoId;
  const { data: puntos } = useSWR(
    perfil.acceso && (perfil.gestiona || verFiltroPunto) ? [CLAVE_TRASLADOS, "puntos"] : null,
    () => fetchTrasladoPuntos(),
  );

  const filtros = {
    punto_id: puntoId || undefined,
    estado: estado || undefined,
    tipo: tipo || undefined,
    q: q || undefined,
    limit: limite,
  };
  const { data, error, isLoading, mutate } = useSWR(
    perfil.acceso ? [CLAVE_TRASLADOS, "comprobantes", filtros] : null,
    () => fetchComprobantes(filtros),
    { refreshInterval, keepPreviousData: true },
  );
  const { data: pendientes } = useSWR(
    perfil.tipo === "punto" ? [CLAVE_TRASLADOS, "pendientes"] : null,
    () => fetchComprobantes({ estado: "pendiente", limit: 1 }),
    { refreshInterval },
  );

  if (!perfil.acceso) {
    return (
      <main className="mx-auto flex w-full max-w-7xl flex-1 flex-col gap-5 px-4 py-6 sm:px-6 sm:py-8">
        <EncabezadoPagina titulo="Traslados" />
        <EstadoVacio titulo="Tu cuenta no tiene acceso a los traslados." ayuda="Si lo necesitas, solicita el acceso al administrador." />
      </main>
    );
  }

  const items = data?.items ?? [];
  const hayFiltros = Boolean(puntoId || estado || tipo || busqueda);
  const cerrar = () => setModal(null);
  const hecho = () => {
    setModal(null);
    revalidarTraslados();
  };

  const manejadores = {
    onHistorial: (c: Comprobante) => setModal({ tipo: "historial", id: c.id, titulo: c.numero }),
    onConfirmar: (c: Comprobante) => setModal({ tipo: "confirmar", comprobante: c }),
    onDevolver: (c: Comprobante) => setModal({ tipo: "devolver", comprobante: c }),
    onReenviar: (c: Comprobante) => setModal({ tipo: "reenviar", comprobante: c }),
    onEliminar: (c: Comprobante) => setModal({ tipo: "eliminar", trasladoId: c.traslado_id, numero: c.numero }),
  };
  const verPdf = (titulo: string, url: string | null | undefined) =>
    url && setModal({ tipo: "visor", titulo, url, formato: "pdf" });

  return (
    <main className="mx-auto flex w-full max-w-7xl flex-1 flex-col gap-5 px-4 py-6 sm:px-6 sm:py-8">
      <EncabezadoPagina
        titulo="Traslados"
        descripcion={DESCRIPCION[perfil.tipo === "ninguno" ? "lectura" : perfil.tipo]}
        acciones={
          <>
            {perfil.tipo === "punto" && pendientes ? (
              <Pildora tono={pendientes.total > 0 ? "warn" : "ok"} className="px-3 py-1">
                {pendientes.total} {pendientes.total === 1 ? "pendiente" : "pendientes"} por confirmar
              </Pildora>
            ) : null}
            <IndicadorEnVivo enVivo={enVivo} />
          </>
        }
      />

      {perfil.gestiona ? (
        <>
          <SubidaPdfs />
          <SeccionBorradores
            refreshInterval={refreshInterval}
            onEditar={(t) => setModal({ tipo: "editar", traslado: t })}
            onEliminar={(t) => setModal({ tipo: "eliminar", trasladoId: t.id, numero: t.numero ?? t.archivo_nombre ?? "sin número" })}
            onVerPdf={(t) => verPdf(t.archivo_nombre ?? "Traslado", t.pdf_url)}
          />
          <SeccionDevueltos perfil={perfil} refreshInterval={refreshInterval} {...manejadores} />
        </>
      ) : null}

      <TarjetaFiltros
        etiqueta="Filtros de comprobantes"
        resumen={data ? `${data.total} comprobante${data.total === 1 ? "" : "s"}` : undefined}
      >
        <BuscadorBarra
          id="traslados-buscar"
          etiqueta="Buscar por número o archivo"
          valor={busqueda}
          onCambio={(v) => {
            setBusqueda(v);
            setLimite(TANDA);
          }}
          placeholder="Buscar por número o archivo"
          claseCampo={CLASE_CAMPO}
        />
        {verFiltroPunto ? (
          <CampoFiltro id="traslados-punto" etiqueta="Punto">
            <select
              id="traslados-punto"
              value={puntoId}
              onChange={(e) => {
                setPuntoId(e.target.value);
                setLimite(TANDA);
              }}
              className={CLASE_CAMPO}
            >
              <option value="">Todos los puntos</option>
              {(puntos ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {etiquetaPuntoOpcion(p)}
                </option>
              ))}
            </select>
          </CampoFiltro>
        ) : null}
        <CampoFiltro id="traslados-estado" etiqueta="Estado">
          <select
            id="traslados-estado"
            value={estado}
            onChange={(e) => {
              setEstado(e.target.value as EstadoComprobante | "");
              setLimite(TANDA);
            }}
            className={CLASE_CAMPO}
          >
            <option value="">Todos</option>
            <option value="pendiente">Pendiente</option>
            <option value="confirmado">Confirmado</option>
            <option value="devuelto">Devuelto</option>
          </select>
        </CampoFiltro>
        <CampoFiltro id="traslados-tipo" etiqueta="Movimiento">
          <select
            id="traslados-tipo"
            value={tipo}
            onChange={(e) => {
              setTipo(e.target.value as TipoComprobante | "");
              setLimite(TANDA);
            }}
            className={CLASE_CAMPO}
          >
            <option value="">Todos</option>
            <option value="salida">Salida</option>
            <option value="ingreso">Ingreso</option>
          </select>
        </CampoFiltro>
        {hayFiltros ? (
          <button
            type="button"
            onClick={() => {
              setBusqueda("");
              setPuntoId("");
              setEstado("");
              setTipo("");
              setLimite(TANDA);
            }}
            className={claseBoton("fantasma")}
          >
            Limpiar filtros
          </button>
        ) : null}
      </TarjetaFiltros>

      <Panel conRelleno={false} titulo="Comprobantes" conteo={data ? String(data.total) : undefined}>
        {error ? (
          <div className="p-4 sm:p-5">
            <ErrorConReintento mensaje={error.message} onReintentar={() => mutate()} />
          </div>
        ) : null}
        {isLoading && !data ? (
          <div className="flex flex-col gap-2 p-4">
            <SkeletonLinea className="h-10" />
            <SkeletonLinea className="h-10" />
            <SkeletonLinea className="h-10" />
          </div>
        ) : null}
        {data && items.length === 0 ? (
          <p className="px-5 py-8 text-center text-sm text-muted">
            {hayFiltros ? "No hay comprobantes con esos filtros." : "No hay comprobantes todavía."}
          </p>
        ) : null}
        {items.length > 0 ? (
          <TablaComprobantes
            items={items}
            perfil={perfil}
            onVerPdf={(c) => verPdf(c.archivo_nombre ?? c.numero, c.pdf_url)}
            onVerFirma={(c) =>
              c.firma_url && setModal({ tipo: "visor", titulo: `Firma de ${c.responsable_nombre ?? c.numero}`, url: c.firma_url, formato: "imagen" })
            }
            {...manejadores}
          />
        ) : null}
        {data && items.length < data.total ? (
          <div className="flex justify-center border-t border-line p-3">
            <button type="button" onClick={() => setLimite((l) => l + TANDA)} className={claseBoton("secundario")}>
              Cargar más
            </button>
          </div>
        ) : null}
      </Panel>

      {modal?.tipo === "visor" ? <ModalVisor titulo={modal.titulo} url={modal.url} tipo={modal.formato} onCerrar={cerrar} /> : null}
      {modal?.tipo === "historial" ? <ModalHistorial comprobanteId={modal.id} titulo={modal.titulo} onCerrar={cerrar} /> : null}
      {modal?.tipo === "confirmar" && usuario ? (
        <ModalConfirmarComprobante
          comprobante={modal.comprobante}
          onCerrar={cerrar}
          onHecho={hecho}
        />
      ) : null}
      {modal?.tipo === "devolver" ? <ModalDevolver comprobante={modal.comprobante} onCerrar={cerrar} onHecho={hecho} /> : null}
      {modal?.tipo === "reenviar" ? (
        <ModalReenviar comprobante={modal.comprobante} puntos={puntos ?? []} onCerrar={cerrar} onHecho={hecho} />
      ) : null}
      {modal?.tipo === "editar" ? (
        <ModalEditarBorrador traslado={modal.traslado} puntos={puntos ?? []} onCerrar={cerrar} onHecho={hecho} />
      ) : null}
      {modal?.tipo === "eliminar" ? (
        <ModalEliminarTraslado trasladoId={modal.trasladoId} numero={modal.numero} onCerrar={cerrar} onHecho={hecho} />
      ) : null}
    </main>
  );
}
