import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SWRConfig } from "swr";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SeccionEmpleados } from "./SeccionEmpleados";

const api = vi.hoisted(() => ({
  actualizarEmpleado: vi.fn(),
  crearEmpleado: vi.fn(),
  eliminarEmpleado: vi.fn(),
  fetchEmpleadosAdmin: vi.fn(),
  fetchSedesAdmin: vi.fn(),
  resetearPinEmpleado: vi.fn(),
}));
vi.mock("@/lib/api", async (importOriginal) => ({
  // ErrorAdmin real: AccionEliminar distingue el 409 con instanceof.
  ...(await importOriginal<typeof import("@/lib/api")>()),
  ...api,
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

const sedes = [
  { id: "s1", nombre: "Centro", codigo: "C", direccion: "", timezone: "America/Bogota", activa: true },
  { id: "s2", nombre: "Cerrada", codigo: "X", direccion: "", timezone: "America/Bogota", activa: false },
];
const empleados = [
  { id: "e1", nombre: "Luis Perez", sede_id: "s1", rol: "operador", estado: "activo" },
  { id: "e2", nombre: "Marta Gil", sede_id: "s1", rol: "supervisor", estado: "inactivo" },
];

const montar = () =>
  render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <SeccionEmpleados />
    </SWRConfig>,
  );

beforeEach(() => {
  Object.values(api).forEach((f) => f.mockReset());
  api.fetchEmpleadosAdmin.mockResolvedValue(empleados);
  api.fetchSedesAdmin.mockResolvedValue(sedes);
  api.crearEmpleado.mockResolvedValue({});
  api.actualizarEmpleado.mockResolvedValue({});
  api.resetearPinEmpleado.mockResolvedValue({ ok: true });
  api.eliminarEmpleado.mockResolvedValue({ ok: true });
  toast.success.mockReset();
  toast.error.mockReset();
});

const fila = (nombre: string) => screen.getByText(nombre).closest("li") as HTMLElement;

describe("SeccionEmpleados: listado", () => {
  it("muestra cargando y luego los empleados con sede, rol y estado", async () => {
    montar();
    expect(screen.getByText("Cargando…")).toBeInTheDocument();
    expect(await screen.findByText("Luis Perez")).toBeInTheDocument();
    expect(within(fila("Luis Perez")).getByText(/Centro, Bodeguero/)).toBeInTheDocument();
    expect(within(fila("Luis Perez")).getByText("Activo")).toBeInTheDocument();
    expect(within(fila("Marta Gil")).getByText("Inactivo")).toBeInTheDocument();
    expect(within(fila("Marta Gil")).getByRole("button", { name: "Activar" })).toBeInTheDocument();
  });

  it("estado vacio cuando no hay empleados", async () => {
    api.fetchEmpleadosAdmin.mockResolvedValue([]);
    montar();
    expect(await screen.findByText("Todavía no hay registros.")).toBeInTheDocument();
  });

  it("si la carga falla muestra el error con Reintentar", async () => {
    api.fetchEmpleadosAdmin.mockRejectedValueOnce(new Error("Sin sesion")).mockResolvedValue(empleados);
    montar();
    expect(await screen.findByRole("alert")).toHaveTextContent("Sin sesion");
    expect(screen.queryByText("Cargando…")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Reintentar" }));
    expect(await screen.findByText("Luis Perez")).toBeInTheDocument();
  });
});

describe("SeccionEmpleados: crear", () => {
  async function llenar(pin = "1234") {
    await screen.findByText("Luis Perez");
    await userEvent.type(screen.getByLabelText("Nombre"), "  Ana Ruiz ");
    await userEvent.selectOptions(screen.getByLabelText("Sede"), "s1");
    await userEvent.selectOptions(screen.getByLabelText("Rol"), "punto_venta");
    if (pin) await userEvent.type(screen.getByLabelText(/PIN/), pin);
  }

  it("solo ofrece sedes activas y el boton exige nombre, sede y PIN de 4 a 6 digitos", async () => {
    montar();
    await screen.findByText("Luis Perez");
    const sede = screen.getByLabelText("Sede");
    expect(within(sede).queryByText("Cerrada")).toBeNull();
    const crear = screen.getByRole("button", { name: "Crear empleado" });
    expect(crear).toBeDisabled();
    await llenar("123");
    expect(crear).toBeDisabled();
    await userEvent.type(screen.getByLabelText(/PIN/), "4");
    expect(crear).toBeEnabled();
  });

  it("el PIN es un campo password y solo acepta digitos", async () => {
    montar();
    await screen.findByText("Luis Perez");
    const pin = screen.getByLabelText(/PIN/);
    expect(pin).toHaveAttribute("type", "password");
    await userEvent.type(pin, "1a2b");
    expect(pin).toHaveValue("12");
  });

  it("crea con el nombre recortado, limpia nombre y PIN y recarga la lista", async () => {
    montar();
    await llenar("654321");
    await userEvent.click(screen.getByRole("button", { name: "Crear empleado" }));
    await waitFor(() =>
      expect(api.crearEmpleado).toHaveBeenCalledWith({ nombre: "Ana Ruiz", sede_id: "s1", rol: "punto_venta", pin: "654321" }),
    );
    expect(toast.success).toHaveBeenCalledWith("Empleado creado");
    // Ni el aviso ni el DOM conservan el PIN.
    expect(JSON.stringify(toast.success.mock.calls)).not.toContain("654321");
    await waitFor(() => expect(screen.getByLabelText("Nombre")).toHaveValue(""));
    expect(screen.getByLabelText(/PIN/)).toHaveValue("");
    await waitFor(() => expect(api.fetchEmpleadosAdmin.mock.calls.length).toBeGreaterThan(1));
  });

  it("si el backend rechaza muestra el error y conserva lo escrito", async () => {
    api.crearEmpleado.mockRejectedValue(new Error("Ya existe un empleado con ese nombre"));
    montar();
    await llenar();
    await userEvent.click(screen.getByRole("button", { name: "Crear empleado" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Ya existe un empleado con ese nombre"));
    expect(screen.getByLabelText("Nombre")).toHaveValue("  Ana Ruiz ");
    expect(JSON.stringify(toast.error.mock.calls)).not.toContain("1234");
  });
});

describe("SeccionEmpleados: editar, estado, PIN y eliminar", () => {
  it("editar envia nombre, sede y rol", async () => {
    montar();
    await screen.findByText("Luis Perez");
    await userEvent.click(within(fila("Luis Perez")).getByRole("button", { name: "Editar" }));
    const nombre = screen.getAllByLabelText("Nombre").find((e) => (e as HTMLInputElement).value === "Luis Perez") as HTMLElement;
    await userEvent.clear(nombre);
    await userEvent.type(nombre, "Luis P.");
    const rol = screen.getAllByLabelText("Rol").at(-1) as HTMLElement;
    await userEvent.selectOptions(rol, "admin");
    await userEvent.click(screen.getByRole("button", { name: "Guardar" }));
    await waitFor(() =>
      expect(api.actualizarEmpleado).toHaveBeenCalledWith("e1", { nombre: "Luis P.", sede_id: "s1", rol: "admin" }),
    );
    expect(toast.success).toHaveBeenCalledWith("Empleado actualizado");
  });

  it("no deja guardar un nombre vacio", async () => {
    montar();
    await screen.findByText("Luis Perez");
    await userEvent.click(within(fila("Luis Perez")).getByRole("button", { name: "Editar" }));
    const nombre = screen.getAllByLabelText("Nombre").find((e) => (e as HTMLInputElement).value === "Luis Perez") as HTMLElement;
    await userEvent.clear(nombre);
    expect(screen.getByRole("button", { name: "Guardar" })).toBeDisabled();
  });

  it("Desactivar y Activar alternan el estado", async () => {
    montar();
    await screen.findByText("Luis Perez");
    await userEvent.click(within(fila("Luis Perez")).getByRole("button", { name: "Desactivar" }));
    await waitFor(() => expect(api.actualizarEmpleado).toHaveBeenCalledWith("e1", { estado: "inactivo" }));
    expect(toast.success).toHaveBeenCalledWith("Empleado desactivado");
    await userEvent.click(within(fila("Marta Gil")).getByRole("button", { name: "Activar" }));
    await waitFor(() => expect(api.actualizarEmpleado).toHaveBeenCalledWith("e2", { estado: "activo" }));
  });

  it("reset de PIN llama al backend con el PIN nuevo sin mostrarlo en pantalla", async () => {
    montar();
    await screen.findByText("Luis Perez");
    await userEvent.click(within(fila("Luis Perez")).getByRole("button", { name: "Cambiar PIN" }));
    await userEvent.type(screen.getByLabelText("Nuevo PIN"), "7788");
    expect(screen.queryByText("7788")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Guardar" }));
    await waitFor(() => expect(api.resetearPinEmpleado).toHaveBeenCalledWith("e1", "7788"));
    expect(toast.success).toHaveBeenCalledWith("PIN actualizado");
    expect(document.body.textContent).not.toContain("7788");
  });

  it("eliminar sin historial borra y revalida", async () => {
    montar();
    await screen.findByText("Luis Perez");
    await userEvent.click(within(fila("Luis Perez")).getByRole("button", { name: "Eliminar" }));
    const dialogo = screen.getByRole("dialog");
    await userEvent.click(within(dialogo).getByRole("button", { name: "Eliminar" }));
    await waitFor(() => expect(api.eliminarEmpleado).toHaveBeenCalledWith("e1"));
    expect(toast.success).toHaveBeenCalledWith("Empleado eliminado");
  });

  it("eliminar un empleado con historial (409) ofrece Desactivar", async () => {
    const { ErrorAdmin } = await import("@/lib/api");
    api.eliminarEmpleado.mockRejectedValue(new ErrorAdmin("Tiene entregas registradas", 409));
    montar();
    await screen.findByText("Luis Perez");
    await userEvent.click(within(fila("Luis Perez")).getByRole("button", { name: "Eliminar" }));
    await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Eliminar" }));
    expect(await screen.findByText("Tiene entregas registradas")).toBeInTheDocument();
    await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Desactivar" }));
    await waitFor(() => expect(api.actualizarEmpleado).toHaveBeenCalledWith("e1", { estado: "inactivo" }));
  });
});
