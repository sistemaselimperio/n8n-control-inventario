import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SWRConfig } from "swr";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SeccionUsuariosDashboard } from "./SeccionUsuariosDashboard";

const api = vi.hoisted(() => ({
  actualizarUsuarioDashboard: vi.fn(),
  crearUsuarioDashboard: vi.fn(),
  eliminarUsuarioDashboard: vi.fn(),
  fetchUsuariosDashboard: vi.fn(),
  resetearPasswordUsuarioDashboard: vi.fn(),
}));
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  ...api,
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));
vi.mock("@/lib/SesionProvider", () => ({ useSesion: () => ({ usuario: { id: "yo", usuario: "ana" } }) }));

const base = { activo: true, creado_at: "2026-01-01T00:00:00Z", ultimo_login_at: null, bloqueado_hasta: null };
const usuarios = [
  { ...base, id: "yo", usuario: "ana", nombre: "Ana Admin", rol: "admin", area: "todo" },
  { ...base, id: "u2", usuario: "beto", nombre: "Beto Consulta", rol: "consulta", area: "bodega", ultimo_login_at: "2026-10-01T15:00:00Z" },
  {
    ...base,
    id: "u3",
    usuario: "carla",
    nombre: "Carla Traslados",
    rol: "supervisor",
    area: "traslados",
    bloqueado_hasta: "2999-01-01T00:00:00Z",
  },
];

const montar = () =>
  render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <SeccionUsuariosDashboard />
    </SWRConfig>,
  );

const fila = (nombre: string) => screen.getByText(nombre, { exact: false }).closest("li") as HTMLElement;

beforeEach(() => {
  Object.values(api).forEach((f) => f.mockReset());
  api.fetchUsuariosDashboard.mockResolvedValue(usuarios);
  api.crearUsuarioDashboard.mockResolvedValue({});
  api.actualizarUsuarioDashboard.mockResolvedValue({});
  api.resetearPasswordUsuarioDashboard.mockResolvedValue({ ok: true });
  toast.success.mockReset();
  toast.error.mockReset();
});

describe("SeccionUsuariosDashboard: listado", () => {
  it("muestra rol, area, ultimo ingreso y bloqueo vigente", async () => {
    montar();
    await screen.findByText(/Beto Consulta/);
    expect(within(fila("Beto Consulta")).getByText(/Consulta, área bodega/)).toBeInTheDocument();
    expect(within(fila("Beto Consulta")).queryByText(/nunca/)).toBeNull();
    expect(within(fila("Ana Admin")).getByText(/Último ingreso: nunca/)).toBeInTheDocument();
    expect(within(fila("Carla Traslados")).getByText(/Bloqueado hasta/)).toBeInTheDocument();
    expect(within(fila("Beto Consulta")).queryByText(/Bloqueado hasta/)).toBeNull();
  });

  it("marca al usuario actual y le impide desactivarse o eliminarse", async () => {
    montar();
    await screen.findByText(/Ana Admin/);
    const yo = fila("Ana Admin");
    expect(within(yo).getByText("(tú)")).toBeInTheDocument();
    expect(within(yo).getByRole("button", { name: "Desactivar" })).toBeDisabled();
    expect(within(yo).getByRole("button", { name: "Eliminar" })).toBeDisabled();
    expect(within(fila("Beto Consulta")).getByRole("button", { name: "Desactivar" })).toBeEnabled();
  });
});

