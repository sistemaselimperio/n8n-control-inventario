import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FilaTrasladoSyscafe } from "@/lib/api";

const api = vi.hoisted(() => ({ asignarSyscafeDashboard: vi.fn() }));
vi.mock("@/lib/api", () => api);
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

const fila = (p: Partial<FilaTrasladoSyscafe> = {}): FilaTrasladoSyscafe => ({
  tipo: "traslado",
  id: "t1",
  consecutivo: 12,
  numero_talonario: null,
  talonario_id: null,
  numero_syscafe: null,
  punto_origen_id: "p1",
  punto_origen_nombre: "Centro",
  tipo_traslado: "entre_puntos",
  punto_destino_id: "p2",
  punto_destino_nombre: "Norte",
  estado: "en_transito",
  fecha: "2026-10-13",
  created_at: "2026-10-13T10:00:00Z",
  motivo: null,
  anulado_por_nombre: null,
  ...p,
});

const ancla = { left: 40, top: 60, height: 30 } as DOMRect;

// ultimoPrefijo es estado del modulo: cada prueba lo reinicia importando el
// componente de nuevo.
async function montar(f: FilaTrasladoSyscafe = fila()) {
  vi.resetModules();
  const { CajaSyscafe } = await import("./CajaSyscafe");
  const onCerrar = vi.fn();
  const onGuardado = vi.fn();
  const vista = render(<CajaSyscafe fila={f} ancla={ancla} onCerrar={onCerrar} onGuardado={onGuardado} />);
  return { onCerrar, onGuardado, CajaSyscafe, ...vista };
}

beforeEach(() => {
  api.asignarSyscafeDashboard.mockReset().mockResolvedValue(undefined);
  toast.success.mockReset();
  toast.error.mockReset();
});

const prefijo = () => screen.getByLabelText("Prefijo");
const indicativo = () => screen.getByLabelText("Indicativo");

