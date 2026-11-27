import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SWRConfig } from "swr";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Comprobante, Traslado } from "@/lib/api";
import type { UsuarioDashboard } from "@/lib/sesion";
import TrasladosPage from "./page";

const api = vi.hoisted(() => ({
  fetchTrasladoPuntos: vi.fn(),
  fetchComprobantes: vi.fn(),
  fetchComprobante: vi.fn(),
  fetchTraslados: vi.fn(),
  enviarTraslado: vi.fn(),
  eliminarTraslado: vi.fn(),
  subirTraslados: vi.fn(),
  devolverComprobante: vi.fn(),
  confirmarComprobante: vi.fn(),
  reenviarComprobante: vi.fn(),
  actualizarTraslado: vi.fn(),
  fetchReceptoresPunto: vi.fn(),
}));
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  ...api,
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));
const sesion = vi.hoisted(() => ({ usuario: null as unknown }));
vi.mock("@/lib/SesionProvider", () => ({
  useSesion: () => ({ usuario: sesion.usuario, esAdmin: (sesion.usuario as { rol: string })?.rol === "admin" }),
}));

const usuario = (parcial: Partial<UsuarioDashboard>): UsuarioDashboard => ({
  id: "u1",
  usuario: "u",
  nombre: "Laura Perez",
  rol: "supervisor",
  area: "traslados",
  punto_id: null,
  cedula: "1002003004",
  ...parcial,
});
const ADMIN = usuario({ rol: "admin", area: "todo" });
const ENCARGADA = usuario({});
const PUNTO = usuario({ punto_id: "p1" });
const LECTURA = usuario({ rol: "consulta" });

const comp = (parcial: Partial<Comprobante>): Comprobante => ({
  id: "c1",
  traslado_id: "t1",
  numero: "FV 100",
  tipo: "salida",
  punto_id: "p1",
  punto_nombre: "Punto Norte",
  punto_codigo: "PN",
  estado: "pendiente",
  responsable_usuario_id: null,
  responsable_nombre: null,
  responsable_cedula: null,
  firma_url: null,
  observacion: null,
  motivo_devolucion: null,
  resuelto_at: null,
  creado_at: "2026-11-01T10:00:00Z",
  actualizado_at: "2026-11-01T10:00:00Z",
  archivo_nombre: "fv100.pdf",
  pdf_url: "http://x/fv100.pdf",
  fecha: "2026-11-01",
  concepto: null,
  ...parcial,
});

const PENDIENTE = comp({});
const CONFIRMADO = comp({
  id: "c2",
  traslado_id: "t2",
  numero: "FV 200",
  tipo: "ingreso",
  estado: "confirmado",
  responsable_nombre: "Marta Ruiz",
  responsable_cedula: "555666777",
  firma_url: "http://x/firma.png",
  archivo_nombre: "fv200.pdf",
  pdf_url: "http://x/fv200.pdf",
});
const DEVUELTO = comp({
  id: "c3",
  traslado_id: "t3",
  numero: "FV 300",
  estado: "devuelto",
  responsable_nombre: "Pedro Gil",
  responsable_cedula: "888999000",
  motivo_devolucion: "Cantidad errada",
  archivo_nombre: "fv300.pdf",
  pdf_url: "http://x/fv300.pdf",
});

const BORRADOR = {
  id: "b1",
  numero: "FV 400",
  archivo_nombre: "borrador400.pdf",
  pdf_url: "http://x/b400.pdf",
  estado: "borrador",
  advertencias: ["No se reconoció el destino"],
  fecha: "2026-11-03",
  concepto: "Mercancia",
  elaboro: null,
  origen_texto: "Bodega Central",
  destino_texto: "Pnto Nrte",
  origen_punto_id: null,
  origen_punto: null,
  destino_punto_id: null,
  destino_punto: null,
  creado_por: null,
  creado_at: "",
  actualizado_at: "",
  enviado_at: null,
  comprobantes: [],
} as Traslado;

