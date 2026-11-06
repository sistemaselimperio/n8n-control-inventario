import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SWRConfig } from "swr";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BorradorTrasladoBodega, TrasladoDetalle } from "@/lib/api";

const api = vi.hoisted(() => ({
  fetchPuntosPublicos: vi.fn(),
  leerBorradorTrasladoBodega: vi.fn(),
  enviarTrasladoBodega: vi.fn(),
  editarTrasladoBodega: vi.fn(),
}));
vi.mock("@/lib/api", () => api);
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

import { ModalTrasladoBodega } from "./ModalTrasladoBodega";

const PUNTOS = [
  { id: "p1", nombre: "CFC — La Cumbre", codigo: "CFC" },
  { id: "p2", nombre: "PT — Puente de Tierra", codigo: "PT" },
];

const borrador = (extra: Partial<BorradorTrasladoBodega> = {}): BorradorTrasladoBodega => ({
  numero: "NPT-1839",
  fecha: "2026-11-02",
  concepto: "SUGERIDO PUENTE 29 OCTUBRE",
  origen: "BODEGA VENTAS",
  destino_texto: "BODEGA PUENTE DE TIERRA",
  elaboro: "YOHANA",
  total_documento: 20,
  items: [
    { referencia: "02058", detalle: "C. CONTELAC 18 P.", empaque: "BULTO", cantidad: 15, precio: 75700 },
    { referencia: "1476", detalle: "25-4-24 NUTRIMON", empaque: "BULTO", cantidad: 5, precio: 140000 },
  ],
  advertencias: [],
  punto_destino_id: "p2",
  ya_cargado: false,
  ...extra,
});

const pdf = (nombre = "NPT 1839.pdf", tipo = "application/pdf", tamano = 10) => {
  const f = new File(["%PDF-1.4"], nombre, { type: tipo });
  Object.defineProperty(f, "size", { value: tamano });
  return f;
};

function montar(props: { traslado?: TrasladoDetalle } = {}) {
  const onCerrar = vi.fn();
  const onGuardado = vi.fn();
  render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <ModalTrasladoBodega onCerrar={onCerrar} onGuardado={onGuardado} {...props} />
    </SWRConfig>,
  );
  return { onCerrar, onGuardado };
}

const subir = (archivo = pdf()) =>
  userEvent.upload(screen.getByLabelText("Archivo PDF del traslado"), archivo, { applyAccept: false });

beforeEach(() => {
  Object.values(api).forEach((f) => f.mockReset());
  api.fetchPuntosPublicos.mockResolvedValue(PUNTOS);
  api.leerBorradorTrasladoBodega.mockResolvedValue(borrador());
  api.enviarTrasladoBodega.mockResolvedValue({ id: "t1" });
  api.editarTrasladoBodega.mockResolvedValue({ id: "t1" });
  toast.success.mockReset();
  toast.error.mockReset();
});

describe("ModalTrasladoBodega: subir el PDF", () => {
  it("empieza pidiendo el PDF", () => {
    montar();
    expect(screen.getByRole("dialog", { name: "Subir traslado de bodega" })).toBeInTheDocument();
    expect(screen.getByLabelText("Archivo PDF del traslado")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Enviar traslado" })).toBeNull();
  });

  it("rechaza lo que no es PDF sin llamar al backend", async () => {
    montar();
    await subir(pdf("foto.png", "image/png"));
    expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/PDF/));
    expect(api.leerBorradorTrasladoBodega).not.toHaveBeenCalled();
  });

  it("rechaza un PDF de mas de 5 MB", async () => {
    montar();
    await subir(pdf("grande.pdf", "application/pdf", 5 * 1024 * 1024 + 1));
    expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/5 MB/));
    expect(api.leerBorradorTrasladoBodega).not.toHaveBeenCalled();
  });

  it("si el backend no puede leer el PDF muestra el motivo y deja elegir otro", async () => {
    api.leerBorradorTrasladoBodega.mockRejectedValue(new Error("El PDF no tiene texto legible"));
    montar();
    await subir();
    expect(await screen.findByText("El PDF no tiene texto legible")).toBeInTheDocument();
    expect(screen.getByLabelText("Archivo PDF del traslado")).toBeInTheDocument();
  });
});

