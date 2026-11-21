"""Administracion de sedes, empleados, puntos, usuarios de punto y supervisores
(alta, edicion, desactivacion y reset de PIN) -- la usa la pantalla /creador
del dashboard. La logica vive aca y los routers solo traducen excepciones a
HTTP. Nunca se borra nada: "borrar" es desactivar (estado/activa/activo),
porque hay FKs desde traslados_puntos y logs que apuntan a estas filas.

El PIN llega en texto plano solo para hashearlo (ver app/services/auth_pin.py);
ni el PIN ni pin_hash/pin_salt se devuelven ni se escriben en logs.
"""

from typing import Any

import asyncpg

from app.db import get_pool
from app.models.log import EventoLog
from app.services.auth_pin import generar_sal, hashear_pin
from app.services.logging_service import registrar_evento
from app.services.permisos_dashboard import actor_actual


class RegistroNoEncontrado(Exception):
    pass


class DatoInvalido(Exception):
    """Dato que viola una regla de negocio o una restriccion unica."""


# Tablas administrables -> columnas que se pueden editar con PATCH. Los nombres de tabla y de
# columna que llegan a las queries salen siempre de estas constantes, nunca
# del request.
_COLUMNAS_EDITABLES = {
    "sedes": ("nombre", "direccion", "activa"),
    "empleados": ("nombre", "sede_id", "rol", "estado"),
    "puntos": ("nombre", "activo", "es_interna"),
    "usuarios_punto": ("nombre", "estado"),
    "supervisores": ("nombre", "estado"),
}

# Tabla -> entidad_tipo con la que se registra el cambio en logs.
_ENTIDAD_LOG = {
    "sedes": "sede",
    "empleados": "empleado",
    "puntos": "punto",
    "usuarios_punto": "usuario_punto",
    "supervisores": "supervisor",
    "tipos_documento": "tipo_documento",
    "productos": "producto",
}

_CAMPOS_UUID = ("id", "punto_id")


def serializar(fila: asyncpg.Record | dict) -> dict:
    """Fila -> dict JSON-able sin datos de PIN (uuid a str, sin hash ni sal)."""
    resultado = dict(fila)
    resultado.pop("pin_hash", None)
    resultado.pop("pin_salt", None)
    for campo in _CAMPOS_UUID:
        if resultado.get(campo) is not None:
            resultado[campo] = str(resultado[campo])
    return resultado


async def registrar_cambio(
    tabla: str, entidad_id: str, accion: str, detalle: dict[str, Any] | None = None, sede_id: str = "-"
) -> None:
    """Deja el evento en logs. El actor es el de la sesion del dashboard
    ("dashboard:<usuario>", ver permisos_dashboard.actor_actual); con el token
    legacy es "dashboard:token", y fuera de una peticion (scripts) "admin"."""
    await registrar_evento(
        EventoLog.ADMIN_CAMBIO,
        entidad_tipo=_ENTIDAD_LOG[tabla],
        entidad_id=entidad_id,
        actor_id=actor_actual.get() or "admin",
        sede_id=sede_id,
        resultado=accion,
        detalle=detalle or {},
    )


def _mensaje_integridad(exc: asyncpg.PostgresError) -> str:
    if isinstance(exc, asyncpg.UniqueViolationError):
        return "Ya existe un registro con ese nombre o codigo"
    if isinstance(exc, asyncpg.ForeignKeyViolationError):
        return "La referencia indicada no existe"
    return "Datos invalidos"


async def crear_fila(tabla: str, columnas: dict[str, Any], sede_id: str = "-") -> dict:
    """Insert generico para las tablas administrables. `columnas` ya viene
    validado por los modelos Pydantic del router."""
    if tabla not in _COLUMNAS_EDITABLES:
        raise ValueError(f"Tabla no administrable: {tabla}")
    nombres = list(columnas)
    marcadores = ", ".join(f"${i}" for i in range(1, len(nombres) + 1))
    pool = await get_pool()
    try:
        fila = await pool.fetchrow(
            f"insert into {tabla} ({', '.join(nombres)}) values ({marcadores}) returning *",
            *columnas.values(),
        )
    except (asyncpg.UniqueViolationError, asyncpg.ForeignKeyViolationError, asyncpg.DataError) as exc:
        raise DatoInvalido(_mensaje_integridad(exc)) from exc
    detalle = {k: v for k, v in columnas.items() if k not in ("pin_hash", "pin_salt")}
    await registrar_cambio(tabla, str(fila["id"]), "creado", detalle, sede_id)
    return serializar(fila)


async def actualizar_fila(tabla: str, fila_id: str, cambios: dict[str, Any]) -> dict:
    """Update parcial: solo las columnas de _COLUMNAS_EDITABLES que vengan en
    `cambios` (los None ya se descartaron antes). Lanza RegistroNoEncontrado
    si el id no existe y DatoInvalido ante choques de unicidad."""
    permitidas = _COLUMNAS_EDITABLES[tabla]
    cambios = {k: v for k, v in cambios.items() if k in permitidas}
    pool = await get_pool()
    if not cambios:
        fila = await pool.fetchrow(f"select * from {tabla} where id = $1::uuid", fila_id)
        if fila is None:
            raise RegistroNoEncontrado()
        return serializar(fila)
    asignaciones = ", ".join(f"{col} = ${i}" for i, col in enumerate(cambios, start=2))
    try:
        fila = await pool.fetchrow(
            f"update {tabla} set {asignaciones} where id = $1::uuid returning *",
            fila_id,
            *cambios.values(),
        )
    except (asyncpg.UniqueViolationError, asyncpg.ForeignKeyViolationError, asyncpg.DataError) as exc:
        raise DatoInvalido(_mensaje_integridad(exc)) from exc
    if fila is None:
        raise RegistroNoEncontrado()
    await registrar_cambio(tabla, fila_id, "actualizado", cambios)
    return serializar(fila)


async def resetear_pin(tabla: str, fila_id: str, pin: str) -> None:
    """Pone un PIN nuevo (sal nueva). Sirve para empleados, usuarios_punto y
    supervisores -- las tres tablas tienen pin_hash/pin_salt."""
    if tabla not in ("empleados", "usuarios_punto", "supervisores"):
        raise ValueError(f"Tabla sin PIN: {tabla}")
    sal = generar_sal()
    pin_hash = hashear_pin(pin, sal)
    pool = await get_pool()
    actualizado = await pool.fetchval(
        f"update {tabla} set pin_hash = $2, pin_salt = $3 where id = $1::uuid returning id",
        fila_id,
        pin_hash,
        sal,
    )
    if actualizado is None:
        raise RegistroNoEncontrado()
    await registrar_cambio(tabla, fila_id, "pin_reseteado")


async def crear_con_pin(tabla: str, columnas: dict[str, Any], pin: str, sede_id: str = "-") -> dict:
    sal = generar_sal()
    return await crear_fila(tabla, {**columnas, "pin_hash": hashear_pin(pin, sal), "pin_salt": sal}, sede_id)


async def sede_existe(sede_id: str) -> bool:
    pool = await get_pool()
    return bool(await pool.fetchval("select exists (select 1 from sedes where id::text = $1)", sede_id))
