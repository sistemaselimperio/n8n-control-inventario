import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SWRConfig } from "swr";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FilaTrasladoSyscafe } from "@/lib/api";
import TrasladosPage from "./page";

const api = vi.hoisted(() => ({
  asignarSyscafeDashboard: vi.fn(),
  fetchActividadTraslados: vi.fn(),
  fetchPuntosPublicos: vi.fn(),
  listarTrasladosSyscafe: vi.fn(),
}));
vi.mock("@/lib/api", () => api);

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

const sesion = vi.hoisted(() => ({
  usuario: { id: "1", usuario: "ana", nombre: "Ana", rol: "admin", area: "todo" } as Record<string, unknown>,
  puedeEditar: true,
}));
vi.mock("@/lib/SesionProvider", () => ({ useSesion: () => sesion }));

// Los modales de detalle tienen su propia logica y llamadas: aqui solo se
// comprueba cual se abre.
vi.mock("@/components/traslados/ModalDetalleTraslado", () => ({
  ModalDetalleTraslado: ({ id }: { id: string }) => <div role="dialog">detalle {id}</div>,
}));
vi.mock("@/components/traslados/ModalAnulada", () => ({
  ModalAnulada: ({ fila }: { fila: { id: string } }) => <div role="dialog">anulada {fila.id}</div>,
}));

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

const chip = (grupo: string, nombre: RegExp) =>
  within(screen.getByRole("group", { name: grupo })).getByRole("button", { name: nombre });

// Filtros de la barra: boton "Fecha: Todas" que abre un menu con opciones.
const filtro = (nombre: string) => screen.getByRole("button", { name: new RegExp(`^${nombre}:`) });
async function elegir(nombre: string, opcion: RegExp) {
  if (!screen.queryByRole("menu", { name: nombre })) await userEvent.click(filtro(nombre));
  await userEvent.click(within(screen.getByRole("menu", { name: nombre })).getByRole("menuitemradio", { name: opcion }));
}

const FILAS = [
  fila({ id: "t1", consecutivo: 1, numero_talonario: "A 10", talonario_id: "k1" }),
  fila({
    id: "t2",
    consecutivo: 2,
    numero_talonario: "V 20",
    talonario_id: "k2",
    numero_syscafe: "NBR-945",
    estado: "recibido",
    punto_destino_nombre: "Sur",
  }),
  fila({
    id: "t3",
    consecutivo: 3,
    tipo_traslado: "directo",
    punto_origen_id: null,
    punto_origen_nombre: null,
    estado: "recibido_con_novedad",
    punto_destino_nombre: "Peñalisa",
  }),
  fila({ tipo: "anulada", id: "a1", consecutivo: null, numero_talonario: "A 11", motivo: "Hoja danada", estado: "anulada" }),
];

const montar = () =>
  render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <TrasladosPage />
    </SWRConfig>,
  );

beforeEach(() => {
  Object.values(api).forEach((f) => f.mockReset());
  api.listarTrasladosSyscafe.mockResolvedValue(FILAS);
  api.fetchActividadTraslados.mockResolvedValue([]);
  api.fetchPuntosPublicos.mockResolvedValue([{ id: "p1", nombre: "Centro", codigo: null }]);
  api.asignarSyscafeDashboard.mockResolvedValue(undefined);
  toast.success.mockReset();
  toast.error.mockReset();
  sesion.usuario = { id: "1", usuario: "ana", nombre: "Ana", rol: "admin", area: "todo" };
  sesion.puedeEditar = true;
});

const filasTabla = () => within(screen.getByRole("table")).getAllByRole("row").slice(1);

describe("pagina de traslados: listado", () => {
  it("muestra referencia, empresa, Syscafe y estado de cada fila", async () => {
    montar();
    await screen.findByRole("table");
    expect(filasTabla()).toHaveLength(4);
    const t1 = filasTabla()[0];
    expect(within(t1).getByText("A 10")).toBeInTheDocument();
    expect(within(t1).getByText("Comercializadora El Imperio")).toBeInTheDocument();
    expect(within(t1).getByText("Pendiente")).toBeInTheDocument();
    expect(within(t1).getByText("En tránsito")).toBeInTheDocument();
    const t2 = filasTabla()[1];
    expect(within(t2).getByText("NBR-945")).toBeInTheDocument();
    expect(within(t2).getByText("13/10/2026")).toBeInTheDocument();
    expect(screen.getByText("4 traslados")).toBeInTheDocument();
  });

  it("una llegada directa muestra 'Llega directo' y una hoja anulada su motivo", async () => {
    montar();
    await screen.findByRole("table");
    expect(within(filasTabla()[2]).getByText(/Llega directo/)).toBeInTheDocument();
    expect(within(filasTabla()[2]).getByText("TP-000003")).toBeInTheDocument();
    expect(within(filasTabla()[3]).getByText("Motivo: Hoja danada")).toBeInTheDocument();
    // Una anulada no es "pendiente" de Syscafe ni se puede asignar.
    expect(within(filasTabla()[3]).queryByText("Pendiente")).toBeNull();
  });

  it("estado vacio, y mensaje propio cuando se piden solo pendientes", async () => {
    api.listarTrasladosSyscafe.mockResolvedValue([]);
    montar();
    expect(await screen.findByText("No hay traslados para mostrar.")).toBeInTheDocument();
    await userEvent.click(chip("Vista", /^Pendiente N° Traslado/));
    expect(await screen.findByText("No hay traslados pendientes de Syscafe.")).toBeInTheDocument();
  });

  it("si falla la carga ofrece reintentar", async () => {
    api.listarTrasladosSyscafe.mockRejectedValueOnce(new Error("/traslados respondio 500")).mockResolvedValue(FILAS);
    montar();
    expect(await screen.findByRole("alert")).toHaveTextContent("No se pudieron cargar los traslados.");
    await userEvent.click(screen.getByRole("button", { name: "Reintentar" }));
    expect(await screen.findByRole("table")).toBeInTheDocument();
  });
});

