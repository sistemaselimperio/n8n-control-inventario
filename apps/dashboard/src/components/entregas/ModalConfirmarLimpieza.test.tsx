import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ModalConfirmarLimpieza } from "./ModalConfirmarLimpieza";

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

beforeEach(() => {
  toast.error.mockReset();
});

function montar(onConfirmar = vi.fn().mockResolvedValue(undefined)) {
  const onCerrar = vi.fn();
  render(<ModalConfirmarLimpieza onConfirmar={onConfirmar} onCerrar={onCerrar} />);
  return { onConfirmar, onCerrar };
}

const boton = () => screen.getByRole("button", { name: "Eliminar todo" });
const campo = () => screen.getByLabelText(/Escribe/);

describe("ModalConfirmarLimpieza (zona de peligro)", () => {
  it("el boton esta deshabilitado hasta escribir la palabra exacta", async () => {
    montar();
    expect(boton()).toBeDisabled();
    await userEvent.type(campo(), "eliminar todo");
    expect(boton()).toBeDisabled();
    await userEvent.clear(campo());
    await userEvent.type(campo(), "ELIMINAR");
    expect(boton()).toBeDisabled();
    await userEvent.clear(campo());
    await userEvent.type(campo(), "ELIMINAR TODO");
    expect(boton()).toBeEnabled();
  });

  it("tolera espacios alrededor de la palabra", async () => {
    montar();
    await userEvent.type(campo(), "  ELIMINAR TODO  ");
    expect(boton()).toBeEnabled();
  });

  it("confirma una sola vez con la palabra correcta", async () => {
    const { onConfirmar } = montar();
    await userEvent.type(campo(), "ELIMINAR TODO");
    await userEvent.click(boton());
    expect(onConfirmar).toHaveBeenCalledOnce();
  });

  it("mientras elimina bloquea el boton y el campo", async () => {
    let terminar: () => void = () => {};
    const { onConfirmar } = montar(vi.fn(() => new Promise<void>((r) => (terminar = r))));
    await userEvent.type(campo(), "ELIMINAR TODO");
    await userEvent.click(boton());
    expect(await screen.findByRole("button", { name: "Eliminando..." })).toBeDisabled();
    expect(campo()).toBeDisabled();
    expect(onConfirmar).toHaveBeenCalledOnce();
    terminar();
  });

  it("si falla muestra el error dentro del modal y en un toast, y deja reintentar", async () => {
    const { onConfirmar } = montar(vi.fn().mockRejectedValue(new Error("No autorizado")));
    await userEvent.type(campo(), "ELIMINAR TODO");
    await userEvent.click(boton());
    expect(await screen.findByText("No autorizado")).toBeInTheDocument();
    expect(toast.error).toHaveBeenCalledWith("No autorizado");
    await waitFor(() => expect(boton()).toBeEnabled());
    await userEvent.click(boton());
    expect(onConfirmar).toHaveBeenCalledTimes(2);
  });

  it("Cancelar y el clic en el fondo cierran; el clic dentro de la tarjeta no", async () => {
    const { onCerrar } = montar();
    await userEvent.click(screen.getByText(/Esto borra permanentemente/));
    expect(onCerrar).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(onCerrar).toHaveBeenCalledOnce();
  });
});
