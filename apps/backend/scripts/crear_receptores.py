"""Carga masiva de receptores por punto (las personas que reciben traslados en
cada punto, ver app/services/receptores_punto.py) desde un CSV. El archivo
trae las cedulas reales: vive FUERA del repositorio y nunca se commitea.

El CSV lleva el encabezado `nombre,cedula,punto`, donde `punto` es el nombre del
punto SIN codigo (por ejemplo "Villa de Leyva" para "NVL — Villa de Leyva"). Se
cruza sin distinguir mayusculas ni tildes con la parte del nombre que va despues
de " — "; tambien valen el nombre completo, el codigo o un alias exacto. La
cedula se normaliza a solo digitos (5 a 15).

Idempotente: se hace upsert por (punto, cedula), actualiza el nombre y deja la
persona activa. Nunca borra nada. Si algun punto no se encuentra (o es ambiguo)
o alguna fila es invalida, no se escribe nada.

Uso:
    python -m scripts.crear_receptores ruta/receptores.csv         # simulacion: solo muestra
    python -m scripts.crear_receptores ruta/receptores.csv --si    # aplica los cambios
"""

import argparse
import asyncio
import csv
import re
import unicodedata
from dataclasses import dataclass, field

import asyncpg

from app.config import get_settings
from app.models.receptor_punto import normalizar_cedula, normalizar_nombre

ENCABEZADO = ["nombre", "cedula", "punto"]

_SQL_UPSERT = """
insert into receptores_punto (punto_id, nombre, cedula) values ($1::uuid, $2, $3)
on conflict (punto_id, cedula) do update set nombre = excluded.nombre, activo = true
returning (xmax = 0) as creado
"""


class ErrorCsv(Exception):
    """El archivo no se puede usar (no existe o tiene otro encabezado)."""


@dataclass
class Fila:
    linea: int
    nombre: str
    cedula: str
    punto: str


@dataclass
class Plan:
    # (punto_id, cedula) -> {"nombre", "punto" (codigo o nombre), "linea"}
    receptores: dict = field(default_factory=dict)
    sin_punto: dict[str, list[int]] = field(default_factory=dict)
    ambiguos: dict[str, list[int]] = field(default_factory=dict)
    errores: list[str] = field(default_factory=list)
    repetidos: int = 0

    @property
    def problemas(self) -> bool:
        return bool(self.sin_punto or self.ambiguos or self.errores)


def normalizar_texto(texto: str | None) -> str:
    """Minusculas, sin tildes y con los espacios colapsados (para cruzar nombres)."""
    sin_tildes = "".join(c for c in unicodedata.normalize("NFKD", texto or "") if not unicodedata.combining(c))
    return re.sub(r"\s+", " ", sin_tildes).strip().casefold()


def leer_csv(ruta: str) -> list[Fila]:
    try:
        with open(ruta, encoding="utf-8-sig", newline="") as archivo:
            lector = csv.reader(archivo)
            encabezado = next(lector, None)
            if [c.strip().lower() for c in encabezado or []] != ENCABEZADO:
                raise ErrorCsv(f"El encabezado debe ser exactamente: {','.join(ENCABEZADO)}")
            filas = []
            for linea, celdas in enumerate(lector, start=2):
                if not any(c.strip() for c in celdas):
                    continue
                nombre, cedula, punto = (celdas + ["", "", ""])[:3]
                filas.append(Fila(linea, nombre.strip(), cedula.strip(), punto.strip()))
            return filas
    except OSError as exc:
        raise ErrorCsv(f"No se pudo leer el archivo: {exc}") from exc


def _claves_de_punto(punto: dict) -> set[str]:
    nombre = punto["nombre"] or ""
    sin_codigo = re.split(r"\s[—–-]\s", nombre, maxsplit=1)[-1]
    claves = {normalizar_texto(sin_codigo), normalizar_texto(nombre), normalizar_texto(punto.get("codigo"))}
    claves.update(normalizar_texto(a) for a in punto.get("alias") or [])
    claves.discard("")
    return claves


