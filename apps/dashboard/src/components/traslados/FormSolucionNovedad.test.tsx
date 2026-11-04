import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SWRConfig } from "swr";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ fetchPuntosPublicos: vi.fn(), resolverNovedadDashboard: vi.fn() }));
vi.mock("@/lib/api", () => api);
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

import { FormSolucionNovedad } from "./FormSolucionNovedad";

const montar = (onResuelta = vi.fn()) => {
  render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <FormSolucionNovedad trasladoId="t1" puntoDestinoId="p2" onResuelta={onResuelta} />
    </SWRConfig>,
  );
  return onResuelta;
};

beforeEach(() => {
  Object.values(api).forEach((f) => f.mockReset());
  toast.success.mockReset();
  api.fetchPuntosPublicos.mockResolvedValue([
    { id: "p1", nombre: "Centro", codigo: "CFC" },
    { id: "p2", nombre: "Bodega", codigo: "BDG" },
  ]);
  api.resolverNovedadDashboard.mockResolvedValue({});
});

describe("FormSolucionNovedad", () => {
  it("precarga el codigo del punto destino y permite editarlo", async () => {
    montar();
    const codigo = screen.getByLabelText("Código del consecutivo");
    await waitFor(() => expect(codigo).toHaveValue("BDG"));
    await userEvent.clear(codigo);
    await userEvent.type(codigo, "npt");
    expect(codigo).toHaveValue("NPT");
  });

  it("el numero solo admite digitos y el boton espera todos los campos", async () => {
    montar();
    await waitFor(() => expect(screen.getByLabelText("Código del consecutivo")).toHaveValue("BDG"));
    const boton = screen.getByRole("button", { name: "Marcar como resuelta" });
    expect(boton).toBeDisabled();
    await userEvent.type(screen.getByLabelText("Número del consecutivo"), "12a3");
    expect(screen.getByLabelText("Número del consecutivo")).toHaveValue("123");
    expect(boton).toBeDisabled(); // falta la solucion
    await userEvent.type(screen.getByLabelText("Solución"), "Se repuso");
    expect(boton).toBeEnabled();
  });

  it("envia la solucion y avisa para refrescar", async () => {
    const onResuelta = montar();
    await waitFor(() => expect(screen.getByLabelText("Código del consecutivo")).toHaveValue("BDG"));
    await userEvent.type(screen.getByLabelText("Solución"), "  Se repuso  ");
    await userEvent.type(screen.getByLabelText("Número del consecutivo"), "0012");
    await userEvent.click(screen.getByRole("button", { name: "Marcar como resuelta" }));
    await waitFor(() =>
      expect(api.resolverNovedadDashboard).toHaveBeenCalledWith("t1", {
        solucion: "Se repuso",
        consecutivo_codigo: "BDG",
        consecutivo_numero: "0012",
      }),
    );
    await waitFor(() => expect(onResuelta).toHaveBeenCalled());
    expect(toast.success).toHaveBeenCalledWith("Novedad resuelta");
  });

  it("muestra el error del backend y no refresca", async () => {
    api.resolverNovedadDashboard.mockRejectedValue(new Error("Ese consecutivo ya está registrado"));
    const onResuelta = montar();
    await waitFor(() => expect(screen.getByLabelText("Código del consecutivo")).toHaveValue("BDG"));
    await userEvent.type(screen.getByLabelText("Solución"), "x");
    await userEvent.type(screen.getByLabelText("Número del consecutivo"), "1");
    await userEvent.click(screen.getByRole("button", { name: "Marcar como resuelta" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Ese consecutivo ya está registrado");
    expect(onResuelta).not.toHaveBeenCalled();
  });
});
