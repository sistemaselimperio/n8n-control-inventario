import { createRef } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FirmaCanvas, type ControlFirma } from "./FirmaCanvas";

const ctx = {
  scale: vi.fn(),
  setTransform: vi.fn(),
  beginPath: vi.fn(),
  moveTo: vi.fn(),
  lineTo: vi.fn(),
  stroke: vi.fn(),
  clearRect: vi.fn(),
  lineWidth: 0,
  lineCap: "",
  lineJoin: "",
  strokeStyle: "",
};

beforeEach(() => {
  [ctx.scale, ctx.setTransform, ctx.beginPath, ctx.moveTo, ctx.lineTo, ctx.stroke, ctx.clearRect].forEach((f) => f.mockClear());
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((cb) => cb(new Blob(["png"], { type: "image/png" })));
  vi.spyOn(HTMLCanvasElement.prototype, "getBoundingClientRect").mockReturnValue({
    left: 10,
    top: 20,
    width: 300,
    height: 150,
    right: 310,
    bottom: 170,
    x: 10,
    y: 20,
    toJSON: () => ({}),
  });
});

const lienzo = () => screen.getByLabelText("Área de firma") as HTMLCanvasElement;

function trazo(el: Element, tipo = "mouse") {
  fireEvent.pointerDown(el, { clientX: 20, clientY: 40, pointerId: 1, pointerType: tipo, buttons: 1 });
  fireEvent.pointerMove(el, { clientX: 60, clientY: 80, pointerId: 1, pointerType: tipo, buttons: 1 });
  fireEvent.pointerUp(el, { clientX: 60, clientY: 80, pointerId: 1, pointerType: tipo });
}

describe("FirmaCanvas", () => {
  it("el lienzo bloquea los gestos del navegador (touch-action none)", () => {
    render(<FirmaCanvas onCambio={() => {}} />);
    expect(lienzo().style.touchAction).toBe("none");
  });

  it("ajusta el lienzo a la densidad de pixeles de la pantalla", () => {
    vi.stubGlobal("devicePixelRatio", 2);
    render(<FirmaCanvas onCambio={() => {}} />);
    expect(lienzo().width).toBe(600);
    expect(lienzo().height).toBe(300);
    expect(ctx.scale).toHaveBeenCalledWith(2, 2);
  });

  it("avisa que hay trazo solo despues de dibujar, con raton, tactil o lapiz", () => {
    const onCambio = vi.fn();
    render(<FirmaCanvas onCambio={onCambio} />);
    expect(onCambio).not.toHaveBeenCalled();
    trazo(lienzo(), "touch");
    expect(onCambio).toHaveBeenLastCalledWith(true);
    expect(ctx.lineTo).toHaveBeenCalled();
    expect(ctx.stroke).toHaveBeenCalled();
  });

  it("un movimiento sin pulsar no dibuja", () => {
    const onCambio = vi.fn();
    render(<FirmaCanvas onCambio={onCambio} />);
    fireEvent.pointerMove(lienzo(), { clientX: 60, clientY: 80, pointerId: 1 });
    expect(onCambio).not.toHaveBeenCalled();
  });

  it("Limpiar borra el lienzo y avisa que ya no hay trazo", async () => {
    const onCambio = vi.fn();
    render(<FirmaCanvas onCambio={onCambio} />);
    trazo(lienzo());
    await userEvent.click(screen.getByRole("button", { name: "Limpiar" }));
    expect(ctx.clearRect).toHaveBeenCalled();
    expect(onCambio).toHaveBeenLastCalledWith(false);
  });

  it("exportar devuelve un PNG solo si hay trazo", async () => {
    const ref = createRef<ControlFirma>();
    render(<FirmaCanvas ref={ref} onCambio={() => {}} />);
    expect(await ref.current!.exportar()).toBeNull();
    trazo(lienzo());
    const blob = await ref.current!.exportar();
    expect(blob?.type).toBe("image/png");
  });
});
