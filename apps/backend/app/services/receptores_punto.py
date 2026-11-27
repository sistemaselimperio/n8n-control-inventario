"""Receptores por punto: las personas que reciben traslados en cada punto.

Cada punto entra al dashboard con UN usuario compartido; al confirmar un
comprobante o devolver uno pendiente se elige quien recibe: alguien de esta
lista (`receptores_punto`) o una "otra persona" escrita a mano, que se guarda
solo en el comprobante y nunca se agrega a la lista. Aca vive:

- la lectura para el modal del punto (solo activos),
- la resolucion y validacion de quien recibe (la usa services/traslados.py),
- la administracion desde /creador (alta, edicion, desactivacion y borrado
  definitivo; el comprobante conserva nombre y cedula copiados, y su
  receptor_id queda en null por `on delete set null`).

La cedula se guarda solo con digitos (ver models/receptor_punto.py) y no se
escribe en los logs del catalogo.
"""

import uuid
from typing import Any

import asyncpg

from app.db import get_pool
from app.models.receptor_punto import ReceptorActualizar, ReceptorCrear, normalizar_cedula, normalizar_nombre
from app.services import traslados_reglas as reglas
from app.services.permisos_traslados import PerfilTraslados
from app.services.usuarios import DatoInvalido, RegistroNoEncontrado, registrar_cambio, serializar

_TABLA = "receptores_punto"
_MSG_DUPLICADO = "Ya existe un receptor con esa cédula en ese punto"
_MSG_PUNTO = "El punto indicado no existe"

_SQL_LISTAR = """
select r.id, r.punto_id, r.nombre, r.cedula, r.activo, r.creado_at, p.nombre as punto_nombre
from receptores_punto r
join puntos p on p.id = r.punto_id
"""


def _s(valor: Any) -> str | None:
    return None if valor is None else str(valor)


# ---------------------------------------------------------------------------
# Lectura para el modal del punto
# ---------------------------------------------------------------------------


async def listar_activos_de_punto(perfil: PerfilTraslados, punto_id: str) -> list[dict]:
    """Receptores activos del punto, por nombre: [{id, nombre, cedula}]. Un
    perfil limitado a otro punto recibe 404 (mismo criterio que los comprobantes)."""
    if not perfil.ve(punto_id):
        raise reglas.TrasladoNoEncontrado("Punto no encontrado")
    pool = await get_pool()
    filas = await pool.fetch(
        _SQL_LISTAR + " where r.punto_id = $1::uuid and r.activo = true order by r.nombre, r.cedula", punto_id
    )
    return [{"id": str(f["id"]), "nombre": f["nombre"], "cedula": f["cedula"]} for f in filas]


# ---------------------------------------------------------------------------
# Quien recibe al confirmar / devolver
# ---------------------------------------------------------------------------


async def resolver_receptor(
    conn, punto_id: str, *, receptor_id: str | None, nombre: str | None, cedula: str | None
) -> dict:
    """Valida quien recibe un comprobante del punto `punto_id`: EXACTAMENTE uno
    de `receptor_id` (activo y de ese punto) o "otra persona" (`nombre` y
    `cedula`, ambos obligatorios). Devuelve {receptor_id, nombre, cedula,
    fuera_de_lista}; lanza traslados_reglas.DatoInvalido si no sirve."""
    hay_texto = bool((nombre or "").strip() or (cedula or "").strip())
    if receptor_id and hay_texto:
        raise reglas.DatoInvalido("Elige un receptor de la lista o indica otra persona, no las dos cosas")
    if receptor_id:
        try:
            uuid.UUID(str(receptor_id))
        except ValueError:
            raise reglas.DatoInvalido("El receptor seleccionado no es válido") from None
        fila = await conn.fetchrow(
            "select id, punto_id, nombre, cedula, activo from receptores_punto where id = $1::uuid", str(receptor_id)
        )
        if fila is None or not fila["activo"] or str(fila["punto_id"]) != str(punto_id):
            raise reglas.DatoInvalido("El receptor seleccionado no está disponible en este punto")
        return {"receptor_id": str(fila["id"]), "nombre": fila["nombre"], "cedula": fila["cedula"], "fuera_de_lista": False}
    if not hay_texto:
        raise reglas.DatoInvalido("Indica quién recibe: elige un receptor de la lista o escribe otra persona")
    try:
        return {
            "receptor_id": None,
            "nombre": normalizar_nombre(nombre),
            "cedula": normalizar_cedula(cedula),
            "fuera_de_lista": True,
        }
    except ValueError as exc:
        raise reglas.DatoInvalido(str(exc)) from exc


