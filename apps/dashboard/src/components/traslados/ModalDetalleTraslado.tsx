"use client";

// Detalle de un traslado: datos, apartado Syscafe (numero y reporte, editables
// para quien puede asignarlos), productos con lo enviado vs. lo recibido (con su estado por
// producto), novedad y fotos.

import { useState } from "react";
import useSWR from "swr";
import { toast } from "sonner";
import {
  anularTrasladoBodega,
  fetchTrasladoDetalle,
  type ItemTrasladoDetalle,
  type TrasladoDetalle,
} from "@/lib/api";
import { claseBoton, ErrorConReintento, Icono, Pildora, type TonoPildora } from "@/components/ui";
import { Folio } from "@/components/entregas/Folio";
import {
  empresaTalonario,
  ESTADOS,
  fechaCorta,
  fechaHora,
  formatoPrecio,
  ORIGEN_DIRECTO,
  referencia,
  SIN_REFERENCIA,
} from "./compartido";
import { ModalTrasladoBodega } from "./ModalTrasladoBodega";
import { Dato, ModalBase } from "./ModalBase";
import { FormSolucionNovedad } from "./FormSolucionNovedad";
import { SeccionSyscafe } from "./SeccionSyscafe";

export function ModalDetalleTraslado({
  id,
  puedeAsignar,
  onCerrar,
  onCambio,
}: {
  id: string;
  puedeAsignar: boolean;
  onCerrar: () => void;
  onCambio: () => void;
}) {
  const { data: t, error, mutate } = useSWR(["traslado-detalle", id], () => fetchTrasladoDetalle(id), {
    refreshInterval: 5000,
  });
  // Llega directo: no hay quien despache ni transporte, solo firma quien recibe.
  const directo = t?.tipo === "directo";
  // Desde bodega: PDF del sistema contable que el supervisor envio a un punto.
  const bodega = t?.tipo === "desde_bodega";
  const [editando, setEditando] = useState(false);
  const info = t ? (ESTADOS[t.estado] ?? { texto: t.estado, tono: "neutro" as TonoPildora }) : null;

  return (
    <>
    <ModalBase
      etiqueta={t && referencia({ ...t, tipo: "traslado" }) !== SIN_REFERENCIA ? `Traslado ${referencia({ ...t, tipo: "traslado" })}` : "Traslado"}
      titulo={
        t && referencia({ ...t, tipo: "traslado" }) !== SIN_REFERENCIA ? (
          <Folio tipo="Traslado" numero={referencia({ ...t, tipo: "traslado" })} tamano="modal" />
        ) : (
          "Traslado"
        )
      }
      onCerrar={onCerrar}
      pildora={info ? <Pildora tono={info.tono}>{info.texto}</Pildora> : undefined}
    >
      {error ? (
        <ErrorConReintento mensaje="No se pudo cargar el detalle del traslado." onReintentar={() => mutate()} />
      ) : !t ? (
        <div className="flex flex-col gap-2" aria-busy>
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="h-6 animate-pulse rounded bg-surface-2" />
          ))}
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {empresaTalonario({ ...t, tipo: "traslado" }) ? (
              <Dato etiqueta="Empresa">{empresaTalonario({ ...t, tipo: "traslado" })}</Dato>
            ) : null}
            <Dato etiqueta="Origen y destino">
              {directo ? ORIGEN_DIRECTO : (t.punto_origen_nombre ?? "—")} <Icono nombre="derecha" className="mx-0.5 inline h-3.5 w-3.5 align-text-bottom text-muted" />
              <span className="sr-only">a</span> {t.punto_destino_nombre ?? "—"}
            </Dato>
            <Dato etiqueta="Fecha">{fechaCorta(t.fecha)}</Dato>
            {directo || bodega ? null : <Dato etiqueta="Transportador">{t.transportador_nombre || "—"}</Dato>}
            {bodega && t.concepto ? <Dato etiqueta="Concepto">{t.concepto}</Dato> : null}
            {bodega && t.elaboro ? <Dato etiqueta="Elaboró">{t.elaboro}</Dato> : null}
            <Dato etiqueta="Creado por">
              {t.creado_por_nombre ?? "—"}, {fechaHora(t.created_at)}
            </Dato>
            <Dato etiqueta="Recibido por">
              {t.recibido_at ? `${t.recibido_por_nombre ?? "—"}, ${fechaHora(t.recibido_at)}` : "Aún sin recibir"}
            </Dato>
          </div>

          {bodega ? (
            <AccionesBodega
              t={t}
              puedeGestionar={puedeAsignar}
              onEditar={() => setEditando(true)}
              onAnulado={async () => {
                await mutate();
                onCambio();
              }}
            />
          ) : (
            <SeccionSyscafe
              traslado={t}
              puedeEditar={puedeAsignar}
              onCambio={async () => {
                await mutate();
                onCambio();
              }}
            />
          )}

          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h4 className="text-sm font-semibold text-ink">Productos</h4>
              <ResumenRecepcion items={t.items} />
            </div>
            <div className="overflow-x-auto rounded-md border border-line">
              <table className="w-full min-w-[640px] text-left text-sm">
                <thead className="border-b border-line text-xs text-muted">
                  <tr>
                    {bodega ? <th className="px-3 py-2 font-medium">Referencia</th> : null}
                    <th className="px-3 py-2 font-medium">Producto</th>
                    {bodega ? null : <th className="px-3 py-2 font-medium">Marca</th>}
                    <th className="px-3 py-2 font-medium">{bodega ? "Empaque" : "Presentación"}</th>
                    {bodega ? <th className="px-3 py-2 text-right font-medium">Precio</th> : null}
                    <th className="px-3 py-2 text-right font-medium">Enviada</th>
                    <th className="px-3 py-2 text-right font-medium">Recibida</th>
                    {bodega ? null : <th className="px-3 py-2 font-medium">Vence</th>}
                    <th className="px-3 py-2 font-medium">Estado</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {t.items.map((it) => {
                    const diferente = it.cantidad_recibida !== null && it.cantidad_recibida !== it.cantidad;
                    return (
                      <tr key={it.id} className="align-top">
                        {bodega ? <td className="cifra px-3 py-2 text-ink">{it.referencia ?? "—"}</td> : null}
                        <td className="px-3 py-2 text-ink">
                          {it.producto}
                          {it.novedad ? <p className="text-xs text-danger-fg">Novedad: {it.novedad}</p> : null}
                        </td>
                        {bodega ? null : <td className="px-3 py-2 text-xs text-muted">{it.marca || "—"}</td>}
                        <td className="px-3 py-2 text-xs text-muted">{it.presentacion || "—"}</td>
                        {bodega ? (
                          <td className="px-3 py-2 text-right tabular-nums text-ink">{formatoPrecio(it.precio)}</td>
                        ) : null}
                        <td className="px-3 py-2 text-right tabular-nums text-ink">{it.cantidad}</td>
                        <td
                          className={`px-3 py-2 text-right tabular-nums ${diferente ? "font-semibold text-danger-fg" : "text-ink"}`}
                        >
                          {it.cantidad_recibida ?? "—"}
                          {diferente ? <span className="sr-only"> (distinta de lo enviado)</span> : null}
                        </td>
                        {bodega ? null : (
                          <td className="px-3 py-2 text-xs text-muted">
                            {it.fecha_vencimiento ? fechaCorta(it.fecha_vencimiento) : "—"}
                          </td>
                        )}
                        <td className="px-3 py-2">
                          <EstadoProducto it={it} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {t.contenido_texto ? (
            <Dato etiqueta="Contenido de la hoja">
              <span className="whitespace-pre-line">{t.contenido_texto}</span>
            </Dato>
          ) : null}
          {t.observaciones ? <Dato etiqueta="Observaciones">{t.observaciones}</Dato> : null}
          <NovedadYSolucion
            t={t}
            puedeResolver={puedeAsignar}
            onResuelta={async () => {
              await mutate();
              onCambio();
            }}
          />
          <Imagenes t={t} />
        </>
      )}
    </ModalBase>
    {editando && t ? (
      <ModalTrasladoBodega
        traslado={t}
        onCerrar={() => setEditando(false)}
        onGuardado={async () => {
          await mutate();
          onCambio();
        }}
      />
    ) : null}
    </>
  );
}

// Traslado desde bodega: PDF original, anulacion (si la hay) y, mientras sigue en
// transito, editar o anular (solo quien puede escribir traslados).
function AccionesBodega({
  t,
  puedeGestionar,
  onEditar,
  onAnulado,
}: {
  t: TrasladoDetalle;
  puedeGestionar: boolean;
  onEditar: () => void;
  onAnulado: () => void | Promise<void>;
}) {
  const [anulando, setAnulando] = useState(false);
  const [motivo, setMotivo] = useState("");
  const [enviando, setEnviando] = useState(false);
  const editable = puedeGestionar && t.estado === "en_transito";

  const confirmar = async () => {
    setEnviando(true);
    try {
      await anularTrasladoBodega(t.id, motivo.trim());
      toast.success("Traslado anulado");
      setAnulando(false);
      await onAnulado();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "No se pudo anular el traslado");
    } finally {
      setEnviando(false);
    }
  };

  return (
    <div className="flex flex-col gap-3 rounded-md border border-line bg-surface-2 p-3">
      <div className="flex flex-wrap items-center gap-2">
        {t.pdf_url ? (
          <a href={t.pdf_url} target="_blank" rel="noopener noreferrer" className={claseBoton("secundario")}>
            <Icono nombre="factura" className="h-4 w-4" />
            Ver PDF original
          </a>
        ) : null}
        {editable && !anulando ? (
          <>
            <button type="button" onClick={onEditar} className={claseBoton("secundario")}>
              <Icono nombre="lapiz" className="h-4 w-4" />
              Editar traslado
            </button>
            <button type="button" onClick={() => setAnulando(true)} className={claseBoton("fantasma")}>
              Anular traslado
            </button>
          </>
        ) : null}
      </div>

      {anulando ? (
        <div className="flex flex-col gap-2">
          <label className="flex flex-col gap-1 text-xs font-medium text-muted">
            Motivo de la anulación
            <textarea
              value={motivo}
              onChange={(e) => setMotivo(e.target.value)}
              maxLength={500}
              rows={2}
              className="rounded-md border border-line-strong bg-surface p-2 text-sm text-ink"
            />
          </label>
          <span className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={confirmar}
              disabled={enviando || motivo.trim() === ""}
              className={claseBoton("peligro")}
            >
              {enviando ? "Anulando…" : "Confirmar anulación"}
            </button>
            <button type="button" onClick={() => setAnulando(false)} disabled={enviando} className={claseBoton("fantasma")}>
              Cancelar
            </button>
          </span>
        </div>
      ) : null}

      {t.estado === "anulado" ? (
        <div className="flex flex-col gap-1 border-t border-line pt-3">
          <span className="text-xs font-medium text-muted">Anulado</span>
          <p className="text-sm text-ink">Motivo: {t.anulado_motivo ?? "—"}</p>
          <p className="text-xs text-muted">
            {t.anulado_por ?? "Supervisión"}, {fechaHora(t.anulado_at ?? null)}
          </p>
        </div>
      ) : null}
    </div>
  );
}

