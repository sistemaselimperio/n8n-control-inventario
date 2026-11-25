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

describe("ModalConfirmarComprobante", () => {
  const usuario = { nombre: "Laura Perez", cedula: "1002003004" };
  const montar = (u = usuario) => {
    const onHecho = vi.fn();
    const onCerrar = vi.fn();
    render(<ModalConfirmarComprobante comprobante={comp()} usuario={u} onCerrar={onCerrar} onHecho={onHecho} />);
    return { onHecho, onCerrar };
  };

  it("muestra quien firma: nombre y cedula del usuario de la sesion", () => {
    montar();
    expect(screen.getByText("Laura Perez")).toBeInTheDocument();
    expect(screen.getByText(/C\.C\. 1002003004/)).toBeInTheDocument();
  });

  it("sin cedula igual deja firmar y confirmar: basta con la sesion del punto", async () => {
    montar({ nombre: "Punto Susa", cedula: "" });
    expect(screen.queryByText(/C\.C\./)).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByLabelText("Área de firma")).toBeInTheDocument();
    firmar();
    await waitFor(() => expect(screen.getByRole("button", { name: "Confirmar recepción" })).toBeEnabled());
  });

  it("el boton queda deshabilitado hasta que haya un trazo", async () => {
    montar();
    const boton = screen.getByRole("button", { name: "Confirmar recepción" });
    expect(boton).toBeDisabled();
    firmar();
    await waitFor(() => expect(boton).toBeEnabled());
    await userEvent.click(screen.getByRole("button", { name: "Limpiar" }));
    await waitFor(() => expect(boton).toBeDisabled());
  });

  it("envia la firma PNG y la observacion, avisa y avisa al padre", async () => {
    api.confirmarComprobante.mockResolvedValue(comp({ estado: "confirmado" }));
    const { onHecho } = montar();
    firmar();
    await userEvent.type(screen.getByLabelText(/Observación/), "Todo completo");
    await userEvent.click(screen.getByRole("button", { name: "Confirmar recepción" }));
    await waitFor(() => expect(api.confirmarComprobante).toHaveBeenCalled());
    const [id, blob, obs] = api.confirmarComprobante.mock.calls[0];
    expect(id).toBe("c1");
    expect((blob as Blob).type).toBe("image/png");
    expect(obs).toBe("Todo completo");
    expect(toast.success).toHaveBeenCalledWith("Recepción confirmada");
    expect(onHecho).toHaveBeenCalled();
  });

  it("un error del backend se muestra dentro del modal y no cierra", async () => {
    api.confirmarComprobante.mockRejectedValue(new Error("Ya fue confirmado"));
    const { onHecho } = montar();
    firmar();
    await userEvent.click(screen.getByRole("button", { name: "Confirmar recepción" }));
    expect(await screen.findByText("Ya fue confirmado")).toBeInTheDocument();
    expect(onHecho).not.toHaveBeenCalled();
  });
});

describe("ModalDevolver", () => {
  it("exige un motivo y limita a 500 caracteres", async () => {
    api.devolverComprobante.mockResolvedValue(comp({ estado: "devuelto" }));
    const onHecho = vi.fn();
    render(<ModalDevolver comprobante={comp()} onCerrar={() => {}} onHecho={onHecho} />);
    const boton = screen.getByRole("button", { name: "Devolver" });
    expect(boton).toBeDisabled();
    expect(screen.getByLabelText(/Motivo/)).toHaveAttribute("maxlength", "500");
    await userEvent.type(screen.getByLabelText(/Motivo/), "   ");
    expect(boton).toBeDisabled();
    await userEvent.type(screen.getByLabelText(/Motivo/), "Cantidad errada");
    await userEvent.click(boton);
    await waitFor(() => expect(api.devolverComprobante).toHaveBeenCalledWith("c1", "Cantidad errada"));
    expect(toast.success).toHaveBeenCalledWith("Comprobante devuelto");
    expect(onHecho).toHaveBeenCalled();
  });

  it("muestra el error del backend", async () => {
    api.devolverComprobante.mockRejectedValue(new Error("No permitido"));
    render(<ModalDevolver comprobante={comp()} onCerrar={() => {}} onHecho={() => {}} />);
    await userEvent.type(screen.getByLabelText(/Motivo/), "x");
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
