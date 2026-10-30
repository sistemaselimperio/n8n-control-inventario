import type { ComponentProps } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorAdmin } from "@/lib/api";
import { AccionEliminar, CambiarPin, PIN_VALIDO, ejecutar, etiquetaRol } from "./compartido";

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

beforeEach(() => {
  toast.success.mockReset();
  toast.error.mockReset();
});

describe("PIN_VALIDO y etiquetaRol", () => {
  it.each([
    ["1234", true],
    ["123456", true],
    ["123", false],
    ["1234567", false],
    ["12a4", false],
    ["", false],
    ["1234\n", false],
  ])("PIN_VALIDO(%j) = %s", (pin, esperado) => {
    expect(PIN_VALIDO.test(pin)).toBe(esperado);
  });

  it("etiquetaRol traduce roles conocidos y deja pasar los demas", () => {
    expect(etiquetaRol("operador")).toBe("Bodeguero");
    expect(etiquetaRol("faia_viewer")).toBe("Visor FAIA");
    expect(etiquetaRol("desconocido")).toBe("desconocido");
  });
});

describe("ejecutar", () => {
  it("avisa el exito y devuelve true", async () => {
    await expect(ejecutar(async () => {}, "Hecho")).resolves.toBe(true);
    expect(toast.success).toHaveBeenCalledWith("Hecho");
  });

  it("avisa el error y devuelve false", async () => {
    await expect(ejecutar(async () => Promise.reject(new Error("fallo")), "Hecho")).resolves.toBe(false);
    expect(toast.error).toHaveBeenCalledWith("fallo");
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("un error que no es Error usa el mensaje generico", async () => {
    await ejecutar(async () => Promise.reject("x"), "Hecho");
    expect(toast.error).toHaveBeenCalledWith("La operación falló");
  });
});

describe("CambiarPin", () => {
  const abrir = async () => userEvent.click(screen.getByRole("button", { name: "Cambiar PIN" }));

  it("el campo es de tipo password y descarta lo que no sea digito", async () => {
    render(<CambiarPin onGuardar={vi.fn()} />);
    await abrir();
    const campo = screen.getByLabelText("Nuevo PIN");
    expect(campo).toHaveAttribute("type", "password");
    await userEvent.type(campo, "12ab34");
    expect(campo).toHaveValue("1234");
  });

  it("Guardar exige entre 4 y 6 digitos", async () => {
    render(<CambiarPin onGuardar={vi.fn()} />);
    await abrir();
    const guardar = screen.getByRole("button", { name: "Guardar" });
    await userEvent.type(screen.getByLabelText("Nuevo PIN"), "123");
    expect(guardar).toBeDisabled();
    await userEvent.type(screen.getByLabelText("Nuevo PIN"), "4");
    expect(guardar).toBeEnabled();
  });

  it("guarda, avisa sin incluir el PIN y vuelve al boton inicial", async () => {
    const onGuardar = vi.fn().mockResolvedValue(undefined);
    render(<CambiarPin onGuardar={onGuardar} />);
    await abrir();
    await userEvent.type(screen.getByLabelText("Nuevo PIN"), "4321");
    await userEvent.click(screen.getByRole("button", { name: "Guardar" }));
    await waitFor(() => expect(onGuardar).toHaveBeenCalledWith("4321"));
    expect(toast.success).toHaveBeenCalledWith("PIN actualizado");
    expect(JSON.stringify(toast.success.mock.calls)).not.toContain("4321");
    expect(await screen.findByRole("button", { name: "Cambiar PIN" })).toBeInTheDocument();
    // El PIN no queda en el DOM al reabrir.
    await abrir();
    expect(screen.getByLabelText("Nuevo PIN")).toHaveValue("");
  });

  it("Enter guarda cuando el PIN es valido", async () => {
    const onGuardar = vi.fn().mockResolvedValue(undefined);
    render(<CambiarPin onGuardar={onGuardar} />);
    await abrir();
    await userEvent.type(screen.getByLabelText("Nuevo PIN"), "1234{Enter}");
    await waitFor(() => expect(onGuardar).toHaveBeenCalledWith("1234"));
  });

  it("si falla se queda abierto con el error en un toast, sin filtrar el PIN", async () => {
    const onGuardar = vi.fn().mockRejectedValue(new Error("PIN demasiado simple"));
    render(<CambiarPin onGuardar={onGuardar} />);
    await abrir();
    await userEvent.type(screen.getByLabelText("Nuevo PIN"), "1111");
    await userEvent.click(screen.getByRole("button", { name: "Guardar" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("PIN demasiado simple"));
    expect(screen.getByLabelText("Nuevo PIN")).toBeInTheDocument();
    expect(JSON.stringify(toast.error.mock.calls)).not.toContain("1111");
  });

  it("Cancelar cierra y descarta el PIN escrito", async () => {
    render(<CambiarPin onGuardar={vi.fn()} />);
    await abrir();
    await userEvent.type(screen.getByLabelText("Nuevo PIN"), "9999");
    await userEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    await abrir();
    expect(screen.getByLabelText("Nuevo PIN")).toHaveValue("");
  });
});

describe("AccionEliminar", () => {
  function montar(props: Partial<ComponentProps<typeof AccionEliminar>> = {}) {
    const onHecho = vi.fn();
    const onEliminar = vi.fn().mockResolvedValue(undefined);
    render(
      <AccionEliminar
        nombre="Sede Norte"
        exito="Sede eliminada"
        onEliminar={onEliminar}
        onHecho={onHecho}
        {...props}
      />,
    );
    return { onHecho, onEliminar };
  }
  const abrir = () => userEvent.click(screen.getByRole("button", { name: "Eliminar" }));
  const confirmar = () => userEvent.click(botonDelDialogo("Eliminar"));
  function botonDelDialogo(nombre: string) {
    const dialogo = screen.getByRole("dialog");
    return Array.from(dialogo.querySelectorAll("button")).find((b) => b.textContent?.startsWith(nombre)) as HTMLElement;
  }

  it("pide confirmacion con el nombre antes de borrar", async () => {
    const { onEliminar } = montar();
    await abrir();
    expect(screen.getByRole("dialog", { name: "¿Eliminar Sede Norte?" })).toBeInTheDocument();
    expect(onEliminar).not.toHaveBeenCalled();
  });

  it("elimina, avisa, cierra y revalida", async () => {
    const { onEliminar, onHecho } = montar();
    await abrir();
    await confirmar();
    await waitFor(() => expect(onHecho).toHaveBeenCalledOnce());
    expect(onEliminar).toHaveBeenCalledOnce();
    expect(toast.success).toHaveBeenCalledWith("Sede eliminada");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("Cancelar y Escape cierran sin borrar", async () => {
    const { onEliminar } = montar();
    await abrir();
    await userEvent.click(botonDelDialogo("Cancelar"));
    expect(screen.queryByRole("dialog")).toBeNull();
    await abrir();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(onEliminar).not.toHaveBeenCalled();
  });

  it("un 409 con historial ofrece Desactivar en vez de Eliminar", async () => {
    const onDesactivar = vi.fn().mockResolvedValue(undefined);
    const { onHecho } = montar({
      onEliminar: vi.fn().mockRejectedValue(new ErrorAdmin("Tiene historial: no se puede borrar", 409)),
      onDesactivar,
      exitoDesactivar: "Sede desactivada",
    });
    await abrir();
    await confirmar();
    expect(await screen.findByRole("alert")).toHaveTextContent("Tiene historial");
    expect(botonDelDialogo("Eliminar")).toBeUndefined();
    await userEvent.click(botonDelDialogo("Desactivar"));
    await waitFor(() => expect(onDesactivar).toHaveBeenCalledOnce());
    expect(toast.success).toHaveBeenCalledWith("Sede desactivada");
    expect(onHecho).toHaveBeenCalledOnce();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("un error distinto de 409 deja ofrecer Eliminar de nuevo", async () => {
    montar({
      onEliminar: vi.fn().mockRejectedValue(new ErrorAdmin("Sin permiso", 403)),
      onDesactivar: vi.fn(),
    });
    await abrir();
    await confirmar();
    expect(await screen.findByRole("alert")).toHaveTextContent("Sin permiso");
    expect(botonDelDialogo("Eliminar")).toBeDefined();
    expect(botonDelDialogo("Desactivar")).toBeUndefined();
  });

  it("un 409 sin onDesactivar (registro ya inactivo) no ofrece ninguna salida de borrado", async () => {
    montar({ onEliminar: vi.fn().mockRejectedValue(new ErrorAdmin("Tiene historial", 409)) });
    await abrir();
    await confirmar();
    await screen.findByRole("alert");
    expect(botonDelDialogo("Eliminar")).toBeUndefined();
    expect(botonDelDialogo("Desactivar")).toBeUndefined();
  });

  it("deshabilitado no abre el modal", async () => {
    montar({ deshabilitado: true, titulo: "Tiene sedes" });
    expect(screen.getByRole("button", { name: "Eliminar" })).toBeDisabled();
  });
});
