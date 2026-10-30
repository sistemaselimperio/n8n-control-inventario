import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Entrega } from "@/lib/api";
import { FilaRevision } from "./FilaRevision";

const api = vi.hoisted(() => ({
  actualizarItems: vi.fn(),
  eliminarEntrega: vi.fn(),
  fetchHistorialEntrega: vi.fn(),
  revisarEntrega: vi.fn(),
}));
vi.mock("@/lib/api", () => api);

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

const sesion = vi.hoisted(() => ({ esAdmin: true, puedeEditar: true }));
vi.mock("@/lib/SesionProvider", () => ({ useSesion: () => sesion }));

const entregaBase = (p: Partial<Entrega> = {}): Entrega => ({
  id: "e1",
  tipo: "FEI",
  indicativo_numero: "10254",
  sede_origen_id: "s1",
  sede_origen_nombre: "Sede Centro",
  items: [
    { id: "i1", descripcion: "Arroz", cantidad_entregada: 0, cantidad_pendiente: 5 },
    { id: "i2", descripcion: "Aceite", cantidad_entregada: 1, cantidad_pendiente: 2 },
  ],
  estado: "pendiente_revision",
  operador_id: "op1",
  operador_nombre: null,
  operador_rol: null,
  bodeguero_id: null,
  bodeguero_nombre: null,
  confianza_ia: { tipo: 0.4, indicativo_numero: 0.9 },
  evidencia_url: "https://fotos.test/e1.jpg",
  evidencia_creacion_url: null,
  traslado_tipo: null,
  traslado_indicativo_numero: null,
  capturado_at: "2026-10-01T12:00:00Z",
  nota_general: null,
  ...p,
});

const sedes = [
  { id: "s1", nombre: "Sede Centro" },
  { id: "s2", nombre: "Polo Sur" },
];

function montar(entrega: Entrega = entregaBase(), onGuardado = vi.fn()) {
  render(
    <table>
      <tbody>
        <FilaRevision entrega={entrega} sedes={sedes} onGuardado={onGuardado} />
      </tbody>
    </table>,
  );
  return onGuardado;
}

beforeEach(() => {
  Object.values(api).forEach((f) => f.mockReset());
  api.revisarEntrega.mockResolvedValue({});
  api.actualizarItems.mockResolvedValue({ id: "e1", items: [] });
  api.eliminarEntrega.mockResolvedValue(undefined);
  api.fetchHistorialEntrega.mockResolvedValue([]);
  toast.success.mockReset();
  toast.error.mockReset();
  sesion.esAdmin = true;
  sesion.puedeEditar = true;
});

