import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Entrega, ItemEntrega, LogEvent } from "@/lib/api";

const api = vi.hoisted(() => ({ fetchHistorialEntrega: vi.fn(), eliminarEntrega: vi.fn() }));
vi.mock("@/lib/api", () => api);
const sesion = vi.hoisted(() => ({ esAdmin: true }));
vi.mock("@/lib/SesionProvider", () => ({ useSesion: () => sesion }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { ModalDetalleEntrega } from "./ModalDetalleEntrega";

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
  items: [
    item({ id: "i1", descripcion: "Arroz", cantidad_entregada: 6, cantidad_pendiente: 4 }),
    item({ id: "i2", descripcion: "Aceite", cantidad_entregada: 10, cantidad_pendiente: 0 }),
  ],
  estado: "procesada",
  operador_id: "op1",
  operador_nombre: "Ana",
  operador_rol: "operador",
  bodeguero_id: "b1",
  bodeguero_nombre: "Luis",
  confianza_ia: {},
  evidencia_url: "https://x/foto.jpg",
  evidencia_creacion_url: null,
  traslado_tipo: null,
  traslado_indicativo_numero: null,
  capturado_at: "2026-10-01T12:00:00Z",
  nota_general: null,
  ...p,
});

const visita = (p: Partial<LogEvent> = {}): LogEvent => ({
  id: "l1",
  evento: "entrega_actualizada",
  entidad_tipo: "entrega",
  entidad_id: "e1",
  actor_id: "b1",
  actor_nombre: "Luis",
  actor_rol: "bodeguero" as LogEvent["actor_rol"],
  sede_id: "s1",
  resultado: "ok",
  detalle: {},
  timestamp: "2026-10-01T15:00:00Z",
  ...p,
});

const montar = (e: Entrega = entrega()) =>
  render(<ModalDetalleEntrega entrega={e} onCerrar={vi.fn()} onEliminado={vi.fn()} onEditado={vi.fn()} />);

beforeEach(() => {
  sesion.esAdmin = true;
  api.fetchHistorialEntrega.mockReset().mockResolvedValue([visita()]);
});

describe("detalle de entrega", () => {
  it("muestra el avance: unidades entregadas sobre el total y lo pendiente", () => {
    montar();
    const avance = screen.getByRole("region", { name: "Avance" });
    expect(within(avance).getByRole("progressbar")).toHaveAttribute("aria-valuenow", "80");
    expect(within(avance).getByText("16 de 20")).toBeInTheDocument();
    expect(within(avance).getByText(/4 pendientes/)).toBeInTheDocument();
  });

  it("agrupa la informacion en secciones con titulo", () => {
    montar();
    for (const nombre of ["Avance", "Datos", "Productos", "Recorrido"]) {
      expect(screen.getByRole("region", { name: nombre })).toBeInTheDocument();
    }
  });

  it("cada producto muestra lo entregado y lo pendiente", () => {
    montar();
    const productos = screen.getByRole("region", { name: "Productos" });
    const arroz = within(productos).getByText("Arroz").closest("li") as HTMLElement;
    expect(within(arroz).getByText("6")).toBeInTheDocument();
    expect(within(arroz).getByText(/Pendiente 4/)).toBeInTheDocument();
  });

  it("el recorrido lista la captura y cada visita de bodega", async () => {
    montar();
    const recorrido = screen.getByRole("region", { name: "Recorrido" });
    expect(within(recorrido).getByText("Capturado")).toBeInTheDocument();
    expect(await within(recorrido).findByText("Entregado en bodega")).toBeInTheDocument();
  });

  it("el estado va en el encabezado, junto al folio", () => {
    montar();
    const dialogo = screen.getByRole("dialog");
    const encabezado = within(dialogo).getByRole("banner");
    expect(within(encabezado).getByText("Pendiente")).toBeInTheDocument();
  });

  it("la firma va en su propia tarjeta sobre fondo blanco, fuera del carrusel de fotos", () => {
    montar(entrega({ firma_url: "https://x/firma.png", traslado_url: "https://x/traslado.jpg" }));
    const firma = screen.getByRole("region", { name: "Firma del cliente" });
    const img = within(firma).getByAltText("Firma del cliente");
    expect(img).toHaveAttribute("src", "https://x/firma.png");
    expect(img.className).toMatch(/bg-white/);
    // El carrusel solo trae las fotos del documento (foto + traslado).
    expect(screen.getByRole("button", { name: /Ver foto 2 de 2/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Ver foto 3 de/ })).toBeNull();
  });

  it("sin firma no muestra la tarjeta de firma", () => {
    montar();
    expect(screen.queryByRole("region", { name: "Firma del cliente" })).toBeNull();
  });

  it("solo el admin ve Editar y Eliminar", () => {
    const { unmount } = montar();
    expect(screen.getByRole("button", { name: "Editar" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Eliminar" })).toBeInTheDocument();
    unmount();
    sesion.esAdmin = false;
    montar();
    expect(screen.queryByRole("button", { name: "Editar" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Eliminar" })).toBeNull();
  });
});
