"use client";

// Ranking de productos mas/menos vendidos en un rango de fechas (ver GET
// /ranking/productos en el backend) -- se agrega en Python a partir de
// entrega_items.cantidad_entregada, sin agregacion en SQL. Pantalla de solo
// lectura, sin edicion.
//
// Forma: ranking de magnitudes -> barras horizontales ordenadas, una serie
// (un color) por columna, valor escrito al lado de cada barra (el dato nunca
// depende solo del color). Colores validados con el validador de la skill
// dataviz sobre la superficie clara del panel: verde de marca (ok, 4.1:1 sobre
// blanco) y verde azulado (brand-sky, 4.6:1); ambos >= 3:1 como elemento grafico.

import { useMemo, useState } from "react";
import useSWR from "swr";
import { fetchRankingProductos, fetchSedes, type RankingProductoItem } from "@/lib/api";
import {
  CampoFiltro,
  CLASE_CAMPO,
  EncabezadoPagina,
  ErrorConReintento,
  Indicador,
  Segmentado,
  TarjetaFiltros,
} from "@/components/ui";

const COLOR_MAS = "var(--color-ok)";
const COLOR_MENOS = "var(--color-brand-sky)";

function fechaISO(fecha: Date): string {
  const anio = fecha.getFullYear();
  const mes = String(fecha.getMonth() + 1).padStart(2, "0");
  const dia = String(fecha.getDate()).padStart(2, "0");
  return `${anio}-${mes}-${dia}`;
}

function hoyISO(): string {
  return fechaISO(new Date());
}

function haceNDias(n: number): string {
  const fecha = new Date();
  fecha.setDate(fecha.getDate() - n);
  return fechaISO(fecha);
}

// Convierte el rango de calendario (inputs <input type="date">, "YYYY-MM-DD")
// a los ISO que espera el backend -- "hasta" se lleva al final de ese dia
// (23:59:59.999 local), mismo criterio que fechasCalendarioAISO en
// app/page.tsx (sin esto se perderian las entregas capturadas despues de
// medianoche del dia elegido).
function rangoCalendarioAISO(desde: string, hasta: string): { desde: string; hasta: string } {
  const [ay, am, ad] = desde.split("-").map(Number);
  const [hy, hm, hd] = hasta.split("-").map(Number);
  return {
    desde: new Date(ay, am - 1, ad).toISOString(),
    hasta: new Date(hy, hm - 1, hd, 23, 59, 59, 999).toISOString(),
  };
}

const formatoNumero = new Intl.NumberFormat("es-CO");

// "22 sep" / "22 sep 2026" -- para el resumen del rango elegido.
function fechaCorta(iso: string, conAnio: boolean): string {
  const [a, m, d] = iso.split("-").map(Number);
  return new Date(a, m - 1, d).toLocaleDateString("es-CO", {
    day: "numeric",
    month: "short",
    ...(conAnio ? { year: "numeric" } : {}),
  });
}

type Periodo = "hoy" | "semana" | "mes" | "custom";

