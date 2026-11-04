"use client";

import { useState } from "react";
import { toast } from "sonner";
import { actualizarItems, revisarEntrega, type Entrega, type ItemEntrega } from "@/lib/api";
import { Boton, Icono } from "@/components/ui";
import { TIPOS_DOCUMENTO } from "@/lib/entregas";
import { Folio } from "./Folio";

// Edicion de una entrega desde el boton "Editar" del detalle (solo admin):
// tipo, N° de documento y, por producto, nombre y cantidades. Guarda con los
// mismos endpoints que la revision manual -- el backend lo registra como
// correccion del admin (ver "Cambios del admin").
export function ModalEditarEntrega({
  entrega,
  onCerrar,
  onGuardado,
}: {
  entrega: Entrega;
  onCerrar: () => void;
  onGuardado: () => void;
}) {
  const [tipo, setTipo] = useState(entrega.tipo);
  const [indicativoNumero, setIndicativoNumero] = useState(entrega.indicativo_numero);
  const [items, setItems] = useState<ItemEntrega[]>(entrega.items);
  const [guardando, setGuardando] = useState(false);

  const actualizarItem = (id: string, cambios: Partial<ItemEntrega>) => {
    setItems((prev) => prev.map((item) => (item.id === id ? { ...item, ...cambios } : item)));
  };

  const guardar = async () => {
    if (!tipo.trim() || !indicativoNumero.trim()) {
      toast.error("Tipo y N° de documento no pueden quedar vacíos");
      return;
    }
    if (items.some((item) => !item.descripcion.trim())) {
      toast.error("Ningún producto puede quedar sin nombre");
      return;
    }
    if (items.some((item) => item.cantidad_entregada < 0 || item.cantidad_pendiente < 0)) {
      toast.error("Las cantidades no pueden ser negativas");
      return;
    }
    setGuardando(true);
    try {
      await revisarEntrega(entrega.id, { tipo, indicativo_numero: indicativoNumero, aprobar: false });
      if (items.length > 0) {
        await actualizarItems(
          entrega.id,
          items.map((item) => ({
            id: item.id,
            descripcion: item.descripcion.trim(),
            cantidad_entregada: item.cantidad_entregada,
            cantidad_pendiente: item.cantidad_pendiente,
          }))
        );
      }
      toast.success("Entrega actualizada");
      onGuardado();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Error al guardar");
    } finally {
      setGuardando(false);
    }
  };

  const claseInput = "rounded-lg border border-line bg-page px-2 py-1.5 text-sm text-ink";

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-brand-night/50 px-4"
      onClick={guardando ? undefined : onCerrar}
    >
      <div
        className="flex max-h-[85vh] w-full max-w-lg flex-col gap-4 overflow-y-auto rounded-lg border border-line bg-surface p-5"
        onClick={(ev) => ev.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <h3 className="flex flex-wrap items-baseline gap-x-3 text-lg font-semibold text-ink">
            Editar <Folio tipo={entrega.tipo} numero={entrega.indicativo_numero} tamano="modal" />
          </h3>
          <button onClick={onCerrar} disabled={guardando} className="text-muted hover:text-ink" aria-label="Cerrar">
            <Icono nombre="cerrar" className="h-5 w-5" />
          </button>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <label className="flex flex-col gap-1 text-xs text-muted">
            Tipo
            <input
              value={tipo}
              onChange={(e) => setTipo(e.target.value.toUpperCase())}
              list="tipos-documento-editar"
              className={claseInput}
            />
            <datalist id="tipos-documento-editar">
              {TIPOS_DOCUMENTO.map((t) => (
                <option key={t} value={t} />
              ))}
            </datalist>
          </label>
          <label className="flex flex-col gap-1 text-xs text-muted">
            N° de documento
            <input value={indicativoNumero} onChange={(e) => setIndicativoNumero(e.target.value)} className={claseInput} />
          </label>
        </div>

        <div className="flex flex-col gap-2">
          <span className="text-sm font-medium text-muted">Productos</span>
          {items.length === 0 ? (
            <p className="text-xs text-subtle">Sin productos registrados.</p>
          ) : (
            items.map((item) => (
              <div key={item.id} className="flex flex-col gap-2 rounded-md border border-line p-2">
                <label className="flex flex-col gap-1 text-xs text-muted">
                  Nombre del producto
                  <input
                    value={item.descripcion}
                    onChange={(e) => actualizarItem(item.id, { descripcion: e.target.value })}
                    className={claseInput}
                  />
                </label>
                <div className="grid grid-cols-2 gap-2">
                  <label className="flex flex-col gap-1 text-xs text-muted">
                    Entregado
                    <input
                      type="number"
                      min={0}
                      value={item.cantidad_entregada}
                      onChange={(e) => actualizarItem(item.id, { cantidad_entregada: Number(e.target.value) })}
                      className={claseInput}
                    />
                  </label>
                  <label className="flex flex-col gap-1 text-xs text-muted">
                    Pendiente
                    <input
                      type="number"
                      min={0}
                      value={item.cantidad_pendiente}
                      onChange={(e) => actualizarItem(item.id, { cantidad_pendiente: Number(e.target.value) })}
                      className={claseInput}
                    />
                  </label>
                </div>
              </div>
            ))
          )}
        </div>

        <div className="flex justify-end gap-2">
          <Boton onClick={onCerrar} disabled={guardando}>
            Cancelar
          </Boton>
          <Boton variante="primario" onClick={guardar} disabled={guardando}>
            {guardando ? "Guardando..." : "Guardar cambios"}
          </Boton>
        </div>
      </div>
    </div>
  );
}
