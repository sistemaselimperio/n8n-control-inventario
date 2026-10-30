"""Borrado desde la pantalla /creador: "Eliminar" borra de verdad, pero SOLO un
registro que nunca se uso. Si tiene historial, se rechaza con TieneHistorial
(HTTP 409 en el router) y la salida es desactivarlo; nada con historial se
borra jamas.

Hay dos tipos de referencias a un registro y las dos se revisan a mano, con
SELECT EXISTS, antes de borrar:
  - FKs reales (p. ej. traslados_puntos.punto_origen_id -> puntos.id), y
  - referencias blandas sin FK: columnas de texto que guardan el id del
    registro (entregas.sede_origen_id, operador_id, logs.actor_id/sede_id,
    turnos.empleado_id...). Postgres no las protege, por eso son las
    importantes.
Ademas, la FK que atrape una escritura concurrente se traduce al mismo error
(ForeignKeyViolationError) como red de seguridad.

Los logs `admin_cambio` sobre el propio registro (su alta, ediciones o reset
de PIN) no cuentan como historial: si no, nada creado desde el panel se podria
borrar nunca. `logs` es append-only: el borrado deja su evento
`admin_cambio` ("eliminado") y no se toca ninguna fila de logs. Nunca se
registra ningun dato de PIN ni contrasena.
"""

from collections.abc import Callable
from typing import Any

import asyncpg

from app.db import get_pool
from app.services import tipos_documento as servicio_tipos
from app.services.usuarios import RegistroNoEncontrado, registrar_cambio
from app.services.usuarios_dashboard import _registrar_cambio as registrar_cambio_dashboard


class TieneHistorial(Exception):
    """El registro esta en uso (o tiene historial) y no se puede borrar."""


class ReglaBorrado(Exception):
    """Borrado que dejaria al sistema en un estado invalido (p. ej. sin admin)."""


# Cada chequeo es (descripcion para el mensaje, subconsulta SQL que devuelve
# filas si hay historial). `$1` es siempre el id del registro (texto o codigo).
# Los nombres de tabla/columna salen de estas constantes, nunca del request.
Chequeo = tuple[str, str]


def _mensaje(sujeto: str, motivos: list[str], consejo: str) -> str:
    if len(motivos) == 1:
        lista = motivos[0]
    else:
        lista = ", ".join(motivos[:-1]) + " y " + motivos[-1]
    return f"No se puede eliminar: {sujeto} tiene {lista}. {consejo}"


async def _motivos(conn: asyncpg.Connection, chequeos: list[Chequeo], valor: str) -> list[str]:
    """Descripciones de todos los chequeos que encuentran historial (una sola
    consulta con un EXISTS por chequeo)."""
    # El primer uso de $1 fija su tipo en Postgres: se declara texto de entrada
    # (los chequeos que comparan contra uuid lo castean con $1::uuid).
    columnas = ", ".join(f"exists ({sql}) as c{i}" for i, (_, sql) in enumerate(chequeos))
    fila = await conn.fetchrow(f"select $1::text is not null as _p, {columnas}", valor)
    return [descripcion for i, (descripcion, _) in enumerate(chequeos) if fila[f"c{i}"]]


async def _eliminar(
    *,
    tabla: str,
    clave: str,
    valor: str,
    sujeto: str,
    chequeos: list[Chequeo],
    detalle_log: Callable[[asyncpg.Record], dict[str, Any]],
    consejo: str = "Puedes desactivarlo.",
) -> asyncpg.Record:
    """Revisa historial y borra dentro de una transaccion; deja el evento
    admin_cambio. `clave` es la condicion de identidad con su cast (p. ej.
    "id = $1::uuid")."""
    pool = await get_pool()
    try:
        async with pool.acquire() as conn:
            async with conn.transaction():
                # for update: serializa dos borrados simultaneos del mismo registro.
                fila = await conn.fetchrow(f"select * from {tabla} where {clave} for update", valor)
                if fila is None:
                    raise RegistroNoEncontrado()
                motivos = await _motivos(conn, chequeos, valor)
                if motivos:
                    raise TieneHistorial(_mensaje(sujeto, motivos, consejo))
                await conn.execute(f"delete from {tabla} where {clave}", valor)
    except asyncpg.ForeignKeyViolationError as exc:
        # Alguien lo uso justo entre el chequeo y el borrado.
        raise TieneHistorial(_mensaje(sujeto, ["registros asociados"], consejo)) from exc
    await registrar_cambio(tabla, valor, "eliminado", detalle_log(fila))
    return fila


