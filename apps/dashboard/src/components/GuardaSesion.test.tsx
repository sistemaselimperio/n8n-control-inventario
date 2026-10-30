import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GuardaSesion } from "./GuardaSesion";
import { SesionProvider } from "@/lib/SesionProvider";
import { leerSesion } from "@/lib/sesion";
import { SESION_PRUEBA, iniciarSesionDePrueba, mockLocation } from "@/test/utils";

const nav = vi.hoisted(() => ({ replace: vi.fn(), pathname: "/entregas" }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: nav.replace }),
  usePathname: () => nav.pathname,
}));
const api = vi.hoisted(() => ({ fetchYo: vi.fn(), cambiarPassword: vi.fn(), loginDashboard: vi.fn() }));
vi.mock("@/lib/api", () => api);
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

const montar = () =>
  render(
    <SesionProvider>
      <GuardaSesion>
        <p>contenido protegido</p>
      </GuardaSesion>
    </SesionProvider>,
  );

const usuarioDe = (rol: "admin" | "supervisor" | "consulta", area?: "todo" | "bodega" | "traslados") => ({
  ...SESION_PRUEBA.usuario,
  rol,
  area,
});

beforeEach(() => {
  nav.replace.mockReset();
  nav.pathname = "/entregas";
  // La validacion contra el backend queda pendiente: estas pruebas miran el
  // guard y la barra con la sesion tal como se guardo.
  api.fetchYo.mockReset().mockReturnValue(new Promise(() => {}));
  api.cambiarPassword.mockReset();
  toast.success.mockReset();
  toast.error.mockReset();
});

describe("guard de rutas", () => {
  it("sin sesion no pinta el contenido y manda a /login con ?siguiente", async () => {
    nav.pathname = "/traslados";
    montar();
    expect(screen.queryByText("contenido protegido")).toBeNull();
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith("/login?siguiente=%2Ftraslados"));
  });

  it("desde la raiz manda a /login sin siguiente", async () => {
    nav.pathname = "/";
    montar();
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith("/login"));
  });

  it.each(["/login", "/faia", "/faia/otra"])("%s es publica: se pinta sin sesion y sin redirigir", (ruta) => {
    nav.pathname = ruta;
    montar();
    expect(screen.getByText("contenido protegido")).toBeInTheDocument();
    expect(nav.replace).not.toHaveBeenCalled();
    // Ni barra de usuario.
    expect(screen.queryByRole("banner")).toBeNull();
  });

  it("con sesion pinta la barra y el contenido", () => {
    iniciarSesionDePrueba();
    montar();
    expect(screen.getByText("contenido protegido")).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "Principal" })).toBeInTheDocument();
    expect(nav.replace).not.toHaveBeenCalled();
  });

  it("un usuario de area traslados en /entregas es llevado a /traslados sin ver el contenido", async () => {
    iniciarSesionDePrueba({ usuario: usuarioDe("consulta", "traslados") });
    montar();
    expect(screen.queryByText("contenido protegido")).toBeNull();
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith("/traslados"));
  });
});

