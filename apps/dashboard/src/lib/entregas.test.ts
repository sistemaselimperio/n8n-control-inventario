import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Entrega, ItemEntrega, LogEvent } from "./api";
import {
  describirCambioAdmin,
  describirEvento,
  datetimeLocalAIso,
  esActorDashboard,
  esCorreccionAdmin,
  esHoy,
  estadoVisual,
  fechasCalendarioAISO,
  formatearFechaHora,
  historialDeItem,
  isoADatetimeLocal,
  motivoDevolucionLegible,
  motivoNoEntregadoLegible,
  nombreActorAdmin,
  nombreBodeguero,
  nombreSedeCorto,
  sumar,
  tienePendiente,
} from "./entregas";

const item = (p: Partial<ItemEntrega> = {}): ItemEntrega => ({
  id: "i1",
  descripcion: "Arroz",
  cantidad_entregada: 0,
  cantidad_pendiente: 0,
  ...p,
});

const entrega = (p: Partial<Entrega> = {}): Entrega => ({
  id: "e1",
  tipo: "FEI",
  indicativo_numero: "10254",
  sede_origen_id: "s1",
  sede_origen_nombre: "Sede Centro",
  items: [item()],
  estado: "procesada",
  operador_id: "op1",
  operador_nombre: null,
  operador_rol: null,
  bodeguero_id: null,
  bodeguero_nombre: null,
  confianza_ia: {},
  evidencia_url: "",
  evidencia_creacion_url: null,
  traslado_tipo: null,
  traslado_indicativo_numero: null,
  capturado_at: "2026-10-01T12:00:00Z",
  nota_general: null,
  ...p,
});

const log = (p: Partial<LogEvent> = {}): LogEvent => ({
  id: "l1",
  evento: "entrega_actualizada",
  entidad_tipo: "entrega",
  entidad_id: "e1",
  actor_id: "op1",
  sede_id: "s1",
  resultado: "ok",
  detalle: {},
  timestamp: "2026-10-01T12:00:00Z",
  ...p,
});

describe("calculos de entregas", () => {
  it("sumar totaliza el campo pedido", () => {
    const items = [item({ cantidad_entregada: 2, cantidad_pendiente: 5 }), item({ cantidad_entregada: 3, cantidad_pendiente: 0 })];
    expect(sumar(items, "cantidad_entregada")).toBe(5);
    expect(sumar(items, "cantidad_pendiente")).toBe(5);
    expect(sumar([], "cantidad_entregada")).toBe(0);
  });

  it("tienePendiente", () => {
    expect(tienePendiente(entrega({ items: [item({ cantidad_pendiente: 1 })] }))).toBe(true);
    expect(tienePendiente(entrega({ items: [item(), item()] }))).toBe(false);
    expect(tienePendiente(entrega({ items: [] }))).toBe(false);
  });

  it("nombreSedeCorto quita el prefijo Sede sin tocar otros nombres", () => {
    expect(nombreSedeCorto("Sede Centro")).toBe("Centro");
    expect(nombreSedeCorto("sede  Polo Sur")).toBe("Polo Sur");
    expect(nombreSedeCorto("Sedena")).toBe("Sedena");
    expect(nombreSedeCorto(null)).toBeNull();
  });

  it("estadoVisual separa Procesada de Pendiente", () => {
    expect(estadoVisual(entrega({ estado: "pendiente_revision" }))).toEqual({ etiqueta: "Pendiente de revisión", tono: "warn" });
    expect(estadoVisual(entrega({ estado: "duplicado_bloqueado" }))).toEqual({ etiqueta: "Duplicado bloqueado", tono: "error" });
    expect(estadoVisual(entrega({ items: [item({ cantidad_pendiente: 2 })] }))).toEqual({ etiqueta: "Pendiente", tono: "warn" });
    expect(estadoVisual(entrega())).toEqual({ etiqueta: "Procesada", tono: "ok" });
  });

  it("esActorDashboard", () => {
    expect(esActorDashboard("dashboard:ana")).toBe(true);
    expect(esActorDashboard("supervisor")).toBe(true);
    expect(esActorDashboard("op1")).toBe(false);
    expect(esActorDashboard(null)).toBe(false);
    expect(esActorDashboard(undefined)).toBe(false);
  });

  it("nombreBodeguero nunca muestra al usuario del dashboard", () => {
    expect(nombreBodeguero(entrega({ bodeguero_nombre: "Luis", bodeguero_id: "b1" }))).toBe("Luis");
    expect(nombreBodeguero(entrega({ bodeguero_id: "dashboard:ana" }))).toBe("NE");
    expect(nombreBodeguero(entrega({ bodeguero_id: null }))).toBe("NE");
    expect(nombreBodeguero(entrega({ bodeguero_id: "b1" }))).toBe("b1");
  });
});