# --- Sedes ------------------------------------------------------------------
# sedes.id viaja como texto en las referencias blandas (entregas.sede_origen_id,
# empleados.sede_id, logs.sede_id, turnos.sede_id...).
_CHEQUEOS_SEDE: list[Chequeo] = [
    ("entregas registradas", "select 1 from entregas where sede_origen_id = $1"),
    ("empleados asignados", "select 1 from empleados where sede_id = $1"),
    # El alta/edicion de un empleado deja admin_cambio con sede_id de la sede:
    # eso ya lo cubre el chequeo de empleados, no cuenta como uso.
    ("eventos en el historial", "select 1 from logs where sede_id = $1 and evento <> 'admin_cambio'"),
    ("turnos programados", "select 1 from turnos where sede_id = $1"),
    ("recomendaciones de turnos", "select 1 from shift_recommendations where sede_id = $1"),
    ("devoluciones registradas", "select 1 from devoluciones where sede_id = $1"),
    ("productos no entregados registrados", "select 1 from items_no_entregados where sede_id = $1"),
    (
        "facturas faltantes reportadas",
        "select 1 from facturas_faltantes where sede_id = $1 or sede_reporta_id = $1",
    ),
]


async def eliminar_sede(sede_id: str) -> None:
    await _eliminar(
        tabla="sedes",
        clave="id = $1::uuid",
        valor=sede_id,
        sujeto="esta sede",
        chequeos=_CHEQUEOS_SEDE,
        detalle_log=lambda f: {"nombre": f["nombre"], "codigo": f["codigo"]},
    )


# --- Empleados (bodega) -----------------------------------------------------
# El id del empleado se guarda como texto en operador_id / bodeguero_id /
# entregado_por / actor_id / reportado_por / empleado_id.
_CHEQUEOS_EMPLEADO: list[Chequeo] = [
    ("entregas registradas", "select 1 from entregas where operador_id = $1 or bodeguero_id = $1"),
    ("productos entregados", "select 1 from entrega_items where entregado_por = $1"),
    ("devoluciones registradas", "select 1 from devoluciones where operador_id = $1"),
    ("productos no entregados registrados", "select 1 from items_no_entregados where operador_id = $1"),
    (
        "facturas faltantes reportadas",
        "select 1 from facturas_faltantes where reportado_por = $1 or cerrada_por = $1",
    ),
    ("turnos programados", "select 1 from turnos where empleado_id = $1"),
    ("eventos en el historial", "select 1 from logs where actor_id = $1"),
]


async def eliminar_empleado(empleado_id: str) -> None:
    await _eliminar(
        tabla="empleados",
        clave="id = $1::uuid",
        valor=empleado_id,
        sujeto="este empleado",
        chequeos=_CHEQUEOS_EMPLEADO,
        detalle_log=lambda f: {"nombre": f["nombre"], "rol": f["rol"], "sede_id": f["sede_id"]},
    )


# --- Puntos -----------------------------------------------------------------
# traslados_puntos.* y talonarios_punto.punto_id son FKs; los logs de traslados
# y talonarios guardan el id del punto en logs.sede_id (referencia blanda).
_CHEQUEOS_PUNTO: list[Chequeo] = [
    (
        "traslados registrados",
        "select 1 from traslados_puntos where punto_origen_id = $1::uuid or punto_destino_id = $1::uuid",
    ),
    ("talonarios", "select 1 from talonarios_punto where punto_id = $1::uuid"),
    ("eventos en el historial", "select 1 from logs where sede_id = $1 and evento <> 'admin_cambio'"),
    # Va al final: borrar un punto con usuarios fallaria por FK aunque no
    # tuvieran historial; se pide eliminarlos (o desactivar el punto) antes.
    ("usuarios asignados", "select 1 from usuarios_punto where punto_id = $1::uuid"),
]


async def eliminar_punto(punto_id: str) -> None:
    await _eliminar(
        tabla="puntos",
        clave="id = $1::uuid",
        valor=punto_id,
        sujeto="este punto",
        chequeos=_CHEQUEOS_PUNTO,
        consejo="Puedes desactivarlo (o eliminar antes sus usuarios sin historial).",
        detalle_log=lambda f: {"nombre": f["nombre"], "codigo": f["codigo"]},
    )


# --- Usuarios de punto ------------------------------------------------------
_CHEQUEOS_USUARIO_PUNTO: list[Chequeo] = [
    (
        "traslados registrados",
        "select 1 from traslados_puntos where creado_por = $1::uuid or recibido_por = $1::uuid",
    ),
    ("talonarios configurados", "select 1 from talonarios_punto where creado_por = $1::uuid"),
    ("hojas de talonario anuladas", "select 1 from talonario_hojas_anuladas where anulado_por = $1::uuid"),
    ("eventos en el historial", "select 1 from logs where actor_id = $1"),
]


async def eliminar_usuario_punto(usuario_id: str) -> None:
    await _eliminar(
        tabla="usuarios_punto",
        clave="id = $1::uuid",
        valor=usuario_id,
        sujeto="este usuario",
        chequeos=_CHEQUEOS_USUARIO_PUNTO,
        detalle_log=lambda f: {"nombre": f["nombre"], "punto_id": str(f["punto_id"])},
    )


# --- Supervisores -----------------------------------------------------------
# traslados_puntos.numero_syscafe_por guarda el NOMBRE de quien asigno el
# numero (no el id), asi que se compara por nombre.
_CHEQUEOS_SUPERVISOR: list[Chequeo] = [
    ("novedades resueltas", "select 1 from traslados_puntos where solucionado_por = $1::uuid"),
    (
        "numeros Syscafe asignados",
        "select 1 from traslados_puntos where numero_syscafe_por = (select nombre from supervisores where id = $1::uuid)",
    ),
    ("eventos en el historial", "select 1 from logs where actor_id = $1"),
]


