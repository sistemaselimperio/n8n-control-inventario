"use client";

// Detalle de un traslado: datos, apartado Syscafe (numero y reporte, editables
// para quien puede asignarlos), productos con lo enviado vs. lo recibido (con su estado por
// producto), novedad y fotos.

import useSWR from "swr";
import {
  fetchTrasladoDetalle,
  type ItemTrasladoDetalle,
  type TrasladoDetalle,
} from "@/lib/api";
import { ErrorConReintento, Icono, Pildora, type TonoPildora } from "@/components/ui";
import { Folio } from "@/components/entregas/Folio";
import { empresaTalonario, ESTADOS, fechaCorta, fechaHora, ORIGEN_DIRECTO, referencia } from "./compartido";
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
  const info = t ? (ESTADOS[t.estado] ?? { texto: t.estado, tono: "neutro" as TonoPildora }) : null;

  return (
    <ModalBase
      etiqueta={t ? `Traslado ${referencia({ ...t, tipo: "traslado" })}` : "Traslado"}
      titulo={t ? <Folio tipo="Traslado" numero={referencia({ ...t, tipo: "traslado" })} tamano="modal" /> : "Traslado"}
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
            {directo ? null : <Dato etiqueta="Transportador">{t.transportador_nombre || "—"}</Dato>}
            <Dato etiqueta="Creado por">
              {t.creado_por_nombre ?? "—"}, {fechaHora(t.created_at)}
            </Dato>
            <Dato etiqueta="Recibido por">
              {t.recibido_at ? `${t.recibido_por_nombre ?? "—"}, ${fechaHora(t.recibido_at)}` : "Aún sin recibir"}
            </Dato>
          </div>

          <SeccionSyscafe
            traslado={t}
            puedeEditar={puedeAsignar}
            onCambio={async () => {
              await mutate();
              onCambio();
            }}
          />

          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h4 className="text-sm font-semibold text-ink">Productos</h4>
              <ResumenRecepcion items={t.items} />
            </div>
            <div className="overflow-x-auto rounded-md border border-line">
              <table className="w-full min-w-[640px] text-left text-sm">
                <thead className="border-b border-line text-xs text-muted">
                  <tr>
                    <th className="px-3 py-2 font-medium">Producto</th>
                    <th className="px-3 py-2 font-medium">Marca</th>
                    <th className="px-3 py-2 font-medium">Presentación</th>
                    <th className="px-3 py-2 text-right font-medium">Enviada</th>
                    <th className="px-3 py-2 text-right font-medium">Recibida</th>
                    <th className="px-3 py-2 font-medium">Vence</th>
                    <th className="px-3 py-2 font-medium">Estado</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {t.items.map((it) => {
                    const diferente = it.cantidad_recibida !== null && it.cantidad_recibida !== it.cantidad;
                    return (
                      <tr key={it.id} className="align-top">
                        <td className="px-3 py-2 text-ink">
                          {it.producto}
                          {it.novedad ? <p className="text-xs text-danger-fg">Novedad: {it.novedad}</p> : null}
                        </td>
                        <td className="px-3 py-2 text-xs text-muted">{it.marca || "—"}</td>
                        <td className="px-3 py-2 text-xs text-muted">{it.presentacion || "—"}</td>
                        <td className="px-3 py-2 text-right tabular-nums text-ink">{it.cantidad}</td>
                        <td
                          className={`px-3 py-2 text-right tabular-nums ${diferente ? "font-semibold text-danger-fg" : "text-ink"}`}
                        >
                          {it.cantidad_recibida ?? "—"}
                          {diferente ? <span className="sr-only"> (distinta de lo enviado)</span> : null}
                        </td>
                        <td className="px-3 py-2 text-xs text-muted">
                          {it.fecha_vencimiento ? fechaCorta(it.fecha_vencimiento) : "—"}
                        </td>
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
