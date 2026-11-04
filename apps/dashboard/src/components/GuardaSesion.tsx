"use client";

// Guard de rutas + barra de usuario, montado en el layout raiz. La sesion vive
// en localStorage (no en cookie), asi que el guard es del lado del cliente: no
// se renderiza nada protegido hasta saber que hay sesion, para no mostrar un
// destello del panel a quien no inicio sesion.

import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { toast } from "sonner";
import { cambiarPassword } from "@/lib/api";
import { Logo } from "@/components/Logo";
import { useSesion } from "@/lib/SesionProvider";
import { ETIQUETA_ROL, rutaInicial, rutaPermitida, type RolDashboard } from "@/lib/sesion";

// Rutas que no exigen sesion del panel: el login y /faia (que tiene su propio
// login por PIN para empleados de FAIA).
const RUTAS_PUBLICAS = ["/login", "/faia"];

const CLAVE_LOGO_ANIMADO = "logo-animado";

const esPublica = (ruta: string) => RUTAS_PUBLICAS.some((r) => ruta === r || ruta.startsWith(`${r}/`));

export const COLOR_ROL: Record<RolDashboard, string> = {
  admin: "border-ok/50 text-ok-fg",
  supervisor: "border-info/40 text-info",
  consulta: "border-line-strong text-muted",
};

export function GuardaSesion({ children }: { children: ReactNode }) {
  const { listo, sesion } = useSesion();
  const pathname = usePathname();
  const router = useRouter();
  const publica = esPublica(pathname);

  useEffect(() => {
    if (!listo || publica || sesion) return;
    const siguiente = pathname && pathname !== "/" ? `?siguiente=${encodeURIComponent(pathname)}` : "";
    router.replace(`/login${siguiente}`);
  }, [listo, publica, sesion, pathname, router]);

  // Area: si la ruta no corresponde al area del usuario, se lo lleva a su
  // primera pagina permitida (ej. traslados -> /traslados).
  const permitida = publica || !sesion || rutaPermitida(sesion.usuario, pathname);
  useEffect(() => {
    if (!permitida && sesion) router.replace(rutaInicial(sesion.usuario));
  }, [permitida, sesion, router]);

  if (publica) return <>{children}</>;

  if (!listo || !sesion || !permitida) {
    return (
      <div className="flex min-h-screen items-center justify-center" aria-busy>
        <div className="h-2 w-24 animate-pulse rounded bg-surface-2" />
      </div>
    );
  }

  return (
    <>
      <BarraUsuario />
      {children}
    </>
  );
}

// Enlaces del menu principal. `soloAdmin` replica la misma regla que ya usaba
// la portada (Planificacion de turnos y Administracion solo para admin).
// `grupo` separa la operacion diaria del analisis y de la configuracion: la
// barra los muestra como bloques, con la configuracion al extremo derecho.
type GrupoNav = "operacion" | "analisis" | "configuracion";
type EnlaceNav = { href: string; etiqueta: string; grupo: GrupoNav; icono: ReactNode; soloAdmin?: boolean };

// Iconos de contorno (24x24, trazo 1.75) dibujados aqui para no sumar una
// dependencia; son decorativos: la etiqueta de texto siempre acompaña.
const ICONOS = {
  entregas: (
    <path d="m7.5 4.27 9 5.15M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16ZM3.3 7 12 12l8.7-5M12 22V12" />
  ),
  traslados: (
    <>
      <path d="M14 18V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v11a1 1 0 0 0 1 1h2M15 18H9M19 18h2a1 1 0 0 0 1-1v-3.65a1 1 0 0 0-.22-.62l-3.48-4.35A1 1 0 0 0 17.52 8H14" />
      <circle cx="7" cy="18" r="2" />
      <circle cx="17" cy="18" r="2" />
    </>
  ),
  puntos: (
    <>
      <path d="M20 10c0 5-5.54 10.19-7.4 11.8a1 1 0 0 1-1.2 0C9.54 20.19 4 15 4 10a8 8 0 0 1 16 0" />
      <circle cx="12" cy="10" r="3" />
    </>
  ),
  ranking: <path d="M3 3v16a2 2 0 0 0 2 2h16M18 17V9M13 17V5M8 17v-3" />,
  turnos: (
    <>
      <path d="M8 2v4M16 2v4M3 10h18" />
      <rect x="3" y="4" width="18" height="18" rx="2" />
    </>
  ),
  catalogo: (
    <path d="M12 7v14M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3Z" />
  ),
  administracion: (
    <>
      <path d="M20 7h-9M14 17H5" />
      <circle cx="17" cy="17" r="3" />
      <circle cx="7" cy="7" r="3" />
    </>
  ),
};