describe("CajaSyscafe: campos", () => {
  it("el prefijo acepta digitos despues de la primera letra (ej. TB9) y se escribe en mayusculas", async () => {
    await montar();
    await userEvent.type(prefijo(), "tb9");
    expect(prefijo()).toHaveValue("TB9");
  });

  it("el prefijo no puede empezar con numero, descarta simbolos y se corta en 4", async () => {
    await montar();
    await userEvent.type(prefijo(), "9a-b$c1d2");
    expect(prefijo()).toHaveValue("ABC1");
  });

  it("el indicativo solo acepta digitos y hasta 8", async () => {
    await montar();
    await userEvent.type(indicativo(), "12a3456789012");
    expect(indicativo()).toHaveValue("12345678");
  });

  it("Guardar esta deshabilitado hasta tener prefijo e indicativo", async () => {
    await montar();
    const guardar = screen.getByRole("button", { name: "Guardar número Syscafe" });
    expect(guardar).toBeDisabled();
    await userEvent.type(prefijo(), "NBR");
    expect(guardar).toBeDisabled();
    await userEvent.type(indicativo(), "945");
    expect(guardar).toBeEnabled();
  });

  it("separa un numero existente (NBR-945 y TB9-120) en prefijo e indicativo", async () => {
    const { unmount } = await montar(fila({ numero_syscafe: "NBR-945" }));
    expect(prefijo()).toHaveValue("NBR");
    expect(indicativo()).toHaveValue("945");
    unmount();
    await montar(fila({ numero_syscafe: "TB9-120" }));
    expect(prefijo()).toHaveValue("TB9");
    expect(indicativo()).toHaveValue("120");
  });

  it("con un numero existente sin cambios no se puede guardar, pero si borrar", async () => {
    await montar(fila({ numero_syscafe: "NBR-945" }));
    expect(screen.getByRole("button", { name: "Guardar número Syscafe" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Borrar número Syscafe" })).toBeEnabled();
  });

  it("sin numero guardado no hay boton de borrar", async () => {
    await montar();
    expect(screen.queryByRole("button", { name: "Borrar número Syscafe" })).toBeNull();
  });
});

describe("CajaSyscafe: guardar y borrar", () => {
  it("guarda PREFIJO-INDICATIVO, avisa y cierra", async () => {
    const { onCerrar, onGuardado } = await montar();
    await userEvent.type(prefijo(), "tb9");
    await userEvent.type(indicativo(), "120");
    await userEvent.click(screen.getByRole("button", { name: "Guardar número Syscafe" }));
    await waitFor(() => expect(onGuardado).toHaveBeenCalledOnce());
    expect(api.asignarSyscafeDashboard).toHaveBeenCalledWith("t1", "TB9-120");
    expect(toast.success).toHaveBeenCalledWith("Syscafe TB9-120 guardado en TP-000012");
    expect(onCerrar).toHaveBeenCalled();
  });

  it("Enter en un campo guarda si es valido", async () => {
    await montar();
    await userEvent.type(prefijo(), "NBR");
    await userEvent.type(indicativo(), "945{Enter}");
    await waitFor(() => expect(api.asignarSyscafeDashboard).toHaveBeenCalledWith("t1", "NBR-945"));
  });

  it("Enter con el formulario incompleto no guarda", async () => {
    await montar();
    await userEvent.type(prefijo(), "NBR{Enter}");
    expect(api.asignarSyscafeDashboard).not.toHaveBeenCalled();
  });

  it("borrar envia null", async () => {
    const { onGuardado } = await montar(fila({ numero_syscafe: "NBR-945" }));
    await userEvent.click(screen.getByRole("button", { name: "Borrar número Syscafe" }));
    await waitFor(() => expect(onGuardado).toHaveBeenCalled());
    expect(api.asignarSyscafeDashboard).toHaveBeenCalledWith("t1", null);
    expect(toast.success).toHaveBeenCalledWith("Número Syscafe borrado");
  });

  it("un error (409 de otra hoja) se muestra, no cierra y deja reintentar", async () => {
    api.asignarSyscafeDashboard.mockRejectedValue(new Error("Ya lo tiene la hoja A 12"));
    const { onCerrar, onGuardado } = await montar();
    await userEvent.type(prefijo(), "NBR");
    await userEvent.type(indicativo(), "945");
    await userEvent.click(screen.getByRole("button", { name: "Guardar número Syscafe" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Ya lo tiene la hoja A 12"));
    expect(onCerrar).not.toHaveBeenCalled();
    expect(onGuardado).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Guardar número Syscafe" })).toBeEnabled();
  });

  it("recuerda el ultimo prefijo guardado para la siguiente caja", async () => {
    const { CajaSyscafe, unmount } = await montar();
    await userEvent.type(prefijo(), "TB9");
    await userEvent.type(indicativo(), "1");
    await userEvent.click(screen.getByRole("button", { name: "Guardar número Syscafe" }));
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    unmount();
    render(<CajaSyscafe fila={fila({ id: "t2" })} ancla={ancla} onCerrar={vi.fn()} onGuardado={vi.fn()} />);
    expect(prefijo()).toHaveValue("TB9");
  });
});

describe("CajaSyscafe: cierre", () => {
  it("Escape cierra", async () => {
    const { onCerrar } = await montar();
    await userEvent.keyboard("{Escape}");
    expect(onCerrar).toHaveBeenCalled();
  });

  it("un clic afuera cierra, uno adentro no", async () => {
    const { onCerrar } = await montar();
    fireEvent.pointerDown(prefijo());
    expect(onCerrar).not.toHaveBeenCalled();
    fireEvent.pointerDown(document.body);
    expect(onCerrar).toHaveBeenCalledOnce();
  });

  it("scroll y resize cierran", async () => {
    const { onCerrar } = await montar();
    fireEvent.scroll(window);
    fireEvent(window, new Event("resize"));
    expect(onCerrar).toHaveBeenCalledTimes(2);
  });

  it("al desmontar quita los oyentes", async () => {
    const { onCerrar, unmount } = await montar();
    unmount();
    fireEvent(window, new Event("resize"));
    await userEvent.keyboard("{Escape}");
    expect(onCerrar).not.toHaveBeenCalled();
  });
});