describe("fechas", () => {
  afterEach(() => vi.useRealTimers());

  it("esHoy compara con el dia actual", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 30, 15, 0, 0));
    expect(esHoy(new Date(2026, 9, 30, 1, 0, 0).toISOString())).toBe(true);
    expect(esHoy(new Date(2026, 9, 29, 23, 59, 0).toISOString())).toBe(false);
    expect(esHoy(null)).toBe(false);
    expect(esHoy(undefined)).toBe(false);
  });

  it("fechasCalendarioAISO lleva hasta al final del dia local", () => {
    const r = fechasCalendarioAISO("2026-10-01", "2026-10-02");
    expect(r.desde).toBe(new Date(2026, 9, 1).toISOString());
    expect(r.hasta).toBe(new Date(2026, 9, 2, 23, 59, 59, 999).toISOString());
  });

  it("fechasCalendarioAISO omite lo vacio", () => {
    expect(fechasCalendarioAISO("", "")).toEqual({});
    expect(fechasCalendarioAISO("2026-10-01", "")).toEqual({ desde: new Date(2026, 9, 1).toISOString() });
  });

  it("isoADatetimeLocal y datetimeLocalAIso son inversos en hora local", () => {
    const local = new Date(2026, 9, 30, 8, 5);
    const iso = local.toISOString();
    expect(isoADatetimeLocal(iso)).toBe("2026-10-30T08:05");
    expect(datetimeLocalAIso("2026-10-30T08:05")).toBe(iso);
  });

  it("isoADatetimeLocal y datetimeLocalAIso toleran vacios e invalidos", () => {
    expect(isoADatetimeLocal(null)).toBe("");
    expect(isoADatetimeLocal("basura")).toBe("");
    expect(datetimeLocalAIso("")).toBeUndefined();
    expect(datetimeLocalAIso("basura")).toBeUndefined();
  });

  it("formatearFechaHora usa la zona de Colombia sin importar la del navegador", () => {
    // 13:00 UTC = 8:00 a. m. en Bogota (UTC-5, sin horario de verano).
    const texto = formatearFechaHora("2026-09-28T13:00:00Z");
    expect(texto).toMatch(/28/);
    expect(texto).toMatch(/8:00/);
    // 02:00 UTC sigue siendo el dia anterior en Colombia.
    expect(formatearFechaHora("2026-09-28T02:00:00Z")).toMatch(/27/);
    expect(formatearFechaHora(null)).toBe("—");
    expect(formatearFechaHora(undefined)).toBe("—");
  });
});

describe("motivos legibles", () => {
  it("motivoNoEntregadoLegible", () => {
    expect(motivoNoEntregadoLegible("facturado_de_mas")).toBe("Facturado de más");
    expect(motivoNoEntregadoLegible("otro", "se mojo")).toBe("se mojo");
    expect(motivoNoEntregadoLegible("otro")).toBe("Otro");
    expect(motivoNoEntregadoLegible("raro")).toBe("raro");
    expect(motivoNoEntregadoLegible(undefined)).toBe("sin motivo");
  });

  it("motivoDevolucionLegible", () => {
    expect(motivoDevolucionLegible("danado")).toBe("Dañado");
    expect(motivoDevolucionLegible("otro", "roto")).toBe("roto");
    expect(motivoDevolucionLegible("x")).toBe("x");
    expect(motivoDevolucionLegible(undefined)).toBe("sin motivo");
  });
});

