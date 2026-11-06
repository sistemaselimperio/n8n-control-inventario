import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SWRConfig } from "swr";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  fetchTrasladoDetalle: vi.fn(),
  fetchPuntosPublicos: vi.fn(),
  resolverNovedadDashboard: vi.fn(),
  asignarSyscafeDashboard: vi.fn(),
  subirReporteSyscafeDashboard: vi.fn(),
  anularTrasladoBodega: vi.fn(),
}));
vi.mock("@/lib/api", () => api);
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));
// El formulario de edicion tiene sus propias pruebas: aqui solo se comprueba que se abre.
vi.mock("./ModalTrasladoBodega", () => ({
  ModalTrasladoBodega: ({ traslado }: { traslado?: { id: string } }) => (
    <div role="dialog" aria-label="Editar traslado de bodega">
      editando {traslado?.id}
    </div>
  ),
}));

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

describe("ModalDetalleTraslado: traslado desde bodega", () => {
  const bodega = (extra: Record<string, unknown> = {}) =>
    detalle({
      tipo: "desde_bodega",
      estado: "en_transito",
      numero_talonario: null,
      talonario_id: null,
      numero_syscafe: "NPT-1839",
      numero_documento: "NPT-1839",
      punto_origen_nombre: "BODEGA VENTAS",
      transportador_nombre: "",
      concepto: "SUGERIDO PUENTE 29 OCTUBRE",
      elaboro: "YOHANA",
      pdf_url: "https://x/traslados-bodega/t1.pdf",
      novedad: null,
      novedad_estado: null,
      recibido_at: null,
      recibido_por_nombre: null,
      firma_recibe_url: null,
      items: [
        {
          id: "i1",
          producto: "C. CONTELAC 18 P.",
          marca: "",
          presentacion: "BULTO",
          referencia: "02058",
          precio: 75700,
          cantidad: 15,
          cantidad_recibida: null,
          novedad: null,
          fecha_vencimiento: null,
        },
      ],
      ...extra,
    });

  it("muestra referencia y precio de cada producto, el concepto, la bodega y el PDF", async () => {
    api.fetchTrasladoDetalle.mockResolvedValue(bodega());
    montar(true);
    expect(await screen.findByText("02058")).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Referencia" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Precio" })).toBeInTheDocument();
    expect(screen.getByText(/75\.700/)).toBeInTheDocument();
    expect(screen.getByText("SUGERIDO PUENTE 29 OCTUBRE")).toBeInTheDocument();
    expect(screen.getAllByText(/BODEGA VENTAS/).length).toBeGreaterThan(0);
    expect(screen.getByRole("link", { name: "Ver PDF original" })).toHaveAttribute(
      "href",
      "https://x/traslados-bodega/t1.pdf",
    );
    expect(screen.queryByText("Transportador")).toBeNull();
  });

  it("en transito y con permiso ofrece editar y anular", async () => {
    api.fetchTrasladoDetalle.mockResolvedValue(bodega());
    montar(true);
    expect(await screen.findByRole("button", { name: "Editar traslado" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Anular traslado" })).toBeInTheDocument();
  });

  it.each([
    ["sin permiso", false, {}],
    ["ya recibido", true, { estado: "recibido" }],
    ["anulado", true, { estado: "anulado" }],
  ])("%s no ofrece editar ni anular", async (_n, permiso, extra) => {
    api.fetchTrasladoDetalle.mockResolvedValue(bodega(extra));
    montar(permiso);
    await screen.findByText("02058");
    expect(screen.queryByRole("button", { name: "Editar traslado" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Anular traslado" })).toBeNull();
  });

  it("editar abre el formulario de edicion", async () => {
    api.fetchTrasladoDetalle.mockResolvedValue(bodega());
    montar(true);
    await userEvent.click(await screen.findByRole("button", { name: "Editar traslado" }));
    expect(screen.getByRole("dialog", { name: "Editar traslado de bodega" })).toHaveTextContent("editando t1");
  });

  it("anular exige el motivo y lo manda", async () => {
    api.fetchTrasladoDetalle.mockResolvedValue(bodega());
    api.anularTrasladoBodega.mockResolvedValue({});
    montar(true);
    await userEvent.click(await screen.findByRole("button", { name: "Anular traslado" }));
    const confirmar = screen.getByRole("button", { name: "Confirmar anulación" });
    expect(confirmar).toBeDisabled();
    await userEvent.type(screen.getByLabelText("Motivo de la anulación"), "  Cantidades mal  ");
    expect(confirmar).toBeEnabled();
    await userEvent.click(confirmar);
    await waitFor(() => expect(api.anularTrasladoBodega).toHaveBeenCalledWith("t1", "Cantidades mal"));
    expect(toast.success).toHaveBeenCalled();
  });

  it("si el backend rechaza la anulacion (409) muestra el mensaje", async () => {
    api.fetchTrasladoDetalle.mockResolvedValue(bodega());
    api.anularTrasladoBodega.mockRejectedValue(new Error("Este traslado ya fue recibido y no se puede modificar"));
    montar(true);
    await userEvent.click(await screen.findByRole("button", { name: "Anular traslado" }));
    await userEvent.type(screen.getByLabelText("Motivo de la anulación"), "x");
    await userEvent.click(screen.getByRole("button", { name: "Confirmar anulación" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/ya fue recibido/)));
  });

  it("un traslado anulado muestra el motivo, quien lo anulo y su numero de documento", async () => {
    api.fetchTrasladoDetalle.mockResolvedValue(
      bodega({
        estado: "anulado",
        numero_syscafe: null,
        anulado_motivo: "Cantidades mal",
        anulado_por: "Marta",
        anulado_at: "2026-11-03T10:00:00Z",
      }),
    );
    montar(true);
    expect(await screen.findByText(/Cantidades mal/)).toBeInTheDocument();
    expect(screen.getByText(/Marta/)).toBeInTheDocument();
    expect(screen.getAllByText("NPT-1839").length).toBeGreaterThan(0);
  });
});
