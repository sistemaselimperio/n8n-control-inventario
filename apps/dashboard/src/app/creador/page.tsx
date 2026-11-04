"use client";

// Administracion de sedes, empleados (bodega), puntos y sus usuarios,
// supervisores, tipos de documento y usuarios del dashboard -- reemplaza los
// scripts de alta (scripts/crear_supervisor.py, crear_punto.py) y los curl a
// POST /empleados. Solo para el rol admin de la sesion del panel (los
// endpoints exigen el Bearer, ver apiFetch en lib/api.ts). "Eliminar" borra de
// verdad solo un registro que nunca se uso; si tiene historial (traslados,
// entregas, logs...) el backend lo rechaza y se ofrece "Desactivar", que deja
// la fila en la base y solo deja de aparecer en las aplicaciones.
//
// Cada seccion vive en src/components/creador/; esta pagina solo arma el
// encabezado, el indice de secciones y muestra la elegida.

import { useState } from "react";
import Link from "next/link";
import { useSesion } from "@/lib/SesionProvider";
import { claseBoton, EncabezadoPagina, Icono } from "@/components/ui";
import { SeccionSedes } from "@/components/creador/SeccionSedes";
import { SeccionEmpleados } from "@/components/creador/SeccionEmpleados";
import { SeccionPuntos } from "@/components/creador/SeccionPuntos";
import { SeccionSupervisores } from "@/components/creador/SeccionSupervisores";
import { SeccionTipos } from "@/components/creador/SeccionTipos";
import { SeccionUsuariosDashboard } from "@/components/creador/SeccionUsuariosDashboard";

type Pestana = "sedes" | "empleados" | "puntos" | "supervisores" | "tipos" | "usuarios";
const PESTANAS: { id: Pestana; etiqueta: string }[] = [
  { id: "sedes", etiqueta: "Sedes" },
  { id: "empleados", etiqueta: "Empleados (bodega)" },
  { id: "puntos", etiqueta: "Puntos y usuarios" },
  { id: "supervisores", etiqueta: "Supervisores" },
  { id: "tipos", etiqueta: "Tipos de documento" },
  { id: "usuarios", etiqueta: "Usuarios del dashboard" },
];

export default function CreadorPage() {
  const { esAdmin } = useSesion();
  const [pestana, setPestana] = useState<Pestana>("sedes");

  // Solo admin: el backend ya responde 403 a los demas, esto evita mostrar
  // una pantalla que no puede cargar nada.
  if (!esAdmin) {
    return (
      <main className="mx-auto flex w-full max-w-7xl flex-1 flex-col items-start gap-4 px-4 py-6 sm:px-6 sm:py-8">
        <EncabezadoPagina titulo="Administración" />
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

  return (
    <main className="mx-auto flex w-full max-w-7xl flex-1 flex-col gap-5 px-4 py-6 sm:px-6 sm:py-8">
      <EncabezadoPagina
        titulo="Administración"
        descripcion="Gestiona sedes, empleados, puntos, supervisores, tipos de documento y usuarios. Eliminar solo funciona con registros sin uso; si ya tienen historial, desactívalos."
      />

      {/* Indice de secciones: botones nativos (se alcanzan con Tab y se activan
          con Enter o Espacio); la activa lleva aria-current y subrayado verde,
          y en pantallas angostas la fila se desplaza dentro de su contenedor. */}
      <nav aria-label="Secciones de administración" className="overflow-x-auto border-b border-line">
        <ul className="flex min-w-max gap-1">
          {PESTANAS.map((p) => {
            const activa = pestana === p.id;
            return (
              <li key={p.id}>
                <button
                  onClick={() => setPestana(p.id)}
                  aria-current={activa ? "true" : undefined}
                  className={`-mb-px inline-flex min-h-11 items-center whitespace-nowrap border-b-2 px-3 text-sm font-medium transition-colors duration-150 ${
                    activa
                      ? "border-ok font-semibold text-ink"
                      : "border-transparent text-muted hover:border-line-strong hover:text-ink"
                  }`}
                >
                  {p.etiqueta}
                </button>
              </li>
            );
          })}
        </ul>
      </nav>

      {pestana === "sedes" ? <SeccionSedes /> : null}
      {pestana === "empleados" ? <SeccionEmpleados /> : null}
      {pestana === "puntos" ? <SeccionPuntos /> : null}
      {pestana === "supervisores" ? <SeccionSupervisores /> : null}
      {pestana === "tipos" ? <SeccionTipos /> : null}
      {pestana === "usuarios" ? <SeccionUsuariosDashboard /> : null}
    </main>
  );
}
