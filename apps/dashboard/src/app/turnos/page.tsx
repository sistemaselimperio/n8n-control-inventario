"use client";

// Planificacion de turnos: cuando llega mas trabajo a cada bodega, para
// saber cuando poner mas gente (ver GET /turnos/carga y
// app/services/turnos.py en el backend). Calculado en vivo sobre las ultimas
// semanas, en hora local de la sede. Pantalla de solo lectura.
//
// Pensada para quien arma los horarios, no para alguien tecnico: primero un
// resumen en frases, despues de lo general a lo particular -- que DIA (barras,
// lo mas facil de leer), a que HORA (grilla dia x hora con 3 niveles con
// nombre en vez de una escala continua) y por ultimo la lista de horarios a
// reforzar. El detalle de cada cuadrito se ve al pasar el mouse, al tocarlo
// (tablet) o con el teclado.
//
// Color: un solo tono verde de marca (rampa secuencial de la skill dataviz). El nivel
// "Mucho trabajo" ademas lleva borde claro, asi no depende solo del color.

import { useMemo, useState } from "react";
import Link from "next/link";
import useSWR from "swr";
import { fetchCargaTurnos, fetchSedes, type CeldaCarga } from "@/lib/api";
import {
  claseBoton,
  EncabezadoPagina,
  EstadoVacio,
  ErrorConReintento,
  Icono,
  Panel,
  Segmentado,
  TarjetaFiltros,
} from "@/components/ui";
import { useSesion } from "@/lib/SesionProvider";

const VERDE_BARRA = "var(--color-brand-blue)";

// Niveles de la grilla, de menos a mas. "mucho" = hora pico (la calcula el
// backend: percentil 90 de las horas con trabajo).
type Nivel = "nada" | "poco" | "normal" | "mucho";

const NIVELES: { nivel: Nivel; etiqueta: string; color: string }[] = [
  { nivel: "nada", etiqueta: "Sin trabajo", color: "var(--color-surface-2)" },
  { nivel: "poco", etiqueta: "Poco", color: "color-mix(in srgb, var(--color-ok) 30%, var(--color-surface))" },
  { nivel: "normal", etiqueta: "Normal", color: "color-mix(in srgb, var(--color-ok) 65%, var(--color-surface))" },
  { nivel: "mucho", etiqueta: "Mucho trabajo", color: "var(--color-ok)" },
];
const COLOR_NIVEL = Object.fromEntries(NIVELES.map((n) => [n.nivel, n.color])) as Record<Nivel, string>;
const ETIQUETA_NIVEL = Object.fromEntries(NIVELES.map((n) => [n.nivel, n.etiqueta])) as Record<Nivel, string>;

const DIAS_CORTOS = ["Lun", "Mar", "Mié", "Jue", "Vie", "Sáb", "Dom"];
const DIAS = ["lunes", "martes", "miércoles", "jueves", "viernes", "sábado", "domingo"];
const DIAS_TITULO = DIAS.map((d) => d.charAt(0).toUpperCase() + d.slice(1));

const VENTANAS = [
  { valor: 4, etiqueta: "4 semanas" },
  { valor: 8, etiqueta: "8 semanas" },
  { valor: 12, etiqueta: "12 semanas" },
] as const;

const formato1 = new Intl.NumberFormat("es-CO", { maximumFractionDigits: 1 });
const formato0 = new Intl.NumberFormat("es-CO", { maximumFractionDigits: 0 });

const hora = (h: number) => `${h % 24}:00`;
const rangoHora = (h: number) => `${hora(h)} a ${hora(h + 1)}`;

// "4 documentos" / "1 documento" -- con decimal solo si es menor a 10.
function documentos(v: number): string {
  const texto = v < 10 ? formato1.format(v) : formato0.format(v);
  return `${texto} ${texto === "1" ? "documento" : "documentos"}`;
}

function nivelDe(celda: CeldaCarga | undefined, umbral: number | null): Nivel {
  if (!celda || celda.promedio <= 0) return "nada";
  if (celda.pico) return "mucho";
  // "Normal" = al menos la mitad de lo que ya cuenta como pico.
  if (umbral && celda.promedio >= umbral / 2) return "normal";
  return "poco";
}

