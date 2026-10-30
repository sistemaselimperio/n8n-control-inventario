import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Boton, EncabezadoPagina, ErrorConReintento, EstadoVacio, Indicador, Panel, Pildora, Segmentado, claseBoton } from "./ui";

describe("ErrorConReintento", () => {
  it("muestra el mensaje como alerta y reintenta al pulsar", async () => {
    const onReintentar = vi.fn();
    render(<ErrorConReintento mensaje="Sin conexion" onReintentar={onReintentar} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Sin conexion");
    await userEvent.click(screen.getByRole("button", { name: "Reintentar" }));
    expect(onReintentar).toHaveBeenCalledOnce();
  });
});

describe("EstadoVacio", () => {
  it("muestra titulo y ayuda opcional", () => {
    const { rerender } = render(<EstadoVacio titulo="Nada por aqui" />);
    expect(screen.getByText("Nada por aqui")).toBeInTheDocument();
    expect(screen.queryByText("Prueba otro filtro")).toBeNull();
    rerender(<EstadoVacio titulo="Nada por aqui" ayuda="Prueba otro filtro" />);
    expect(screen.getByText("Prueba otro filtro")).toBeInTheDocument();
  });
});

describe("Indicador", () => {
  it("cargando oculta la cifra", () => {
    render(<Indicador etiqueta="Hoy" valor="12" cargando />);
    expect(screen.getByText("Hoy")).toBeInTheDocument();
    expect(screen.queryByText("12")).toBeNull();
  });

  it("muestra valor, unidad y detalle (o 'Sin datos')", () => {
    const { rerender } = render(<Indicador etiqueta="Hoy" valor="12" unidad="uds" detalle="de 20" cargando={false} />);
    expect(screen.getByText("12")).toBeInTheDocument();
    expect(screen.getByText("uds")).toBeInTheDocument();
    expect(screen.getByText("de 20")).toBeInTheDocument();
    rerender(<Indicador etiqueta="Hoy" valor="0" cargando={false} />);
    expect(screen.getByText("Sin datos")).toBeInTheDocument();
  });
});

describe("Panel", () => {
  it("enlaza el titulo con la seccion cuando hay id y muestra conteo, subtitulo y acciones", () => {
    render(
      <Panel id="uno" titulo="Empleados" conteo="3" subtitulo="Quienes entran" acciones={<button>Nuevo</button>}>
        contenido
      </Panel>,
    );
    expect(screen.getByRole("region", { name: /Empleados/ })).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
    expect(screen.getByText("Quienes entran")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Nuevo" })).toBeInTheDocument();
    expect(screen.getByText("contenido")).toBeInTheDocument();
  });
});

describe("Segmentado", () => {
  const opciones = [
    { valor: "a", etiqueta: "Uno" },
    { valor: "b", etiqueta: "Dos" },
    { valor: "c", etiqueta: "Tres", deshabilitada: true },
  ] as const;

  it("marca la opcion activa y avisa el cambio", async () => {
    const onCambiar = vi.fn();
    render(<Segmentado etiqueta="Filtro" opciones={opciones} valor="a" onCambiar={onCambiar} />);
    expect(screen.getByRole("button", { name: "Uno" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Dos" })).toHaveAttribute("aria-pressed", "false");
    await userEvent.click(screen.getByRole("button", { name: "Dos" }));
    expect(onCambiar).toHaveBeenCalledWith("b");
  });

  it("una opcion deshabilitada no dispara el cambio", async () => {
    const onCambiar = vi.fn();
    render(<Segmentado etiqueta="Filtro" opciones={opciones} valor={null} onCambiar={onCambiar} />);
    await userEvent.click(screen.getByRole("button", { name: "Tres" }));
    expect(onCambiar).not.toHaveBeenCalled();
  });
});

describe("Boton y claseBoton", () => {
  it("el boton es type=button por defecto (no envia formularios sin querer)", () => {
    render(<Boton>Ok</Boton>);
    expect(screen.getByRole("button", { name: "Ok" })).toHaveAttribute("type", "button");
  });

  it("acepta type=submit y respeta disabled", () => {
    render(
      <Boton type="submit" disabled>
        Enviar
      </Boton>,
    );
    expect(screen.getByRole("button", { name: "Enviar" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Enviar" })).toHaveAttribute("type", "submit");
  });

  it("claseBoton agrega la variante y las clases extra", () => {
    expect(claseBoton("peligro", "w-full")).toContain("bg-danger-solid");
    expect(claseBoton("peligro", "w-full")).toContain("w-full");
    expect(claseBoton()).toContain("border-line-strong");
  });
});

describe("Pildora y EncabezadoPagina", () => {
  it("la pildora aplica el tono", () => {
    render(<Pildora tono="ok">Listo</Pildora>);
    expect(screen.getByText("Listo").className).toContain("text-ok-fg");
  });

  it("el encabezado muestra titulo como h1 y las partes opcionales solo si existen", () => {
    const { rerender } = render(<EncabezadoPagina titulo="Entregas" />);
    expect(screen.getByRole("heading", { level: 1, name: "Entregas" })).toBeInTheDocument();
    rerender(<EncabezadoPagina titulo="Entregas" sobretitulo="Panel" descripcion="Todo el historial" acciones={<button>Ir</button>} />);
    expect(screen.getByText("Panel")).toBeInTheDocument();
    expect(screen.getByText("Todo el historial")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Ir" })).toBeInTheDocument();
  });
});