// Todas las secciones son pestañas visibles de la barra superior (sin menus
// desplegables). "Entregas" es la pagina principal (el antiguo "Hoy" se
// fusiono con ella).
const ENLACES_NAV: EnlaceNav[] = [
  { href: "/entregas", etiqueta: "Entregas", grupo: "operacion", icono: ICONOS.entregas },
  { href: "/traslados", etiqueta: "Traslados", grupo: "operacion", icono: ICONOS.traslados },
  { href: "/puntos", etiqueta: "Puntos", grupo: "operacion", icono: ICONOS.puntos },
  { href: "/ranking", etiqueta: "Ranking", grupo: "analisis", icono: ICONOS.ranking },
  { href: "/turnos", etiqueta: "Turnos", grupo: "analisis", icono: ICONOS.turnos, soloAdmin: true },
  { href: "/productos", etiqueta: "Catálogo", grupo: "configuracion", icono: ICONOS.catalogo },
  { href: "/creador", etiqueta: "Administración", grupo: "configuracion", icono: ICONOS.administracion, soloAdmin: true },
];

function IconoNav({ children }: { children: ReactNode }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      className="h-4 w-4 shrink-0"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </svg>
  );
}

// Primer enlace de cada grupo (salvo el primero de todos): lleva el separador
// vertical delante; el de configuracion ademas se va al extremo derecho.
const claseInicioGrupo = (e: EnlaceNav, i: number) => {
  if (i === 0 || ENLACES_NAV[i - 1].grupo === e.grupo) return "";
  const separador =
    "relative ml-1 pl-1 before:absolute before:left-0 before:top-1/2 before:h-5 before:w-px before:-translate-y-1/2 before:bg-white/15";
  return e.grupo === "configuracion" ? `${separador} md:ml-auto` : separador;
};

const esActiva = (pathname: string, href: string) => pathname === href || pathname.startsWith(`${href}/`);

const AVISO_BLOQUEADO = "Tu cuenta no tiene acceso a esta sección";

// Candado de las secciones sin permiso (el texto atenuado y el aviso
// acompañan: el icono no va solo).
function Candado() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      className="h-3.5 w-3.5 shrink-0"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M7 11V7a5 5 0 0 1 10 0v4M5 11h14a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1Z" />
    </svg>
  );
}

// Pestañas subrayadas sobre el azul noche: la activa se ilumina a blanco y
// lleva una barra de 3px en el verde de marca pegada al borde inferior; las
// demas quedan en el gris azulado de la barra. El anillo de foco va hacia
// adentro (offset negativo) para que el scroll horizontal no lo recorte.
const CLASE_ITEM_NAV =
  "relative flex min-h-11 items-center gap-1.5 whitespace-nowrap px-3 text-sm transition-colors duration-150 focus-visible:outline-offset-[-2px] after:absolute after:inset-x-3 after:bottom-0 after:h-[3px] after:rounded-t-sm";

const claseItemNav = (activo: boolean) =>
  `${CLASE_ITEM_NAV} ${
    activo
      ? "font-semibold text-white after:bg-campo"
      : "font-medium text-cielo-ink after:bg-transparent hover:text-white hover:after:bg-white/25"
  }`;


// Iniciales del avatar: primera letra de las dos primeras palabras del nombre.
const iniciales = (nombre: string) =>
  nombre
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? "")
    .join("") || "?";

