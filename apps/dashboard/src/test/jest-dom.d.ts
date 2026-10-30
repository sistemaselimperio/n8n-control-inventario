// Solo tipos: agrega los matchers de jest-dom (toBeInTheDocument, toHaveValue...) a
// Assertion de Vitest para que `next build` (tsc) entienda las pruebas. El registro
// en tiempo de ejecucion se hace en vitest.setup.ts.
import "@testing-library/jest-dom/vitest";