async def eliminar_supervisor(supervisor_id: str) -> None:
    await _eliminar(
        tabla="supervisores",
        clave="id = $1::uuid",
        valor=supervisor_id,
        sujeto="este supervisor",
        chequeos=_CHEQUEOS_SUPERVISOR,
        detalle_log=lambda f: {"nombre": f["nombre"]},
    )


# --- Tipos de documento -----------------------------------------------------
# entregas.tipo / traslado_tipo / facturas_faltantes.tipo guardan el codigo como
# texto libre (sin FK). Se compara sin distinguir mayusculas.
_CHEQUEOS_TIPO: list[Chequeo] = [
    ("entregas registradas", "select 1 from entregas where upper(tipo) = upper($1)"),
    ("traslados de entregas registrados", "select 1 from entregas where upper(traslado_tipo) = upper($1)"),
    ("facturas faltantes reportadas", "select 1 from facturas_faltantes where upper(tipo) = upper($1)"),
]


async def eliminar_tipo_documento(codigo: str) -> None:
    await _eliminar(
        tabla="tipos_documento",
        clave="codigo = $1",
        valor=codigo,
        sujeto="este tipo de documento",
        chequeos=_CHEQUEOS_TIPO,
        detalle_log=lambda f: {"codigo": f["codigo"], "descripcion": f["descripcion"]},
    )
    # La frase de ejemplos del prompt de vision se cachea unos segundos.
    servicio_tipos.invalidar_cache()


# --- Usuarios del dashboard -------------------------------------------------
# Su rastro es el actor "dashboard:<usuario>" (logs, entregas corregidas,
# devoluciones...) y su nombre en numero_syscafe_por. Los intentos de login
# (ok o fallidos) tambien cuentan como uso.
_ACTOR = "'dashboard:' || (select usuario from usuarios_dashboard where id = $1::uuid)"
_CHEQUEOS_USUARIO_DASHBOARD: list[Chequeo] = [
    ("eventos en el historial", f"select 1 from logs where actor_id = {_ACTOR}"),
    (
        "intentos de ingreso registrados",
        "select 1 from logs where entidad_id = $1 and entidad_tipo = 'usuario_dashboard' and evento <> 'admin_cambio'",
    ),
    ("entregas registradas", f"select 1 from entregas where operador_id = {_ACTOR} or bodeguero_id = {_ACTOR}"),
    ("productos entregados", f"select 1 from entrega_items where entregado_por = {_ACTOR}"),
    ("devoluciones registradas", f"select 1 from devoluciones where operador_id = {_ACTOR}"),
    ("productos no entregados registrados", f"select 1 from items_no_entregados where operador_id = {_ACTOR}"),
    (
        "numeros Syscafe asignados",
        "select 1 from traslados_puntos where numero_syscafe_por = (select nombre from usuarios_dashboard where id = $1::uuid)",
    ),
]


async def eliminar_usuario_dashboard(actor: dict, usuario_id: str) -> None:
    """Ademas del historial: no se borra a si mismo ni al ultimo admin activo
    (mismas guardas que desactivar, ver usuarios_dashboard.actualizar).

    Los admins activos se bloquean (`for update`, en orden por id) ANTES de
    leer la fila a borrar y de contarlos, igual que hace `actualizar`: sin ese
    bloqueo, dos admins que se borran entre si a la vez veian los dos "queda
    otro" y la tabla quedaba sin ningun administrador. El orden por id evita
    un interbloqueo entre dos transacciones que bloquean el mismo conjunto."""

    async def guardas(fila: asyncpg.Record, admins_activos: int) -> None:
        if usuario_id == actor["id"]:
            raise ReglaBorrado("No puedes eliminarte a ti mismo")
        if fila["rol"] == "admin" and fila["activo"] and admins_activos <= 1:
            raise ReglaBorrado("Debe quedar al menos un administrador activo")

    pool = await get_pool()
    try:
        async with pool.acquire() as conn:
            async with conn.transaction():
                admins = await conn.fetch(
                    "select id from usuarios_dashboard where rol = 'admin' and activo order by id for update"
                )
                fila = await conn.fetchrow("select * from usuarios_dashboard where id = $1::uuid for update", usuario_id)
                if fila is None:
                    raise RegistroNoEncontrado()
                await guardas(fila, len(admins))
                motivos = await _motivos(conn, _CHEQUEOS_USUARIO_DASHBOARD, usuario_id)
                if motivos:
                    raise TieneHistorial(_mensaje("este usuario", motivos, "Puedes desactivarlo."))
                await conn.execute("delete from usuarios_dashboard where id = $1::uuid", usuario_id)
    except asyncpg.ForeignKeyViolationError as exc:
        raise TieneHistorial(_mensaje("este usuario", ["registros asociados"], "Puedes desactivarlo.")) from exc
    await registrar_cambio_dashboard(
        actor, usuario_id, "eliminado", {"usuario": fila["usuario"], "nombre": fila["nombre"], "rol": fila["rol"]}
    )