function BarraUsuario() {
  const { usuario, logout, esAdmin } = useSesion();
  const pathname = usePathname();
  const [menuAbierto, setMenuAbierto] = useState(false);
  const [cambiando, setCambiando] = useState(false);
  // En pantallas angostas la fila de pestañas hace scroll: al cambiar de ruta
  // se trae la pestaña activa a la vista para que no quede escondida.
  const activaRef = useRef<HTMLAnchorElement>(null);
  useEffect(() => {
    activaRef.current?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [pathname]);
  // El logo se anima solo la primera vez que se muestra en la sesion del
  // navegador (no en cada cambio de ruta). Si sessionStorage falla, queda estatico.
  const [animarLogo] = useState(() => {
    try {
      return window.sessionStorage.getItem(CLAVE_LOGO_ANIMADO) !== "1";
    } catch {
      return false;
    }
  });
  useEffect(() => {
    try {
      window.sessionStorage.setItem(CLAVE_LOGO_ANIMADO, "1");
    } catch {
      // Sin almacenamiento: el logo simplemente no se anima.
    }
  }, []);
  if (!usuario) return null;

  // Todas las secciones se muestran: las que el usuario no puede abrir quedan
  // bloqueadas (con candado y sin enlace) en lugar de desaparecer del menu.
  const permitido = (e: EnlaceNav) => (!e.soloAdmin || esAdmin) && rutaPermitida(usuario, e.href);
  const enlaceSimple = (e: EnlaceNav, i: number) => {
    const claseLi = `flex shrink-0 ${claseInicioGrupo(e, i)}`;
    if (!permitido(e)) {
      return (
        <li key={e.href} className={claseLi}>
          <span
            aria-disabled="true"
            title={AVISO_BLOQUEADO}
            className={`${CLASE_ITEM_NAV} cursor-not-allowed font-medium text-cielo-ink/50`}
          >
            <IconoNav>{e.icono}</IconoNav>
            {e.etiqueta}
            <Candado />
            <span className="sr-only">, sin acceso</span>
          </span>
        </li>
      );
    }
    const activa = esActiva(pathname, e.href);
    return (
      <li key={e.href} className={claseLi}>
        <Link
          ref={activa ? activaRef : undefined}
          href={e.href}
          aria-current={activa ? "page" : undefined}
          className={claseItemNav(activa)}
        >
          <IconoNav>{e.icono}</IconoNav>
          {e.etiqueta}
        </Link>
      </li>
    );
  };

  return (
    <header className="sticky top-0 z-30 bg-brand-night">
      {/* Una sola barra: logo, pestañas y usuario. En el celular las pestañas
          bajan a una segunda fila de borde a borde que hace scroll horizontal
          dentro de si misma (la pagina nunca se desplaza de lado); desde md
          van en la misma fila, con la barra verde de la activa pegada al borde
          inferior de la barra. */}
      <div className="mx-auto flex w-full max-w-7xl flex-wrap items-center gap-x-4 px-4 sm:px-6">
        <Link
          href="/entregas"
          className="order-1 flex h-14 shrink-0 items-center rounded-md md:h-16"
          aria-label="Panel de despachos, El Imperio"
        >
          <Logo tamano="compacto" animado={animarLogo} />
        </Link>

        <nav
          aria-label="Principal"
          className="order-3 -mx-4 w-[calc(100%+2rem)] border-t border-white/10 sm:-mx-6 sm:w-[calc(100%+3rem)] md:order-2 md:mx-0 md:w-auto md:min-w-0 md:flex-1 md:self-stretch md:border-t-0"
        >
          <ul className="flex h-full overflow-x-auto px-1 [scrollbar-color:var(--color-cielo-hover)_transparent] [scrollbar-width:thin] sm:px-3 md:px-0">
            {ENLACES_NAV.map(enlaceSimple)}
          </ul>
        </nav>

        <div className="relative order-2 ml-auto flex shrink-0 items-center md:order-3 md:ml-0">
          <button
            onClick={() => setMenuAbierto((a) => !a)}
            aria-haspopup="menu"
            aria-expanded={menuAbierto}
            aria-label="Menú de usuario"
            className="flex min-h-11 cursor-pointer items-center gap-2.5 rounded-full py-1 pl-1 pr-2 text-left transition-colors duration-150 hover:bg-white/10"
          >
            <span
              aria-hidden
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-oro text-sm font-bold text-brand-ink"
            >
              {iniciales(usuario.nombre)}
            </span>
            <span className="hidden max-w-40 truncate text-sm font-medium text-white sm:block">{usuario.nombre}</span>
            <svg
              aria-hidden
              viewBox="0 0 24 24"
              className={`h-4 w-4 text-cielo-ink transition-transform duration-150 ${menuAbierto ? "rotate-180" : ""}`}
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="m6 9 6 6 6-6" />
            </svg>
          </button>
          {menuAbierto ? (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setMenuAbierto(false)} />
              <div
                role="menu"
                className="absolute right-0 top-full z-50 mt-1 flex w-60 flex-col rounded-lg border border-line bg-surface py-1 shadow-md shadow-brand-night/10"
              >
                <div className="flex flex-col gap-1.5 border-b border-line px-3 pb-2.5 pt-2">
                  <p className="truncate text-sm font-semibold text-ink">
                    {usuario.nombre} · @{usuario.usuario}
                  </p>
                  <span className={`w-fit rounded-full border px-2 py-0.5 text-[11px] font-medium ${COLOR_ROL[usuario.rol]}`}>
                    {ETIQUETA_ROL[usuario.rol]}
                  </span>
                </div>
                <button
                  role="menuitem"
                  onClick={() => {
                    setMenuAbierto(false);
                    setCambiando(true);
                  }}
                  className="min-h-11 cursor-pointer px-3 text-left text-sm text-soft transition-colors duration-150 hover:bg-surface-2"
                >
                  Cambiar contraseña
                </button>
                {/* Cerrar sesion va aparte y en rojo: separado de las acciones normales. */}
                <div aria-hidden className="my-1 h-px bg-line" />
                <button
                  role="menuitem"
                  onClick={logout}
                  className="min-h-11 cursor-pointer px-3 text-left text-sm font-medium text-danger-fg transition-colors duration-150 hover:bg-surface-2"
                >
                  Cerrar sesión
                </button>
              </div>
            </>
          ) : null}
        </div>
      </div>
      {/* Portal al body: el modal no debe depender del contexto de apilamiento
          (sticky + z-30) del header para quedar centrado sobre toda la pantalla. */}
      {cambiando ? createPortal(<ModalCambiarPassword onCerrar={() => setCambiando(false)} />, document.body) : null}
    </header>
  );
}

