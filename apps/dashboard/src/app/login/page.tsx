"use client";

// Login del panel (usuario + contraseña, ver POST /dashboard/auth/login).
// Distinto del login por PIN de /faia, que es para empleados de FAIA.

import { Suspense, useEffect, useState, type FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useSesion } from "@/lib/SesionProvider";
import Image from "next/image";

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

// Ojo abierto / tachado para mostrar u ocultar la contraseña (decorativo:
// el boton lleva su propio nombre accesible).
function IconoOjo({ tachado }: { tachado: boolean }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={1.8}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z" />
      <circle cx="12" cy="12" r="3" />
      {tachado ? <path strokeLinecap="round" d="M4 4l16 16" /> : null}
    </svg>
  );
}

function IconoCandado() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={1.8}>
      <rect x="5" y="10.5" width="14" height="10" rx="2" />
      <path strokeLinecap="round" d="M8 10.5V7.5a4 4 0 0 1 8 0v3" />
    </svg>
  );
}

// Borde rasgado de la tirilla: dientes de sierra en blanco (SVG, sin degradados).
function BordeRasgado({ abajo = false }: { abajo?: boolean }) {
  return (
    <svg aria-hidden className={`block h-2.5 w-full text-white ${abajo ? "rotate-180" : ""}`} preserveAspectRatio="none">
      <defs>
        <pattern id={abajo ? "diente-b" : "diente-a"} width="14" height="10" patternUnits="userSpaceOnUse">
          <path d="M0 10 L7 0 L14 10 Z" fill="currentColor" />
        </pattern>
      </defs>
      <rect width="100%" height="100%" fill={`url(#${abajo ? "diente-b" : "diente-a"})`} />
    </svg>
  );
}

// Las dos piezas del panel, con datos de ejemplo: la tirilla de un despacho
// (guia fotografiada y leida) y la hoja de talonario de un traslado entre
// puntos (numero de talonario + numero Syscafe, como en /traslados).

const RENGLONES_DESPACHO = [
  ["Concentrado 40 kg", "12"],
  ["Sal mineralizada", "6"],
  ["Melaza 20 L", "4"],
] as const;

function TirillaDespacho() {
  return (
    <figure aria-label="Tirilla de ejemplo de un despacho" className="relative z-10 w-[250px] -rotate-3">
      <BordeRasgado />
      <div className="bg-white px-5 py-4 text-left font-mono text-[12px] leading-relaxed text-ink">
        <p className="text-center font-semibold">DESPACHO</p>
        <p className="text-center text-muted">Guía fotografiada en sede</p>
        <p className="mt-2 border-t-2 border-dashed border-line-strong pt-2 text-center font-sans text-3xl font-bold leading-none tracking-tight">
          FEI 10254
        </p>
        <ul className="mt-2 border-t-2 border-dashed border-line-strong pt-1.5">
          {RENGLONES_DESPACHO.map(([producto, cantidad]) => (
            <li key={producto} className="flex justify-between gap-3">
              <span className="truncate">{producto}</span>
              <span className="tabular-nums">{cantidad}</span>
            </li>
          ))}
        </ul>
        <p className="mt-1.5 flex justify-between border-t-2 border-dashed border-line-strong pt-1.5 font-semibold">
          <span>ESTADO</span>
          <span className="text-ok-fg">PROCESADA</span>
        </p>
      </div>
      <BordeRasgado abajo />
    </figure>
  );
}