describe("pagina de traslados: filtros", () => {
  const hoyLocal = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };

  it("los filtros de servidor viajan a listarTrasladosSyscafe", async () => {
    montar();
    await screen.findByRole("table");
    await elegir("Punto", /^Centro$/);
    await userEvent.click(chip("Vista", /^Pendiente N° Traslado/));
    await elegir("Fecha", /^Elegir fechas$/);
    await userEvent.type(screen.getByLabelText("Desde"), "2026-10-01");
    await userEvent.type(screen.getByLabelText("Hasta"), "2026-10-31");
    await waitFor(() =>
      expect(api.listarTrasladosSyscafe).toHaveBeenLastCalledWith({
        puntoId: "p1",
        pendientes: true,
        desde: "2026-10-01",
        hasta: "2026-10-31",
      }),
    );
    await elegir("Fecha", /^Todas las fechas$/);
    await waitFor(() =>
      expect(api.listarTrasladosSyscafe).toHaveBeenLastCalledWith({
        puntoId: "p1",
        pendientes: true,
        desde: undefined,
        hasta: undefined,
      }),
    );
    expect(screen.queryByLabelText("Desde")).toBeNull();
  });

  it("el atajo Hoy filtra desde y hasta el dia de hoy", async () => {
    montar();
    await screen.findByRole("table");
    await elegir("Fecha", /^Hoy$/);
    expect(filtro("Fecha")).toHaveTextContent("Hoy");
    expect(screen.queryByRole("menu", { name: "Fecha" })).toBeNull();
    await waitFor(() =>
      expect(api.listarTrasladosSyscafe).toHaveBeenLastCalledWith({
        puntoId: undefined,
        pendientes: false,
        desde: hoyLocal(),
        hasta: hoyLocal(),
      }),
    );
  });

  it("vista, empresa y tipo filtran en el cliente; cada vista muestra su conteo", async () => {
    montar();
    await screen.findByRole("table");
    expect(chip("Vista", /^Recibidos/)).toHaveTextContent("1");
    await userEvent.click(chip("Vista", /^Recibidos/));
    expect(chip("Vista", /^Recibidos/)).toHaveAttribute("aria-pressed", "true");
    expect(filasTabla()).toHaveLength(1);
    expect(within(filasTabla()[0]).getByText("V 20")).toBeInTheDocument();
    await userEvent.click(chip("Vista", /^Todos/));
    await elegir("Empresa", /El Imperio/);
    expect(filasTabla().map((f) => within(f).queryByText(/^[AV] \d+$/)?.textContent)).toEqual(["A 10", "A 11"]);
    await elegir("Empresa", /^Todas$/);
    await elegir("Tipo", /^Llega directo$/);
    expect(filasTabla()).toHaveLength(1);
    expect(within(filasTabla()[0]).getByText("TP-000003")).toBeInTheDocument();
  });

  it("Limpiar filtros solo aparece con filtros activos y los quita todos", async () => {
    montar();
    await screen.findByRole("table");
    const total = filasTabla().length;
    expect(screen.queryByRole("button", { name: "Limpiar filtros" })).toBeNull();
    await userEvent.click(chip("Vista", /^Recibidos/));
    await elegir("Tipo", /^Entre puntos$/);
    await userEvent.click(screen.getByRole("button", { name: "Limpiar filtros" }));
    expect(filasTabla()).toHaveLength(total);
    expect(chip("Vista", /^Todos/)).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByRole("button", { name: "Limpiar filtros" })).toBeNull();
  });
});

