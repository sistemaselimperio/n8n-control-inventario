import { describe, expect, it } from "vitest";
import type { FilaTrasladoSyscafe } from "./api";
import { combinarTrasladosDePunto, kpisDePunto, mesDe } from "./puntos";

const fila = (p: Partial<FilaTrasladoSyscafe>): FilaTrasladoSyscafe => ({
  tipo: "traslado",
  id: "t1",
  consecutivo: 1,
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

describe("mesDe", () => {
  it("devuelve AAAA-MM de una fecha ISO", () => {
    expect(mesDe("2026-10-13")).toBe("2026-10");
    expect(mesDe(new Date(2026, 9, 5))).toBe("2026-10");
  });
});

describe("combinarTrasladosDePunto", () => {
  it("une enviados y recibidos sin repetir y marca la direccion", () => {
    const enviado = fila({ id: "a", punto_origen_id: "p1", punto_destino_id: "p2" });
    const recibido = fila({ id: "b", punto_origen_id: "p3", punto_destino_id: "p1", created_at: "2026-10-14T10:00:00Z" });
    // El mismo traslado llega por ambas rutas si el punto se envia a si mismo
    // (o en una llegada directa listada dos veces): no se duplica.
    const directo = fila({ id: "c", punto_origen_id: null, punto_destino_id: "p1", tipo_traslado: "directo" });
    const r = combinarTrasladosDePunto([enviado, directo], [recibido, directo], "p1");
    expect(r.map((f) => f.fila.id)).toEqual(["b", "a", "c"]);
    expect(r.find((f) => f.fila.id === "a")?.direccion).toBe("enviado");
    expect(r.find((f) => f.fila.id === "b")?.direccion).toBe("recibido");
    expect(r.find((f) => f.fila.id === "c")?.direccion).toBe("recibido");
    expect(r).toHaveLength(3);
  });

  it("deja las hojas anuladas como enviadas del punto", () => {
    const anulada = fila({ id: "z", tipo: "anulada", punto_destino_id: null, estado: "anulada" });
    const r = combinarTrasladosDePunto([anulada], [], "p1");
    expect(r[0].direccion).toBe("enviado");
  });
});

describe("kpisDePunto", () => {
  const hoy = "2026-10-20";
  it("cuenta traslados del mes, pendientes de recibir, con novedad y sin Syscafe", () => {
    const filas = combinarTrasladosDePunto(
      [
        fila({ id: "a", fecha: "2026-10-02", numero_syscafe: "NBR-1", estado: "recibido" }),
        fila({ id: "b", fecha: "2026-10-03", numero_syscafe: null, estado: "recibido_con_novedad" }),
        fila({ id: "viejo", fecha: "2026-09-30", numero_syscafe: null, estado: "recibido" }),
        fila({ id: "z", tipo: "anulada", estado: "anulada", punto_destino_id: null, fecha: "2026-10-05" }),
      ],
      [
        fila({ id: "r1", punto_origen_id: "p3", punto_destino_id: "p1", fecha: "2026-10-10", estado: "en_transito", numero_syscafe: null }),
        fila({ id: "r2", punto_origen_id: "p3", punto_destino_id: "p1", fecha: "2026-10-11", estado: "recibido", numero_syscafe: "NBR-7" }),
      ],
      "p1",
    );
    expect(kpisDePunto(filas, "p1", hoy)).toEqual({
      delMes: 4, // a, b, r1, r2 (el viejo es de septiembre; la anulada no es traslado)
      pendientesRecibir: 1, // r1
      conNovedad: 1, // b
      sinSyscafe: 2, // b (enviado) + viejo; r1 es hoja de otro punto, no cuenta
    });
  });

  it("todo en cero cuando no hay traslados", () => {
    expect(kpisDePunto([], "p1", hoy)).toEqual({ delMes: 0, pendientesRecibir: 0, conNovedad: 0, sinSyscafe: 0 });
  });
});