export default function RankingPage() {
  const [periodo, setPeriodo] = useState<Periodo>("semana");
  const [desde, setDesde] = useState(haceNDias(6));
  const [hasta, setHasta] = useState(hoyISO());
  const [sedeId, setSedeId] = useState<string>("todas");

  const { data: sedes } = useSWR("sedes", fetchSedes);

  const elegirPeriodo = (nuevo: Exclude<Periodo, "custom">) => {
    setPeriodo(nuevo);
    if (nuevo === "hoy") {
      setDesde(hoyISO());
      setHasta(hoyISO());
    } else if (nuevo === "semana") {
      setDesde(haceNDias(6));
      setHasta(hoyISO());
    } else {
      // "Este mes" = ultimos 30 dias, mas simple y consistente que el mes
      // calendario (que arrancaria vacio el dia 1).
      setDesde(haceNDias(29));
      setHasta(hoyISO());
    }
  };

  const cambiarDesde = (valor: string) => {
    setPeriodo("custom");
    setDesde(valor);
  };

  const cambiarHasta = (valor: string) => {
    setPeriodo("custom");
    setHasta(valor);
  };

  const rangoISO = useMemo(() => rangoCalendarioAISO(desde, hasta), [desde, hasta]);

  const {
    data: ranking,
    error,
    isLoading,
    mutate,
  } = useSWR(
    ["ranking-productos", rangoISO.desde, rangoISO.hasta, sedeId],
    () =>
      fetchRankingProductos({
        desde: rangoISO.desde,
        hasta: rangoISO.hasta,
        sedeId: sedeId === "todas" ? undefined : sedeId,
      }),
    { refreshInterval: 30000 }
  );

  const nombreSede =
    sedeId === "todas" ? "Todas las sedes" : (sedes ?? []).find((s) => s.id === sedeId)?.nombre ?? "Sede";
  const mismoAnio = desde.slice(0, 4) === hasta.slice(0, 4);
  const textoRango =
    desde === hasta
      ? fechaCorta(desde, true)
      : `${fechaCorta(desde, !mismoAnio)} – ${fechaCorta(hasta, true)}`;

  const masVendidos = ranking?.mas_vendidos ?? [];
  const menosVendidos = ranking?.menos_vendidos ?? [];
  const lider = masVendidos[0];
  const unidadesTop = masVendidos.reduce((suma, item) => suma + item.cantidad_total, 0);
  const menosMovido = menosVendidos[0];

  return (
    <main className="mx-auto flex w-full max-w-7xl flex-1 flex-col gap-5 px-4 py-6 sm:px-6 sm:py-8">
      <EncabezadoPagina
        titulo="Ranking de productos"
        descripcion="Qué productos salieron más y cuáles menos en el período elegido, según lo confirmado en las entregas."
      />

      {/* Filtros agrupados en una tarjeta, arriba de los datos. */}
      <TarjetaFiltros
        etiqueta="Filtros"
        resumen={
          <>
            Mostrando <span className="font-medium text-soft">{textoRango}</span> en{" "}
            <span className="font-medium text-soft">{nombreSede}</span>
            {isLoading && ranking ? <span className="ml-2 text-subtle">actualizando…</span> : null}
          </>
        }
      >
        <Segmentado
          etiqueta="Período"
          valor={periodo === "custom" ? null : periodo}
          onCambiar={elegirPeriodo}
          opciones={[
            { valor: "hoy", etiqueta: "Hoy" },
            { valor: "semana", etiqueta: "Últimos 7 días" },
            { valor: "mes", etiqueta: "Últimos 30 días" },
          ]}
        />
        <CampoFiltro id="ranking-desde" etiqueta="Desde">
          <input
            id="ranking-desde"
            type="date"
            value={desde}
            onChange={(e) => cambiarDesde(e.target.value)}
            max={hasta || undefined}
            className={CLASE_CAMPO}
          />
        </CampoFiltro>
        <CampoFiltro id="ranking-hasta" etiqueta="Hasta">
          <input
            id="ranking-hasta"
            type="date"
            value={hasta}
            onChange={(e) => cambiarHasta(e.target.value)}
            min={desde || undefined}
            className={CLASE_CAMPO}
          />
        </CampoFiltro>
        <CampoFiltro id="ranking-sede" etiqueta="Sede">
          <select id="ranking-sede" value={sedeId} onChange={(e) => setSedeId(e.target.value)} className={CLASE_CAMPO}>
            <option value="todas">Todas las sedes</option>
            {(sedes ?? []).map((s) => (
              <option key={s.id} value={s.id}>
                {s.nombre}
              </option>
            ))}
          </select>
        </CampoFiltro>
      </TarjetaFiltros>

      {error ? <ErrorConReintento mensaje="No se pudo cargar el ranking. Revisa la conexión con el servidor." onReintentar={() => mutate()} /> : null}

      {/* Indicadores de cabecera en un solo tablero con reglas -- el dato suelto
          no necesita grafico. */}
      <section aria-label="Resumen" className="overflow-hidden rounded-lg border border-line bg-surface">
        <div className="grid grid-cols-1 gap-px bg-line sm:grid-cols-3">
          <Indicador
            plano
            etiqueta="Producto más vendido"
            valor={lider ? formatoNumero.format(lider.cantidad_total) : "—"}
            unidad={lider ? "unidades" : undefined}
            detalle={lider?.nombre ?? "Sin datos en este período"}
            cargando={isLoading && !ranking}
          />
          <Indicador
            plano
            etiqueta={`Unidades en el top ${masVendidos.length || 15}`}
            valor={masVendidos.length ? formatoNumero.format(unidadesTop) : "—"}
            unidad={masVendidos.length ? "unidades" : undefined}
            detalle={
              masVendidos.length
                ? `${masVendidos.length} ${masVendidos.length === 1 ? "producto" : "productos"} con más salida`
                : "Sin datos en este período"
            }
            cargando={isLoading && !ranking}
          />
          <Indicador
            plano
            etiqueta="Producto con menos salida"
            valor={menosMovido ? formatoNumero.format(menosMovido.cantidad_total) : "—"}
            unidad={menosMovido ? "unidades" : undefined}
            detalle={menosMovido?.nombre ?? "Sin datos en este período"}
            cargando={isLoading && !ranking}
          />
        </div>
      </section>

      {/* Dos columnas separadas por una regla dentro de una sola superficie. */}
      <div className="grid grid-cols-1 gap-px overflow-hidden rounded-lg border border-line bg-line lg:grid-cols-2">
        <ColumnaRanking
          titulo="Más vendidos"
          subtitulo="Ordenados por unidades entregadas"
          items={ranking?.mas_vendidos}
          cargando={isLoading && !ranking}
          color={COLOR_MAS}
        />
        <ColumnaRanking
          titulo="Menos vendidos"
          subtitulo="Productos con menor salida en el período"
          items={ranking?.menos_vendidos}
          cargando={isLoading && !ranking}
          color={COLOR_MENOS}
        />
      </div>
    </main>
  );
}

