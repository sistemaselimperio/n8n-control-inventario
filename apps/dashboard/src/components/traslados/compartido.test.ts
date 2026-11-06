import { describe, expect, it } from "vitest";
import { empresaTalonario, ESTADOS, fechaCorta, fechaHora, letraTalonario, referencia } from "./compartido";

describe("referencia", () => {
  it("usa el numero de talonario si es anulada o tiene talonario_id", () => {
    expect(referencia({ tipo: "anulada", numero_talonario: "V 120", talonario_id: null, consecutivo: null })).toBe("V 120");
    expect(referencia({ tipo: "traslado", numero_talonario: "A 7", talonario_id: "t1", consecutivo: 3 })).toBe("A 7");
  });

  it("un traslado desde bodega se identifica por el numero de su documento", () => {
    const base = { tipo: "traslado" as const, numero_talonario: null, talonario_id: null, consecutivo: 9 };
    expect(referencia({ ...base, numero_documento: "NPT-1839" })).toBe("NPT-1839");
    expect(referencia({ ...base, numero_documento: null })).toBe("—");
  });

  it("sin documento ni hoja de talonario devuelve un guion largo, nunca TP-", () => {
    expect(referencia({ tipo: "traslado", numero_talonario: "A 7", talonario_id: null, consecutivo: 42 })).toBe("—");
    expect(referencia({ tipo: "traslado", numero_talonario: null, talonario_id: null, consecutivo: null })).toBe("—");
  });
});

describe("ESTADOS", () => {
  it("incluye el estado anulado de los traslados desde bodega", () => {
    expect(ESTADOS.anulado).toEqual({ texto: "Anulado", tono: "neutro" });
  });
});

describe("letra y empresa del talonario", () => {
  const fila = (numero: string | null, talonario_id: string | null = "t1") => ({
    tipo: "traslado" as const,
    numero_talonario: numero,
    talonario_id,
  });

  it("extrae la letra en mayuscula", () => {
    expect(letraTalonario(fila("v 120"))).toBe("V");
    expect(letraTalonario(fila("  A 5"))).toBe("A");
  });

  it("devuelve null en traslados antiguos o sin numero", () => {
    expect(letraTalonario(fila("A 5", null))).toBeNull();
    expect(letraTalonario(fila(null))).toBeNull();
    expect(letraTalonario(fila("120"))).toBeNull();
  });

  it("empresaTalonario segun la letra", () => {
    expect(empresaTalonario(fila("A 1"))).toBe("Comercializadora El Imperio");
    expect(empresaTalonario(fila("V 1"))).toBe("Agroveterinaria La Rebaja");
    expect(empresaTalonario(fila("Z 1"))).toBeNull();
    expect(empresaTalonario(fila("A 1", null))).toBeNull();
  });
});

describe("fechas", () => {
  it("fechaCorta no corre el dia por la zona horaria", () => {
    expect(fechaCorta("2026-10-13")).toBe("13/10/2026");
    expect(fechaCorta("2026-10-13T23:59:00Z")).toBe("13/10/2026");
    expect(fechaCorta("basura")).toBe("basura");
  });

  it("fechaHora con null muestra raya", () => {
    expect(fechaHora(null)).toBe("—");
    expect(fechaHora("2026-10-13T12:00:00Z")).not.toBe("—");
  });
});
