import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SWRConfig } from "swr";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SeccionPuntos } from "./SeccionPuntos";

const api = vi.hoisted(() => ({
  actualizarPunto: vi.fn(),
  crearPunto: vi.fn(),
  eliminarPunto: vi.fn(),
  fetchPuntosAdmin: vi.fn(),
  fetchUsuariosPuntoAdmin: vi.fn(),
  crearUsuarioPunto: vi.fn(),
  actualizarUsuarioPunto: vi.fn(),
  eliminarUsuarioPunto: vi.fn(),
  resetearPinUsuarioPunto: vi.fn(),
}));
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  ...api,
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

const puntos = [
  { id: "p1", nombre: "Punto Norte", codigo: "PN", activo: true, es_interna: false, alias: [] },
  { id: "p2", nombre: "Bodega Central", codigo: "BC", activo: true, es_interna: true, alias: ["Principal", "Bodega Matriz"] },
];

const montar = () =>
  render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <SeccionPuntos />
    </SWRConfig>,
  );

const fila = (nombre: string) => screen.getByText(nombre).closest("li") as HTMLElement;

beforeEach(() => {
  Object.values(api).forEach((f) => f.mockReset());
  api.fetchPuntosAdmin.mockResolvedValue(puntos);
  api.actualizarPunto.mockResolvedValue({});
  toast.success.mockReset();
  toast.error.mockReset();
});

describe("SeccionPuntos: punto interno", () => {
  it("muestra la insignia Interna solo en los puntos internos", async () => {
    montar();
    await screen.findByText("Punto Norte");
    expect(within(fila("Bodega Central")).getByText("Interna")).toBeInTheDocument();
    expect(within(fila("Punto Norte")).queryByText("Interna")).toBeNull();
  });

  it("el interruptor marca un punto como interno", async () => {
    montar();
    await screen.findByText("Punto Norte");
    const conmutador = within(fila("Punto Norte")).getByRole("switch", { name: /Interna/ });
    expect(conmutador).toHaveAttribute("aria-checked", "false");
    await userEvent.click(conmutador);
    await waitFor(() => expect(api.actualizarPunto).toHaveBeenCalledWith("p1", { es_interna: true }));
    expect(toast.success).toHaveBeenCalledWith("Punto marcado como interno");
  });

  it("el interruptor quita la marca de interno", async () => {
    montar();
    await screen.findByText("Bodega Central");
    await userEvent.click(within(fila("Bodega Central")).getByRole("switch", { name: /Interna/ }));
    await waitFor(() => expect(api.actualizarPunto).toHaveBeenCalledWith("p2", { es_interna: false }));
    expect(toast.success).toHaveBeenCalledWith("Punto ya no es interno");
  });

  it("el subtitulo ya no habla de bodegas del flujo de traslados", async () => {
    montar();
    await screen.findByText("Punto Norte");
    expect(screen.queryByText(/Bodegas del flujo de traslados/)).toBeNull();
  });
});

describe("SeccionPuntos: otros nombres (alias)", () => {
  it("muestra los otros nombres de forma compacta solo si el punto los tiene", async () => {
    montar();
    await screen.findByText("Punto Norte");
    expect(within(fila("Bodega Central")).getByText("Otros nombres: Principal, Bodega Matriz")).toBeInTheDocument();
    expect(within(fila("Punto Norte")).queryByText(/Otros nombres/)).toBeNull();
  });

  it("crea un punto enviando los otros nombres separados por coma", async () => {
    api.crearPunto.mockResolvedValue({ id: "p3", nombre: "Nuevo", alias: [] });
    montar();
    await screen.findByText("Punto Norte");
    await userEvent.type(screen.getByLabelText("Nombre del punto"), "  Nuevo ");
    await userEvent.type(screen.getByLabelText(/Otros nombres/), " Principal , ,Bodega Matriz ");
    await userEvent.click(screen.getByRole("button", { name: "Crear punto" }));
    await waitFor(() => expect(api.crearPunto).toHaveBeenCalledWith("Nuevo", ["Principal", "Bodega Matriz"]));
    expect(toast.success).toHaveBeenCalledWith("Punto creado");
  });

  it("crea un punto sin otros nombres con lista vacia", async () => {
    api.crearPunto.mockResolvedValue({ id: "p3", nombre: "Nuevo", alias: [] });
    montar();
    await screen.findByText("Punto Norte");
    await userEvent.type(screen.getByLabelText("Nombre del punto"), "Nuevo");
    await userEvent.click(screen.getByRole("button", { name: "Crear punto" }));
    await waitFor(() => expect(api.crearPunto).toHaveBeenCalledWith("Nuevo", []));
  });

  it("al editar precarga los otros nombres y los guarda junto al nombre", async () => {
    montar();
    await screen.findByText("Bodega Central");
    await userEvent.click(within(fila("Bodega Central")).getByRole("button", { name: "Editar" }));
    // El primero es el del formulario de alta; el de la fila en edicion va despues.
    const campo = screen.getAllByLabelText("Otros nombres (separados por coma)").at(-1) as HTMLElement;
    expect(campo).toHaveValue("Principal, Bodega Matriz");
    await userEvent.clear(campo);
    await userEvent.type(campo, "Matriz");
    await userEvent.click(screen.getByRole("button", { name: "Guardar" }));
    await waitFor(() =>
      expect(api.actualizarPunto).toHaveBeenCalledWith("p2", { nombre: "Bodega Central", alias: ["Matriz"] }),
    );
  });

  it("al editar se pueden quitar todos los otros nombres", async () => {
    montar();
    await screen.findByText("Bodega Central");
    await userEvent.click(within(fila("Bodega Central")).getByRole("button", { name: "Editar" }));
    await userEvent.clear(screen.getAllByLabelText("Otros nombres (separados por coma)").at(-1) as HTMLElement);
    await userEvent.click(screen.getByRole("button", { name: "Guardar" }));
    await waitFor(() =>
      expect(api.actualizarPunto).toHaveBeenCalledWith("p2", { nombre: "Bodega Central", alias: [] }),
    );
  });

  it("muestra el mensaje de conflicto del backend y deja la edicion abierta", async () => {
    const mensaje = "El nombre alterno «Principal» ya lo usa el punto BV — Bodega Ventas";
    api.actualizarPunto.mockRejectedValue(new Error(mensaje));
    montar();
    await screen.findByText("Bodega Central");
    await userEvent.click(within(fila("Bodega Central")).getByRole("button", { name: "Editar" }));
    await userEvent.click(screen.getByRole("button", { name: "Guardar" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(mensaje));
    expect(screen.getAllByLabelText("Otros nombres (separados por coma)").length).toBeGreaterThan(1);
  });
});
