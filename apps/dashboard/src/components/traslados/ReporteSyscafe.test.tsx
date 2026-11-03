import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ subirReporteSyscafeDashboard: vi.fn() }));
vi.mock("@/lib/api", () => api);
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

import { MAX_BYTES_REPORTE, ReporteSyscafe, validarArchivoReporte } from "./ReporteSyscafe";

const sinReporte = {
  id: "t1",
  reporte_syscafe_url: null,
  reporte_syscafe_tipo: null,
  reporte_syscafe_at: null,
  reporte_syscafe_por: null,
};

const archivo = (nombre: string, tipo: string, tamano = 10) => {
  const f = new File(["x"], nombre, { type: tipo });
  Object.defineProperty(f, "size", { value: tamano });
  return f;
};

const entrada = () => screen.getByLabelText("Archivo del reporte Syscafe");

beforeEach(() => {
  api.subirReporteSyscafeDashboard.mockReset().mockResolvedValue({});
  toast.success.mockReset();
  toast.error.mockReset();
  URL.createObjectURL = vi.fn(() => "blob:previa");
  URL.revokeObjectURL = vi.fn();
});

describe("validarArchivoReporte", () => {
  it("acepta jpg, png, webp y pdf de hasta 5 MB", () => {
    for (const tipo of ["image/jpeg", "image/png", "image/webp", "application/pdf"]) {
      expect(validarArchivoReporte(archivo("a", tipo, MAX_BYTES_REPORTE))).toBeNull();
    }
  });

  it("rechaza otros tipos y archivos de mas de 5 MB", () => {
    expect(validarArchivoReporte(archivo("a.txt", "text/plain"))).toMatch(/JPG, PNG, WebP o PDF/);
    expect(validarArchivoReporte(archivo("a.pdf", "application/pdf", MAX_BYTES_REPORTE + 1))).toMatch(/5 MB/);
  });
});

describe("ReporteSyscafe: subir", () => {
  it("no muestra el control a quien no puede subir", () => {
    render(<ReporteSyscafe traslado={sinReporte} puedeSubir={false} onSubido={vi.fn()} />);
    expect(screen.queryByLabelText("Archivo del reporte Syscafe")).toBeNull();
    expect(screen.getByText(/Sin reporte/i)).toBeInTheDocument();
  });

  it("elegir un archivo valido muestra la vista previa y pide confirmacion antes de subir", async () => {
    render(<ReporteSyscafe traslado={sinReporte} puedeSubir onSubido={vi.fn()} />);
    await userEvent.upload(entrada(), archivo("reporte.png", "image/png"));
    expect(screen.getByAltText("Vista previa del reporte")).toHaveAttribute("src", "blob:previa");
    expect(screen.getByText(/no se puede cambiar/i)).toBeInTheDocument();
    expect(api.subirReporteSyscafeDashboard).not.toHaveBeenCalled();
  });

  it("para un PDF muestra el nombre del archivo", async () => {
    render(<ReporteSyscafe traslado={sinReporte} puedeSubir onSubido={vi.fn()} />);
    await userEvent.upload(entrada(), archivo("reporte.pdf", "application/pdf"));
    expect(screen.getByText("reporte.pdf")).toBeInTheDocument();
    expect(screen.queryByAltText("Vista previa del reporte")).toBeNull();
  });

  it("confirmar sube el archivo, avisa y recarga", async () => {
    const onSubido = vi.fn();
    render(<ReporteSyscafe traslado={sinReporte} puedeSubir onSubido={onSubido} />);
    const f = archivo("reporte.pdf", "application/pdf");
    await userEvent.upload(entrada(), f);
    await userEvent.click(screen.getByRole("button", { name: "Confirmar y subir" }));
    await waitFor(() => expect(onSubido).toHaveBeenCalled());
    expect(api.subirReporteSyscafeDashboard).toHaveBeenCalledWith("t1", f);
    expect(toast.success).toHaveBeenCalled();
  });

  it("cancelar descarta el archivo sin subir", async () => {
    render(<ReporteSyscafe traslado={sinReporte} puedeSubir onSubido={vi.fn()} />);
    await userEvent.upload(entrada(), archivo("reporte.pdf", "application/pdf"));
    await userEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(entrada()).toBeInTheDocument();
    expect(api.subirReporteSyscafeDashboard).not.toHaveBeenCalled();
  });

  it("un archivo invalido muestra el error y no pide confirmacion", async () => {
    render(<ReporteSyscafe traslado={sinReporte} puedeSubir onSubido={vi.fn()} />);
    await userEvent.upload(entrada(), archivo("a.txt", "text/plain"), { applyAccept: false });
    expect(toast.error).toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Confirmar y subir" })).toBeNull();
  });

  it("si el backend falla muestra el mensaje y permite reintentar", async () => {
    api.subirReporteSyscafeDashboard.mockRejectedValue(new Error("Este traslado ya tiene un reporte Syscafe"));
    const onSubido = vi.fn();
    render(<ReporteSyscafe traslado={sinReporte} puedeSubir onSubido={onSubido} />);
    await userEvent.upload(entrada(), archivo("r.pdf", "application/pdf"));
    await userEvent.click(screen.getByRole("button", { name: "Confirmar y subir" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Este traslado ya tiene un reporte Syscafe"));
    expect(onSubido).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Confirmar y subir" })).toBeEnabled();
  });
});

describe("ReporteSyscafe: ya subido", () => {
  const conImagen = {
    ...sinReporte,
    reporte_syscafe_url: "https://x/reporte.webp",
    reporte_syscafe_tipo: "image/webp",
    reporte_syscafe_at: "2026-10-13T10:00:00Z",
    reporte_syscafe_por: "Ana Prueba",
  };

  it("imagen: miniatura que enlaza al archivo y sin control de subida", () => {
    render(<ReporteSyscafe traslado={conImagen} puedeSubir onSubido={vi.fn()} />);
    const enlace = screen.getByRole("link", { name: /reporte syscafe/i });
    expect(enlace).toHaveAttribute("href", "https://x/reporte.webp");
    expect(enlace).toHaveAttribute("target", "_blank");
    expect(screen.getByAltText("Reporte Syscafe")).toHaveAttribute("src", "https://x/reporte.webp");
    expect(screen.queryByLabelText("Archivo del reporte Syscafe")).toBeNull();
    expect(screen.getByText(/Ana Prueba/)).toBeInTheDocument();
  });

  it("pdf: enlace Ver PDF en pestaña nueva, visible aunque no pueda subir", () => {
    render(
      <ReporteSyscafe
        traslado={{ ...conImagen, reporte_syscafe_url: "https://x/r.pdf", reporte_syscafe_tipo: "application/pdf" }}
        puedeSubir={false}
        onSubido={vi.fn()}
      />,
    );
    const enlace = screen.getByRole("link", { name: "Ver PDF" });
    expect(enlace).toHaveAttribute("href", "https://x/r.pdf");
    expect(enlace).toHaveAttribute("target", "_blank");
  });
});