function TalonarioTraslado() {
  return (
    <figure aria-label="Hoja de talonario de ejemplo de un traslado" className="relative w-[290px] rotate-2">
      {/* Hojas de abajo del talonario. */}
      <span aria-hidden className="absolute inset-0 translate-x-2 translate-y-2 rounded-sm bg-surface-2" />
      <span aria-hidden className="absolute inset-0 translate-x-1 translate-y-1 rounded-sm bg-line" />
      <div className="relative rounded-sm bg-white text-left text-ink">
        {/* Lomo del talonario con sus grapas. */}
        <div className="flex h-5 items-center justify-around rounded-t-sm bg-ink">
          <span aria-hidden className="h-1 w-6 rounded-full bg-line-strong" />
          <span aria-hidden className="h-1 w-6 rounded-full bg-line-strong" />
        </div>
        <div className="flex font-mono text-[12px] leading-relaxed">
          {/* Colilla que queda pegada al talonario, separada por la perforacion. */}
          <div className="flex w-16 shrink-0 flex-col items-center justify-center gap-1 border-r-2 border-dashed border-line-strong px-2 py-4 text-center">
            <span className="text-muted">No.</span>
            <span className="font-sans text-xl font-bold leading-none">A 10</span>
          </div>
          <div className="min-w-0 flex-1 px-4 py-3">
            <p className="font-semibold">TRASLADO</p>
            <p className="text-muted">Entre puntos</p>
            <dl className="mt-2 border-t-2 border-dashed border-line-strong pt-1.5">
              <div className="flex justify-between gap-2">
                <dt className="text-muted">De</dt>
                <dd className="truncate">Bodega</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-muted">A</dt>
                <dd className="truncate">Punto Centro</dd>
              </div>
              <div className="flex justify-between gap-2 font-semibold">
                <dt>Syscafe</dt>
                <dd className="tabular-nums text-ok-fg">4587</dd>
              </div>
            </dl>
          </div>
        </div>
      </div>
    </figure>
  );
}

