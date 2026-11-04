import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SWRConfig } from "swr";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FilaTrasladoSyscafe } from "@/lib/api";
import PuntosPage from "./page";

const api = vi.hoisted(() => ({ fetchPuntosPublicos: vi.fn(), listarTrasladosSyscafe: vi.fn() }));
vi.mock("@/lib/api", () => api);

const hoy = new Date();
const fecha = `${hoy.getFullYear()}-${String(hoy.getMonth() + 1).padStart(2, "0")}-02`;
const fila = (p: Partial<FilaTrasladoSyscafe>): FilaTrasladoSyscafe => ({
  tipo: "traslado",
  id: "t1",
  consecutivo: 1,
  numero_talonario: null,
  talonario_id: null,
  numero_syscafe: null,
  punto_origen_id: "p1",
  punto_origen_nombre: "Centro",
  tipo_traslado: "entre_puntos",
  punto_destino_id: "p2",
  punto_destino_nombre: "Norte",
  estado: "en_transito",
  fecha,
  created_at: `${fecha}T10:00:00Z`,
  motivo: null,
  anulado_por_nombre: null,
  ...p,
});

const montar = () =>
  render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <PuntosPage />
    </SWRConfig>,
  );

beforeEach(() => {
  Object.values(api).forEach((fn) => fn.mockReset());
  api.fetchPuntosPublicos.mockResolvedValue([
    { id: "p1", nombre: "Centro", codigo: "CEN" },
    { id: "p2", nombre: "Norte", codigo: null },
  ]);
  api.listarTrasladosSyscafe.mockResolvedValue([fila({ id: "a" }), fila({ id: "b", numero_syscafe: "NBR-1" })]);
});

describe("lista de puntos", () => {
  it("muestra una tarjeta por punto con enlace a su detalle y un resumen", async () => {
    montar();
    const centro = await screen.findByRole("link", { name: /Centro/ });
    expect(centro).toHaveAttribute("href", "/puntos/p1");
    const norte = screen.getByRole("link", { name: /Norte/ });
    expect(norte).toHaveAttribute("href", "/puntos/p2");
    expect(within(centro).getByText("CEN")).toBeInTheDocument();
    // Centro envio 2 traslados este mes (1 sin Syscafe); Norte los recibe (2 en transito).
    expect(within(centro).getByText("Del mes").parentElement).toHaveTextContent("2");
    expect(within(centro).getByText("Sin número de traslado").parentElement).toHaveTextContent("1");
    expect(within(norte).getByText("Por recibir").parentElement).toHaveTextContent("2");
  });

  it("busca por nombre o codigo", async () => {
    montar();
    await screen.findByRole("link", { name: /Centro/ });
    await userEvent.type(screen.getByLabelText("Buscar punto"), "nor");
    expect(screen.queryByRole("link", { name: /Centro/ })).toBeNull();
    expect(screen.getByRole("link", { name: /Norte/ })).toBeInTheDocument();
  });

  it("sin puntos muestra un estado vacio", async () => {
    api.fetchPuntosPublicos.mockResolvedValue([]);
    montar();
    expect(await screen.findByText("No hay puntos para mostrar.")).toBeInTheDocument();
  });

  it("si el resumen falla igual lista los puntos", async () => {
    api.listarTrasladosSyscafe.mockRejectedValue(new Error("boom"));
    montar();
    expect(await screen.findByRole("link", { name: /Centro/ })).toBeInTheDocument();
  });
});