describe("correcciones del admin", () => {
  it("esCorreccionAdmin reconoce logs nuevos y viejos", () => {
    expect(esCorreccionAdmin(log({ evento: "revision_manual_aprobada" }))).toBe(true);
    expect(esCorreccionAdmin(log({ detalle: { correccion_dashboard: true } }))).toBe(true);
    expect(esCorreccionAdmin(log({ sede_id: "dashboard" }))).toBe(true);
    expect(esCorreccionAdmin(log({ actor_id: "dashboard:ana" }))).toBe(true);
    expect(esCorreccionAdmin(log())).toBe(false);
    expect(esCorreccionAdmin(log({ evento: "devolucion_registrada", sede_id: "dashboard" }))).toBe(false);
  });

  it("nombreActorAdmin", () => {
    expect(nombreActorAdmin(log({ actor_id: "dashboard:ana" }))).toBe("ana");
    expect(nombreActorAdmin(log({ actor_id: "x", actor_nombre: "Luis" }))).toBe("Luis");
    expect(nombreActorAdmin(log({ actor_id: "x" }))).toBe("x");
  });

  it("describirCambioAdmin", () => {
    expect(describirCambioAdmin({ campo: "tipo", antes: "FEI", despues: "FV1" })).toBe("Tipo: FEI → FV1");
    expect(describirCambioAdmin({ campo: "cantidad_pendiente", antes: 3, despues: 1, producto: "Arroz" })).toBe(
      "Arroz: Pendiente: 3 → 1",
    );
    // En el cambio de nombre no se repite el producto como prefijo.
    expect(describirCambioAdmin({ campo: "descripcion", antes: "A", despues: "B", producto: "A" })).toBe("Nombre: A → B");
    expect(describirCambioAdmin({ campo: "otro", antes: "", despues: "x" })).toBe("otro: — → x");
  });
});

describe("historialDeItem", () => {
  it("ordena por fecha y filtra solo el item pedido", () => {
    const hist = [
      log({
        id: "b",
        timestamp: "2026-10-02T10:00:00Z",
        detalle: { items: [{ id: "i1", cantidad_entregada: 5, cantidad_pendiente: 0 }] },
      }),
      log({
        id: "a",
        timestamp: "2026-10-01T10:00:00Z",
        detalle: {
          items: [
            { id: "i1", cantidad_entregada: 2, cantidad_pendiente: 3 },
            { id: "i2", cantidad_entregada: 9, cantidad_pendiente: 9 },
          ],
          retirado_por: { nombre: "Pedro", telefono: "300" },
        },
      }),
    ];
    const r = historialDeItem(hist, "i1");
    expect(r.map((e) => e.texto)).toEqual([
      "Entregado 2, pendiente 3. Retirado por Pedro (300)",
      "Entregado 5, pendiente 0",
    ]);
  });

  it("marca las correcciones del admin", () => {
    const r = historialDeItem(
      [
        log({
          actor_id: "dashboard:ana",
          detalle: { items: [{ id: "i1", cantidad_entregada: 1, cantidad_pendiente: 1 }] },
        }),
      ],
      "i1",
    );
    expect(r[0].texto).toBe("Corrección de ana. Entregado 1, pendiente 1");
  });

  it("incluye devoluciones y no entregados del item", () => {
    const r = historialDeItem(
      [
        log({
          evento: "devolucion_registrada",
          timestamp: "2026-10-01T10:00:00Z",
          detalle: { item_id: "i1", cantidad: 2, motivo: "danado", resolucion: "reposicion" },
        }),
        log({
          evento: "devolucion_registrada",
          timestamp: "2026-10-01T11:00:00Z",
          detalle: { item_id: "otro", cantidad: 1, motivo: "danado", resolucion: "reposicion" },
        }),
        log({
          evento: "item_no_entregado",
          timestamp: "2026-10-01T12:00:00Z",
          detalle: { item_id: "i1", cantidad: 4, motivo: "otro", motivo_detalle: "sin stock" },
        }),
      ],
      "i1",
    );
    expect(r.map((e) => e.texto)).toEqual([
      "Devolución de 2 (Dañado) — repuesto",
      "No se entrega 4 (sin stock)",
    ]);
  });

  it("no revienta con detalle ausente", () => {
    expect(historialDeItem([log({ detalle: undefined as unknown as Record<string, unknown> })], "i1")).toEqual([]);
  });
});