def planificar(filas: list[Fila], puntos: list[dict]) -> Plan:
    indice: dict[str, set[str]] = {}
    etiqueta: dict[str, str] = {}
    for punto in puntos:
        etiqueta[str(punto["id"])] = punto.get("codigo") or punto["nombre"]
        for clave in _claves_de_punto(punto):
            indice.setdefault(clave, set()).add(str(punto["id"]))

    plan = Plan()
    for fila in filas:
        try:
            nombre = normalizar_nombre(fila.nombre)
            cedula = normalizar_cedula(fila.cedula)
        except ValueError as exc:
            plan.errores.append(f"Línea {fila.linea}: {exc}")
            continue
        clave = normalizar_texto(fila.punto)
        if not clave:
            plan.errores.append(f"Línea {fila.linea}: falta el punto")
            continue
        ids = indice.get(clave, set())
        if len(ids) != 1:
            destino = plan.ambiguos if ids else plan.sin_punto
            destino.setdefault(fila.punto, []).append(fila.linea)
            continue
        (punto_id,) = ids
        if (punto_id, cedula) in plan.receptores:
            plan.repetidos += 1
        plan.receptores[(punto_id, cedula)] = {"nombre": nombre, "punto": etiqueta[punto_id], "linea": fila.linea}
    return plan


def _enmascarar(cedula: str) -> str:
    return "*" * max(len(cedula) - 4, 0) + cedula[-4:]


def _imprimir_plan(plan: Plan) -> None:
    por_punto: dict[str, list[str]] = {}
    for (_, cedula), datos in plan.receptores.items():
        por_punto.setdefault(datos["punto"], []).append(f"{datos['nombre']} ({_enmascarar(cedula)})")
    for punto in sorted(por_punto):
        print(f"{punto}: {len(por_punto[punto])} receptores")
        for linea in sorted(por_punto[punto]):
            print(f"    {linea}")
    if plan.repetidos:
        print(f"Repetidos en el CSV (misma cédula y punto, se usa la última fila): {plan.repetidos}")


def _imprimir_problemas(plan: Plan) -> None:
    for titulo, grupo in (("Puntos sin coincidencia", plan.sin_punto), ("Puntos ambiguos", plan.ambiguos)):
        if grupo:
            print(f"{titulo}:")
            for texto, lineas in sorted(grupo.items()):
                print(f"    {texto!r} (líneas {', '.join(map(str, lineas))})")
    for error in plan.errores:
        print(error)


async def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("csv", help="Ruta del CSV con el encabezado nombre,cedula,punto (fuera del repositorio)")
    parser.add_argument("--si", action="store_true", help="Aplica los cambios (sin esto solo simula)")
    args = parser.parse_args()

    try:
        filas = leer_csv(args.csv)
    except ErrorCsv as exc:
        print(exc)
        raise SystemExit(1) from exc

    conn = await asyncpg.connect(get_settings().database_url)
    try:
        puntos = [
            {"id": str(f["id"]), "nombre": f["nombre"], "codigo": f["codigo"], "alias": list(f["alias"] or [])}
            for f in await conn.fetch("select id, nombre, codigo, alias from puntos where activo = true")
        ]
        plan = planificar(filas, puntos)
        _imprimir_plan(plan)
        if plan.problemas:
            _imprimir_problemas(plan)
            print("No se escribió nada: corrige el CSV y vuelve a correr el script.")
            raise SystemExit(1)
        print(f"Total: {len(plan.receptores)} receptores en {len({k[0] for k in plan.receptores})} puntos.")
        if not args.si:
            print("Simulación: no se escribió nada. Agrega --si para aplicar los cambios.")
            return
        creados = actualizados = 0
        async with conn.transaction():
            for (punto_id, cedula), datos in plan.receptores.items():
                if await conn.fetchval(_SQL_UPSERT, punto_id, datos["nombre"], cedula):
                    creados += 1
                else:
                    actualizados += 1
        print(f"Listo: {creados} creados, {actualizados} actualizados.")
    finally:
        await conn.close()


if __name__ == "__main__":
    asyncio.run(main())
