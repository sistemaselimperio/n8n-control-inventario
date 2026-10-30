import { act, render, renderHook, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Sesion } from "./sesion";
import { leerSesion } from "./sesion";
import { SesionProvider, useSesion } from "./SesionProvider";
import { SESION_PRUEBA, iniciarSesionDePrueba, mockLocation } from "@/test/utils";

const api = vi.hoisted(() => ({ fetchYo: vi.fn(), loginDashboard: vi.fn() }));
vi.mock("@/lib/api", () => api);

function Sonda() {
  const { listo, usuario, esAdmin, puedeEditar, login, logout } = useSesion();
  return (
    <div>
      <p data-testid="estado">
        {listo ? "listo" : "cargando"}|{usuario?.nombre ?? "anonimo"}|{usuario?.rol ?? "-"}|{String(esAdmin)}|{String(puedeEditar)}
      </p>
      <button onClick={() => login("  ANA ", "clave").catch(() => {})}>entrar</button>
      <button onClick={logout}>salir</button>
    </div>
  );
}

const montar = () =>
  render(
    <SesionProvider>
      <Sonda />
    </SesionProvider>,
  );

beforeEach(() => {
  api.fetchYo.mockReset().mockResolvedValue(SESION_PRUEBA.usuario);
  api.loginDashboard.mockReset();
});

describe("SesionProvider", () => {
  it("sin sesion: listo y usuario anonimo", () => {
    montar();
    expect(screen.getByTestId("estado")).toHaveTextContent("listo|anonimo|-|false|false");
    expect(api.fetchYo).not.toHaveBeenCalled();
  });

  it("con sesion guardada expone usuario y permisos", async () => {
    iniciarSesionDePrueba({ usuario: { ...SESION_PRUEBA.usuario, rol: "supervisor" } });
    api.fetchYo.mockResolvedValue({ ...SESION_PRUEBA.usuario, rol: "supervisor" });
    montar();
    expect(screen.getByTestId("estado")).toHaveTextContent("listo|Ana|supervisor|false|true");
    await waitFor(() => expect(api.fetchYo).toHaveBeenCalledOnce());
  });

  it("login normaliza el usuario (trim + minusculas) y guarda la sesion", async () => {
    const respuesta: Sesion = { ...SESION_PRUEBA, token: "nuevo" };
    api.loginDashboard.mockResolvedValue(respuesta);
    montar();
    await userEvent.click(screen.getByText("entrar"));
    expect(api.loginDashboard).toHaveBeenCalledWith("ana", "clave");
    await waitFor(() => expect(leerSesion()?.token).toBe("nuevo"));
    expect(screen.getByTestId("estado")).toHaveTextContent("listo|Ana|admin|true|true");
  });

  it("si el login falla no se guarda nada", async () => {
    api.loginDashboard.mockRejectedValue(new Error("Usuario o contraseña incorrectos"));
    montar();
    await userEvent.click(screen.getByText("entrar"));
    await waitFor(() => expect(api.loginDashboard).toHaveBeenCalled());
    expect(leerSesion()).toBeNull();
  });

  it("logout borra la sesion y recarga en /login", async () => {
    const assign = mockLocation("/entregas");
    iniciarSesionDePrueba();
    montar();
    await userEvent.click(screen.getByText("salir"));
    expect(leerSesion()).toBeNull();
    expect(assign).toHaveBeenCalledWith("/login");
    expect(screen.getByTestId("estado")).toHaveTextContent("listo|anonimo");
  });

  it("una sesion ya vencida se cierra al montar", async () => {
    const assign = mockLocation("/entregas");
    iniciarSesionDePrueba({ expira_at: new Date(Date.now() - 1000).toISOString() });
    montar();
    await waitFor(() => expect(leerSesion()).toBeNull());
    expect(assign).toHaveBeenCalledWith("/login?expirada=1");
  });

  it("cierra la sesion cuando llega expira_at", () => {
    vi.useFakeTimers();
    try {
      const assign = mockLocation("/entregas");
      iniciarSesionDePrueba({ expira_at: new Date(Date.now() + 60_000).toISOString() });
      montar();
      expect(leerSesion()).not.toBeNull();
      act(() => {
        vi.advanceTimersByTime(59_000);
      });
      expect(assign).not.toHaveBeenCalled();
      act(() => {
        vi.advanceTimersByTime(2_000);
      });
      expect(leerSesion()).toBeNull();
      expect(assign).toHaveBeenCalledWith("/login?expirada=1");
    } finally {
      vi.useRealTimers();
    }
  });

  it("refresca nombre y rol cuando el backend los cambio", async () => {
    iniciarSesionDePrueba();
    api.fetchYo.mockResolvedValue({ ...SESION_PRUEBA.usuario, nombre: "Ana Maria", rol: "supervisor" });
    montar();
    await waitFor(() => expect(screen.getByTestId("estado")).toHaveTextContent("Ana Maria|supervisor"));
    expect(leerSesion()?.usuario.nombre).toBe("Ana Maria");
    // El token se conserva.
    expect(leerSesion()?.token).toBe("tok-123");
  });

  it("no reescribe la sesion si nada cambio", async () => {
    iniciarSesionDePrueba();
    const crudo = localStorage.getItem("despachos_sesion");
    montar();
    await waitFor(() => expect(api.fetchYo).toHaveBeenCalled());
    expect(localStorage.getItem("despachos_sesion")).toBe(crudo);
  });

  it("si fetchYo falla por red se sigue con lo guardado", async () => {
    iniciarSesionDePrueba();
    api.fetchYo.mockRejectedValue(new TypeError("Failed to fetch"));
    montar();
    await waitFor(() => expect(api.fetchYo).toHaveBeenCalled());
    expect(leerSesion()?.token).toBe("tok-123");
    expect(screen.getByTestId("estado")).toHaveTextContent("Ana");
  });

  it("descarta la respuesta de fetchYo si la sesion cambio mientras tanto", async () => {
    iniciarSesionDePrueba();
    let resolver: (u: unknown) => void = () => {};
    // Solo la primera consulta (con el token viejo) queda pendiente; la que se
    // dispare con el token nuevo responde con los mismos datos de la sesion.
    api.fetchYo.mockReturnValueOnce(new Promise((r) => (resolver = r)));
    montar();
    act(() => {
      iniciarSesionDePrueba({ token: "otro-token" });
    });
    await act(async () => {
      resolver({ ...SESION_PRUEBA.usuario, nombre: "Intruso" });
    });
    expect(leerSesion()?.usuario.nombre).toBe("Ana");
  });

  it("useSesion fuera del proveedor lanza un error claro", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => renderHook(() => useSesion())).toThrow("useSesion debe usarse dentro de <SesionProvider>");
  });
});
