"use client";

// Traslado desde bodega: el supervisor sube el PDF "TRASLADO ENTRE BODEGAS" del
// sistema contable, revisa y corrige lo que el backend leyo (tabla editable),
// elige el punto de destino y lo envia. Tambien sirve para corregir un traslado
// que sigue en transito (recibe `traslado`: abre directo en la revision).

import { useState } from "react";
import useSWR from "swr";
import { toast } from "sonner";
import {
  editarTrasladoBodega,
  enviarTrasladoBodega,
  fetchPuntosPublicos,
  leerBorradorTrasladoBodega,
  type BorradorTrasladoBodega,
  type TrasladoBodegaDatos,
  type TrasladoDetalle,
} from "@/lib/api";
import { claseBoton, CLASE_CAMPO, Icono, Pildora } from "@/components/ui";
import { ModalBase } from "./ModalBase";

const MAX_BYTES_PDF = 5 * 1024 * 1024;

interface FilaEditable {
  clave: number;
  referencia: string;
  detalle: string;
  empaque: string;
  cantidad: string;
  precio: string;
}

interface Formulario {
  numero: string;
  fecha: string;
  concepto: string;
  origen: string;
  elaboro: string;
  puntoId: string;
}

const FORMULARIO_VACIO: Formulario = { numero: "", fecha: "", concepto: "", origen: "", elaboro: "", puntoId: "" };

const claseCeldaCampo = `${CLASE_CAMPO} w-full min-w-0`;

// Clave estable de cada renglon (sirve de key de React al agregar o quitar filas).
let ultimaClave = 0;
const siguienteClave = () => ++ultimaClave;

function filaVacia(clave: number): FilaEditable {
  return { clave, referencia: "", detalle: "", empaque: "", cantidad: "", precio: "" };
}

const cantidadValida = (txt: string) => txt.trim() !== "" && Number.isInteger(Number(txt)) && Number(txt) > 0;
const precioValido = (txt: string) => txt.trim() !== "" && Number.isFinite(Number(txt)) && Number(txt) >= 0;
const filaValida = (f: FilaEditable) =>
  f.referencia.trim() !== "" && f.detalle.trim() !== "" && cantidadValida(f.cantidad) && precioValido(f.precio);

