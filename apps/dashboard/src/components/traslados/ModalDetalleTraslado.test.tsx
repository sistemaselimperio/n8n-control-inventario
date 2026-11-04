import { render, screen } from "@testing-library/react";
import { SWRConfig } from "swr";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  fetchTrasladoDetalle: vi.fn(),
  fetchPuntosPublicos: vi.fn(),
  resolverNovedadDashboard: vi.fn(),
  asignarSyscafeDashboard: vi.fn(),
  subirReporteSyscafeDashboard: vi.fn(),
}));
vi.mock("@/lib/api", () => api);
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { ModalDetalleTraslado } from "./ModalDetalleTraslado";

const detalle = (extra: Record<string, unknown> = {}) => ({
  id: "t1",
  consecutivo: 1,
  tipo: "entre_puntos",
  punto_destino_id: "p2",
  numero_talonario: "A 10",
  talonario_id: "k1",
  numero_syscafe: null,
  punto_origen_nombre: "Centro",
  punto_destino_nombre: "Bodega",
  transportador_nombre: "Pedro",
  fecha: "2026-10-13",
  estado: "recibido_con_novedad",
  observaciones: null,
  novedad: "Faltan 3 sacos",
  novedad_estado: "pendiente",
  solucion: null,
  consecutivo_solucion: null,
  solucionado_por_nombre: null,
  solucionado_at: null,
  creado_por_nombre: "Ana",
  created_at: "2026-10-13T10:00:00Z",
  recibido_por_nombre: "Luis",
  recibido_at: "2026-10-13T12:00:00Z",
  declaracion_aceptada_at: "2026-10-13T12:00:00Z",
  firma_recibe_url: "https://x/firma.png",
  items: [],
  ...extra,
});

const montar = (puedeAsignar: boolean) =>
  render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <ModalDetalleTraslado id="t1" puedeAsignar={puedeAsignar} onCerrar={vi.fn()} onCambio={vi.fn()} />
    </SWRConfig>,
  );

beforeEach(() => {
  Object.values(api).forEach((f) => f.mockReset());
  api.fetchPuntosPublicos.mockResolvedValue([{ id: "p2", nombre: "Bodega", codigo: "BDG" }]);
});

describe("ModalDetalleTraslado: resolver novedad", () => {
  it("con permiso y novedad pendiente muestra el formulario", async () => {
    api.fetchTrasladoDetalle.mockResolvedValue(detalle());
    montar(true);
    expect(await screen.findByRole("form", { name: "Resolver novedad" })).toBeInTheDocument();
  });

  it("sin permiso solo muestra la novedad", async () => {
    api.fetchTrasladoDetalle.mockResolvedValue(detalle());
    montar(false);
    expect(await screen.findByText("Faltan 3 sacos")).toBeInTheDocument();
    expect(screen.queryByRole("form", { name: "Resolver novedad" })).toBeNull();
  });

  it("una novedad ya resuelta no ofrece el formulario aunque haya permiso", async () => {
    api.fetchTrasladoDetalle.mockResolvedValue(
      detalle({
        novedad_estado: "resuelta",
        solucion: "Se repuso",
        consecutivo_solucion: "BDG-12",
        solucionado_at: "2026-10-14T10:00:00Z",
      }),
    );
    montar(true);
    expect(await screen.findByText("Se repuso")).toBeInTheDocument();
    expect(screen.queryByRole("form", { name: "Resolver novedad" })).toBeNull();
  });
});

describe("ModalDetalleTraslado: sin constancia ni historial", () => {
  it("no muestra la constancia de recepcion ni el historial, aunque este recibido", async () => {
    api.fetchTrasladoDetalle.mockResolvedValue(detalle());
    montar(true);
    expect(await screen.findByText("Faltan 3 sacos")).toBeInTheDocument();
    expect(screen.queryByText("Constancia de recepción")).toBeNull();
    expect(screen.queryByText(/Aceptó revisión producto por producto/)).toBeNull();
    expect(screen.queryByRole("heading", { name: "Historial" })).toBeNull();
    expect(screen.queryByText("Traslado enviado")).toBeNull();
    expect(screen.queryByText("Traslado recibido")).toBeNull();
    expect(screen.queryByAltText("Firma de quien recibe")).toBeNull();
  });
});
