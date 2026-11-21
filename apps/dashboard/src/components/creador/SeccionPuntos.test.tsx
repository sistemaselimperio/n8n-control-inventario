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
  { id: "p1", nombre: "Punto Norte", codigo: "PN", activo: true, es_interna: false },
  { id: "p2", nombre: "Bodega Central", codigo: "BC", activo: true, es_interna: true },
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
