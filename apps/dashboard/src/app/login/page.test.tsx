import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import LoginPage from "./page";
import { SesionProvider } from "@/lib/SesionProvider";
import { leerSesion } from "@/lib/sesion";
import { SESION_PRUEBA, iniciarSesionDePrueba } from "@/test/utils";

const nav = vi.hoisted(() => ({ replace: vi.fn(), params: new URLSearchParams() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: nav.replace }),
  useSearchParams: () => nav.params,
}));
const api = vi.hoisted(() => ({ fetchYo: vi.fn(), loginDashboard: vi.fn() }));
vi.mock("@/lib/api", () => api);

const montar = () =>
  render(
    <SesionProvider>
      <LoginPage />
    </SesionProvider>,
  );

beforeEach(() => {
  nav.replace.mockReset();
  nav.params = new URLSearchParams();
  api.fetchYo.mockReset().mockResolvedValue(SESION_PRUEBA.usuario);
  api.loginDashboard.mockReset();
});

describe("pagina de login", () => {
  it("el boton Entrar esta deshabilitado hasta completar usuario y contraseña", async () => {
    montar();
    const boton = screen.getByRole("button", { name: "Entrar" });
    expect(boton).toBeDisabled();
    await userEvent.type(screen.getByLabelText("Usuario"), "   ");
    await userEvent.type(screen.getByLabelText("Contraseña"), "x");
    expect(boton).toBeDisabled();
    await userEvent.type(screen.getByLabelText("Usuario"), "ana");
    expect(boton).toBeEnabled();
  });

  it("inicia sesion, guarda el token y sigue al panel", async () => {
    api.loginDashboard.mockResolvedValue({ ...SESION_PRUEBA, token: "nuevo" });
    montar();
    await userEvent.type(screen.getByLabelText("Usuario"), " Ana ");
    await userEvent.type(screen.getByLabelText("Contraseña"), "secreta");
    await userEvent.click(screen.getByRole("button", { name: "Entrar" }));
    expect(api.loginDashboard).toHaveBeenCalledWith("ana", "secreta");
    await waitFor(() => expect(leerSesion()?.token).toBe("nuevo"));
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith("/"));
  });

  it("muestra el error del backend y permite reintentar", async () => {
    api.loginDashboard.mockRejectedValue(new Error("Usuario o contraseña incorrectos"));
    montar();
    await userEvent.type(screen.getByLabelText("Usuario"), "ana");
    await userEvent.type(screen.getByLabelText("Contraseña"), "mala");
    await userEvent.click(screen.getByRole("button", { name: "Entrar" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Usuario o contraseña incorrectos");
    expect(leerSesion()).toBeNull();
    expect(screen.getByRole("button", { name: "Entrar" })).toBeEnabled();
    expect(nav.replace).not.toHaveBeenCalled();
  });

  it("muestra el mensaje de bloqueo por intentos (423)", async () => {
    api.loginDashboard.mockRejectedValue(new Error("Demasiados intentos. Intenta en 15 minutos"));
    montar();
    await userEvent.type(screen.getByLabelText("Usuario"), "ana");
    await userEvent.type(screen.getByLabelText("Contraseña"), "x");
    await userEvent.click(screen.getByRole("button", { name: "Entrar" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Demasiados intentos");
  });

  it("avisa que la sesion expiro con ?expirada=1", () => {
    nav.params = new URLSearchParams("expirada=1");
    montar();
    expect(screen.getByRole("status")).toHaveTextContent("Tu sesión expiró");
  });

  it("sin el parametro no muestra el aviso de expiracion", () => {
    montar();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("con sesion ya iniciada redirige al destino pedido", async () => {
    iniciarSesionDePrueba();
    nav.params = new URLSearchParams("siguiente=/traslados");
    montar();
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith("/traslados"));
  });

  it.each([
    ["//evil.com", "/"],
    ["https://evil.com", "/"],
    ["/login?x=1", "/"],
    ["/entregas?estado=revision", "/entregas?estado=revision"],
  ])("?siguiente=%s redirige a %s (solo rutas internas)", async (siguiente, esperado) => {
    iniciarSesionDePrueba();
    nav.params = new URLSearchParams({ siguiente });
    montar();
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith(esperado));
  });
});