describe("SeccionUsuariosDashboard: crear", () => {
  async function llenar({ password = "claveSegura1", usuario = "  NuevoUsuario ", nombre = "Nuevo" } = {}) {
    await screen.findByText(/Ana Admin/);
    await userEvent.type(screen.getByLabelText(/^Usuario/), usuario);
    await userEvent.type(screen.getByLabelText("Nombre"), nombre);
    await userEvent.type(screen.getByLabelText(/^Contraseña/), password);
  }

  it("el boton exige usuario de 3+ letras, nombre y contraseña de 8+", async () => {
    montar();
    await screen.findByText(/Ana Admin/);
    const crear = screen.getByRole("button", { name: "Crear usuario" });
    await llenar({ password: "corta12" });
    expect(crear).toBeDisabled();
    await userEvent.type(screen.getByLabelText(/^Contraseña/), "3");
    expect(crear).toBeEnabled();
  });

  it("envia el usuario normalizado y la contraseña, y limpia el formulario sin dejar rastro", async () => {
    montar();
    await llenar();
    await userEvent.selectOptions(screen.getByLabelText("Rol"), "supervisor");
    await userEvent.selectOptions(screen.getByLabelText("Área"), "traslados");
    await userEvent.click(screen.getByRole("button", { name: "Crear usuario" }));
    await waitFor(() =>
      expect(api.crearUsuarioDashboard).toHaveBeenCalledWith({
        usuario: "nuevousuario",
        nombre: "Nuevo",
        rol: "supervisor",
        area: "traslados",
        password: "claveSegura1",
      }),
    );
    expect(toast.success).toHaveBeenCalledWith("Usuario creado");
    expect(JSON.stringify(toast.success.mock.calls)).not.toContain("claveSegura1");
    await waitFor(() => expect(screen.getByLabelText(/^Contraseña/)).toHaveValue(""));
    expect(screen.getByLabelText("Nombre")).toHaveValue("");
  });

  it("un admin siempre queda con area 'todo' aunque se haya elegido otra", async () => {
    montar();
    await llenar();
    await userEvent.selectOptions(screen.getByLabelText("Área"), "bodega");
    await userEvent.selectOptions(screen.getByLabelText("Rol"), "admin");
    expect(screen.getByLabelText("Área")).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Crear usuario" }));
    await waitFor(() => expect(api.crearUsuarioDashboard).toHaveBeenCalledWith(expect.objectContaining({ rol: "admin", area: "todo" })));
  });

  it("un error del backend se avisa y conserva lo escrito", async () => {
    api.crearUsuarioDashboard.mockRejectedValue(new Error("Ese usuario ya existe"));
    montar();
    await llenar();
    await userEvent.click(screen.getByRole("button", { name: "Crear usuario" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Ese usuario ya existe"));
    expect(screen.getByLabelText("Nombre")).toHaveValue("Nuevo");
    expect(JSON.stringify(toast.error.mock.calls)).not.toContain("claveSegura1");
  });
});

describe("SeccionUsuariosDashboard: editar y restablecer contraseña", () => {
  it("restablecer exige 8 caracteres, usa campo password y no muestra la contraseña", async () => {
    montar();
    await screen.findByText(/Beto Consulta/);
    await userEvent.click(within(fila("Beto Consulta")).getByRole("button", { name: "Restablecer contraseña" }));
    const campo = screen.getByLabelText("Nueva contraseña");
    expect(campo).toHaveAttribute("type", "password");
    const guardar = screen.getByRole("button", { name: "Guardar" });
    await userEvent.type(campo, "corta12");
    expect(guardar).toBeDisabled();
    await userEvent.type(campo, "3");
    await userEvent.click(guardar);
    await waitFor(() => expect(api.resetearPasswordUsuarioDashboard).toHaveBeenCalledWith("u2", "corta123"));
    expect(toast.success).toHaveBeenCalledWith("Contraseña restablecida");
    expect(document.body.textContent).not.toContain("corta123");
  });

  it("editar convierte el area en 'todo' al elegir rol admin", async () => {
    montar();
    await screen.findByText(/Beto Consulta/);
    await userEvent.click(within(fila("Beto Consulta")).getByRole("button", { name: "Editar" }));
    await userEvent.selectOptions(screen.getAllByLabelText("Rol").at(-1) as HTMLElement, "admin");
    expect(screen.getAllByLabelText("Área").at(-1)).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Guardar" }));
    await waitFor(() =>
      expect(api.actualizarUsuarioDashboard).toHaveBeenCalledWith("u2", { nombre: "Beto Consulta", rol: "admin", area: "todo" }),
    );
  });

  it("Activar/Desactivar a otro usuario alterna el flag activo", async () => {
    montar();
    await screen.findByText(/Beto Consulta/);
    await userEvent.click(within(fila("Beto Consulta")).getByRole("button", { name: "Desactivar" }));
    await waitFor(() => expect(api.actualizarUsuarioDashboard).toHaveBeenCalledWith("u2", { activo: false }));
    expect(toast.success).toHaveBeenCalledWith("Usuario desactivado");
  });
});
