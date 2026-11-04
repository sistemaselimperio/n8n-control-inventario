"use client";

// Tablero "Cómo va hoy". Jerarquia en dos niveles: una tarjeta principal con el
// avance del dia (entregadas de las facturadas hoy, con barra, porcentaje y las
// facturadas por sede) y, al lado, mosaicos compactos en horizontal: la cifra
// en un cuadro con el color de su estado y el rotulo con el contexto al lado.
// Las tarjetas con filtro son botones que cambian directamente los filtros de /entregas (estado / flujo, en la URL);
// la que coincide con el filtro activo queda marcada con borde verde y, al pulsarla
// de nuevo, lo quita. Todo se calcula de lo ya cargado, sin pedirle nada nuevo
// al backend.

import { useMemo, type ReactNode } from "react";
import { TIPOS_REMISION, type Entrega, type LogEvent } from "@/lib/api";
import {
  esHoy,
  nombreSedeCorto,
  sumar,
  tienePendiente,
  type FiltroEstado,
  type FiltroFlujo,
} from "@/lib/entregas";
import { SkeletonLinea } from "@/components/ui";

type Tono = "neutral" | "bien" | "atencion" | "alerta";

// Bloque de la cifra: un cuadro con el color del tono al 12% y la cifra en el
// tono. El rotulo al lado siempre dice que es (el color nunca es la unica pista).
const TONO_BLOQUE: Record<Tono, string> = {
  neutral: "bg-surface-2 text-ink",
  bien: "bg-ok-fg/12 text-ok-fg",
  atencion: "bg-gold-fg/12 text-gold-fg",
  alerta: "bg-danger-fg/12 text-danger-fg",
};

// Contenedor comun: superficie, borde y estados de foco/hover/activo. Si hay
// `alPulsar` se renderiza como boton; si no, como div.
function Contenedor({
  activa,
  alPulsar,
  className,
  children,
}: {
  activa?: boolean;
  alPulsar?: () => void;
  className: string;
  children: ReactNode;
}) {
  const base = `rounded-lg border bg-surface text-left ${className}`;
  if (!alPulsar) return <div className={`${base} border-line`}>{children}</div>;
  return (
    <button
      type="button"
      onClick={alPulsar}
      aria-pressed={activa}
      className={`group ${base} w-full cursor-pointer transition-colors duration-150 hover:bg-surface-2 ${
        activa ? "border-ok bg-surface-2" : "border-line hover:border-line-strong"
      }`}
    >
      {children}
    </button>
  );
}

// Tarjeta principal: avance del dia, compacta.
function TarjetaAvance({
  entregadas,
  facturadas,
  contexto,
  activa,
  alPulsar,
  dosFilas,
}: {
  entregadas: number;
  facturadas: number;
  contexto: string;
  activa: boolean;
  alPulsar: () => void;
  dosFilas: boolean;
}) {
  // Sin facturas no hay proporcion: barra vacia (evita dividir por cero).
  const porcentaje = facturadas > 0 ? Math.min(100, Math.round((entregadas / facturadas) * 100)) : 0;
  return (
    <Contenedor
      activa={activa}
      alPulsar={alPulsar}
      className={`col-span-2 flex h-full flex-col justify-center gap-2 px-3.5 py-2.5 lg:col-span-1 ${dosFilas ? "lg:row-span-2" : ""}`}
    >
      <div className="flex items-center justify-between gap-3">
        <span className="text-[13px] font-medium text-soft">Entregadas hoy</span>
        <span className="rounded-full bg-ok-fg/12 px-2 py-0.5 text-xs font-semibold tabular-nums text-ok-fg">
          {porcentaje}%
        </span>
      </div>
      <p className="flex items-baseline gap-1.5">
        <span className="cifra text-[24px] leading-none text-ink">{entregadas}</span>
        <span className="text-sm text-muted">
          de {facturadas} {facturadas === 1 ? "factura" : "facturas"}
        </span>
      </p>
      <div
        role="progressbar"
        aria-label="Facturas de hoy entregadas completas"
        aria-valuemin={0}
        aria-valuemax={Math.max(facturadas, 1)}
        aria-valuenow={Math.min(entregadas, Math.max(facturadas, 1))}
        className="h-1.5 w-full overflow-hidden rounded-full bg-surface-2 group-hover:bg-line"
      >
        <div className="h-full rounded-full bg-ok" style={{ width: `${porcentaje}%` }} />
      </div>
      <span className="truncate text-xs text-muted" title={contexto}>
        {contexto}
      </span>
    </Contenedor>
  );
}

