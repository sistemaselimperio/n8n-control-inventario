import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

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
