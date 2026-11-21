import { describe, expect, it, vi } from "vitest";
import {
  accionesComprobante,
  etiquetaEstado,
  perfilTraslados,
  revalidarTraslados,
  CLAVE_TRASLADOS,
  CEDULA_FIRMA_VALIDA,
  etiquetaPuntoOpcion,
} from "./traslados";
import type { Comprobante } from "./api";
import type { UsuarioDashboard } from "./sesion";

const mutateMock = vi.hoisted(() => vi.fn());
vi.mock("swr", async (importOriginal) => {
  const original = await importOriginal<typeof import("swr")>();
  return { ...original, mutate: mutateMock };
});

const u = (parcial: Partial<UsuarioDashboard>): UsuarioDashboard => ({
  id: "1",
  usuario: "u",
  nombre: "U",
  rol: "consulta",
  area: "todo",
  ...parcial,
});

const comp = (estado: Comprobante["estado"]) => ({ estado }) as Comprobante;

describe("perfilTraslados", () => {
  it("admin: todo", () => {
    const p = perfilTraslados(u({ rol: "admin" }));
    expect(p).toMatchObject({ acceso: true, gestiona: true, firma: true, soloLectura: false, tipo: "admin" });
  });

  it("encargada: supervisor de traslados sin punto gestiona pero no firma", () => {
    const p = perfilTraslados(u({ rol: "supervisor", area: "traslados", punto_id: null }));
    expect(p).toMatchObject({ acceso: true, gestiona: true, firma: false, tipo: "encargada" });
  });

  it("punto: supervisor de traslados con punto firma pero no gestiona", () => {
    const p = perfilTraslados(u({ rol: "supervisor", area: "traslados", punto_id: "p1" }));
    expect(p).toMatchObject({ acceso: true, gestiona: false, firma: true, tipo: "punto", puntoId: "p1" });
  });

  it("lectura: consulta de traslados (con o sin punto) y supervisor/consulta de area todo", () => {
    for (const usuario of [
      u({ rol: "consulta", area: "traslados" }),
      u({ rol: "consulta", area: "traslados", punto_id: "p1" }),
      u({ rol: "consulta", area: "todo" }),
      u({ rol: "supervisor", area: "todo" }),
      u({ rol: "consulta" , area: undefined }),
    ]) {
      expect(perfilTraslados(usuario)).toMatchObject({ acceso: true, gestiona: false, firma: false, soloLectura: true, tipo: "lectura" });
    }
  });

  it("area bodega no tiene acceso; sin usuario tampoco", () => {
    expect(perfilTraslados(u({ rol: "supervisor", area: "bodega" })).acceso).toBe(false);
    expect(perfilTraslados(null).acceso).toBe(false);
  });
});

describe("accionesComprobante", () => {
  const admin = perfilTraslados(u({ rol: "admin" }));
  const encargada = perfilTraslados(u({ rol: "supervisor", area: "traslados" }));
  const punto = perfilTraslados(u({ rol: "supervisor", area: "traslados", punto_id: "p1" }));
  const lectura = perfilTraslados(u({ rol: "consulta", area: "traslados" }));

  it("punto: confirma y devuelve solo pendientes; no devuelve confirmados ni elimina", () => {
    expect(accionesComprobante(punto, comp("pendiente"))).toMatchObject({ confirmar: true, devolver: true, eliminar: false });
    expect(accionesComprobante(punto, comp("confirmado"))).toMatchObject({ confirmar: false, devolver: false, eliminar: false });
  });

  it("encargada: devuelve confirmados, no pendientes; no firma; reenvia devueltos; elimina", () => {
    expect(accionesComprobante(encargada, comp("pendiente"))).toMatchObject({ confirmar: false, devolver: false, eliminar: true });
    expect(accionesComprobante(encargada, comp("confirmado"))).toMatchObject({ devolver: true });
    expect(accionesComprobante(encargada, comp("devuelto"))).toMatchObject({ reenviar: true, devolver: false });
  });

  it("admin: confirma, devuelve pendientes y confirmados, reenvia y elimina", () => {
    expect(accionesComprobante(admin, comp("pendiente"))).toMatchObject({ confirmar: true, devolver: true, eliminar: true });
    expect(accionesComprobante(admin, comp("confirmado"))).toMatchObject({ devolver: true });
    expect(accionesComprobante(admin, comp("devuelto"))).toMatchObject({ reenviar: true });
  });

  it("lectura: solo historial", () => {
    for (const e of ["pendiente", "confirmado", "devuelto"] as const) {
      expect(accionesComprobante(lectura, comp(e))).toEqual({
        historial: true,
        confirmar: false,
        devolver: false,
        eliminar: false,
        reenviar: false,
      });
    }
  });
});

describe("textos y utilidades", () => {
  it("etiquetas de estado", () => {
    expect(etiquetaEstado("pendiente")).toBe("Pendiente");
    expect(etiquetaEstado("confirmado")).toBe("Confirmado");
    expect(etiquetaEstado("devuelto")).toBe("Devuelto");
  });

  it("etiquetaPuntoOpcion marca los puntos internos", () => {
    expect(etiquetaPuntoOpcion({ nombre: "Norte", codigo: "PN", es_interna: false })).toBe("Norte (PN)");
    expect(etiquetaPuntoOpcion({ nombre: "Central", codigo: null, es_interna: true })).toBe("Central · interna");
  });

  it("la cedula de firma son 5 a 15 digitos", () => {
    expect(CEDULA_FIRMA_VALIDA.test("12345")).toBe(true);
    expect(CEDULA_FIRMA_VALIDA.test("1234")).toBe(false);
    expect(CEDULA_FIRMA_VALIDA.test("12a45")).toBe(false);
  });

  it("revalidarTraslados invalida toda clave que empiece por la clave de traslados", () => {
    mutateMock.mockClear();
    revalidarTraslados();
    expect(mutateMock).toHaveBeenCalledTimes(1);
    const filtro = mutateMock.mock.calls[0][0] as (k: unknown) => boolean;
    expect(filtro([CLAVE_TRASLADOS, "x"])).toBe(true);
    expect(filtro(["entregas-tabla"])).toBe(false);
    expect(filtro("entregas")).toBe(false);
  });
});
