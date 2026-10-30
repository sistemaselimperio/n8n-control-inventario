// Utilidades compartidas por las pruebas: respuestas falsas de fetch y una
// sesion guardada. Nada aqui toca la red real.

import { vi } from "vitest";
import { guardarSesion, type Sesion } from "@/lib/sesion";

export function respuestaJson(cuerpo: unknown, status = 200): Response {
  return new Response(JSON.stringify(cuerpo), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// Reemplaza fetch por un mock; cada llamada devuelve las respuestas en orden
// (la ultima se repite). Una funcion permite construir la respuesta al vuelo.
export function mockFetch(...respuestas: (Response | (() => Response | Promise<Response>) | Error)[]) {
  let i = 0;
  const fn = vi.fn(async () => {
    const r = respuestas[Math.min(i++, respuestas.length - 1)];
    if (r instanceof Error) throw r;
    return typeof r === "function" ? r() : r.clone();
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

export const SESION_PRUEBA: Sesion = {
  token: "tok-123",
  usuario: { id: "u1", usuario: "ana", nombre: "Ana", rol: "admin", area: "todo" },
  expira_at: new Date(Date.now() + 3_600_000).toISOString(),
};

export function iniciarSesionDePrueba(parcial: Partial<Sesion> = {}): Sesion {
  const s = { ...SESION_PRUEBA, ...parcial };
  guardarSesion(s);
  return s;
}

// location de jsdom no se puede espiar: se sustituye por un objeto simple para
// comprobar las redirecciones (window.location.assign).
export function mockLocation(pathname = "/entregas") {
  const assign = vi.fn();
  vi.stubGlobal("location", { pathname, assign, href: `http://localhost${pathname}` });
  return assign;
}

export function ultimaLlamada(fn: ReturnType<typeof vi.fn>) {
  const [url, init] = fn.mock.calls.at(-1) as [string, RequestInit | undefined];
  return { url, init: init ?? {}, headers: new Headers(init?.headers) };
}
