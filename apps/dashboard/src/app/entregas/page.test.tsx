import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SWRConfig } from "swr";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Entrega } from "@/lib/api";
import EntregasPage from "./page";

const nav = vi.hoisted(() => ({ replace: vi.fn(), params: new URLSearchParams() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: nav.replace }),
  usePathname: () => "/entregas",
  useSearchParams: () => nav.params,
}));

const api = vi.hoisted(() => ({
  descargarExport: vi.fn(),
  eliminarTodasLasEntregas: vi.fn(),
  fetchEntregas: vi.fn(),
  fetchLogs: vi.fn(),
  fetchSedes: vi.fn(),
}));
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  ...api,
}));

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

const sesion = vi.hoisted(() => ({ esAdmin: true, puedeEditar: true }));
vi.mock("@/lib/SesionProvider", () => ({ useSesion: () => sesion }));

// El Realtime se prueba aparte (useEntregasEnVivo.test.tsx).
vi.mock("@/lib/useEntregasEnVivo", () => ({
  useEntregasEnVivo: () => ({ enVivo: false, refreshInterval: 0 }),
}));

const entrega = (p: Partial<Entrega>): Entrega => ({
  id: "e1",
  tipo: "FEI",
  indicativo_numero: "100",
  sede_origen_id: "s1",
  sede_origen_nombre: "Sede Centro",
  items: [{ id: "i1", descripcion: "Arroz", cantidad_entregada: 0, cantidad_pendiente: 3 }],
  estado: "procesada",
  operador_id: "op1",
  operador_nombre: "Luis",
  operador_rol: "operador",
  bodeguero_id: null,
  bodeguero_nombre: null,
  confianza_ia: {},
  evidencia_url: "https://fotos.test/1.jpg",
  evidencia_creacion_url: null,
  traslado_tipo: null,
  traslado_indicativo_numero: null,
  capturado_at: "2026-10-01T12:00:00Z",
  nota_general: null,
  ...p,
});

const DATOS: Entrega[] = [
  entrega({ id: "e1", indicativo_numero: "100" }),
  entrega({
    id: "e2",
    tipo: "RM3",
    indicativo_numero: "200",
    items: [{ id: "i2", descripcion: "Aceite", cantidad_entregada: 2, cantidad_pendiente: 0 }],
  }),
  entrega({ id: "e3", indicativo_numero: "300", estado: "pendiente_revision" }),
];

const montar = () =>
  render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <EntregasPage />
    </SWRConfig>,
  );

beforeEach(() => {
  Object.values(api).forEach((f) => f.mockReset());
  api.fetchEntregas.mockResolvedValue(DATOS);
  api.fetchLogs.mockResolvedValue([]);
  api.fetchSedes.mockResolvedValue([{ id: "s1", nombre: "Sede Centro" }]);
  api.descargarExport.mockResolvedValue(undefined);
  toast.success.mockReset();
  toast.error.mockReset();
  nav.replace.mockReset();
  nav.params = new URLSearchParams();
  sesion.esAdmin = true;
  sesion.puedeEditar = true;
});

const tabla = () => screen.getByRole("table");

describe("pagina de entregas: estados de carga", () => {
  it("muestra las entregas del backend", async () => {
    montar();
    await waitFor(() => expect(within(tabla()).getAllByRole("row").length).toBeGreaterThan(3));
    expect(within(tabla()).getByText("200")).toBeInTheDocument();
  });

  it("sin entregas muestra el estado vacio", async () => {
    api.fetchEntregas.mockResolvedValue([]);
    montar();
    expect(await screen.findByText("Sin entregas todavía.")).toBeInTheDocument();
  });

  it("si el backend falla muestra el aviso con la URL y el motivo", async () => {
    api.fetchEntregas.mockRejectedValue(new Error("/entregas respondio 500"));
    montar();
    expect(await screen.findByText(/No se pudo conectar con el backend \(http:\/\/api\.test\)/)).toHaveTextContent(
      "/entregas respondio 500",
    );
  });
});

describe("pagina de entregas: filtros de la URL", () => {
  it("?estado=revision deja solo las pendientes de revision", async () => {
    nav.params = new URLSearchParams("estado=revision");
    montar();
    await waitFor(() => expect(within(tabla()).getByText("300")).toBeInTheDocument());
    expect(within(tabla()).queryByText("100")).toBeNull();
    expect(within(tabla()).queryByText("200")).toBeNull();
  });

  it("?estado=procesada deja solo las completas", async () => {
    nav.params = new URLSearchParams("estado=procesada");
    montar();
    await waitFor(() => expect(within(tabla()).getByText("200")).toBeInTheDocument());
    expect(within(tabla()).queryByText("100")).toBeNull();
    expect(within(tabla()).queryByText("300")).toBeNull();
  });

  it("?flujo=remisiones deja solo RM3/RM2/RSF", async () => {
    nav.params = new URLSearchParams("flujo=remisiones");
    montar();
    await waitFor(() => expect(within(tabla()).getByText("200")).toBeInTheDocument());
    expect(within(tabla()).queryByText("100")).toBeNull();
  });

  it("un valor desconocido en la URL equivale a sin filtro", async () => {
    nav.params = new URLSearchParams("estado=raro&flujo=otro");
    montar();
    await waitFor(() => expect(within(tabla()).getByText("100")).toBeInTheDocument());
    expect(within(tabla()).getByText("200")).toBeInTheDocument();
    expect(within(tabla()).getByText("300")).toBeInTheDocument();
  });
});