describe("FilaRevision: guardar y aprobar", () => {
  it("lista los campos de baja confianza y el enlace a la foto", () => {
    montar();
    expect(screen.getByText("tipo")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Ver foto original/ })).toHaveAttribute("href", "https://fotos.test/e1.jpg");
  });

  it("Aprobar envia la cabecera ampliada y despues los items", async () => {
    const onGuardado = montar();
    await userEvent.clear(screen.getByLabelText("N° de documento"));
    await userEvent.type(screen.getByLabelText("N° de documento"), "99999");
    await userEvent.click(screen.getByRole("button", { name: "Aprobar" }));

    await waitFor(() => expect(onGuardado).toHaveBeenCalledOnce());
    expect(api.revisarEntrega).toHaveBeenCalledWith(
      "e1",
      expect.objectContaining({
        tipo: "FEI",
        indicativo_numero: "99999",
        aprobar: true,
        sede_origen_id: "s1",
        operador_id: "op1",
        capturado_at: "2026-10-01T12:00:00.000Z",
      }),
    );
    // Los traslado_* vacios no se mandan.
    const campos = api.revisarEntrega.mock.calls[0][1];
    expect(campos.traslado_tipo).toBeUndefined();
    expect(campos.traslado_indicativo_numero).toBeUndefined();
    expect(api.actualizarItems).toHaveBeenCalledWith(
      "e1",
      [
        { id: "i1", descripcion: "Arroz", cantidad_entregada: 0, cantidad_pendiente: 5 },
        { id: "i2", descripcion: "Aceite", cantidad_entregada: 1, cantidad_pendiente: 2 },
      ],
      undefined,
    );
    expect(toast.success).toHaveBeenCalledWith("Entrega aprobada");
  });

  it("el tipo se escribe en mayusculas y acepta cualquier valor (ej. TB9)", async () => {
    montar();
    const tipo = screen.getByLabelText(/^Tipo/);
    await userEvent.clear(tipo);
    await userEvent.type(tipo, "tb9");
    expect(tipo).toHaveValue("TB9");
    await userEvent.click(screen.getByRole("button", { name: "Guardar" }));
    await waitFor(() => expect(api.revisarEntrega).toHaveBeenCalled());
    expect(api.revisarEntrega.mock.calls[0][1].tipo).toBe("TB9");
  });

  it("corregir una cantidad pendiente viaja en actualizarItems", async () => {
    montar();
    const pendiente = screen.getAllByLabelText("Pendiente")[0];
    await userEvent.clear(pendiente);
    await userEvent.type(pendiente, "3");
    await userEvent.click(screen.getByRole("button", { name: "Guardar" }));
    await waitFor(() => expect(api.actualizarItems).toHaveBeenCalled());
    expect(api.actualizarItems.mock.calls[0][1][0]).toEqual({
      id: "i1",
      descripcion: "Arroz",
      cantidad_entregada: 0,
      cantidad_pendiente: 3,
    });
    expect(toast.success).toHaveBeenCalledWith("Entrega guardada");
  });

  it("en una entrega ya procesada solo guarda (aprobar=false) y no manda la cabecera ampliada", async () => {
    montar(entregaBase({ estado: "procesada" }));
    expect(screen.queryByRole("button", { name: "Aprobar" })).toBeNull();
    expect(screen.queryByLabelText("Sede origen")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Guardar" }));
    await waitFor(() => expect(api.revisarEntrega).toHaveBeenCalled());
    expect(api.revisarEntrega.mock.calls[0][1]).toEqual({ tipo: "FEI", indicativo_numero: "10254", aprobar: false });
  });

  it("si solo cambia la nota general igual llama a actualizarItems con la nota", async () => {
    montar(entregaBase({ items: [], estado: "procesada" }));
    await userEvent.type(screen.getByLabelText("Nota general de la factura"), "Entregar en la tarde");
    await userEvent.click(screen.getByRole("button", { name: "Guardar" }));
    await waitFor(() => expect(api.actualizarItems).toHaveBeenCalledWith("e1", [], "Entregar en la tarde"));
  });

  it("sin items ni nota nueva no llama a actualizarItems", async () => {
    montar(entregaBase({ items: [], estado: "procesada" }));
    await userEvent.click(screen.getByRole("button", { name: "Guardar" }));
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    expect(api.actualizarItems).not.toHaveBeenCalled();
    expect(screen.getByText("Sin productos registrados.")).toBeInTheDocument();
  });

  it("si revisarEntrega falla muestra el error y no toca los items ni recarga", async () => {
    api.revisarEntrega.mockRejectedValue(new Error("Ya existe ese documento"));
    const onGuardado = montar();
    await userEvent.click(screen.getByRole("button", { name: "Aprobar" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Ya existe ese documento"));
    expect(api.actualizarItems).not.toHaveBeenCalled();
    expect(onGuardado).not.toHaveBeenCalled();
    // El boton vuelve a quedar usable.
    expect(screen.getByRole("button", { name: "Aprobar" })).toBeEnabled();
  });

  it("si falla actualizarItems tampoco se confirma el guardado", async () => {
    api.actualizarItems.mockRejectedValue(new Error("Cantidad negativa"));
    const onGuardado = montar();
    await userEvent.click(screen.getByRole("button", { name: "Guardar" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Cantidad negativa"));
    expect(onGuardado).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("un error que no es Error muestra el mensaje generico", async () => {
    api.revisarEntrega.mockRejectedValue("boom");
    montar();
    await userEvent.click(screen.getByRole("button", { name: "Guardar" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Error al guardar"));
  });
});

describe("FilaRevision: permisos por rol", () => {
  it("consulta: todo deshabilitado y sin botones de accion", () => {
    sesion.esAdmin = false;
    sesion.puedeEditar = false;
    montar();
    expect(screen.getByLabelText("N° de documento")).toBeDisabled();
    expect(screen.getByLabelText("Nota general de la factura")).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Guardar" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Aprobar" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Cancelar" })).toBeNull();
    expect(screen.getByText(/Tu rol es de consulta/)).toBeInTheDocument();
  });

  it("supervisor: edita y aprueba pero no puede cancelar el pedido", () => {
    sesion.esAdmin = false;
    montar();
    expect(screen.getByRole("button", { name: "Aprobar" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Cancelar" })).toBeNull();
  });

  it("sin pendiente en ningun producto, el supervisor no edita nombre ni entregado pero el admin si", () => {
    const sinPendiente = entregaBase({
      estado: "procesada",
      items: [{ id: "i1", descripcion: "Arroz", cantidad_entregada: 5, cantidad_pendiente: 0 }],
    });
    sesion.esAdmin = false;
    const { unmount } = render(
      <table>
        <tbody>
          <FilaRevision entrega={sinPendiente} sedes={sedes} onGuardado={vi.fn()} />
        </tbody>
      </table>,
    );
    expect(screen.getByLabelText("Descripción")).toBeDisabled();
    expect(screen.getByLabelText("Entregado")).toBeDisabled();
    // La pendiente siempre se puede corregir para deshacer un 0 por error.
    expect(screen.getByLabelText("Pendiente")).toBeEnabled();
    expect(screen.getByText(/Sin pendiente en ningún producto/)).toBeInTheDocument();
    unmount();

    sesion.esAdmin = true;
    montar(sinPendiente);
    expect(screen.getByLabelText("Descripción")).toBeEnabled();
    expect(screen.getByLabelText("Entregado")).toBeEnabled();
  });
});

describe("FilaRevision: cancelar pedido (borrado definitivo)", () => {
  it("el admin confirma en el modal y se elimina", async () => {
    const onGuardado = montar();
    await userEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(screen.getByText("Cancelar pedido", { selector: "h3" })).toBeInTheDocument();
    expect(api.eliminarEntrega).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Cancelar pedido" }));
    await waitFor(() => expect(api.eliminarEntrega).toHaveBeenCalledWith("e1"));
    expect(toast.success).toHaveBeenCalledWith("Pedido cancelado");
    expect(onGuardado).toHaveBeenCalledOnce();
  });

  it("cerrar el modal no elimina nada", async () => {
    montar();
    await userEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    const modal = screen.getByText("Cancelar pedido", { selector: "h3" }).parentElement as HTMLElement;
    await userEvent.click(within(modal).getByRole("button", { name: "Cancelar" }));
    expect(screen.queryByText("Cancelar pedido", { selector: "h3" })).toBeNull();
    expect(api.eliminarEntrega).not.toHaveBeenCalled();
  });

  it("si el backend rechaza (409/403) muestra el error y no recarga", async () => {
    api.eliminarEntrega.mockRejectedValue(new Error("La entrega ya esta completada"));
    const onGuardado = montar();
    await userEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    await userEvent.click(screen.getByRole("button", { name: "Cancelar pedido" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("La entrega ya esta completada"));
    expect(onGuardado).not.toHaveBeenCalled();
  });

  it("una entrega procesada y completa no ofrece cancelar", () => {
    montar(
      entregaBase({
        estado: "procesada",
        items: [{ id: "i1", descripcion: "Arroz", cantidad_entregada: 5, cantidad_pendiente: 0 }],
      }),
    );
    expect(screen.queryByRole("button", { name: "Cancelar" })).toBeNull();
  });
});

describe("FilaRevision: historial por producto", () => {
  const logs = [
    {
      id: "l1",
      evento: "entrega_actualizada",
      entidad_tipo: "entrega",
      entidad_id: "e1",
      actor_id: "op1",
      sede_id: "s1",
      resultado: "ok",
      timestamp: "2026-10-01T10:00:00Z",
      detalle: { items: [{ id: "i1", cantidad_entregada: 2, cantidad_pendiente: 3 }] },
    },
  ];

  it("pide el historial una sola vez y muestra solo los eventos del producto", async () => {
    api.fetchHistorialEntrega.mockResolvedValue(logs);
    montar();
    const botones = screen.getAllByRole("button", { name: /Ver historial/ });
    await userEvent.click(botones[0]);
    expect(await screen.findByText("Entregado 2, pendiente 3")).toBeInTheDocument();
    // El segundo producto reutiliza el mismo fetch y no tiene eventos propios.
    await userEvent.click(screen.getAllByRole("button", { name: /Ver historial/ })[0]);
    expect(await screen.findByText("Sin cambios registrados todavía.")).toBeInTheDocument();
    expect(api.fetchHistorialEntrega).toHaveBeenCalledTimes(1);
    expect(api.fetchHistorialEntrega).toHaveBeenCalledWith("e1");
  });

  it("alternar oculta el historial abierto", async () => {
    api.fetchHistorialEntrega.mockResolvedValue(logs);
    montar();
    await userEvent.click(screen.getAllByRole("button", { name: /Ver historial/ })[0]);
    await screen.findByText("Entregado 2, pendiente 3");
    await userEvent.click(screen.getByRole("button", { name: /Ocultar historial/ }));
    expect(screen.queryByText("Entregado 2, pendiente 3")).toBeNull();
  });

  it("si la consulta falla muestra el estado vacio en vez de romper", async () => {
    api.fetchHistorialEntrega.mockRejectedValue(new Error("red"));
    montar();
    await userEvent.click(screen.getAllByRole("button", { name: /Ver historial/ })[0]);
    expect(await screen.findByText("Sin cambios registrados todavía.")).toBeInTheDocument();
  });
});