describe("ModalTrasladoBodega: revisar el borrador", () => {
  it("muestra los datos leidos, los productos y el punto sugerido", async () => {
    montar();
    await subir();
    expect(await screen.findByLabelText("Número del traslado")).toHaveValue("NPT-1839");
    expect(screen.getByLabelText("Fecha")).toHaveValue("2026-11-02");
    expect(screen.getByLabelText("Concepto")).toHaveValue("SUGERIDO PUENTE 29 OCTUBRE");
    expect(screen.getByLabelText("Bodega de origen")).toHaveValue("BODEGA VENTAS");
    expect(screen.getByLabelText("Elaboró")).toHaveValue("YOHANA");
    expect(screen.getByLabelText("Referencia 1")).toHaveValue("02058"); // ceros intactos
    expect(screen.getByLabelText("Detalle 2")).toHaveValue("25-4-24 NUTRIMON");
    expect(screen.getByLabelText("Cantidad 1")).toHaveValue(15);
    expect(screen.getByLabelText("Precio 2")).toHaveValue(140000);
    expect(screen.getByLabelText("Punto de destino")).toHaveValue("p2");
  });

  it("lista las advertencias del PDF", async () => {
    api.leerBorradorTrasladoBodega.mockResolvedValue(
      borrador({ advertencias: ["No se pudo leer el renglón: 999 ROTO"] }),
    );
    montar();
    await subir();
    expect(await screen.findByText(/No se pudo leer el renglón: 999 ROTO/)).toBeInTheDocument();
  });

  it("compara la suma de cantidades con el total del PDF", async () => {
    montar();
    await subir();
    expect(await screen.findByText(/Suma de cantidades: 20/)).toBeInTheDocument();
    expect(screen.queryByText(/no coincide con el total/i)).toBeNull();

    await userEvent.clear(screen.getByLabelText("Cantidad 1"));
    await userEvent.type(screen.getByLabelText("Cantidad 1"), "10");
    expect(screen.getByText(/Suma de cantidades: 15/)).toBeInTheDocument();
    expect(screen.getByText(/no coincide con el total del PDF \(20\)/i)).toBeInTheDocument();
  });

  it("sin punto sugerido obliga a elegir uno antes de enviar", async () => {
    api.leerBorradorTrasladoBodega.mockResolvedValue(borrador({ punto_destino_id: null }));
    montar();
    await subir();
    const enviar = await screen.findByRole("button", { name: "Enviar traslado" });
    expect(enviar).toBeDisabled();
    expect(screen.getByText(/Elige el punto de destino/)).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText("Punto de destino"), "p1");
    expect(enviar).toBeEnabled();
  });

  it("avisa cuando el traslado ya fue cargado", async () => {
    api.leerBorradorTrasladoBodega.mockResolvedValue(borrador({ ya_cargado: true }));
    montar();
    await subir();
    expect(await screen.findByText(/ya fue cargado/i)).toBeInTheDocument();
  });

  it("no deja enviar con un producto incompleto", async () => {
    montar();
    await subir();
    await userEvent.clear(await screen.findByLabelText("Detalle 1"));
    expect(screen.getByRole("button", { name: "Enviar traslado" })).toBeDisabled();
    expect(screen.getByText(/Revisa los productos/)).toBeInTheDocument();
  });

  it("quitar un renglon lo saca de la tabla", async () => {
    montar();
    await subir();
    await userEvent.click(await screen.findByRole("button", { name: "Quitar producto 1" }));
    expect(screen.queryByDisplayValue("02058")).toBeNull();
    expect(screen.getByDisplayValue("1476")).toBeInTheDocument();
  });

  it("agregar un producto suma un renglon vacio", async () => {
    montar();
    await subir();
    await userEvent.click(await screen.findByRole("button", { name: "Agregar producto" }));
    expect(screen.getByLabelText("Referencia 3")).toHaveValue("");
  });
});