describe("pagina de traslados: busqueda", () => {
  const buscar = (texto: string) => userEvent.type(screen.getByLabelText("Buscar traslado"), texto);

  it("ignora tildes y mayusculas", async () => {
    montar();
    await screen.findByRole("table");
    await buscar("PENALISA");
    await waitFor(() => expect(filasTabla()).toHaveLength(1));
    expect(screen.getByText("Mostrando 1 de 4")).toBeInTheDocument();
  });

  it("encuentra un numero Syscafe sin guion ni espacios", async () => {
    montar();
    await screen.findByRole("table");
    await buscar("nbr945");
    await waitFor(() => expect(filasTabla()).toHaveLength(1));
    expect(within(filasTabla()[0]).getByText("NBR-945")).toBeInTheDocument();
  });

  it("'pendiente' encuentra solo los traslados sin Syscafe, no las hojas anuladas", async () => {
    montar();
    await screen.findByRole("table");
    await buscar("pendiente");
    await waitFor(() => expect(filasTabla()).toHaveLength(2));
    expect(within(filasTabla()[0]).getByText("A 10")).toBeInTheDocument();
    expect(within(filasTabla()[1]).getByText("TP-000003")).toBeInTheDocument();
  });

  it("sin coincidencias muestra el mensaje y Borrar busqueda restaura la lista", async () => {
    montar();
    await screen.findByRole("table");
    await buscar("zzz");
    expect(await screen.findByText(/Ningún traslado coincide con «zzz»/)).toBeInTheDocument();
    await userEvent.click(screen.getAllByRole("button", { name: /Borrar búsqueda/ })[0]);
    expect(await screen.findByRole("table")).toBeInTheDocument();
    expect(filasTabla()).toHaveLength(4);
  });

  it("Escape limpia el buscador", async () => {
    montar();
    await screen.findByRole("table");
    await buscar("nbr{Escape}");
    expect(screen.getByLabelText("Buscar traslado")).toHaveValue("");
  });
});

describe("pagina de traslados: numero Syscafe", () => {
  it("registra un numero con prefijo que lleva digito (TB9) y recarga la lista", async () => {
    montar();
    await screen.findByRole("table");
    await userEvent.click(screen.getByRole("button", { name: "Registrar número Syscafe de A 10" }));
    const caja = screen.getByRole("dialog", { name: /Número Syscafe del traslado A 10/ });
    await userEvent.type(within(caja).getByLabelText("Prefijo"), "tb9");
    await userEvent.type(within(caja).getByLabelText("Indicativo"), "120");
    const llamadasAntes = api.listarTrasladosSyscafe.mock.calls.length;
    await userEvent.click(within(caja).getByRole("button", { name: "Guardar número Syscafe" }));
    await waitFor(() => expect(api.asignarSyscafeDashboard).toHaveBeenCalledWith("t1", "TB9-120"));
    await waitFor(() => expect(api.listarTrasladosSyscafe.mock.calls.length).toBeGreaterThan(llamadasAntes));
    expect(screen.queryByRole("dialog", { name: /Número Syscafe/ })).toBeNull();
  });

  it("la fila con Syscafe ofrece Editar, y la caja no abre el detalle", async () => {
    montar();
    await screen.findByRole("table");
    await userEvent.click(screen.getByRole("button", { name: "Editar número Syscafe de V 20" }));
    expect(screen.getByRole("dialog", { name: /Número Syscafe del traslado V 20/ })).toBeInTheDocument();
    expect(screen.queryByText("detalle t2")).toBeNull();
  });

  it.each([
    ["consulta (solo lectura)", { rol: "consulta", area: "todo" }, false],
    ["supervisor de bodega", { rol: "supervisor", area: "bodega" }, true],
  ])("%s no puede registrar Syscafe", async (_n, usuario, puedeEditar) => {
    sesion.usuario = { id: "2", usuario: "u", nombre: "U", ...usuario };
    sesion.puedeEditar = puedeEditar;
    montar();
    await screen.findByRole("table");
    expect(screen.queryByRole("button", { name: /número Syscafe de/ })).toBeNull();
  });

  it("un supervisor de traslados si puede", async () => {
    sesion.usuario = { id: "2", usuario: "u", nombre: "U", rol: "supervisor", area: "traslados" };
    montar();
    await screen.findByRole("table");
    expect(screen.getByRole("button", { name: "Registrar número Syscafe de A 10" })).toBeInTheDocument();
  });
});

describe("pagina de traslados: detalle", () => {
  it("clic en un traslado abre el detalle", async () => {
    montar();
    await screen.findByRole("table");
    await userEvent.click(within(filasTabla()[0]).getByText("A 10"));
    expect(screen.getByText("detalle t1")).toBeInTheDocument();
  });

  it("Enter sobre la fila abre el detalle", async () => {
    montar();
    await screen.findByRole("table");
    filasTabla()[1].focus();
    await userEvent.keyboard("{Enter}");
    expect(screen.getByText("detalle t2")).toBeInTheDocument();
  });

  it("una hoja anulada abre su propio modal", async () => {
    montar();
    await screen.findByRole("table");
    await userEvent.click(within(filasTabla()[3]).getByText("A 11"));
    expect(screen.getByText("anulada a1")).toBeInTheDocument();
  });
});
