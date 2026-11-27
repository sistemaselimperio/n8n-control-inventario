import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SWRConfig } from "swr";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Comprobante, Traslado } from "@/lib/api";
import { ModalConfirmarComprobante } from "./ModalConfirmarComprobante";
import { ModalDevolver } from "./ModalDevolver";
import { ModalEditarBorrador } from "./ModalEditarBorrador";
import { ModalHistorial } from "./ModalHistorial";
import { ModalReenviar } from "./ModalReenviar";
import { ModalVisor } from "./ModalVisor";

const api = vi.hoisted(() => ({
  confirmarComprobante: vi.fn(),
  devolverComprobante: vi.fn(),
  reenviarComprobante: vi.fn(),
  actualizarTraslado: vi.fn(),
  fetchComprobante: vi.fn(),
  fetchReceptoresPunto: vi.fn(),
}));
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  ...api,
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

const ctx = {
  scale: vi.fn(),
  setTransform: vi.fn(),
  beginPath: vi.fn(),
  moveTo: vi.fn(),
  lineTo: vi.fn(),
  stroke: vi.fn(),
  clearRect: vi.fn(),
};

const comp = (parcial: Partial<Comprobante> = {}): Comprobante => ({
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
  ...parcial,
});

const puntos = [
  { id: "p1", nombre: "Punto Norte", codigo: "PN", es_interna: false },
  { id: "p2", nombre: "Bodega Central", codigo: "BC", es_interna: true },
];

beforeEach(() => {
  Object.values(api).forEach((f) => f.mockReset());
  toast.success.mockReset();
  toast.error.mockReset();
  [ctx.scale, ctx.setTransform, ctx.beginPath, ctx.moveTo, ctx.lineTo, ctx.stroke, ctx.clearRect].forEach((f) => f.mockClear());
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((cb) => cb(new Blob(["png"], { type: "image/png" })));
  vi.spyOn(HTMLCanvasElement.prototype, "getBoundingClientRect").mockReturnValue({
    left: 0, top: 0, width: 300, height: 150, right: 300, bottom: 150, x: 0, y: 0, toJSON: () => ({}),
  });
});

const firmar = () => {
  const l = screen.getByLabelText("Área de firma");
  fireEvent.pointerDown(l, { clientX: 5, clientY: 5, pointerId: 1, buttons: 1 });
  fireEvent.pointerMove(l, { clientX: 50, clientY: 50, pointerId: 1, buttons: 1 });
  fireEvent.pointerUp(l, { pointerId: 1 });
};

const receptores = [
  { id: "r1", nombre: "Luis Pérez", cedula: "1234567" },
  { id: "r2", nombre: "Ana Gil", cedula: "7654321" },
];

const conSwr = (ui: React.ReactNode) => (
  <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{ui}</SWRConfig>
);

// Elige "Otra persona" y llena nombre y cedula.
const escribirOtraPersona = async (nombre = "Marta Ríos", cedula = "52.123.456") => {
  await userEvent.selectOptions(await screen.findByLabelText("Quién recibe"), "Otra persona");
  await userEvent.type(screen.getByLabelText("Nombre de quien recibe"), nombre);
  await userEvent.type(screen.getByLabelText("Cédula de quien recibe"), cedula);
};