const PUNTOS = [
  { id: "p1", nombre: "Punto Norte", codigo: "PN", es_interna: false },
  { id: "p2", nombre: "Bodega Central", codigo: "BC", es_interna: true },
];

function montar(u: UsuarioDashboard | null) {
  sesion.usuario = u;
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <TrasladosPage />
    </SWRConfig>,
  );
}

const tabla = (nombre: string) => screen.getByRole("table", { name: nombre });
const fila = (nombreTabla: string, texto: string) =>
  within(tabla(nombreTabla)).getByText(texto).closest("tr") as HTMLElement;

async function esperarFila(nombreTabla: string, texto: string) {
  const t = await screen.findByRole("table", { name: nombreTabla });
  return within(t).findByText(texto);
}

beforeEach(() => {
  Object.values(api).forEach((f) => f.mockReset());
  toast.success.mockReset();
  toast.error.mockReset();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  api.fetchTrasladoPuntos.mockResolvedValue(PUNTOS);
  api.fetchComprobantes.mockImplementation(async (f: { estado?: string; limit?: number }) => {
    if (f.limit === 1) return { total: 3, items: [] };
    if (f.estado === "devuelto") return { total: 1, items: [DEVUELTO] };
    return { total: 2, items: [PENDIENTE, CONFIRMADO] };
  });
  api.fetchTraslados.mockResolvedValue({ total: 1, items: [BORRADOR] });
  api.fetchComprobante.mockResolvedValue(
    comp({ historial: [{ evento: "enviado", actor: "Ana", resultado: "ok", detalle: "Envio inicial", timestamp: "2026-11-01T10:00:00Z" }] }),
  );
});

describe("acceso", () => {
  it("el area sin acceso no ve el modulo ni consulta datos", () => {
    montar(usuario({ area: "bodega" }));
    expect(screen.getByText(/no tiene acceso/i)).toBeInTheDocument();
    expect(api.fetchComprobantes).not.toHaveBeenCalled();
  });
});

