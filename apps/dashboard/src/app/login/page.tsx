"use client";

// Login del panel (usuario + contraseña, ver POST /dashboard/auth/login).
// Distinto del login por PIN de /faia, que es para empleados de FAIA.

import { Suspense, useEffect, useState, type FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useSesion } from "@/lib/SesionProvider";
import { claseBoton } from "@/components/ui";
import { Logo } from "@/components/Logo";

// Solo rutas internas: evita redirigir a otro sitio con ?siguiente=//evil.com.
function destinoSeguro(siguiente: string | null): string {
  if (!siguiente || !siguiente.startsWith("/") || siguiente.startsWith("//") || siguiente.startsWith("/login")) {
    return "/";
  }
  return siguiente;
}

// Mensaje para el usuario: nunca muestra el "Failed to fetch" del navegador.
// fetch lanza TypeError cuando no hay conexion con el servidor; cualquier otro
// error trae el mensaje del backend (credenciales, bloqueo por intentos, etc.).
function mensajeLogin(err: unknown): string {
  if (err instanceof TypeError) return "No se pudo conectar con el servidor. Inténtalo de nuevo.";
  const mensaje = err instanceof Error ? err.message : "";
  if (!mensaje || /usuario o contraseña/i.test(mensaje)) {
    return "Usuario o contraseña incorrectos. Inténtalo de nuevo.";
  }
  return mensaje;
}

function FormularioLogin() {
  const { listo, sesion, login } = useSesion();
  const router = useRouter();
  const params = useSearchParams();
  const expirada = params.get("expirada") === "1";
  const destino = destinoSeguro(params.get("siguiente"));

  const [usuario, setUsuario] = useState("");
  const [password, setPassword] = useState("");
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Ya hay sesion (recien iniciada o abierta en otra pestaña): se sigue al panel.
  useEffect(() => {
    if (listo && sesion) router.replace(destino);
  }, [listo, sesion, destino, router]);

  const enviar = async (ev: FormEvent) => {
    ev.preventDefault();
    setError(null);
    setEnviando(true);
    try {
      await login(usuario, password);
    } catch (err) {
      setError(mensajeLogin(err));
      setEnviando(false);
    }
  };

  return (
    <main className="flex w-full flex-1 items-center justify-center px-4 py-10">
      <div className="flex w-full max-w-sm flex-col gap-6">
        <header className="flex flex-col gap-3">
          <Logo tamano="grande" animado className="self-center" />
          <div className="mt-2 flex flex-col gap-1 text-center">
            <h1 className="titular text-[22px] leading-tight text-ink">Iniciar sesión</h1>
            <p className="text-sm text-muted">Entra al panel de despachos con tu usuario y contraseña.</p>
          </div>
        </header>

        {expirada ? (
          <div role="status" className="rounded-md border border-warn/40 bg-warn-fill/15 px-4 py-3 text-sm text-warn">
            Tu sesión expiró. Vuelve a entrar con tu usuario y contraseña.
          </div>
        ) : null}

        <form onSubmit={enviar} className="flex flex-col gap-4 rounded-lg border border-line bg-surface p-5 sm:p-6">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="login-usuario" className="text-sm font-medium text-soft">
              Usuario
            </label>
            <input
              id="login-usuario"
              autoFocus
              autoComplete="username"
              autoCapitalize="none"
              value={usuario}
              onChange={(e) => setUsuario(e.target.value)}
              aria-invalid={error ? true : undefined}
              className="min-h-11 rounded-md border border-line-strong bg-surface px-3 text-sm text-ink"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="login-password" className="text-sm font-medium text-soft">
              Contraseña
            </label>
            <input
              id="login-password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              aria-invalid={error ? true : undefined}
              className="min-h-11 rounded-md border border-line-strong bg-surface px-3 text-sm text-ink"
            />
          </div>
          {error ? (
            <p role="alert" className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger-fg">
              {error}
            </p>
          ) : null}
          <button
            type="submit"
            disabled={enviando || !usuario.trim() || !password}
            className={claseBoton("primario", "min-h-11 w-full")}
          >
            {enviando ? "Entrando…" : "Entrar"}
          </button>
        </form>
      </div>
    </main>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <FormularioLogin />
    </Suspense>
  );
}