describe("describirEvento", () => {
  const mapa = new Map([["e1", entrega()]]);

  it("entrega insertada con documento y sede", () => {
    expect(describirEvento(log({ evento: "entrega_insertada" }), mapa)).toBe(
      "Nueva entrega registrada — FEI 10254 en Sede Centro.",
    );
  });

  it("sin la entrega cargada usa el id de sede y omite el documento", () => {
    expect(describirEvento(log({ evento: "entrega_insertada", entidad_id: "x" }), mapa)).toBe(
      "Nueva entrega registrada en s1.",
    );
  });

  it("confirmacion de cantidades suma lo pendiente y cuenta puntos de venta", () => {
    const texto = describirEvento(
      log({
        detalle: {
          items: [{ cantidad_pendiente: 2, desde_punto_venta: true }, { cantidad_pendiente: 1 }],
          retirado_por: { nombre: "Pedro", telefono: "300" },
        },
      }),
      mapa,
    );
    expect(texto).toContain("Se confirmaron cantidades de FEI 10254 — quedan 3 pendientes.");
    expect(texto).toContain("Retiró Pedro (300).");
    expect(texto).toContain("Además, 1 producto entregado en el punto de venta");
  });

  it("correccion del admin cuenta los cambios en singular y plural", () => {
    const base = { actor_id: "dashboard:ana" };
    expect(describirEvento(log({ ...base, detalle: { cambios: [{}] } }), mapa)).toBe(
      "ana corrigió FEI 10254 desde el dashboard (1 cambio).",
    );
    expect(describirEvento(log({ ...base, detalle: { cambios: [{}, {}] } }), mapa)).toBe(
      "ana corrigió FEI 10254 desde el dashboard (2 cambios).",
    );
  });

  it("entregado todo desde punto de venta y otra bodega", () => {
    expect(describirEvento(log({ actor_nombre: "Luis", detalle: { desde_punto_venta: true } }), mapa)).toBe(
      "Entregado todo desde el punto de venta — FEI 10254 (registró Luis).",
    );
    expect(describirEvento(log({ detalle: { desde_otra_bodega: true } }), mapa)).toContain("desde otra bodega");
  });

  it("devolucion, no entregado, duplicado, revision y cancelacion", () => {
    expect(
      describirEvento(
        log({ evento: "devolucion_registrada", detalle: { cantidad: 2, motivo: "danado", resolucion: "no_lo_lleva" } }),
        mapa,
      ),
    ).toBe("Devolución en FEI 10254 de 2 unidades (Dañado) — el cliente no lo lleva.");
    expect(
      describirEvento(
        log({ evento: "item_no_entregado", detalle: { cantidad: 1, producto: "Arroz", motivo: "producto_equivocado" } }),
        mapa,
      ),
    ).toBe("No se entregaron 1 de Arroz en FEI 10254 (Producto equivocado).");
    expect(
      describirEvento(log({ evento: "duplicado_bloqueado", detalle: { tipo: "FEI", indicativo_numero: "1" } }), mapa),
    ).toContain('Se bloqueó un reintento de "FEI 1"');
    expect(describirEvento(log({ evento: "revision_manual_aprobada" }), mapa)).toBe(
      "Un supervisor aprobó la revisión de FEI 10254.",
    );
    expect(describirEvento(log({ evento: "entrega_cancelada" }), mapa)).toContain("Se canceló una captura de FEI 10254");
    expect(describirEvento(log({ evento: "health_check_fallido" }), mapa)).toContain("Aviso técnico");
  });

  it("eventos tecnicos devuelven null", () => {
    for (const evento of ["foto_capturada", "extraccion_ia", "chequeo_duplicado", "sync_tiempo_real", "turnos_generados"]) {
      expect(describirEvento(log({ evento }), mapa)).toBeNull();
    }
  });
});

describe("revalidarEntregas", () => {
  const mutate = vi.fn();

  beforeEach(() => {
    vi.resetModules();
    mutate.mockReset();
    vi.doMock("swr", () => ({ mutate }));
  });

  afterEach(() => vi.doUnmock("swr"));

  it("revalida 'entregas' y las variantes filtradas de la tabla, nada mas", async () => {
    const { revalidarEntregas } = await import("./entregas");
    revalidarEntregas();
    const filtro = mutate.mock.calls[0][0] as (k: unknown) => boolean;
    expect(filtro("entregas")).toBe(true);
    expect(filtro(["entregas-tabla", "s1"])).toBe(true);
    expect(filtro("logs")).toBe(false);
    expect(filtro(["otra", "x"])).toBe(false);
  });
});