describe("admin y encargada", () => {
  it("ven la carga de PDF, los borradores, los devueltos y la tabla de comprobantes", async () => {
    montar(ADMIN);
    expect(screen.getByRole("heading", { name: "Traslados" })).toBeInTheDocument();
    expect(screen.getByLabelText("Seleccionar PDFs")).toBeInTheDocument();
    expect(await screen.findByText("borrador400.pdf")).toBeInTheDocument();
    expect(await esperarFila("Bandeja de devueltos", "FV 300")).toBeInTheDocument();
    expect(await esperarFila("Comprobantes", "FV 100")).toBeInTheDocument();
  });

  it("la tabla muestra punto, movimiento, estado y responsable con cedula", async () => {
    montar(ADMIN);
    await esperarFila("Comprobantes", "FV 200");
    const f2 = fila("Comprobantes", "FV 200");
    expect(within(f2).getByText("Punto Norte")).toBeInTheDocument();
    expect(within(f2).getByText("Ingreso")).toBeInTheDocument();
    expect(within(f2).getByText("Confirmado")).toBeInTheDocument();
    expect(within(f2).getByText("Marta Ruiz")).toBeInTheDocument();
    expect(within(f2).getByText(/C\.C\. 555666777/)).toBeInTheDocument();
    const f1 = fila("Comprobantes", "FV 100");
    expect(within(f1).getByText("Salida")).toBeInTheDocument();
    expect(within(f1).getByText("Pendiente")).toBeInTheDocument();
    expect(within(f1).queryByRole("button", { name: "Ver firma" })).toBeNull();
  });

  it("Ver firma abre la imagen y el nombre del archivo abre el PDF en un visor", async () => {
    montar(ADMIN);
    await esperarFila("Comprobantes", "FV 200");
    const f2 = fila("Comprobantes", "FV 200");
    await userEvent.click(within(f2).getByRole("button", { name: "Ver firma" }));
    expect(screen.getByRole("img", { name: /Firma/ })).toHaveAttribute("src", "http://x/firma.png");
    await userEvent.keyboard("{Escape}");
    await userEvent.click(within(f2).getByRole("button", { name: "fv200.pdf" }));
    expect(screen.getByTitle("fv200.pdf")).toHaveAttribute("src", "http://x/fv200.pdf");
  });

  it("los filtros consultan al backend con estado, tipo y punto", async () => {
    montar(ADMIN);
    await esperarFila("Comprobantes", "FV 100");
    await userEvent.selectOptions(screen.getByLabelText("Estado"), "confirmado");
    await waitFor(() =>
      expect(api.fetchComprobantes).toHaveBeenCalledWith(expect.objectContaining({ estado: "confirmado", limit: 50 })),
    );
    await userEvent.selectOptions(screen.getByLabelText("Movimiento"), "salida");
    await waitFor(() => expect(api.fetchComprobantes).toHaveBeenCalledWith(expect.objectContaining({ tipo: "salida" })));
    await userEvent.selectOptions(screen.getByLabelText("Punto"), "p2");
    await waitFor(() => expect(api.fetchComprobantes).toHaveBeenCalledWith(expect.objectContaining({ punto_id: "p2" })));
  });

  it("la busqueda por numero o archivo se manda al backend", async () => {
    montar(ADMIN);
    await esperarFila("Comprobantes", "FV 100");
    await userEvent.type(screen.getByLabelText("Buscar por número o archivo"), "fv2");
    await waitFor(() => expect(api.fetchComprobantes).toHaveBeenCalledWith(expect.objectContaining({ q: "fv2" })));
  });

  it("Historial abre la linea de tiempo del comprobante", async () => {
    montar(ADMIN);
    await esperarFila("Comprobantes", "FV 100");
    await userEvent.click(within(fila("Comprobantes", "FV 100")).getByRole("button", { name: "Historial" }));
    expect(await screen.findByText("Envio inicial")).toBeInTheDocument();
    expect(api.fetchComprobante).toHaveBeenCalledWith("c1");
  });

  it("Devolver solo aparece en confirmados para la encargada, y pide motivo", async () => {
    montar(ENCARGADA);
    await esperarFila("Comprobantes", "FV 100");
    expect(within(fila("Comprobantes", "FV 100")).queryByRole("button", { name: "Devolver" })).toBeNull();
    expect(within(fila("Comprobantes", "FV 100")).queryByRole("button", { name: "Confirmar" })).toBeNull();
    api.devolverComprobante.mockResolvedValue(CONFIRMADO);
    await userEvent.click(within(fila("Comprobantes", "FV 200")).getByRole("button", { name: "Devolver" }));
    await userEvent.type(screen.getByLabelText(/Motivo/), "Firma ilegible");
    await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Devolver" }));
    await waitFor(() => expect(api.devolverComprobante).toHaveBeenCalledWith("c2", "Firma ilegible", undefined));
  });

  it("Eliminar pide confirmacion en un modal y borra el traslado completo", async () => {
    api.eliminarTraslado.mockResolvedValue({ ok: true, archivos_borrados: 1 });
    montar(ADMIN);
    await esperarFila("Comprobantes", "FV 100");
    await userEvent.click(within(fila("Comprobantes", "FV 100")).getByRole("button", { name: "Eliminar" }));
    expect(api.eliminarTraslado).not.toHaveBeenCalled();
    expect(screen.getByText(/no se puede deshacer/i)).toBeInTheDocument();
    const dialogo = screen.getByRole("dialog", { name: "Eliminar traslado" });
    await userEvent.click(within(dialogo).getByRole("button", { name: "Eliminar traslado" }));
    await waitFor(() => expect(api.eliminarTraslado).toHaveBeenCalledWith("t1"));
    expect(toast.success).toHaveBeenCalledWith("Traslado eliminado");
  });

  describe("borradores", () => {
    it("muestran advertencias y lo leido del PDF", async () => {
      montar(ADMIN);
      const tarjeta = (await screen.findByText("borrador400.pdf")).closest("article") as HTMLElement;
      expect(within(tarjeta).getByText("No se reconoció el destino")).toBeInTheDocument();
      expect(within(tarjeta).getByText("FV 400")).toBeInTheDocument();
    });

    it("Enviar a los puntos avisa el exito", async () => {
      api.enviarTraslado.mockResolvedValue({});
      montar(ADMIN);
      const tarjeta = (await screen.findByText("borrador400.pdf")).closest("article") as HTMLElement;
      await userEvent.click(within(tarjeta).getByRole("button", { name: "Enviar a los puntos" }));
      await waitFor(() => expect(api.enviarTraslado).toHaveBeenCalledWith("b1"));
      expect(toast.success).toHaveBeenCalledWith("Traslado enviado a los puntos");
    });

    it("un 422 muestra las advertencias dentro de la tarjeta", async () => {
      const { ErrorTraslado } = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
      api.enviarTraslado.mockRejectedValue(new ErrorTraslado("No se puede enviar", 422, ["Falta el punto de destino", "Falta la fecha"]));
      montar(ADMIN);
      const tarjeta = (await screen.findByText("borrador400.pdf")).closest("article") as HTMLElement;
      await userEvent.click(within(tarjeta).getByRole("button", { name: "Enviar a los puntos" }));
      expect(await within(tarjeta).findByText("No se puede enviar")).toBeInTheDocument();
      expect(within(tarjeta).getByText("Falta el punto de destino")).toBeInTheDocument();
      expect(within(tarjeta).getByText("Falta la fecha")).toBeInTheDocument();
    });

    it("Editar abre el modal con los puntos", async () => {
      montar(ADMIN);
      const tarjeta = (await screen.findByText("borrador400.pdf")).closest("article") as HTMLElement;
      await userEvent.click(within(tarjeta).getByRole("button", { name: "Editar" }));
      const dialogo = screen.getByRole("dialog", { name: "Editar borrador" });
      expect(within(dialogo).getByLabelText("Número")).toHaveValue("FV 400");
      // Origen y destino ofrecen los puntos, con la marca de interna.
      expect(within(dialogo).getAllByRole("option", { name: /Bodega Central.*interna/ })).toHaveLength(2);
    });
  });

  describe("bandeja de devueltos", () => {
    it("muestra punto, numero, responsable con cedula y motivo", async () => {
      montar(ADMIN);
      await esperarFila("Bandeja de devueltos", "FV 300");
      const f = fila("Bandeja de devueltos", "FV 300");
      expect(within(f).getByText("Punto Norte")).toBeInTheDocument();
      expect(within(f).getByText("Pedro Gil")).toBeInTheDocument();
      expect(within(f).getByText(/C\.C\. 888999000/)).toBeInTheDocument();
      expect(within(f).getByText("Cantidad errada")).toBeInTheDocument();
    });

    it("tiene Historial, Corregir y reenviar y Eliminar traslado", async () => {
      montar(ADMIN);
      await esperarFila("Bandeja de devueltos", "FV 300");
      const f = fila("Bandeja de devueltos", "FV 300");
      expect(within(f).getByRole("button", { name: "Historial" })).toBeInTheDocument();
      expect(within(f).getByRole("button", { name: "Eliminar traslado" })).toBeInTheDocument();
      await userEvent.click(within(f).getByRole("button", { name: "Corregir y reenviar" }));
      expect(screen.getByRole("dialog", { name: "Corregir y reenviar" })).toBeInTheDocument();
    });
  });
});

