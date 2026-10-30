import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Configuracion de Vitest siguiendo la guia de Next.js. Las variables
// NEXT_PUBLIC_* se fijan a valores falsos para que ninguna prueba toque el
// backend, Supabase ni Vercel reales.
export default defineConfig({
  plugins: [react()],
  // Los alias del tsconfig (@/*) se resuelven de forma nativa en Vite.
  resolve: { tsconfigPaths: true },
  test: {
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
    env: {
      NEXT_PUBLIC_API_URL: "http://api.test",
      NEXT_PUBLIC_SUPABASE_URL: "",
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "",
    },
    restoreMocks: true,
  },
});