# ---------------------------------------------------------------------------
# Administracion (/creador)
# ---------------------------------------------------------------------------


def _fila(fila: Any) -> dict:
    resultado = serializar(fila)
    if resultado.get("creado_at") is None:
        resultado.pop("creado_at", None)
    return resultado


def _error_integridad(exc: asyncpg.PostgresError) -> DatoInvalido:
    if isinstance(exc, asyncpg.ForeignKeyViolationError):
        return DatoInvalido(_MSG_PUNTO)
    return DatoInvalido(_MSG_DUPLICADO)


async def listar(*, punto_id: str | None, incluir_inactivos: bool) -> list[dict]:
    condiciones: list[str] = []
    args: list[Any] = []
    if punto_id is not None:
        args.append(punto_id)
        condiciones.append(f"r.punto_id = ${len(args)}::uuid")
    if not incluir_inactivos:
        condiciones.append("r.activo = true")
    donde = (" where " + " and ".join(condiciones)) if condiciones else ""
    pool = await get_pool()
    filas = await pool.fetch(f"{_SQL_LISTAR}{donde} order by p.nombre, r.nombre, r.cedula", *args)
    return [_fila(f) for f in filas]


async def crear(payload: ReceptorCrear) -> dict:
    pool = await get_pool()
    try:
        fila = await pool.fetchrow(
            "insert into receptores_punto (punto_id, nombre, cedula) values ($1::uuid, $2, $3) returning *",
            payload.punto_id,
            payload.nombre,
            payload.cedula,
        )
    except (asyncpg.UniqueViolationError, asyncpg.ForeignKeyViolationError) as exc:
        raise _error_integridad(exc) from exc
    await registrar_cambio(_TABLA, str(fila["id"]), "creado", {"nombre": payload.nombre, "punto_id": payload.punto_id})
    return _fila(fila)


async def actualizar(receptor_id: str, payload: ReceptorActualizar) -> dict:
    """Update parcial (nombre, cedula, punto, activo). RegistroNoEncontrado si
    no existe; DatoInvalido ante cedula repetida en el punto."""
    cambios = payload.model_dump(exclude_none=True)
    pool = await get_pool()
    if not cambios:
        fila = await pool.fetchrow(f"{_SQL_LISTAR} where r.id = $1::uuid", receptor_id)
        if fila is None:
            raise RegistroNoEncontrado()
        return _fila(fila)
    asignaciones = ", ".join(
        f"{col} = ${i}" + ("::uuid" if col == "punto_id" else "") for i, col in enumerate(cambios, start=2)
    )
    try:
        fila = await pool.fetchrow(
            f"update receptores_punto set {asignaciones} where id = $1::uuid returning *", receptor_id, *cambios.values()
        )
    except (asyncpg.UniqueViolationError, asyncpg.ForeignKeyViolationError) as exc:
        raise _error_integridad(exc) from exc
    if fila is None:
        raise RegistroNoEncontrado()
    # La cedula no se escribe en el log del catalogo: solo se anota que cambio.
    detalle = {("cedula_cambiada" if k == "cedula" else k): (True if k == "cedula" else v) for k, v in cambios.items()}
    await registrar_cambio(_TABLA, receptor_id, "actualizado", detalle)
    return _fila(fila)


async def eliminar(receptor_id: str) -> None:
    """Borrado definitivo. Los comprobantes ya firmados conservan nombre y
    cedula (copiados); su receptor_id pasa a null por la FK."""
    pool = await get_pool()
    fila = await pool.fetchrow("delete from receptores_punto where id = $1::uuid returning *", receptor_id)
    if fila is None:
        raise RegistroNoEncontrado()
    await registrar_cambio(_TABLA, receptor_id, "eliminado", {"nombre": fila["nombre"], "punto_id": str(fila["punto_id"])})
