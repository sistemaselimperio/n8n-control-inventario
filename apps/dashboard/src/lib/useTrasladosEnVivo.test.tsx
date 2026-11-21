import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { POLLING_EN_VIVO_MS, POLLING_SIN_REALTIME_MS } from "./entregas";
import { useTrasladosEnVivo } from "./useTrasladosEnVivo";

const falso = vi.hoisted(() => ({
  cliente: null as null | Record<string, unknown>,
  manejadores: new Map<string, () => void>(),
  alEstado: null as null | ((s: string) => void),
  canales: [] as unknown[],
  removeChannel: vi.fn(),
}));

function crearCliente() {
  return {
    channel: vi.fn(() => {
      const canal = {
        on: vi.fn((_t: string, filtro: { table: string }, cb: () => void) => {
          falso.manejadores.set(filtro.table, cb);
          return canal;
        }),
        subscribe: vi.fn((cb: (s: string) => void) => {
          falso.alEstado = cb;
          return canal;
        }),
      };
      falso.canales.push(canal);
      return canal;
    }),
    removeChannel: falso.removeChannel,
  };
}

vi.mock("@/lib/supabase", () => ({
  get supabase() {
    return falso.cliente;
  },
}));

const mutateMock = vi.hoisted(() => vi.fn());
vi.mock("swr", async (importOriginal) => ({ ...(await importOriginal<typeof import("swr")>()), mutate: mutateMock }));

beforeEach(() => {
  falso.cliente = crearCliente();
  falso.manejadores.clear();
  falso.alEstado = null;
  falso.canales = [];
  falso.removeChannel.mockReset();
  mutateMock.mockReset();
});

describe("useTrasladosEnVivo", () => {
  it("sin cliente de Supabase usa el polling rapido y no falla", () => {
    falso.cliente = null;
    const { result } = renderHook(() => useTrasladosEnVivo());
    expect(result.current).toEqual({ enVivo: false, refreshInterval: POLLING_SIN_REALTIME_MS });
  });

  it("escucha las tablas traslados y traslado_comprobantes", () => {
    renderHook(() => useTrasladosEnVivo());
    expect([...falso.manejadores.keys()].sort()).toEqual(["traslado_comprobantes", "traslados"]);
  });

  it("un evento revalida las claves de traslados", () => {
    renderHook(() => useTrasladosEnVivo());
    act(() => falso.manejadores.get("traslados")?.());
    act(() => falso.manejadores.get("traslado_comprobantes")?.());
    expect(mutateMock).toHaveBeenCalledTimes(2);
    const filtro = mutateMock.mock.calls[0][0] as (k: unknown) => boolean;
    expect(filtro(["traslados", "comprobantes"])).toBe(true);
    expect(filtro("entregas")).toBe(false);
  });

  it("el intervalo sigue el estado de la suscripcion", () => {
    const { result } = renderHook(() => useTrasladosEnVivo());
    act(() => falso.alEstado?.("SUBSCRIBED"));
    expect(result.current).toEqual({ enVivo: true, refreshInterval: POLLING_EN_VIVO_MS });
    act(() => falso.alEstado?.("CLOSED"));
    expect(result.current).toEqual({ enVivo: false, refreshInterval: POLLING_SIN_REALTIME_MS });
  });

  it("al desmontar quita el canal", () => {
    const { unmount } = renderHook(() => useTrasladosEnVivo());
    unmount();
    expect(falso.removeChannel).toHaveBeenCalledWith(falso.canales[0]);
  });
});