type EstadoItem = "bien" | "diferencia" | "sin_recibir";

// Una linea esta "bien" si llego lo enviado; "con diferencia" si llego distinto
// o trae novedad; "sin recibir" mientras el traslado no se haya recibido.
function estadoItem(it: ItemTrasladoDetalle): EstadoItem {
  if (it.cantidad_recibida === null) return "sin_recibir";
  if (it.cantidad_recibida !== it.cantidad || Boolean(it.novedad?.trim())) return "diferencia";
  return "bien";
}

function EstadoProducto({ it }: { it: ItemTrasladoDetalle }) {
  const estado = estadoItem(it);
  if (estado === "sin_recibir") return <Pildora tono="neutro">Sin recibir</Pildora>;
  if (estado === "bien") return <Pildora tono="ok">Llegó bien</Pildora>;
  const faltan = it.cantidad - (it.cantidad_recibida ?? 0);
  return (
    <div className="flex flex-col items-start gap-1">
      <Pildora tono="error">Con diferencia</Pildora>
      {faltan > 0 ? (
        <span className="text-xs text-danger-fg">
          Faltan {faltan} {faltan === 1 ? "unidad" : "unidades"}
        </span>
      ) : null}
      {it.novedad ? <span className="text-xs text-danger-fg">{it.novedad}</span> : null}
    </div>
  );
}