const INPUT =
  "rounded-lg border border-line bg-page px-3 py-2 text-sm text-ink [color-scheme:light]";

function ModalCambiarPassword({ onCerrar }: { onCerrar: () => void }) {
  const [actual, setActual] = useState("");
  const [nueva, setNueva] = useState("");
  const [confirmar, setConfirmar] = useState("");
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const enviar = async (ev: FormEvent) => {
    ev.preventDefault();
    if (nueva.length < 8) return setError("La contraseña nueva debe tener al menos 8 caracteres.");
    if (nueva !== confirmar) return setError("La confirmación no coincide con la contraseña nueva.");
    setError(null);
    setEnviando(true);
    try {
      await cambiarPassword(actual, nueva);
      toast.success("Contraseña actualizada");
      onCerrar();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo cambiar la contraseña");
    } finally {
      setEnviando(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-brand-night/40 px-4" onClick={onCerrar}>
      <form
        onSubmit={enviar}
        className="flex w-full max-w-md flex-col gap-4 rounded-xl border border-line bg-surface p-5"
        onClick={(ev) => ev.stopPropagation()}
      >
        <h3 className="text-lg font-semibold text-ink">Cambiar contraseña</h3>
        <label className="flex flex-col gap-1">
          <span className="text-xs leading-none text-muted">Contraseña actual</span>
          <input
            type="password"
            autoFocus
            autoComplete="current-password"
            value={actual}
            onChange={(e) => setActual(e.target.value)}
            className={INPUT}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs leading-none text-muted">Contraseña nueva (mínimo 8 caracteres)</span>
          <input
            type="password"
            autoComplete="new-password"
            value={nueva}
            onChange={(e) => setNueva(e.target.value)}
            className={INPUT}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs leading-none text-muted">Confirmar contraseña nueva</span>
          <input
            type="password"
            autoComplete="new-password"
            value={confirmar}
            onChange={(e) => setConfirmar(e.target.value)}
            className={INPUT}
          />
        </label>
        {error ? <p className="text-xs text-danger-fg">{error}</p> : null}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onCerrar}
            className="min-h-10 cursor-pointer rounded-md border border-line-strong px-3 py-1.5 text-xs font-medium text-soft transition hover:bg-surface-2"
          >
            Cancelar
          </button>
          <button
            type="submit"
            disabled={enviando || !actual || !nueva || !confirmar}
            className="inline-flex min-h-10 cursor-pointer items-center justify-center rounded-md bg-ok px-3 py-1.5 text-xs font-semibold text-ok-on transition hover:bg-ok-hover disabled:opacity-50"
          >
            {enviando ? "Guardando…" : "Cambiar contraseña"}
          </button>
        </div>
      </form>
    </div>
  );
}
