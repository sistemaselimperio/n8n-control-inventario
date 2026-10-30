import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup } from "@testing-library/react";
import { afterEach, expect, vi } from "vitest";

// Se registran los matchers de jest-dom a mano: la entrada /vitest del paquete
// no extiende el expect de esta instancia de Vitest.
expect.extend(matchers);

// Cada prueba parte de un navegador limpio: sin componentes montados, sin
// globales sustituidas (fetch, location) y sin sesion ni preferencias
// guardadas por la prueba anterior.
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  try {
    localStorage.clear();
  } catch {
    // Algunas pruebas sustituyen localStorage por uno que falla a proposito.
  }
});