describe("ModalConfirmarComprobante", () => {
  beforeEach(() => {
    api.fetchReceptoresPunto.mockResolvedValue(receptores);
  });
  const montar = () => {
    const onHecho = vi.fn();
    const onCerrar = vi.fn();
    render(conSwr(<ModalConfirmarComprobante comprobante={comp()} onCerrar={onCerrar} onHecho={onHecho} />));
    return { onHecho, onCerrar };
  };
  const botonConfirmar = () => screen.getByRole("button", { name: "Confirmar recepción" });

  it("lista los receptores activos del punto del comprobante", async () => {
    montar();
    const selector = await screen.findByLabelText("Quién recibe");
    await waitFor(() => expect(within(selector).getAllByRole("option")).toHaveLength(4));
    expect(api.fetchReceptoresPunto).toHaveBeenCalledWith("p1");
    expect(within(selector).getByRole("option", { name: /Luis Pérez/ })).toBeInTheDocument();
    expect(within(selector).getByRole("option", { name: "Otra persona" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Nombre de quien recibe")).toBeNull();
  });

  it("el boton queda deshabilitado hasta que haya firma Y quien recibe", async () => {
    montar();
    const selector = await screen.findByLabelText("Quién recibe");
    await waitFor(() => expect(within(selector).getAllByRole("option")).toHaveLength(4));
    expect(botonConfirmar()).toBeDisabled();
    firmar();
    await waitFor(() => expect(screen.getByRole("button", { name: "Limpiar" })).toBeEnabled());
    expect(botonConfirmar()).toBeDisabled(); // falta elegir quien recibe
    await userEvent.selectOptions(selector, "r1");
    await waitFor(() => expect(botonConfirmar()).toBeEnabled());
    await userEvent.click(screen.getByRole("button", { name: "Limpiar" }));
    await waitFor(() => expect(botonConfirmar()).toBeDisabled());
  });

  it("envia la firma PNG, la observacion y el receptor elegido", async () => {
    api.confirmarComprobante.mockResolvedValue(comp({ estado: "confirmado" }));
    const { onHecho } = montar();
    await userEvent.selectOptions(await screen.findByLabelText("Quién recibe"), "r2");
    firmar();
    await userEvent.type(screen.getByLabelText(/Observación/), "Todo completo");
    await userEvent.click(botonConfirmar());
    await waitFor(() => expect(api.confirmarComprobante).toHaveBeenCalled());
    const [id, blob, obs, quien] = api.confirmarComprobante.mock.calls[0];
    expect(id).toBe("c1");
    expect((blob as Blob).type).toBe("image/png");
    expect(obs).toBe("Todo completo");
    expect(quien).toEqual({ receptor_id: "r2" });
    expect(toast.success).toHaveBeenCalledWith("Recepción confirmada");
    expect(onHecho).toHaveBeenCalled();
  });

  it("otra persona pide nombre y cedula (5 a 15 digitos) antes de habilitar el boton", async () => {
    montar();
    await userEvent.selectOptions(await screen.findByLabelText("Quién recibe"), "Otra persona");
    firmar();
    await waitFor(() => expect(screen.getByRole("button", { name: "Limpiar" })).toBeEnabled());
    expect(botonConfirmar()).toBeDisabled();
    await userEvent.type(screen.getByLabelText("Nombre de quien recibe"), "Marta Ríos");
    await userEvent.type(screen.getByLabelText("Cédula de quien recibe"), "12ab");
    expect(botonConfirmar()).toBeDisabled();
    await userEvent.clear(screen.getByLabelText("Cédula de quien recibe"));
    await userEvent.type(screen.getByLabelText("Cédula de quien recibe"), "52.123.456");
    await waitFor(() => expect(botonConfirmar()).toBeEnabled());
  });

  it("confirma con otra persona mandando nombre y cedula normalizada", async () => {
    api.confirmarComprobante.mockResolvedValue(comp({ estado: "confirmado" }));
    montar();
    await escribirOtraPersona();
    firmar();
    await waitFor(() => expect(botonConfirmar()).toBeEnabled());
    await userEvent.click(botonConfirmar());
    await waitFor(() => expect(api.confirmarComprobante).toHaveBeenCalled());
    expect(api.confirmarComprobante.mock.calls[0][3]).toEqual({
      receptor_nombre: "Marta Ríos",
      receptor_cedula: "52123456",
    });
  });

  it("sin receptores registrados avisa y deja usar otra persona", async () => {
    api.fetchReceptoresPunto.mockResolvedValue([]);
    montar();
    expect(await screen.findByText(/no tiene receptores registrados/)).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText("Quién recibe"), "Otra persona");
    expect(screen.getByLabelText("Nombre de quien recibe")).toBeInTheDocument();
  });

  it("si la lista no carga muestra el error y deja usar otra persona", async () => {
    api.fetchReceptoresPunto.mockRejectedValue(new Error("Sin conexión"));
    montar();
    expect(await screen.findByText(/No se pudo cargar la lista de receptores/)).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText("Quién recibe"), "Otra persona");
    expect(screen.getByLabelText("Cédula de quien recibe")).toBeInTheDocument();
  });

  it("un error del backend se muestra dentro del modal y no cierra", async () => {
    api.confirmarComprobante.mockRejectedValue(new Error("Ya fue confirmado"));
    const { onHecho } = montar();
    await userEvent.selectOptions(await screen.findByLabelText("Quién recibe"), "r1");
    firmar();
    await waitFor(() => expect(botonConfirmar()).toBeEnabled());
    await userEvent.click(botonConfirmar());
    expect(await screen.findByText("Ya fue confirmado")).toBeInTheDocument();
    expect(onHecho).not.toHaveBeenCalled();
  });
});

describe("ModalDevolver", () => {
  beforeEach(() => {
    api.fetchReceptoresPunto.mockResolvedValue(receptores);
  });
  const montar = (c = comp(), onHecho = vi.fn()) =>
    render(conSwr(<ModalDevolver comprobante={c} onCerrar={() => {}} onHecho={onHecho} />));

  it("un pendiente exige motivo (maximo 500) y quien recibe", async () => {
    api.devolverComprobante.mockResolvedValue(comp({ estado: "devuelto" }));
    const onHecho = vi.fn();
    montar(comp(), onHecho);
    const boton = screen.getByRole("button", { name: "Devolver" });
    expect(boton).toBeDisabled();
    expect(screen.getByLabelText(/Motivo/)).toHaveAttribute("maxlength", "500");
    await userEvent.type(screen.getByLabelText(/Motivo/), "   ");
    expect(boton).toBeDisabled();
    await userEvent.type(screen.getByLabelText(/Motivo/), "Cantidad errada");
    expect(boton).toBeDisabled(); // falta elegir quien recibe
    await userEvent.selectOptions(await screen.findByLabelText("Quién recibe"), "r1");
    await waitFor(() => expect(boton).toBeEnabled());
    await userEvent.click(boton);
    await waitFor(() =>
      expect(api.devolverComprobante).toHaveBeenCalledWith("c1", "Cantidad errada", { receptor_id: "r1" })
    );
    expect(toast.success).toHaveBeenCalledWith("Comprobante devuelto");
    expect(onHecho).toHaveBeenCalled();
  });

  it("un pendiente tambien se puede devolver con otra persona", async () => {
    api.devolverComprobante.mockResolvedValue(comp({ estado: "devuelto" }));
    montar();
    await userEvent.type(screen.getByLabelText(/Motivo/), "No llegó");
    await escribirOtraPersona();
    await userEvent.click(screen.getByRole("button", { name: "Devolver" }));
    await waitFor(() =>
      expect(api.devolverComprobante).toHaveBeenCalledWith("c1", "No llegó", {
        receptor_nombre: "Marta Ríos",
        receptor_cedula: "52123456",
      })
    );
  });

  it("un confirmado (lo devuelve la encargada) no pide receptor ni lo carga", async () => {
    api.devolverComprobante.mockResolvedValue(comp({ estado: "devuelto" }));
    montar(comp({ estado: "confirmado" }));
    expect(screen.queryByLabelText("Quién recibe")).toBeNull();
    await userEvent.type(screen.getByLabelText(/Motivo/), "Firma ilegible");
    await userEvent.click(screen.getByRole("button", { name: "Devolver" }));
    await waitFor(() => expect(api.devolverComprobante).toHaveBeenCalledWith("c1", "Firma ilegible", undefined));
    expect(api.fetchReceptoresPunto).not.toHaveBeenCalled();
  });

  it("muestra el error del backend", async () => {
    api.devolverComprobante.mockRejectedValue(new Error("No permitido"));
    montar();
    await userEvent.type(screen.getByLabelText(/Motivo/), "x");
    await userEvent.selectOptions(await screen.findByLabelText("Quién recibe"), "r1");
    await userEvent.click(screen.getByRole("button", { name: "Devolver" }));
    expect(await screen.findByText("No permitido")).toBeInTheDocument();
  });
});

describe("ModalReenviar", () => {
  it("precarga numero y punto, y manda solo lo que cambio", async () => {
    api.reenviarComprobante.mockResolvedValue(comp());
    const onHecho = vi.fn();
    render(
      <ModalReenviar comprobante={comp({ estado: "devuelto", motivo_devolucion: "Numero errado" })} puntos={puntos} onCerrar={() => {}} onHecho={onHecho} />,
    );
    expect(screen.getByText(/Numero errado/)).toBeInTheDocument();
    expect(screen.getByLabelText("Número")).toHaveValue("FV 100");
    expect(screen.getByLabelText("Punto")).toHaveValue("p1");
    const numero = screen.getByLabelText("Número");
    await userEvent.clear(numero);
    await userEvent.type(numero, "FV 101");
    await userEvent.click(screen.getByRole("button", { name: "Corregir y reenviar" }));
    await waitFor(() => expect(api.reenviarComprobante).toHaveBeenCalledWith("c1", { numero: "FV 101" }));
    expect(toast.success).toHaveBeenCalledWith("Comprobante reenviado");
    expect(onHecho).toHaveBeenCalled();
  });

  it("puede cambiar de punto y reemplazar el PDF (solo PDF)", async () => {
    api.reenviarComprobante.mockResolvedValue(comp());
    render(<ModalReenviar comprobante={comp({ estado: "devuelto" })} puntos={puntos} onCerrar={() => {}} onHecho={() => {}} />);
    await userEvent.selectOptions(screen.getByLabelText("Punto"), "p2");
    expect(screen.getByLabelText(/Reemplazar PDF/)).toHaveAttribute("accept", ".pdf,application/pdf");
    const pdf = new File(["x"], "nuevo.pdf", { type: "application/pdf" });
    await userEvent.upload(screen.getByLabelText(/Reemplazar PDF/), pdf);
    await userEvent.click(screen.getByRole("button", { name: "Corregir y reenviar" }));
    await waitFor(() => expect(api.reenviarComprobante).toHaveBeenCalledWith("c1", { punto_id: "p2", archivo: pdf }));
  });

  it("sin cambios se reenvia igual (el backend lo vuelve a poner pendiente)", async () => {
    api.reenviarComprobante.mockResolvedValue(comp());
    render(<ModalReenviar comprobante={comp({ estado: "devuelto" })} puntos={puntos} onCerrar={() => {}} onHecho={() => {}} />);
    await userEvent.click(screen.getByRole("button", { name: "Corregir y reenviar" }));
    await waitFor(() => expect(api.reenviarComprobante).toHaveBeenCalledWith("c1", {}));
  });
});

describe("ModalEditarBorrador", () => {
  const traslado = (parcial: Partial<Traslado> = {}): Traslado =>
    ({
      id: "t1",
      numero: "FV 7",
      archivo_nombre: "a.pdf",
      pdf_url: "http://x/a.pdf",
      estado: "borrador",
      advertencias: [],
      fecha: "2026-11-02",
      concepto: "Traslado de mercancia",
      elaboro: null,
      origen_texto: "Bodega Central",
      destino_texto: "Punto Norte",
      origen_punto_id: "p2",
      origen_punto: null,
      destino_punto_id: null,
      destino_punto: null,
      creado_por: null,
      creado_at: "",
      actualizado_at: "",
      enviado_at: null,
      comprobantes: [],
      ...parcial,
    }) as Traslado;

  it("precarga los datos, marca los puntos internos y muestra el texto leido del PDF", () => {
    render(<ModalEditarBorrador traslado={traslado()} puntos={puntos} onCerrar={() => {}} onHecho={() => {}} />);
    expect(screen.getByLabelText("Número")).toHaveValue("FV 7");
    expect(screen.getByLabelText("Fecha")).toHaveValue("2026-11-02");
    expect(screen.getByLabelText("Concepto")).toHaveValue("Traslado de mercancia");
    expect(screen.getByLabelText("Origen")).toHaveValue("p2");
    expect(within(screen.getByLabelText("Origen")).getByRole("option", { name: /Bodega Central.*interna/i })).toBeInTheDocument();
    expect(screen.getByText("Leído en el PDF: origen")).toBeInTheDocument();
    expect(screen.getByText("Leído en el PDF: destino")).toBeInTheDocument();
  });

  it("guarda con PATCH y manda null en los campos vaciados", async () => {
    api.actualizarTraslado.mockResolvedValue(traslado());
    const onHecho = vi.fn();
    render(<ModalEditarBorrador traslado={traslado()} puntos={puntos} onCerrar={() => {}} onHecho={onHecho} />);
    await userEvent.clear(screen.getByLabelText("Concepto"));
    await userEvent.selectOptions(screen.getByLabelText("Destino"), "p1");
    await userEvent.click(screen.getByRole("button", { name: "Guardar cambios" }));
    await waitFor(() =>
      expect(api.actualizarTraslado).toHaveBeenCalledWith("t1", {
        numero: "FV 7",
        origen_punto_id: "p2",
        destino_punto_id: "p1",
        fecha: "2026-11-02",
        concepto: null,
      }),
    );
    expect(toast.success).toHaveBeenCalledWith("Borrador actualizado");
    expect(onHecho).toHaveBeenCalled();
  });

  it("un numero vacio se envia como null", async () => {
    api.actualizarTraslado.mockResolvedValue(traslado());
    render(<ModalEditarBorrador traslado={traslado()} puntos={puntos} onCerrar={() => {}} onHecho={() => {}} />);
    await userEvent.clear(screen.getByLabelText("Número"));
    await userEvent.click(screen.getByRole("button", { name: "Guardar cambios" }));
    await waitFor(() => expect(api.actualizarTraslado).toHaveBeenCalledWith("t1", expect.objectContaining({ numero: null })));
  });
});

describe("ModalHistorial", () => {
  const montar = () =>
    render(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <ModalHistorial comprobanteId="c1" titulo="FV 100" onCerrar={() => {}} />
      </SWRConfig>,
    );

  it("lista los eventos en orden como linea de tiempo", async () => {
    api.fetchComprobante.mockResolvedValue(
      comp({
        historial: [
          { evento: "enviado", actor: "Ana", resultado: "ok", detalle: "Envio inicial", timestamp: "2026-11-01T10:00:00Z" },
          { evento: "devuelto", actor: "Laura", resultado: "ok", detalle: "Cantidad errada", timestamp: "2026-11-02T10:00:00Z" },
        ],
      }),
    );
    montar();
    expect(await screen.findByText("Envio inicial")).toBeInTheDocument();
    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent("Ana");
    expect(items[1]).toHaveTextContent("Cantidad errada");
  });

  it("muestra eventos reales del backend: nombre largo, actor con prefijo y detalle como objeto", async () => {
    api.fetchComprobante.mockResolvedValue(
      comp({
        historial: [
          {
            evento: "traslado_comprobante_creado",
            actor: "dashboard:yohana",
            resultado: "ok",
            detalle: { numero: "TB4-7278", tipo: "ingreso" },
            timestamp: "2026-11-01T10:00:00Z",
          },
          {
            evento: "traslado_comprobante_devuelto",
            actor: "dashboard:susa",
            resultado: "ok",
            detalle: { numero: "TB4-7278", tipo: "ingreso", motivo: "Faltan 2 bultos", estado_anterior: "pendiente" },
            timestamp: "2026-11-02T10:00:00Z",
          },
        ],
      }),
    );
    montar();
    const items = await screen.findAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent("Enviado al punto");
    expect(items[0]).toHaveTextContent("yohana");
    expect(items[0]).not.toHaveTextContent("dashboard:");
    expect(items[1]).toHaveTextContent("Devuelto");
    expect(items[1]).toHaveTextContent("Motivo: Faltan 2 bultos");
  });

  it("sin eventos lo dice, y un error permite reintentar", async () => {
    api.fetchComprobante.mockResolvedValueOnce(comp({ historial: [] }));
    montar();
    expect(await screen.findByText(/Sin eventos/)).toBeInTheDocument();
  });

  it("muestra el error de carga", async () => {
    api.fetchComprobante.mockRejectedValue(new Error("No se pudo cargar"));
    montar();
    expect(await screen.findByText("No se pudo cargar")).toBeInTheDocument();
  });
});

describe("ModalVisor", () => {
  it("PDF: iframe y enlace para abrir en otra pestaña", () => {
    render(<ModalVisor titulo="a.pdf" url="http://x/a.pdf" tipo="pdf" onCerrar={() => {}} />);
    expect(screen.getByTitle("a.pdf")).toHaveAttribute("src", "http://x/a.pdf");
    const enlace = screen.getByRole("link", { name: /Abrir en pestaña nueva/ });
    expect(enlace).toHaveAttribute("href", "http://x/a.pdf");
    expect(enlace).toHaveAttribute("target", "_blank");
    expect(enlace).toHaveAttribute("rel", expect.stringContaining("noopener"));
  });

  it("imagen: muestra la firma", () => {
    render(<ModalVisor titulo="Firma" url="http://x/f.png" tipo="imagen" onCerrar={() => {}} />);
    expect(screen.getByRole("img", { name: "Firma" })).toHaveAttribute("src", "http://x/f.png");
  });

  it("Escape cierra", async () => {
    const onCerrar = vi.fn();
    render(<ModalVisor titulo="a.pdf" url="http://x/a.pdf" tipo="pdf" onCerrar={onCerrar} />);
    await userEvent.keyboard("{Escape}");
    expect(onCerrar).toHaveBeenCalled();
  });
});