describe("usuario de punto", () => {
  it("no ve carga, borradores ni devueltos, y no consulta esos datos", async () => {
    montar(PUNTO);
    await esperarFila("Comprobantes", "FV 100");
    expect(screen.queryByLabelText("Seleccionar PDFs")).toBeNull();
    expect(screen.queryByText("borrador400.pdf")).toBeNull();
    expect(screen.queryByRole("table", { name: "Bandeja de devueltos" })).toBeNull();
    expect(api.fetchTraslados).not.toHaveBeenCalled();
    // El backend ya filtra por su punto: no se ofrece elegir otro.
    expect(screen.queryByLabelText("Punto")).toBeNull();
  });

  it("muestra el contador de pendientes en el encabezado", async () => {
    montar(PUNTO);
    expect(await screen.findByText(/3 pendientes/)).toBeInTheDocument();
    expect(api.fetchComprobantes).toHaveBeenCalledWith(expect.objectContaining({ estado: "pendiente", limit: 1 }));
  });

  it("puede Confirmar y Devolver un pendiente, pero no Devolver un confirmado ni Eliminar", async () => {
    montar(PUNTO);
    await esperarFila("Comprobantes", "FV 100");
    const pendiente = fila("Comprobantes", "FV 100");
    expect(within(pendiente).getByRole("button", { name: "Confirmar" })).toBeInTheDocument();
    expect(within(pendiente).getByRole("button", { name: "Devolver" })).toBeInTheDocument();
    expect(within(pendiente).queryByRole("button", { name: "Eliminar" })).toBeNull();
    const confirmado = fila("Comprobantes", "FV 200");
    expect(within(confirmado).queryByRole("button", { name: "Devolver" })).toBeNull();
    expect(within(confirmado).queryByRole("button", { name: "Confirmar" })).toBeNull();
  });

  it("Confirmar abre el modal de firma y pide quien recibe del punto del comprobante", async () => {
    api.fetchReceptoresPunto.mockResolvedValue([{ id: "r1", nombre: "Luis Pérez", cedula: "1234567" }]);
    montar(PUNTO);
    await esperarFila("Comprobantes", "FV 100");
    await userEvent.click(within(fila("Comprobantes", "FV 100")).getByRole("button", { name: "Confirmar" }));
    const dialogo = screen.getByRole("dialog", { name: "Confirmar recepción" });
    expect(await within(dialogo).findByRole("option", { name: /Luis Pérez/ })).toBeInTheDocument();
    expect(within(dialogo).getByLabelText("Quién recibe")).toBeInTheDocument();
  });
});