export function ModalTrasladoBodega({
  traslado,
  onCerrar,
  onGuardado,
}: {
  traslado?: TrasladoDetalle;
  onCerrar: () => void;
  onGuardado: () => void;
}) {
  const edicion = Boolean(traslado);

  const { data: puntos } = useSWR("puntos-publicos", fetchPuntosPublicos);

  const [archivo, setArchivo] = useState<File | null>(null);
  const [leyendo, setLeyendo] = useState(false);
  const [errorLectura, setErrorLectura] = useState<string | null>(null);
  const [borrador, setBorrador] = useState<BorradorTrasladoBodega | null>(null);
  const [enviando, setEnviando] = useState(false);
  const [form, setForm] = useState<Formulario>(() =>
    traslado
      ? {
          numero: traslado.numero_documento ?? traslado.numero_syscafe ?? "",
          fecha: traslado.fecha?.slice(0, 10) ?? "",
          concepto: traslado.concepto ?? "",
          origen: traslado.origen_texto ?? traslado.punto_origen_nombre ?? "",
          elaboro: traslado.elaboro ?? "",
          puntoId: traslado.punto_destino_id ?? "",
        }
      : FORMULARIO_VACIO,
  );
  const [filas, setFilas] = useState<FilaEditable[]>(() =>
    (traslado?.items ?? []).map((it) => ({
      clave: siguienteClave(),
      referencia: it.referencia ?? "",
      detalle: it.producto,
      empaque: it.presentacion ?? "",
      cantidad: String(it.cantidad),
      precio: it.precio == null ? "" : String(it.precio),
    })),
  );

  const enRevision = edicion || borrador !== null;
  const campo = (k: keyof Formulario) => (v: string) => setForm((f) => ({ ...f, [k]: v }));
  const cambiarFila = (clave: number, parte: Partial<FilaEditable>) =>
    setFilas((fs) => fs.map((f) => (f.clave === clave ? { ...f, ...parte } : f)));

  const elegirArchivo = async (elegido: File | undefined | null) => {
    if (!elegido) return;
    if (elegido.type !== "application/pdf" && !elegido.name.toLowerCase().endsWith(".pdf")) {
      toast.error("El traslado debe ser un archivo PDF.");
      return;
    }
    if (elegido.size > MAX_BYTES_PDF) {
      toast.error("El PDF no puede pesar más de 5 MB.");
      return;
    }
    setErrorLectura(null);
    setLeyendo(true);
    try {
      const leido = await leerBorradorTrasladoBodega(elegido);
      setArchivo(elegido);
      setBorrador(leido);
      setForm({
        numero: leido.numero ?? "",
        fecha: leido.fecha ?? "",
        concepto: leido.concepto ?? "",
        origen: leido.origen ?? "",
        elaboro: leido.elaboro ?? "",
        puntoId: leido.punto_destino_id ?? "",
      });
      setFilas(
        leido.items.map((it) => ({
          clave: siguienteClave(),
          referencia: it.referencia,
          detalle: it.detalle,
          empaque: it.empaque,
          cantidad: String(it.cantidad),
          precio: String(it.precio),
        })),
      );
    } catch (err) {
      setErrorLectura(err instanceof Error ? err.message : "No se pudo leer el PDF");
    } finally {
      setLeyendo(false);
    }
  };

  const suma = filas.reduce((acc, f) => acc + (Number(f.cantidad) || 0), 0);
  const total = borrador?.total_documento ?? null;

  const faltantes: string[] = [];
  if (!form.numero.trim()) faltantes.push("Escribe el número del traslado");
  if (!form.fecha) faltantes.push("Falta la fecha");
  if (!form.origen.trim()) faltantes.push("Falta la bodega de origen");
  if (!form.puntoId) faltantes.push("Elige el punto de destino");
  if (filas.length === 0) faltantes.push("Agrega al menos un producto");
  else if (!filas.every(filaValida))
    faltantes.push("Revisa los productos: referencia, detalle, cantidad entera mayor que 0 y precio");

  const guardar = async () => {
    const datos: TrasladoBodegaDatos = {
      numero: form.numero.trim(),
      fecha: form.fecha,
      concepto: form.concepto.trim() || null,
      origen: form.origen.trim(),
      punto_destino_id: form.puntoId,
      elaboro: form.elaboro.trim() || null,
      items: filas.map((f) => ({
        referencia: f.referencia.trim(),
        detalle: f.detalle.trim(),
        empaque: f.empaque.trim(),
        cantidad: Number(f.cantidad),
        precio: Number(f.precio),
      })),
    };
    setEnviando(true);
    try {
      if (traslado) await editarTrasladoBodega(traslado.id, datos);
      else if (archivo) await enviarTrasladoBodega(archivo, datos);
      else return;
      toast.success(edicion ? "Traslado actualizado" : "Traslado enviado al punto");
      onGuardado();
      onCerrar();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "No se pudo guardar el traslado");
    } finally {
      setEnviando(false);
    }
  };

  const titulo = edicion ? "Editar traslado de bodega" : "Subir traslado de bodega";
  const advertencias = borrador?.advertencias ?? [];
  const avisarYaCargado = Boolean(borrador?.ya_cargado) && !advertencias.some((a) => /ya fue cargado/i.test(a));

  return (
    <ModalBase etiqueta={titulo} titulo={titulo} ancho="max-w-5xl" onCerrar={onCerrar}>
      {!enRevision ? (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-muted">
            Sube el PDF «Traslado entre bodegas» del sistema contable. Lo leemos para que revises los datos antes de
            enviarlo al punto.
          </p>
          <label className="flex min-h-32 cursor-pointer flex-col items-center justify-center gap-1.5 rounded-md border-2 border-dashed border-line-strong px-4 py-5 text-center hover:border-ok hover:bg-surface-2">
            <Icono nombre="arriba" className="h-5 w-5 text-ok-fg" />
            <span className="text-sm font-semibold text-ink">{leyendo ? "Leyendo el PDF…" : "Elegir PDF"}</span>
            <span className="text-xs text-muted">Solo PDF · 5 MB</span>
            <input
              type="file"
              accept="application/pdf"
              aria-label="Archivo PDF del traslado"
              disabled={leyendo}
              onChange={(e) => elegirArchivo(e.target.files?.[0])}
              className="sr-only"
            />
          </label>
          {errorLectura ? (
            <p role="alert" className="text-sm text-danger-fg">
              {errorLectura}
            </p>
          ) : null}
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {advertencias.length > 0 || avisarYaCargado ? (
            <ul className="flex flex-col gap-1 rounded-md border border-brand-gold/50 bg-brand-gold/10 p-3 text-sm text-ink">
              {avisarYaCargado ? <li>El traslado {borrador?.numero} ya fue cargado antes.</li> : null}
              {advertencias.map((a) => (
                <li key={a}>{a}</li>
              ))}
            </ul>
          ) : null}

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Campo etiqueta="Número del traslado" valor={form.numero} onCambio={campo("numero")} />
            <Campo etiqueta="Fecha" tipo="date" valor={form.fecha} onCambio={campo("fecha")} />
            <Campo etiqueta="Elaboró" valor={form.elaboro} onCambio={campo("elaboro")} />
            <Campo etiqueta="Bodega de origen" valor={form.origen} onCambio={campo("origen")} />
            <Campo etiqueta="Concepto" valor={form.concepto} onCambio={campo("concepto")} />
            <label className="flex flex-col gap-1 text-xs font-medium text-muted">
              Punto de destino
              {puntos ? (
                <select
                  value={form.puntoId}
                  onChange={(e) => campo("puntoId")(e.target.value)}
                  className={`${CLASE_CAMPO} text-ink`}
                >
                  <option value="">Elegir punto…</option>
                  {puntos.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.nombre}
                    </option>
                  ))}
                </select>
              ) : (
                <span className="min-h-11 py-3 text-sm font-normal text-muted">Cargando puntos…</span>
              )}
            </label>
          </div>
          {borrador?.destino_texto ? (
            <p className="-mt-2 text-xs text-muted">El PDF dice: «{borrador.destino_texto}».</p>
          ) : null}

          <div className="flex flex-wrap items-center justify-between gap-2">
            <h4 className="text-sm font-semibold text-ink">Productos</h4>
            <span className="flex flex-wrap items-center gap-2 text-xs text-muted">
              <span>Suma de cantidades: {suma}</span>
              {total !== null && suma !== total ? (
                <Pildora tono="warn">No coincide con el total del PDF ({total})</Pildora>
              ) : null}
            </span>
          </div>
          <div className="overflow-x-auto rounded-md border border-line">
            <table aria-label="Productos del traslado" className="w-full min-w-[820px] text-left text-sm">
              <thead className="border-b border-line text-xs text-muted">
                <tr>
                  <th scope="col" className="px-2 py-2 font-medium">Referencia</th>
                  <th scope="col" className="px-2 py-2 font-medium">Detalle</th>
                  <th scope="col" className="px-2 py-2 font-medium">Empaque</th>
                  <th scope="col" className="px-2 py-2 font-medium">Cantidad</th>
                  <th scope="col" className="px-2 py-2 font-medium">Precio</th>
                  <th scope="col" className="px-2 py-2">
                    <span className="sr-only">Acciones</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {filas.map((f, i) => (
                  <tr key={f.clave}>
                    <td className="w-28 px-2 py-1.5">
                      <input aria-label={`Referencia ${i + 1}`} value={f.referencia} className={claseCeldaCampo}
                        onChange={(e) => cambiarFila(f.clave, { referencia: e.target.value })} />
                    </td>
                    <td className="px-2 py-1.5">
                      <input aria-label={`Detalle ${i + 1}`} value={f.detalle} className={claseCeldaCampo}
                        onChange={(e) => cambiarFila(f.clave, { detalle: e.target.value })} />
                    </td>
                    <td className="w-28 px-2 py-1.5">
                      <input aria-label={`Empaque ${i + 1}`} value={f.empaque} className={claseCeldaCampo}
                        onChange={(e) => cambiarFila(f.clave, { empaque: e.target.value })} />
                    </td>
                    <td className="w-24 px-2 py-1.5">
                      <input aria-label={`Cantidad ${i + 1}`} type="number" min={1} step={1} value={f.cantidad}
                        className={claseCeldaCampo}
                        onChange={(e) => cambiarFila(f.clave, { cantidad: e.target.value })} />
                    </td>
                    <td className="w-32 px-2 py-1.5">
                      <input aria-label={`Precio ${i + 1}`} type="number" min={0} step="any" value={f.precio}
                        className={claseCeldaCampo}
                        onChange={(e) => cambiarFila(f.clave, { precio: e.target.value })} />
                    </td>
                    <td className="w-12 px-2 py-1.5">
                      <button
                        type="button"
                        aria-label={`Quitar producto ${i + 1}`}
                        onClick={() => setFilas((fs) => fs.filter((x) => x.clave !== f.clave))}
                        className="flex h-9 w-9 items-center justify-center rounded-md text-muted hover:bg-surface-2 hover:text-ink"
                      >
                        <Icono nombre="cerrar" className="h-4 w-4" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div>
            <button
              type="button"
              onClick={() => setFilas((fs) => [...fs, filaVacia(siguienteClave())])}
              className={claseBoton("fantasma")}
            >
              <Icono nombre="mas" className="h-4 w-4" />
              Agregar producto
            </button>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
            <p className="text-sm text-danger-fg" aria-live="polite">
              {faltantes[0] ?? ""}
            </p>
            <span className="flex gap-2">
              <button type="button" onClick={onCerrar} disabled={enviando} className={claseBoton("fantasma")}>
                Cancelar
              </button>
              <button
                type="button"
                onClick={guardar}
                disabled={enviando || faltantes.length > 0}
                className={claseBoton("primario")}
              >
                {enviando ? "Guardando…" : edicion ? "Guardar cambios" : "Enviar traslado"}
              </button>
            </span>
          </div>
        </div>
      )}
    </ModalBase>
  );
}

function Campo({
  etiqueta,
  valor,
  onCambio,
  tipo = "text",
}: {
  etiqueta: string;
  valor: string;
  onCambio: (v: string) => void;
  tipo?: string;
}) {
  return (
    <label className="flex flex-col gap-1 text-xs font-medium text-muted">
      {etiqueta}
      <input type={tipo} value={valor} onChange={(e) => onCambio(e.target.value)} className={`${CLASE_CAMPO} text-ink`} />
    </label>
  );
}