describe("ModalTrasladoBodega: enviar", () => {
  it("manda el PDF y los datos revisados, avisa y cierra", async () => {
    const { onCerrar, onGuardado } = montar();
    const archivo = pdf();
    await subir(archivo);
    await userEvent.clear(await screen.findByLabelText("Concepto"));
    await userEvent.type(screen.getByLabelText("Concepto"), "CORREGIDO");
    await userEvent.click(screen.getByRole("button", { name: "Enviar traslado" }));

    await waitFor(() => expect(onGuardado).toHaveBeenCalled());
    expect(api.enviarTrasladoBodega).toHaveBeenCalledWith(archivo, {
      numero: "NPT-1839",
      fecha: "2026-11-02",
      concepto: "CORREGIDO",
      origen: "BODEGA VENTAS",
      punto_destino_id: "p2",
      elaboro: "YOHANA",
      items: [
        { referencia: "02058", detalle: "C. CONTELAC 18 P.", empaque: "BULTO", cantidad: 15, precio: 75700 },
        { referencia: "1476", detalle: "25-4-24 NUTRIMON", empaque: "BULTO", cantidad: 5, precio: 140000 },
      ],
    });
    expect(toast.success).toHaveBeenCalled();
    expect(onCerrar).toHaveBeenCalled();
  });

  it("si el backend rechaza (409) muestra el mensaje y no cierra", async () => {
    api.enviarTrasladoBodega.mockRejectedValue(new Error("El traslado NPT-1839 ya fue cargado"));
    const { onCerrar, onGuardado } = montar();
    await subir();
    await userEvent.click(await screen.findByRole("button", { name: "Enviar traslado" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("El traslado NPT-1839 ya fue cargado"));
    expect(onGuardado).not.toHaveBeenCalled();
    expect(onCerrar).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Enviar traslado" })).toBeEnabled();
  });
});

describe("ModalTrasladoBodega: editar un traslado en transito", () => {
  const detalle = {
    id: "t9",
    tipo: "desde_bodega",
    estado: "en_transito",
    punto_destino_id: "p2",
    numero_documento: "NPT-1839",
    numero_syscafe: "NPT-1839",
    fecha: "2026-11-02",
    concepto: "SUGERIDO",
    origen_texto: "BODEGA VENTAS",
    punto_origen_nombre: "BODEGA VENTAS",
    elaboro: "YOHANA",
    items: [
      { id: "i1", producto: "C. CONTELAC", presentacion: "BULTO", referencia: "02058", precio: 75700, cantidad: 15 },
    ],
  } as unknown as TrasladoDetalle;

  it("abre directo en la revision, con los datos del traslado", async () => {
    montar({ traslado: detalle });
    expect(screen.getByRole("dialog", { name: "Editar traslado de bodega" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Archivo PDF del traslado")).toBeNull();
    expect(screen.getByLabelText("Número del traslado")).toHaveValue("NPT-1839");
    expect(screen.getByLabelText("Referencia 1")).toHaveValue("02058");
    expect(screen.getByLabelText("Empaque 1")).toHaveValue("BULTO");
    expect(await screen.findByLabelText("Punto de destino")).toHaveValue("p2");
  });

  it("guardar llama a editar con el id y cierra", async () => {
    const { onCerrar, onGuardado } = montar({ traslado: detalle });
    await userEvent.clear(screen.getByLabelText("Cantidad 1"));
    await userEvent.type(screen.getByLabelText("Cantidad 1"), "12");
    await userEvent.click(await screen.findByRole("button", { name: "Guardar cambios" }));
    await waitFor(() => expect(onGuardado).toHaveBeenCalled());
    const [id, datos] = api.editarTrasladoBodega.mock.calls[0];
    expect(id).toBe("t9");
    expect(datos.items[0]).toMatchObject({ referencia: "02058", cantidad: 12, precio: 75700 });
    expect(datos.origen).toBe("BODEGA VENTAS");
    expect(api.enviarTrasladoBodega).not.toHaveBeenCalled();
    expect(onCerrar).toHaveBeenCalled();
  });

  it("si ya lo recibieron muestra el 409", async () => {
    api.editarTrasladoBodega.mockRejectedValue(new Error("Este traslado ya fue recibido y no se puede modificar"));
    montar({ traslado: detalle });
    await userEvent.click(await screen.findByRole("button", { name: "Guardar cambios" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/ya fue recibido/)));
  });
});

describe("ModalTrasladoBodega: accesibilidad basica", () => {
  it("la tabla de productos tiene encabezados", async () => {
    montar();
    await subir();
    const tabla = await screen.findByRole("table", { name: "Productos del traslado" });
    for (const col of ["Referencia", "Detalle", "Empaque", "Cantidad", "Precio"]) {
      expect(within(tabla).getByRole("columnheader", { name: col })).toBeInTheDocument();
    }
  });
});