// Mosaico compacto en horizontal: cuadro con la cifra a la izquierda, rotulo y
// contexto a la derecha.
function Mosaico({
  titulo,
  valor,
  tono,
  contexto,
  activa,
  alPulsar,
}: {
  titulo: string;
  valor: number;
  tono: Tono;
  contexto: string;
  activa?: boolean;
  alPulsar?: () => void;
}) {
  return (
    <Contenedor activa={activa} alPulsar={alPulsar} className="flex min-h-[52px] items-center gap-2.5 px-2.5 py-1.5">
      <span
        className={`cifra flex h-9 min-w-9 shrink-0 items-center justify-center rounded-md px-1.5 text-[18px] leading-none ${TONO_BLOQUE[tono]}`}
      >
        {valor}
      </span>
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="truncate text-[13px] font-medium leading-tight text-ink">{titulo}</span>
        <span className="truncate text-xs text-muted" title={contexto}>
          {contexto}
        </span>
      </span>
    </Contenedor>
  );
}

// Esqueletos con el mismo tamano que las tarjetas finales (sin salto al cargar).
function AvanceCargando({ dosFilas }: { dosFilas: boolean }) {
  return (
    <div
      className={`col-span-2 flex flex-col justify-center gap-2 rounded-lg border border-line bg-surface px-3.5 py-2.5 lg:col-span-1 ${dosFilas ? "lg:row-span-2" : ""}`}
      aria-hidden
    >
      <SkeletonLinea className="h-5 w-28" />
      <SkeletonLinea className="h-6 w-28" />
      <SkeletonLinea className="h-1.5 w-full rounded-full" />
      <SkeletonLinea className="h-4 w-40" />
    </div>
  );
}

function MosaicoCargando() {
  return (
    <div className="flex min-h-[68px] items-center gap-3 rounded-lg border border-line bg-surface px-3 py-2.5" aria-hidden>
      <SkeletonLinea className="h-9 w-9 rounded-md" />
      <span className="flex flex-col gap-1.5">
        <SkeletonLinea className="h-4 w-24" />
        <SkeletonLinea className="h-3 w-20" />
      </span>
    </div>
  );
}

