import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SWRConfig } from "swr";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FilaTrasladoSyscafe } from "@/lib/api";
import PuntoPage from "./page";

const api = vi.hoisted(() => ({
  fetchPuntosPublicos: vi.fn(),
  listarTrasladosSyscafe: vi.fn(),
  listarTrasladosRecibidos: vi.fn(),
  fetchTalonarioPunto: vi.fn(),
  fetchUsuariosPuntoAdmin: vi.fn(),
}));
vi.mock("@/lib/api", () => api);

vi.mock("next/navigation", () => ({ useParams: () => ({ id: "p1" }) }));

const sesion = vi.hoisted(() => ({
  usuario: { id: "1", usuario: "ana", nombre: "Ana", rol: "admin", area: "todo" } as Record<string, unknown>,
  puedeEditar: true,
  esAdmin: true,
}));
vi.mock("@/lib/SesionProvider", () => ({ useSesion: () => sesion }));

vi.mock("@/components/traslados/ModalDetalleTraslado", () => ({
  ModalDetalleTraslado: ({ id }: { id: string }) => <div role="dialog">detalle {id}</div>,
}));
vi.mock("@/components/traslados/ModalAnulada", () => ({
  ModalAnulada: ({ fila }: { fila: { id: string } }) => <div role="dialog">anulada {fila.id}</div>,
}));

const hoy = new Date();
const fechaDeEsteMes = `${hoy.getFullYear()}-${String(hoy.getMonth() + 1).padStart(2, "0")}-01`;

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
  fecha: fechaDeEsteMes,
  created_at: `${fechaDeEsteMes}T10:00:00Z`,
  motivo: null,
  anulado_por_nombre: null,
  ...p,
});

const ENVIADOS = [
  fila({ id: "e1", consecutivo: 11, numero_syscafe: "NBR-11", estado: "recibido" }),
  fila({ id: "e2", consecutivo: 12, numero_syscafe: null, estado: "recibido_con_novedad" }),
];
const RECIBIDOS = [
  fila({
    id: "r1",
    consecutivo: 21,
    punto_origen_id: "p3",
    punto_origen_nombre: "Sur",
    punto_destino_id: "p1",
    punto_destino_nombre: "Centro",
    estado: "en_transito",
  }),
];

const montar = () =>
  render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <PuntoPage />
    </SWRConfig>,
  );

// Celda del indicador a partir de su rotulo (el primero en el documento: los indicadores van sobre la tabla).
const indicador = (etiqueta: string) => screen.getAllByText(etiqueta)[0].parentElement as HTMLElement;

beforeEach(() => {
  Object.values(api).forEach((fn) => fn.mockReset());
  sesion.usuario = { id: "1", usuario: "ana", nombre: "Ana", rol: "admin", area: "todo" };
  sesion.esAdmin = true;
  sesion.puedeEditar = true;
  api.fetchPuntosPublicos.mockResolvedValue([
    { id: "p1", nombre: "Centro", codigo: "CEN" },
    { id: "p2", nombre: "Norte", codigo: "NOR" },
  ]);
  api.listarTrasladosSyscafe.mockResolvedValue(ENVIADOS);
  api.listarTrasladosRecibidos.mockResolvedValue(RECIBIDOS);
  api.fetchTalonarioPunto.mockResolvedValue({
    talonarios: [{ id: "k1", letra: "A", rango: "1-100", siguiente_hoja: "A 15", quedan: 86, agotado: false, umbral_aviso: 10 }],
    talonario: null,
  });
  api.fetchUsuariosPuntoAdmin.mockResolvedValue([
    { id: "u1", nombre: "Marta Ruiz", punto_id: "p1", estado: "activo" },
    { id: "u2", nombre: "Pedro Gil", punto_id: "p1", estado: "inactivo" },
  ]);
});

