"use client";

// Tabla de traslados de un punto (enviados y recibidos) en /puntos/[id]. Misma
// lectura que la tabla de /traslados (referencia del talonario, numero Syscafe,
// origen y destino, fecha y estado) mas una columna "Movimiento". Solo muestra:
// el numero Syscafe se registra desde /traslados o desde el detalle.

import {
  CLASE_FILA_CLICABLE,
  CLASE_TABLA,
  CLASE_TBODY,
  CLASE_THEAD,
  Icono,
  Pildora,
  type TonoPildora,
} from "@/components/ui";
import {
  empresaTalonario,
  ESTADOS,
  fechaCorta,
  ORIGEN_DIRECTO,
  referencia,
} from "@/components/traslados/compartido";
import type { FilaTrasladoSyscafe } from "@/lib/api";
import type { TrasladoDePunto } from "@/lib/puntos";

export function TablaTrasladosPunto({
  filas,
  onAbrir,
}: {
  filas: TrasladoDePunto[];
  onAbrir: (fila: FilaTrasladoSyscafe) => void;
}) {
  return (
    <div className="overflow-x-auto">
      <table className={`${CLASE_TABLA} min-w-[760px]`}>
        <thead className={CLASE_THEAD}>
          <tr>
            <th scope="col" className="py-3 pl-4 pr-3 font-medium sm:pl-5">
              Talonario
            </th>
            <th scope="col" className="px-3 py-3 font-medium">
              Traslado
            </th>
            <th scope="col" className="px-3 py-3 font-medium">
              Origen y destino
            </th>
            <th scope="col" className="px-3 py-3 font-medium">
              Movimiento
            </th>
            <th scope="col" className="px-3 py-3 font-medium">
              Fecha
            </th>
            <th scope="col" className="py-3 pl-3 pr-4 font-medium sm:pr-5">
              Estado
            </th>
          </tr>
        </thead>
        <tbody className={CLASE_TBODY}>
          {filas.map(({ fila, direccion }) => {
            const anulada = fila.tipo === "anulada";
            const info = ESTADOS[fila.estado] ?? { texto: fila.estado, tono: "neutro" as TonoPildora };
            return (
              <tr
                key={`${fila.tipo}:${fila.id}`}
                tabIndex={0}
                onClick={() => onAbrir(fila)}
                onKeyDown={(e) => {
                  if (e.target === e.currentTarget && e.key === "Enter") onAbrir(fila);
                }}
                className={CLASE_FILA_CLICABLE}
              >
                <td className="whitespace-nowrap py-2.5 pl-4 pr-3 sm:pl-5">
                  <span className={`cifra block text-[14px] ${anulada ? "text-muted" : "text-ink"}`}>{referencia(fila)}</span>
                  {empresaTalonario(fila) ? <span className="block text-xs text-muted">{empresaTalonario(fila)}</span> : null}
                </td>
                <td className="px-3 py-2.5">
                  {anulada ? (
                    <span className="text-xs text-muted" title={fila.motivo ?? undefined}>
                      {fila.motivo ? `Motivo: ${fila.motivo}` : "—"}
                    </span>
                  ) : fila.numero_syscafe ? (
                    <span className="cifra text-[14px] text-ink">{fila.numero_syscafe}</span>
                  ) : (
                    <Pildora tono="warn">Pendiente</Pildora>
                  )}
                </td>
                <td className="px-3 py-2.5 text-ink">
                  {anulada ? (
                    (fila.punto_origen_nombre ?? "—")
                  ) : (
                    <>
                      {fila.tipo_traslado === "directo" ? ORIGEN_DIRECTO : (fila.punto_origen_nombre ?? "—")}
                      <Icono nombre="derecha" className="mx-1.5 inline h-3.5 w-3.5 align-text-bottom text-muted" />
                      <span className="sr-only">a</span>
                      {fila.punto_destino_nombre ?? "—"}
                    </>
                  )}
                </td>
                <td className="px-3 py-2.5 text-muted">{anulada ? "Hoja anulada" : direccion === "enviado" ? "Enviado" : "Recibido"}</td>
                <td className="whitespace-nowrap px-3 py-2.5 tabular-nums text-muted">{fechaCorta(fila.fecha)}</td>
                <td className="py-2.5 pl-3 pr-4 sm:pr-5">
                  <Pildora tono={info.tono}>{info.texto}</Pildora>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