describe("pagina de entregas: busqueda y revision", () => {
  it("la busqueda va al backend con debounce y se trae el filtro", async () => {
    montar();
    await waitFor(() => expect(api.fetchEntregas).toHaveBeenCalled());
    await userEvent.type(screen.getByPlaceholderText(/Buscar por tipo/), "FEI 10");
    await waitFor(() => expect(api.fetchEntregas).toHaveBeenCalledWith(expect.objectContaining({ busqueda: "FEI 10", limit: 150 })), {
      timeout: 3000,
    });
    // No se mando una peticion por cada tecla.
    const conBusqueda = api.fetchEntregas.mock.calls.filter(([o]) => o?.busqueda);
    expect(conBusqueda).toHaveLength(1);
  });

  it("clic en una fila pendiente abre la revision y otro clic la cierra", async () => {
    montar();
    const celda = await within(tabla()).findByText("100");
    await userEvent.click(celda);
    expect(await screen.findByText("Revisa estos campos antes de aprobar:")).toBeInTheDocument();
    await userEvent.click(celda);
    expect(screen.queryByText("Revisa estos campos antes de aprobar:")).toBeNull();
  });
});

describe("pagina de entregas: exportar", () => {
  it.each([
    ["Reporte mensual (Excel)", "xlsx"],
    ["Descargar CSV (Excel)", "csv"],
  ])("%s pide el formato %s", async (etiqueta, formato) => {
    montar();
    await userEvent.click(screen.getByRole("button", { name: new RegExp(etiqueta.replace(/[()]/g, "\\$&")) }));
    await waitFor(() => expect(api.descargarExport).toHaveBeenCalledWith(formato));
  });

  it("mientras descarga bloquea ambos botones y los libera al terminar", async () => {
    let terminar: () => void = () => {};
    api.descargarExport.mockReturnValue(new Promise<void>((r) => (terminar = r)));
    montar();
    await userEvent.click(screen.getByRole("button", { name: /Descargar CSV/ }));
    expect(await screen.findByRole("button", { name: "Descargando…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Reporte mensual/ })).toBeDisabled();
    terminar();
    await waitFor(() => expect(screen.getByRole("button", { name: /Descargar CSV/ })).toBeEnabled());
    expect(screen.getByRole("button", { name: /Reporte mensual/ })).toBeEnabled();
  });

  it("si falla avisa con el mensaje del backend y vuelve a habilitar", async () => {
    api.descargarExport.mockRejectedValue(new Error("Sin sesion"));
    montar();
    await userEvent.click(screen.getByRole("button", { name: /Reporte mensual/ }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Sin sesion"));
    expect(screen.getByRole("button", { name: /Reporte mensual/ })).toBeEnabled();
  });
});

describe("pagina de entregas: zona de peligro", () => {
  it("solo la ve el admin", async () => {
    sesion.esAdmin = false;
    montar();
    await screen.findByText("Entregas", { selector: "h1" });
    expect(screen.queryByText("Zona de peligro")).toBeNull();
  });

  it("limpieza total: pide la palabra, borra y muestra el resultado", async () => {
    api.eliminarTodasLasEntregas.mockResolvedValue({ entregas_borradas: 3, logs_borrados: 9 });
    montar();
    await userEvent.click(await screen.findByRole("button", { name: "Eliminar todos los productos" }));
    await userEvent.type(screen.getByLabelText(/Escribe/), "ELIMINAR TODO");
    await userEvent.click(screen.getByRole("button", { name: "Eliminar todo" }));
    await waitFor(() => expect(api.eliminarTodasLasEntregas).toHaveBeenCalledOnce());
    expect(toast.success).toHaveBeenCalledWith("Se eliminaron 3 entregas y 9 logs");
    expect(await screen.findByText(/Última limpieza: 3 entregas y 9 logs borrados/)).toBeInTheDocument();
    expect(screen.queryByLabelText(/Escribe/)).toBeNull();
  });

  it("sin escribir la palabra no se llama al backend", async () => {
    montar();
    await userEvent.click(await screen.findByRole("button", { name: "Eliminar todos los productos" }));
    expect(screen.getByRole("button", { name: "Eliminar todo" })).toBeDisabled();
    expect(api.eliminarTodasLasEntregas).not.toHaveBeenCalled();
  });
});
