import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Entrega } from "@/lib/api";
import { ModalEditarEntrega } from "./ModalEditarEntrega";

const api = vi.hoisted(() => ({ actualizarItems: vi.fn(), revisarEntrega: vi.fn() }));
vi.mock("@/lib/api", () => api);
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

const entrega = (p: Partial<Entrega> = {}): Entrega =>
  ({
    id: "e1",
    tipo: "FEI",
    indicativo_numero: "10254",
    items: [
      { id: "i1", descripcion: "Arroz", cantidad_entregada: 1, cantidad_pendiente: 4 },
      { id: "i2", descripcion: "Aceite", cantidad_entregada: 0, cantidad_pendiente: 2 },
    ],
    ...p,
  }) as Entrega;

function montar(e: Entrega = entrega()) {
  const onCerrar = vi.fn();
  const onGuardado = vi.fn();
  render(<ModalEditarEntrega entrega={e} onCerrar={onCerrar} onGuardado={onGuardado} />);
  return { onCerrar, onGuardado };
}

const guardar = () => userEvent.click(screen.getByRole("button", { name: "Guardar cambios" }));

beforeEach(() => {
  api.actualizarItems.mockReset().mockResolvedValue({});
  api.revisarEntrega.mockReset().mockResolvedValue({});
  toast.success.mockReset();
  toast.error.mockReset();
});

describe("ModalEditarEntrega", () => {
  it("guarda tipo y numero sin aprobar y despues los items con el nombre recortado", async () => {
    const { onGuardado } = montar();
    const tipo = screen.getByLabelText(/^Tipo/);
    await userEvent.clear(tipo);
    await userEvent.type(tipo, "tb9");
    const nombre = screen.getAllByLabelText("Nombre del producto")[0];
    await userEvent.clear(nombre);
    await userEvent.type(nombre, "  Arroz Diana ");
    await guardar();
    await waitFor(() => expect(onGuardado).toHaveBeenCalledOnce());
    expect(api.revisarEntrega).toHaveBeenCalledWith("e1", { tipo: "TB9", indicativo_numero: "10254", aprobar: false });
    expect(api.actualizarItems).toHaveBeenCalledWith("e1", [
      { id: "i1", descripcion: "Arroz Diana", cantidad_entregada: 1, cantidad_pendiente: 4 },
      { id: "i2", descripcion: "Aceite", cantidad_entregada: 0, cantidad_pendiente: 2 },
    ]);
    expect(toast.success).toHaveBeenCalledWith("Entrega actualizada");
  });

  it("exige tipo y numero de documento", async () => {
    montar();
    await userEvent.clear(screen.getByLabelText("N° de documento"));
    await guardar();
    expect(toast.error).toHaveBeenCalledWith("Tipo y N° de documento no pueden quedar vacíos");
    expect(api.revisarEntrega).not.toHaveBeenCalled();
  });

  it("no deja un producto sin nombre", async () => {
    montar();
    await userEvent.clear(screen.getAllByLabelText("Nombre del producto")[1]);
    await guardar();
    expect(toast.error).toHaveBeenCalledWith("Ningún producto puede quedar sin nombre");
    expect(api.revisarEntrega).not.toHaveBeenCalled();
  });

  it("rechaza cantidades negativas antes de llamar al backend", async () => {
    montar();
    const pendiente = screen.getAllByLabelText("Pendiente")[0];
    // fireEvent: user-event normaliza el "-" suelto de un input numerico.
    fireEvent.change(pendiente, { target: { value: "-3" } });
    await guardar();
    expect(toast.error).toHaveBeenCalledWith("Las cantidades no pueden ser negativas");
    expect(api.revisarEntrega).not.toHaveBeenCalled();
    expect(api.actualizarItems).not.toHaveBeenCalled();
  });

  it("sin productos solo corrige la cabecera", async () => {
    const { onGuardado } = montar(entrega({ items: [] }));
    expect(screen.getByText("Sin productos registrados.")).toBeInTheDocument();
    await guardar();
    await waitFor(() => expect(onGuardado).toHaveBeenCalled());
    expect(api.actualizarItems).not.toHaveBeenCalled();
  });

  it("si el backend rechaza muestra el error y no confirma", async () => {
    api.revisarEntrega.mockRejectedValue(new Error("Ya existe ese documento"));
    const { onGuardado } = montar();
    await guardar();
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Ya existe ese documento"));
    expect(onGuardado).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Guardar cambios" })).toBeEnabled();
  });

  it("mientras guarda bloquea Cancelar y el cierre por el fondo", async () => {
    let terminar: () => void = () => {};
    api.revisarEntrega.mockReturnValue(new Promise<void>((r) => (terminar = r)));
    const { onCerrar } = montar();
    await guardar();
    expect(await screen.findByRole("button", { name: "Guardando..." })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancelar" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cerrar" })).toBeDisabled();
    terminar();
    await waitFor(() => expect(api.actualizarItems).toHaveBeenCalled());
    expect(onCerrar).not.toHaveBeenCalled();
  });

  it("Cancelar cierra sin guardar", async () => {
    const { onCerrar } = montar();
    await userEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(onCerrar).toHaveBeenCalledOnce();
    expect(api.revisarEntrega).not.toHaveBeenCalled();
  });
});
