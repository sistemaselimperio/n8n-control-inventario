import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SWRConfig } from "swr";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorAdmin, type ReceptorAdmin } from "@/lib/api";
import { SeccionReceptores } from "./SeccionReceptores";

const api = vi.hoisted(() => ({
  fetchPuntosAdmin: vi.fn(),
  fetchReceptoresAdmin: vi.fn(),
  crearReceptor: vi.fn(),
  actualizarReceptor: vi.fn(),
  eliminarReceptor: vi.fn(),
}));
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  ...api,
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

const puntos = [
  { id: "p1", nombre: "NVL — Villa de Leyva", codigo: "NVL", activo: true, es_interna: false, alias: [] },
  { id: "p2", nombre: "TB — Chiquinquirá", codigo: "TB", activo: true, es_interna: false, alias: [] },
  { id: "p3", nombre: "OLD — Cerrado", codigo: "OLD", activo: false, es_interna: false, alias: [] },
];

const receptor = (parcial: Partial<ReceptorAdmin>): ReceptorAdmin => ({
  id: "r1",
  punto_id: "p1",
  punto_nombre: "NVL — Villa de Leyva",
  nombre: "Luis Pérez",
  cedula: "1234567",
  activo: true,
  creado_at: "2026-11-01T10:00:00Z",
  ...parcial,
});

const lista = [
  receptor({}),
  receptor({ id: "r2", nombre: "Ana Gil", cedula: "7654321", activo: false }),
  receptor({ id: "r3", punto_id: "p2", punto_nombre: "TB — Chiquinquirá", nombre: "Pedro Soto", cedula: "1112223" }),
];

const montar = () =>
  render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <SeccionReceptores />
    </SWRConfig>
  );

const fila = (nombre: string) => screen.getByText(nombre).closest("li") as HTMLElement;

beforeEach(() => {
  Object.values(api).forEach((f) => f.mockReset());
  api.fetchPuntosAdmin.mockResolvedValue(puntos);
  api.fetchReceptoresAdmin.mockResolvedValue(lista);
  api.crearReceptor.mockResolvedValue(receptor({}));
  api.actualizarReceptor.mockResolvedValue(receptor({}));
  api.eliminarReceptor.mockResolvedValue({ ok: true });
  toast.success.mockReset();
  toast.error.mockReset();
});