describe("lectura", () => {
  it("solo ve la lista con Historial", async () => {
    montar(LECTURA);
    await esperarFila("Comprobantes", "FV 100");
    expect(screen.queryByLabelText("Seleccionar PDFs")).toBeNull();
    for (const numero of ["FV 100", "FV 200"]) {
      const f = fila("Comprobantes", numero);
      expect(within(f).getByRole("button", { name: "Historial" })).toBeInTheDocument();
      for (const nombre of ["Confirmar", "Devolver", "Eliminar"]) {
        expect(within(f).queryByRole("button", { name: nombre })).toBeNull();
      }
    }
  });
});

describe("estados de la lista", () => {
  it("sin comprobantes lo dice", async () => {
    api.fetchComprobantes.mockResolvedValue({ total: 0, items: [] });
    montar(LECTURA);
    expect(await screen.findByText(/No hay comprobantes/)).toBeInTheDocument();
  });

  it("un error de carga ofrece reintentar", async () => {
    api.fetchComprobantes.mockRejectedValueOnce(new Error("Servidor caído")).mockResolvedValue({ total: 1, items: [PENDIENTE] });
    montar(LECTURA);
    expect(await screen.findByText("Servidor caído")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Reintentar" }));
    expect(await esperarFila("Comprobantes", "FV 100")).toBeInTheDocument();
  });

  it("Cargar más pide la siguiente tanda cuando hay mas resultados", async () => {
    api.fetchComprobantes.mockResolvedValue({ total: 80, items: [PENDIENTE] });
    montar(LECTURA);
    await esperarFila("Comprobantes", "FV 100");
    await userEvent.click(screen.getByRole("button", { name: "Cargar más" }));
    await waitFor(() => expect(api.fetchComprobantes).toHaveBeenCalledWith(expect.objectContaining({ limit: 100 })));
  });
});