function ResumenRecepcion({ items }: { items: ItemTrasladoDetalle[] }) {
  const estados = items.map(estadoItem);
  if (estados.every((e) => e === "sin_recibir")) return null;
  const bien = estados.filter((e) => e === "bien").length;
  const conDiferencia = estados.filter((e) => e === "diferencia").length;
  const sinRecibir = estados.filter((e) => e === "sin_recibir").length;
  const partes = [`${bien} bien`, `${conDiferencia} con diferencia`];
  if (sinRecibir > 0) partes.push(`${sinRecibir} sin recibir`);
  return <span className="text-xs text-muted">{partes.join(" · ")}</span>;
}

function NovedadYSolucion({
  t,
  puedeResolver,
  onResuelta,
}: {
  t: TrasladoDetalle;
  puedeResolver: boolean;
  onResuelta: () => void | Promise<void>;
}) {
  if (!t.novedad && !t.novedad_estado) return null;
  const resuelta = t.novedad_estado === "resuelta";
  return (
    <div className="flex flex-col gap-3 rounded-md border border-line bg-surface-2 p-3">
      <div className="flex items-center gap-2">
        <h4 className="text-sm font-semibold text-ink">Novedad</h4>
        <Pildora tono={resuelta ? "ok" : "error"}>{resuelta ? "Resuelta" : "Pendiente"}</Pildora>
      </div>
      <p className="text-sm text-ink">{t.novedad ?? "Diferencia de cantidad en la recepción."}</p>
      {t.novedad_estado === "pendiente" && puedeResolver ? (
        <FormSolucionNovedad trasladoId={t.id} puntoDestinoId={t.punto_destino_id} onResuelta={onResuelta} />
      ) : null}
      {resuelta ? (
        <div className="flex flex-col gap-1 border-t border-line pt-3">
          <span className="text-xs font-medium text-muted">
            Solución{t.consecutivo_solucion ? ` ${t.consecutivo_solucion}` : ""}
          </span>
          <p className="text-sm text-ink">{t.solucion ?? "—"}</p>
          <p className="text-xs text-muted">
            {t.solucionado_por_nombre ?? "Supervisión"}, {fechaHora(t.solucionado_at)}
          </p>
        </div>
      ) : null}
    </div>
  );
}

