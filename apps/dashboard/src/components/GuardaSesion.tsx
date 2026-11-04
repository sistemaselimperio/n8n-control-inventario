"use client";

// Guard de rutas + barra de usuario, montado en el layout raiz. La sesion vive
// en localStorage (no en cookie), asi que el guard es del lado del cliente: no
// se renderiza nada protegido hasta saber que hay sesion, para no mostrar un
// destello del panel a quien no inicio sesion.

import { useEffect, useState, type FormEvent, type ReactNode } from "react";
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
type EnlaceNav = { href: string; etiqueta: string; soloAdmin?: boolean };

// Todas las secciones son pestañas visibles de la barra superior (sin menus
// desplegables). "Entregas" es la pagina principal (el antiguo "Hoy" se
// fusiono con ella).
const ENLACES_NAV: EnlaceNav[] = [
  { href: "/entregas", etiqueta: "Entregas" },
  { href: "/traslados", etiqueta: "Traslados" },
  { href: "/puntos", etiqueta: "Puntos" },
  { href: "/ranking", etiqueta: "Ranking" },
  { href: "/turnos", etiqueta: "Turnos", soloAdmin: true },
  { href: "/productos", etiqueta: "Catálogo" },
  { href: "/creador", etiqueta: "Administración", soloAdmin: true },
];

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

// Clases comunes de las pestañas: 44px de alto y marca de activo de 2px en el
// verde de marca bajo el texto (sin pildora). El anillo de foco va hacia
// adentro (offset negativo) para que ningun contenedor lo recorte.
const CLASE_ITEM_NAV =
  "relative flex min-h-11 items-center rounded-md px-3 text-sm transition-colors duration-150 focus-visible:outline-offset-[-2px] after:absolute after:inset-x-3 after:bottom-0 after:h-0.5 after:rounded-full";

const claseItemNav = (activo: boolean) =>
  `${CLASE_ITEM_NAV} ${
    activo
      ? "font-semibold text-white after:bg-oro"
      : "font-medium text-cielo-ink after:bg-transparent hover:bg-cielo-hover hover:text-white"
  }`;

function BarraUsuario() {
  const { usuario, logout, esAdmin } = useSesion();
  const pathname = usePathname();
  const [menuAbierto, setMenuAbierto] = useState(false);
  // Movil: la lista de enlaces se pliega tras un boton. Se guarda la ruta en la
  // que se abrio, asi se cierra sola al navegar (sin efecto).
  const [navAbiertaEn, setNavAbiertaEn] = useState<string | null>(null);
  const navAbierta = navAbiertaEn === pathname;
  const [cambiando, setCambiando] = useState(false);
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
  const enlaceSimple = (e: EnlaceNav) =>
    !permitido(e) ? (
      <li key={e.href} className="flex">
        <span
          aria-disabled="true"
          title={AVISO_BLOQUEADO}
          className={`${CLASE_ITEM_NAV} cursor-not-allowed gap-1.5 font-medium text-cielo-ink/70 after:bg-transparent`}
        >
          {e.etiqueta}
          <Candado />
          <span className="sr-only">, sin acceso</span>
        </span>
      </li>
    ) : (
      <li key={e.href} className="flex">
        <Link
          href={e.href}
          aria-current={esActiva(pathname, e.href) ? "page" : undefined}
          className={`${claseItemNav(esActiva(pathname, e.href))} w-full md:w-auto`}
        >
          {e.etiqueta}
        </Link>
      </li>
    );

  return (
    <header className="sticky top-0 z-30 border-b-4 border-campo bg-cielo">
      <div className="mx-auto flex min-h-14 w-full max-w-7xl flex-wrap items-center gap-x-3 px-4 sm:px-6">
        <Link
          href="/entregas"
          className="flex shrink-0 items-center rounded-md py-1"
          aria-label="Panel de despachos, El Imperio"
        >
          <Logo tamano="compacto" animado={animarLogo} />
        </Link>

        {/* Todas las secciones a la vista. En escritorio las pestañas pasan a
            una segunda fila si no caben; en movil la lista se pliega tras el
            boton de menu (una sola lista, para que no haya enlaces repetidos). */}
        <nav
          aria-label="Principal"
          id="nav-principal"
          className={`order-last w-full pb-2 md:order-none md:block md:w-auto md:flex-1 md:pb-0 ${navAbierta ? "block" : "hidden"}`}
        >
          <ul className="flex flex-col gap-0.5 md:flex-row md:flex-wrap md:items-center md:gap-1">
            {ENLACES_NAV.map(enlaceSimple)}
          </ul>
        </nav>

        <div className="relative ml-auto flex shrink-0 items-center">
          <button
            onClick={() => setMenuAbierto((a) => !a)}
            aria-haspopup="menu"
            aria-expanded={menuAbierto}
            aria-label="Menú de usuario"
            className="flex min-h-11 cursor-pointer items-center gap-2 rounded-md px-2 text-xs text-white transition-colors duration-150 hover:bg-cielo-hover"
          >
            <span className="hidden font-medium sm:inline">{usuario.nombre}</span>
            <span className="rounded-full border border-cielo-ink/50 px-2 py-0.5 text-[11px] text-cielo-ink">
              {ETIQUETA_ROL[usuario.rol]}
            </span>
            <svg
              aria-hidden
              viewBox="0 0 24 24"
              className="h-4 w-4 text-cielo-ink"
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
                className="absolute right-0 z-50 mt-1 flex w-52 flex-col rounded-lg border border-line bg-surface py-1 shadow-md shadow-brand-night/10"
              >
                <p className="truncate px-3 py-1.5 text-[11px] text-muted">
                  {usuario.nombre} · @{usuario.usuario}
                </p>
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
                <button
                  role="menuitem"
                  onClick={logout}
                  className="min-h-11 cursor-pointer px-3 text-left text-sm text-soft transition-colors duration-150 hover:bg-surface-2"
                >
                  Cerrar sesión
                </button>
              </div>
            </>
          ) : null}
        </div>

        <button
          type="button"
          onClick={() => setNavAbiertaEn(navAbierta ? null : pathname)}
          aria-expanded={navAbierta}
          aria-controls="nav-principal"
          aria-label="Menú de navegación"
          className="flex min-h-11 min-w-11 cursor-pointer items-center justify-center rounded-md text-white transition-colors duration-150 hover:bg-cielo-hover md:hidden"
        >
          <svg
            aria-hidden
            viewBox="0 0 24 24"
            className="h-5 w-5"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
          >
            {navAbierta ? <path d="M18 6 6 18M6 6l12 12" /> : <path d="M4 6h16M4 12h16M4 18h16" />}
          </svg>
        </button>
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
