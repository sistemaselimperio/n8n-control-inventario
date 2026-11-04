import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ asignarSyscafeDashboard: vi.fn(), subirReporteSyscafeDashboard: vi.fn() }));
vi.mock("@/lib/api", () => api);
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

import { SeccionSyscafe } from "./SeccionSyscafe";

const base = {
  id: "t1",
  numero_syscafe: null as string | null,
  numero_syscafe_at: null as string | null,
  numero_syscafe_por: null as string | null,
  reporte_syscafe_url: null as string | null,
  reporte_syscafe_tipo: null as string | null,
  reporte_syscafe_at: null as string | null,
  reporte_syscafe_por: null as string | null,
};

beforeEach(() => {
  api.asignarSyscafeDashboard.mockReset().mockResolvedValue(undefined);
  api.subirReporteSyscafeDashboard.mockReset().mockResolvedValue({});
  toast.success.mockReset();
  toast.error.mockReset();
});

describe("SeccionSyscafe", () => {
  it("es una seccion propia con titulo Traslado y su estado", () => {
    render(<SeccionSyscafe traslado={base} puedeEditar onCambio={vi.fn()} />);
    const seccion = screen.getByRole("region", { name: "Traslado" });
    expect(within(seccion).getByText("Falta número y reporte")).toBeInTheDocument();
  });

  it("completo cuando tiene numero y reporte", () => {
    render(
      <SeccionSyscafe
        traslado={{
          ...base,
          numero_syscafe: "CUK-172",
          numero_syscafe_at: "2026-10-28T14:40:05Z",
          numero_syscafe_por: "Erika",
          reporte_syscafe_url: "https://x/r.png",
          reporte_syscafe_tipo: "image/png",
          reporte_syscafe_at: "2026-10-28T15:00:00Z",
          reporte_syscafe_por: "Erika",
        }}
        puedeEditar
        onCambio={vi.fn()}
      />,
    );
    expect(screen.getByText("Completo")).toBeInTheDocument();
    expect(screen.getByText("CUK-172")).toBeInTheDocument();
  });

  it("registrar el numero con prefijo e indicativo guarda PREFIJO-NUMERO", async () => {
    const onCambio = vi.fn();
    render(<SeccionSyscafe traslado={base} puedeEditar onCambio={onCambio} />);
    await userEvent.click(screen.getByRole("button", { name: "Registrar número de traslado" }));
    await userEvent.type(screen.getByLabelText("Prefijo"), "cuk");
    await userEvent.type(screen.getByLabelText("Indicativo"), "172{Enter}");
    await waitFor(() => expect(api.asignarSyscafeDashboard).toHaveBeenCalledWith("t1", "CUK-172"));
    await waitFor(() => expect(onCambio).toHaveBeenCalled());
  });

  it("editar trae el numero actual separado y borrar lo quita", async () => {
    render(
      <SeccionSyscafe traslado={{ ...base, numero_syscafe: "CUK-172" }} puedeEditar onCambio={vi.fn()} />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Editar número de traslado" }));
    expect(screen.getByLabelText("Prefijo")).toHaveValue("CUK");
    expect(screen.getByLabelText("Indicativo")).toHaveValue("172");
    await userEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    await userEvent.click(screen.getByRole("button", { name: "Borrar número de traslado" }));
    await waitFor(() => expect(api.asignarSyscafeDashboard).toHaveBeenCalledWith("t1", null));
  });

  it("sin permiso no muestra controles de edicion ni de subida", () => {
    render(<SeccionSyscafe traslado={base} puedeEditar={false} onCambio={vi.fn()} />);
    expect(screen.queryByRole("button", { name: /número de traslado/ })).toBeNull();
    expect(screen.queryByLabelText("Archivo del reporte de traslado")).toBeNull();
  });
});
