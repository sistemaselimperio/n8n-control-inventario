import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SubidaPdfs } from "./SubidaPdfs";

const api = vi.hoisted(() => ({ subirTraslados: vi.fn() }));
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  ...api,
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

const pdf = (nombre: string, bytes = 10) =>
  new File([new Uint8Array(bytes)], nombre, { type: "application/pdf" });

beforeEach(() => {
  api.subirTraslados.mockReset();
  toast.success.mockReset();
  toast.error.mockReset();
});

const entrada = () => screen.getByLabelText("Seleccionar PDFs") as HTMLInputElement;

describe("SubidaPdfs", () => {
  it("acepta varios PDF por clic", () => {
    render(<SubidaPdfs />);
    expect(entrada()).toHaveAttribute("multiple");
    expect(entrada()).toHaveAttribute("accept", ".pdf,application/pdf");
  });

  it("sube cada archivo, muestra el progreso y el resultado de cada uno", async () => {
    api.subirTraslados.mockImplementation(async (archivos: File[]) => {
      const nombre = archivos[0].name;
      const mapa: Record<string, object> = {
        "a.pdf": { archivo: "a.pdf", resultado: "creado", detalle: "Traslado FV 1 listo", traslado: null },
        "b.pdf": { archivo: "b.pdf", resultado: "borrador", detalle: "Falta el destino", traslado: null },
        "c.pdf": { archivo: "c.pdf", resultado: "duplicado", detalle: "Ya existe FV 3", traslado: null },
        "d.pdf": { archivo: "d.pdf", resultado: "error", detalle: "No se pudo leer", traslado: null },
      };
      return { resultados: [mapa[nombre]] };
    });
    const onTerminado = vi.fn();
    render(<SubidaPdfs onTerminado={onTerminado} />);
    await userEvent.upload(entrada(), [pdf("a.pdf"), pdf("b.pdf"), pdf("c.pdf"), pdf("d.pdf")]);
    await waitFor(() => expect(onTerminado).toHaveBeenCalled());
    expect(api.subirTraslados).toHaveBeenCalledTimes(4);
    const lista = screen.getByRole("list", { name: "Resultado de la carga" });
    const items = within(lista).getAllByRole("listitem");
    expect(items).toHaveLength(4);
    expect(items[0]).toHaveTextContent("a.pdf");
    expect(items[0]).toHaveTextContent("Creado");
    expect(items[1]).toHaveTextContent("Borrador");
    expect(items[1]).toHaveTextContent("Falta el destino");
    expect(items[2]).toHaveTextContent("Duplicado");
    expect(items[2]).toHaveTextContent("Ya existe FV 3");
    expect(items[3]).toHaveTextContent("Error");
    expect(items[3]).toHaveTextContent("No se pudo leer");
  });

  it("muestra una barra de progreso mientras sube", async () => {
    let liberar: () => void = () => {};
    api.subirTraslados.mockImplementation(
      () =>
        new Promise((resolver) => {
          liberar = () => resolver({ resultados: [{ archivo: "a.pdf", resultado: "creado", detalle: null, traslado: null }] });
        }),
    );
    render(<SubidaPdfs />);
    await userEvent.upload(entrada(), [pdf("a.pdf")]);
    const barra = await screen.findByRole("progressbar");
    expect(barra).toHaveAttribute("aria-valuemax", "1");
    expect(barra).toHaveAttribute("aria-valuenow", "0");
    liberar();
    await waitFor(() => expect(screen.queryByRole("progressbar")).toBeNull());
  });

  it("un fallo de red de un archivo no detiene a los demas", async () => {
    api.subirTraslados
      .mockRejectedValueOnce(new Error("Archivo demasiado grande"))
      .mockResolvedValueOnce({ resultados: [{ archivo: "b.pdf", resultado: "creado", detalle: null, traslado: null }] });
    render(<SubidaPdfs />);
    await userEvent.upload(entrada(), [pdf("a.pdf"), pdf("b.pdf")]);
    const items = await screen.findAllByRole("listitem");
    await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(2));
    expect(items[0]).toHaveTextContent("Archivo demasiado grande");
    expect(screen.getAllByRole("listitem")[1]).toHaveTextContent("Creado");
  });

  it("rechaza lo que no es PDF y lo que pasa de 5 MB sin llamar al backend", async () => {
    render(<SubidaPdfs />);
    const txt = new File(["hola"], "notas.txt", { type: "text/plain" });
    // fireEvent: user-event filtraria por `accept` y no llegaria el archivo invalido.
    fireEvent.change(entrada(), { target: { files: [txt, pdf("grande.pdf", 5 * 1024 * 1024 + 1)] } });
    expect(await screen.findByText(/notas\.txt: solo se aceptan archivos PDF/)).toBeInTheDocument();
    expect(screen.getByText(/grande\.pdf: supera los 5 MB/)).toBeInTheDocument();
    expect(api.subirTraslados).not.toHaveBeenCalled();
  });

  it("limita a 20 archivos por carga y lo avisa", async () => {
    api.subirTraslados.mockResolvedValue({ resultados: [{ archivo: "x.pdf", resultado: "creado", detalle: null, traslado: null }] });
    render(<SubidaPdfs />);
    const muchos = Array.from({ length: 21 }, (_, i) => pdf(`f${i}.pdf`));
    fireEvent.change(entrada(), { target: { files: muchos } });
    expect(await screen.findByText(/máximo 20 archivos/i)).toBeInTheDocument();
    await waitFor(() => expect(api.subirTraslados).toHaveBeenCalledTimes(20));
  });

  it("soltar archivos en la zona los sube", async () => {
    api.subirTraslados.mockResolvedValue({ resultados: [{ archivo: "a.pdf", resultado: "creado", detalle: null, traslado: null }] });
    render(<SubidaPdfs />);
    const zona = screen.getByTestId("zona-subida");
    fireEvent.dragOver(zona, { dataTransfer: { files: [] } });
    fireEvent.drop(zona, { dataTransfer: { files: [pdf("a.pdf")] } });
    await waitFor(() => expect(api.subirTraslados).toHaveBeenCalledTimes(1));
  });
});