// Foto del talonario y firmas: el backend guarda URLs publicas de Storage (las
// arma la app movil con getPublicUrl), asi que se muestran tal cual.
function Imagenes({ t }: { t: TrasladoDetalle }) {
  const imagenes = [
    { url: t.foto_talonario_url, etiqueta: "Talonario" },
    // En una llegada directa solo firma quien recibe.
    { url: t.tipo === "directo" ? null : t.firma_despacha_url, etiqueta: "Firma despacha" },
    { url: t.tipo === "directo" ? null : t.firma_transporta_url, etiqueta: "Firma transporta" },
    { url: t.firma_recibe_url, etiqueta: "Firma recibe" },
  ].filter((i): i is { url: string; etiqueta: string } => Boolean(i.url));
  if (imagenes.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      <h4 className="text-sm font-semibold text-ink">Fotos y firmas</h4>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {imagenes.map((img) => (
          <a
            key={img.etiqueta}
            href={img.url}
            target="_blank"
            rel="noopener noreferrer"
            className="flex flex-col gap-1 text-xs text-muted hover:text-ink"
          >
            {/* eslint-disable-next-line @next/next/no-img-element -- URLs publicas de Storage, igual que la evidencia de entregas */}
            <img
              src={img.url}
              alt={img.etiqueta}
              loading="lazy"
              className="h-24 w-full rounded-md border border-line-strong bg-white object-contain p-1"
            />
            {img.etiqueta}
          </a>
        ))}
      </div>
    </div>
  );
}