describe("SeccionReceptores", () => {
  it("agrupa los receptores por punto, con su estado, e incluye los inactivos", async () => {
    montar();
    await screen.findByText("Luis Pérez");
    expect(api.fetchReceptoresAdmin).toHaveBeenCalledWith(undefined);
    expect(screen.getByRole("heading", { name: /NVL — Villa de Leyva/ })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /TB — Chiquinquirá/ })).toBeInTheDocument();
    expect(within(fila("Luis Pérez")).getByText("Activo")).toBeInTheDocument();
    expect(within(fila("Ana Gil")).getByText("Inactivo")).toBeInTheDocument();
    expect(within(fila("Luis Pérez")).getByText(/C\.C\. 1234567/)).toBeInTheDocument();
  });

  it("filtra por punto", async () => {
    montar();
    await screen.findByText("Luis Pérez");
    await userEvent.selectOptions(screen.getByLabelText("Filtrar por punto"), "p2");
    await waitFor(() => expect(api.fetchReceptoresAdmin).toHaveBeenLastCalledWith("p2"));
  });

  it("agrega un receptor: punto, nombre y cedula validos habilitan el boton", async () => {
    montar();
    await screen.findByText("Luis Pérez");
    const boton = screen.getByRole("button", { name: "Agregar receptor" });
    expect(boton).toBeDisabled();
    const formulario = screen.getByRole("group", { name: "Agregar receptor" });
    // Solo puntos activos para elegir.
    expect(within(formulario).queryByRole("option", { name: /OLD/ })).toBeNull();
    await userEvent.selectOptions(within(formulario).getByLabelText("Punto"), "p2");
    await userEvent.type(within(formulario).getByLabelText("Nombre"), "  Marta Ríos ");
    await userEvent.type(within(formulario).getByLabelText("Cédula"), "12ab");
    expect(boton).toBeDisabled();
    await userEvent.clear(within(formulario).getByLabelText("Cédula"));
    await userEvent.type(within(formulario).getByLabelText("Cédula"), "52.123.456");
    await waitFor(() => expect(boton).toBeEnabled());
    await userEvent.click(boton);
    await waitFor(() =>
      expect(api.crearReceptor).toHaveBeenCalledWith({ punto_id: "p2", nombre: "Marta Ríos", cedula: "52123456" })
    );
    expect(toast.success).toHaveBeenCalledWith("Receptor agregado");
    expect(within(formulario).getByLabelText("Nombre")).toHaveValue("");
  });

  it("un duplicado muestra el aviso del backend y conserva el formulario", async () => {
    api.crearReceptor.mockRejectedValue(new ErrorAdmin("Ya existe un receptor con esa cédula en ese punto", 409));
    montar();
    await screen.findByText("Luis Pérez");
    const formulario = screen.getByRole("group", { name: "Agregar receptor" });
    await userEvent.selectOptions(within(formulario).getByLabelText("Punto"), "p1");
    await userEvent.type(within(formulario).getByLabelText("Nombre"), "Luis");
    await userEvent.type(within(formulario).getByLabelText("Cédula"), "1234567");
    await userEvent.click(screen.getByRole("button", { name: "Agregar receptor" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Ya existe un receptor con esa cédula en ese punto"));
    expect(within(formulario).getByLabelText("Nombre")).toHaveValue("Luis");
  });

  it("edita nombre, cedula y punto", async () => {
    montar();
    await screen.findByText("Luis Pérez");
    await userEvent.click(within(fila("Luis Pérez")).getByRole("button", { name: "Editar" }));
    const nombre = screen.getByLabelText("Nombre del receptor");
    await userEvent.clear(nombre);
    await userEvent.type(nombre, "Luis P.");
    const cedula = screen.getByLabelText("Cédula del receptor");
    await userEvent.clear(cedula);
    await userEvent.type(cedula, "9.999.999");
    await userEvent.selectOptions(screen.getByLabelText("Punto del receptor"), "p2");
    await userEvent.click(screen.getByRole("button", { name: "Guardar" }));
    await waitFor(() =>
      expect(api.actualizarReceptor).toHaveBeenCalledWith("r1", { nombre: "Luis P.", cedula: "9999999", punto_id: "p2" })
    );
    expect(toast.success).toHaveBeenCalledWith("Receptor actualizado");
  });

  it("edita solo lo que cambio", async () => {
    montar();
    await screen.findByText("Luis Pérez");
    await userEvent.click(within(fila("Luis Pérez")).getByRole("button", { name: "Editar" }));
    const nombre = screen.getByLabelText("Nombre del receptor");
    await userEvent.clear(nombre);
    await userEvent.type(nombre, "Luis Eduardo");
    await userEvent.click(screen.getByRole("button", { name: "Guardar" }));
    await waitFor(() => expect(api.actualizarReceptor).toHaveBeenCalledWith("r1", { nombre: "Luis Eduardo" }));
  });

  it("desactiva y activa", async () => {
    montar();
    await screen.findByText("Luis Pérez");
    await userEvent.click(within(fila("Luis Pérez")).getByRole("button", { name: "Desactivar" }));
    await waitFor(() => expect(api.actualizarReceptor).toHaveBeenCalledWith("r1", { activo: false }));
    expect(toast.success).toHaveBeenCalledWith("Receptor desactivado");
    await userEvent.click(within(fila("Ana Gil")).getByRole("button", { name: "Activar" }));
    await waitFor(() => expect(api.actualizarReceptor).toHaveBeenCalledWith("r2", { activo: true }));
    expect(toast.success).toHaveBeenCalledWith("Receptor activado");
  });

  it("eliminar pide confirmacion dentro de la app y borra de verdad", async () => {
    montar();
    await screen.findByText("Luis Pérez");
    await userEvent.click(within(fila("Luis Pérez")).getByRole("button", { name: "Eliminar" }));
    const dialogo = await screen.findByRole("dialog");
    expect(within(dialogo).getByText(/¿Eliminar Luis Pérez\?/)).toBeInTheDocument();
    expect(within(dialogo).getByText(/conservan su nombre y cédula/)).toBeInTheDocument();
    expect(api.eliminarReceptor).not.toHaveBeenCalled();
    await userEvent.click(within(dialogo).getByRole("button", { name: "Eliminar" }));
    await waitFor(() => expect(api.eliminarReceptor).toHaveBeenCalledWith("r1"));
    expect(toast.success).toHaveBeenCalledWith("Receptor eliminado");
  });

  it("cancelar la confirmacion no borra nada", async () => {
    montar();
    await screen.findByText("Luis Pérez");
    await userEvent.click(within(fila("Luis Pérez")).getByRole("button", { name: "Eliminar" }));
    await userEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Cancelar" }));
    expect(api.eliminarReceptor).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("sin receptores muestra el estado vacio", async () => {
    api.fetchReceptoresAdmin.mockResolvedValue([]);
    montar();
    expect(await screen.findByText("Todavía no hay registros.")).toBeInTheDocument();
  });

  it("si la lista falla ofrece reintentar", async () => {
    api.fetchReceptoresAdmin.mockRejectedValueOnce(new Error("Sin conexión")).mockResolvedValue(lista);
    montar();
    expect(await screen.findByText("Sin conexión")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Reintentar/ }));
    expect(await screen.findByText("Luis Pérez")).toBeInTheDocument();
  });
});