// "Norte 14, Centro 10" -- de mayor a menor.
function resumirPor<T>(lista: T[], clave: (item: T) => string): string {
  const mapa = new Map<string, number>();
  for (const item of lista) {
    const k = clave(item);
    mapa.set(k, (mapa.get(k) ?? 0) + 1);
  }
  return [...mapa.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${k} ${n}`)
    .join(", ");
}

const sedeDe = (e: Entrega) => nombreSedeCorto(e.sede_origen_nombre) ?? e.sede_origen_id;

export function ResumenHoy({
  entregas,
  logs,
  puedeEditar,
  filtroEstado,
  filtroFlujo,
  onEstado,
  onFlujo,
}: {
  entregas: Entrega[] | undefined;
  logs: LogEvent[] | undefined;
  puedeEditar: boolean;
  filtroEstado: FiltroEstado;
  filtroFlujo: FiltroFlujo;
  onEstado: (valor: FiltroEstado) => void;
  onFlujo: (valor: FiltroFlujo) => void;
}) {
  const datos = useMemo(() => {
    const todas = entregas ?? [];
    const hoy = todas.filter((e) => esHoy(e.capturado_at));
    // Facturadas = documentos capturados hoy; entregadas = de esos, los que ya
    // no tienen nada pendiente (procesados y con todo entregado).
    const entregadas = hoy.filter((e) => e.estado === "procesada" && !tienePendiente(e));
    const remisiones = hoy.filter((e) => TIPOS_REMISION.includes(e.tipo.toUpperCase()));
    const porRevisar = todas.filter((e) => e.estado === "pendiente_revision");
    const sinTerminar = todas.filter((e) => tienePendiente(e) && e.estado !== "pendiente_revision");
    const devoluciones = (logs ?? []).filter((l) => l.evento === "devolucion_registrada" && esHoy(l.timestamp));
    const unidadesDevueltas = devoluciones.reduce(
      (total, l) => total + ((l.detalle as { cantidad?: number } | undefined)?.cantidad ?? 0),
      0
    );
    return {
      hoy,
      entregadas,
      remisiones,
      porRevisar,
      sinTerminar,
      devoluciones,
      unidadesDevueltas,
      unidadesPendientes: sinTerminar.reduce((total, e) => total + sumar(e.items, "cantidad_pendiente"), 0),
    };
  }, [entregas, logs]);

  const cargando = entregas === undefined;
  const cargandoDevoluciones = cargando || logs === undefined;
  const sinMovimiento = "Todavía sin movimiento";

  // Pulsar la tarjeta activa quita el filtro; cualquier otra lo aplica.
  const alternarEstado = (valor: Exclude<FiltroEstado, "todas">) => () =>
    onEstado(filtroEstado === valor ? "todas" : valor);

  // Avance a la izquierda y mosaicos al lado. Con 4 mosaicos (rol con
  // revision) van en 2x2 y el avance ocupa dos filas; con 3, en una sola fila.
  // En celular: avance arriba a todo el ancho y mosaicos de a 2.
  const nMosaicos = puedeEditar ? 4 : 3;
  const dosFilas = nMosaicos === 4;
  const rejilla = dosFilas
    ? "lg:grid-cols-[minmax(260px,1.2fr)_repeat(2,minmax(0,1fr))]"
    : "lg:grid-cols-[minmax(260px,1.2fr)_repeat(3,minmax(0,1fr))]";

  return (
    <div className={`grid grid-cols-2 gap-2 ${rejilla}`}>
      {cargando ? (
        <>
          <AvanceCargando dosFilas={dosFilas} />
          {Array.from({ length: nMosaicos }, (_, i) => (
            <MosaicoCargando key={i} />
          ))}
        </>
      ) : (
        <>
          <TarjetaAvance
            entregadas={datos.entregadas.length}
            facturadas={datos.hoy.length}
            contexto={datos.hoy.length > 0 ? `Facturadas por sede: ${resumirPor(datos.hoy, sedeDe)}` : sinMovimiento}
            activa={filtroEstado === "procesada"}
            alPulsar={alternarEstado("procesada")}
            dosFilas={dosFilas}
          />
          <Mosaico
            titulo="Remisiones hoy"
            valor={datos.remisiones.length}
            tono="neutral"
            contexto={
              datos.remisiones.length > 0
                ? resumirPor(datos.remisiones, (e) => e.tipo.toUpperCase())
                : sinMovimiento
            }
            activa={filtroFlujo === "remisiones"}
            alPulsar={() => onFlujo(filtroFlujo === "remisiones" ? "todos" : "remisiones")}
          />
          {puedeEditar ? (
            <Mosaico
              titulo="Para revisión"
              valor={datos.porRevisar.length}
              tono={datos.porRevisar.length > 0 ? "atencion" : "bien"}
              contexto={datos.porRevisar.length > 0 ? resumirPor(datos.porRevisar, sedeDe) : "Todo revisado"}
              activa={filtroEstado === "revision"}
              alPulsar={alternarEstado("revision")}
            />
          ) : null}
          <Mosaico
            titulo="Sin terminar"
            valor={datos.sinTerminar.length}
            tono={datos.sinTerminar.length > 0 ? "atencion" : "bien"}
            contexto={
              datos.sinTerminar.length > 0
                ? `${datos.unidadesPendientes} ${datos.unidadesPendientes === 1 ? "unidad pendiente" : "unidades pendientes"}`
                : "Nada pendiente"
            }
            activa={filtroEstado === "pendiente"}
            alPulsar={alternarEstado("pendiente")}
          />
          {cargandoDevoluciones ? (
            <MosaicoCargando />
          ) : (
            <Mosaico
              titulo="Devoluciones hoy"
              valor={datos.devoluciones.length}
              tono={datos.devoluciones.length > 0 ? "alerta" : "neutral"}
              contexto={
                datos.devoluciones.length > 0
                  ? `${datos.unidadesDevueltas} ${datos.unidadesDevueltas === 1 ? "unidad devuelta" : "unidades devueltas"}`
                  : "Sin devoluciones"
              }
            />
          )}
        </>
      )}
    </div>
  );
}
