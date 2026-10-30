import { afterEach, describe, expect, it, vi } from "vitest";

const createClient = vi.hoisted(() => vi.fn(() => ({ canal: "falso" })));
vi.mock("@supabase/supabase-js", () => ({ createClient }));

async function cargar() {
  vi.resetModules();
  return import("./supabase");
}

afterEach(() => createClient.mockClear());

describe("cliente de Supabase (solo Realtime)", () => {
  it("es null si faltan las variables, sin crear ningun cliente", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "");
    expect((await cargar()).supabase).toBeNull();
    expect(createClient).not.toHaveBeenCalled();
  });

  it("es null si falta solo la clave", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://x.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "");
    expect((await cargar()).supabase).toBeNull();
  });

  it("crea el cliente con la URL y la clave publicable", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://falso.supabase.test");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "clave-publica-falsa");
    const { supabase } = await cargar();
    expect(createClient).toHaveBeenCalledWith("https://falso.supabase.test", "clave-publica-falsa");
    expect(supabase).toEqual({ canal: "falso" });
  });
});