describe("barra de usuario", () => {
  it("el admin ve todos los enlaces habilitados", () => {
    iniciarSesionDePrueba();
    montar();
    expect(screen.getByRole("link", { name: "Administración" })).toHaveAttribute("href", "/creador");
    expect(screen.getByRole("link", { name: "Traslados" })).toHaveAttribute("href", "/traslados");
    expect(screen.getByRole("link", { name: "Entregas" })).toHaveAttribute("aria-current", "page");
  });

  it("un supervisor de bodega ve Traslados y Administracion bloqueados (sin enlace)", () => {
    iniciarSesionDePrueba({ usuario: usuarioDe("supervisor", "bodega") });
    montar();
    expect(screen.queryByRole("link", { name: "Administración" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Traslados" })).toBeNull();
    expect(screen.getAllByText(", sin acceso")).toHaveLength(2);
  });

  it("el menu Analisis bloquea Turnos para quien no es admin", async () => {
    iniciarSesionDePrueba({ usuario: usuarioDe("supervisor", "bodega") });
    montar();
    await userEvent.click(screen.getByRole("button", { name: /Análisis/ }));
    expect(screen.getByRole("menuitem", { name: /Ranking/ })).toHaveAttribute("href", "/ranking");
    expect(screen.getByRole("menuitem", { name: /Turnos/ })).toHaveAttribute("aria-disabled", "true");
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("menu", { name: "Análisis" })).toBeNull();
  });

  it("muestra nombre, usuario y rol en el menu de usuario", async () => {
    iniciarSesionDePrueba();
    montar();
    await userEvent.click(screen.getByRole("button", { name: "Menú de usuario" }));
    expect(screen.getByText(/Ana · @ana/)).toBeInTheDocument();
    expect(screen.getByText("Administrador")).toBeInTheDocument();
  });

  it("Cerrar sesion borra la sesion y recarga en /login", async () => {
    const assign = mockLocation("/entregas");
    iniciarSesionDePrueba();
    montar();
    await userEvent.click(screen.getByRole("button", { name: "Menú de usuario" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Cerrar sesión" }));
    expect(leerSesion()).toBeNull();
    expect(assign).toHaveBeenCalledWith("/login");
  });
});

describe("cambiar contraseña", () => {
  async function abrirModal() {
    iniciarSesionDePrueba();
    montar();
    await userEvent.click(screen.getByRole("button", { name: "Menú de usuario" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Cambiar contraseña" }));
  }

  it("valida el minimo de 8 caracteres sin llamar al backend", async () => {
    await abrirModal();
    await userEvent.type(screen.getByLabelText("Contraseña actual"), "vieja");
    await userEvent.type(screen.getByLabelText(/Contraseña nueva/), "corta");
    await userEvent.type(screen.getByLabelText("Confirmar contraseña nueva"), "corta");
    await userEvent.click(screen.getByRole("button", { name: "Cambiar contraseña" }));
    expect(screen.getByText("La contraseña nueva debe tener al menos 8 caracteres.")).toBeInTheDocument();
    expect(api.cambiarPassword).not.toHaveBeenCalled();
  });

  it("exige que la confirmacion coincida", async () => {
    await abrirModal();
    await userEvent.type(screen.getByLabelText("Contraseña actual"), "vieja");
    await userEvent.type(screen.getByLabelText(/Contraseña nueva/), "nuevaClave1");
    await userEvent.type(screen.getByLabelText("Confirmar contraseña nueva"), "otraClave22");
    await userEvent.click(screen.getByRole("button", { name: "Cambiar contraseña" }));
    expect(screen.getByText("La confirmación no coincide con la contraseña nueva.")).toBeInTheDocument();
    expect(api.cambiarPassword).not.toHaveBeenCalled();
  });

  it("guarda, avisa y cierra el modal", async () => {
    api.cambiarPassword.mockResolvedValue(undefined);
    await abrirModal();
    await userEvent.type(screen.getByLabelText("Contraseña actual"), "vieja");
    await userEvent.type(screen.getByLabelText(/Contraseña nueva/), "nuevaClave1");
    await userEvent.type(screen.getByLabelText("Confirmar contraseña nueva"), "nuevaClave1");
    await userEvent.click(screen.getByRole("button", { name: "Cambiar contraseña" }));
    expect(api.cambiarPassword).toHaveBeenCalledWith("vieja", "nuevaClave1");
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Contraseña actualizada"));
    expect(screen.queryByLabelText("Contraseña actual")).toBeNull();
  });

  it("muestra el error del backend y deja el modal abierto", async () => {
    api.cambiarPassword.mockRejectedValue(new Error("La contraseña actual no coincide"));
    await abrirModal();
    await userEvent.type(screen.getByLabelText("Contraseña actual"), "mala");
    await userEvent.type(screen.getByLabelText(/Contraseña nueva/), "nuevaClave1");
    await userEvent.type(screen.getByLabelText("Confirmar contraseña nueva"), "nuevaClave1");
    await userEvent.click(screen.getByRole("button", { name: "Cambiar contraseña" }));
    expect(await screen.findByText("La contraseña actual no coincide")).toBeInTheDocument();
    expect(screen.getByLabelText("Contraseña actual")).toBeInTheDocument();
  });
});