function FormularioLogin() {
  const { listo, sesion, login } = useSesion();
  const router = useRouter();
  const params = useSearchParams();
  const expirada = params.get("expirada") === "1";
  const destino = destinoSeguro(params.get("siguiente"));

  const [usuario, setUsuario] = useState("");
  const [password, setPassword] = useState("");
  const [verPassword, setVerPassword] = useState(false);
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

  const incompleto = !usuario.trim() || !password;
  const bloqueado = enviando || incompleto;

  const claseCampo =
    "min-h-12 w-full rounded-md border-2 border-line-strong bg-surface px-3.5 text-base text-ink transition-colors duration-150 hover:border-soft focus:border-cielo";

  return (
    // Pantalla partida: a la izquierda la marca sobre cielo (logo, la guia
    // como pieza central, el titular y la franja campo); a la derecha el
    // formulario. En movil la marca se reduce a una cabecera corta.
    // En escritorio ocupa exactamente la altura de la ventana (h-dvh): nada
    // obliga a hacer scroll. En pantallas bajas se ocultan las piezas de papel.
    <main className="grid w-full flex-1 lg:h-dvh lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)] lg:overflow-hidden">
      <section
        aria-label="Comercializadora El Imperio"
        className="flex min-h-0 flex-col overflow-hidden bg-cielo text-white"
      >
        {/* Banner de la marca pegado arriba, a todo el ancho del panel (foto:
            cielo, campo y mano con la planta; raster a proposito, una foto no
            se puede pasar a SVG sin perderla). La mascara desvanece su marco
            oscuro arriba y abajo para que se funda con el cielo. */}
        <Image
          src="/banner-el-imperio.png"
          alt="El Imperio Comercializadora. Cada vez más cerca del campo"
          width={1111}
          height={224}
          priority
          sizes="(min-width: 1024px) 52vw, 100vw"
          className="login-baja h-auto w-full shrink-0 [mask-image:linear-gradient(to_bottom,transparent,black_14%,black_84%,transparent)]"
        />
        <div className="flex min-h-0 w-full flex-1 flex-col items-center justify-center gap-6 px-6 py-8 text-center lg:gap-8 lg:px-12">
          {/* Talonario del traslado y tirilla del despacho, uno junto al otro. */}
          <div className="hidden items-start justify-center gap-5 sm:flex [@media(max-height:720px)]:hidden">
            <div className="login-talonario [--d:250ms]">
              <TalonarioTraslado />
            </div>
            <div className="login-tirilla mt-6 [--d:400ms]">
              <TirillaDespacho />
            </div>
          </div>

          <div className="flex max-w-xl flex-col items-center gap-3">
            <p className="login-sube [--d:350ms] text-3xl font-bold uppercase leading-[0.95] tracking-tight sm:text-4xl lg:text-5xl">
              Despachos y
              <br />
              traslados <span className="text-oro">al día.</span>
            </p>
            <p className="login-sube [--d:450ms] max-w-md text-base text-cielo-ink">
              Las guías que fotografían las sedes y los traslados entre puntos, con su número de talonario, en un solo lugar.
            </p>
          </div>
        </div>

        <p className="login-franja [--d:700ms] hidden w-full shrink-0 items-center justify-center gap-5 bg-campo px-6 py-3.5 text-sm font-bold uppercase tracking-wide text-ok-on lg:flex">
          <span>Entregas por guía</span>
          <span aria-hidden className="h-1 w-8 rounded-full bg-ok-on" />
          <span>Traslados entre puntos</span>
          <span aria-hidden className="h-1 w-8 rounded-full bg-ok-on" />
          <span>Sin duplicados</span>
        </p>
      </section>

      <div className="flex min-h-0 flex-col items-center justify-center gap-6 overflow-y-auto bg-page px-5 py-10 sm:px-10">
        <div className="login-tarjeta [--d:150ms] w-full max-w-md rounded-xl border-4 border-ink bg-surface p-6 shadow-[10px_10px_0_0_var(--color-campo)] sm:p-9">
          <h1 className="text-3xl font-bold uppercase leading-tight tracking-tight text-ink">Iniciar sesión</h1>
          <p className="mt-2 text-base text-soft">Ingresa con el usuario y la contraseña que se te asignó.</p>

          {expirada ? (
            <div role="status" className="mt-5 rounded-md border border-warn-fill/60 bg-warn-fill/15 px-4 py-3 text-sm text-warn">
              Tu sesión expiró. Vuelve a entrar con tu usuario y contraseña.
            </div>
          ) : null}

          <form onSubmit={enviar} aria-label="Iniciar sesión" className="mt-7 flex flex-col gap-5">
            <div className="flex flex-col gap-1.5">
              <label htmlFor="login-usuario" className="text-sm font-semibold text-ink">
                Usuario
              </label>
              <input
                id="login-usuario"
                autoFocus
                autoComplete="username"
                autoCapitalize="none"
                spellCheck={false}
                value={usuario}
                onChange={(e) => setUsuario(e.target.value)}
                aria-invalid={error ? true : undefined}
                className={claseCampo}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <label htmlFor="login-password" className="text-sm font-semibold text-ink">
                Contraseña
              </label>
              <div className="relative">
                <input
                  id="login-password"
                  type={verPassword ? "text" : "password"}
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  aria-invalid={error ? true : undefined}
                  className={`${claseCampo} pr-12`}
                />
                <button
                  type="button"
                  onClick={() => setVerPassword((v) => !v)}
                  aria-pressed={verPassword}
                  aria-controls="login-password"
                  aria-label={verPassword ? "Ocultar contraseña" : "Mostrar contraseña"}
                  className="absolute inset-y-0 right-0 flex w-12 items-center justify-center rounded-r-md text-muted transition-colors duration-150 hover:text-ink"
                >
                  <IconoOjo tachado={verPassword} />
                </button>
              </div>
            </div>

            {error ? (
              <p role="alert" className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger-fg">
                {error}
              </p>
            ) : null}

            <button
              type="submit"
              disabled={bloqueado}
              className={`mt-2 inline-flex min-h-12 w-full items-center justify-center rounded-md border-2 text-base font-bold uppercase tracking-wide transition-[transform,background-color] duration-150 ${
                bloqueado
                  ? // Deshabilitado legible (no a media opacidad).
                    "cursor-not-allowed border-line-strong bg-surface-2 text-subtle"
                  : "border-ink bg-ok text-ok-on hover:bg-ok-hover active:translate-y-px"
              }`}
            >
              {enviando ? "Entrando…" : "Entrar"}
            </button>
          </form>
        </div>

        <div className="login-sube [--d:450ms] flex max-w-md flex-col items-center gap-1 text-center text-sm text-muted">
          <p className="flex items-center gap-2">
            <IconoCandado />
            Solo personal autorizado.
          </p>
          <p>¿Olvidaste la contraseña? Un administrador la restablece desde Administración.</p>
        </div>
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
