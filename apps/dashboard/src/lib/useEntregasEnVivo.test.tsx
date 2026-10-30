import { act, render, renderHook, screen, waitFor } from "@testing-library/react";
import useSWR, { SWRConfig } from "swr";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { POLLING_EN_VIVO_MS, POLLING_SIN_REALTIME_MS } from "./entregas";
import { useEntregasEnVivo } from "./useEntregasEnVivo";

type Evento = { event: string; schema: string; table: string };
type Callback = () => void;

// Cliente de Supabase falso: guarda los manejadores por tabla y el callback de
// estado de la suscripcion para poder simular eventos y caidas del socket.
const falso = vi.hoisted(() => {
  const estado = {
    cliente: null as null | Record<string, unknown>,
    manejadores: new Map<string, () => void>(),
    alEstado: null as null | ((s: string) => void),
    canales: [] as unknown[],
    removeChannel: vi.fn(),
    nombresCanal: [] as string[],
  };
  return estado;
});

function crearCliente() {
  return {
    channel: vi.fn((nombre: string) => {
      falso.nombresCanal.push(nombre);
      const canal = {
        on: vi.fn((_tipo: string, filtro: Evento, cb: Callback) => {
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
vi.mock("swr", async (importOriginal) => {
  const original = await importOriginal<typeof import("swr")>();
  return { ...original, mutate: mutateMock };
});

beforeEach(() => {
  falso.cliente = crearCliente();
  falso.manejadores.clear();
  falso.alEstado = null;
  falso.canales = [];
  falso.nombresCanal = [];
  falso.removeChannel.mockReset();
  mutateMock.mockReset();
});

const emitir = (tabla: string) => act(() => falso.manejadores.get(tabla)?.());
const estadoSocket = (s: string) => act(() => falso.alEstado?.(s));

describe("useEntregasEnVivo", () => {
  it("sin cliente de Supabase usa solo el polling rapido y no falla", () => {
    falso.cliente = null;
    const { result } = renderHook(() => useEntregasEnVivo());
    expect(result.current).toEqual({ enVivo: false, refreshInterval: POLLING_SIN_REALTIME_MS });
  });

  it("se suscribe a un canal con entregas y entrega_items (y no a logs por defecto)", () => {
    renderHook(() => useEntregasEnVivo());
    expect(falso.nombresCanal).toEqual(["dashboard-entregas-logs"]);
    expect([...falso.manejadores.keys()].sort()).toEqual(["entrega_items", "entregas"]);
  });

  it("escucha logs solo si se pide", () => {
    renderHook(() => useEntregasEnVivo({ escucharLogs: true }));
    expect([...falso.manejadores.keys()].sort()).toEqual(["entrega_items", "entregas", "logs"]);
  });

  it("enVivo y el intervalo siguen el estado de la suscripcion", () => {
    const { result } = renderHook(() => useEntregasEnVivo());
    expect(result.current.refreshInterval).toBe(POLLING_SIN_REALTIME_MS);
    estadoSocket("SUBSCRIBED");
    expect(result.current).toEqual({ enVivo: true, refreshInterval: POLLING_EN_VIVO_MS });
    // Si el socket se cae, el polling vuelve a ser el rapido (red de seguridad).
    estadoSocket("CHANNEL_ERROR");
    expect(result.current).toEqual({ enVivo: false, refreshInterval: POLLING_SIN_REALTIME_MS });
    estadoSocket("SUBSCRIBED");
    expect(result.current.enVivo).toBe(true);
    estadoSocket("CLOSED");
    expect(result.current.enVivo).toBe(false);
    estadoSocket("TIMED_OUT");
    expect(result.current.enVivo).toBe(false);
  });

  it("un cambio en entregas o entrega_items revalida las claves de entregas", () => {
    renderHook(() => useEntregasEnVivo());
    emitir("entregas");
    emitir("entrega_items");
    expect(mutateMock).toHaveBeenCalledTimes(2);
    const filtro = mutateMock.mock.calls[0][0] as (k: unknown) => boolean;
    expect(filtro("entregas")).toBe(true);
    expect(filtro(["entregas-tabla", "x"])).toBe(true);
    expect(filtro("logs")).toBe(false);
  });

  it("un cambio en logs revalida la clave 'logs'", () => {
    renderHook(() => useEntregasEnVivo({ escucharLogs: true }));
    emitir("logs");
    expect(mutateMock).toHaveBeenCalledWith("logs");
  });

  it("al desmontar quita el canal", () => {
    const { unmount } = renderHook(() => useEntregasEnVivo());
    expect(falso.removeChannel).not.toHaveBeenCalled();
    unmount();
    expect(falso.removeChannel).toHaveBeenCalledTimes(1);
    expect(falso.removeChannel).toHaveBeenCalledWith(falso.canales[0]);
  });

  it("al cambiar escucharLogs reemplaza el canal sin dejar el anterior abierto", () => {
    const { rerender } = renderHook(({ logs }) => useEntregasEnVivo({ escucharLogs: logs }), {
      initialProps: { logs: false },
    });
    rerender({ logs: true });
    expect(falso.removeChannel).toHaveBeenCalledTimes(1);
    expect(falso.canales).toHaveLength(2);
    expect(falso.manejadores.has("logs")).toBe(true);
  });
});

// Integracion con SWR real: el evento realtime fuerza la lectura y, si el
// socket cae, el polling sigue trayendo datos.
describe("consistencia realtime + polling con SWR", () => {
  function Tabla({ cargar }: { cargar: () => Promise<number> }) {
    const { refreshInterval } = useEntregasEnVivo();
    const { data } = useSWR("entregas", cargar, { refreshInterval });
    return <p data-testid="dato">{data ?? "sin datos"}</p>;
  }

  const montar = (cargar: () => Promise<number>) =>
    render(
      <SWRConfig value={{ dedupingInterval: 0 }}>
        <Tabla cargar={cargar} />
      </SWRConfig>,
    );

  it("un evento realtime fuerza la lectura sin esperar al polling", async () => {
    const { mutate: mutateReal } = await vi.importActual<typeof import("swr")>("swr");
    mutateMock.mockImplementation((...args: Parameters<typeof mutateReal>) => mutateReal(...args));
    let n = 0;
    const cargar = vi.fn(async () => ++n);
    montar(cargar);
    await waitFor(() => expect(cargar).toHaveBeenCalled());
    estadoSocket("SUBSCRIBED");
    const antes = cargar.mock.calls.length;
    emitir("entregas");
    await waitFor(() => expect(cargar.mock.calls.length).toBeGreaterThan(antes));
  });

  it("el polling de respaldo (5 s) sigue trayendo datos mientras no hay socket", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      let n = 0;
      const cargar = vi.fn(async () => ++n);
      montar(cargar);
      await waitFor(() => expect(screen.getByTestId("dato")).toHaveTextContent("1"));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(POLLING_SIN_REALTIME_MS + 100);
      });
      expect(cargar.mock.calls.length).toBeGreaterThanOrEqual(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("con el canal suscrito el polling baja a 30 s y se retoma a 5 s si el socket cae", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      let n = 0;
      const cargar = vi.fn(async () => ++n);
      montar(cargar);
      await waitFor(() => expect(cargar).toHaveBeenCalledTimes(1));
      estadoSocket("SUBSCRIBED");
      const antes = cargar.mock.calls.length;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(POLLING_SIN_REALTIME_MS * 3);
      });
      // En vivo: 15 s no alcanzan para el siguiente tick de 30 s.
      expect(cargar.mock.calls.length).toBe(antes);
      estadoSocket("CLOSED");
      await act(async () => {
        await vi.advanceTimersByTimeAsync(POLLING_SIN_REALTIME_MS + 100);
      });
      expect(cargar.mock.calls.length).toBeGreaterThan(antes);
    } finally {
      vi.useRealTimers();
    }
  });
});