// Solo admin. Se separa en dos componentes para no cortar los hooks de
// ContenidoTurnos con un return temprano.
export default function TurnosPage() {
  const { esAdmin } = useSesion();
  if (!esAdmin) {
    return (
      <main className="mx-auto flex w-full flex-1 max-w-7xl flex-col items-start gap-4 px-4 py-6 sm:px-6 sm:py-8">
        <EncabezadoPagina titulo="Planificación de turnos" />
        <div className="rounded-md border border-warn/40 bg-warn-fill/15 px-4 py-3 text-sm text-warn">
          No tienes permiso para ver esta sección. Solo los administradores pueden acceder.
        </div>
        <Link href="/" className={claseBoton("secundario")}>
          <Icono nombre="izquierda" className="h-3.5 w-3.5" />
          Volver al panel
        </Link>
      </main>
    );
  }
  return <ContenidoTurnos />;
}

function ContenidoTurnos() {
  const { data: sedes } = useSWR("sedes", fetchSedes);
  const [sedeElegida, setSedeElegida] = useState<string | null>(null);
  const [semanas, setSemanas] = useState<number>(8);
  const [celdaActiva, setCeldaActiva] = useState<{ dia: number; hora: number } | null>(null);

  // Sin "todas las sedes": cada bodega tiene su propio ritmo y mezclarlas no
  // sirve para armar turnos. Arranca con la primera sede.
  const sedeId = sedeElegida ?? sedes?.[0]?.id ?? null;
  const nombreSede = sedes?.find((s) => s.id === sedeId)?.nombre ?? "la sede";

  const { data, error, isLoading, mutate } = useSWR(
    sedeId ? ["turnos-carga", sedeId, semanas] : null,
    () => fetchCargaTurnos(sedeId!, semanas),
    { refreshInterval: 60000 }
  );

  const celdas = useMemo(() => data?.celdas ?? [], [data]);
  const umbral = data?.umbral_pico ?? null;
  const porClave = useMemo(() => new Map(celdas.map((c) => [`${c.dia}-${c.hora}`, c])), [celdas]);

  // Total por dia (suma de sus horas) -- para las barras y el resumen.
  const totalesDia = useMemo(() => {
    const totales = Array(7).fill(0) as number[];
    for (const c of celdas) totales[c.dia] += c.promedio;
    return totales;
  }, [celdas]);
  const maximoDia = Math.max(0, ...totalesDia);
  const diaMasMovido = maximoDia > 0 ? totalesDia.indexOf(maximoDia) : null;
  const diaMasTranquilo = maximoDia > 0 ? totalesDia.indexOf(Math.min(...totalesDia)) : null;
  const horaMasFuerte = celdas.reduce<CeldaCarga | null>((mejor, c) => (!mejor || c.promedio > mejor.promedio ? c : mejor), null);

  // Solo las horas con actividad (y una de margen a cada lado) -- 24 columnas
  // casi vacias harian cada cuadrito ilegible.
  const horas = useMemo(() => {
    if (celdas.length === 0) return [];
    const minima = Math.max(0, Math.min(...celdas.map((c) => c.hora)) - 1);
    const maxima = Math.min(23, Math.max(...celdas.map((c) => c.hora)) + 1);
    return Array.from({ length: maxima - minima + 1 }, (_, i) => minima + i);
  }, [celdas]);

  const bloques = [...(data?.bloques ?? [])].sort(
    (a, b) => a.dia_indice - b.dia_indice || a.hora_inicio.localeCompare(b.hora_inicio)
  );

  // Sin sede todavia (la lista de sedes no llego) tambien es "cargando" --
  // si no, se veria "Sin datos" durante ese instante.
  const cargando = !error && !data && (isLoading || !sedeId);
  const sinDatos = !!data && celdas.length === 0;
  const historialCorto = !!data && data.semanas > 0 && data.semanas < 6;

  const detalle = celdaActiva ? porClave.get(`${celdaActiva.dia}-${celdaActiva.hora}`) : undefined;
  const nivelDetalle = celdaActiva ? nivelDe(detalle, umbral) : null;

  return (
    <main className="mx-auto flex w-full min-w-0 max-w-7xl flex-1 flex-col gap-5 px-4 py-6 sm:px-6 sm:py-8">
      <EncabezadoPagina
        titulo="Planificación de turnos"
        descripcion={
          <>
            Mira <span className="text-ink">cuándo llega más trabajo a la bodega</span>, según los documentos que se
            registraron en la app, y decide cuándo poner más gente y cuándo alcanza con menos.
          </>
        }
      />

      {/* Filtros agrupados en una tarjeta, con rotulos en palabras. */}
      <TarjetaFiltros etiqueta="Filtros" className="[&>div]:gap-4">
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted">Bodega</span>
          <Segmentado
            etiqueta="Bodega"
            valor={sedeId}
            onCambiar={setSedeElegida}
            opciones={(sedes ?? []).map((s) => ({ valor: s.id, etiqueta: s.nombre }))}
          />
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted">Mirar las últimas</span>
          <Segmentado
            etiqueta="Semanas a mirar"
            valor={String(semanas)}
            onCambiar={(v) => setSemanas(Number(v))}
            opciones={VENTANAS.map((v) => ({ valor: String(v.valor), etiqueta: v.etiqueta }))}
          />
        </div>
        {/* Espacio siempre reservado: el aviso aparece al llegar los datos sin empujar el resto de la página. */}
        <div className="flex min-h-11 min-w-64 flex-1 items-center" aria-live="polite">
          {historialCorto ? (
            <p className="flex items-start gap-2 text-xs leading-relaxed text-warn">
              <IconoAviso />
              <span>
                <span className="font-medium">Todavía hay pocos datos</span> ({data.semanas}{" "}
                {data.semanas === 1 ? "semana" : "semanas"}). Tómalo como una primera idea: con 6 a 8 semanas de
                registros ya es confiable.
              </span>
            </p>
          ) : null}
        </div>
      </TarjetaFiltros>

      {error ? (
        <ErrorConReintento
          mensaje="No se pudo cargar la información. Revisa la conexión con el servidor."
          onReintentar={() => mutate()}
        />
      ) : null}

      {/* 1. Resumen en frases -- lo primero que hay que entender. */}
      <Panel titulo="En resumen" subtitulo={`Lo más importante de ${nombreSede}, en pocas palabras.`}>
        {cargando ? (
          <div className="flex flex-col gap-3" aria-busy>
            {/* 4 lineas con el alto de leading-relaxed (text-sm): igual que las 4 frases cargadas. */}
            {[80, 65, 72, 70].map((ancho) => (
              <div key={ancho} className="flex h-[22.75px] items-center">
                <div className="h-4 animate-pulse rounded bg-surface-2" style={{ width: `${ancho}%` }} />
              </div>
            ))}
          </div>
        ) : sinDatos || diaMasMovido === null || !horaMasFuerte ? (
          <EstadoVacio
            titulo="No hay documentos registrados en este período"
            ayuda="Prueba mirando más semanas o elige la otra bodega."
          />
        ) : (
          <ul className="flex flex-col gap-3 text-sm leading-relaxed text-soft">
            <FraseResumen>
              El día con más trabajo es el <b className="text-ink">{DIAS[diaMasMovido]}</b>: en promedio{" "}
              {documentos(totalesDia[diaMasMovido])} por semana.
            </FraseResumen>
            <FraseResumen>
              La hora más fuerte es el <b className="text-ink">{DIAS[horaMasFuerte.dia]}</b> de{" "}
              <b className="text-ink">{rangoHora(horaMasFuerte.hora)}</b>.
            </FraseResumen>
            {diaMasTranquilo !== null && diaMasTranquilo !== diaMasMovido ? (
              <FraseResumen>
                El día más tranquilo es el <b className="text-ink">{DIAS[diaMasTranquilo]}</b>
                {totalesDia[diaMasTranquilo] === 0
                  ? ": no se registra trabajo."
                  : `: en promedio ${documentos(totalesDia[diaMasTranquilo])} por semana.`}
              </FraseResumen>
            ) : null}
            <FraseResumen>
              {bloques.length > 0 ? (
                <>
                  Conviene tener más gente en{" "}
                  <b className="text-ink">
                    {bloques.length} {bloques.length === 1 ? "horario" : "horarios"}
                  </b>{" "}
                  de la semana (están en la lista de abajo).
                </>
              ) : (
                "No hay horarios que se destaquen: el trabajo está repartido parejo."
              )}
            </FraseResumen>
          </ul>
        )}
      </Panel>

      {/* 2. Que dia -- barras, lo mas facil de leer. */}
      <Panel
        titulo="¿Qué día hay más trabajo?"
        subtitulo="Documentos registrados en promedio cada semana, por día."
      >
        {cargando ? (
          <div className="h-[188px] animate-pulse rounded-md bg-surface-2" aria-busy />
        ) : sinDatos ? (
          <EstadoVacio titulo="Sin datos en este período" />
        ) : (
          <ol className="flex flex-col gap-2">
            {DIAS_TITULO.map((dia, d) => {
              const total = totalesDia[d];
              const ancho = maximoDia > 0 ? (total / maximoDia) * 100 : 0;
              const destacado = d === diaMasMovido;
              return (
                <li key={dia} className="grid grid-cols-[5.5rem_1fr_auto] items-center gap-3">
                  <span className={`text-sm ${destacado ? "font-semibold text-ink" : "text-muted"}`}>
                    {dia}
                  </span>
                  <div className="h-3 w-full overflow-hidden rounded-full bg-surface-2">
                    {total > 0 ? (
                      <div
                        className="h-full rounded-full transition-[width] duration-500"
                        style={{ width: `${Math.max(2, ancho)}%`, backgroundColor: VERDE_BARRA, opacity: destacado ? 1 : 0.7 }}
                      />
                    ) : null}
                  </div>
                  <span className="w-28 text-right text-sm tabular-nums text-soft">
                    {total > 0 ? documentos(total) : "sin trabajo"}
                  </span>
                </li>
              );
            })}
          </ol>
        )}
      </Panel>

      {/* 3. A que hora -- grilla dia x hora con niveles con nombre. */}
      <Panel
        titulo="¿A qué hora?"
        subtitulo="Cada cuadrito es un día a una hora. Toca o pasa el mouse por uno para ver el detalle."
        // min-w-0: la grilla (min-w-max) se desplaza dentro de la tarjeta en
        // vez de ensanchar toda la pagina en pantallas chicas.
        className="min-w-0"
      >
        {/* key distinta: React no reutiliza el nodo del esqueleto (el navegador lo contaria como salto). */}
        {cargando ? (
          <div key="esqueleto-hora" className="h-[23.5rem] animate-pulse rounded-md bg-surface-2" aria-busy />
        ) : sinDatos ? (
          <EstadoVacio titulo="Sin datos en este período" />
        ) : (
          <div key="grilla-hora" className="flex min-w-0 flex-col gap-4">
            {/* Leyenda arriba: primero se aprende a leer, despues se mira. */}
            <ul className="flex flex-wrap gap-x-5 gap-y-2 text-xs text-soft">
              {NIVELES.map((n) => (
                <li key={n.nivel} className="flex items-center gap-2">
                  <span
                    className={`h-4 w-4 rounded-[4px] ${n.nivel === "mucho" ? "ring-2 ring-inset ring-brand-gold" : ""}`}
                    style={{ backgroundColor: n.color }}
                    aria-hidden
                  />
                  {n.etiqueta}
                </li>
              ))}
            </ul>

            {/* Linea de detalle -- el dato exacto del cuadrito elegido. */}
            <p className="min-h-6 rounded-md bg-surface-2 px-3 py-2 text-sm text-soft" aria-live="polite">
              {celdaActiva && nivelDetalle ? (
                <>
                  <span className="font-medium text-ink">
                    {DIAS_TITULO[celdaActiva.dia]} de {rangoHora(celdaActiva.hora)}
                  </span>
                  {": "}
                  {nivelDetalle === "nada"
                    ? "no se registra trabajo."
                    : `${ETIQUETA_NIVEL[nivelDetalle].toLowerCase()}, en promedio ${documentos(detalle!.promedio)} por semana.`}
                </>
              ) : (
                <span className="text-muted">Elige un cuadrito para ver cuánto trabajo hay.</span>
              )}
            </p>

            <div className="overflow-x-auto pb-1">
              <div
                className="grid min-w-max gap-[3px]"
                style={{ gridTemplateColumns: `3rem repeat(${horas.length}, minmax(2.25rem, 1fr))` }}
                onMouseLeave={() => setCeldaActiva(null)}
              >
                <span />
                {horas.map((h) => (
                  <span key={h} className="pb-1 text-center text-xs tabular-nums text-muted">
                    {hora(h)}
                  </span>
                ))}
                {DIAS_CORTOS.map((dia, d) => (
                  <div key={dia} className="contents">
                    <span className="flex items-center text-xs text-muted">{dia}</span>
                    {horas.map((h) => {
                      const celda = porClave.get(`${d}-${h}`);
                      const nivel = nivelDe(celda, umbral);
                      const activa = celdaActiva?.dia === d && celdaActiva?.hora === h;
                      return (
                        <button
                          key={h}
                          type="button"
                          aria-label={`${DIAS_TITULO[d]} de ${rangoHora(h)}: ${
                            nivel === "nada" ? "sin trabajo" : `${ETIQUETA_NIVEL[nivel]}, ${documentos(celda!.promedio)} por semana`
                          }`}
                          onMouseEnter={() => setCeldaActiva({ dia: d, hora: h })}
                          onFocus={() => setCeldaActiva({ dia: d, hora: h })}
                          onClick={() => setCeldaActiva({ dia: d, hora: h })}
                          className={`h-9 cursor-pointer rounded-[4px] transition-colors duration-150 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-brand-gold ${
                            nivel === "mucho" ? "ring-2 ring-inset ring-brand-gold" : ""
                          } ${activa ? "outline outline-2 outline-offset-1 outline-brand-gold" : ""}`}
                          style={{ backgroundColor: COLOR_NIVEL[nivel] }}
                        />
                      );
                    })}
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </Panel>

      {/* 4. Lista accionable -- que hacer con todo lo anterior. */}
      <Panel
        titulo="Horarios para reforzar"
        subtitulo="Los momentos con mucho trabajo. Ahí conviene tener más gente disponible."
        conteo={data ? `${bloques.length} ${bloques.length === 1 ? "horario" : "horarios"}` : undefined}
      >
        {cargando ? (
          <div key="esqueleto-horarios" className="h-32 animate-pulse rounded-md bg-surface-2" aria-busy />
        ) : bloques.length === 0 ? (
          <EstadoVacio titulo="No hay horarios que se destaquen en este período" />
        ) : (
          <div key="lista-horarios" className="flex flex-col gap-3">
            <ul className="flex flex-col divide-y divide-line rounded-md border border-line">
              {bloques.map((b) => (
                <li
                  key={`${b.dia_indice}-${b.hora_inicio}`}
                  className="flex min-h-11 items-center justify-between gap-3 px-4 py-3"
                >
                  <div className="flex flex-col gap-0.5">
                    <span className="text-sm font-medium text-ink">
                      {DIAS_TITULO[b.dia_indice]}, de {Number(b.hora_inicio.slice(0, 2))}:00 a{" "}
                      {Number(b.hora_fin.slice(0, 2))}:00
                    </span>
                    <span className="text-xs text-muted">
                      Hasta {documentos(b.carga_maxima)} por semana en esa franja
                    </span>
                  </div>
                  <div className="flex shrink-0 flex-col items-end">
                    <span className="cifra text-[28px] text-ink">{b.personal_sugerido}</span>
                    <span className="text-xs text-muted">
                      {b.personal_sugerido === 1 ? "persona sugerida" : "personas sugeridas"}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
            <p className="text-xs leading-relaxed text-muted">
              Las personas sugeridas son una referencia para arrancar (una por cada dos horas de mucho trabajo
              seguidas). El sistema no sabe cuántos documentos despacha una persona por hora: ajústalo con tu
              experiencia.
            </p>
          </div>
        )}
      </Panel>

      {/* Explicacion del calculo, plegada para no estorbar. */}
      <details className="group rounded-lg border border-line bg-surface px-4 py-3 text-sm text-muted sm:px-5">
        <summary className="flex min-h-11 cursor-pointer list-none items-center font-medium text-ink marker:hidden">
          <span className="inline-block transition-transform duration-200 group-open:rotate-90">›</span> ¿Cómo se
          calcula?
        </summary>
        <ul className="mt-3 flex list-disc flex-col gap-2 pl-5 leading-relaxed">
          <li>
            Se cuentan los documentos que los bodegueros registraron en la app, según el día y la hora en que se
            tomó la foto (hora de Colombia).
          </li>
          <li>
            Se miran solo las últimas semanas que elijas arriba, y se saca el promedio por semana. Así un día
            especialmente raro no pesa tanto.
          </li>
          <li>
            &ldquo;Mucho trabajo&rdquo; son las horas que están entre el 10&nbsp;% más cargado de la semana.
            &ldquo;Normal&rdquo; es al menos la mitad de eso, y &ldquo;Poco&rdquo;, el resto.
          </li>
          <li>No cuentan los documentos rechazados por duplicado.</li>
        </ul>
      </details>
    </main>
  );
}

function FraseResumen({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-3">
      <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-brand-sky" aria-hidden />
      <span>{children}</span>
    </li>
  );
}

function IconoAviso() {
  return (
    <svg viewBox="0 0 24 24" className="mt-0.5 h-5 w-5 shrink-0" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <path d="M12 9v4m0 4h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