describe("detalle de un punto", () => {
  it("muestra el encabezado, los indicadores y las secciones", async () => {
    montar();
    expect(await screen.findByRole("heading", { level: 1, name: "Centro" })).toBeInTheDocument();
    expect(screen.getByText(/CEN/)).toBeInTheDocument();
    for (const nombre of ["Traslados del punto", "Talonario activo", "Usuarios del punto"]) {
      expect(screen.getByRole("heading", { level: 2, name: new RegExp(nombre) })).toBeInTheDocument();
    }
    // 3 traslados este mes (2 enviados + 1 recibido), 1 por recibir, 1 con novedad, 1 sin Syscafe.
    await waitFor(() => expect(within(indicador("Traslados del mes")).getByText("3")).toBeInTheDocument());
    expect(within(indicador("Pendientes de recibir")).getByText("1")).toBeInTheDocument();
    expect(within(indicador("Con novedad")).getByText("1")).toBeInTheDocument();
    expect(within(indicador("Sin número Syscafe")).getByText("1")).toBeInTheDocument();
  });

  it("lista los traslados enviados y recibidos con estado y numero Syscafe", async () => {
    montar();
    expect(await screen.findByText("TP-000011")).toBeInTheDocument();
    expect(screen.getByText("TP-000021")).toBeInTheDocument();
    expect(screen.getByText("NBR-11")).toBeInTheDocument();
    expect(screen.getByText("Con novedad", { selector: "span.inline-flex" })).toBeInTheDocument();
    expect(api.listarTrasladosSyscafe).toHaveBeenCalledWith({ puntoId: "p1" });
    expect(api.listarTrasladosRecibidos).toHaveBeenCalledWith("p1");
  });

  it("filtra por enviados y recibidos", async () => {
    montar();
    await screen.findByText("TP-000011");
    await userEvent.click(screen.getByRole("button", { name: "Recibidos" }));
    expect(screen.queryByText("TP-000011")).toBeNull();
    expect(screen.getByText("TP-000021")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Enviados" }));
    expect(screen.getByText("TP-000011")).toBeInTheDocument();
    expect(screen.queryByText("TP-000021")).toBeNull();
  });

  it("abre el detalle del traslado al hacer clic en una fila", async () => {
    montar();
    await userEvent.click(await screen.findByText("TP-000011"));
    expect(screen.getByRole("dialog")).toHaveTextContent("detalle e1");
  });

  it("muestra el talonario activo del punto", async () => {
    montar();
    expect(await screen.findByText("1-100")).toBeInTheDocument();
    expect(screen.getByText(/A 15/)).toBeInTheDocument();
    expect(screen.getByText("Quedan 86")).toBeInTheDocument();
    expect(api.fetchTalonarioPunto).toHaveBeenCalledWith("p1");
  });

  it("muestra los usuarios del punto al administrador", async () => {
    montar();
    expect(await screen.findByText("Marta Ruiz")).toBeInTheDocument();
    expect(screen.getByText("Pedro Gil")).toBeInTheDocument();
    expect(api.fetchUsuariosPuntoAdmin).toHaveBeenCalledWith("p1");
  });
});

describe("permisos", () => {
  it("oculta la seccion de usuarios si no es admin y no consulta esos datos", async () => {
    sesion.usuario = { id: "2", usuario: "luis", nombre: "Luis", rol: "supervisor", area: "traslados" };
    sesion.esAdmin = false;
    montar();
    await screen.findByRole("heading", { level: 1, name: "Centro" });
    expect(screen.queryByRole("heading", { name: /Usuarios del punto/ })).toBeNull();
    expect(api.fetchUsuariosPuntoAdmin).not.toHaveBeenCalled();
  });

  it("degrada con un aviso discreto si la sesion no puede ver usuarios (401)", async () => {
    api.fetchUsuariosPuntoAdmin.mockRejectedValue(Object.assign(new Error("No autorizado"), { status: 401 }));
    montar();
    expect(await screen.findByText(/No tienes permiso para ver los usuarios/)).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "Centro" })).toBeInTheDocument();
  });
});

describe("estados vacios", () => {
  it("sin traslados, sin talonario y sin usuarios", async () => {
    api.listarTrasladosSyscafe.mockResolvedValue([]);
    api.listarTrasladosRecibidos.mockResolvedValue([]);
    api.fetchTalonarioPunto.mockResolvedValue({ talonarios: [], talonario: null });
    api.fetchUsuariosPuntoAdmin.mockResolvedValue([]);
    montar();
    expect(await screen.findByText("Este punto todavía no tiene traslados.")).toBeInTheDocument();
    expect(screen.getByText("Este punto todavía no tiene un talonario configurado.")).toBeInTheDocument();
    expect(screen.getByText("Este punto todavía no tiene usuarios.")).toBeInTheDocument();
    // Indicadores en cero (no guiones ni vacios).
    expect(within(indicador("Traslados del mes")).getByText("0")).toBeInTheDocument();
  });

  it("si el talonario no responde (404 o error) muestra un estado vacio tranquilo", async () => {
    api.fetchTalonarioPunto.mockRejectedValue(new Error("/puntos/p1/talonario respondio 404"));
    montar();
    expect(await screen.findByText("No se pudo consultar el talonario de este punto.")).toBeInTheDocument();
  });

  it("avisa si el punto no existe", async () => {
    api.fetchPuntosPublicos.mockResolvedValue([{ id: "otro", nombre: "Otro", codigo: null }]);
    montar();
    expect(await screen.findByText("No encontramos este punto.")).toBeInTheDocument();
  });
});