function ColumnaRanking({
  titulo,
  subtitulo,
  items,
  cargando,
  color,
}: {
  titulo: string;
  subtitulo: string;
  items: RankingProductoItem[] | undefined;
  cargando: boolean;
  color: string;
}) {
  // Escala propia de cada columna: la barra mas larga es el mayor valor de
  // ESTA lista (en "menos vendidos" los valores son chicos y con la escala de
  // "mas vendidos" las barras serian invisibles).
  const maximo = Math.max(1, ...(items ?? []).map((item) => item.cantidad_total));

  return (
    <section className="flex flex-col gap-4 bg-surface p-4 sm:p-5">
      <header className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-0.5">
          <h2 className="flex items-center gap-2 text-base font-semibold text-ink">
            <span className="h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: color }} aria-hidden />
            {titulo}
          </h2>
          <p className="text-xs text-muted">{subtitulo}</p>
        </div>
        {items && items.length > 0 ? (
          <span className="text-xs tabular-nums text-muted">
            {items.length} {items.length === 1 ? "producto" : "productos"}
          </span>
        ) : null}
      </header>

      {cargando ? (
        <ol className="flex flex-col gap-3" aria-busy>
          {Array.from({ length: 6 }, (_, i) => (
            <li key={i} className="flex flex-col gap-1.5">
              <div className="h-3 animate-pulse rounded bg-surface-2" style={{ width: `${70 - i * 8}%` }} />
              <div className="h-2 animate-pulse rounded bg-surface-2/70" style={{ width: `${90 - i * 12}%` }} />
            </li>
          ))}
        </ol>
      ) : !items || items.length === 0 ? (
        <div className="flex flex-col items-center gap-1 py-10 text-center">
          <p className="text-sm text-muted">Sin ventas en este período</p>
          <p className="text-xs text-subtle">Prueba con un rango de fechas más amplio u otra sede.</p>
        </div>
      ) : (
        <ol className="flex flex-col divide-y divide-line">
          {items.map((item, indice) => {
            const ancho = Math.max(2, (item.cantidad_total / maximo) * 100);
            const puesto = indice + 1;
            return (
              <li
                key={item.codigo ?? item.nombre}
                title={`${item.nombre}: ${formatoNumero.format(item.cantidad_total)} unidades en ${item.entregas_count} ${
                  item.entregas_count === 1 ? "entrega" : "entregas"
                }`}
                className="flex min-h-11 items-center gap-3 py-2.5"
              >
                {/* El puesto es una secuencia real: va en cifra apagada. */}
                <span className="cifra w-7 shrink-0 text-right text-[20px] text-muted">{puesto}</span>
                <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="truncate text-sm text-ink">{item.nombre}</span>
                    <span className="cifra shrink-0 text-[20px] text-ink">{formatoNumero.format(item.cantidad_total)}</span>
                  </div>
                  {/* Barra: pista tenue + relleno con extremos redondeados. */}
                  <div className="h-2 w-full overflow-hidden rounded-full bg-surface-2">
                    <div
                      className="h-full rounded-full transition-[width] duration-500"
                      style={{ width: `${ancho}%`, backgroundColor: color }}
                    />
                  </div>
                  <div className="flex justify-between gap-3 text-xs text-muted">
                    <span className="tabular-nums">{item.codigo ?? "sin código"}</span>
                    <span>
                      {item.entregas_count} {item.entregas_count === 1 ? "entrega" : "entregas"}
                    </span>
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
