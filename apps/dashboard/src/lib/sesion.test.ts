import { describe, expect, it, vi } from "vitest";
import {
  areaEfectiva,
  borrarSesion,
  esAdmin,
  expirarSesion,
  guardarSesion,
  leerSesion,
  puedeEditar,
  rutaInicial,
  rutaPermitida,
  sesionVigente,
  suscribirSesion,
  tokenActual,
  type UsuarioDashboard,
} from "./sesion";
import { SESION_PRUEBA, iniciarSesionDePrueba, mockLocation } from "@/test/utils";

const usuario = (rol: UsuarioDashboard["rol"], area?: UsuarioDashboard["area"]): UsuarioDashboard => ({
  id: "1",
  usuario: "u",
  nombre: "U",
  rol,
  area,
});

describe("almacenamiento de la sesion", () => {
  it("guarda y lee la sesion", () => {
    guardarSesion(SESION_PRUEBA);
    expect(leerSesion()).toEqual(SESION_PRUEBA);
  });

  it("devuelve el mismo objeto mientras el texto no cambie (estable para useSyncExternalStore)", () => {
    guardarSesion(SESION_PRUEBA);
    expect(leerSesion()).toBe(leerSesion());
  });

  it("sin nada guardado devuelve null", () => {
    expect(leerSesion()).toBeNull();
  });

  it.each([
    ["JSON corrupto", "{no-es-json"],
    ["sin token", JSON.stringify({ usuario: { id: "1" }, expira_at: "2030-01-01" })],
    ["token vacio", JSON.stringify({ token: "", usuario: { id: "1" }, expira_at: "2030-01-01" })],
    ["sin usuario", JSON.stringify({ token: "t", expira_at: "2030-01-01" })],
    ["sin expira_at", JSON.stringify({ token: "t", usuario: { id: "1" } })],
  ])("trata %s como sin sesion", (_n, crudo) => {
    localStorage.setItem("despachos_sesion", crudo);
    expect(leerSesion()).toBeNull();
  });

  it("borrarSesion limpia el storage", () => {
    guardarSesion(SESION_PRUEBA);
    borrarSesion();
    expect(leerSesion()).toBeNull();
    expect(localStorage.getItem("despachos_sesion")).toBeNull();
  });

  it("no revienta si localStorage falla", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("bloqueado");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("lleno");
    });
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new Error("bloqueado");
    });
    expect(leerSesion()).toBeNull();
    expect(() => guardarSesion(SESION_PRUEBA)).not.toThrow();
    expect(() => borrarSesion()).not.toThrow();
  });
});

describe("vigencia y token", () => {
  it("sesionVigente respeta expira_at", () => {
    expect(sesionVigente(null)).toBe(false);
    expect(sesionVigente({ ...SESION_PRUEBA, expira_at: new Date(Date.now() + 5000).toISOString() })).toBe(true);
    expect(sesionVigente({ ...SESION_PRUEBA, expira_at: new Date(Date.now() - 5000).toISOString() })).toBe(false);
    expect(sesionVigente({ ...SESION_PRUEBA, expira_at: "no-es-fecha" })).toBe(false);
  });

  it("tokenActual solo devuelve el token de una sesion vigente", () => {
    expect(tokenActual()).toBeNull();
    iniciarSesionDePrueba();
    expect(tokenActual()).toBe("tok-123");
    iniciarSesionDePrueba({ expira_at: new Date(Date.now() - 1).toISOString() });
    expect(tokenActual()).toBeNull();
  });
});

describe("suscribirSesion", () => {
  it("avisa al guardar y al borrar, y deja de avisar tras cancelar", () => {
    const oyente = vi.fn();
    const cancelar = suscribirSesion(oyente);
    guardarSesion(SESION_PRUEBA);
    borrarSesion();
    expect(oyente).toHaveBeenCalledTimes(2);
    cancelar();
    guardarSesion(SESION_PRUEBA);
    expect(oyente).toHaveBeenCalledTimes(2);
  });

  it("reacciona al evento storage de otra pestana solo para su clave", () => {
    const oyente = vi.fn();
    const cancelar = suscribirSesion(oyente);
    window.dispatchEvent(new StorageEvent("storage", { key: "otra_clave" }));
    expect(oyente).not.toHaveBeenCalled();
    window.dispatchEvent(new StorageEvent("storage", { key: "despachos_sesion" }));
    window.dispatchEvent(new StorageEvent("storage", { key: null }));
    expect(oyente).toHaveBeenCalledTimes(2);
    cancelar();
    window.dispatchEvent(new StorageEvent("storage", { key: "despachos_sesion" }));
    expect(oyente).toHaveBeenCalledTimes(2);
  });
});

describe("expirarSesion", () => {
  it("borra la sesion y manda a /login?expirada=1", () => {
    const assign = mockLocation("/entregas");
    iniciarSesionDePrueba();
    expirarSesion();
    expect(leerSesion()).toBeNull();
    expect(assign).toHaveBeenCalledWith("/login?expirada=1");
  });

  it("no redirige si ya esta en /login", () => {
    const assign = mockLocation("/login");
    iniciarSesionDePrueba();
    expirarSesion();
    expect(leerSesion()).toBeNull();
    expect(assign).not.toHaveBeenCalled();
  });
});

describe("roles, areas y rutas", () => {
  it("esAdmin y puedeEditar", () => {
    expect(esAdmin(usuario("admin"))).toBe(true);
    expect(esAdmin(usuario("supervisor"))).toBe(false);
    expect(esAdmin(null)).toBe(false);
    expect(puedeEditar(usuario("admin"))).toBe(true);
    expect(puedeEditar(usuario("supervisor"))).toBe(true);
    expect(puedeEditar(usuario("consulta"))).toBe(false);
    expect(puedeEditar(undefined)).toBe(false);
  });

  it("areaEfectiva: admin y sesiones viejas sin area cuentan como todo", () => {
    expect(areaEfectiva(usuario("admin", "bodega"))).toBe("todo");
    expect(areaEfectiva(usuario("consulta"))).toBe("todo");
    expect(areaEfectiva(usuario("consulta", "traslados"))).toBe("traslados");
    expect(areaEfectiva(null)).toBe("todo");
  });

  it("rutaPermitida por area", () => {
    const bodega = usuario("supervisor", "bodega");
    expect(rutaPermitida(bodega, "/entregas")).toBe(true);
    expect(rutaPermitida(bodega, "/productos/x")).toBe(true);
    expect(rutaPermitida(bodega, "/")).toBe(true);
    expect(rutaPermitida(bodega, "/traslados")).toBe(false);
    // "/" solo coincide exacto, no como prefijo de todo.
    expect(rutaPermitida(bodega, "/creador")).toBe(false);
    // Un prefijo parcial no cuenta ("/entregasX").
    expect(rutaPermitida(bodega, "/entregasX")).toBe(false);
    const traslados = usuario("consulta", "traslados");
    expect(rutaPermitida(traslados, "/traslados/abc")).toBe(true);
    expect(rutaPermitida(traslados, "/entregas")).toBe(false);
    expect(rutaPermitida(usuario("admin"), "/cualquiera")).toBe(true);
  });

  it("rutaInicial por area", () => {
    expect(rutaInicial(usuario("admin"))).toBe("/entregas");
    expect(rutaInicial(usuario("consulta", "bodega"))).toBe("/entregas");
    expect(rutaInicial(usuario("consulta", "traslados"))).toBe("/traslados");
  });
});
